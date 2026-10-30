//! M1.26c single-writer rule (D4): `cargo test -p rw-cli --test forward`.
//!
//! - CLI write while the sidecar is live → forwarded, one step, `origin=cli`
//!   (the sidecar's watcher sees the write and adds nothing).
//! - Lock held but socket unreachable → exit 2, files and history untouched.
//! - No sidecar → in-process session, lock released afterwards.
//! - A second sidecar on the same project becomes a relay to the owner
//!   (the owner keeps the lock); a `--no-socket` owner refuses it with exit 2
//!   (`RW-E007 locked-by`).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use rw_project::History;
use rw_project::lock::{LockState, probe};
use rw_project::testutil::{TempDir, fixture_project, wait_until};
use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_rocketwright");

struct Sidecar {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<Value>,
    /// Notifications that arrived while waiting for a response.
    pending: Vec<Value>,
    next: u64,
}

impl Sidecar {
    fn start(project: &Path, extra: &[&str]) -> Sidecar {
        let mut child = Command::new(BIN)
            .args(["mcp", "--project"])
            .arg(project)
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let out = child.stdout.take().unwrap();
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines() {
                let Ok(line) = line else { break };
                if let Ok(v) = serde_json::from_str::<Value>(&line)
                    && tx.send(v).is_err()
                {
                    break;
                }
            }
        });
        let mut s = Sidecar {
            child,
            stdin,
            rx,
            pending: Vec::new(),
            next: 1,
        };
        s.request(
            "initialize",
            json!({"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}),
        );
        s.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        s
    }

    fn send(&mut self, v: &Value) {
        let w = self.stdin.as_mut().unwrap();
        writeln!(w, "{v}").unwrap();
        w.flush().unwrap();
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            let left = end.saturating_duration_since(Instant::now());
            let v = self.rx.recv_timeout(left).expect("sidecar answered");
            if v.get("id") == Some(&json!(id)) {
                return v["result"].clone();
            }
            self.pending.push(v);
        }
    }

    /// `resources/updated` notifications received within `ms`.
    fn updates(&mut self, ms: u64) -> Vec<String> {
        let end = Instant::now() + Duration::from_millis(ms);
        let mut out = Vec::new();
        for v in std::mem::take(&mut self.pending) {
            if v["method"] == "notifications/resources/updated" {
                out.push(v["params"]["uri"].as_str().unwrap_or("").to_string());
            }
        }
        while let Ok(v) = self
            .rx
            .recv_timeout(end.saturating_duration_since(Instant::now()))
        {
            if v["method"] == "notifications/resources/updated" {
                out.push(v["params"]["uri"].as_str().unwrap_or("").to_string());
            }
        }
        out
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn project(tag: &str) -> TempDir {
    let d = TempDir::new(tag);
    fixture_project(d.path());
    d
}

fn rw_call(project: &Path, tool: &str, args: Value) -> (i32, Value, String) {
    let o = Command::new(BIN)
        .args(["call", "--project"])
        .arg(project)
        .args(["--label", "rw set", tool, &args.to_string()])
        .output()
        .unwrap();
    let out = serde_json::from_slice(&o.stdout).unwrap_or(Value::Null);
    (
        o.status.code().unwrap_or(-1),
        out,
        String::from_utf8_lossy(&o.stderr).into_owned(),
    )
}

fn span(v: &str) -> Value {
    json!({"ops": [{"op": "replace", "path": "/params/span/value", "value": v}]})
}

fn steps(project: &Path) -> Vec<rw_api::HistoryStep> {
    History::open(project).unwrap().steps().unwrap()
}

/// Every project file except `.rw/` → bytes and mtime.
fn files_state(root: &Path) -> Vec<(PathBuf, Vec<u8>, std::time::SystemTime)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap() {
            let e = e.unwrap();
            let p = e.path();
            if p.file_name().is_some_and(|n| n == ".rw") {
                continue;
            }
            if e.file_type().unwrap().is_dir() {
                stack.push(p);
            } else {
                let m = e.metadata().unwrap().modified().unwrap();
                out.push((p.clone(), std::fs::read(&p).unwrap(), m));
            }
        }
    }
    out.sort();
    out
}

