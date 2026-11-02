//! Windows AI session bindings. Transcripts remain in each AI's own store.
//! Observation runs off the UI thread; only the window may replace a pane.
use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{File, OpenOptions},
    io::{BufRead, Read},
    path::{Path, PathBuf},
    sync::mpsc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug)]
pub struct Binding {
    pub space: String,
    pub tab: String,
    pub pane: String,
    pub terminal: String,
    pub pid: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Entry {
    pub space: String,
    pub tab: String,
    pub pane: String,
    pub terminal: String,
    pub root_pid: u32,
    pub root_start: String,
    pub agent: String,
    pub session_id: String,
    pub cwd: String,
    pub transcript: String,
    pub options: Vec<String>,
    pub active: bool,
    pub updated_ms: u64,
    pub attempted_root: String,
    pub error: Option<String>,
    pub settling_until_ms: u64,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Store {
    version: u32,
    home: String,
    enabled: bool,
    checked_ms: u64,
    entries: BTreeMap<String, Entry>,
    unresolved: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub binding: Binding,
    pub start: String,
    pub entry: Entry,
}

pub enum Notice {
    Restore(Plan),
    Error(String),
    ManualFinished(ManualAction, Result<String, String>),
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ManualAction { Save, Restore }

enum Message {
    Frame(Vec<Binding>, bool),
    Manual(ManualAction, Vec<Binding>, bool),
    Result(String, String, Option<(String, u32)>, Option<String>),
    Stop(mpsc::Sender<()>),
}

pub struct Manager {
    tx: mpsc::Sender<Message>,
    rx: mpsc::Receiver<Notice>,
    last_frame: Option<Instant>,
    stopped: bool,
    manual_pending: bool,
}

pub fn root() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Herdr/session-restore")
}

pub fn state_path() -> PathBuf {
    use sha2::{Digest, Sha256};
    let home = crate::mods::app_dir();
    let default = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".config/herdr-app");
    let session = std::env::var("HC_SESSION").unwrap_or_else(|_| "default".into());
    let name = if home == default && session == "default" {
        "session-restore.json".into()
    } else {
        let digest = Sha256::digest(format!(
            "{}:{session}",
            home.to_string_lossy().to_lowercase()
        ));
        format!("session-restore-{}.json", &format!("{digest:x}")[..16])
    };
    root().parent().unwrap().join(name)
}

pub fn status() -> serde_json::Value {
    let path = state_path();
    match std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Store>(&b).ok())
    {
        Some(s) => serde_json::json!({"file":path,"enabled":s.enabled,"tracked":s.entries.len(),
            "active":s.entries.values().filter(|e|e.active).count(),"checked_ms":s.checked_ms,"unresolved":s.unresolved,
            "issues":s.entries.values().filter_map(|e|e.error.as_ref().map(|error|serde_json::json!({"pane":e.pane,"error":error}))).collect::<Vec<_>>()}),
        None => serde_json::json!({"file":path,"state":"starting_or_unavailable"}),
    }
}

impl Manager {
    pub fn new(core: std::sync::Arc<crate::hc::Core>) -> Self {
        let (tx, input) = mpsc::channel();
        let (output, rx) = mpsc::channel();
        if cfg!(windows) {
            std::thread::spawn(move || {
                if let Err(e) = worker(input, &output, core) {
                    let _ = output.send(Notice::Error(format!("AI session memory: {e:#}")));
                }
            });
        }
        Self {
            tx,
            rx,
            last_frame: None,
            stopped: false,
            manual_pending: false,
        }
    }

    pub fn update(&mut self, bindings: Vec<Binding>, can_restore: bool) -> Vec<Notice> {
        if self
            .last_frame
            .is_none_or(|t| t.elapsed() >= Duration::from_secs(2))
            && !self.stopped
        {
            self.last_frame = Some(Instant::now());
            let _ = self.tx.send(Message::Frame(bindings, can_restore));
        }
        let notices: Vec<_> = self.rx.try_iter().collect();
        if notices.iter().any(|n| matches!(n, Notice::ManualFinished(..) | Notice::Error(_))) {
            self.manual_pending = false;
        }
        notices
    }

    pub fn request(&mut self, action: ManualAction, bindings: Vec<Binding>, ready: bool) -> Result<(), String> {
        if self.stopped || self.manual_pending { return Err("대화 저장·복원이 이미 진행 중입니다.".into()); }
        self.tx.send(Message::Manual(action, bindings, ready)).map_err(|_| "대화 기억 기능을 사용할 수 없습니다. 설정과 오류 기록을 확인하세요.".to_owned())?;
        self.manual_pending = true;
        Ok(())
    }

    pub fn completed(&self, plan: &Plan, new: Option<(String, u32)>, error: Option<String>) {
        let _ = self.tx.send(Message::Result(
            plan.binding.pane.clone(),
            plan.entry.session_id.clone(),
            new,
            error,
        ));
    }

