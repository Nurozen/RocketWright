//! M1.42b (CORE): B2 case 1 end to end through the `rw` binary.
//! `cargo test -p rw-cli --test parity_case1 -- --nocapture`.
//!
//! On a temp copy of `fixtures/case1`:
//!
//! 1. `rw check --json` gives the static block (`mass.cg`, `aero.cp`,
//!    `aero.cna`, `stability.liftoff`), scored against the golden `static`
//!    with `tests/oracle/tolerances.json`.
//! 2. `rw sim simulation_5` flies the fixture's own sim (RK4 at 0.05 s, the
//!    integrator the golden's `conditions` record, so the conditions hash
//!    matches), then `rw diff run <run> --golden
//!    tests/oracle/case1-generic.json` must report no setup mismatch, a row
//!    for every `keymap.json` key, and a pass for every key that
//!    `tolerances.json` lists for case 1 (with the same tolerance string).
//! 3. The same sim with the shipped default integrator (DP5(4)) is flown as
//!    `simulation_5_dp54`. Its diff against the golden lists exactly the
//!    expected setup mismatches (conditions hash, sim name) and is scored
//!    here against the same tolerances; `rw diff run <rk4> <dp54>` gives the
//!    integrator term (flagged above 0.5 % apogee).
//!
//! The test then writes the B2 run record `target/parity/ours/case1-generic.json`
//! (or `$RW_PARITY_OURS/…`) from the CLI outputs only (run manifest, summary,
//! check JSON), plus `case1-generic.series.csv` (the run's series) for
//! `scripts/bar/triage.ts`. `make bar-parity CASE=1` runs this test first
//! (`PRODUCERS` in `scripts/bar/parity.ts`).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use assert_cmd::Command;
use common::{TempProject, repo_root};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

const CLOCK: &str = "2026-10-16T12:00:00Z";
const GOLDEN: &str = "tests/oracle/case1-generic.json";
const CASE: u64 = 1;
const GATE_SIM: &str = "simulation_5";
const DP54_SIM: &str = "simulation_5_dp54";
/// Plan M1.42b: an RK4 vs DP5(4) apogee difference above this flags the integrator.
const INTEGRATOR_FLAG_PCT: f64 = 0.5;

fn rw(project: &Path) -> Command {
    let mut c = Command::cargo_bin("rocketwright").unwrap();
    c.env("RW_CLOCK", CLOCK)
        .env_remove("RW_TEST_HOOKS")
        .arg("--project")
        .arg(project)
        .current_dir(repo_root());
    c
}

