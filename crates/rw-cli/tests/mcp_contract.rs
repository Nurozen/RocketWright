//! M1.8: `cargo test -p rw-cli --test mcp_contract`. Drives `rocketwright mcp`
//! over raw newline-delimited JSON-RPC on stdio and on `.rw/sidecar.sock`:
//! protocol pin, the tool list against the registry, every tool body (double
//! or `NotImplemented`), `_meta`, resources, `resources/subscribe` →
//! `notifications/resources/updated`, and socket forwarding (a CLI-origin call
//! over the socket notifies the stdio client).
//!
//! Test builds enable the `doubles` feature (self dev-dependency).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::collections::BTreeSet;
use std::time::Duration;

use common::*;
use rw_api::{RESOURCES, schema_entry};
use serde_json::{Value, json};

#[test]
fn handshake_pins_protocol_2025_11_25() {
    let p = TempProject::new();
    for asked in ["2026-07-28", "2025-11-25", "2025-06-18"] {
        let mut s = Sidecar::start(&p.0);
        let r = s.rpc.initialize(asked);
        assert_eq!(r["protocolVersion"], "2025-11-25", "client asked {asked}");
        assert_eq!(r["serverInfo"]["name"], "rocketwright");
        assert_eq!(r["capabilities"]["resources"]["subscribe"], true);
        assert!(r["capabilities"]["tools"].is_object());
        assert!(s.stop().success());
    }
}

#[test]
fn tools_list_is_the_registry() {
    let p = TempProject::new();
    let mut s = Sidecar::started(&p.0);
    let tools = s.rpc.result("tools/list", json!({}))["tools"].clone();
    let tools = tools.as_array().unwrap();
    let listed: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    // The registry's tools, then the app-only `run_series` (B3) and `render_picture` (CP-W1 r3).
    let mut expected: Vec<&str> = mcp_tools().iter().map(|d| d.name).collect();
    expected.push("run_series");
    expected.push("render_picture");
    assert_eq!(listed, expected);
    for app in &tools[tools.len() - 2..] {
        assert_eq!(app["_meta"]["ui"]["visibility"], json!(["app"]));
        assert_eq!(app["annotations"]["readOnlyHint"], true);
    }
    for (t, d) in tools.iter().zip(mcp_tools()) {
        let input = schema_entry(&format!("tools/{}.input", d.name))
            .unwrap()
            .schema();
        let output = schema_entry(&format!("tools/{}.output", d.name))
            .unwrap()
            .schema();
        assert_eq!(&t["inputSchema"], input.as_value(), "{}", d.name);
        assert_eq!(&t["outputSchema"], output.as_value(), "{}", d.name);
        assert_eq!(
            t["inputSchema"]["type"], "object",
            "{}: MCP input roots are objects",
            d.name
        );
        let a = &t["annotations"];
        assert_eq!(a["readOnlyHint"], d.hints.read_only, "{}", d.name);
        assert_eq!(a["destructiveHint"], d.hints.destructive, "{}", d.name);
        assert_eq!(a["idempotentHint"], d.hints.idempotent, "{}", d.name);
        assert_eq!(t["_meta"]["rw/approval"], json!(d.approval), "{}", d.name);
        assert_eq!(t["_meta"]["rw/mutating"], d.hints.mutating, "{}", d.name);
        let gated = d.approval == rw_api::Approval::Always;
        assert_eq!(
            t["_meta"].get("rw/permission_policy") == Some(&json!("always_ask")),
            gated,
            "{}",
            d.name
        );
    }
}

