//! B1a (D4): `cargo test -p rw-cli --test mcp_relay`. Every `rocketwright
//! mcp` instance is a relay front: the first owns `.rw/lock` and the
//! socket, later ones relay their stdio to it.
//!
//! - lock free → owner; lock held → relay (calls, `_meta` and
//!   `resources/updated` pass through); the owner killed → the relay
//!   promotes and its subscriptions still fire;
//! - N simultaneous contenders → exactly one owner, N-1 relays;
//! - a bind failure after acquiring releases the lock; a contender owns it;
//! - the owner's stdin closes while a relay is attached and a job runs →
//!   it drains (stays until the job finishes and the relay detaches), then
//!   exits; the next instance owns the project and the result is readable;
//! - `--list-tools` while another instance owns the lock: exit 0, lock
//!   holder unchanged;
//! - `lecturn/approval` and `lecturn/context` reach the owner and are
//!   echoed, and the owner's `lecturn/summary` comes back unchanged;
//!   `lecturn/context.threadId` attributes the call (D21);
//! - relay connections are `Origin::Mcp` (no CLI-only commands).
//!
//! B1b (recovery):
//! - the owner dies after a mutation commits and before it replies: the
//!   caller gets `unavailable` with `outcome: "unknown"`, the step landed
//!   exactly once (`history_list`), and after the promotion the client gets
//!   `resources/updated` for its subscriptions and `rw/upstream-changed`;
//! - the owner dies mid-read: the read is retried on the new upstream and
//!   succeeds; every relay is told the upstream changed.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use common::*;
use rw_project::lock::{LockState, probe};
use rw_project::testutil::wait_until;
use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_rocketwright");

/// One `rocketwright mcp` process with its stderr captured (role traces).
struct Inst {
    child: Child,
    rpc: Rpc,
    err: Receiver<String>,
    lines: Vec<String>,
}

impl Inst {
    fn spawn(project: &Path, env: &[(&str, &str)]) -> Inst {
        let mut child = Command::new(BIN)
            .args(["mcp", "--project"])
            .arg(project)
            .env("RW_MCP_TRACE", "1")
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn rocketwright mcp");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (tx, err) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                eprintln!("{line}");
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Inst {
            child,
            rpc: Rpc::new(Box::new(stdin), Box::new(stdout)),
            err,
            lines: Vec::new(),
        }
    }