    pub fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        if cfg!(windows) {
            let (tx, rx) = mpsc::channel();
            if self.tx.send(Message::Stop(tx)).is_ok()
                && rx.recv_timeout(Duration::from_secs(10)).is_err()
            {
                tracing::warn!("AI session memory did not finish within the quit budget");
            }
        }
    }

    pub fn finish(&mut self, bindings: Vec<Binding>) {
        #[cfg(windows)]
        let shutting_down =
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(0x2000) != 0 };
        #[cfg(not(windows))]
        let shutting_down = false;
        let _ = self.tx.send(Message::Frame(
            if shutting_down { vec![] } else { bindings },
            false,
        ));
        self.stop();
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        self.stop();
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct ProcessRoot {
    pid: u32,
    start: String,
    idle_shell: bool,
    holder_pid: u32,
}
#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Agent {
    pid: u32,
    start: String,
    ancestors: Vec<u32>,
    agent: String,
    session_id: Option<String>,
    cwd: Option<String>,
    transcript: Option<String>,
    options: Vec<String>,
    days: Vec<String>,
}
#[derive(Default, Deserialize)]
struct Scan {
    roots: Vec<ProcessRoot>,
    agents: Vec<Agent>,
    #[serde(default)]
    claims: Vec<Claim>,
    #[serde(default)]
    claude_projects: String,
}
#[derive(Default, Deserialize)]
#[serde(default)]
struct Claim {
    agent: String,
    session_id: String,
    cwd: String,
    transcript: String,
    model: String,
    updated_ms: u64,
    ended: bool,
    lineage: Vec<ProcessRoot>,
}

fn scan(bindings: &[Binding]) -> Result<Scan> {
    #[cfg(test)]
    let links = std::env::var_os("HERDR_RESTORE_TEST_LINKS")
        .map(PathBuf::from)
        .unwrap_or_else(|| root().join("links"));
    #[cfg(not(test))]
    let links = root().join("links");
    let roots = bindings
        .iter()
        .map(|b| b.pid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let mut child = crate::spawn::command("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(root().join("scan.ps1"))
        .arg("-Roots")
        .arg(roots)
        .arg("-Links")
        .arg(links)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || {
        let mut b = Vec::new();
        stdout.read_to_end(&mut b).map(|_| b)
    });
    let err = std::thread::spawn(move || {
        let mut b = String::new();
        stderr.read_to_string(&mut b).map(|_| b)
    });
    let deadline = Instant::now() + Duration::from_secs(8);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("process observation timed out; no sessions were changed");
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let bytes = out
        .join()
        .map_err(|_| anyhow::anyhow!("process observation reader failed"))??;
    let errors = err
        .join()
        .map_err(|_| anyhow::anyhow!("process observation error reader failed"))??;
    if !status.success() {
        bail!("process observation failed: {errors}");
    }
    let mut snapshot: Scan =
        serde_json::from_slice(&bytes).context("invalid process observation")?;
    enrich(&mut snapshot);
    Ok(snapshot)
}

fn enrich(scan: &mut Scan) {
    let projects = std::fs::read_dir(&scan.claude_projects)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect::<Vec<_>>();
    for agent in &mut scan.agents {
        let Some(sid) = agent.session_id.as_deref().filter(|id| valid_id(id)) else {
            continue;
        };
        let existing = agent
            .transcript
            .as_deref()
            .map(PathBuf::from)
            .filter(|p| p.is_file());
        let transcript = existing.or_else(|| {
            if agent.agent == "claude" {
                projects
                    .iter()
                    .map(|p| p.join(format!("{sid}.jsonl")))
                    .find(|p| p.is_file())
            } else {
                agent
                    .days
                    .iter()
                    .filter_map(|d| std::fs::read_dir(d).ok())
                    .flatten()
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .find(|p| {
                        p.file_name()
                            .is_some_and(|n| n.to_string_lossy().ends_with(&format!("{sid}.jsonl")))
                    })
            }
        });
        if let Some(path) = transcript {
            if agent.agent == "codex" {
                let header = (|| -> Result<serde_json::Value> {
                    let mut line = String::new();
                    std::io::BufReader::new(File::open(&path)?.take(1024 * 1024))
                        .read_line(&mut line)?;
                    Ok(serde_json::from_str(&line)?)
                })();
                match header {
                    Ok(v) if v["type"] == "session_meta" && v["payload"]["id"] == sid => {
                        agent.cwd = v["payload"]["cwd"].as_str().map(str::to_owned);
                    }
                    _ => {
                        agent.session_id = None;
                        continue;
                    }
                }
            }
            agent.transcript = Some(path.to_string_lossy().into_owned());
        }
    }
}

fn load(path: &Path, home: &str) -> Result<Store> {
    let backup = path.with_extension("json.bak");
    let parse = |path: &Path| -> Result<Store> {
        let store: Store = serde_json::from_slice(&std::fs::read(path)?)?;
        if store.version != 1 || store.home != home {
            bail!("unsupported session memory version or app home");
        }
        Ok(store)
    };
    if !path.exists() && !backup.exists() {
        return Ok(Store {
            version: 1,
            home: home.into(),
            enabled: true,
            ..Default::default()
        });
    }
    match parse(path) {
        Ok(store) => Ok(store),
        Err(first) => {
            let store = parse(&backup).with_context(|| {
                format!("session memory and backup cannot be loaded: {first:#}")
            })?;
            // Preserve the damaged file; never silently start with an empty mapping.
            if path.exists() {
                std::fs::rename(path, path.with_extension(format!("json.corrupt-{}", now())))?;
            }
            crate::persist::write_atomic(path, serde_json::to_vec_pretty(&store)?)?;
            Ok(store)
        }
    }
}

fn save(path: &Path, store: &Store) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(store)?;
    if let Ok(previous) = std::fs::read(path) {
        // Only rotate a readable, compatible previous state into the backup.
        let old: Store = serde_json::from_slice(&previous)?;
        if old.version != 1 || old.home != store.home {
            bail!("refusing to overwrite incompatible session memory");
        }
        crate::persist::write_atomic(&path.with_extension("json.bak"), previous)?;
    }
    crate::persist::write_atomic(path, bytes)?;
    Ok(())
}

