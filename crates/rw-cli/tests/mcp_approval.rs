//! B2 (D6): `cargo test -p rw-cli --test mcp_approval`. App-decided
//! approval for calls Lecturn proxies with `_meta["lecturn/approval"]`.
//!
//! - The rules and pinned D6 reason strings of the app's old
//!   `requiresApproval` (`policy.ts`, its tests `agent.test.ts` and
//!   `review-fixes.test.ts`), which B17 removed: these cases now hold them.
//! - Durations `30`, `"30"`, `"30 s"`, `"2 min"`, `0` and missing.
//! - `mc = 500` answers `not_implemented` with no approval meta, approved
//!   or not.
//! - Over MCP: a gated call is answered without side effects (`isError`,
//!   `rw/error` `approval_required`, `lecturn/approval-required {reason}`);
//!   `approved: true` runs it; no `lecturn/approval` meta behaves as today;
//!   a gated call through a relay is answered the same way.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::path::Path;

use common::*;
use rw_api::{ApiErrorCode, command_def};
use rw_cli::mcp::approval::{Gate, default_engine_seconds, gate, reason, seconds};
use rw_project::testutil::wait_until;
use serde_json::{Value, json};

fn why(tool: &str, args: Value) -> Option<String> {
    reason(command_def(tool).unwrap(), &args)
}

fn engine(duration: Value) -> Option<String> {
    let mut args = json!({"engine": "demo"});
    if !duration.is_null() {
        args["duration"] = duration;
    }
    why("engine_simulate", args)
}

const UNAPPROVED: &str = r#"{"approved": false, "requestId": "r1"}"#;

fn unapproved() -> Value {
    serde_json::from_str(UNAPPROVED).unwrap()
}

// ---- decisions -----------------------------------------------------------

#[test]
fn default_duration_is_the_engines() {
    assert_eq!(default_engine_seconds(), 120.0);
}

#[test]
fn durations_parse_with_the_core_grammar() {
    // agent.test.ts:168-176, review-fixes.test.ts:51-62
    assert_eq!(seconds(&json!("90 s")), Some(90.0));
    assert_eq!(seconds(&json!("2 min")), Some(120.0));
    assert_eq!(seconds(&json!("1500 ms")), Some(1.5));
    assert_eq!(seconds(&json!("120/1 s")), Some(120.0));
    assert_eq!(seconds(&json!(".5e3 s")), Some(500.0));
    assert_eq!(seconds(&json!("1 1/2 min")), Some(90.0));
    assert_eq!(seconds(&json!("90s")), Some(90.0));
    assert_eq!(seconds(&json!("2 hr")), Some(7200.0));
    assert_eq!(seconds(&json!("1 sec")), Some(1.0));
    assert_eq!(seconds(&json!("-5 s")), Some(-5.0));
    assert_eq!(seconds(&json!("= burn * 2")), None);
    assert_eq!(seconds(&json!("5 furlongs")), None);
    assert_eq!(seconds(&json!("5 m")), None, "a length is not a time");
    assert_eq!(seconds(&json!(true)), None);
    // Normalized: a bare number or unitless string is seconds.
    assert_eq!(seconds(&json!(30)), Some(30.0));
    assert_eq!(seconds(&json!("30")), Some(30.0));
    assert_eq!(seconds(&json!(" 30 s ")), Some(30.0));
    assert_eq!(seconds(&json!(0)), Some(0.0));
    assert_eq!(seconds(&json!(90.5)), Some(90.5));
}

