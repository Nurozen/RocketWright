//! M2.6: `rw export ork|rasp|glb|stl|csv` through the binary.
//! `cargo test -p rw-cli --test export`.
//!
//! - GLB: a structurally valid glTF 2.0 binary (header, chunks, accessors in
//!   bounds, triangle indices in range).
//! - STL: binary, triangle count matches the size, and watertight: after
//!   welding coincident vertices, every directed edge is matched by its
//!   reverse (closed, consistently oriented surfaces).
//! - RASP: parses back as a motor and imports into `lib/motors/`.
//! - CSV: the run's series.
//! - `.ork`: export → `rw import ork` into a new project → the evaluated
//!   component ids, types, stations, and dimensions agree within 1e-9 m.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::collections::BTreeMap;
use std::path::Path;

use assert_cmd::Command;
use common::{TempProject, repo_root};
use serde_json::Value;

fn rw(project: &Path) -> Command {
    let mut c = Command::cargo_bin("rocketwright").unwrap();
    c.env("RW_CLOCK", "2026-10-16T12:00:00Z")
        .env_remove("RW_TEST_HOOKS")
        .env("RW_MOTOR_CACHE", "")
        .arg("--project")
        .arg(project)
        .current_dir(project);
    c
}

fn rw_json(project: &Path, args: &[&str]) -> Value {
    let o = rw(project).args(args).arg("--json").output().unwrap();
    assert!(
        o.status.success(),
        "rw {args:?}: {}\n{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
    serde_json::from_slice(&o.stdout).unwrap()
}

fn simple_project() -> TempProject {
    let t = TempProject::new();
    let o = Command::cargo_bin("rocketwright")
        .unwrap()
        .args(["init", "--template", "simple-rocket"])
        .arg(&t.0)
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    t
}

fn u32le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

/// Structural GLB validation (glTF 2.0 binary container).
fn validate_glb(b: &[u8]) {
    assert_eq!(&b[0..4], b"glTF");
    assert_eq!(u32le(b, 4), 2, "version");
    assert_eq!(u32le(b, 8) as usize, b.len(), "length");
    let jlen = u32le(b, 12) as usize;
    assert_eq!(u32le(b, 16), 0x4E4F_534A, "JSON chunk");
    assert_eq!(jlen % 4, 0);
    let doc: Value = serde_json::from_slice(&b[20..20 + jlen]).unwrap();
    assert_eq!(doc["asset"]["version"], "2.0");
    let bin_at = 20 + jlen;
    let blen = u32le(b, bin_at) as usize;
    assert_eq!(u32le(b, bin_at + 4), 0x004E_4942, "BIN chunk");
    let bin = &b[bin_at + 8..bin_at + 8 + blen];
    assert_eq!(
        doc["buffers"][0]["byteLength"].as_u64().unwrap() as usize,
        blen
    );
    let views = doc["bufferViews"].as_array().unwrap();
    for v in views {
        let off = v["byteOffset"].as_u64().unwrap_or(0) as usize;
        let len = v["byteLength"].as_u64().unwrap() as usize;
        assert!(off + len <= blen, "bufferView in bounds");
    }
    let acc = doc["accessors"].as_array().unwrap();
    for m in doc["meshes"].as_array().unwrap() {
        for p in m["primitives"].as_array().unwrap() {
            let pos = &acc[p["attributes"]["POSITION"].as_u64().unwrap() as usize];
            let n_vert = pos["count"].as_u64().unwrap();
            let ia = &acc[p["indices"].as_u64().unwrap() as usize];
            let n_idx = ia["count"].as_u64().unwrap() as usize;
            assert_eq!(n_idx % 3, 0, "triangles");
            assert_eq!(ia["componentType"], 5125);
            let v = &views[ia["bufferView"].as_u64().unwrap() as usize];
            let off = v["byteOffset"].as_u64().unwrap_or(0) as usize;
            for k in 0..n_idx {
                assert!(
                    u64::from(u32le(bin, off + 4 * k)) < n_vert,
                    "index in range"
                );
            }
        }
    }
    let nodes = doc["nodes"].as_array().unwrap();
    for r in doc["scenes"][0]["nodes"].as_array().unwrap() {
        assert!((r.as_u64().unwrap() as usize) < nodes.len());
    }
}

type P = [i64; 3];

/// Parses a binary STL and checks it is watertight (see the module docs).
fn validate_stl(b: &[u8]) -> usize {
    let n = u32le(b, 80) as usize;
    assert_eq!(b.len(), 84 + 50 * n, "size matches the triangle count");
    assert!(n > 0);
    let q = |at: usize| -> P {
        let f = |k: usize| f32::from_le_bytes(b[at + 4 * k..at + 4 * k + 4].try_into().unwrap());
        // Weld at 1e-3 mm.
        [0, 1, 2].map(|k| (f64::from(f(k)) * 1e3).round() as i64)
    };
    let mut edges: BTreeMap<(P, P), i64> = BTreeMap::new();
    for t in 0..n {
        let at = 84 + 50 * t + 12;
        let v = [q(at), q(at + 12), q(at + 24)];
        if v[0] == v[1] || v[1] == v[2] || v[0] == v[2] {
            continue; // degenerate (a fan apex)
        }
        for k in 0..3 {
            let (a, c) = (v[k], v[(k + 1) % 3]);
            *edges.entry((a, c)).or_default() += 1;
        }
    }
    let open: Vec<_> = edges
        .iter()
        .filter(|((a, c), k)| edges.get(&(*c, *a)).copied().unwrap_or(0) != **k)
        .take(5)
        .collect();
    assert!(
        open.is_empty(),
        "unmatched edges (not watertight): {open:?}"
    );
    n
}

fn components(m: &Value) -> BTreeMap<String, Value> {
    m["components"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["id"].as_str().unwrap().to_string(), c.clone()))
        .collect()
}

