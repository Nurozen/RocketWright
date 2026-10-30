//! M1.31: `cargo test -p rw-cli --test mcp_notify`. Resource notifications
//! on a real project session: `notifications/resources/updated` for the
//! subscribed `rw://project/*` URIs after MCP writes, CLI writes forwarded
//! over `.rw/sidecar.sock` (`rw set`), watched external edits, and history
//! tags; `rw://runs/index` when a run completes. Dry runs and reads
//! announce nothing.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::collections::BTreeSet;
use std::process::Command;
use std::time::Duration;

use common::*;
use serde_json::json;

const ALL: [&str; 4] = [
    "rw://project/check",
    "rw://project/files",
    "rw://project/history",
    "rw://project/model",
];

fn set(uris: &[&str]) -> BTreeSet<String> {
    uris.iter().map(|u| u.to_string()).collect()
}

fn quiet(s: &mut Sidecar) {
    s.rpc.result("ping", json!({}));
    let n = s.rpc.notifications(
        "notifications/resources/updated",
        Duration::from_millis(300),
    );
    assert!(n.is_empty(), "unexpected updates: {n:?}");
}

#[test]
fn project_resources_follow_every_front_end() {
    let p = TempProject::fixture("fixtures/case1");
    let mut s = Sidecar::started(&p.0);
    for u in ALL {
        s.rpc.result("resources/subscribe", json!({"uri": u}));
    }

    // An MCP write: model, check, files, history.
    s.rpc.ok(
        "model_patch",
        json!({"ops": [{"op": "replace", "path": "/c/fins/span", "value": "32 mm"}]}),
    );
    assert_eq!(s.rpc.updated(4), set(&ALL));

    // Dry runs and reads announce nothing.
    s.rpc.ok(
        "model_patch",
        json!({"ops": [{"op": "replace", "path": "/c/fins/span", "value": "33 mm"}], "dry_run": true}),
    );
    s.rpc.ok("design_check", json!({}));
    s.rpc.ok("model_get", json!({}));
    quiet(&mut s);

    // A CLI write while the sidecar owns the project is forwarded over the
    // socket (D4) and announced to the stdio client.
    let out = Command::new(env!("CARGO_BIN_EXE_rocketwright"))
        .args(["set", "c.fins.span=34 mm", "--json", "--project"])
        .arg(&p.0)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["step"], "step:3");
    assert_eq!(s.rpc.updated(4), set(&ALL));
    let hist = s.rpc.ok("history_list", json!({}));
    assert_eq!(hist["steps"][2]["origin"], "cli");

    // A watched external edit (the watcher re-checks and records a step).
    let path = p.0.join("rocket.rw.toml");
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, text.replace("span = \"34 mm\"", "span = \"36 mm\"")).unwrap();
    assert_eq!(s.rpc.updated(4), set(&ALL));
    let hist = s.rpc.ok("history_list", json!({}));
    assert_eq!(hist["steps"][3]["origin"], "watcher");

    // A tag changes only the history.
    s.rpc.ok("history_tag", json!({"name": "baseline"}));
    assert_eq!(s.rpc.updated(1), set(&["rw://project/history"]));
    quiet(&mut s);
    assert!(s.stop().success());
}

#[test]
fn runs_index_updates_when_a_run_completes() {
    let p = TempProject::fixture("fixtures/case1");
    let mut s = Sidecar::started(&p.0);
    s.rpc
        .result("resources/subscribe", json!({"uri": "rw://runs/index"}));
    let out = s.rpc.ok("simulate", json!({"sim": "simulation_5"}));
    let deadline = std::time::Instant::now() + TIMEOUT * 6;
    loop {
        let n = s
            .rpc
            .notifications("notifications/resources/updated", Duration::from_millis(50));
        assert!(n.iter().all(|x| x["params"]["uri"] == "rw://runs/index"));
        let r = s
            .rpc
            .result("resources/read", json!({"uri": "rw://runs/index"}));
        let v: serde_json::Value =
            serde_json::from_str(r["contents"][0]["text"].as_str().unwrap()).unwrap();
        if !n.is_empty() && v["runs"][0]["status"] == "complete" {
            assert_eq!(v["runs"][0]["run_id"], out["run_id"]);
            break;
        }
        assert!(std::time::Instant::now() < deadline, "no completion update");
    }
    assert!(s.stop().success());
}
