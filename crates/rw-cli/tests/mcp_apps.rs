//! B3 (D7, D8): `cargo test -p rw-cli --test mcp_apps`. The MCP Apps
//! surface of `rocketwright mcp`:
//!
//! - each card tool's `_meta.ui.resourceUri` (beside its `rw/*` keys), and
//!   `resources/read` of every `ui://rw/*` card (mime, CSP, prefersBorder);
//! - `run_series` on a real completed flight run (the B4(b) design) returns
//!   monotonic `t` and a positive altitude peak equal to the run's apogee;
//! - `run_series` on a real `engine_simulate` run of
//!   `fixtures/research-vehicle` engine `demo` returns monotonic `t_s` and a
//!   positive `thrust_n` peak;
//! - `run_series` is app-only: absent from the model-visible tool list;
//! - its input errors (unknown field, unsafe path, missing run, max_points);
//! - `render_picture` (app-only, read-only) returns a real `render`'s PNG
//!   by its `path`, and refuses paths outside renders/;
//! - `render_store` (internal, unlisted; CPW2B) stores a window render's
//!   PNG under renders/window/ for `render_picture`, and answers a call
//!   Lecturn proxied as an unknown tool.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use common::*;
use serde_json::{Value, json};

/// The B4(b) C-motor design (the design-and-fly turn's rocket).
const B4B: &str = "app/apps/server/test/fixtures/cards/b4b-design";

const CARDS: &[(&str, &[&str])] = &[
    (
        "ui://rw/run-card",
        &["simulate", "engine_simulate", "job_status", "run_diff"],
    ),
    (
        "ui://rw/step-card",
        &[
            "component_add",
            "component_remove",
            "model_patch",
            "import_file",
            "history_restore",
            "history_show",
        ],
    ),
    ("ui://rw/render-card", &["render", "history_compare"]),
];

fn tools(s: &mut Sidecar) -> Vec<Value> {
    s.rpc.result("tools/list", json!({}))["tools"]
        .as_array()
        .unwrap()
        .clone()
}

/// The tools a host shows the model: MCP Apps hides `visibility: ["app"]`.
fn model_visible(tools: &[Value]) -> Vec<&str> {
    tools
        .iter()
        .filter(|t| {
            t["_meta"]["ui"]["visibility"]
                .as_array()
                .is_none_or(|v| v.iter().any(|x| x == "model"))
        })
        .map(|t| t["name"].as_str().unwrap())
        .collect()
}

#[test]
fn card_tools_name_their_resource_and_every_card_reads() {
    let p = TempProject::new();
    let mut s = Sidecar::started(&p.0);
    let tools = tools(&mut s);
    let by_name: BTreeMap<&str, &Value> = tools
        .iter()
        .map(|t| (t["name"].as_str().unwrap(), t))
        .collect();
    let mut with_ui = 0;
    for (uri, names) in CARDS {
        for n in *names {
            let m = &by_name[n]["_meta"];
            assert_eq!(m["ui"]["resourceUri"], *uri, "{n}");
            assert!(m.get("rw/approval").is_some(), "{n}: rw/* keys stay");
            assert!(m.get("rw/mutating").is_some(), "{n}: rw/* keys stay");
            with_ui += 1;
        }
    }
    let declared = tools
        .iter()
        .filter(|t| t["_meta"]["ui"].get("resourceUri").is_some())
        .count();
    assert_eq!(
        declared, with_ui,
        "only the card table's tools declare a card"
    );

    let listed = s.rpc.result("resources/list", json!({}))["resources"].clone();
    for (uri, _) in CARDS {
        let r = listed
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["uri"] == *uri)
            .unwrap_or_else(|| panic!("{uri} is not listed"));
        assert_eq!(r["mimeType"], "text/html;profile=mcp-app");

        let read = s.rpc.result("resources/read", json!({"uri": uri}));
        let c = &read["contents"][0];
        assert_eq!(c["uri"], *uri);
        assert_eq!(c["mimeType"], "text/html;profile=mcp-app");
        assert_eq!(c["_meta"]["ui"]["prefersBorder"], true);
        assert_eq!(c["_meta"]["ui"]["csp"]["connectDomains"], json!([]));
        let html = c["text"].as_str().unwrap();
        assert!(html.starts_with("<!doctype html>"), "{uri}");
        assert!(html.contains("ui/initialize"), "{uri}");
        assert!(html.contains("--color-ring-primary"), "{uri}");
    }
    let e = s.rpc.call("resources/read", json!({"uri": "ui://rw/nope"}));
    assert!(e.get("error").is_some(), "{e}");
}

