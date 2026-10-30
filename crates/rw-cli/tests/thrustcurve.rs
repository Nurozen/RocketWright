//! `cargo test -p rw-cli --test thrustcurve`: the opt-in ThrustCurve search
//! and download against a local mock of thrustcurve.org's JSON API
//! (`RW_THRUSTCURVE_URL`), never the real network.
//!
//! - `rw motor thrustcurve search` parses results and needs no project.
//! - `rw motor thrustcurve fetch` saves the data file into `lib/motors/` as
//!   `rw motor import` does (sha256 in `[lib.sha256]`, `lib:` refs, the
//!   strict check) plus a `[lib.source]` record; the ref flies.
//! - Errors: unreachable host and HTTP errors (`RW-E015`, exit 2), no such
//!   motor or data file (`RW-E016`), an ambiguous designation (`RW-E017`).
//! - Over MCP, `thrustcurve_fetch` needs the user's approval (the reason names
//!   the host) and sends nothing before it; `thrustcurve_search` does not.
//!
//! The motors and the curve here are made up for the tests: ThrustCurve data
//! is never committed.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::{Arc, Mutex};

use assert_cmd::Command;
use base64::Engine as _;
use common::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const ACME_ID: &str = "aaaaaaaaaaaaaaaaaaaa0001";
const ZETA_ID: &str = "aaaaaaaaaaaaaaaaaaaa0002";

/// A synthetic 18 mm C motor (RASP), written for these tests.
const ACME_ENG: &str = "; synthetic test curve\n\
C6 18 70 0-3-5 0.0110 0.0240 Acme\n\
   0.050 6.000\n\
   0.200 12.000\n\
   0.400 6.000\n\
   1.500 4.500\n\
   1.800 0.000\n";

fn motor(id: &str, maker: &str) -> Value {
    json!({
        "motorId": id, "manufacturer": format!("{maker} Rocketry"), "manufacturerAbbrev": maker,
        "designation": "C6", "commonName": "C6", "impulseClass": "C", "diameter": 18,
        "length": 70, "type": "SU", "avgThrustN": 4.9, "totImpulseNs": 8.8,
        "burnTimeS": 1.8, "dataFiles": 2, "delays": "0,3,5", "availability": "regular"
    })
}

/// What the mock answers: search by common name / designation `C6` (two
/// makers), by manufacturer, or by id; download in RASP (a user file and a
/// cert file, cert preferred) but not RockSim; `BOOM` is an HTTP 500.
fn answer(path: &str, body: &Value) -> (u16, Value) {
    match path {
        "/api/v1/search.json" => {
            let name = body["commonName"]
                .as_str()
                .or(body["designation"].as_str())
                .unwrap_or("");
            if name == "BOOM" {
                return (500, json!({"error": "boom"}));
            }
            let mut all = vec![motor(ACME_ID, "Acme"), motor(ZETA_ID, "Zeta")];
            if let Some(id) = body["id"].as_str() {
                all.retain(|m| m["motorId"] == id);
            } else if !name.eq_ignore_ascii_case("c6") {
                all.clear();
            }
            if let Some(mk) = body["manufacturer"].as_str() {
                all.retain(|m| {
                    m["manufacturerAbbrev"]
                        .as_str()
                        .unwrap()
                        .eq_ignore_ascii_case(mk)
                });
            }
            (
                200,
                json!({"criteria": [], "matches": all.len(), "results": all}),
            )
        }
        "/api/v1/download.json" => {
            if body["format"] != "RASP" || body["motorIds"] != json!([ACME_ID]) {
                return (200, json!({"results": []}));
            }
            let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
            (
                200,
                json!({"results": [
                    {"motorId": ACME_ID, "simfileId": "bbbbbbbbbbbbbbbbbbbb0001", "format": "RASP",
                     "source": "user", "data": b64("not the preferred file\n"),
                     "infoUrl": "/simfiles/bbbbbbbbbbbbbbbbbbbb0001/"},
                    {"motorId": ACME_ID, "simfileId": "bbbbbbbbbbbbbbbbbbbb0002", "format": "RASP",
                     "source": "cert", "data": b64(ACME_ENG),
                     "infoUrl": "/simfiles/bbbbbbbbbbbbbbbbbbbb0002/"}
                ]}),
            )
        }
        _ => (404, json!({"error": "not found"})),
    }
}

/// A local HTTP/1.1 server answering [`answer`]; records every request.
struct Mock {
    url: String,
    seen: Arc<Mutex<Vec<(String, Value)>>>,
}

