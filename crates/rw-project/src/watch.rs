//! The project watcher (M1.29, R3.5): agents and editors may change files
//! directly; the owner notices, re-checks, records a step, and notifies.
//!
//! - `notify` + `notify-debouncer-full`, 200 ms.
//! - Event kinds are not trusted (FSEvents reports renames as `Name(Any)` on
//!   both paths and replays the root's `Create`): any debounced batch that
//!   touches a relevant path triggers [`Session::sync_from_disk`], which
//!   re-reads and blake3-compares content. Replays, touches, and the
//!   session's own writes (the own-write set) change nothing.
//! - A half-written or invalid file keeps the last good model and reports
//!   `RW-E001` until it parses.
//! - External steps carry `origin = watcher`. A forwarded CLI write and the
//!   watcher event it causes produce one step: the session already knows the
//!   content, and history dedupes by tree hash (D3).

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use rw_api::Origin;

use crate::layout;
use crate::session::{SharedSession, SyncOutcome};

/// The debounce window.
pub const DEBOUNCE: Duration = Duration::from_millis(200);

/// A running watcher; dropping it stops watching.
pub struct Watcher {
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
    _thread: std::thread::JoinHandle<()>,
}

impl std::fmt::Debug for Watcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Watcher").finish_non_exhaustive()
    }
}

/// True when a debounced batch touches something the session reads.
fn relevant(root: &Path, events: &DebounceEventResult) -> bool {
    let Ok(events) = events else {
        // Errors (dropped events, rescans): re-read to be safe.
        return true;
    };
    events.iter().any(|e| {
        e.paths.iter().any(|p| {
            let p = p.canonicalize().unwrap_or_else(|_| p.clone());
            match layout::rel_path(root, &p) {
                Some(rel) => layout::is_relevant(&rel),
                // The root itself (replayed Create, rescans).
                None => p == root,
            }
        })
    })
}

impl Watcher {
    /// Watches the session's project. `on_sync` hears every outcome (tests,
    /// logging); notifications go through the session's listeners.
    pub fn start(
        session: SharedSession,
        on_sync: impl Fn(&SyncOutcome) + Send + 'static,
    ) -> notify_debouncer_full::notify::Result<Watcher> {
        let root = session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .root()
            .to_path_buf();
        let (tx, rx) = mpsc::channel::<DebounceEventResult>();
        let mut debouncer = new_debouncer(DEBOUNCE, None, tx)?;
        debouncer.watch(&root, RecursiveMode::Recursive)?;
        let thread = std::thread::Builder::new()
            .name("rw-watch".into())
            .spawn(move || {
                // Ends when the debouncer (and its sender) is dropped.
                while let Ok(batch) = rx.recv() {
                    if !relevant(&root, &batch) {
                        continue;
                    }
                    let outcome = {
                        let mut s = session.lock().unwrap_or_else(|e| e.into_inner());
                        s.sync_from_disk(Origin::Watcher)
                    };
                    match outcome {
                        Ok(o) => on_sync(&o),
                        Err(e) => eprintln!("rocketwright watch: {}", e.message),
                    }
                }
            })
            .map_err(notify_debouncer_full::notify::Error::io)?;
        Ok(Watcher {
            _debouncer: debouncer,
            _thread: thread,
        })
    }
}