fn close(a: &Value, b: &Value, path: &str) {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            assert!((x - y).abs() <= 1e-9, "{path}: {x} vs {y}");
        }
        (Value::Object(x), Value::Object(y)) => {
            for (k, v) in x {
                close(v, y.get(k).unwrap_or(&Value::Null), &format!("{path}/{k}"));
            }
        }
        (Value::Array(x), Value::Array(y)) => {
            assert_eq!(x.len(), y.len(), "{path}");
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                close(p, q, &format!("{path}/{i}"));
            }
        }
        _ => assert_eq!(a, b, "{path}"),
    }
}

/// Evaluated ids, types, stations, and dimensions agree within 1e-9 m.
fn assert_same_geometry(a: &Value, b: &Value) {
    let (ca, cb) = (components(a), components(b));
    assert_eq!(
        ca.keys().collect::<Vec<_>>(),
        cb.keys().collect::<Vec<_>>(),
        "component ids"
    );
    for (id, x) in &ca {
        let y = &cb[id];
        assert_eq!(x["shape"]["type"], y["shape"]["type"], "{id}");
        for k in ["x_fore", "x_aft"] {
            close(&x[k], &y[k], &format!("{id}/{k}"));
        }
        close(&x["shape"], &y["shape"], &format!("{id}/shape"));
    }
}

#[test]
fn glb_and_stl_validate() {
    let p = simple_project();
    let v = rw_json(&p.0, &["export", "glb", "out/rocket.glb"]);
    assert_eq!(v["path"], "out/rocket.glb");
    validate_glb(&std::fs::read(p.0.join("out/rocket.glb")).unwrap());
    rw_json(&p.0, &["export", "stl", "out/rocket.stl"]);
    validate_stl(&std::fs::read(p.0.join("out/rocket.stl")).unwrap());
    // The fixture with fin tabs, a cluster-free mount, and rings.
    let c = TempProject::fixture("fixtures/case1");
    rw_json(&c.0, &["export", "stl", "x.stl"]);
    validate_stl(&std::fs::read(c.0.join("x.stl")).unwrap());
    rw_json(&c.0, &["export", "glb", "x.glb"]);
    validate_glb(&std::fs::read(c.0.join("x.glb")).unwrap());
}