fn worker(
    input: mpsc::Receiver<Message>,
    output: &mpsc::Sender<Notice>,
    core: std::sync::Arc<crate::hc::Core>,
) -> Result<()> {
    std::fs::create_dir_all(root().join("links"))?;
    let path = state_path();
    let _lock: File = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("json.lock"))?;
    // A second window must not race the owner, including across Windows sessions.
    _lock
        .try_lock()
        .context("another window already owns AI session memory")?;
    crate::persist::write_atomic(
        &root().join("scan.ps1"),
        include_bytes!("session_restore/scan.ps1"),
    )?;
    crate::persist::write_atomic(
        &root().join("hook.ps1"),
        include_bytes!("session_restore/hook.ps1"),
    )?;
    let home = crate::mods::app_dir().to_string_lossy().into_owned();
    let mut store = load(&path, &home)?;
    if !store.enabled {
        return Ok(());
    }
    if let Ok(list) = core.call_timeout(
        "terminal.list",
        serde_json::json!({}),
        Duration::from_secs(2),
    ) {
        for entry in store
            .entries
            .values_mut()
            .filter(|e| e.error.as_deref() == Some("Restore requested"))
        {
            let pending = list["terminals"].as_array().is_some_and(|records| {
                records.iter().any(|r| {
                    r["state"] == "live"
                        && r.pointer("/labels/herdr.restore.pane")
                            .and_then(serde_json::Value::as_str)
                            == Some(&entry.pane)
                        && r.pointer("/labels/herdr.restore.session")
                            .and_then(serde_json::Value::as_str)
                            == Some(&entry.session_id)
                })
            });
            if !pending && list["terminals"].is_array() {
                entry.attempted_root.clear();
                entry.error = None;
            }
        }
    }
    let mut frames = Vec::new();
    let mut can_restore = false;
    let mut written = String::new();
    let mut last_error = String::new();
    let mut last_scan = Instant::now() - Duration::from_secs(300);
    let mut last_trigger = String::new();
    loop {
        let message = match input.recv_timeout(Duration::from_secs(300)) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => Message::Frame(frames.clone(), can_restore),
            Err(_) => break,
        };
        let mut messages = vec![message];
        messages.extend(input.try_iter());
        let mut stop = None;
        let mut manual = None;
        for message in messages {
            match message {
                Message::Frame(bindings, ready) => {
                    frames = bindings;
                    can_restore = ready;
                }
                Message::Manual(action, bindings, ready) => { manual = Some((action, bindings, ready)); }
                Message::Result(pane, sid, new, error) => {
                    if let Some(entry) =
                        store.entries.get_mut(&pane).filter(|e| e.session_id == sid)
                    {
                        entry.error = error;
                        if let Some((address, pid)) = new {
                            entry.terminal = address;
                            entry.root_pid = pid;
                            entry.root_start.clear();
                            entry.settling_until_ms = now() + 30_000;
                        }
                    }
                }
                Message::Stop(ack) => {
                    stop = Some(ack);
                }
            }
        }
        let action = manual.as_ref().map(|(action, _, _)| *action);
        if let Some((action, bindings, ready)) = manual {
            frames = bindings;
            can_restore = ready && action == ManualAction::Restore;
            if ready { prepare_manual(&mut store, &frames, action); }
        }
        let mut queued = 0;
        let mut manual_error = None;
        let stamp = |directory: PathBuf| {
            std::fs::read_dir(directory)
                .into_iter()
                .flatten()
                .filter_map(|f| f.ok()?.metadata().ok()?.modified().ok())
                .max()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        };
        let trigger = format!(
            "{frames:?}:{can_restore}:{}:{}",
            stamp(root().join("links")),
            stamp(std::env::temp_dir().join("CodexTerminalTitles"))
        );
        if !frames.is_empty()
            && (action.is_some() || stop.is_some()
                || trigger != last_trigger
                || last_scan.elapsed() >= Duration::from_secs(300))
        {
            last_scan = Instant::now();
            last_trigger = trigger;
            match scan(&frames) {
                Ok(scan) => {
                    last_error.clear();
                    for plan in observe(
                        &mut store,
                        &frames,
                        &scan,
                        can_restore && stop.is_none(),
                        now(),
                    ) {
                        // Durably claim before dispatch. A crash or second window never replays
                        // an ambiguous launch; a new real process observation clears the claim.
                        save(&path, &store)?;
                        queued += 1;
                        let _ = output.send(Notice::Restore(plan));
                    }
                }
                Err(error) => {
                    let error = format!("{error:#}");
                    manual_error = Some(error.clone());
                    if error != last_error {
                        let _ = output.send(Notice::Error(error.clone()));
                        last_error = error;
                    }
                }
            }
        } else if frames.is_empty() && stop.is_none() && can_restore {
            store.entries.clear();
            store.unresolved.clear();
        }
        let body = serde_json::to_string(&(&store.entries, &store.unresolved))?;
        if action.is_some() || body != written || now().saturating_sub(store.checked_ms) >= 300_000 || stop.is_some() {
            store.checked_ms = now();
            save(&path, &store)?;
            written = body;
        }
        if let Some(action) = action {
            let result = manual_error.map_or_else(|| {
                let active = store.entries.values().filter(|e| e.active).count();
                let issues = store.unresolved.len() + store.entries.values().filter(|e| e.error.is_some() && e.error.as_deref() != Some("Restore requested") && !store.unresolved.contains_key(&e.pane)).count();
                Ok(match action {
                    ManualAction::Save => format!("대화 연결 {active}개를 저장했습니다. 확인이 필요한 항목: {issues}개."),
                    ManualAction::Restore => format!("복원 검사를 완료했습니다. 재개 요청: {queued}개, 확인 필요: {issues}개. 실행 중인 대화는 유지했습니다."),
                })
            }, Err);
            let _ = output.send(Notice::ManualFinished(action, result));
        }
        if let Some(ack) = stop {
            let _ = ack.send(());
            break;
        }
    }
    Ok(())
}

