//! Watches local agent log directories and tells the UI when logs change (debounced).

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};

/// Keeps the watcher alive; dropping it stops watching.
pub struct LogWatcher {
    _watcher: Option<notify::RecommendedWatcher>,
}

/// Calls `on_change` at most every `debounce` while files under `dirs` change.
pub fn watch(
    dirs: Vec<PathBuf>,
    debounce: Duration,
    on_change: impl Fn() + Send + 'static,
) -> LogWatcher {
    let (tx, rx) = mpsc::channel::<()>();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if event
                .paths
                .iter()
                .any(|p| p.extension().is_some_and(|e| e == "jsonl"))
            {
                let _ = tx.send(());
            }
        }
    });
    let Ok(mut watcher) = watcher else {
        return LogWatcher { _watcher: None };
    };
    let mut any = false;
    for dir in &dirs {
        any |= watcher.watch(dir, RecursiveMode::Recursive).is_ok();
    }
    if !any {
        return LogWatcher { _watcher: None };
    }
    std::thread::Builder::new()
        .name("agent-log-watch".into())
        .spawn(move || {
            while rx.recv().is_ok() {
                std::thread::sleep(debounce);
                while rx.try_recv().is_ok() {}
                on_change();
            }
        })
        .ok();
    LogWatcher {
        _watcher: Some(watcher),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn reports_changes_to_jsonl_files_debounced() {
        let dir = std::env::temp_dir().join(format!("lf-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("proj")).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let _w = watch(vec![dir.clone()], Duration::from_millis(200), move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(100));
        for i in 0..5 {
            std::fs::write(dir.join("proj/s.jsonl"), format!("{i}\n")).unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while count.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(400));
        let n = count.load(Ordering::SeqCst);
        assert!(
            (1..=2).contains(&n),
            "debounced into few notifications, got {n}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