#[test]
fn rasp_and_csv_export() {
    let p = simple_project();
    rw_json(&p.0, &["export", "rasp", "motors.eng"]);
    let text = std::fs::read_to_string(p.0.join("motors.eng")).unwrap();
    assert!(text.lines().any(|l| l.contains(' ') && !l.starts_with(';')));
    // It is a valid motor file: it imports into lib/motors/.
    let v = rw_json(&p.0, &["motor", "import", "motors.eng"]);
    assert!(!v["imported"].as_array().unwrap().is_empty(), "{v}");
    assert!(p.0.join("lib/motors/motors.eng").is_file());
    let check = rw_json(&p.0, &["check"]);
    assert!(
        !check["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["code"] == "RW-W003"),
        "the imported motor's sha256 is recorded"
    );

    let o = rw(&p.0).args(["export", "csv", "x.csv"]).output().unwrap();
    assert_eq!(
        o.status.code(),
        Some(2),
        "csv without a run is a usage error"
    );
    rw_json(&p.0, &["sim", "baseline"]);
    rw_json(&p.0, &["export", "csv", "x.csv", "--run", "baseline"]);
    let csv = std::fs::read_to_string(p.0.join("x.csv")).unwrap();
    assert!(csv.starts_with("t,"), "{}", &csv[..csv.len().min(80)]);
    assert!(csv.lines().count() > 10);
}

#[test]
fn ork_round_trip_keeps_evaluated_ids_and_dimensions() {
    for fixture in [
        "templates/simple-rocket",
        "fixtures/case1",
        "fixtures/research-vehicle",
    ] {
        if !repo_root().join(fixture).is_dir() {
            continue;
        }
        let p = TempProject::fixture(fixture);
        let configs = rw_json(&p.0, &["eval"])["model"].clone();
        rw_json(&p.0, &["export", "ork", "rocket.ork"]);
        let dest = TempProject::new();
        let out = dest.0.join("imported");
        // The import runs its own strict check: exit 1 when it is not clean
        // (the research vehicle's liftoff T/W warning), the step recorded.
        let o = rw(&p.0)
            .args([
                "import",
                "ork",
                p.0.join("rocket.ork").to_str().unwrap(),
                out.to_str().unwrap(),
                "--json",
            ])
            .output()
            .unwrap();
        let v: Value = serde_json::from_slice(&o.stdout).unwrap();
        let strict = v["check_strict_status"].as_str().unwrap_or("?");
        assert_eq!(
            o.status.code(),
            Some(if strict == "clean" { 0 } else { 1 }),
            "{fixture}: {v}"
        );
        assert_ne!(strict, "errors", "{fixture}: {v}");
        assert!(v["step"].is_string(), "{fixture}: {v}");
        let back = rw_json(&out, &["eval"])["model"].clone();
        assert_same_geometry(&configs, &back);
        // Every configuration of the source survives with its motors resolved.
        for (id, cfg) in configs["configs"].as_object().unwrap() {
            let b = &back["configs"][id];
            assert!(b.is_object(), "{fixture}: config {id}");
            assert_eq!(
                cfg["motors"].as_array().map(Vec::len),
                b["motors"].as_array().map(Vec::len),
                "{fixture}: {id}"
            );
        }
        let o = rw(&out).args(["check"]).output().unwrap();
        assert_eq!(
            o.status.code(),
            Some(0),
            "{fixture}: {}",
            String::from_utf8_lossy(&o.stdout)
        );
    }
}

/// REV-core item 2: `rw export` refuses a path outside the project unless
/// `--allow-outside` is given.
#[test]
fn export_outside_the_project_needs_allow_outside() {
    let p = simple_project();
    let out = TempProject::new();
    let target = out.0.join("rocket.glb");
    let o = rw(&p.0)
        .args(["export", "glb"])
        .arg(&target)
        .output()
        .unwrap();
    assert_eq!(
        o.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    assert!(String::from_utf8_lossy(&o.stderr).contains("outside the project"));
    assert!(!target.exists());
    let o = rw(&p.0)
        .args(["export", "glb", "../escape.glb"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    let t = target.display().to_string();
    rw_json(&p.0, &["export", "glb", &t, "--allow-outside"]);
    validate_glb(&std::fs::read(&target).unwrap());
}