fn wait_owned(p: &Path, socket: bool) {
    assert!(
        wait_until(10_000, || matches!(probe(p).unwrap(), LockState::Held(_))
            && (!socket || p.join(".rw/sidecar.sock").exists())),
        "sidecar took the lock"
    );
}

#[test]
fn cli_write_while_sidecar_live_is_forwarded_as_one_cli_step() {
    let d = project("fwd-live");
    let mut app = Sidecar::start(d.path(), &[]);
    wait_owned(d.path(), true);
    // Let the watcher settle (FSEvents replays the root).
    std::thread::sleep(Duration::from_millis(500));
    app.request(
        "resources/subscribe",
        json!({"uri": "rw://project/history"}),
    );
    let LockState::Held(owner) = probe(d.path()).unwrap() else {
        panic!()
    };
    assert_eq!(owner.pid, app.child.id());

    let (code, out, err) = rw_call(d.path(), "model_patch", span("62 mm"));
    assert_eq!(code, 0, "{err}");
    assert_eq!(out["step"], "step:2", "{out}");
    assert!(
        std::fs::read_to_string(d.path().join("rocket.rw.toml"))
            .unwrap()
            .contains("\"62 mm\"")
    );
    // The app hears about the CLI write.
    assert!(
        app.updates(1500)
            .contains(&"rw://project/history".to_string())
    );

    // The sidecar's watcher saw the write too: still one step.
    std::thread::sleep(Duration::from_millis(800));
    let st = steps(d.path());
    assert_eq!(st.len(), 2, "{st:#?}");
    assert_eq!(st[1].origin, rw_api::Origin::Cli);
    assert_eq!(st[1].title, "rw set");
    assert_eq!(st[1].tool.as_deref(), Some("model_patch"));

    // Reads forward too, and see the same history.
    let (code, list, _) = rw_call(d.path(), "history_list", json!({}));
    assert_eq!(code, 0);
    assert_eq!(list["steps"].as_array().unwrap().len(), 2);

    // A CLI-only command forwards over the socket as well.
    let (code, out, err) = rw_call(
        d.path(),
        "component_move",
        json!({"id": "chute", "attach": {"to": "body.inner", "at": "attach", "offset": "10 mm"}}),
    );
    assert_eq!(code, 0, "{err}");
    assert_eq!(out["step"], "step:3");

    // An agent editing the file directly: one watcher step.
    let p = d.path().join("rocket.rw.toml");
    let t = std::fs::read_to_string(&p)
        .unwrap()
        .replace("\"62 mm\"", "\"63 mm\"");
    std::fs::write(&p, t).unwrap();
    assert!(wait_until(5000, || steps(d.path()).len() == 4));
    std::thread::sleep(Duration::from_millis(800));
    let st = steps(d.path());
    assert_eq!(st.len(), 4, "{st:#?}");
    assert_eq!(st[3].origin, rw_api::Origin::Watcher);

    // Validation happens before routing: a bad call never reaches the owner.
    let (code, _, err) = rw_call(d.path(), "model_patch", json!({"ops": []}));
    assert_eq!(code, 2, "{err}");
    assert_eq!(steps(d.path()).len(), 4);
}

#[test]
fn lock_held_and_socket_unreachable_exits_2_and_writes_nothing() {
    let d = project("fwd-dead");
    // A live owner that serves no socket.
    let _app = Sidecar::start(d.path(), &["--no-socket"]);
    wait_owned(d.path(), false);
    let before = files_state(d.path());
    let n = steps(d.path()).len();
    let (code, out, err) = rw_call(d.path(), "model_patch", span("70 mm"));
    assert_eq!(code, 2, "{out} {err}");
    assert!(err.contains("locked-by"), "{err}");
    assert!(err.contains("RW-E007"), "{err}");
    assert!(err.contains("nothing was written"), "{err}");
    assert_eq!(files_state(d.path()), before, "files untouched");
    assert_eq!(steps(d.path()).len(), n, "history untouched");
}

