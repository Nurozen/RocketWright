//! W0 merge gate for B1a + B2 + B3: `cargo test -p rw-cli --test
//! mcp_relay_approval_cards`. Through a relay (a second `rocketwright mcp`
//! on a project another instance owns):
//!
//! - a Lecturn-proxied gated call (`engine_simulate` with no duration,
//!   `lecturn/approval.approved: false`) still answers `approval_required`
//!   with `_meta["lecturn/approval-required"]` and runs nothing; the same
//!   call approved runs and completes synchronously;
//! - the run card's resource reads through the relay (`ui://rw/run-card`,
//!   `text/html;profile=mcp-app`, its `_meta.ui`), and the card's own
//!   `run_series` call returns the run's thrust samples;
//! - the tools a relay lists still declare their cards.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use common::*;
use rw_project::lock::{LockState, probe};
use rw_project::testutil::wait_until;
use serde_json::{Value, json};

fn lecturn_call(s: &mut Sidecar, name: &str, args: Value, approved: bool) -> Value {
    s.rpc.result(
        "tools/call",
        json!({"name": name, "arguments": args,
               "_meta": {"lecturn/approval": {"approved": approved},
                         "lecturn/context": {"projectId": "p1", "threadId": "t1",
                                             "workspaceRoot": "/w", "turnId": "u1"}}}),
    )
}

#[test]
fn gated_call_and_card_read_through_a_relay() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    let owner = Sidecar::started(&p.0);
    assert!(
        wait_until(TIMEOUT.as_millis() as u64, || p.socket().exists()),
        "the owner never served its socket"
    );
    let mut relay = Sidecar::started(&p.0);
    // The second instance relays: the first keeps the lock.
    relay.rpc.ok("model_get", json!({"path": "/name"}));
    match probe(&p.0).unwrap() {
        LockState::Held(i) => assert_eq!(i.pid, owner.child.id(), "the owner keeps the lock"),
        LockState::Free { .. } => panic!("nobody holds the lock"),
    }

    // The gated call: no side effect, the app-decided reason in `_meta`.
    let gated = lecturn_call(
        &mut relay,
        "engine_simulate",
        json!({"engine": "demo"}),
        false,
    );
    assert_eq!(gated["isError"], true, "{gated}");
    assert_eq!(gated["_meta"]["rw/error"]["code"], "approval_required");
    assert_eq!(
        gated["_meta"]["lecturn/approval-required"]["reason"],
        "Burn duration not set · default 120 s"
    );
    assert_eq!(gated["_meta"]["lecturn/approval"]["approved"], false);
    assert!(
        !p.0.join("runs/engine.demo").exists(),
        "a gated call ran the engine"
    );

    // Approved: the engine run completes synchronously.
    let ran = lecturn_call(
        &mut relay,
        "engine_simulate",
        json!({"engine": "demo"}),
        true,
    );
    assert!(ran.get("isError").is_none_or(|v| v == false), "{ran}");
    assert!(ran["_meta"].get("lecturn/approval-required").is_none());
    let out = &ran["structuredContent"];
    assert_eq!(out["status"], "complete");
    assert!(out["job_id"].is_null());

    // The tool's card, read through the relay.
    let tools = relay.rpc.result("tools/list", json!({}))["tools"].clone();
    let t = tools
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "engine_simulate")
        .unwrap();
    let uri = t["_meta"]["ui"]["resourceUri"].as_str().unwrap();
    assert_eq!(uri, "ui://rw/run-card");
    let read = relay.rpc.result("resources/read", json!({"uri": uri}));
    let c = &read["contents"][0];
    assert_eq!(c["mimeType"], "text/html;profile=mcp-app");
    assert_eq!(c["_meta"]["ui"]["prefersBorder"], true);
    assert!(c["text"].as_str().unwrap().starts_with("<!doctype html>"));

    // The card's own call (app-only run_series) through the relay.
    let series = relay.rpc.ok(
        "run_series",
        json!({"sim": out["sim"], "run_id": out["run_id"], "fields": ["t_s", "thrust_n"]}),
    );
    let thrust: Vec<f64> = series["values"]["thrust_n"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_f64)
        .collect();
    assert!(thrust.iter().copied().fold(0.0, f64::max) > 0.0);

    drop(relay);
    assert!(owner.stop().success());
}