#[test]
fn engine_durations() {
    // The listed D6 cases.
    assert_eq!(engine(json!(30)), None);
    assert_eq!(engine(json!("30")), None);
    assert_eq!(engine(json!("30 s")), None);
    assert_eq!(engine(json!(0)), None);
    assert_eq!(
        engine(json!("2 min")).as_deref(),
        Some("Engine burn of 120 s (over 60 s)")
    );
    let missing = Some("Burn duration not set · default 120 s");
    assert_eq!(engine(Value::Null).as_deref(), missing);
    assert_eq!(
        why(
            "engine_simulate",
            json!({"engine": "demo", "duration": null})
        )
        .as_deref(),
        missing,
        "null is missing"
    );
    // review-fixes.test.ts:64-69
    assert_eq!(
        engine(json!("120/1 s")).as_deref(),
        Some("Engine burn of 120 s (over 60 s)")
    );
    assert_eq!(
        engine(json!(".5e3 s")).as_deref(),
        Some("Engine burn of 500 s (over 60 s)")
    );
    assert_eq!(
        engine(json!("= t_burn * 3")).as_deref(),
        Some(r#"Burn duration "= t_burn * 3" can't be checked"#)
    );
    assert!(
        engine(json!("5 furlongs"))
            .unwrap()
            .contains("can't be checked")
    );
    assert_eq!(engine(json!("5 s")), None);
    assert_eq!(engine(json!("1 min")), None, "60 s is not over 60 s");
    assert_eq!(
        engine(json!(61)).as_deref(),
        Some("Engine burn of 61 s (over 60 s)")
    );
    assert_eq!(
        engine(json!(90.5)).as_deref(),
        Some("Engine burn of 90.5 s (over 60 s)")
    );
}

#[test]
fn network_urls_ask_except_rw() {
    // agent.test.ts:172-173
    assert_eq!(
        why(
            "simulate",
            json!({"sim": "b", "a": [{"b": " https://thrustcurve.org/x "}]})
        )
        .as_deref(),
        Some("Network access to thrustcurve.org")
    );
    assert_eq!(
        why(
            "simulate",
            json!({"sim": "b", "ref": "rw://runs/abc/summary", "path": "motors/c6.eng"})
        ),
        None
    );
    assert_eq!(
        why(
            "engine_simulate",
            json!({"engine": "https://x.example/e", "duration": "5 s"})
        )
        .as_deref(),
        Some("Network access to x.example")
    );
    // agent.test.ts:186: `never` tools never ask, whatever the input.
    assert_eq!(why("model_get", json!({"path": "https://x"})), None);
}

#[test]
fn simulate_without_mc_or_small_mc_runs() {
    // agent.test.ts:174-175 (mc 100 is not over the limit).
    assert_eq!(why("simulate", json!({"sim": "b", "mc": 100})), None);
    assert_eq!(why("simulate", json!({"sim": "b"})), None);
    let g = |args: Value| gate(command_def("simulate").unwrap(), &args, &unapproved());
    assert_eq!(g(json!({"sim": "b", "mc": 100})), None);
    assert_eq!(g(json!({"sim": "b"})), None);
}

#[test]
fn monte_carlo_is_not_implemented_before_any_gate() {
    let def = command_def("simulate").unwrap();
    let args = json!({"sim": "b", "mc": 500});
    for approval in [unapproved(), json!({"approved": true}), json!({})] {
        match gate(def, &args, &approval) {
            Some(Gate::Refuse(e)) => assert_eq!(e.code, ApiErrorCode::NotImplemented),
            other => panic!("mc 500 with {approval}: {other:?}"),
        }
    }
    // Even with a network URL in the input: nothing to approve.
    let args = json!({"sim": "https://x.example/s", "mc": 101});
    assert!(matches!(
        gate(def, &args, &unapproved()),
        Some(Gate::Refuse(_))
    ));
}

#[test]
fn always_tools_ask_and_name_the_path() {
    // agent.test.ts:178-188, review-fixes.test.ts (approval reasons).
    assert_eq!(
        why("export_file", json!({"path": "https://x.example/out"})).as_deref(),
        Some("Network access to x.example")
    );
    assert_eq!(
        why("export_file", json!({"path": "out.svg"})).as_deref(),
        Some(r#"Export writes "out.svg", outside the model"#)
    );
    assert!(
        why(
            "export_file",
            json!({"path": "/Users/x/.ssh/k", "allow_outside": true})
        )
        .unwrap()
        .starts_with("Export writes outside the project: /Users/x/.ssh/k")
    );
    assert_eq!(
        why("cfd_import", json!({})).as_deref(),
        Some("CFD import reads files outside the model")
    );
    assert!(why("import_file", json!({"path": "motors/c6.eng"})).is_some());
}

/// CPW1R5A: the approval card shows the reason to the user, so it is plain
/// prose: no tool ids, no comparison operators or code quotes, short.
#[test]
fn reasons_are_plain_prose() {
    let reasons = [
        engine(Value::Null),
        engine(json!("2 min")),
        engine(json!("5 furlongs")),
        why(
            "simulate",
            json!({"sim": "b", "a": "https://thrustcurve.org/x"}),
        ),
        why("export_file", json!({"path": "out.svg"})),
        why(
            "export_file",
            json!({"path": "/tmp/k", "allow_outside": true}),
        ),
        why("import_file", json!({"path": "motors/c6.eng"})),
        why("cfd_import", json!({})),
    ];
    for r in reasons {
        let r = r.expect("asks");
        let id = [
            "engine_simulate",
            "export_file",
            "import_file",
            "cfd_import",
            "simulate ",
        ];
        assert!(!id.iter().any(|t| r.contains(t)), "{r}: names a tool id");
        assert!(
            !r.contains('>') && !r.contains('`'),
            "{r}: operator or code quote"
        );
        assert!(r.chars().count() <= 60, "{r}: over 60 characters");
        assert!(
            r.starts_with(|c: char| c.is_uppercase()),
            "{r}: not a sentence"
        );
    }
}

#[test]
fn approved_runs_and_never_tools_pass() {
    let def = command_def("engine_simulate").unwrap();
    let args = json!({"engine": "demo"});
    assert!(matches!(
        gate(def, &args, &unapproved()),
        Some(Gate::Ask(_))
    ));
    assert_eq!(gate(def, &args, &json!({"approved": true})), None);
    // `approved` must be exactly `true`.
    for a in [
        json!({}),
        json!({"approved": "true"}),
        json!({"approved": 1}),
        json!(null),
    ] {
        assert!(matches!(gate(def, &args, &a), Some(Gate::Ask(_))), "{a}");
    }
    assert_eq!(
        gate(command_def("model_get").unwrap(), &json!({}), &unapproved()),
        None
    );
}

// ---- over MCP ------------------------------------------------------------

fn call(rpc: &mut Rpc, name: &str, args: Value, approval: Option<Value>) -> Value {
    let mut params = json!({"name": name, "arguments": args});
    if let Some(a) = approval {
        params["_meta"] = json!({
            "lecturn/approval": a,
            "lecturn/context": {"projectId": "p1", "threadId": "lt1", "workspaceRoot": "/w", "turnId": "u1"},
        });
    }
    rpc.result("tools/call", params)
}

fn assert_gated(r: &Value, reason: &str) {
    assert_eq!(r["isError"], true, "{r}");
    let m = &r["_meta"];
    assert_eq!(
        m["lecturn/approval-required"],
        json!({"reason": reason}),
        "{r}"
    );
    assert_eq!(m["rw/error"]["code"], "approval_required", "{r}");
    assert_eq!(m["rw/error"]["message"], reason);
    assert_eq!(m["lecturn/approval"], unapproved(), "request meta echoed");
    assert_eq!(m["rw/ctx"]["thread"], "lt1");
    // CPW1R4B: the row reads `Simulate engine · Needs approval`.
    assert_eq!(m["lecturn/summary"], "Needs approval", "{r}");
    assert!(r.get("structuredContent").is_none_or(Value::is_null), "{r}");
}

fn engine_runs(p: &Path) -> usize {
    std::fs::read_dir(p.join("runs/engine.demo"))
        .map(|d| d.count())
        .unwrap_or(0)
}

#[test]
fn engine_simulate_is_gated_then_runs_once_approved() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    let mut s = Sidecar::started(&p.0);
    let missing = "Burn duration not set · default 120 s";
    let r = call(
        &mut s.rpc,
        "engine_simulate",
        json!({"engine": "demo"}),
        Some(unapproved()),
    );
    assert_gated(&r, missing);
    let r = call(
        &mut s.rpc,
        "engine_simulate",
        json!({"engine": "demo", "duration": "2 min"}),
        Some(unapproved()),
    );
    assert_gated(&r, "Engine burn of 120 s (over 60 s)");
    assert_eq!(engine_runs(&p.0), 0, "a gated call has no side effects");

    // A short run needs no approval.
    let r = call(
        &mut s.rpc,
        "engine_simulate",
        json!({"engine": "demo", "duration": "4 s"}),
        Some(unapproved()),
    );
    assert_eq!(r["isError"], false, "{r}");
    assert!(r["_meta"].get("lecturn/approval-required").is_none());
    assert_eq!(r["structuredContent"]["status"], "complete");

    // Approved: the default duration runs.
    let r = call(
        &mut s.rpc,
        "engine_simulate",
        json!({"engine": "demo"}),
        Some(json!({"approved": true, "requestId": "r1"})),
    );
    assert_eq!(r["isError"], false, "{r}");
    assert!(r["_meta"].get("lecturn/approval-required").is_none());
    assert_eq!(r["structuredContent"]["status"], "complete", "{r}");
    assert_eq!(engine_runs(&p.0), 2);
    assert!(s.stop().success());
}

#[test]
fn calls_without_lecturn_approval_behave_as_today() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    let mut s = Sidecar::started(&p.0);
    let r = call(
        &mut s.rpc,
        "engine_simulate",
        json!({"engine": "demo", "duration": "2 min"}),
        None,
    );
    assert_eq!(r["isError"], false, "{r}");
    assert!(r["_meta"].get("lecturn/approval-required").is_none());
    // An `always` tool is not gated here either.
    let r = call(
        &mut s.rpc,
        "export_file",
        json!({"path": "https://x.example/out.svg"}),
        None,
    );
    assert!(r["_meta"].get("lecturn/approval-required").is_none(), "{r}");
    assert_ne!(r["_meta"]["rw/error"]["code"], "approval_required", "{r}");
    // A Lecturn context without approval meta is not gated.
    let r = s.rpc.result(
        "tools/call",
        json!({"name": "export_file", "arguments": {"path": "https://x.example/out.svg"},
               "_meta": {"lecturn/context": {"threadId": "lt1"}}}),
    );
    assert!(r["_meta"].get("lecturn/approval-required").is_none(), "{r}");
    assert!(s.stop().success());
}