#[test]
fn every_tool_answers_a_double_or_not_implemented() {
    let p = TempProject::new();
    let mut s = Sidecar::started(&p.0);
    for d in mcp_tools() {
        let input = fixture_payload(&format!("tools/{}.input.json", d.name));
        let r = s.rpc.result(
            "tools/call",
            json!({"name": d.name, "arguments": input, "_meta": {"rw/thread": "t1", "rw/tool_call": format!("tc-{}", d.name), "rw/label": "contract"}}),
        );
        let ctx = &r["_meta"]["rw/ctx"];
        assert_eq!(ctx["origin"], "mcp", "{}", d.name);
        assert_eq!(ctx["thread"], "t1", "{}", d.name);
        assert_eq!(ctx["tool_call"], format!("tc-{}", d.name));
        assert_eq!(ctx["label"], "contract");
        assert!(
            r.get("isError").is_none_or(|v| v == false),
            "{}: {r}",
            d.name
        );
        let out = &r["structuredContent"];
        assert_eq!(
            out,
            &fixture_payload(&format!("tools/{}.output.json", d.name)),
            "{}",
            d.name
        );
        let errs = validate(&format!("tools/{}.output", d.name), out);
        assert!(errs.is_empty(), "{}: {errs:?}", d.name);
        let text: Value = serde_json::from_str(r["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            &text, out,
            "{}: text content mirrors structuredContent",
            d.name
        );
        (d.check_output)(out).unwrap();
    }
}

#[test]
fn bad_calls_are_reported() {
    let p = TempProject::new();
    let mut s = Sidecar::started(&p.0);
    // Schema-invalid input: a tool-level error the agent can read.
    let r = s
        .rpc
        .result("tools/call", json!({"name": "job_status", "arguments": {}}));
    assert_eq!(r["isError"], true);
    assert_eq!(r["_meta"]["rw/error"]["code"], "invalid_input");
    // Unknown tool: a protocol error.
    let v = s
        .rpc
        .call("tools/call", json!({"name": "nope", "arguments": {}}));
    assert!(v.get("error").is_some(), "{v}");
}

#[test]
fn resources_list_and_read() {
    let p = TempProject::new();
    let mut s = Sidecar::started(&p.0);
    let list = s.rpc.result("resources/list", json!({}))["resources"].clone();
    let uris: BTreeSet<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["uri"].as_str().unwrap())
        .collect();
    let fixed: BTreeSet<&str> = RESOURCES
        .iter()
        .filter(|r| !r.uri.contains('{'))
        .map(|r| r.uri)
        .collect();
    // The registry's resources, then the `ui://rw/*` MCP Apps cards (B3).
    let (ui, rw): (BTreeSet<&str>, BTreeSet<&str>) =
        uris.iter().partition(|u| u.starts_with("ui://"));
    assert_eq!(rw, fixed);
    assert_eq!(
        ui,
        BTreeSet::from([
            "ui://rw/run-card",
            "ui://rw/step-card",
            "ui://rw/render-card"
        ])
    );
    for r in list.as_array().unwrap() {
        let ui = r["uri"].as_str().unwrap().starts_with("ui://");
        let mime = if ui {
            "text/html;profile=mcp-app"
        } else {
            "application/json"
        };
        assert_eq!(r["mimeType"], mime, "{}", r["uri"]);
    }
    let templates =
        s.rpc.result("resources/templates/list", json!({}))["resourceTemplates"].clone();
    let tpl: BTreeSet<&str> = templates
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["uriTemplate"].as_str().unwrap())
        .collect();
    let want: BTreeSet<&str> = RESOURCES
        .iter()
        .filter(|r| r.uri.contains('{'))
        .map(|r| r.uri)
        .collect();
    assert_eq!(tpl, want);

    for (uri, type_name) in [
        ("rw://project/model", "evaluated-model"),
        ("rw://project/check", "check-report"),
        ("rw://project/files", "project-files"),
        ("rw://project/history", "tools/history_list.output"),
        ("rw://runs/index", "tools/run_list.output"),
        ("rw://runs/r1/summary", "run-summary"),
        ("rw://jobs/j1", "job-info"),
    ] {
        let r = s.rpc.result("resources/read", json!({"uri": uri}));
        let c = &r["contents"][0];
        assert_eq!(c["uri"], uri);
        assert_eq!(c["mimeType"], "application/json");
        let v: Value = serde_json::from_str(c["text"].as_str().unwrap()).unwrap();
        let errs = validate(type_name, &v);
        assert!(errs.is_empty(), "{uri}: {errs:?}");
    }
    let r = s.rpc.result(
        "resources/read",
        json!({"uri": "rw://schema/tools/model_patch.input"}),
    );
    let v: Value = serde_json::from_str(r["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        &v,
        schema_entry("tools/model_patch.input")
            .unwrap()
            .schema()
            .as_value()
    );
    let e = s.rpc.call("resources/read", json!({"uri": "rw://nope"}));
    assert!(e.get("error").is_some(), "{e}");
}

