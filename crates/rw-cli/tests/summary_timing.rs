//! B3 round 8: derived timing in run summaries, so agents never subtract
//! event times by hand. `cargo test -p rw-cli --test summary_timing` flies
//! `fixtures/case1` (7 s delay, charge after apogee) and the research
//! vehicle's baseline (2 s delay, charge before apogee) and checks
//! `summary.json`, `rw run summary --fields`, and `rw sim` text output.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::path::Path;

use assert_cmd::Command;
use common::*;
use serde_json::Value;

fn run(project: &Path, args: &[&str]) -> String {
    let o = Command::cargo_bin("rocketwright")
        .unwrap()
        .env("RW_CLOCK", "2026-10-16T12:00:00Z")
        .env_remove("RW_TEST_HOOKS")
        .env_remove("RW_RENDER")
        .arg("--project")
        .arg(project)
        .args(args)
        .current_dir(repo_root())
        .output()
        .unwrap();
    let out = String::from_utf8_lossy(&o.stdout).into_owned();
    assert_eq!(
        o.status.code(),
        Some(0),
        "rw {}: {out} {}",
        args.join(" "),
        String::from_utf8_lossy(&o.stderr)
    );
    out
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

/// Stored values keep 6 significant figures.
fn close(a: f64, b: f64) {
    assert!(
        (a - b).abs() <= 1e-5 * a.abs().max(b.abs()).max(1.0),
        "{a} vs {b}"
    );
}

/// Checks the derived fields of one run against its own events and config;
/// returns `(sim text, run summary --fields text)`.
fn check(project: &Path, sim: &str, chute: &str, mount: &str, delay: f64) -> (String, String) {
    let simh = run(project, &["sim", sim]);
    let v: Value = serde_json::from_str(&run(project, &["run", "summary", sim, "--json"])).unwrap();
    let s = &v["summary"];
    let ev = |kind: &str| {
        v["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["kind"] == kind)
            .unwrap_or_else(|| panic!("no {kind} event"))
            .clone()
    };
    let (apo, burn, dep, ej) = (
        ev("apogee"),
        ev("burnout"),
        ev("deployment"),
        ev("ejection"),
    );
    let t_apo = f(&s["time_to_apogee_s"]);
    close(f(&s["coast_time_s"]), f(&s["optimum_delay_s"]));
    close(f(&s["coast_time_s"]), t_apo - f(&burn["t"]));
    close(f(&s["burnout_time_s"]), f(&burn["t"]));

    let d = s["deployments"].as_array().unwrap();
    assert_eq!(d.len(), 1, "{s}");
    let d = &d[0];
    assert_eq!(d["source"], format!("rw:c/{chute}"));
    close(f(&d["t_s"]), f(&dep["t"]));
    close(f(&d["deploy_minus_apogee_s"]), f(&dep["t"]) - f(&apo["t"]));
    close(f(&d["deploy_altitude_m"]), f(&dep["altitude"]));
    close(f(&d["deploy_velocity_ms"]), f(&dep["velocity"]));
    close(f(&d["deploy_velocity_ms"]), f(&s["deployment_velocity_ms"]));

    let x = s["ejections"].as_array().unwrap();
    assert_eq!(x.len(), 1, "{s}");
    let x = &x[0];
    assert_eq!(x["source"], format!("rw:c/{mount}"));
    assert_eq!(ej["source"], format!("rw:c/{mount}"));
    close(f(&x["delay_s"]), delay);
    close(f(&x["t_s"]), f(&ej["t"]));
    close(f(&x["optimum_delay_s"]), f(&s["optimum_delay_s"]));
    close(
        f(&x["delay_minus_optimum_s"]),
        delay - f(&s["optimum_delay_s"]),
    );
    close(f(&x["delay_minus_optimum_s"]), f(&ej["t"]) - t_apo);

    for row in [
        "\n  burnout_time ",
        "\n  coast_time ",
        &format!("\n  deploy_minus_apogee ({chute}) "),
        &format!("\n  deploy_altitude ({chute}) "),
        &format!("\n  deploy_velocity ({chute}) "),
        &format!("\n  ejection_delay ({mount}) "),
        &format!("\n  delay_minus_optimum ({mount}) "),
    ] {
        assert!(simh.contains(row), "rw sim lacks {row:?}: {simh}");
    }
    let fields = run(
        project,
        &[
            "run",
            "summary",
            sim,
            "--fields",
            "deploy_minus_apogee,deploy_altitude,deploy_velocity,delay_minus_optimum,coast_time",
        ],
    );
    assert_eq!(fields.lines().count(), 6, "{fields}");
    let explained = run(project, &["run", "summary", "--fields", sim]);
    for m in [
        "deployment time minus apogee time (negative = before apogee)",
        "configured delay minus optimum delay",
        "apogee time minus the last burnout time",
        "altitude above the pad at deployment",
    ] {
        assert!(explained.contains(m), "{m}: {explained}");
    }
    (simh, fields)
}

#[test]
fn case1_charge_after_apogee() {
    let p = TempProject::fixture("fixtures/case1");
    let (simh, fields) = check(&p.0, "simulation_5", "chute", "mmt", 7.0);
    // 7 s delay against a ~6.1 s optimum: positive, printed with its sign.
    assert!(
        simh.contains(" s (after apogee)") && simh.contains("\n  deploy_minus_apogee (chute) +"),
        "{simh}"
    );
    assert!(fields.contains(" s (charge after apogee)"), "{fields}");
}

#[test]
fn research_vehicle_charge_before_apogee() {
    let p = TempProject::fixture("fixtures/research-vehicle");
    let (simh, fields) = check(&p.0, "baseline", "chute", "motor_casing", 2.0);
    // 2 s delay against a ~2.14 s optimum: negative.
    assert!(simh.contains(" s (before apogee)"), "{simh}");
    assert!(fields.contains(" s (charge before apogee)"), "{fields}");
    assert!(
        fields.contains("\n  delay_minus_optimum (motor_casing) -"),
        "{fields}"
    );
}
