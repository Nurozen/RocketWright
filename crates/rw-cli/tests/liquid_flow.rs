//! M4.4-M4.6: `cargo test -p rw-cli --test liquid_flow` (and with
//! `--features cea` for the native-CEA part). On a copy of the research
//! vehicle:
//!
//! - `rw check --json` reports exactly the two missing inputs of
//!   `engines/demo-incomplete.rw.toml` (`RW-W210`, `RW-W211`, plan D10b);
//! - `rw engine design demo` sizes the spec R6.13 engine with no findings,
//!   and the incomplete variant lists `Missing inputs · 2`;
//! - the generated curve flies in `rw sim` (a Complete run whose manifest
//!   names `MotorSource::Liquid`);
//! - `rw engine sim demo` writes `runs/engine.demo/<run>/` and caches;
//! - feature `cea`: a custom N2O(L)/IPA(L) engine is designed through native
//!   CEA and equals a direct `rw-cea-sys` call, also from a relocated binary;
//!   without the feature it reports `RW-E227`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::path::Path;

use assert_cmd::Command;
use common::*;
use serde_json::Value;

fn rw_at(bin: Option<&Path>, project: &Path, args: &[&str], env: &[(&str, &str)]) -> (i32, String) {
    let mut c = match bin {
        Some(b) => Command::new(b),
        None => Command::cargo_bin("rocketwright").unwrap(),
    };
    c.env("RW_CLOCK", "2026-10-20T12:00:00Z")
        .env("RW_OFFLINE", "1")
        .env_remove("RW_TEST_HOOKS")
        .env_remove("RW_CEA_DATA")
        .env_remove("RW_RENDER");
    for (k, v) in env {
        c.env(k, v);
    }
    let o = c
        .arg("--project")
        .arg(project)
        .args(args)
        .current_dir(repo_root())
        .output()
        .unwrap();
    (
        o.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&o.stdout).into_owned() + &String::from_utf8_lossy(&o.stderr),
    )
}

fn rw(project: &Path, args: &[&str]) -> (i32, String) {
    rw_at(None, project, args, &[])
}

fn json(out: &str) -> Value {
    let start = out.find('{').unwrap_or_else(|| panic!("no JSON in {out}"));
    let mut de = serde_json::Deserializer::from_str(&out[start..]).into_iter::<Value>();
    de.next().unwrap().unwrap()
}

const LIQUID_CONFIG: &str = "name = \"Liquid demo\"\n\n[motors.motor_casing]\nengine = \"demo\"\n\n[deploy.chute]\nevent = \"apogee\"\n";
const LIQUID_SIM: &str =
    "name = \"Liquid demo\"\nconfig = \"liquid\"\n\n[launch]\nrail_length = \"3 m\"\n";

