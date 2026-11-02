//! Local diagnostics and bounded repair requests. No terminal text or screenshots.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::Context};

const ROTATE_BYTES: u64 = 5 * 1024 * 1024;
const ROTATIONS: usize = 4;
static TX: OnceLock<mpsc::SyncSender<Message>> = OnceLock::new();
static SNAPSHOT: OnceLock<Mutex<Value>> = OnceLock::new();
static RECENT: OnceLock<Mutex<VecDeque<Value>>> = OnceLock::new();
static REFRESH: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
static DROPPED: AtomicU64 = AtomicU64::new(0);
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn directory() -> PathBuf {
    crate::mods::app_dir().join("diagnostics")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn clipped(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = text[..end].to_owned();
    if end < text.len() {
        out.push_str(" [truncated]");
    }
    out
}

/// Credential strings can appear inside an exception. Redact before enqueueing.
pub fn redact(text: &str) -> String {
    static PATTERNS: OnceLock<Vec<fancy_regex::Regex>> = OnceLock::new();
    let patterns=PATTERNS.get_or_init(||[
        r"(?i)(?:github_pat_|gh[pousr]_|sk-(?:proj-|ant-)?)[A-Za-z0-9_-]{16,}",
        r"(?i)Bearer\s+[A-Za-z0-9._~+/=-]+",
        r#"(?i)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|client[_-]?secret)\s*[\"']?\s*[:=]\s*[\"']?[^\s\"',;}]+"#,
        r"https?://[^\s/@:]+:[^\s/@]+@",
    ].into_iter().map(|p|fancy_regex::Regex::new(p).expect("diagnostic redaction pattern")).collect());
    let mut out = clipped(text, 16 * 1024);
    for pattern in patterns {
        out = pattern.replace_all(&out, "[REDACTED]").into_owned();
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = home.to_string_lossy();
        out = out
            .replace(home.as_ref(), "<USERPROFILE>")
            .replace(&home.replace('\\', "/"), "<USERPROFILE>");
    }
    out
}
fn safe(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(redact(s)),
        Value::Array(a) => Value::Array(a.iter().take(32).map(safe).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .take(48)
                .map(|(k, v)| {
                    let lower = k.to_lowercase();
                    let blocked = [
                        "token",
                        "password",
                        "secret",
                        "authorization",
                        "clipboard",
                        "prompt",
                        "transcript",
                        "terminal_output",
                    ]
                    .iter()
                    .any(|s| lower.contains(s));
                    (
                        k.clone(),
                        if blocked {
                            json!("[REDACTED]")
                        } else {
                            safe(v)
                        },
                    )
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

enum Message {
    Event(Value),
    Flush(mpsc::Sender<()>),
}
fn send(value: Value) {
    if let Some(tx) = TX.get() {
        if tx.try_send(Message::Event(value)).is_err() {
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
    }
}
pub fn snapshot(value: Value) {
    if let Ok(mut slot) = SNAPSHOT.get_or_init(|| Mutex::new(Value::Null)).lock() {
        *slot = safe(&value);
    }
}
pub fn action(name: &str, args: &Value, person: bool) -> u64 {
    let id = SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    // Names are enough to reproduce dispatch; argument values can contain a task.
    let keys = args
        .as_object()
        .map(|a| a.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let value = json!({"kind":"action","time_ms":now(),"id":id,"command":name,"argument_names":keys,"person":person});
    if let Ok(mut recent) = RECENT.get_or_init(|| Mutex::new(VecDeque::new())).lock() {
        recent.push_back(value.clone());
        while recent.len() > 24 {
            recent.pop_front();
        }
    }
    send(value);
    id
}
pub fn outcome(id: u64, name: &str, result: &Value, elapsed: u64) {
    let error = result.get("error").and_then(Value::as_str);
    send(
        json!({"kind":"action_result","time_ms":now(),"id":id,"command":name,"elapsed_ms":elapsed,"ok":error.is_none(),"pending":result.get("pending")}),
    );
    if let Some(error) = error {
        report(
            "command",
            name,
            error,
            json!({"action_id":id,"elapsed_ms":elapsed}),
        );
    }
}
pub fn report(category: &str, source: &str, error: &str, details: Value) {
    let context = SNAPSHOT
        .get()
        .and_then(|m| m.lock().ok().map(|v| v.clone()))
        .unwrap_or(Value::Null);
    let recent = RECENT
        .get()
        .and_then(|m| m.lock().ok().map(|v| v.iter().cloned().collect::<Vec<_>>()))
        .unwrap_or_default();
    send(
        json!({"kind":"error","time_ms":now(),"category":category,"source":source,"error":error,"details":details,"context":context,"recent_actions":recent}),
    );
}
pub fn take_refresh() -> Option<String> {
    REFRESH.get()?.lock().ok()?.pop_front()
}
pub fn resolved(category: &str, source: &str, error: &str) {
    send(json!({"kind":"recovered","time_ms":now(),"incident":fingerprint(category,source,error)}));
}
pub fn flush() {
    if let Some(tx) = TX.get() {
        let (ack, wait) = mpsc::channel();
        if tx.try_send(Message::Flush(ack)).is_ok() {
            let _ = wait.recv_timeout(Duration::from_secs(2));
        }
    }
}

pub struct DiagnosticLayer;
#[derive(Default)]
struct Fields(BTreeMap<String, Value>);
impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0
            .insert(field.name().into(), json!(redact(&format!("{value:?}"))));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().into(), json!(redact(value)));
    }
}
impl<S: Subscriber> Layer<S> for DiagnosticLayer {
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        let meta = event.metadata();
        if *meta.level() > tracing::Level::WARN {
            return;
        }
        let mut fields = Fields::default();
        event.record(&mut fields);
        let message = fields
            .0
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("runtime error");
        let message = fields
            .0
            .get("error")
            .and_then(Value::as_str)
            .map_or_else(|| message.to_owned(), |e| format!("{message}: {e}"));
        report(
            if meta.target().starts_with("gpui_shell") {
                "script"
            } else {
                "runtime"
            },
            meta.target(),
            &message,
            json!({"level":meta.level().as_str(),"file":meta.file(),"line":meta.line(),"module":meta.module_path(),"fields":fields.0,"thread":std::thread::current().name()}),
        );
    }
}
pub fn install() -> DiagnosticLayer {
    let (tx, rx) = mpsc::sync_channel(256);
    if TX.set(tx).is_ok() {
        let dir = directory();
        std::thread::spawn(move || {
            if let Err(error) = worker(&dir, rx) {
                eprintln!("Herdr diagnostics unavailable: {error}");
            }
        });
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic| {
            report(
                "panic",
                "native",
                &panic.to_string(),
                json!({"backtrace":std::backtrace::Backtrace::force_capture().to_string()}),
            );
            flush();
            previous(panic);
        }));
    }
    DiagnosticLayer
}

pub fn fingerprint(category: &str, source: &str, error: &str) -> String {
    static UUID: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let pattern = UUID.get_or_init(|| {
        fancy_regex::Regex::new(
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        )
        .unwrap()
    });
    let cleaned = redact(error);
    let cleaned = pattern.replace_all(&cleaned, "<id>");
    format!(
        "{:x}",
        Sha256::digest(format!("{category}\n{source}\n{cleaned}"))
    )[..16]
        .into()
}
fn transient(error: &str) -> bool {
    let error = error.to_lowercase();
    ["interrupted", "execution limit", "script timed out"]
        .iter()
        .any(|s| error.contains(s))
}
fn repairable(category: &str, error: &str) -> bool {
    matches!(category, "script" | "mod_render" | "mod_load" | "panic")
        || (category == "command"
            && [
                "TypeError",
                "ReferenceError",
                "SyntaxError",
                "panicked",
                "index out of bounds",
            ]
            .iter()
            .any(|s| error.contains(s)))
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Incident {
    id: String,
    first_ms: u64,
    last_ms: u64,
    count: u64,
    category: String,
    source: String,
    error: String,
    sample: Value,
    recoveries: u32,
    last_recovery_ms: u64,
    repair: String,
    attempts: u32,
}
#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct RepairConfig {
    enabled: bool,
    repository: PathBuf,
    node: Option<PathBuf>,
    max_jobs_per_day: u32,
    cooldown_seconds: u64,
}

fn rotate(path: &Path) -> std::io::Result<()> {
    for index in (1..=ROTATIONS).rev() {
        let from = if index == 1 {
            path.to_owned()
        } else {
            path.with_extension(format!("jsonl.{}", index - 1))
        };
        let to = path.with_extension(format!("jsonl.{index}"));
        if from.is_file() {
            if to.is_file() {
                std::fs::remove_file(&to)?;
            }
            std::fs::rename(from, to)?;
        }
    }
    Ok(())
}
fn append(path: &Path, record: &Value, limit: u64) -> std::io::Result<()> {
    if path.metadata().is_ok_and(|m| m.len() >= limit) {
        rotate(path)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut file, record)?;
    file.write_all(b"\n")?;
    file.flush()
}

fn worker(dir: &Path, rx: mpsc::Receiver<Message>) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir.join("incidents"))?;
    let log = dir.join("events.jsonl");
    let build = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .map(|b| format!("{:x}", Sha256::digest(b)))
        .unwrap_or_default();
    let run = format!("{}-{}", now(), std::process::id());
    let mut incidents = BTreeMap::<String, Incident>::new();
    for f in std::fs::read_dir(dir.join("incidents"))?.flatten() {
        if f.path().extension().is_some_and(|e| e == "json") {
            if let Ok(bytes) = std::fs::read(f.path()) {
                if let Ok(mut incident) = serde_json::from_slice::<Incident>(&bytes) {
                    if valid_incident(&incident.id) {
                        if incident.repair == "running" {
                            incident.repair = "interrupted".into();
                        }
                        incidents.insert(incident.id.clone(), incident);
                    }
                }
            }
        }
    }
    let mut job: Option<(std::process::Child, String)> = None;
    let budget: Value = std::fs::read(dir.join("budget.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut job_day = budget["day"].as_u64().unwrap_or(now() / 86_400_000);
    let mut jobs_today = budget["jobs"].as_u64().unwrap_or(0).min(10) as u32;
    let mut last_job = budget["last_ms"].as_u64().unwrap_or(0);
    let mut saved = BTreeMap::<String, (u64, u64)>::new();
    let mut dirty = BTreeSet::new();
    let mut last_save = Instant::now();
    append(
        &log,
        &json!({"kind":"startup","time_ms":now(),"run":run,"build":build,"version":env!("CARGO_PKG_VERSION"),"os":std::env::consts::OS,"arch":std::env::consts::ARCH}),
        ROTATE_BYTES,
    )?;
    loop {
        let message = rx.recv_timeout(Duration::from_secs(1));
        match message {
            Ok(Message::Event(event)) => {
                let mut event = safe(&event);
                event["run"] = json!(run);
                event["build"] = json!(build);
                let mut write = true;
                if event["kind"] == "error" {
                    let category = event["category"].as_str().unwrap_or("runtime").to_owned();
                    let source = event["source"].as_str().unwrap_or("unknown").to_owned();
                    let error = event["error"].as_str().unwrap_or("unknown").to_owned();
                    let id = fingerprint(&category, &source, &error);
                    event["incident"] = json!(id);
                    dirty.insert(id.clone());
                    let entry = incidents.entry(id.clone()).or_insert_with(|| Incident {
                        id: id.clone(),
                        first_ms: now(),
                        category: category.clone(),
                        source: source.clone(),
                        error: error.clone(),
                        ..Default::default()
                    });
                    if entry.repair == "recovered" {
                        entry.repair.clear();
                    }
                    entry.count += 1;
                    entry.last_ms = now();
                    entry.sample = event.clone();
                    write = saved
                        .get(&id)
                        .is_none_or(|(_, stamp)| now().saturating_sub(*stamp) >= 2_000);
                    if transient(&error)
                        && entry.recoveries < 2
                        && now().saturating_sub(entry.last_recovery_ms) > 10_000
                    {
                        entry.recoveries += 1;
                        entry.last_recovery_ms = now();
                        if let Ok(mut refresh) =
                            REFRESH.get_or_init(|| Mutex::new(VecDeque::new())).lock()
                        {
                            refresh.push_back(id.clone());
                        }
                    }
                    if repairable(&category, &error)
                        && (!transient(&error) || entry.count >= 3)
                        && entry.repair.is_empty()
                    {
                        entry.repair = "queued".into();
                    }
                    if write {
                        saved.insert(id, (entry.count, now()));
                    }
                } else if event["kind"] == "recovered" {
                    if let Some(id) = event["incident"].as_str() {
                        if let Some(entry) = incidents.get_mut(id) {
                            if entry.repair == "queued" || entry.repair.is_empty() {
                                entry.repair = "recovered".into();
                                dirty.insert(id.into());
                            }
                        }
                    }
                }
                if write {
                    append(&log, &event, ROTATE_BYTES)?;
                }
            }
            Ok(Message::Flush(ack)) => {
                save_incidents(dir, &incidents)?;
                let _ = ack.send(());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                save_incidents(dir, &incidents)?;
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if let Some((child, id)) = &mut job {
            if let Some(exit) = child.try_wait()? {
                if let Some(incident) = incidents.get_mut(id) {
                    incident.repair = if exit.success() {
                        "verified_or_reported"
                    } else {
                        "failed"
                    }
                    .into();
                    dirty.insert(id.clone());
                }
                append(
                    &log,
                    &json!({"kind":"repair_finished","time_ms":now(),"incident":id,"exit_code":exit.code()}),
                    ROTATE_BYTES,
                )?;
                job = None;
            }
        }
        let config: RepairConfig = std::fs::read(dir.join("auto-repair.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        if now() / 86_400_000 != job_day {
            job_day = now() / 86_400_000;
            jobs_today = 0;
        }
        let daily = if config.max_jobs_per_day == 0 {
            3
        } else {
            config.max_jobs_per_day.min(10)
        };
        let cooldown = if config.cooldown_seconds == 0 {
            900
        } else {
            config.cooldown_seconds.max(60)
        } * 1000;
        if config.enabled
            && job.is_none()
            && jobs_today < daily
            && now().saturating_sub(last_job) >= cooldown
        {
            if let Some(incident) = incidents.values_mut().find(|i| {
                i.repair == "queued" && now().saturating_sub(i.first_ms) >= 10_000 && i.attempts < 2
            }) {
                let script = config.repository.join("scripts/repair-herdr.cjs");
                if script.is_file() {
                    incident.attempts += 1;
                    incident.repair = "running".into();
                    last_job = now();
                    jobs_today += 1;
                    crate::persist::write_atomic(
                        &dir.join("budget.json"),
                        serde_json::to_vec(
                            &json!({"day":job_day,"jobs":jobs_today,"last_ms":last_job}),
                        )?,
                    )?;
                    save_incident(dir, incident)?;
                    let report = dir.join("incidents").join(format!("{}.json", incident.id));
                    let child =
                        crate::spawn::command(config.node.as_deref().unwrap_or(Path::new("node")))
                            .arg(script)
                            .arg("--incident")
                            .arg(report)
                            .arg("--repository")
                            .arg(&config.repository)
                            .arg("--diagnostics")
                            .arg(dir)
                            .stdin(std::process::Stdio::null())
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .spawn();
                    match child {
                        Ok(child) => job = Some((child, incident.id.clone())),
                        Err(error) => {
                            incident.repair =
                                format!("failed_to_start: {}", redact(&error.to_string()));
                        }
                    }
                }
            }
        }
        if last_save.elapsed() >= Duration::from_secs(1) {
            while incidents.len() > 200 {
                let oldest = incidents
                    .values()
                    .filter(|i| i.repair != "running")
                    .min_by_key(|i| i.last_ms)
                    .map(|i| i.id.clone());
                let Some(id) = oldest else { break };
                incidents.remove(&id);
                saved.remove(&id);
                dirty.remove(&id);
                let _ = std::fs::remove_file(dir.join("incidents").join(format!("{id}.json")));
            }
            for id in std::mem::take(&mut dirty) {
                if let Some(entry) = incidents.get(&id) {
                    save_incident(dir, entry)?;
                }
            }
            last_save = Instant::now();
            let state = json!({"directory":dir,"run":run,"build":build,"incidents":incidents.len(),"queued":incidents.values().filter(|i|i.repair=="queued").count(),"running":job.as_ref().map(|(_,id)|id),"enabled":config.enabled,"jobs_today":jobs_today,"dropped":DROPPED.load(Ordering::Relaxed)});
            crate::persist::write_atomic(
                &dir.join("status.json"),
                serde_json::to_vec_pretty(&state)?,
            )?;
        }
    }
    Ok(())
}
fn valid_incident(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|c| c.is_ascii_hexdigit())
}
fn save_incident(dir: &Path, incident: &Incident) -> anyhow::Result<()> {
    anyhow::ensure!(valid_incident(&incident.id), "invalid incident id");
    crate::persist::write_atomic(
        &dir.join("incidents").join(format!("{}.json", incident.id)),
        serde_json::to_vec_pretty(incident)?,
    )?;
    Ok(())
}
fn save_incidents(dir: &Path, incidents: &BTreeMap<String, Incident>) -> anyhow::Result<()> {
    for incident in incidents.values() {
        save_incident(dir, incident)?;
    }
    Ok(())
}
pub fn status() -> Value {
    let mut state: Value = std::fs::read(directory().join("status.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({"directory":directory(),"state":"starting"}));
    state["last_repair"] = std::fs::read(directory().join("last-repair.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    state["native_pending_exit"] = json!(directory().join("pending-native.json").is_file());
    state
}

/// A fixed, reviewed helper installs a verified candidate only after this GUI exits.
pub fn schedule_native_install() {
    if !cfg!(windows) || !directory().join("pending-native.json").is_file() {
        return;
    }
    let config: Value = std::fs::read(directory().join("auto-repair.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let Some(repo) = config["repository"].as_str() else {
        return;
    };
    let script = Path::new(repo).join("scripts/apply-native-repair.ps1");
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    if script.is_file() {
        let _ = crate::spawn::command("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script)
            .arg("-Diagnostics")
            .arg(directory())
            .arg("-Executable")
            .arg(exe)
            .arg("-ParentPid")
            .arg(std::process::id().to_string())
            .spawn();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logs_mask_credentials_and_never_keep_task_arguments() {
        let value = safe(
            &json!({"message":"Authorization: Bearer abcdef1234567890 password=hunter2 api_key=12345678 ghp_123456789012345678901234","prompt":"private task","clipboard":"private copy"}),
        );
        let text = value.to_string();
        for secret in [
            "abcdef1234567890",
            "hunter2",
            "12345678",
            "private task",
            "private copy",
        ] {
            assert!(!text.contains(secret), "{text}");
        }
        assert!(redact("한글 오류 ✓").contains("한글 오류"));
    }
    #[test]
    fn incidents_group_volatile_ids_and_retain_distinct_causes() {
        let a = fingerprint(
            "script",
            "panel",
            "failed 01234567-1111-2222-3333-444444444444",
        );
        let b = fingerprint(
            "script",
            "panel",
            "failed aaaaaaaa-1111-2222-3333-444444444444",
        );
        assert_eq!(a, b);
        assert_ne!(a, fingerprint("script", "panel", "different cause"));
    }
    #[test]
    fn log_rotation_is_bounded_and_keeps_complete_json_lines() {
        let dir = std::env::temp_dir().join(format!(
            "herdr-diagnostics-test-{}-{}",
            std::process::id(),
            now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("events.jsonl");
        for i in 0..30 {
            append(&log, &json!({"n":i,"text":"한글"}), 40).unwrap();
        }
        let files = std::fs::read_dir(&dir)
            .unwrap()
            .map(|f| f.unwrap().path())
            .collect::<Vec<_>>();
        assert!(files.len() <= ROTATIONS + 1);
        for file in files {
            for line in std::fs::read_to_string(file).unwrap().lines() {
                serde_json::from_str::<Value>(line).unwrap();
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn validation_errors_do_not_start_ai_and_render_failures_do() {
        assert!(!repairable("command", "folder missing"));
        assert!(!repairable("runtime", "network unavailable"));
        assert!(repairable("mod_render", "TypeError"));
        assert!(transient("execution interrupted"));
        assert!(!transient("permission denied"));
    }

    #[test]
    fn worker_records_redacted_incident_counts_and_source_context() {
        let dir = std::env::temp_dir().join(format!(
            "herdr-diagnostics-worker-{}-{}",
            std::process::id(),
            now()
        ));
        let (tx, rx) = mpsc::sync_channel(8);
        let copy = dir.clone();
        let thread = std::thread::spawn(move || worker(&copy, rx).unwrap());
        for _ in 0..2 {
            tx.send(Message::Event(json!({"kind":"error","category":"mod_render","source":"probe","error":"TypeError password=do-not-retain","context":{"pane":"test-pane"}}))).unwrap();
        }
        drop(tx);
        thread.join().unwrap();
        let files = std::fs::read_dir(dir.join("incidents"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(files.len(), 1);
        let text = std::fs::read_to_string(files[0].path()).unwrap();
        assert!(!text.contains("do-not-retain"));
        let incident: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(incident["count"], 2);
        assert_eq!(incident["sample"]["context"]["pane"], "test-pane");
        assert_eq!(incident["repair"], "queued");
        assert!(
            std::fs::read_to_string(dir.join("events.jsonl"))
                .unwrap()
                .lines()
                .all(|l| serde_json::from_str::<Value>(l).is_ok())
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