fn prepare_manual(store: &mut Store, bindings: &[Binding], action: ManualAction) {
    store.entries.retain(|pane, _| bindings.iter().any(|b| b.pane == *pane));
    store.unresolved.retain(|pane, _| bindings.iter().any(|b| b.pane == *pane));
    if action == ManualAction::Restore {
        for entry in store.entries.values_mut() {
            // An explicit retry may recheck a failed launch, never an in-flight one.
            if entry.error.is_some() && entry.error.as_deref() != Some("Restore requested") {
                entry.attempted_root.clear();
            }
        }
    }
}

fn observe(
    store: &mut Store,
    bindings: &[Binding],
    scan: &Scan,
    ready: bool,
    time: u64,
) -> Vec<Plan> {
    let panes = bindings
        .iter()
        .map(|b| b.pane.as_str())
        .collect::<HashSet<_>>();
    if ready {
        store
            .entries
            .retain(|pane, _| panes.contains(pane.as_str()));
        store
            .unresolved
            .retain(|pane, _| panes.contains(pane.as_str()));
    }
    let mut plans = Vec::new();
    for b in bindings {
        let Some(root) = scan
            .roots
            .iter()
            .find(|r| r.pid == b.pid && !r.start.is_empty())
        else {
            continue;
        };
        let all = scan
            .agents
            .iter()
            .filter(|a| a.ancestors.contains(&b.pid))
            .collect::<Vec<_>>();
        let agents = all
            .iter()
            .copied()
            .filter(|a| {
                !all.iter()
                    .any(|p| p.pid != a.pid && a.ancestors.contains(&p.pid))
            })
            .collect::<Vec<_>>();
        // More than one AI under a shell can be a sub-agent. Never infer ownership.
        if agents.len() == 1 {
            let a = agents[0];
            if let (Some(sid), Some(cwd), Some(transcript)) = (&a.session_id, &a.cwd, &a.transcript)
                && valid_id(sid)
                && !cwd.is_empty()
                && Path::new(transcript).is_file()
            {
                let same = store.entries.get(&b.pane).filter(|e| {
                    e.session_id == *sid && e.root_start == root.start && e.root_pid == root.pid
                });
                let timestamp = same.map_or(time, |e| e.updated_ms);
                store.entries.insert(
                    b.pane.clone(),
                    Entry {
                        space: b.space.clone(),
                        tab: b.tab.clone(),
                        pane: b.pane.clone(),
                        terminal: b.terminal.clone(),
                        root_pid: root.pid,
                        root_start: root.start.clone(),
                        agent: a.agent.clone(),
                        session_id: sid.clone(),
                        cwd: cwd.clone(),
                        transcript: transcript.clone(),
                        options: a.options.clone(),
                        active: true,
                        updated_ms: timestamp,
                        ..Default::default()
                    },
                );
                store.unresolved.remove(&b.pane);
            } else {
                let reason = "The running AI has not reported an exact resumable conversation ID";
                store.unresolved.insert(b.pane.clone(), reason.into());
                if let Some(entry) = store.entries.get_mut(&b.pane) {
                    entry.active = false;
                    entry.error = Some(reason.into());
                }
            }
            continue;
        }
        if !agents.is_empty() {
            store.unresolved.insert(
                b.pane.clone(),
                "Multiple independent AIs share this terminal".into(),
            );
            if let Some(entry) = store.entries.get_mut(&b.pane) {
                entry.active = false;
                entry.updated_ms = time;
                entry.error = Some(
                    "Multiple independent AIs share this terminal; automatic restore is paused"
                        .into(),
                );
            }
            continue;
        }
        store.unresolved.remove(&b.pane);
        let Some(entry) = store.entries.get_mut(&b.pane) else {
            continue;
        };
        // Hooks keep the connection current even when the window is closed. Match
        // the previous shell's PID AND birth time, never just a folder or a PID.
        if let Some(claim) = scan
            .claims
            .iter()
            .filter(|c| {
                c.updated_ms > entry.updated_ms
                    && c.lineage
                        .iter()
                        .any(|p| p.pid == entry.root_pid && p.start == entry.root_start)
            })
            .max_by_key(|c| c.updated_ms)
            && valid_id(&claim.session_id)
            && matches!(claim.agent.as_str(), "codex" | "claude")
        {
            if claim.session_id != entry.session_id {
                entry.options.clear();
                if !claim.model.is_empty()
                    && !claim.model.starts_with('-')
                    && !claim.model.chars().any(char::is_control)
                {
                    entry.options = vec!["--model".into(), claim.model.clone()];
                }
                entry.attempted_root.clear();
            }
            entry.agent = claim.agent.clone();
            entry.session_id = claim.session_id.clone();
            entry.cwd = claim.cwd.clone();
            entry.transcript = claim.transcript.clone();
            entry.updated_ms = claim.updated_ms;
            entry.active = !claim.ended;
        }
        if scan.claims.iter().any(|claim| {
            claim.ended
                && claim.agent == entry.agent
                && claim.session_id == entry.session_id
                && claim.updated_ms >= entry.updated_ms
        }) {
            entry.active = false;
            continue;
        }
        // A different terminal manually assigned to this pane is not recovery.
        if b.terminal != entry.terminal {
            entry.active = false;
            continue;
        }
        if time < entry.settling_until_ms {
            continue;
        }
        if entry.root_start.is_empty() {
            entry.root_start = root.start.clone();
        }
        if root.pid == entry.root_pid && root.start == entry.root_start {
            // The shell survived and its AI exited normally: do not resurrect it.
            entry.active = false;
            if entry.settling_until_ms != 0 {
                entry.error =
                    Some("The resumed AI did not become ready; check its terminal".into());
            }
            continue;
        }
        let key = format!("{}:{}", root.pid, root.start);
        if !ready || !entry.active || !root.idle_shell || entry.attempted_root == key {
            continue;
        }
        entry.attempted_root = key;
        if scan
            .agents
            .iter()
            .any(|a| a.session_id.as_deref() == Some(&entry.session_id))
        {
            entry.error = Some("This conversation is already running in another terminal".into());
            continue;
        }
        if let Err(error) = validate(entry) {
            entry.error = Some(error.to_string());
            continue;
        }
        entry.error = Some("Restore requested".into());
        plans.push(Plan {
            binding: b.clone(),
            start: root.start.clone(),
            entry: entry.clone(),
        });
    }
    plans
}