#[test]
fn check_reports_exactly_the_two_missing_inputs() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    let (_, out) = rw(p.path(), &["check", "--json"]);
    let v = json(&out);
    let w2: Vec<(String, String)> = v["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["code"].as_str().is_some_and(|c| c.starts_with("RW-W2")))
        .map(|d| {
            (
                d["code"].as_str().unwrap().to_string(),
                d["path"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    assert_eq!(
        w2,
        vec![
            (
                "RW-W210".to_string(),
                "/engines/demo-incomplete/fluid_model".to_string()
            ),
            (
                "RW-W211".to_string(),
                "/engines/demo-incomplete/feed/edge/0/bc".to_string()
            ),
        ],
        "{out}"
    );
    // The complete engine adds no liquid finding at all.
    assert!(
        !out.contains("/engines/demo/"),
        "demo engine has findings: {out}"
    );
}

#[test]
fn engine_design_sizes_the_spec_engine_and_lists_missing_inputs() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    let (code, out) = rw(p.path(), &["--json", "engine", "design", "demo"]);
    assert_eq!(code, 0, "{out}");
    let v = json(&out);
    let errs = validate("tools/engine_design.output", &v);
    assert!(errs.is_empty(), "{errs:?}");
    let perf = &v["performance"];
    assert!((perf["thrust"].as_f64().unwrap() - 1500.0).abs() < 1e-6);
    let dt = perf["throat_diameter"].as_f64().unwrap();
    assert!((dt - 0.026_159).abs() < 1e-4, "{dt}");
    assert_eq!(v["missing_inputs"].as_array().unwrap().len(), 0);
    assert_eq!(v["design"]["thermo"], "table:n2o-ethanol");
    assert_eq!(v["design"]["feed"].as_array().unwrap().len(), 2);
    assert!(v["design"]["blowdown"]["burn_time"].as_f64().unwrap() > 2.0);

    let (code, out) = rw(p.path(), &["--json", "engine", "design", "demo-incomplete"]);
    assert_eq!(code, 1, "missing inputs fail: {out}");
    let v = json(&out);
    assert_eq!(
        v["missing_inputs"],
        serde_json::json!([
            "/engines/demo-incomplete/fluid_model",
            "/engines/demo-incomplete/feed/edge/0/bc"
        ])
    );
    // Chamber sizing does not need the feed inputs; the blowdown does.
    assert!(v["performance"].is_object());
    assert!(v["design"]["blowdown"].is_null());

    let (code, out) = rw(p.path(), &["engine", "design", "nope"]);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("no engine `nope`"), "{out}");
}

#[test]
fn the_liquid_curve_flies_in_rw_sim() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    std::fs::write(p.path().join("configs/liquid.rw.toml"), LIQUID_CONFIG).unwrap();
    std::fs::write(p.path().join("sims/liquid.rw.toml"), LIQUID_SIM).unwrap();
    let (code, out) = rw(p.path(), &["sim", "liquid"]);
    assert_eq!(code, 0, "{out}");
    let (_, list) = rw(
        p.path(),
        &["--json", "call", "run_list", "{\"sim\":\"liquid\"}"],
    );
    let v = json(&list);
    let run = &v["runs"][0];
    assert_eq!(run["status"], "complete", "{list}");
    let id = run["run_id"].as_str().unwrap();
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(p.path().join(format!("runs/liquid/{id}/manifest.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["motors"][0]["source"]["kind"], "liquid");
    assert_eq!(manifest["motors"][0]["source"]["engine"], "demo");
    let s = &run["summary"];
    assert!(s["apogee_m"].as_f64().unwrap() > 1000.0, "{s}");
    let burnout = s["burnout_time_s"].as_f64().unwrap();
    assert!((2.0..30.0).contains(&burnout), "{s}");
    // Changing the engine changes the run (its curve and hash are inputs).
    let path = p.path().join("engines/demo.rw.toml");
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(
        &path,
        text.replace("pressure = \"50 bar\"", "pressure = \"48 bar\""),
    )
    .unwrap();
    let (code, out) = rw(p.path(), &["sim", "liquid"]);
    assert_eq!(code, 0, "{out}");
    assert!(
        !out.contains(id),
        "a new run id after the engine edit: {out}"
    );
}

#[test]
fn engine_sim_writes_the_blowdown_run() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    let (code, out) = rw(p.path(), &["--json", "engine", "sim", "demo"]);
    assert_eq!(code, 0, "{out}");
    let v = json(&out);
    assert!(validate("tools/engine_simulate.output", &v).is_empty());
    assert_eq!(v["status"], "complete");
    assert_eq!(v["cached"], false);
    let dir = p.path().join(format!(
        "runs/engine.demo/{}",
        v["run_id"].as_str().unwrap()
    ));
    let doc: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("engine.json")).unwrap()).unwrap();
    assert_eq!(doc["provenance"], "engineering");
    assert!(doc["blowdown"]["samples"].as_array().unwrap().len() > 100);
    let csv = std::fs::read_to_string(dir.join("series.csv")).unwrap();
    assert!(csv.starts_with("t_s,chamber_pressure_pa,ox_tank_pressure_pa"));
    let (_, again) = rw(p.path(), &["--json", "engine", "sim", "demo"]);
    assert_eq!(json(&again)["cached"], true);
    let (code, out) = rw(p.path(), &["engine", "sim", "demo-incomplete"]);
    assert_eq!(code, 1, "{out}");
}

/// An engine like the demo on N2O(L)/IPA(L) named as CEA species: not a
/// table pair, so it dispatches to native CEA.
fn native_engine(p: &Path) {
    let demo = std::fs::read_to_string(p.join("engines/demo.rw.toml")).unwrap();
    let text = demo
        .replace(
            "propellants = { oxidizer = \"n2o\", fuel = \"ethanol\" }",
            "propellants = { oxidizer = \"N2O(L)\", fuel = \"IPA(L)\" }",
        )
        .replace("fluid = \"n2o\"", "fluid = \"N2O(L)\"")
        .replace("fluid = \"ethanol\"", "fluid = \"IPA(L)\"");
    std::fs::write(p.join("engines/native.rw.toml"), text).unwrap();
}

#[cfg(not(feature = "cea"))]
#[test]
fn custom_propellants_need_native_cea() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    native_engine(p.path());
    let (code, out) = rw(p.path(), &["--json", "engine", "design", "native"]);
    assert_eq!(code, 1, "{out}");
    let v = json(&out);
    assert!(v["performance"].is_null());
    assert!(
        v["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["code"] == "RW-E227"
                && d["message"].as_str().unwrap().contains("--features cea")),
        "{out}"
    );
}