#[test]
fn subscriptions_fire_resources_updated() {
    let p = TempProject::new();
    let mut s = Sidecar::started(&p.0);
    for uri in ["rw://project/model", "rw://project/check"] {
        s.rpc.result("resources/subscribe", json!({"uri": uri}));
    }
    let e = s.rpc.call(
        "resources/subscribe",
        json!({"uri": "rw://runs/r1/summary"}),
    );
    assert!(
        e.get("error").is_some(),
        "summaries are not subscribable: {e}"
    );

    let patch = fixture_payload("tools/model_patch.input.json");
    let mut wet = patch.clone();
    wet["dry_run"] = json!(false);
    s.rpc.result(
        "tools/call",
        json!({"name": "model_patch", "arguments": wet}),
    );
    assert_eq!(
        s.rpc.updated(2),
        ["rw://project/check", "rw://project/model"]
            .map(String::from)
            .into()
    );

    // dry_run writes nothing (I6), so nothing is announced.
    let mut dry = patch.clone();
    dry["dry_run"] = json!(true);
    s.rpc.result(
        "tools/call",
        json!({"name": "model_patch", "arguments": dry}),
    );
    s.rpc.result("ping", json!({}));
    assert!(
        s.rpc
            .notifications(
                "notifications/resources/updated",
                Duration::from_millis(200)
            )
            .is_empty()
    );

    // Read-only tools announce nothing either.
    s.rpc.result("tools/call", json!({"name": "design_check", "arguments": fixture_payload("tools/design_check.input.json")}));
    s.rpc.result("ping", json!({}));
    assert!(
        s.rpc
            .notifications(
                "notifications/resources/updated",
                Duration::from_millis(200)
            )
            .is_empty()
    );

    s.rpc.result(
        "resources/unsubscribe",
        json!({"uri": "rw://project/check"}),
    );
    s.rpc.result(
        "tools/call",
        json!({"name": "model_patch", "arguments": wet}),
    );
    assert_eq!(
        s.rpc.updated(1),
        ["rw://project/model"].map(String::from).into()
    );
}

#[test]
fn socket_forwarding_round_trip() {
    let p = TempProject::new();
    let mut app = Sidecar::started(&p.0);
    app.rpc
        .result("resources/subscribe", json!({"uri": "rw://project/model"}));
    assert!(p.socket().exists(), ".rw/sidecar.sock is served");

    // A CLI write forwarded over the socket (D4) runs with origin=cli ...
    let mut cli = socket_rpc(&p);
    let init = cli.initialize("2025-11-25");
    assert_eq!(init["protocolVersion"], "2025-11-25");
    let mut wet = fixture_payload("tools/model_patch.input.json");
    wet["dry_run"] = json!(false);
    let r = cli.result(
        "tools/call",
        json!({"name": "model_patch", "arguments": wet, "_meta": {"rw/origin": "cli", "rw/label": "rw set"}}),
    );
    assert_eq!(r["_meta"]["rw/ctx"]["origin"], "cli");
    assert_eq!(
        r["structuredContent"],
        fixture_payload("tools/model_patch.output.json")
    );
    // ... and the app's stdio client hears about it.
    assert_eq!(
        app.rpc.updated(1),
        ["rw://project/model"].map(String::from).into()
    );

    // A socket client without rw/origin is origin=socket.
    let r = cli.result(
        "tools/call",
        json!({"name": "job_status", "arguments": {"job_id": "j1"}}),
    );
    assert_eq!(r["_meta"]["rw/ctx"]["origin"], "socket");

    // Socket subscribers hear stdio writes too.
    cli.result("resources/subscribe", json!({"uri": "rw://project/files"}));
    app.rpc.result(
        "tools/call",
        json!({"name": "model_patch", "arguments": wet}),
    );
    assert_eq!(
        cli.updated(1),
        ["rw://project/files"].map(String::from).into()
    );

    drop(cli);
    assert!(app.stop().success());
    assert!(!p.socket().exists(), "socket removed on shutdown");
}

