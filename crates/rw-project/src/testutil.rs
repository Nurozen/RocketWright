//! Test helpers shared by unit and integration tests (not part of the API).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static SEQ: AtomicU32 = AtomicU32::new(0);

/// A temp directory under `/tmp` (short: Unix socket paths are limited to
/// about 104 bytes), removed on drop. Canonicalized, so paths compare equal
/// to what the watcher reports (`/tmp` → `/private/tmp` on macOS).
#[derive(Debug)]
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> TempDir {
        let p = PathBuf::from(format!(
            "/tmp/rw-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("create temp dir");
        TempDir(p.canonicalize().expect("canonicalize temp dir"))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The M1.25 store fixture (`tests/fixtures/project`).
pub fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/project")
}

/// Copies the fixture project into `dest`.
pub fn fixture_project(dest: &Path) {
    copy_dir(&fixture_dir(), dest);
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("mkdir");
    for e in std::fs::read_dir(from).expect("read fixture") {
        let e = e.expect("entry");
        let dst = to.join(e.file_name());
        if e.file_type().expect("type").is_dir() {
            copy_dir(&e.path(), &dst);
        } else {
            std::fs::copy(e.path(), &dst).expect("copy");
        }
    }
}

/// Polls `f` every 20 ms until it returns true or `ms` elapse.
pub fn wait_until(ms: u64, mut f: impl FnMut() -> bool) -> bool {
    let end = std::time::Instant::now() + std::time::Duration::from_millis(ms);
    loop {
        if f() {
            return true;
        }
        if std::time::Instant::now() >= end {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
