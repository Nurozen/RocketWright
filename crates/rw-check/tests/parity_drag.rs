//! PARITY-drag diagnostic (report mode): zero-α C_D (and, in
//! `cp_report_cases_1_to_7`, C_Nα and CP per component) of `fixtures/case<n>`
//! against `tests/oracle/case<n>.aero_sweep.json`, total and per term, at
//! sea level (USSA 1976 speed of sound and kinematic viscosity, as the
//! oracle sweep). Run with `--nocapture`; the numbers are logged in
//! `docs/dev/parity-log.md` (PARITY-drag). The assertions are sanity bounds
//! only, so a model change shows here before it shows in flight.
//!
//! Reading the oracle rows: its per-component rows are **per instance** (one
//! fin, one tube, one rail button), while its totals count every instance.
//! Our terms are per component set. Compare totals, or multiply the oracle
//! row by the instance count.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};

use rw_aero::{AeroModel, AeroOptions, AeroState, DragKind};
use rw_project::{Session, SessionOptions};
use serde_json::Value;

/// Sea-level speed of sound and kinematic viscosity (USSA 1976).
const A0: f64 = 340.294;
const NU0: f64 = 1.4607e-5;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn sweep(case: u32) -> Value {
    let p = root().join(format!("tests/oracle/case{case}.aero_sweep.json"));
    serde_json::from_str(&std::fs::read_to_string(p).expect("aero sweep")).expect("json")
}

fn model(case: u32) -> AeroModel {
    let s = Session::open(
        &root().join(format!("fixtures/case{case}")),
        SessionOptions::read_only(),
    )
    .expect("open fixture");
    let m = s.model().clone();
    AeroModel::new(&m, &rw_geom::build(&m), &AeroOptions::default())
}

fn state(mach: f64) -> AeroState {
    AeroState {
        mach,
        speed: mach * A0,
        alpha: 0.0,
        roll_rate: 0.0,
        pitch_rate: 0.0,
        kinematic_viscosity: NU0,
        thrusting: false,
    }
}

/// Per-case report: totals across the sweep and terms at M 0.3. Returns the
/// worst relative C_D delta over M ≤ 0.6.
fn report(case: u32) -> f64 {
    let am = model(case);
    let sw = sweep(case);
    let mut worst: f64 = 0.0;
    for p in sw["points"].as_array().unwrap() {
        let mach = p["mach"].as_f64().unwrap();
        if mach > 0.6 + 1e-9 {
            continue;
        }
        let terms = am.drag_terms(&state(mach));
        let sum = |k: DragKind| -> f64 { terms.iter().filter(|t| t.kind == k).map(|t| t.cd).sum() };
        let total: f64 = terms.iter().map(|t| t.cd).sum();
        let or = p["cd_total"].as_f64().unwrap();
        worst = worst.max((total / or - 1.0).abs());
        println!(
            "case {case} M {mach:.2}: CD {total:.4} vs {or:.4} ({:+.2}%) | fric {:.4} vs {:.4} | \
             press+par {:.4} vs {:.4} | base {:.4} vs {:.4}",
            100.0 * (total / or - 1.0),
            sum(DragKind::Friction),
            p["cd_friction"].as_f64().unwrap(),
            sum(DragKind::Pressure) + sum(DragKind::Parasitic),
            p["cd_pressure"].as_f64().unwrap(),
            sum(DragKind::Base),
            p["cd_base"].as_f64().unwrap(),
        );
        if (mach - 0.3).abs() < 1e-9 {
            for t in &terms {
                println!(
                    "  case {case} M 0.30 term {:<24} {:?} {:.5} ({})",
                    t.id, t.kind, t.cd, t.model
                );
            }
            for c in p["components"].as_array().unwrap() {
                println!(
                    "  case {case} M 0.30 oracle {:<24} f {:.5} p {:.5} b {:.5}",
                    c["name"].as_str().unwrap_or(""),
                    c["cd_friction"].as_f64().unwrap_or(0.0),
                    c["cd_pressure"].as_f64().unwrap_or(0.0),
                    c["cd_base"].as_f64().unwrap_or(0.0)
                );
            }
        }
    }
    worst
}

#[test]
fn drag_report_cases_1_to_7() {
    for case in 1..=7 {
        let worst = report(case);
        println!(
            "case {case}: worst |ΔCD| over M ≤ 0.6 = {:.2}%",
            100.0 * worst
        );
        // Sanity bound only (report mode): no case is off by more than 15 %.
        assert!(worst < 0.15, "case {case} C_D off by {:.1}%", 100.0 * worst);
    }
}

/// Zero-α C_Nα and CP per component at M 0.3 (the static Mach) against the
/// oracle sweep rows. Unlike its drag rows, the oracle's C_Nα rows are per
/// component set (they sum to its total). Returns ours − oracle total CP (m).
fn cp_report(case: u32) -> f64 {
    let am = model(case);
    let sw = sweep(case);
    let p = sw["points"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| (p["mach"].as_f64().unwrap() - 0.3).abs() < 1e-9)
        .expect("M 0.3 point");
    let ours = am.eval(&state(0.3));
    for c in &ours.components {
        println!(
            "  case {case} M 0.30 lift ours   {:<24} cna {:.5} cp {:.5}",
            c.id, c.cn_alpha, c.cp
        );
    }
    for c in p["components"].as_array().unwrap() {
        if let (Some(cna), Some(cp)) = (c["cna"].as_f64(), c["cp_m"].as_f64()) {
            println!(
                "  case {case} M 0.30 lift oracle {:<24} cna {cna:.5} cp {cp:.5}",
                c["name"].as_str().unwrap_or("")
            );
        }
    }
    let (or_cna, or_cp) = (p["cna"].as_f64().unwrap(), p["cp_m"].as_f64().unwrap());
    println!(
        "case {case} M 0.30: CNa {:.4} vs {or_cna:.4} | CP {:.5} vs {or_cp:.5} ({:+.2} mm)",
        ours.cn_alpha,
        ours.cp,
        1e3 * (ours.cp - or_cp)
    );
    ours.cp - or_cp
}

#[test]
fn cp_report_cases_1_to_7() {
    for case in 1..=7 {
        let d = cp_report(case);
        // Sanity bound only (report mode).
        assert!(d.abs() < 0.05, "case {case} CP off by {:.1} mm", 1e3 * d);
    }
}