impl Mock {
    fn start() -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut r = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if r.read_line(&mut line).is_err() {
                    continue;
                }
                let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    if r.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() {
                        break;
                    }
                    if let Some((k, v)) = h.split_once(':')
                        && k.eq_ignore_ascii_case("content-length")
                    {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; len];
                let _ = r.read_exact(&mut body);
                let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                log.lock().unwrap().push((path.clone(), body.clone()));
                let (status, v) = answer(&path, &body);
                let text = v.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                    text.len()
                );
            }
        });
        Mock { url, seen }
    }

    fn requests(&self) -> Vec<(String, Value)> {
        self.seen.lock().unwrap().clone()
    }

    fn host(&self) -> &str {
        self.url.trim_start_matches("http://")
    }
}

fn rw(url: &str) -> Command {
    let mut c = Command::cargo_bin("rocketwright").unwrap();
    c.env("RW_CLOCK", "2026-10-30T12:00:00Z")
        .env("RW_THRUSTCURVE_URL", url)
        .env_remove("RW_OFFLINE")
        .env_remove("RW_TEST_HOOKS");
    c
}

fn run(url: &str, project: Option<&Path>, args: &[&str], code: i32) -> std::process::Output {
    let mut c = rw(url);
    if let Some(p) = project {
        c.arg("--project").arg(p);
    }
    let o = c.args(args).output().unwrap();
    assert_eq!(
        o.status.code(),
        Some(code),
        "rw {}: stdout {} stderr {}",
        args.join(" "),
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
    o
}

fn json_of(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes)
        .unwrap_or_else(|e| panic!("not JSON ({e}): {}", String::from_utf8_lossy(bytes)))
}