#[test]
fn stale_socket_is_replaced_and_live_one_kept() {
    let p = TempProject::new();
    std::fs::create_dir_all(p.0.join(".rw")).unwrap();
    std::fs::write(p.socket(), b"stale").unwrap();
    let first = Sidecar::started(&p.0);
    let mut cli = socket_rpc(&p);
    cli.initialize("2025-11-25");

    // A second sidecar must not steal a live project (D4: one owner): it
    // becomes a client of the owner's socket and leaves it alone.
    let mut second = Sidecar::start(&p.0);
    let init = second.rpc.initialize("2025-11-25");
    assert_eq!(init["protocolVersion"], "2025-11-25");
    assert_eq!(init["serverInfo"]["name"], "rocketwright");
    let r = second.rpc.result(
        "tools/call",
        json!({"name": "job_status", "arguments": {"job_id": "j1"}}),
    );
    assert_eq!(
        r["_meta"]["rw/ctx"]["origin"], "mcp",
        "a relay is an MCP client"
    );
    let rw_project::lock::LockState::Held(info) = rw_project::lock::probe(&p.0).unwrap() else {
        panic!("the owner lost the lock")
    };
    assert_eq!(info.pid, first.child.id());
    assert!(second.stop().success(), "the relay exits cleanly");
    drop(cli);
    let mut cli = socket_rpc(&p);
    cli.initialize("2025-11-25");
    drop(cli);
    assert!(
        p.socket().exists(),
        "the second sidecar left the live socket alone"
    );
    assert!(first.stop().success());
}