#[cfg(feature = "cea")]
#[test]
fn custom_propellants_design_through_native_cea() {
    use rw_cea_sys::{BUILD_DATA_DIR, Cea, Exit, propellants};
    let p = TempProject::fixture("fixtures/research-vehicle");
    native_engine(p.path());
    let env = [("RW_CEA_DATA", BUILD_DATA_DIR)];
    let (code, out) = rw_at(
        None,
        p.path(),
        &["--json", "engine", "design", "native"],
        &env,
    );
    assert_eq!(code, 0, "{out}");
    let v = json(&out);
    assert_eq!(v["design"]["thermo"], "cea:native N2O(L)/IPA(L)");
    let s = &v["design"]["sizing"];
    // A direct rw-cea-sys call at the design point.
    let cea = Cea::init(BUILD_DATA_DIR).unwrap();
    let st = cea
        .rocket_iac(
            &propellants::ipa_l(),
            &propellants::n2o_l(),
            4.0,
            20.0,
            &Exit::supar(&[4.0]),
            None,
        )
        .unwrap();
    let rel = |a: f64, b: f64| (a - b).abs() / b.abs();
    assert!(
        rel(s["c_star"].as_f64().unwrap(), st.c_star[0]) < 1e-9,
        "{s}"
    );
    assert!(rel(s["cf_vac"].as_f64().unwrap(), st.isp_vac[2] / st.c_star[0]) < 1e-9);
    assert!(rel(s["chamber_temperature"].as_f64().unwrap(), st.t_k[0]) < 1e-9);
    // The blowdown ran on the CEA-filled grid.
    assert!(
        v["design"]["blowdown"]["burn_time"].as_f64().unwrap() > 1.0,
        "{out}"
    );
    // Same physics as the committed n2o-ipa table, within its interpolation.
    let table = std::fs::read_to_string(p.path().join("engines/native.rw.toml"))
        .unwrap()
        .replace("\"N2O(L)\"", "\"n2o\"")
        .replace("\"IPA(L)\"", "\"ipa\"");
    std::fs::write(p.path().join("engines/tabled.rw.toml"), table).unwrap();
    let (_, out2) = rw(p.path(), &["--json", "engine", "design", "tabled"]);
    let t = json(&out2);
    assert_eq!(t["design"]["thermo"], "table:n2o-ipa");
    let c_tab = t["design"]["sizing"]["c_star"].as_f64().unwrap();
    assert!(
        rel(c_tab, st.c_star[0]) < 5e-3,
        "{c_tab} vs {}",
        st.c_star[0]
    );

    // Relocated binary: bin/rocketwright + share/rocketwright/cea, no env.
    let reloc = TempProject::new();
    let bin = reloc.path().join("bin");
    let share = reloc.path().join("share/rocketwright/cea");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&share).unwrap();
    let exe = assert_cmd::cargo::cargo_bin("rocketwright");
    std::fs::copy(&exe, bin.join("rocketwright")).unwrap();
    for f in ["thermo.lib", "trans.lib"] {
        std::fs::copy(Path::new(BUILD_DATA_DIR).join(f), share.join(f)).unwrap();
    }
    let (code, out3) = rw_at(
        Some(&bin.join("rocketwright")),
        p.path(),
        &["--json", "engine", "design", "native"],
        &[],
    );
    assert_eq!(code, 0, "{out3}");
    assert_eq!(json(&out3)["design"]["sizing"], v["design"]["sizing"]);
}