pub fn validate(entry: &Entry) -> Result<()> {
    if !valid_id(&entry.session_id) || !matches!(entry.agent.as_str(), "codex" | "claude") {
        bail!("Missing or invalid conversation ID");
    }
    if !Path::new(&entry.cwd).is_dir() {
        bail!("Conversation folder is unavailable: {}", entry.cwd);
    }
    let path = Path::new(&entry.transcript);
    if !path.is_file()
        || !path.file_name().is_some_and(|n| {
            n.to_string_lossy()
                .ends_with(&format!("{}.jsonl", entry.session_id))
        })
    {
        bail!("The saved conversation file is unavailable");
    }
    // File contents are never executed. Only a small whitelist of CLI options can persist.
    let _ = resume_argv(entry)?;
    Ok(())
}

pub fn resume_argv(entry: &Entry) -> Result<Vec<String>> {
    if !valid_id(&entry.session_id) {
        bail!("Invalid conversation ID");
    }
    let mut argv = vec![entry.agent.clone()];
    if entry.agent == "codex" {
        argv.push("--no-daemon".into());
    }
    let mut options = entry.options.iter();
    while let Some(option) = options.next() {
        match option.as_str() {
            "--model" | "-m" | "--effort" | "--permission-mode" | "--sandbox" | "-s"
            | "--ask-for-approval" | "-a" => {
                let value = options.next().context("Missing launch option value")?;
                if value.starts_with('-') || value.chars().any(char::is_control) {
                    bail!("Invalid launch option value");
                }
                argv.extend([option.clone(), value.clone()]);
            }
            "-c" => {
                let value = options.next().context("Missing reasoning setting")?;
                if !["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
                    .iter()
                    .any(|v| value == &format!("model_reasoning_effort=\"{v}\""))
                {
                    bail!("Unsupported saved setting");
                }
                argv.extend([option.clone(), value.clone()]);
            }
            "--dangerously-skip-permissions" if entry.agent == "claude" => {
                argv.push(option.clone())
            }
            "--dangerously-bypass-approvals-and-sandbox" if entry.agent == "codex" => {
                argv.push(option.clone())
            }
            _ => bail!("Unsupported saved launch option"),
        }
    }
    if entry.agent == "codex" {
        argv.extend([
            "resume".into(),
            entry.session_id.clone(),
            "-C".into(),
            entry.cwd.clone(),
        ]);
    } else if entry.agent == "claude" {
        argv.extend(["--resume".into(), entry.session_id.clone()]);
    } else {
        bail!("Unsupported AI program");
    }
    Ok(argv)
}

/// Recheck immediately before launching, off the UI thread. No user's shell receives input.
pub fn launch(core: &crate::hc::Core, plan: &Plan) -> Result<(String, u32)> {
    validate(&plan.entry)?;
    let scan = scan(std::slice::from_ref(&plan.binding))?;
    if !scan
        .roots
        .iter()
        .any(|r| r.pid == plan.binding.pid && r.start == plan.start && r.idle_shell)
        || scan.agents.iter().any(|a| {
            a.session_id.as_deref() == Some(&plan.entry.session_id)
                || a.ancestors.contains(&plan.binding.pid)
        })
    {
        bail!("Terminal changed or the conversation is already running");
    }
    let record = core.call(
        "terminal.get",
        serde_json::json!({"terminal":plan.binding.terminal}),
    )?;
    if record["state"] != "live" || record["pid"].as_u64() != Some(plan.binding.pid as u64) {
        bail!("Terminal changed before restore");
    }
    let argv = resume_argv(&plan.entry)?;
    let shell = crate::window::shell();
    use sha2::{Digest, Sha256};
    let job = Sha256::digest(format!(
        "{}:{}:{}",
        plan.binding.pane, plan.binding.pid, plan.start
    ));
    let name = format!("hrestore-{}", &format!("{job:x}")[..16]);
    let result=core.call("terminal.run",serde_json::json!({
        "argv":vec![shell,"-NoExit".into(),"-Command".into(),crate::programs::powershell_line(&argv)],
        "cwd":plan.entry.cwd,"keep":true,"name":name,
        "env":{"TERM":"xterm-256color","COLORTERM":"truecolor","TERM_PROGRAM":"herdr"},
        "labels":{"herdr.restore.pane":plan.binding.pane,"herdr.restore.session":plan.entry.session_id,
            "herdr.restore.old":plan.binding.terminal,"herdr.restore.space":plan.binding.space,"herdr.restore.tab":plan.binding.tab}
    }))?;
    let address = result["address"]
        .as_str()
        .context("Restored terminal has no address")?
        .to_owned();
    let record = core
        .call("terminal.get", serde_json::json!({"terminal":address}))
        .context(
            "Restored terminal was created; its journal labels preserve the pending connection",
        )?;
    Ok((address, record["pid"].as_u64().unwrap_or(0) as u32))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> Binding {
        Binding {
            space: "s".into(),
            tab: "t".into(),
            pane: "p".into(),
            terminal: "t1".into(),
            pid: 20,
        }
    }
    fn entry() -> Entry {
        Entry {
            space: "s".into(),
            tab: "t".into(),
            pane: "p".into(),
            terminal: "t1".into(),
            root_pid: 10,
            root_start: "old".into(),
            agent: "codex".into(),
            session_id: "019a4055-2222-7333-8444-555555555555".into(),
            active: true,
            ..Default::default()
        }
    }
    fn store(e: Entry) -> Store {
        Store {
            version: 1,
            enabled: true,
            entries: [("p".into(), e)].into(),
            ..Default::default()
        }
    }
    fn idle() -> Scan {
        Scan {
            roots: vec![ProcessRoot {
                pid: 20,
                start: "new".into(),
                idle_shell: true,
                holder_pid: 0,
            }],
            agents: vec![],
            claims: vec![],
            claude_projects: String::new(),
        }
    }
    #[test]
    fn exact_resume_has_no_task_and_rejects_unknown_options() {
        let mut e = entry();
        e.cwd = "D:/회의 자료/O'Brien".into();
        e.options = vec!["-m".into(), "gpt-6.1-sol".into()];
        let args = resume_argv(&e).unwrap();
        assert_eq!(
            args,
            vec![
                "codex",
                "--no-daemon",
                "-m",
                "gpt-6.1-sol",
                "resume",
                &e.session_id,
                "-C",
                &e.cwd
            ]
        );
        e.options = vec!["--config".into(), "malicious_command=true".into()];
        assert!(resume_argv(&e).is_err());
        assert!(!valid_id("../../other"));
        assert!(valid_id(&e.session_id));
    }
    #[test]
    fn manual_actions_prune_closed_panes_and_retry_failures_without_replaying_pending_launches() {
        let mut e = entry();
        e.error = Some("missing transcript".into());
        e.attempted_root = "20:new".into();
        let mut s = store(e);
        prepare_manual(&mut s, &[binding()], ManualAction::Save);
        assert_eq!(s.entries["p"].attempted_root, "20:new");
        prepare_manual(&mut s, &[binding()], ManualAction::Restore);
        assert!(s.entries["p"].attempted_root.is_empty());
        let e = s.entries.get_mut("p").unwrap();
        e.error = Some("Restore requested".into());
        e.attempted_root = "20:new".into();
        prepare_manual(&mut s, &[binding()], ManualAction::Restore);
        assert_eq!(s.entries["p"].attempted_root, "20:new");
        s.unresolved.insert("p".into(), "unresolved".into());
        prepare_manual(&mut s, &[], ManualAction::Save);
        assert!(s.entries.is_empty());
        assert!(s.unresolved.is_empty());
    }

    #[test]
    fn manual_requests_are_serialized_and_worker_failure_is_reported() {
        let (tx, input) = mpsc::channel();
        let (output, rx) = mpsc::channel();
        let mut manager = Manager { tx, rx, last_frame: Some(Instant::now()), stopped: false, manual_pending: false };
        assert!(manager.request(ManualAction::Save, vec![], true).is_ok());
        assert!(manager.request(ManualAction::Restore, vec![], true).is_err());
        assert!(matches!(input.try_recv().unwrap(), Message::Manual(ManualAction::Save, _, true)));
        output.send(Notice::ManualFinished(ManualAction::Save, Ok("saved".into()))).unwrap();
        assert_eq!(manager.update(vec![], true).len(), 1);
        assert!(manager.request(ManualAction::Restore, vec![], true).is_ok());
        output.send(Notice::Error("worker stopped".into())).unwrap();
        manager.update(vec![], true);
        drop(input);
        assert!(manager.request(ManualAction::Save, vec![], true).is_err());
        manager.stopped = true;
    }
    #[test]
    fn live_ai_and_core_reconnect_never_restore() {
        let mut s = store(entry());
        let mut scan = idle();
        scan.agents.push(Agent {
            ancestors: vec![20],
            ..Default::default()
        });
        assert!(observe(&mut s, &[binding()], &scan, true, 100).is_empty());
        assert!(!s.entries["p"].active);
        let mut e = entry();
        e.root_pid = 20;
        e.root_start = "new".into();
        let mut s = store(e);
        assert!(observe(&mut s, &[binding()], &idle(), true, 100).is_empty());
        assert!(!s.entries["p"].active);
    }
    #[test]
    fn closed_panes_manual_reassignment_and_busy_shells_are_excluded() {
        let mut s = store(entry());
        observe(&mut s, &[], &idle(), false, 100);
        assert_eq!(s.entries.len(), 1);
        observe(&mut s, &[], &idle(), true, 100);
        assert!(s.entries.is_empty());
        let mut b = binding();
        b.terminal = "t2".into();
        let mut s = store(entry());
        observe(&mut s, &[b], &idle(), true, 100);
        assert!(!s.entries["p"].active);
        let mut scan = idle();
        scan.roots[0].idle_shell = false;
        let mut s = store(entry());
        observe(&mut s, &[binding()], &scan, true, 100);
        assert!(s.entries["p"].attempted_root.is_empty());
    }
    #[test]
    fn missing_transcript_and_duplicate_conversation_are_never_guessed() {
        let mut s = store(entry());
        observe(&mut s, &[binding()], &idle(), true, 100);
        assert!(s.entries["p"].error.is_some());
        assert_eq!(s.entries["p"].attempted_root, "20:new");
        let mut scan = idle();
        scan.agents.push(Agent {
            session_id: Some(entry().session_id),
            ancestors: vec![99],
            ..Default::default()
        });
        let mut s = store(entry());
        observe(&mut s, &[binding()], &scan, true, 100);
        assert!(
            s.entries["p"]
                .error
                .as_deref()
                .unwrap()
                .contains("already running")
        );
    }
    #[test]
    fn corrupt_memory_uses_backup_and_preserves_damaged_file() {
        let dir = std::env::temp_dir().join(format!(
            "herdr-restore-test-{}-{}",
            std::process::id(),
            now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let mut s = store(entry());
        s.home = "test".into();
        save(&path, &s).unwrap();
        save(&path, &s).unwrap();
        std::fs::write(&path, b"broken").unwrap();
        let recovered = load(&path, "test").unwrap();
        assert_eq!(recovered.entries.len(), 1);
        assert!(std::fs::read_dir(&dir).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .contains("corrupt-")
        }));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn lost_root_restores_exact_binding_once_and_keeps_same_pid_reuse_distinct() {
        let dir = std::env::temp_dir().join(format!(
            "herdr-restore-positive-{}-{}",
            std::process::id(),
            now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut e = entry();
        e.cwd = dir.to_string_lossy().into_owned();
        let transcript = dir.join(format!("{}.jsonl", e.session_id));
        std::fs::write(&transcript, "{}\n").unwrap();
        e.transcript = transcript.to_string_lossy().into_owned();
        let mut s = store(e.clone());
        let plans = observe(&mut s, &[binding()], &idle(), true, 100);
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].binding.pane, "p");
        assert_eq!(plans[0].entry.session_id, e.session_id);
        assert!(observe(&mut s, &[binding()], &idle(), true, 200).is_empty());
        // The claim survives an app restart, even before a launch acknowledgement.
        let mut restarted: Store =
            serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert!(observe(&mut restarted, &[binding()], &idle(), true, 300).is_empty());
        e.root_pid = 20;
        let mut reused = store(e.clone());
        assert_eq!(
            observe(&mut reused, &[binding()], &idle(), true, 100).len(),
            1
        );
        let mut ended = idle();
        ended.claims.push(Claim {
            agent: "codex".into(),
            session_id: e.session_id.clone(),
            ended: true,
            updated_ms: 100,
            ..Default::default()
        });
        let mut resumed = e.clone();
        resumed.updated_ms = 200;
        let mut s = store(resumed);
        assert_eq!(
            observe(&mut s, &[binding()], &ended, true, 300).len(),
            1,
            "an old normal exit cannot cancel a later resumed conversation"
        );
        let mut s = store(e);
        assert!(observe(&mut s, &[binding()], &ended, true, 100).is_empty());
        assert!(!s.entries["p"].active);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hooks_capture_switches_while_window_is_closed_but_reject_reused_pids() {
        let dir = std::env::temp_dir().join(format!(
            "herdr-restore-claims-{}-{}",
            std::process::id(),
            now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut e = entry();
        e.cwd = dir.to_string_lossy().into_owned();
        let old_file = dir.join(format!("{}.jsonl", e.session_id));
        std::fs::write(&old_file, "{}\n").unwrap();
        e.transcript = old_file.to_string_lossy().into_owned();
        let sid = "019a4055-2222-7333-8444-666666666666";
        let new_file = dir.join(format!("{sid}.jsonl"));
        std::fs::write(&new_file, "{}\n").unwrap();
        let mut scan = idle();
        scan.claims.push(Claim {
            agent: "codex".into(),
            session_id: sid.into(),
            cwd: e.cwd.clone(),
            transcript: new_file.to_string_lossy().into_owned(),
            updated_ms: 50,
            lineage: vec![ProcessRoot {
                pid: 10,
                start: "old".into(),
                ..Default::default()
            }],
            ..Default::default()
        });
        let mut s = store(e.clone());
        let plans = observe(&mut s, &[binding()], &scan, true, 100);
        assert_eq!(plans[0].entry.session_id, sid);
        scan.claims[0].lineage[0].start = "different-birth".into();
        let mut s = store(e.clone());
        let plans = observe(&mut s, &[binding()], &scan, true, 100);
        assert_eq!(plans[0].entry.session_id, e.session_id);
        scan.claims[0].lineage[0].start = "old".into();
        scan.claims[0].ended = true;
        let mut s = store(e);
        assert!(observe(&mut s, &[binding()], &scan, true, 100).is_empty());
        assert!(!s.entries["p"].active);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Run separately with a scratch LOCALAPPDATA, HERDR_APP_HOME and HC_SESSION.
    /// Seeds one harmless reply in a real Codex TUI, then resumes without a new prompt.
    /// Never touches the user's core or asks an AI to use tools.
    #[test]
    #[ignore = "requires an isolated Windows core and installed Codex"]
    fn isolated_windows_loss_and_resume() {
        assert!(
            std::env::var("HC_SESSION")
                .unwrap_or_default()
                .starts_with("herdr-restore-test-")
        );
        assert!(
            std::env::var("LOCALAPPDATA")
                .unwrap()
                .contains("herdr-restore-test-")
        );
        std::fs::create_dir_all(root().join("links")).unwrap();
        crate::persist::write_atomic(
            &root().join("scan.ps1"),
            include_bytes!("session_restore/scan.ps1"),
        )
        .unwrap();
        let core = crate::hc::Core::connect().unwrap();
        let cwd = std::env::var("HERDR_RESTORE_TEST_CWD").expect("set an already trusted test cwd");
        let mut cmd = vec![
            "codex".into(),
            "--no-daemon".into(),
            "--no-alt-screen".into(),
        ];
        let seed = std::env::var("HERDR_RESTORE_TEST_SESSION_ID").ok();
        if let Some(sid) = &seed {
            assert!(valid_id(sid));
            cmd.extend(["resume".into(), sid.clone(), "-C".into(), cwd.clone()]);
        }
        let reused = std::env::var("HERDR_RESTORE_TEST_TERMINAL").ok();
        let address = if let Some(address) = &reused {
            address.clone()
        } else {
            core.run(
                vec![
                    crate::window::shell(),
                    "-NoExit".into(),
                    "-Command".into(),
                    crate::programs::powershell_line(&cmd),
                ],
                Some(cwd),
                serde_json::json!({}),
                None,
            )
            .unwrap()
        };
        let get = || {
            core.call("terminal.get", serde_json::json!({"terminal":address}))
                .unwrap()
        };
        let original_pid = get()["pid"].as_u64().unwrap() as u32;
        let mut b = Binding {
            terminal: address.clone(),
            pid: original_pid,
            ..binding()
        };
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut store = Store::default();
        let mut sent = reused.is_some() || seed.is_some();
        loop {
            let snapshot = scan(std::slice::from_ref(&b)).unwrap();
            observe(&mut store, std::slice::from_ref(&b), &snapshot, true, now());
            if store.entries.contains_key(&b.pane) {
                break;
            }
            if !sent
                && get()
                    .pointer("/status/app")
                    .and_then(serde_json::Value::as_str)
                    == Some("codex")
            {
                core.call("terminal.send",serde_json::json!({"terminal":address,
                    "text":"Reply exactly HERDR_RESTORE_TEST_OK. Do not use tools, edit files, or run commands. This is an isolated conversation resume test.","wait":false})).unwrap();
                sent = true;
            }
            if Instant::now() > deadline {
                panic!("empty Codex TUI did not report a resumable session; terminal {address}");
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        let original = store.entries[&b.pane].clone();
        core.call(
            "terminal.wait",
            serde_json::json!({"terminal":address,"timeout":30}),
        )
        .unwrap();
        println!("captured exact Codex ID and transcript of the isolated test conversation");
        // Terminate only this isolated core's holder. TerminateProcess on just a
        // shell is an ordinary exit on Windows, and correctly does not recover.
        let before_loss = scan(std::slice::from_ref(&b)).unwrap();
        let holder = before_loss
            .roots
            .iter()
            .find(|r| r.pid == original_pid)
            .unwrap()
            .holder_pid;
        assert_ne!(holder, 0);
        assert!(
            crate::spawn::command("taskkill.exe")
                .args(["/F", "/PID", &holder.to_string()])
                .status()
                .unwrap()
                .success()
        );
        let deadline = Instant::now() + Duration::from_secs(35);
        let plan = loop {
            let record = get();
            b.pid = record["pid"].as_u64().unwrap_or(0) as u32;
            if b.pid != 0 && b.pid != original_pid {
                let snapshot = scan(std::slice::from_ref(&b)).unwrap();
                let mut plans =
                    observe(&mut store, std::slice::from_ref(&b), &snapshot, true, now());
                if let Some(plan) = plans.pop() {
                    break plan;
                }
            }
            assert!(
                Instant::now() < deadline,
                "core did not recover this test's lost shell"
            );
            std::thread::sleep(Duration::from_millis(500));
        };
        println!("core recovered a new shell at the same terminal address");
        let (new, pid) = launch(&core, &plan).unwrap();
        let mut restored = b.clone();
        restored.terminal = new.clone();
        restored.pid = pid;
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            let snapshot = scan(std::slice::from_ref(&restored)).unwrap();
            if snapshot.agents.iter().any(|a| {
                a.ancestors.contains(&pid) && a.session_id.as_deref() == Some(&original.session_id)
            }) {
                println!(
                    "resumed the exact previous ID after real root loss; no duplicate and no prompt sent"
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Codex did not reopen the saved conversation"
            );
            std::thread::sleep(Duration::from_millis(500));
        }
        for terminal in [&new, &address] {
            core.call(
                "terminal.keep",
                serde_json::json!({"terminal":terminal,"keep":false}),
            )
            .unwrap();
            core.call("terminal.kill", serde_json::json!({"terminal":terminal}))
                .unwrap();
        }
    }
}
