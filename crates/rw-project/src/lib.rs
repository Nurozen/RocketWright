//! Project I/O: `rw_project::Session` is the only writer of project files
//! (invariant I1). Owns comment-preserving TOML patches, run storage and
//! `run_id` hashing, the file watcher, local git history, and `.ork` container
//! unwrapping.
//!
//! Native crate: filesystem, clock, and threads are allowed here.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod cea_dispatch;
pub mod cfd;
pub mod check;
pub mod clock;
pub mod container;
pub mod create;
pub mod fmt;
pub mod fsutil;
pub mod history;
pub mod interop;
pub mod jobs;
pub mod layout;
pub mod library;
pub mod liquid;
pub mod lock;
pub mod presets;
pub mod runs;
pub mod session;
pub mod store;
#[doc(hidden)]
pub mod testutil;
pub mod tomlpatch;
pub mod visual;
pub mod watch;

pub use check::{Checker, ResolveMotor, StaticCheckDouble, StaticChecker};
pub use history::History;
pub use jobs::JobQueue;
pub use library::Library;
pub use lock::{LockInfo, LockState, ProjectLock};
pub use runs::RunStore;
pub use session::{LockMode, Session, SessionEvent, SessionOptions, SharedSession, SyncOutcome};
pub use store::{FileChange, TomlStore};
pub use watch::Watcher;

/// Crate name, used by stub tests until real contents land.
pub const CRATE_NAME: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    #[test]
    fn crate_name_matches() {
        assert_eq!(super::CRATE_NAME, "rw-project");
    }
}