fn sha256(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

#[test]
fn search_parses_results_without_a_project() {
    let m = Mock::start();
    let dir = TempProject::new(); // not a project
    let o = rw(&m.url)
        .current_dir(&dir.0)
        .args([
            "--json",
            "motor",
            "thrustcurve",
            "search",
            "C6",
            "--diameter",
            "18 mm",
            "--impulse-class",
            "c",
            "--limit",
            "5",
        ])
        .output()
        .unwrap();
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let v = json_of(&o.stdout);
    let errs = validate("tools/thrustcurve_search.output", &v);
    assert!(errs.is_empty(), "{errs:?}");
    assert_eq!(v["matches"], 2);
    assert_eq!(v["host"], m.host());
    let acme = &v["motors"][0];
    assert_eq!(acme["motor_id"], ACME_ID);
    assert_eq!(acme["manufacturer"], "Acme");
    assert_eq!(acme["designation"], "C6");
    assert_eq!(acme["diameter"], 0.018);
    assert_eq!(acme["total_impulse"], 8.8);
    assert_eq!(acme["burn_time"], 1.8);
    // The request: common name, diameter in mm, upper-case class, the limit.
    let (path, body) = &m.requests()[0];
    assert_eq!(path, "/api/v1/search.json");
    assert_eq!(
        body,
        &json!({"commonName": "C6", "diameter": 18.0, "impulseClass": "C", "maxResults": 5})
    );

    // Text output lists each motor; `Acme C6-5` narrows by manufacturer.
    let o = run(
        &m.url,
        None,
        &["motor", "thrustcurve", "search", "Acme C6-5"],
        0,
    );
    let text = String::from_utf8_lossy(&o.stdout);
    assert!(text.contains(ACME_ID) && !text.contains(ZETA_ID), "{text}");
    assert!(text.contains("1 of 1 matches"), "{text}");
    assert_eq!(m.requests()[1].1["manufacturer"], "Acme");
    let o = run(&m.url, None, &["motor", "thrustcurve", "search", "Q99"], 0);
    assert!(String::from_utf8_lossy(&o.stdout).contains("no motors match"));
}

#[test]
fn fetch_saves_into_lib_motors_with_provenance() {
    let m = Mock::start();
    let p = TempProject::fixture("fixtures/simple");

    // Dry run: nothing written.
    let o = run(
        &m.url,
        Some(&p.0),
        &[
            "--json",
            "motor",
            "thrustcurve",
            "fetch",
            ACME_ID,
            "--dry-run",
        ],
        0,
    );
    let v = json_of(&o.stdout);
    assert_eq!(v["dry_run"], true);
    assert!(!p.0.join("lib/motors/Acme_C6.eng").exists());

    // By designation and manufacturer: the cert file wins, one history step.
    let o = run(
        &m.url,
        Some(&p.0),
        &["--json", "motor", "thrustcurve", "fetch", "Acme C6-5"],
        0,
    );
    let v = json_of(&o.stdout);
    let errs = validate("tools/thrustcurve_fetch.output", &v);
    assert!(errs.is_empty(), "{errs:?}");
    assert!(
        v["step"].as_str().is_some_and(|s| s.starts_with("step:")),
        "{v}"
    );
    assert_eq!(v["path"], "lib/motors/Acme_C6.eng");
    assert_eq!(v["imported"], json!(["lib:motors/Acme_C6.eng#C6"]));
    assert_eq!(v["curves"][0]["designation"], "C6");
    assert_eq!(
        v["curves"][0]["source"],
        json!({"kind": "library", "path": "lib/motors/Acme_C6.eng"})
    );
    let saved = std::fs::read(p.0.join("lib/motors/Acme_C6.eng")).unwrap();
    assert_eq!(saved, ACME_ENG.as_bytes(), "the file byte for byte");
    let manifest = std::fs::read_to_string(p.0.join("rocketwright.toml")).unwrap();
    assert!(
        manifest.contains(&format!(
            "\"lib/motors/Acme_C6.eng\" = \"{}\"",
            sha256(ACME_ENG.as_bytes())
        )),
        "{manifest}"
    );
    let doc: toml::Value = toml::from_str(&manifest).unwrap();
    let src = &doc["lib"]["source"]["lib/motors/Acme_C6.eng"];
    assert_eq!(src["origin"].as_str(), Some("thrustcurve"));
    assert_eq!(src["motor_id"].as_str(), Some(ACME_ID));
    assert_eq!(src["simfile_id"].as_str(), Some("bbbbbbbbbbbbbbbbbbbb0002"));
    assert_eq!(
        src["url"].as_str().unwrap(),
        format!("{}/simfiles/bbbbbbbbbbbbbbbbbbbb0002/", m.url)
    );
    assert_eq!(src["downloaded"].as_str(), Some("2026-10-30T12:00:00Z"));
    assert_eq!(v["source"]["origin"], "thrustcurve");

    // The design stays clean, and the ref flies.
    run(&m.url, Some(&p.0), &["check", "--strict"], 0);
    run(
        &m.url,
        Some(&p.0),
        &[
            "set",
            "configs.c6.motors.mount.motor=lib:motors/Acme_C6.eng#C6",
        ],
        0,
    );
    let o = run(&m.url, Some(&p.0), &["--json", "sim", "c6"], 0);
    let v = json_of(&o.stdout);
    assert!(v.to_string().contains("apogee"), "{v}");

    // History names the download.
    let o = run(&m.url, Some(&p.0), &["history", "log"], 0);
    assert!(
        String::from_utf8_lossy(&o.stdout).contains("Download motor Acme C6 (ThrustCurve)"),
        "{}",
        String::from_utf8_lossy(&o.stdout)
    );
}

#[test]
fn fetch_errors_are_clear_and_write_nothing() {
    let m = Mock::start();
    let p = TempProject::fixture("fixtures/simple");
    let before = std::fs::read_to_string(p.0.join("rocketwright.toml")).unwrap();
    let err = |args: &[&str], code: i32| {
        let mut all = vec!["--json"];
        all.extend_from_slice(args);
        json_of(&run(&m.url, Some(&p.0), &all, code).stderr)["error"].clone()
    };

    // Ambiguous: two makers have a C6.
    let e = err(&["motor", "thrustcurve", "fetch", "C6"], 1);
    assert_eq!(e["diagnostics"][0]["code"], "RW-E017", "{e}");
    assert!(e["message"].as_str().unwrap().contains(ZETA_ID), "{e}");
    // No such motor; no data file in the format.
    let e = err(&["motor", "thrustcurve", "fetch", "Q99"], 1);
    assert_eq!(e["diagnostics"][0]["code"], "RW-E016", "{e}");
    let e = err(
        &["motor", "thrustcurve", "fetch", "aaaaaaaaaaaaaaaaaaaa0009"],
        1,
    );
    assert_eq!(e["diagnostics"][0]["code"], "RW-E016", "{e}");
    let e = err(
        &["motor", "thrustcurve", "fetch", ACME_ID, "--format", "rse"],
        1,
    );
    assert_eq!(e["diagnostics"][0]["code"], "RW-E016", "{e}");
    assert!(e["hint"].as_str().unwrap().contains("--format eng"), "{e}");
    // The server fails: HTTP 500.
    let e = err(&["motor", "thrustcurve", "fetch", "BOOM"], 2);
    assert_eq!(e["diagnostics"][0]["code"], "RW-E015", "{e}");
    assert!(e["message"].as_str().unwrap().contains("HTTP 500"), "{e}");
    // A bad format is a usage error before any request.
    let n = m.requests().len();
    run(
        &m.url,
        Some(&p.0),
        &["motor", "thrustcurve", "fetch", ACME_ID, "--format", "zip"],
        2,
    );
    assert_eq!(m.requests().len(), n);

    // Nothing reachable: a closed port.
    let closed = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", l.local_addr().unwrap())
    };
    let o = run(
        &closed,
        Some(&p.0),
        &["--json", "motor", "thrustcurve", "fetch", ACME_ID],
        2,
    );
    let e = json_of(&o.stderr)["error"].clone();
    assert_eq!(e["code"], "unavailable", "{e}");
    assert_eq!(e["diagnostics"][0]["code"], "RW-E015", "{e}");
    let o = run(&closed, None, &["motor", "thrustcurve", "search", "C6"], 2);
    assert!(String::from_utf8_lossy(&o.stderr).contains("RW-E015"));
    // RW_OFFLINE=1 keeps the real host uncontacted (a loopback mock still works).
    let o = rw("https://www.thrustcurve.org")
        .env("RW_OFFLINE", "1")
        .args(["motor", "thrustcurve", "search", "C6"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&o.stderr).contains("RW_OFFLINE=1"));
    let o = rw(&m.url)
        .env("RW_OFFLINE", "1")
        .args(["motor", "thrustcurve", "search", "C6"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0));

    assert_eq!(
        std::fs::read_to_string(p.0.join("rocketwright.toml")).unwrap(),
        before
    );
    assert!(!p.0.join("lib/motors").exists());
}