/// Runs `rw <args> --json`, asserts the exit code, and parses stdout.
fn rw_json(project: &Path, args: &[&str], code: i32) -> Value {
    let o = rw(project).args(args).arg("--json").output().unwrap();
    let out = String::from_utf8_lossy(&o.stdout);
    assert_eq!(
        o.status.code(),
        Some(code),
        "rw {}: stdout {out} stderr {}",
        args.join(" "),
        String::from_utf8_lossy(&o.stderr)
    );
    serde_json::from_str(&out)
        .unwrap_or_else(|e| panic!("rw {}: not JSON ({e}): {out}", args.join(" ")))
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn oracle(name: &str) -> Value {
    read_json(&repo_root().join("tests/oracle").join(name))
}

/// `tolerances.json` entries for case 1: our key → tolerance string.
fn case_tolerances() -> BTreeMap<String, String> {
    let t = oracle("tolerances.json");
    let mut out = BTreeMap::new();
    for g in t["groups"].as_array().expect("tolerances groups") {
        if g["cases"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c.as_u64() == Some(CASE))
        {
            for (k, v) in g["tol"].as_object().unwrap() {
                out.insert(k.clone(), v.as_str().unwrap().to_string());
            }
        }
    }
    assert!(
        !out.is_empty(),
        "tolerances.json has no group for case {CASE}"
    );
    out
}

/// Scores `ours` against `golden` with a `tolerances.json` string
/// (`3%`, `0.3 s`, `1 mm`, `0.1 cal`); the same rule as `scripts/bar/parity.ts`.
fn within(tol: &str, ours: f64, golden: f64) -> bool {
    let s = tol.trim();
    let split = s
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(s.len());
    let n: f64 = s[..split]
        .trim()
        .parse()
        .unwrap_or_else(|_| panic!("bad tolerance {tol:?}"));
    let unit = s[split..].trim();
    let d = (ours - golden).abs();
    match unit {
        "%" => d <= n / 100.0 * golden.abs(),
        "mm" => d <= n * 1e-3 * (1.0 + 1e-12),
        "s" | "m" | "cal" | "m/s" | "m/s2" | "" => d <= n * (1.0 + 1e-12),
        u => panic!("bad tolerance unit {u:?} in {tol:?}"),
    }
}

/// A check-report value by metric path (`mass.cg`, `aero.cp`).
fn metric(report: &Value, path: &str) -> Option<f64> {
    path.split('.').try_fold(report, |v, k| v.get(k))?.as_f64()
}

fn rows_by_key(diff: &Value) -> BTreeMap<String, Value> {
    diff["rows"]
        .as_array()
        .expect("diff rows")
        .iter()
        .map(|r| (r["key"].as_str().unwrap().to_string(), r.clone()))
        .collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Adds `sims/simulation_5_dp54.rw.toml`: the gate sim with the shipped
/// default integrator (no `method`/`dt`, so DP5(4)) and its own name.
fn add_dp54_sim(project: &Path) {
    let src = std::fs::read_to_string(project.join("sims/simulation_5.rw.toml")).unwrap();
    let mut out = String::new();
    let mut in_integrator = false;
    for line in src.lines() {
        if line.starts_with('[') {
            in_integrator = line.trim() == "[integrator]";
            if in_integrator {
                continue;
            }
        }
        if in_integrator {
            continue;
        }
        if line.starts_with("name = ") {
            out.push_str("name = \"Simulation 5 (dp54)\"\n");
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    assert!(src.contains("method = \"rk4\""), "fixture sim is RK4");
    assert!(out.contains("Simulation 5 (dp54)") && !out.contains("rk4"));
    std::fs::write(project.join(format!("sims/{DP54_SIM}.rw.toml")), out).unwrap();
}

fn simulate(project: &Path, sim: &str) -> (String, PathBuf) {
    let s = rw_json(project, &["sim", sim], 0);
    assert_eq!(s["status"], "complete", "{s}");
    let run_id = s["run_id"].as_str().unwrap().to_string();
    let dir = project.join("runs").join(sim).join(&run_id);
    assert!(dir.join("manifest.json").is_file());
    (run_id, dir)
}

fn pct(ours: f64, golden: f64) -> f64 {
    100.0 * (ours / golden - 1.0)
}

#[test]
fn case1_cli_parity() {
    let golden = oracle("case1-generic.json");
    let keymap = oracle("keymap.json");
    let tols = case_tolerances();
    let p = TempProject::fixture("fixtures/case1");
    add_dp54_sim(&p.0);

    // ---- static block via `rw check` ----------------------------------------------
    let check = rw_json(&p.0, &["check"], 0);
    assert_eq!(
        check["config"], golden["config_id"],
        "default config is the golden's"
    );
    assert!(
        (metric(&check, "aero.mach").unwrap() - golden["static"]["mach"].as_f64().unwrap()).abs()
            < 1e-9,
        "check Mach is the golden's static Mach"
    );
    let static_keys = keymap["static"].as_object().unwrap();
    println!("case 1 static (rw check --json)");
    println!(
        "{:<20} {:>12} {:>12} {:>12} {:>8}",
        "key", "oracle", "ours", "delta", "tol"
    );
    for (or, ours) in static_keys {
        let ours = ours.as_str().unwrap();
        let g = golden["static"][or]
            .as_f64()
            .unwrap_or_else(|| panic!("golden static.{or}"));
        let v = metric(&check, ours).unwrap_or_else(|| panic!("check has no {ours}"));
        let tol = tols.get(ours);
        println!(
            "{ours:<20} {g:>12.6} {v:>12.6} {:>12.6} {:>8}",
            v - g,
            tol.map_or("-", String::as_str)
        );
        if let Some(t) = tol {
            assert!(
                within(t, v, g),
                "rw check {ours}: {v} vs golden {g} (tol {t})"
            );
        }
    }

    // ---- gate flight: `rw sim` + `rw diff run --golden` ---------------------------
    let (rk4_id, rk4_dir) = simulate(&p.0, GATE_SIM);
    let manifest = read_json(&rk4_dir.join("manifest.json"));
    assert_eq!(manifest["conditions"]["integrator"], "rk4");
    let diff = rw_json(&p.0, &["diff", "run", &rk4_id, "--golden", GOLDEN], 0);
    assert_eq!(diff["mismatches"], json!([]), "setup mismatch: {diff}");
    assert_eq!(diff["pass"], true, "{diff}");
    let rows = rows_by_key(&diff);
    let summary_keys = keymap["summary"].as_object().unwrap();
    for ours in summary_keys.values().chain(static_keys.values()) {
        let k = ours.as_str().unwrap();
        let r = rows
            .get(k)
            .unwrap_or_else(|| panic!("diff has no row {k}: {diff}"));
        assert!(r["a"].is_number() && r["b"].is_number(), "row {k}: {r}");
    }
    for (k, t) in &tols {
        let r = rows
            .get(k)
            .unwrap_or_else(|| panic!("diff has no row for toleranced key {k}"));
        assert_eq!(r["tol"].as_str(), Some(t.as_str()), "row {k} tolerance");
        assert_eq!(r["pass"], true, "row {k}: {r}");
        let (a, b) = (r["a"].as_f64().unwrap(), r["b"].as_f64().unwrap());
        assert!(within(t, a, b), "row {k} rescored: {a} vs {b} (tol {t})");
    }
    // The diff's static rows are the `rw check` numbers (check JSON is at
    // fixed significant figures, I8).
    for ours in static_keys.values() {
        let k = ours.as_str().unwrap();
        let (a, c) = (rows[k]["a"].as_f64().unwrap(), metric(&check, k).unwrap());
        assert!(
            (a - c).abs() <= 1e-5 * c.abs(),
            "{k}: diff {a} vs check {c}"
        );
    }

    // ---- integrator triage: the shipped default (DP5(4)) --------------------------
    let (dp_id, dp_dir) = simulate(&p.0, DP54_SIM);
    assert_eq!(
        read_json(&dp_dir.join("manifest.json"))["conditions"]["integrator"],
        "dp54"
    );
    let dp_diff = rw_json(&p.0, &["diff", "run", &dp_id, "--golden", GOLDEN], 1);
    let mism: Vec<&str> = dp_diff["mismatches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m.as_str().unwrap().split(':').next().unwrap())
        .collect();
    // The hash mismatch also names each differing condition (M2.11, B3 round 5).
    assert_eq!(
        mism,
        [
            "conditions_hash",
            "conditions.integrator",
            "conditions.time_step_s",
            "sim_name"
        ],
        "{dp_diff}"
    );
    let dp_rows = rows_by_key(&dp_diff);
    for (k, t) in &tols {
        let r = &dp_rows[k];
        let (a, b) = (r["a"].as_f64().unwrap(), r["b"].as_f64().unwrap());
        assert!(within(t, a, b), "dp54 {k}: {a} vs golden {b} (tol {t})");
    }
    let between = rw_json(&p.0, &["diff", "run", &rk4_id, &dp_id], 0);
    let apo = &rows_by_key(&between)["apogee_m"];
    let (apo_rk4, apo_dp) = (apo["a"].as_f64().unwrap(), apo["b"].as_f64().unwrap());
    let integrator_pct = pct(apo_rk4, apo_dp);
    let flagged = integrator_pct.abs() > INTEGRATOR_FLAG_PCT;

    println!("\ncase 1 flight (rw sim + rw diff run --golden)");
    println!(
        "{:<24} {:>11} {:>11} {:>9} {:>11} {:>9} {:>7}",
        "key", "oracle", "rk4 0.05 s", "delta", "dp54", "delta", "tol"
    );
    for ours in summary_keys.values() {
        let k = ours.as_str().unwrap();
        let (g, a) = (
            rows[k]["b"].as_f64().unwrap(),
            rows[k]["a"].as_f64().unwrap(),
        );
        let d = dp_rows[k]["a"].as_f64().unwrap();
        let fmt = |v: f64| {
            if k.ends_with("_s") {
                format!("{:+.3} s", v - g)
            } else {
                format!("{:+.2}%", pct(v, g))
            }
        };
        println!(
            "{k:<24} {g:>11.4} {a:>11.4} {:>9} {d:>11.4} {:>9} {:>7}",
            fmt(a),
            fmt(d),
            tols.get(k).map_or("-", String::as_str)
        );
    }
    println!(
        "integrator: rk4 vs dp54 apogee {integrator_pct:+.3}% ({})",
        if flagged {
            "FLAGGED, > 0.5%"
        } else {
            "within 0.5%, not flagged"
        }
    );

    // ---- the B2 run record, from CLI outputs only ---------------------------------
    let summary = read_json(&rk4_dir.join("summary.json"));
    let digests: Vec<rw_api::OracleMotor> = manifest["motors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| rw_api::OracleMotor {
            mount: m["mount"].as_str().unwrap().to_string(),
            designation: m["designation"].as_str().unwrap().to_string(),
            digest: m["sha256"].as_str().unwrap().to_string(),
            delay_s: None,
        })
        .collect();
    let geometry = std::fs::read(repo_root().join("tests/oracle/case1.geometry.json")).unwrap();
    let mut summary_rec = Map::new();
    for (k, v) in summary.as_object().unwrap() {
        if k != "schema" {
            summary_rec.insert(k.clone(), v.clone());
        }
    }
    let mut check_rec = Map::new();
    for k in [
        "mass.cg",
        "aero.cp",
        "aero.cna",
        "stability.liftoff",
        "mass.liftoff",
        "mass.burnout",
        "aero.cd",
        "aero.mach",
    ] {
        check_rec.insert(
            k.to_string(),
            metric(&check, k).map_or(Value::Null, |v| json!(v)),
        );
    }
    let rec = json!({
        "kind": "ours",
        "case": CASE,
        "matrix": "generic",
        "source": "cargo test -p rw-cli --test parity_case1 (rw check, rw sim, rw diff run --golden)",
        "sim_name": manifest["sim_name"],
        "config_id": manifest["config"],
        "run_id": rk4_id,
        "geometry_sha256": sha256_hex(&geometry),
        "conditions_hash": manifest["conditions_hash"],
        "motor_digest": rw_api::motor_digest(&digests),
        "summary": summary_rec,
        "check": check_rec,
        "series_csv": "case1-generic.series.csv",
        "integrator": {
            "gate": {"method": "rk4", "dt_s": manifest["conditions"]["time_step_s"], "apogee_m": apo_rk4},
            "alt": {"method": "dp54", "apogee_m": apo_dp},
            "apogee_delta_pct": integrator_pct,
            "flag_threshold_pct": INTEGRATOR_FLAG_PCT,
            "flagged": flagged,
        },
    });
    for f in [
        "sim_name",
        "config_id",
        "geometry_sha256",
        "conditions_hash",
        "motor_digest",
    ] {
        assert_eq!(rec[f], golden[f], "{f}: ours vs golden");
    }
    let dir = std::env::var_os("RW_PARITY_OURS")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root().join("target/parity/ours"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(
        rk4_dir.join("series.csv"),
        dir.join("case1-generic.series.csv"),
    )
    .unwrap();
    let path = dir.join("case1-generic.json");
    std::fs::write(&path, serde_json::to_string_pretty(&rec).unwrap() + "\n").unwrap();
    println!("\nwrote {} (+ case1-generic.series.csv)", path.display());
}
