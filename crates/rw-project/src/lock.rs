//! `.rw/lock` (M1.26b, D4): the project's single live owner.
//!
//! The owner holds an exclusive `flock` on `.rw/lock` for its whole lifetime
//! and writes `{pid, socket, started}` into it. The kernel drops the flock
//! when the owner exits for any reason (including `kill -9`), so a stale file
//! never blocks: the next [`ProjectLock::acquire`] takes the lock and
//! overwrites the record (stale-pid recovery). A second owner while the
//! first is alive fails with `RW-E007 locked-by <pid>`.
//!
//! [`probe`] reads the state without taking the lock: the CLI uses it to
//! decide between forwarding to the live sidecar and an in-process session.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Lock file, relative to the project.
pub const LOCK_REL: &str = ".rw/lock";

/// The record inside `.rw/lock`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockInfo {
    pub pid: u32,
    /// The owner's `.rw/sidecar.sock`, absolute, when it serves one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket: Option<PathBuf>,
    /// RFC 3339 start time.
    #[serde(default)]
    pub started: String,
}

/// What [`probe`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockState {
    /// No live owner (no file, or a stale record left by a dead owner).
    Free { stale: Option<LockInfo> },
    /// A live owner holds the lock.
    Held(LockInfo),
}

#[derive(Debug, thiserror::Error)]
pub enum LockError {
    #[error("the project is locked by pid {} (RW-E007 locked-by)", .0.pid)]
    Locked(LockInfo),
    #[error("the project is locked by another process (RW-E007 locked-by)")]
    LockedUnknown,
    #[error(".rw/lock: {0}")]
    Io(#[from] std::io::Error),
}

impl LockError {
    /// The owner's pid, when known.
    pub fn pid(&self) -> Option<u32> {
        match self {
            LockError::Locked(i) => Some(i.pid),
            _ => None,
        }
    }
}

/// The held lock. Dropping it releases the flock and removes the record.
#[derive(Debug)]
pub struct ProjectLock {
    file: File,
    info: LockInfo,
}

pub fn lock_path(project: &Path) -> PathBuf {
    project.join(LOCK_REL)
}

fn read_info(file: &mut File) -> Option<LockInfo> {
    let mut s = String::new();
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_to_string(&mut s).ok()?;
    serde_json::from_str(s.trim()).ok()
}

fn read_info_path(path: &Path) -> Option<LockInfo> {
    let s = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(s.trim()).ok()
}

/// True when `pid` names a live process.
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: kill(pid, 0) sends no signal; it only checks existence.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn open_lock_file(path: &Path) -> std::io::Result<File> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}

impl ProjectLock {
    /// Takes `.rw/lock` for this process, recording `socket`.
    pub fn acquire(project: &Path, socket: Option<&Path>) -> Result<ProjectLock, LockError> {
        let path = lock_path(project);
        let mut file = open_lock_file(&path)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(match read_info(&mut file) {
                    Some(i) => LockError::Locked(i),
                    None => LockError::LockedUnknown,
                });
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(LockError::Io(e)),
        }
        // Any record here belonged to a dead owner: overwrite it.
        let info = LockInfo {
            pid: std::process::id(),
            socket: socket.map(Path::to_path_buf),
            started: crate::clock::now().1,
        };
        let text = serde_json::to_string(&info).unwrap_or_default();
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(text.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(ProjectLock { file, info })
    }

    pub fn info(&self) -> &LockInfo {
        &self.info
    }
}

impl Drop for ProjectLock {
    fn drop(&mut self) {
        // Clear the record while still holding the flock, then release. The
        // file itself stays: unlinking a flocked file lets two later owners
        // lock different inodes.
        let _ = self.file.set_len(0);
        let _ = self.file.unlock();
    }
}

