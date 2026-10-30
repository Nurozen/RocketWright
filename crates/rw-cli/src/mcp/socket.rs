//! `.rw/sidecar.sock` (D4): the owner's listener. Mutating CLI commands
//! forward their `Command` here (newline-delimited MCP JSON-RPC, the same
//! protocol as stdio) with `_meta["rw/origin"] = "cli"`, and every later
//! `rocketwright mcp` instance relays its stdio here ([`super::relay`]).
//! Each accepted connection is its own rmcp service on the shared [`Hub`].
//!
//! A path longer than the platform's `sun_path` falls back to
//! `$TMPDIR/rw-<hash12>.sock` (hash of the project path); the owner records
//! the path it bound in `LockInfo.socket`, which clients read first.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rmcp::ServiceExt;
use rw_api::Origin;
use tokio::net::UnixListener;

use super::server::RELAY_CLIENT;
use super::{Hub, RwServer};

/// Socket path relative to the project.
pub const SOCKET_REL: &str = ".rw/sidecar.sock";

/// Longest socket path that binds everywhere (macOS `sun_path` is 104 bytes,
/// NUL included).
pub const MAX_SOCKET_PATH: usize = 103;

/// The project's socket: `.rw/sidecar.sock`, or the short `$TMPDIR` fallback
/// when that path is too long to bind.
pub fn socket_path(project: &Path) -> PathBuf {
    let p = project.join(SOCKET_REL);
    if p.as_os_str().len() <= MAX_SOCKET_PATH {
        return p;
    }
    short_path(project)
}

/// `$TMPDIR/rw-<hash12>.sock` (`/tmp` when `$TMPDIR` itself is too long).
pub fn short_path(project: &Path) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    let hash = blake3::hash(project.as_os_str().as_bytes()).to_hex();
    let name = format!("rw-{}.sock", &hash[..12]);
    let tmp = std::env::temp_dir().join(&name);
    if tmp.as_os_str().len() <= MAX_SOCKET_PATH {
        tmp
    } else {
        Path::new("/tmp").join(name)
    }
}

/// True when `RW_TEST_HOOKS=1` and `RW_TEST_BIND_FAIL=1`: every bind fails
/// (tests of the bind-failure hand-off, D4).
fn bind_fails_for_tests() -> bool {
    std::env::var("RW_TEST_HOOKS").as_deref() == Ok("1")
        && std::env::var("RW_TEST_BIND_FAIL").as_deref() == Ok("1")
}

/// Binds the project's socket, replacing a stale socket file. Fails when a
/// live sidecar already answers on it.
pub fn bind(project: &Path) -> io::Result<UnixListener> {
    if bind_fails_for_tests() {
        return Err(io::Error::other("bind failed (RW_TEST_BIND_FAIL)"));
    }
    let path = socket_path(project);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if path.exists() {
        if std::os::unix::net::UnixStream::connect(&path).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "another sidecar is serving this project",
            ));
        }
        std::fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(&path)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

/// Serves each connection until the listener task is aborted. Relay
/// connections are counted on the [`Hub`] while they stay open.
pub async fn accept_loop(listener: UnixListener, hub: Arc<Hub>) {
    loop {
        let stream = match listener.accept().await {
            Ok((s, _)) => s,
            Err(e) => {
                eprintln!("rocketwright mcp: socket accept: {e}");
                continue;
            }
        };
        let hub = hub.clone();
        tokio::spawn(async move {
            let server = RwServer::new(hub.clone(), Origin::Socket);
            let conn = server.conn();
            let (r, w) = stream.into_split();
            if let Ok(service) = server.serve((r, w)).await {
                let relay = service
                    .peer()
                    .peer_info()
                    .is_some_and(|i| i.client_info.name == RELAY_CLIENT);
                if relay {
                    hub.relay_attached();
                }
                let _ = service.waiting().await;
                if relay {
                    hub.relay_detached();
                }
            }
            hub.drop_conn(conn);
        });
    }
}

/// Removes the socket file (best effort, on shutdown).
pub fn remove(project: &Path) {
    let _ = std::fs::remove_file(socket_path(project));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_projects_use_the_project_socket() {
        let p = Path::new("/tmp/rw-short");
        assert_eq!(socket_path(p), p.join(SOCKET_REL));
    }

    #[test]
    fn long_projects_fall_back_to_a_short_hashed_path() {
        let long = PathBuf::from(format!("/tmp/{}", "d".repeat(120)));
        let s = socket_path(&long);
        assert!(s.as_os_str().len() <= MAX_SOCKET_PATH, "{}", s.display());
        let name = s.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("rw-") && name.ends_with(".sock"), "{name}");
        assert_eq!(name.len(), "rw-".len() + 12 + ".sock".len());
        assert_eq!(s, socket_path(&long), "stable per project");
        let other = PathBuf::from(format!("/tmp/{}", "e".repeat(120)));
        assert_ne!(s, socket_path(&other), "keyed by the project");
    }
}