#[test]
fn always_and_network_calls_are_gated() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    let mut s = Sidecar::started(&p.0);
    let r = call(
        &mut s.rpc,
        "import_file",
        json!({"path": "https://thrustcurve.org/c6.eng"}),
        Some(unapproved()),
    );
    assert_gated(&r, "Network access to thrustcurve.org");
    let r = call(
        &mut s.rpc,
        "export_file",
        json!({"path": "exports/out.svg"}),
        Some(unapproved()),
    );
    assert_gated(&r, r#"Export writes "exports/out.svg", outside the model"#);
    assert!(!p.0.join("exports/out.svg").exists());
    assert!(s.stop().success());
}

#[test]
fn monte_carlo_answers_not_implemented_with_no_approval_meta() {
    // Both with a project and in contract-fixture mode (doubles), where the
    // session's own `mc > 1` refusal is not there to catch it.
    let rv = TempProject::fixture("fixtures/research-vehicle");
    let empty = TempProject::new();
    for p in [&rv, &empty] {
        let mut s = Sidecar::started(&p.0);
        for approval in [unapproved(), json!({"approved": true, "requestId": "r2"})] {
            let r = call(
                &mut s.rpc,
                "simulate",
                json!({"sim": "nominal", "mc": 500}),
                Some(approval.clone()),
            );
            assert_eq!(r["isError"], true, "{r}");
            let m = &r["_meta"];
            assert_eq!(m["rw/error"]["code"], "not_implemented", "{r}");
            assert!(m.get("lecturn/approval-required").is_none(), "{r}");
            assert_eq!(m["lecturn/approval"], approval);
        }
        assert!(s.stop().success());
    }
}

#[test]
fn gated_call_through_a_relay() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    let _owner = Sidecar::started(&p.0);
    assert!(wait_until(20_000, || p.socket().exists()), "owner socket");
    let mut relay = Sidecar::started(&p.0);
    let r = call(
        &mut relay.rpc,
        "engine_simulate",
        json!({"engine": "demo"}),
        Some(unapproved()),
    );
    assert_gated(&r, "Burn duration not set · default 120 s");
    assert_eq!(r["_meta"]["rw/ctx"]["origin"], "mcp");
    assert_eq!(engine_runs(&p.0), 0);
}