#[test]
fn removed_socket_of_a_live_owner_exits_2() {
    let d = project("fwd-gone");
    let _app = Sidecar::start(d.path(), &[]);
    wait_owned(d.path(), true);
    std::fs::remove_file(d.path().join(".rw/sidecar.sock")).unwrap();
    let before = files_state(d.path());
    let (code, _, err) = rw_call(d.path(), "model_patch", span("70 mm"));
    assert_eq!(code, 2, "{err}");
    assert_eq!(files_state(d.path()), before);
}

#[test]
fn without_a_sidecar_the_cli_runs_in_process() {
    let d = project("fwd-local");
    let (code, out, err) = rw_call(d.path(), "model_patch", span("66 mm"));
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        out["step"], "step:2",
        "step 1 is the initial snapshot: {out}"
    );
    assert!(
        matches!(probe(d.path()).unwrap(), LockState::Free { .. }),
        "lock released"
    );
    let st = steps(d.path());
    assert_eq!(st[1].origin, rw_api::Origin::Cli);
    // Reads take no lock and record nothing.
    let (code, out, _) = rw_call(d.path(), "model_get", json!({"path": "/params/span/value"}));
    assert_eq!(code, 0);
    assert!((out["value"].as_f64().unwrap() - 0.066).abs() < 1e-12);
    assert_eq!(steps(d.path()).len(), 2);
    // A sidecar started now sees the same tree: no new step.
    let _app = Sidecar::start(d.path(), &[]);
    wait_owned(d.path(), true);
    assert_eq!(steps(d.path()).len(), 2);
}

#[test]
fn second_sidecar_becomes_a_relay() {
    let d = project("fwd-two");
    let first = Sidecar::start(d.path(), &[]);
    wait_owned(d.path(), true);
    let mut second = Sidecar::start(d.path(), &[]);
    // The owner keeps the lock and its socket; the second instance relays.
    let LockState::Held(info) = probe(d.path()).unwrap() else {
        panic!("lock released")
    };
    assert_eq!(info.pid, first.child.id());
    assert!(second.child.try_wait().unwrap().is_none(), "the relay runs");
    assert!(
        d.path().join(".rw/sidecar.sock").exists(),
        "the live socket stays"
    );
    // A CLI write is forwarded to the owner and the relay hears about it.
    second.request("resources/subscribe", json!({"uri": "rw://project/model"}));
    let (code, _, err) = rw_call(d.path(), "model_patch", span("70 mm"));
    assert_eq!(code, 0, "{err}");
    assert!(
        second
            .updates(3000)
            .iter()
            .any(|u| u == "rw://project/model"),
        "the relay got resources/updated"
    );
    // ... and reads through the relay see it.
    let r = second.request(
        "tools/call",
        json!({"name": "model_get", "arguments": {"path": "/params/span/value"}}),
    );
    assert!(
        (r["structuredContent"]["value"].as_f64().unwrap() - 0.07).abs() < 1e-12,
        "{r}"
    );
    assert_eq!(r["_meta"]["rw/ctx"]["origin"], "mcp");
}