/// The lock state of `project`, without taking the lock.
pub fn probe(project: &Path) -> std::io::Result<LockState> {
    let path = lock_path(project);
    if !path.exists() {
        return Ok(LockState::Free { stale: None });
    }
    let file = match std::fs::OpenOptions::new().read(true).open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LockState::Free { stale: None });
        }
        Err(e) => return Err(e),
    };
    // A shared lock succeeds only when nobody holds the exclusive one.
    match file.try_lock_shared() {
        Ok(()) => {
            let stale = read_info_path(&path);
            let _ = file.unlock();
            Ok(LockState::Free { stale })
        }
        Err(std::fs::TryLockError::WouldBlock) => {
            let info = read_info_path(&path).unwrap_or(LockInfo {
                pid: 0,
                socket: None,
                started: String::new(),
            });
            Ok(LockState::Held(info))
        }
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use std::io::BufRead;
    use std::process::{Command, Stdio};

    const HELPER_ENV: &str = "RW_LOCK_HELPER_DIR";

    /// Kills the helper if the test fails before it does.
    struct Reap(u32);
    impl Drop for Reap {
        fn drop(&mut self) {
            unsafe { libc::kill(self.0 as libc::pid_t, libc::SIGKILL) };
        }
    }

    /// Child-process body for the two-process tests: holds the lock until killed.
    #[test]
    #[ignore = "helper: run by lock_survives_kill_9_of_owner"]
    fn lock_owner_helper() {
        let Ok(dir) = std::env::var(HELPER_ENV) else {
            return;
        };
        let sock = PathBuf::from(&dir).join(".rw/sidecar.sock");
        let _lock = ProjectLock::acquire(Path::new(&dir), Some(&sock)).unwrap();
        println!("locked {}", std::process::id());
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }

    #[test]
    fn second_owner_in_process_is_refused_and_drop_releases() {
        let dir = TempDir::new("lock-inproc");
        let a = ProjectLock::acquire(dir.path(), None).unwrap();
        assert_eq!(a.info().pid, std::process::id());
        // flock is per open file description: a second open in the same
        // process conflicts too.
        let e = ProjectLock::acquire(dir.path(), None).unwrap_err();
        assert_eq!(e.pid(), Some(std::process::id()));
        assert!(e.to_string().contains("RW-E007"), "{e}");
        assert!(
            matches!(probe(dir.path()).unwrap(), LockState::Held(i) if i.pid == std::process::id())
        );
        drop(a);
        assert_eq!(probe(dir.path()).unwrap(), LockState::Free { stale: None });
        let _b = ProjectLock::acquire(dir.path(), None).unwrap();
    }

    #[test]
    fn stale_record_without_flock_is_recovered() {
        let dir = TempDir::new("lock-stale");
        std::fs::create_dir_all(dir.path().join(".rw")).unwrap();
        // A record left by a dead owner (no process holds the flock).
        std::fs::write(
            lock_path(dir.path()),
            r#"{"pid":999999,"socket":"/nowhere.sock","started":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        match probe(dir.path()).unwrap() {
            LockState::Free { stale: Some(i) } => assert_eq!(i.pid, 999_999),
            s => panic!("{s:?}"),
        }
        assert!(!pid_alive(999_999));
        let l = ProjectLock::acquire(dir.path(), None).unwrap();
        assert_eq!(l.info().pid, std::process::id());
        let on_disk = read_info_path(&lock_path(dir.path())).unwrap();
        assert_eq!(on_disk.pid, std::process::id());
    }

    #[test]
    fn lock_survives_kill_9_of_owner() {
        let dir = TempDir::new("lock-2proc");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "lock::tests::lock_owner_helper",
                "--exact",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(HELPER_ENV, dir.path())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let _reap = Reap(child.id());
        let mut out = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            line.clear();
            assert!(out.read_line(&mut line).unwrap() > 0, "helper exited early");
            // libtest may print `test ... ` on the same line first.
            if let Some(i) = line.find("locked ") {
                line.drain(..i + "locked ".len());
                break;
            }
        }
        let pid: u32 = line.trim().parse().unwrap();
        assert_eq!(pid, child.id());

        // The live owner is reported, with its socket.
        match probe(dir.path()).unwrap() {
            LockState::Held(i) => {
                assert_eq!(i.pid, pid);
                assert_eq!(i.socket, Some(dir.path().join(".rw/sidecar.sock")));
            }
            s => panic!("{s:?}"),
        }
        let e = ProjectLock::acquire(dir.path(), None).unwrap_err();
        assert_eq!(e.pid(), Some(pid));
        assert!(pid_alive(pid));

        // kill -9: the kernel drops the flock; the record goes stale.
        Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .unwrap();
        child.wait().unwrap();
        assert!(!pid_alive(pid));
        match probe(dir.path()).unwrap() {
            LockState::Free { stale: Some(i) } => assert_eq!(i.pid, pid),
            s => panic!("{s:?}"),
        }
        let l = ProjectLock::acquire(dir.path(), None).unwrap();
        assert_eq!(l.info().pid, std::process::id());
    }
}
