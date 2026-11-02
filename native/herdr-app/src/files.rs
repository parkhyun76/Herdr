//! Watching the home folder for the files people and agents edit (settings,
//! keys, programs, themes, layouts, mods), so changes apply live without
//! looking at the disk on a timer. One OS watcher (FSEvents, inotify) for all.

use notify::{RecursiveMode, Watcher as _};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// What changed, relative to the home folder.
pub type Changed = Vec<PathBuf>;

/// Starts watching `home`; None if the OS watcher can't start (the app then
/// polls as before).
pub fn watch(home: &Path) -> Option<async_channel::Receiver<Changed>> {
    static WATCHER: OnceLock<std::sync::Mutex<notify::RecommendedWatcher>> = OnceLock::new();
    let (tx, rx) = async_channel::unbounded();
    let root = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let base = root.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        let changed: Changed = event.paths.iter().filter_map(|p| p.strip_prefix(&base).ok()).filter(|p| watched(p)).map(Path::to_path_buf).collect();
        if !changed.is_empty() {
            let _ = tx.send_blocking(changed);
        }
    })
    .map_err(|e| tracing::warn!("file watching unavailable ({e}); polling instead"))
    .ok()?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| tracing::warn!("cannot watch {} ({e}); polling instead", root.display())).ok()?;
    WATCHER.set(std::sync::Mutex::new(watcher)).ok()?;
    Some(rx)
}

/// The files that change what the app shows. The app's own state files
/// (view.json, shared.json, data/) change all the time and aren't.
fn watched(rel: &Path) -> bool {
    let mut parts = rel.components();
    let first = parts.next().and_then(|c| c.as_os_str().to_str()).unwrap_or_default();
    match first {
        "mods" => mod_file_counts(parts),
        "layouts" | "themes" => true,
        "settings.json" | "keys.json" | "programs.json" => parts.next().is_none(),
        _ => false,
    }
}

/// A change inside `mods/` that should reload a mod. The runtime writes its
/// typings and jsconfig into each mod on load, and editors drop hidden and
/// backup files: none of those are the mod's code.
fn mod_file_counts(rest: std::path::Components) -> bool {
    let parts: Vec<&str> = rest.filter_map(|c| c.as_os_str().to_str()).collect();
    if parts.iter().any(|p| p.starts_with('.') || p.ends_with('~') || *p == "node_modules") {
        return false;
    }
    !matches!(parts.as_slice(), [_, "jsconfig.json"] | [_, .., "gpui-kit.d.ts"])
}

/// Folders mods watch (`watchFolder`): one OS watcher each, shared by every
/// mod waiting on it. Changes collect while nobody waits, so none are missed.
struct Folder {
    _watcher: notify::RecommendedWatcher,
    waiters: Vec<async_channel::Sender<Vec<String>>>,
    pending: Vec<String>,
    flushing: bool,
}

static FOLDERS: OnceLock<std::sync::Mutex<std::collections::HashMap<PathBuf, Folder>>> = OnceLock::new();
/// Changes are batched this long (an editor's save is several events).
const BATCH: std::time::Duration = std::time::Duration::from_millis(150);
/// At most this many folders watched for mods at once.
const MAX_FOLDERS: usize = 64;

fn folders() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, Folder>> {
    FOLDERS.get_or_init(Default::default)
}

/// The next changes under `path` (recursive), as absolute paths: at once if
/// some came since the last call, else when the next batch lands.
pub async fn next_change(path: String) -> Result<Vec<String>, String> {
    let root = Path::new(&path).canonicalize().map_err(|e| format!("{path}: {e}"))?;
    let rx = {
        let mut all = folders().lock().unwrap();
        if !all.contains_key(&root) {
            if all.len() >= MAX_FOLDERS {
                return Err(format!("already watching {MAX_FOLDERS} folders"));
            }
            all.insert(root.clone(), Folder { _watcher: start_folder(&root)?, waiters: Vec::new(), pending: Vec::new(), flushing: false });
        }
        let f = all.get_mut(&root).unwrap();
        if !f.pending.is_empty() && !f.flushing {
            return Ok(std::mem::take(&mut f.pending));
        }
        let (tx, rx) = async_channel::bounded(1);
        f.waiters.push(tx);
        rx
    };
    rx.recv().await.map_err(|_| "stopped watching".to_owned())
}