/// M1.31: every registry tool on the real Session (a copy of
/// `fixtures/case1`): outputs validate against the published output schema,
/// mutating tools return a `CheckDelta` (I6), and only the rows that have
/// not landed answer `not_implemented`.
#[test]
fn real_session_tool_bodies() {
    let p = TempProject::fixture("fixtures/case1");
    let mut s = Sidecar::started(&p.0);
    let golden = repo_root().join("tests/oracle/case1-generic.json");
    let seen = std::cell::RefCell::new(BTreeSet::new());
    let ok = |s: &mut Sidecar, name: &str, args: Value| -> Value {
        seen.borrow_mut().insert(name.to_string());
        let out = s.rpc.ok(name, args);
        let errs = validate(&format!("tools/{name}.output"), &out);
        assert!(errs.is_empty(), "{name}: {errs:?}");
        let def = rw_api::command_def(name).unwrap();
        if def.hints.mutating {
            let errs = validate("check-delta", &out["delta"]);
            assert!(errs.is_empty(), "{name} delta: {errs:?}");
        }
        assert_ne!(
            out,
            fixture_payload(&format!("tools/{name}.output.json")),
            "{name} answered the contract double"
        );
        out
    };

    // Runs first, while the model matches the run.
    let sim = ok(&mut s, "simulate", json!({"sim": "simulation_5"}));
    let job = sim["job_id"].as_str().expect("a job").to_string();
    let deadline = std::time::Instant::now() + TIMEOUT * 6;
    let done = loop {
        let st = ok(&mut s, "job_status", json!({"job_id": job}));
        if st["state"] == "complete" {
            break st;
        }
        assert!(st["state"] == "queued" || st["state"] == "running", "{st}");
        assert!(std::time::Instant::now() < deadline, "job did not finish");
        std::thread::sleep(Duration::from_millis(50));
    };
    let run_id = sim["run_id"].as_str().unwrap().to_string();
    assert_eq!(done["run_id"], run_id.as_str());
    let cached = ok(&mut s, "simulate", json!({"sim": "simulation_5"}));
    assert_eq!(cached["cached"], true);
    assert_eq!(cached["status"], "complete");
    let cancel = ok(&mut s, "job_cancel", json!({"job_id": job}));
    assert_eq!(cancel["state"], "complete", "finished jobs are unchanged");
    let runs = ok(&mut s, "run_list", json!({}));
    assert_eq!(runs["runs"][0]["status"], "complete");
    let diff = ok(
        &mut s,
        "run_diff",
        json!({"a": run_id, "golden": golden.display().to_string()}),
    );
    assert_eq!(diff["pass"], true, "{diff}");

    ok(&mut s, "project_validate", json!({}));
    let sub = ok(&mut s, "model_get", json!({"path": "/components/0"}));
    assert_eq!(sub["value"]["id"], "nose");
    let quick = ok(&mut s, "design_check", json!({"sim": "quick"}));
    assert_eq!(quick["tier"], "quick_sim");
    assert!(quick["sim"]["apogee_m"].as_f64().unwrap() > 300.0);

    let r = s.rpc.tool(
        "render",
        json!({"view": "fin", "width": 400, "height": 300}),
    );
    seen.borrow_mut().insert("render".into());
    let out = &r["structuredContent"];
    assert!(validate("tools/render.output", out).is_empty());
    assert_eq!(
        (out["width"].clone(), out["height"].clone()),
        (json!(400), json!(300))
    );
    assert_eq!(r["content"][1]["type"], "image", "render returns the PNG");
    assert_eq!(r["content"][1]["mimeType"], "image/png");
    assert!(p.0.join(out["path"].as_str().unwrap()).is_file());

    ok(&mut s, "library_search", json!({}));
    let motors = ok(&mut s, "motor_search", json!({"class": "C"}));
    assert!(
        motors["motors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "generic:RW_C6G")
    );
    let schema = ok(&mut s, "schema_get", json!({"name": "check-delta"}));
    assert_eq!(
        schema["schema"]["$id"],
        "https://rocketwright.dev/schema/1/check-delta.json"
    );

    // Mutations.
    let dry = ok(
        &mut s,
        "model_patch",
        json!({"ops": [{"op": "replace", "path": "/c/fins/span", "value": "35 mm"}], "dry_run": true}),
    );
    assert!(dry["delta"]["changed"]["stability.liftoff"].is_array());
    let wet = ok(
        &mut s,
        "model_patch",
        json!({"ops": [{"op": "replace", "path": "/c/fins/span", "value": "35 mm"}]}),
    );
    assert_eq!(wet["step"], "step:2");
    let ballast = json!({"type": "mass_component", "attach": {"to": "body.fore", "at": "fore", "offset": "60 mm"},
        "mass": "5 g", "length": "10 mm", "od": "20 mm"});
    let added = ok(
        &mut s,
        "component_add",
        json!({"id": "ballast", "component": ballast}),
    );
    assert!(
        added["delta"]["changed"]["mass.liftoff"].is_array(),
        "{added}"
    );
    ok(&mut s, "component_remove", json!({"id": "ballast"}));
    let runs = ok(&mut s, "run_list", json!({}));
    assert_eq!(runs["runs"][0]["status"], "outdated", "edits outdate runs");

    // History.
    ok(&mut s, "history_list", json!({}));
    ok(&mut s, "history_show", json!({"version": "step:2"}));
    ok(&mut s, "model_diff", json!({"a": "step:1", "b": "live"}));
    ok(
        &mut s,
        "history_compare",
        json!({"a": "step:1", "b": "live"}),
    );
    ok(&mut s, "history_tag", json!({"name": "baseline"}));
    ok(
        &mut s,
        "history_restore",
        json!({"version": "step:1", "dry_run": true}),
    );

    // project_create on an existing project is a conflict.
    let r = s.rpc.tool("project_create", json!({}));
    seen.borrow_mut().insert("project_create".into());
    assert_eq!(r["_meta"]["rw/error"]["code"], "conflict");

    // import_file (dry run) and export_file (M2.5, M2.6) on real files.
    let ork = p.0.join("bird.ork.xml");
    std::fs::write(&ork, include_str!("../../rw-ork/tests/data/simple.ork.xml")).unwrap();
    seen.borrow_mut().insert("import_file".into());
    let r = s.rpc.tool(
        "import_file",
        json!({"path": ork.display().to_string(), "kind": "ork", "dry_run": true}),
    );
    assert!(r.get("isError").is_none_or(|v| v == false), "{r}");
    assert_eq!(r["structuredContent"]["dry_run"], true, "{r}");
    seen.borrow_mut().insert("export_file".into());
    let r = s.rpc.tool(
        "export_file",
        json!({"format": "glb", "path": "exports/rocket.glb"}),
    );
    assert!(r.get("isError").is_none_or(|v| v == false), "{r}");
    assert!(p.0.join("exports/rocket.glb").is_file());

    // Liquid engines (M4.6) on the research vehicle.
    let rv = TempProject::fixture("fixtures/research-vehicle");
    let mut s2 = Sidecar::started(&rv.0);
    let d = ok(&mut s2, "engine_design", json!({"engine": "demo"}));
    assert!(d["performance"]["thrust"].as_f64().unwrap() > 0.0, "{d}");
    assert_eq!(d["missing_inputs"], json!([]));
    let d = ok(
        &mut s2,
        "engine_design",
        json!({"engine": "demo-incomplete"}),
    );
    assert_eq!(d["missing_inputs"].as_array().unwrap().len(), 2, "{d}");
    let r = ok(
        &mut s2,
        "engine_simulate",
        json!({"engine": "demo", "duration": "4 s"}),
    );
    assert_eq!(r["status"], "complete", "{r}");
    assert!(
        rv.0.join(format!(
            "runs/engine.demo/{}/engine.json",
            r["run_id"].as_str().unwrap()
        ))
        .is_file()
    );
    assert!(s2.stop().success());

    // cfd_import (M5.4): the contract payload (a dry run of one step) on a
    // copy of the synthetic fixture, then a real import of every step.
    let name = "cfd_import";
    let cfd = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/cfd");
    std::fs::create_dir_all(p.0.join("fixtures/cfd")).unwrap();
    for f in ["tank_t0.0.csv", "tank_t0.5.csv", "tank_t1.0.csv"] {
        std::fs::copy(cfd.join(f), p.0.join("fixtures/cfd").join(f)).unwrap();
    }
    let r = ok(
        &mut s,
        name,
        fixture_payload(&format!("tools/{name}.input.json")),
    );
    assert_eq!(r["dry_run"], true);
    assert_eq!(r["dataset"]["id"], "tank_flow");
    assert_eq!(r["dataset"]["files"], json!(["fixtures/cfd/tank_t0.5.csv"]));
    assert_eq!(r["dataset"]["times"], json!([0.5]));
    assert_eq!(r["dataset"]["provenance"], "cfd");
    assert!(
        !p.0.join("runs/cfd.tank_flow").exists(),
        "a dry run writes nothing"
    );
    let r = ok(&mut s, name, json!({"path": "fixtures/cfd"}));
    assert_eq!(r["dataset"]["id"], "tank");
    assert_eq!(r["dataset"]["times"], json!([0.0, 0.5, 1.0]));
    assert_eq!(r["delta"]["changed"], json!({}));
    let rec = p.0.join(format!(
        "runs/cfd.tank/{}/cfd.json",
        r["dataset"]["run_id"].as_str().unwrap()
    ));
    let rec: Value = serde_json::from_str(&std::fs::read_to_string(rec).unwrap()).unwrap();
    assert_eq!(rec["provenance"], "cfd");
    assert_eq!(rec["steps"].as_array().unwrap().len(), 3);
    let all: BTreeSet<String> = mcp_tools().iter().map(|d| d.name.to_string()).collect();
    assert_eq!(*seen.borrow(), all, "every registry tool is exercised");

    // Real resources.
    for uri in [
        "rw://runs/index".to_string(),
        format!("rw://runs/{run_id}/summary"),
        format!("rw://jobs/{job}"),
    ] {
        let r = s.rpc.result("resources/read", json!({"uri": uri}));
        let v: Value = serde_json::from_str(r["contents"][0]["text"].as_str().unwrap()).unwrap();
        assert_ne!(v, Value::Null, "{uri}");
    }
    assert!(s.stop().success());
}

/// R7.3: tool descriptions say when to use the tool, and mutating tools
/// show the CheckDelta shape.
#[test]
fn descriptions_show_the_check_delta_shape() {
    let p = TempProject::new();
    let mut s = Sidecar::started(&p.0);
    let tools = s.rpc.result("tools/list", json!({}))["tools"].clone();
    for (t, d) in tools.as_array().unwrap().iter().zip(mcp_tools()) {
        let text = t["description"].as_str().unwrap();
        assert!(text.len() > d.summary.len() / 2, "{}", d.name);
        assert_eq!(
            text.contains("changed: {\"<metric path>\": [before, after]}"),
            d.hints.mutating,
            "{}: {text}",
            d.name
        );
    }
}
