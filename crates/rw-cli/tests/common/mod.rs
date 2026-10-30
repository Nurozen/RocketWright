//! Shared helpers for the rw-cli integration tests: a raw newline-delimited
//! JSON-RPC peer, the `rocketwright mcp` sidecar process, temp projects.
#![allow(dead_code, clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::{BTreeSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use rw_api::{COMMANDS, schema_entry};
use serde_json::{Value, json};

pub const TIMEOUT: Duration = Duration::from_secs(20);
static SEQ: AtomicU32 = AtomicU32::new(0);

/// Copies a directory tree.
pub fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let d = to.join(e.file_name());
        if e.path().is_dir() {
            copy_dir(&e.path(), &d);
        } else {
            std::fs::copy(e.path(), &d).unwrap();
        }
    }
}

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

/// A short temp project dir (Unix socket paths are limited to ~104 bytes).
pub struct TempProject(pub PathBuf);
impl TempProject {
    pub fn new() -> Self {
        let p = PathBuf::from(format!(
            "/tmp/rwmcp-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    /// A temp copy of a repo fixture project (`fixtures/case1`).
    pub fn fixture(rel: &str) -> Self {
        let t = Self::new();
        copy_dir(&repo_root().join(rel), &t.0);
        t
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn socket(&self) -> PathBuf {
        self.0.join(".rw/sidecar.sock")
    }
}
impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A JSON-RPC peer over any line transport.
pub struct Rpc {
    pub tx: Box<dyn Write + Send>,
    rx: Receiver<Value>,
    pub pending: VecDeque<Value>,
    next_id: u64,
}

impl Rpc {
    pub fn new(tx: Box<dyn Write + Send>, read: Box<dyn std::io::Read + Send>) -> Self {
        let (stx, rx) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(read).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let v: Value = serde_json::from_str(&line)
                    .unwrap_or_else(|e| panic!("non-JSON line from sidecar: {line}: {e}"));
                if stx.send(v).is_err() {
                    break;
                }
            }
        });
        Self {
            tx,
            rx,
            pending: VecDeque::new(),
            next_id: 1,
        }
    }

    pub fn send(&mut self, v: &Value) {
        let mut s = serde_json::to_string(v).unwrap();
        s.push('\n');
        self.tx.write_all(s.as_bytes()).unwrap();
        self.tx.flush().unwrap();
    }

    pub fn notify(&mut self, method: &str) {
        self.send(&json!({"jsonrpc": "2.0", "method": method}));
    }

    pub fn recv(&mut self, deadline: Instant) -> Option<Value> {
        let left = deadline.saturating_duration_since(Instant::now());
        match self.rx.recv_timeout(left) {
            Ok(v) => Some(v),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => None,
        }
    }

    /// Sends a request; returns the whole response (`result` or `error`).
    pub fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let v = self
                .recv(deadline)
                .unwrap_or_else(|| panic!("no response to {method}"));
            if v.get("id") == Some(&json!(id)) && v.get("method").is_none() {
                return v;
            }
            self.pending.push_back(v);
        }
    }

    /// Calls a tool; returns the whole `tools/call` result.
    pub fn tool(&mut self, name: &str, args: Value) -> Value {
        self.result("tools/call", json!({"name": name, "arguments": args}))
    }

    /// Calls a tool that must succeed; returns its structured content.
    pub fn ok(&mut self, name: &str, args: Value) -> Value {
        let r = self.tool(name, args);
        assert!(
            r.get("isError").is_none_or(|v| v == false),
            "{name} failed: {r}"
        );
        r["structuredContent"].clone()
    }

    pub fn result(&mut self, method: &str, params: Value) -> Value {
        let v = self.call(method, params);
        assert!(v.get("error").is_none(), "{method} failed: {v}");
        v["result"].clone()
    }

    pub fn initialize(&mut self, version: &str) -> Value {
        let r = self.result(
            "initialize",
            json!({"protocolVersion": version, "capabilities": {}, "clientInfo": {"name": "mcp_contract", "version": "0"}}),
        );
        self.notify("notifications/initialized");
        r
    }

    /// Notifications received so far plus any arriving within `wait`.
    pub fn notifications(&mut self, method: &str, wait: Duration) -> Vec<Value> {
        let deadline = Instant::now() + wait;
        while let Some(v) = self.recv(deadline) {
            self.pending.push_back(v);
        }
        let (hit, rest): (Vec<Value>, Vec<Value>) = self
            .pending
            .drain(..)
            .partition(|v| v.get("method") == Some(&json!(method)));
        self.pending = rest.into();
        hit
    }

    /// Waits until `n` `resources/updated` notifications arrived; returns their URIs.
    pub fn updated(&mut self, n: usize) -> BTreeSet<String> {
        let deadline = Instant::now() + TIMEOUT;
        let mut uris = BTreeSet::new();
        let mut seen = 0;
        while seen < n {
            for v in self.notifications("notifications/resources/updated", Duration::ZERO) {
                uris.insert(v["params"]["uri"].as_str().unwrap().to_string());
                seen += 1;
            }
            if seen >= n {
                break;
            }
            let v = self
                .recv(deadline)
                .unwrap_or_else(|| panic!("only {seen}/{n} resources/updated arrived"));
            self.pending.push_back(v);
        }
        uris
    }
}

pub struct Sidecar {
    pub child: Child,
    pub rpc: Rpc,
}

impl Sidecar {
    pub fn start(project: &Path) -> Self {
        Self::start_env(project, &[])
    }

    /// Starts with extra environment variables (test hooks).
    pub fn start_env(project: &Path, env: &[(&str, &str)]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_rocketwright"))
            .args(["mcp", "--project"])
            .arg(project)
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn rocketwright mcp");
        let stdin: ChildStdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        Self {
            child,
            rpc: Rpc::new(Box::new(stdin), Box::new(stdout)),
        }
    }

    /// Started with env, handshake done.
    pub fn started_env(project: &Path, env: &[(&str, &str)]) -> Self {
        let mut s = Self::start_env(project, env);
        s.rpc.initialize("2025-11-25");
        s
    }

    pub fn started(project: &Path) -> Self {
        let mut s = Self::start(project);
        s.rpc.initialize("2025-11-25");
        s
    }

    /// Closes stdin and waits for a clean exit.
    pub fn stop(mut self) -> std::process::ExitStatus {
        self.rpc.tx = Box::new(std::io::sink());
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(st) = self.child.try_wait().unwrap() {
                return st;
            }
            assert!(
                Instant::now() < deadline,
                "sidecar did not exit after stdin closed"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn socket_rpc(project: &TempProject) -> Rpc {
    let s = UnixStream::connect(project.socket()).expect("connect .rw/sidecar.sock");
    let r = s.try_clone().unwrap();
    Rpc::new(Box::new(s), Box::new(r))
}

pub fn fixture_payload(rel: &str) -> Value {
    let p = repo_root().join("fixtures/contracts").join(rel);
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
    v["payload"].clone()
}

pub fn validate(schema_name: &str, v: &Value) -> Vec<String> {
    let s = schema_entry(schema_name).unwrap().schema();
    let val = jsonschema::validator_for(s.as_value()).unwrap();
    val.iter_errors(v).map(|e| e.to_string()).collect()
}

pub fn mcp_tools() -> Vec<&'static rw_api::CommandDef> {
    COMMANDS.iter().filter(|d| d.mcp).collect()
}