fn start_folder(root: &Path) -> Result<notify::RecommendedWatcher, String> {
    let key = root.to_path_buf();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        let mut all = folders().lock().unwrap();
        let Some(f) = all.get_mut(&key) else { return };
        for p in event.paths {
            let p = p.to_string_lossy().into_owned();
            if !f.pending.contains(&p) {
                f.pending.push(p);
            }
        }
        if !f.flushing {
            f.flushing = true;
            let key = key.clone();
            std::thread::spawn(move || {
                std::thread::sleep(BATCH);
                let mut all = folders().lock().unwrap();
                let Some(f) = all.get_mut(&key) else { return };
                f.flushing = false;
                if f.waiters.is_empty() {
                    return;
                }
                let batch = std::mem::take(&mut f.pending);
                for w in f.waiters.drain(..) {
                    let _ = w.try_send(batch.clone());
                }
            });
        }
    })
    .map_err(|e| format!("cannot watch: {e}"))?;
    watcher.watch(root, RecursiveMode::Recursive).map_err(|e| format!("cannot watch {}: {e}", root.display()))?;
    Ok(watcher)
}

/// The mod a changed path belongs to (`mods/<name>/...`).
pub fn mod_of(rel: &Path) -> Option<String> {
    let mut parts = rel.components();
    (parts.next()?.as_os_str() == "mods").then_some(())?;
    parts.next()?.as_os_str().to_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_people_edit_counts() {
        assert!(watched(Path::new("settings.json")));
        assert!(watched(Path::new("mods/agents/main.js")));
        assert!(watched(Path::new("layouts/main.json")));
        assert!(!watched(Path::new("view.json")));
        assert!(!watched(Path::new("shared.json")));
        assert!(!watched(Path::new("data/x")));
        assert_eq!(mod_of(Path::new("mods/agents/main.js")).as_deref(), Some("agents"));
    }

    #[test]
    fn files_the_runtime_or_an_editor_writes_into_a_mod_do_not_reload_it() {
        assert!(watched(Path::new("mods/probe")));
        assert!(watched(Path::new("mods/probe/ui.js")));
        assert!(watched(Path::new("mods/probe/lib/jsconfig.json")));
        assert!(!watched(Path::new("mods/probe/jsconfig.json")));
        assert!(!watched(Path::new("mods/probe/gpui-kit.d.ts")));
        assert!(!watched(Path::new("mods/probe/.main.js.swp")));
        assert!(!watched(Path::new("mods/probe/.vscode/settings.json")));
        assert!(!watched(Path::new("mods/probe/main.js~")));
        assert!(!watched(Path::new("mods/probe/lib/gpui-kit.d.ts")));
        assert!(!watched(Path::new("mods/probe/node_modules/x/index.js")));
        assert!(!watched(Path::new("mods/probe/.git/HEAD")));
        assert!(watched(Path::new("mods/probe/mod.json")));
        assert_eq!(mod_of(Path::new("layouts/main.json")), None);
    }

    /// Drives a future to its end on this thread (the tests have no executor).
    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        use std::task::{Context, Poll, Wake, Waker};
        struct Unpark(std::thread::Thread);
        impl Wake for Unpark {
            fn wake(self: std::sync::Arc<Self>) {
                self.0.unpark();
            }
        }
        let waker = Waker::from(std::sync::Arc::new(Unpark(std::thread::current())));
        let mut f = std::pin::pin!(f);
        loop {
            match f.as_mut().poll(&mut Context::from_waker(&waker)) {
                Poll::Ready(v) => return v,
                Poll::Pending => std::thread::park_timeout(std::time::Duration::from_millis(50)),
            }
        }
    }

    #[test]
    fn a_watched_folder_reports_changes_and_misses_none_between_waits() {
        let dir = std::env::temp_dir().join(format!("herdr-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().into_owned();
        // Start watching, then change something while the first wait is on.
        let writer = {
            let dir = dir.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                std::fs::write(dir.join("a.md"), "one").unwrap();
            })
        };
        let first = block_on(next_change(path.clone())).unwrap();
        writer.join().unwrap();
        assert!(first.iter().any(|p| p.ends_with("a.md")), "{first:?}");
        // A change while nobody waits comes back on the next call.
        std::fs::write(dir.join("b.md"), "two").unwrap();
        std::thread::sleep(BATCH * 3);
        let second = block_on(next_change(path)).unwrap();
        assert!(second.iter().any(|p| p.ends_with("b.md")), "{second:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