#[test]
fn run_series_is_hidden_from_the_model() {
    let p = TempProject::new();
    let mut s = Sidecar::started(&p.0);
    let tools = tools(&mut s);
    let t = tools.iter().find(|t| t["name"] == "run_series").unwrap();
    assert_eq!(t["_meta"]["ui"]["visibility"], json!(["app"]));
    assert_eq!(t["annotations"]["readOnlyHint"], true);
    assert_eq!(t["inputSchema"]["properties"]["max_points"]["maximum"], 400);
    let visible = model_visible(&tools);
    assert!(!visible.contains(&"run_series"));
    assert!(!visible.contains(&"render_picture"));
    assert_eq!(visible.len(), tools.len() - 2);
    let t = tools
        .iter()
        .find(|t| t["name"] == "render_picture")
        .unwrap();
    assert_eq!(t["_meta"]["ui"]["visibility"], json!(["app"]));
    assert_eq!(t["annotations"]["readOnlyHint"], true);
}

#[test]
fn render_picture_reads_a_real_render() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    let mut s = Sidecar::started(&p.0);
    let r = s.rpc.tool("render", json!({"view": "profile"}));
    let path = r["structuredContent"]["path"].as_str().unwrap().to_string();
    let inline = r["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["type"] == "image")
        .unwrap()["data"]
        .clone();
    let pic = s.rpc.tool("render_picture", json!({"path": path}));
    assert!(pic.get("isError").is_none_or(|v| v == false), "{pic}");
    let img = pic["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["type"] == "image")
        .unwrap()
        .clone();
    assert_eq!(img["mimeType"], "image/png");
    assert_eq!(img["data"], inline);
    assert_eq!(pic["structuredContent"]["path"], json!(path));
    for bad in [
        "rocket.rw.toml",
        "renders/../rocket.rw.toml",
        "/etc/passwd",
        "renders/nope.png",
    ] {
        let e = s.rpc.tool("render_picture", json!({"path": bad}));
        assert_eq!(e["isError"], true, "{bad}: {e}");
    }
}

#[test]
fn render_store_keeps_a_window_render_for_render_picture() {
    use base64::Engine as _;
    let p = TempProject::fixture("fixtures/research-vehicle");
    let mut s = Sidecar::started(&p.0);
    assert!(!tools(&mut s).iter().any(|t| t["name"] == "render_store"));
    // A real PNG (the profile render's), as the window would send one.
    let r = s.rpc.tool("render", json!({"view": "profile"}));
    let png = r["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["type"] == "image")
        .unwrap()["data"]
        .clone();
    let out = s.rpc.ok(
        "render_store",
        json!({"kind": "plot_render", "png_base64": png}),
    );
    let path = out["path"].as_str().unwrap().to_string();
    assert!(path.starts_with("renders/window/plot_render."), "{out}");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png.as_str().unwrap())
        .unwrap();
    assert_eq!(std::fs::read(p.0.join(&path)).unwrap(), bytes);
    assert_eq!(out["bytes"], json!(bytes.len()));
    // Storing the same picture again names the same file.
    let again = s.rpc.ok(
        "render_store",
        json!({"kind": "plot_render", "png_base64": png}),
    );
    assert_eq!(again["path"], json!(path));
    let pic = s.rpc.tool("render_picture", json!({"path": path}));
    let img = pic["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["type"] == "image")
        .unwrap()
        .clone();
    assert_eq!(img["data"], png);
    let bad = s.rpc.tool(
        "render_store",
        json!({"kind": "plot_render", "png_base64": "aGk="}),
    );
    assert_eq!(bad["isError"], true, "{bad}");
    // POL: each store keeps the newest 50 of its kind; other kinds are untouched.
    let fake = |i: u32| {
        let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
        b.extend_from_slice(&i.to_le_bytes());
        base64::engine::general_purpose::STANDARD.encode(b)
    };
    s.rpc.ok(
        "render_store",
        json!({"kind": "viewport_render", "png_base64": fake(0)}),
    );
    for i in 0..55 {
        s.rpc.ok(
            "render_store",
            json!({"kind": "plot_render", "png_base64": fake(i)}),
        );
    }
    let stored = |kind: &str| {
        std::fs::read_dir(p.0.join("renders/window"))
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.starts_with(&format!("{kind}.")))
            .collect::<Vec<_>>()
    };
    assert_eq!(stored("plot_render").len(), 50);
    assert_eq!(stored("viewport_render").len(), 1);
    // The newest is kept.
    let newest = s.rpc.ok(
        "render_store",
        json!({"kind": "plot_render", "png_base64": fake(54)}),
    );
    assert!(p.0.join(newest["path"].as_str().unwrap()).is_file());
    // Lecturn proxies listed tools only; one that reached here anyway is unknown.
    let proxied = s.rpc.call(
        "tools/call",
        json!({"name": "render_store", "arguments": {"kind": "plot_render", "png_base64": png},
               "_meta": {"lecturn/context": {"workspaceRoot": "/x", "threadId": "t"}}}),
    );
    assert!(proxied.get("error").is_some(), "{proxied}");
}

fn wait_job(s: &mut Sidecar, job: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let st = s.rpc.ok("job_status", json!({"job_id": job}));
        if st["state"] == "complete" {
            return st;
        }
        assert_ne!(st["state"], "failed", "{st}");
        assert!(Instant::now() < deadline, "job {job} did not finish");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn column(out: &Value, name: &str) -> Vec<f64> {
    out["values"][name]
        .as_array()
        .unwrap_or_else(|| panic!("no {name} in {out}"))
        .iter()
        .filter_map(Value::as_f64)
        .collect()
}

fn monotonic(v: &[f64]) -> bool {
    v.windows(2).all(|w| w[0] <= w[1]) && v.first() < v.last()
}

fn peak(v: &[f64]) -> f64 {
    v.iter().copied().fold(f64::NEG_INFINITY, f64::max)
}

#[test]
fn run_series_on_a_real_flight_run() {
    let p = TempProject::fixture(B4B);
    let mut s = Sidecar::started(&p.0);
    let out = s.rpc.ok("simulate", json!({"sim": "default"}));
    let done = match out["job_id"].as_str() {
        Some(job) => wait_job(&mut s, job),
        None => out.clone(),
    };
    let run = done["run_id"].as_str().unwrap().to_string();
    let apogee = done["summary"]["apogee_m"].as_f64().unwrap();

    let r = s.rpc.ok(
        "run_series",
        json!({"sim": "default", "run_id": run, "fields": ["t", "altitude"]}),
    );
    assert_eq!(r["fields"], json!(["t", "altitude"]));
    assert_eq!(r["columns"][0], "t");
    let n = r["points"].as_u64().unwrap() as usize;
    assert!(n <= 400 && n > 2, "{n} points");
    assert!(r["samples"].as_u64().unwrap() as usize >= n);
    let t = column(&r, "t");
    let alt = column(&r, "altitude");
    assert_eq!(t.len(), n);
    assert!(monotonic(&t), "t is not monotonic");
    let top = peak(&alt);
    assert!(top > 0.0, "altitude peak {top}");
    // The downsampled series keeps the stored peak: the run's apogee.
    assert!(
        (top - apogee).abs() <= 1e-3 * apogee,
        "peak {top} vs apogee {apogee}"
    );

    // A tighter budget still keeps the peak.
    let small = s.rpc.ok(
        "run_series",
        json!({"sim": "default", "run_id": run, "fields": ["t", "altitude"], "max_points": 50}),
    );
    assert!(small["points"].as_u64().unwrap() <= 50);
    assert_eq!(peak(&column(&small, "altitude")), top);
}

#[test]
fn run_series_on_a_real_engine_run() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    let mut s = Sidecar::started(&p.0);
    let out = s.rpc.ok("engine_simulate", json!({"engine": "demo"}));
    assert_eq!(out["status"], "complete");
    assert!(
        out["job_id"].is_null(),
        "engine runs are synchronous: {out}"
    );
    let sim = out["sim"].as_str().unwrap();
    assert_eq!(sim, "engine.demo");
    let r = s.rpc.ok(
        "run_series",
        json!({"sim": sim, "run_id": out["run_id"], "fields": ["t_s", "thrust_n", "chamber_pressure_pa"]}),
    );
    let t = column(&r, "t_s");
    assert!(monotonic(&t), "t_s is not monotonic");
    assert!(peak(&column(&r, "thrust_n")) > 0.0);
    assert!(peak(&column(&r, "chamber_pressure_pa")) > 0.0);
    assert!(r["points"].as_u64().unwrap() <= 400);
}

#[test]
fn run_series_input_errors() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    let mut s = Sidecar::started(&p.0);
    let out = s.rpc.ok("engine_simulate", json!({"engine": "demo"}));
    let run = out["run_id"].clone();
    let err = |s: &mut Sidecar, args: Value| {
        let r = s.rpc.tool("run_series", args);
        assert_eq!(r["isError"], true, "{r}");
        r["_meta"]["rw/error"].clone()
    };
    let e = err(
        &mut s,
        json!({"sim": "engine.demo", "run_id": run, "fields": ["altitude"]}),
    );
    assert_eq!(e["code"], "invalid_input");
    let msg = e["message"].as_str().unwrap();
    assert!(
        msg.contains("no column `altitude`") && msg.contains("thrust_n"),
        "{msg}"
    );
    let e = err(
        &mut s,
        json!({"sim": "..", "run_id": run, "fields": ["t_s"]}),
    );
    assert_eq!(e["code"], "invalid_input");
    let e = err(
        &mut s,
        json!({"sim": "engine.demo", "run_id": "000000000000", "fields": ["t_s"]}),
    );
    assert_eq!(e["code"], "not_found");
    let e = err(
        &mut s,
        json!({"sim": "engine.demo", "run_id": run, "fields": ["t_s"], "max_points": 1000}),
    );
    assert_eq!(e["code"], "invalid_input");
    let e = err(&mut s, json!({"sim": "engine.demo"}));
    assert_eq!(e["code"], "invalid_input");
}