const UNAPPROVED: &str = r#"{"approved": false, "requestId": "r1"}"#;

fn call(rpc: &mut Rpc, name: &str, args: Value, approved: Option<bool>) -> Value {
    let mut params = json!({"name": name, "arguments": args});
    if let Some(a) = approved {
        let approval: Value = if a {
            json!({"approved": true, "requestId": "r1"})
        } else {
            serde_json::from_str(UNAPPROVED).unwrap()
        };
        params["_meta"] = json!({
            "lecturn/approval": approval,
            "lecturn/context": {"projectId": "p1", "threadId": "lt1", "workspaceRoot": "/w", "turnId": "u1"},
        });
    }
    rpc.result("tools/call", params)
}

#[test]
fn mcp_fetch_needs_approval_and_search_does_not() {
    let m = Mock::start();
    let p = TempProject::fixture("fixtures/simple");
    let mut s = Sidecar::started_env(&p.0, &[("RW_THRUSTCURVE_URL", &m.url)]);

    let tools = s.rpc.result("tools/list", json!({}))["tools"].clone();
    let tool = |n: &str| {
        tools
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == n)
            .unwrap()
            .clone()
    };
    let fetch = tool("thrustcurve_fetch");
    assert_eq!(
        fetch["_meta"]["rw/permission_policy"], "always_ask",
        "{fetch}"
    );
    assert_eq!(fetch["annotations"]["openWorldHint"], true, "{fetch}");
    let search = tool("thrustcurve_search");
    assert_eq!(search["annotations"]["readOnlyHint"], true, "{search}");
    assert_eq!(search["annotations"]["openWorldHint"], true, "{search}");

    // Unapproved: answered without a request, the reason names the host.
    let r = call(
        &mut s.rpc,
        "thrustcurve_fetch",
        json!({"motor": "C6", "manufacturer": "Acme"}),
        Some(false),
    );
    assert_eq!(r["isError"], true, "{r}");
    let reason = format!("Download Acme C6 from {}", m.host());
    assert_eq!(
        r["_meta"]["lecturn/approval-required"],
        json!({"reason": reason}),
        "{r}"
    );
    assert_eq!(r["_meta"]["rw/error"]["code"], "approval_required", "{r}");
    assert!(m.requests().is_empty(), "no network before approval");
    assert!(!p.0.join("lib/motors").exists());

    // Search is read only: not gated even when Lecturn asks.
    let r = call(
        &mut s.rpc,
        "thrustcurve_search",
        json!({"query": "C6"}),
        Some(false),
    );
    assert_ne!(r["isError"], true, "{r}");
    assert_eq!(r["structuredContent"]["matches"], 2, "{r}");
    assert_eq!(r["_meta"]["lecturn/summary"], "2 motors", "{r}");

    // Approved: downloaded and saved through the session.
    let r = call(
        &mut s.rpc,
        "thrustcurve_fetch",
        json!({"motor": ACME_ID}),
        Some(true),
    );
    assert_ne!(r["isError"], true, "{r}");
    assert_eq!(
        r["structuredContent"]["path"], "lib/motors/Acme_C6.eng",
        "{r}"
    );
    assert_eq!(r["_meta"]["lecturn/summary"], "Saved Acme_C6.eng", "{r}");
    assert!(p.0.join("lib/motors/Acme_C6.eng").exists());

    // A CLI fetch while the sidecar owns the project is forwarded to it.
    let n = m.requests().len();
    let o = run(
        &m.url,
        Some(&p.0),
        &[
            "--json",
            "motor",
            "thrustcurve",
            "fetch",
            ACME_ID,
            "--dry-run",
        ],
        0,
    );
    let v = json_of(&o.stdout);
    assert_eq!(v["dry_run"], true, "{v}");
    assert_eq!(v["path"], "lib/motors/Acme_C6.eng", "{v}");
    assert!(m.requests().len() > n);
    assert!(s.stop().success());
}