#[test]
fn a_socketless_owner_refuses_later_instances() {
    let d = project("fwd-nosock");
    let first = Sidecar::start(d.path(), &["--no-socket"]);
    wait_owned(d.path(), false);
    let o = Command::new(BIN)
        .args(["mcp", "--project"])
        .arg(d.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(
        err.contains(&format!("RW-E007 locked-by {}", first.child.id()))
            && err.contains("--no-socket"),
        "{err}"
    );
}

#[test]
fn sidecar_serves_the_session_over_mcp() {
    let d = project("fwd-mcp");
    let mut app = Sidecar::start(d.path(), &[]);
    wait_owned(d.path(), true);
    std::thread::sleep(Duration::from_millis(500));
    for uri in [
        "rw://project/model",
        "rw://project/check",
        "rw://project/files",
        "rw://project/history",
    ] {
        app.request("resources/subscribe", json!({"uri": uri}));
    }
    let r = app.request(
        "tools/call",
        json!({"name": "model_get", "arguments": {"path": "/params/span/value"}}),
    );
    assert!(
        (r["structuredContent"]["value"].as_f64().unwrap() - 0.05).abs() < 1e-12,
        "{r}"
    );
    let r = app.request(
        "tools/call",
        json!({"name": "model_patch", "arguments": span("57 mm"), "_meta": {"rw/thread": "t9", "rw/tool_call": "tc1"}}),
    );
    let out = &r["structuredContent"];
    assert_eq!(out["step"], "step:2", "{r}");
    assert_eq!(out["delta"]["model_hash"], out["model_hash"]);
    let mut got = app.updates(1200);
    got.sort();
    got.dedup();
    assert_eq!(
        got,
        [
            "rw://project/check",
            "rw://project/files",
            "rw://project/history",
            "rw://project/model"
        ]
    );
    // Dry runs announce nothing and write nothing.
    let mut dry = span("59 mm");
    dry["dry_run"] = json!(true);
    let r = app.request(
        "tools/call",
        json!({"name": "model_patch", "arguments": dry}),
    );
    assert_eq!(r["structuredContent"]["dry_run"], true);
    assert!(app.updates(500).is_empty());
    let r = app.request(
        "tools/call",
        json!({"name": "history_list", "arguments": {}}),
    );
    let st = r["structuredContent"]["steps"].as_array().unwrap();
    assert_eq!(st.len(), 2);
    assert_eq!(st[1]["thread"], "t9");
    assert_eq!(st[1]["origin"], "mcp");
    let r = app.request("resources/read", json!({"uri": "rw://project/files"}));
    let files: Value = serde_json::from_str(r["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert!(
        files["files"]["rocket.rw.toml"]
            .as_str()
            .unwrap()
            .contains("\"57 mm\"")
    );
    // History tags are real too.
    let r = app.request(
        "tools/call",
        json!({"name": "history_tag", "arguments": {"name": "Baseline"}}),
    );
    assert_eq!(r["structuredContent"]["number"], 1, "{r}");
}

/// REV-core item 3: `rw init` on a directory a live sidecar owns forwards
/// `project_create` to it; the CLI itself writes nothing.
#[test]
fn init_under_a_live_sidecar_is_forwarded() {
    let d = TempDir::new("fwd-init-live");
    let _app = Sidecar::start(d.path(), &[]);
    wait_owned(d.path(), true);
    let before = files_state(d.path());
    let o = Command::new(BIN)
        .args(["--json", "init"])
        .arg(d.path())
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&o.stderr);
    // Exit 1 at most: the doubles' strict check is not clean. Never 2
    // (`RW-E007`): the owner answered.
    assert_ne!(o.status.code(), Some(2), "{err}");
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert!(
        v["files"].is_array(),
        "the owner's project_create answer: {v}"
    );
    // Test builds answer from the contract-fixture doubles, which write
    // nothing: any file here would be the CLI writing past the owner.
    assert_eq!(
        files_state(d.path()),
        before,
        "the CLI wrote past the owner"
    );
}

/// REV-core item 3: a live owner without a socket: `rw init` exits 2 and
/// writes nothing.
#[test]
fn init_under_a_socketless_owner_writes_nothing() {
    let d = TempDir::new("fwd-init-dead");
    let _app = Sidecar::start(d.path(), &["--no-socket"]);
    wait_owned(d.path(), false);
    let o = Command::new(BIN)
        .args(["init"])
        .arg(d.path())
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&o.stderr);
    assert_eq!(o.status.code(), Some(2), "{err}");
    assert!(
        err.contains("RW-E007") || err.contains("locked-by"),
        "{err}"
    );
    assert!(files_state(d.path()).is_empty(), "nothing written");
}
