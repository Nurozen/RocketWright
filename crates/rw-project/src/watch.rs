//! The project watcher (M1.29, R3.5): agents and editors may change files
//! directly; the owner notices, re-checks, records a step, and notifies.
//!
//! - `notify` + `notify-debouncer-full`, 200 ms.
//! - Event kinds are not trusted (FSEvents reports renames as `Name(Any)` on
//!   both paths and replays the root's `Create`): any debounced batch that
//!   touches a relevant path triggers [`crate::Session::sync_settled`], which
//!   re-reads and blake3-compares content. Replays, touches, and the
//!   session's own writes (the own-write set) change nothing.
//! - Access events do not count, except a close after writing: inotify
//!   reports every `open`, including the session's own reads of the tree.
//! - A directory event counts too (created, moved in, moved out, removed),
//!   when the directory can hold sources or library files: it may stand for
//!   files whose own events never arrive. inotify (Linux) watches a new
//!   directory only after it has seen it appear, so files created in it
//!   before then are silent, and a directory moved in or out reports only
//!   itself on every platform.
//! - Nothing is applied while a changed source was modified less than
//!   [`DEBOUNCE`] ago: the batch that triggered the read may be for another
//!   path or an older event while an in-place save (truncate, then write)
//!   is under way, and the empty file it leaves in between parses.
//!   notify-debouncer-full also drops the data events that follow a create
//!   or rename-into-place of the same path, so a save right after the
//!   session's own atomic write is reported quiet too early. The watcher
//!   syncs again once the file has been quiet for the window.
//! - A half-written or invalid file keeps the last good model and reports
//!   `RW-E001` until it parses.
//! - External steps carry `origin = watcher`. A forwarded CLI write and the
//!   watcher event it causes produce one step: the session already knows the
//!   content, and history dedupes by tree hash (D3).

use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify_debouncer_full::notify::event::{AccessKind, AccessMode};
use notify_debouncer_full::notify::{EventKind, RecommendedWatcher, RecursiveMode};
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

/// False for access events that change nothing: inotify reports every
/// `open` (including the session's own reads and directory walks, so each
/// sync would wake the watcher again 200 ms later). A close after writing
/// is kept: it is the one event left for a file rewritten right after it
/// was created or renamed into place (module docs).
fn changes(kind: &EventKind) -> bool {
    match kind {
        EventKind::Access(a) => *a == AccessKind::Close(AccessMode::Write),
        _ => true,
    }
}

/// True when a debounced batch touches something the session reads.
fn relevant(root: &Path, events: &DebounceEventResult) -> bool {
    let Ok(events) = events else {
        // Errors (dropped events, rescans): re-read to be safe.
        return true;
    };
    events.iter().filter(|e| changes(&e.kind)).any(|e| {
        e.paths.iter().any(|p| {
            let p = p.canonicalize().unwrap_or_else(|_| p.clone());
            match layout::rel_path(root, &p) {
                // Not a file (any more): a directory, or one moved away.
                Some(rel) => {
                    layout::is_relevant(&rel) || (!p.is_file() && layout::may_hold_relevant(&rel))
                }
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
                // Set when a sync held changes back: sync again by then,
                // batch or not.
                let mut again: Option<Instant> = None;
                // Ends when the debouncer (and its sender) is dropped.
                loop {
                    let batch = match again {
                        Some(at) => {
                            match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                                Ok(b) => Some(b),
                                Err(RecvTimeoutError::Timeout) => None,
                                Err(RecvTimeoutError::Disconnected) => break,
                            }
                        }
                        None => match rx.recv() {
                            Ok(b) => Some(b),
                            Err(_) => break,
                        },
                    };
                    if batch.as_ref().is_some_and(|b| !relevant(&root, b)) {
                        continue;
                    }
                    let outcome = {
                        let mut s = session.lock().unwrap_or_else(|e| e.into_inner());
                        s.sync_settled(Origin::Watcher, DEBOUNCE)
                    };
                    match outcome {
                        Ok((o, wait)) => {
                            again = wait.map(|w| Instant::now() + w);
                            on_sync(&o);
                        }
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