    fn started(project: &Path, env: &[(&str, &str)]) -> Inst {
        let mut i = Inst::spawn(project, env);
        i.rpc.initialize("2025-11-25");
        i
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Stderr lines so far.
    fn stderr(&mut self) -> &[String] {
        while let Ok(l) = self.err.try_recv() {
            self.lines.push(l);
        }
        &self.lines
    }

    /// Waits until a stderr line contains `needle`.
    fn wait_stderr(&mut self, needle: &str) {
        let end = Instant::now() + TIMEOUT;
        while !self.stderr().iter().any(|l| l.contains(needle)) {
            assert!(
                Instant::now() < end,
                "no `{needle}` on stderr: {:?}",
                self.lines
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The owner takes the lock before it logs its role, so wait for the line.
    fn role(&mut self) -> &'static str {
        let end = Instant::now() + TIMEOUT;
        loop {
            let lines = self.stderr();
            if lines.iter().any(|l| l.ends_with(": owner")) {
                return "owner";
            }
            if lines.iter().any(|l| l.contains(": relay ")) {
                return "relay";
            }
            if Instant::now() >= end {
                return "none";
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Closes stdin (what Lecturn's reaper and the app do).
    fn close_stdin(&mut self) {
        self.rpc.tx = Box::new(std::io::sink());
    }

    fn alive(&mut self) -> bool {
        self.child.try_wait().unwrap().is_none()
    }

    fn wait_exit(&mut self) -> ExitStatus {
        let end = Instant::now() + TIMEOUT;
        loop {
            if let Some(st) = self.child.try_wait().unwrap() {
                return st;
            }
            assert!(Instant::now() < end, "pid {} did not exit", self.pid());
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Inst {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn owner_pid(p: &Path) -> Option<u32> {
    match probe(p).unwrap() {
        LockState::Held(i) => Some(i.pid),
        LockState::Free { .. } => None,
    }
}

fn wait_owner(p: &Path, pid: u32) {
    assert!(
        wait_until(TIMEOUT.as_millis() as u64, || owner_pid(p) == Some(pid)),
        "pid {pid} never owned the project (owner: {:?})",
        owner_pid(p)
    );
}

fn wet_patch() -> Value {
    let mut wet = fixture_payload("tools/model_patch.input.json");
    wet["dry_run"] = json!(false);
    wet
}

#[test]
fn lock_free_owns_and_lock_held_relays() {
    let p = TempProject::new();
    let mut owner = Inst::started(&p.0, &[]);
    wait_owner(&p.0, owner.pid());
    assert!(p.socket().exists(), "the owner serves the socket");
    assert_eq!(owner.role(), "owner");

    let mut relay = Inst::spawn(&p.0, &[]);
    let init = relay.rpc.initialize("2025-11-25");
    assert_eq!(init["protocolVersion"], "2025-11-25");
    assert_eq!(init["serverInfo"]["name"], "rocketwright");
    assert_eq!(relay.role(), "relay");
    assert_eq!(
        owner_pid(&p.0),
        Some(owner.pid()),
        "the owner keeps the lock"
    );

    // The tool list and tool bodies come from the owner, unchanged.
    let tools = relay.rpc.result("tools/list", json!({}))["tools"].clone();
    let names: Vec<&str> = tools
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    let mut expected: Vec<&str> = mcp_tools().iter().map(|d| d.name).collect();
    expected.push("run_series");
    expected.push("render_picture");
    assert_eq!(names, expected);

    // Notifications pass through both ways.
    relay
        .rpc
        .result("resources/subscribe", json!({"uri": "rw://project/model"}));
    owner.rpc.result(
        "tools/call",
        json!({"name": "model_patch", "arguments": wet_patch()}),
    );
    assert!(relay.rpc.updated(1).contains("rw://project/model"));
    owner
        .rpc
        .result("resources/subscribe", json!({"uri": "rw://project/files"}));
    relay.rpc.result(
        "tools/call",
        json!({"name": "model_patch", "arguments": wet_patch()}),
    );
    assert!(owner.rpc.updated(1).contains("rw://project/files"));

    // The owner dies: the relay promotes, re-initializes and re-subscribes.
    let _ = owner.child.kill();
    let _ = owner.child.wait();
    wait_owner(&p.0, relay.pid());
    relay.wait_stderr(": owner");
    let r = relay.rpc.result(
        "tools/call",
        json!({"name": "job_status", "arguments": {"job_id": "j1"}}),
    );
    assert_eq!(r["_meta"]["rw/ctx"]["origin"], "mcp");
    wait_until(TIMEOUT.as_millis() as u64, || p.socket().exists());
    let mut cli = socket_rpc(&p);
    cli.initialize("2025-11-25");
    cli.result(
        "tools/call",
        json!({"name": "model_patch", "arguments": wet_patch(), "_meta": {"rw/origin": "cli"}}),
    );
    // Updates from the killed owner may still be queued: wait for the new one.
    let end = Instant::now() + TIMEOUT;
    loop {
        let got = relay.rpc.notifications(
            "notifications/resources/updated",
            Duration::from_millis(200),
        );
        if got
            .iter()
            .any(|n| n["params"]["uri"] == "rw://project/model")
        {
            break;
        }
        assert!(
            Instant::now() < end,
            "the replayed subscription never fired"
        );
    }
    drop(cli);
    relay.close_stdin();
    assert!(relay.wait_exit().success());
    assert_eq!(
        owner_pid(&p.0),
        None,
        "the promoted owner released the lock"
    );
}

#[test]
fn simultaneous_contenders_elect_one_owner() {
    const N: usize = 5;
    let p = TempProject::new();
    let mut all: Vec<Inst> = (0..N).map(|_| Inst::spawn(&p.0, &[])).collect();
    for i in &mut all {
        i.rpc.initialize("2025-11-25");
    }
    let owner = owner_pid(&p.0).expect("someone owns the project");
    let roles: Vec<&str> = all.iter_mut().map(Inst::role).collect();
    assert_eq!(
        roles.iter().filter(|r| **r == "owner").count(),
        1,
        "{roles:?}"
    );
    assert_eq!(
        roles.iter().filter(|r| **r == "relay").count(),
        N - 1,
        "{roles:?}"
    );
    let o = all.iter_mut().position(|i| i.role() == "owner").unwrap();
    assert_eq!(all[o].pid(), owner);
    for i in &mut all {
        let r = i.rpc.result(
            "tools/call",
            json!({"name": "job_status", "arguments": {"job_id": "j1"}}),
        );
        assert_eq!(r["_meta"]["rw/ctx"]["origin"], "mcp");
    }
    assert_eq!(owner_pid(&p.0), Some(owner));
}

#[test]
fn bind_failure_releases_the_lock_and_a_contender_owns_it() {
    let p = TempProject::new();
    let mut a = Inst::spawn(&p.0, &[("RW_TEST_HOOKS", "1"), ("RW_TEST_BIND_FAIL", "1")]);
    a.wait_stderr("released the lock");
    // A retries, but never keeps the lock without a listener.
    assert!(
        wait_until(5000, || owner_pid(&p.0).is_none()),
        "the lock stayed held after the bind failure"
    );
    let mut b = Inst::started(&p.0, &[]);
    wait_owner(&p.0, b.pid());
    assert_eq!(b.role(), "owner");
    // A becomes B's relay.
    a.rpc.initialize("2025-11-25");
    a.wait_stderr(&format!("relay to pid {}", b.pid()));
    let r = a.rpc.result(
        "tools/call",
        json!({"name": "job_status", "arguments": {"job_id": "j1"}}),
    );
    assert_eq!(r["_meta"]["rw/ctx"]["origin"], "mcp");
    assert_eq!(owner_pid(&p.0), Some(b.pid()));
}

#[test]
fn reaped_owner_drains_while_a_relay_and_job_remain() {
    let p = TempProject::fixture("fixtures/case1");
    let hooks = [("RW_TEST_HOOKS", "1"), ("RW_TEST_SIM_DELAY_MS", "2500")];
    let mut owner = Inst::started(&p.0, &hooks);
    wait_owner(&p.0, owner.pid());
    let mut relay = Inst::started(&p.0, &hooks);
    assert_eq!(relay.role(), "relay");
    let out = relay
        .rpc
        .ok("simulate", json!({"sim": "simulation_5", "force": false}));
    let job = out["job_id"].as_str().expect("a job").to_string();
    assert_eq!(out["status"], "running");

    // Lecturn's reaper closes the headless owner's stdin mid-job.
    owner.close_stdin();
    owner.wait_stderr("draining");
    let state = loop {
        assert!(owner.alive(), "the owner exited while the job ran");
        assert_eq!(owner_pid(&p.0), Some(owner.pid()));
        let st = relay.rpc.ok("job_status", json!({"job_id": job}));
        if st["state"] == "complete" {
            break st;
        }
        assert_eq!(st["state"], "running", "{st}");
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(state["summary"]["apogee_m"].as_f64().unwrap() > 300.0);
    // The job is done but the relay is still attached: the owner stays.
    std::thread::sleep(Duration::from_millis(300));
    assert!(owner.alive(), "the owner exited with a relay attached");
    let runs = relay.rpc.ok("run_list", json!({}));
    assert_eq!(runs["runs"][0]["status"], "complete");

    // The relay detaches: the owner drains out and releases the lock.
    relay.close_stdin();
    assert!(relay.wait_exit().success());
    assert!(owner.wait_exit().success());
    assert_eq!(owner_pid(&p.0), None);
    assert!(!p.socket().exists(), "the drained owner removed its socket");

    // The next instance promotes through the same election, and the
    // result the drained owner finished is still there.
    let mut next = Inst::started(&p.0, &[]);
    wait_owner(&p.0, next.pid());
    assert_eq!(next.role(), "owner");
    let runs = next.rpc.ok("run_list", json!({}));
    assert_eq!(runs["runs"][0]["status"], "complete");
    assert_eq!(runs["runs"][0]["run_id"], out["run_id"]);
    let again = next.rpc.ok("simulate", json!({"sim": "simulation_5"}));
    assert_eq!(again["cached"], true, "{again}");
}

#[test]
fn list_tools_takes_no_lock() {
    let p = TempProject::new();
    // On a free project: nothing is created.
    let o = Command::new(BIN)
        .args(["mcp", "--list-tools", "--project"])
        .arg(&p.0)
        .output()
        .unwrap();
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    assert!(!p.0.join(".rw").exists(), "--list-tools wrote .rw/");
    let listed: Value = serde_json::from_slice(&o.stdout).unwrap();

    // While another instance owns the project: same list, owner unchanged.
    let mut owner = Inst::started(&p.0, &[]);
    wait_owner(&p.0, owner.pid());
    let o = Command::new(BIN)
        .args(["mcp", "--list-tools", "--project"])
        .arg(&p.0)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let again: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(again, listed);
    assert_eq!(owner_pid(&p.0), Some(owner.pid()));
    let live = owner.rpc.result("tools/list", json!({}));
    assert_eq!(
        live["tools"], listed["tools"],
        "same as the live tools/list"
    );
}

#[test]
fn lecturn_meta_passes_through_the_relay() {
    let p = TempProject::new();
    let mut owner = Inst::started(&p.0, &[]);
    wait_owner(&p.0, owner.pid());
    let mut relay = Inst::started(&p.0, &[]);
    let context =
        json!({"projectId": "p1", "threadId": "lt-7", "workspaceRoot": p.0, "turnId": "u3"});
    let approval = json!({"approved": true, "requestId": "r9"});
    let r = relay.rpc.result(
        "tools/call",
        json!({"name": "job_status", "arguments": {"job_id": "j1"},
               "_meta": {"lecturn/context": context, "lecturn/approval": approval}}),
    );
    let m = &r["_meta"];
    assert_eq!(m["lecturn/context"], context);
    assert_eq!(m["lecturn/approval"], approval);
    assert_eq!(m["rw/ctx"]["thread"], "lt-7", "D21: the Lecturn thread");
    assert_eq!(m["rw/ctx"]["origin"], "mcp");
    // CPW1R4B: the owner's row summary reaches the client unchanged.
    let direct = owner.rpc.result(
        "tools/call",
        json!({"name": "job_status", "arguments": {"job_id": "j1"}}),
    );
    let summary = m["lecturn/summary"].as_str().expect("a lecturn/summary");
    assert!(
        !summary.is_empty() && !summary.contains('\n'),
        "{summary:?}"
    );
    assert_eq!(m["lecturn/summary"], direct["_meta"]["lecturn/summary"]);
    // rw/thread still wins.
    let r = relay.rpc.result(
        "tools/call",
        json!({"name": "job_status", "arguments": {"job_id": "j1"},
               "_meta": {"rw/thread": "t1", "lecturn/context": context}}),
    );
    assert_eq!(r["_meta"]["rw/ctx"]["thread"], "t1");
}

#[test]
fn relay_connections_are_mcp_origin() {
    let p = TempProject::new();
    let _owner = Inst::started(&p.0, &[]);
    wait_owner(&p.0, _owner.pid());
    let mut relay = Inst::started(&p.0, &[]);
    let r = relay.rpc.result(
        "tools/call",
        json!({"name": "job_status", "arguments": {"job_id": "j1"}}),
    );
    assert_eq!(r["_meta"]["rw/ctx"]["origin"], "mcp");
    // CLI-only commands stay out of reach of agents behind a relay ...
    let v = relay
        .rpc
        .call("tools/call", json!({"name": "fmt", "arguments": {}}));
    assert!(
        v["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("unknown tool")),
        "{v}"
    );
    // ... while a plain socket client (CLI forwarding) still reaches them.
    let mut cli = socket_rpc(&p);
    cli.initialize("2025-11-25");
    let v = cli.call(
        "tools/call",
        json!({"name": "fmt", "arguments": {}, "_meta": {"rw/origin": "cli"}}),
    );
    assert!(
        !v["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("unknown tool")),
        "{v}"
    );
    let r = cli.result(
        "tools/call",
        json!({"name": "job_status", "arguments": {"job_id": "j1"}}),
    );
    assert_eq!(r["_meta"]["rw/ctx"]["origin"], "socket");
}

const UPSTREAM_CHANGED: &str = "notifications/rw/upstream-changed";

/// Waits for an `rw/upstream-changed` notification; returns it.
fn wait_upstream_changed(rpc: &mut Rpc) -> Value {
    let end = Instant::now() + TIMEOUT;
    loop {
        if let Some(n) = rpc
            .notifications(UPSTREAM_CHANGED, Duration::from_millis(100))
            .pop()
        {
            return n;
        }
        assert!(Instant::now() < end, "no {UPSTREAM_CHANGED}");
    }
}

#[test]
fn owner_dies_after_commit_and_the_mutation_outcome_is_unknown() {
    let p = TempProject::fixture("fixtures/case1");
    let hooks = [
        ("RW_TEST_HOOKS", "1"),
        ("RW_TEST_EXIT_AFTER", "model_patch"),
    ];
    let mut owner = Inst::started(&p.0, &hooks);
    wait_owner(&p.0, owner.pid());
    let mut relay = Inst::started(&p.0, &[]);
    assert_eq!(relay.role(), "relay");
    relay.rpc.result(
        "resources/subscribe",
        json!({"uri": "rw://project/history"}),
    );
    let before = relay.rpc.ok("history_list", json!({}))["steps"]
        .as_array()
        .unwrap()
        .len();

    let ctx = json!({"projectId": "p1", "threadId": "lt-1", "workspaceRoot": p.0, "turnId": "u1"});
    let r = relay.rpc.result(
        "tools/call",
        json!({"name": "model_patch",
               "arguments": {"ops": [{"op": "replace", "path": "/c/fins/span", "value": "42 mm"}],
                             "dry_run": false, "label": "B1b span"},
               "_meta": {"lecturn/context": ctx}}),
    );
    assert_eq!(r["isError"], true, "{r}");
    let e = &r["_meta"]["rw/error"];
    assert_eq!(e["code"], "unavailable", "{r}");
    assert_eq!(e["outcome"], "unknown", "{r}");
    assert!(e["hint"].as_str().unwrap().contains("history_list"), "{r}");
    assert_eq!(r["_meta"]["lecturn/context"], ctx, "Lecturn keys echoed");
    assert_eq!(
        owner.wait_exit().code(),
        Some(70),
        "the hook killed the owner"
    );

    // The relay promotes, then tells its client the mirror is stale.
    wait_owner(&p.0, relay.pid());
    let note = wait_upstream_changed(&mut relay.rpc);
    assert_eq!(note["params"]["role"], "owner");
    assert!(relay.rpc.updated(1).contains("rw://project/history"));

    // The caller reconciles through the history: the step landed once.
    let steps = relay.rpc.ok("history_list", json!({}))["steps"].clone();
    let steps = steps.as_array().unwrap();
    assert_eq!(steps.len(), before + 1, "{steps:?}");
    assert_eq!(steps.last().unwrap()["tool"], "model_patch");
    let text = std::fs::read_to_string(p.0.join("rocket.rw.toml")).unwrap();
    assert!(text.contains("span = \"42 mm\""), "the patch is applied");

    // Subscriptions still fire on the promoted owner.
    relay.rpc.ok(
        "model_patch",
        json!({"ops": [{"op": "replace", "path": "/c/fins/span", "value": "44 mm"}], "dry_run": false}),
    );
    assert!(relay.rpc.updated(1).contains("rw://project/history"));
    relay.close_stdin();
    assert!(relay.wait_exit().success());
}

#[test]
fn owner_dies_mid_read_and_the_read_is_retried() {
    let p = TempProject::fixture("fixtures/case1");
    let hooks = [("RW_TEST_HOOKS", "1"), ("RW_TEST_EXIT_BEFORE", "model_get")];
    let mut owner = Inst::started(&p.0, &hooks);
    wait_owner(&p.0, owner.pid());
    let mut a = Inst::started(&p.0, &[]);
    let mut b = Inst::started(&p.0, &[]);
    assert_eq!(a.role(), "relay");
    assert_eq!(b.role(), "relay");
    a.rpc
        .result("resources/subscribe", json!({"uri": "rw://project/model"}));

    // The owner exits before answering: the relay retries on the new
    // upstream (itself or the other relay's promotion) and succeeds.
    let r = a.rpc.tool("model_get", json!({}));
    assert!(r.get("isError").is_none_or(|v| v == false), "{r}");
    assert!(r["structuredContent"].is_object(), "{r}");
    assert_eq!(owner.wait_exit().code(), Some(70));

    // Both relays reconnected and were told so.
    let na = wait_upstream_changed(&mut a.rpc);
    let nb = wait_upstream_changed(&mut b.rpc);
    let roles = [
        na["params"]["role"].as_str().unwrap(),
        nb["params"]["role"].as_str().unwrap(),
    ];
    assert_eq!(
        roles.iter().filter(|r| **r == "owner").count(),
        1,
        "{roles:?}"
    );
    assert!(a.rpc.updated(1).contains("rw://project/model"));
    let r = b.rpc.tool("model_get", json!({}));
    assert!(r.get("isError").is_none_or(|v| v == false), "{r}");
}
