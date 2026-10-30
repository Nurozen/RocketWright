//! M1.39c-p: 6DOF replay of oracle case 1 with our physics end to end: the
//! model built from `tests/oracle/case1.geometry.json`, our aero
//! (`AeroModel`, damping via `eval_with_cg`), our mass (`MassModel` with the
//! RW_C6G motor), through `rw_sim::simulate` (rail → 6DOF → recovery).
//! RK4 at 0.05 s mirrors the golden's `conditions`; the production default
//! (DP5(4)) is reported beside it.
//!
//! Gate (spec B2, case 1): apogee ±3 %, max velocity ±3 %, time to apogee
//! ±0.3 s against the golden. Per-key deltas print with `--nocapture` and are
//! recorded in `docs/dev/parity-log.md`.

mod common;

use common::case1::Case1;
use common::{golden, pct};
use rw_model::IntegratorKind;
use rw_sim::outputs::{OR_SUMMARY_KEYS, summary_value};
use rw_sim::{SimResult, simulate};

fn run(case: &Case1, integrator: IntegratorKind) -> SimResult {
    let (aero, mass) = (case.aero(), case.mass());
    simulate(&case.input(integrator), &aero, &mass, &mut |_| true).expect("flight")
}

/// Prints every golden summary key beside ours; returns (apogee %, vmax %,
/// t_apogee delta s).
fn report(label: &str, r: &SimResult) -> (f64, f64, f64) {
    let g = golden();
    println!("{label}");
    println!(
        "{:<26} {:>12} {:>12} {:>10}",
        "key (ours)", "oracle", "ours", "delta"
    );
    for (or, ours) in OR_SUMMARY_KEYS {
        let o = g["summary"][*or].as_f64().unwrap();
        let v = summary_value(&r.summary, ours).unwrap_or(f64::NAN);
        let d = if ours.ends_with("_s") {
            format!("{:+.3} s", v - o)
        } else {
            format!("{:+.2}%", pct(v, o))
        };
        println!("{ours:<26} {o:>12.4} {v:>12.4} {d:>10}");
    }
    println!(
        "min stability {:.3} cal, burnout {:.3} s at {:.2} m",
        r.summary.min_stability_cal, r.summary.burnout_time_s, r.summary.burnout_altitude_m
    );
    let s = &r.summary;
    (
        pct(s.apogee_m, g["summary"]["max_altitude_m"].as_f64().unwrap()),
        pct(
            s.max_velocity_ms,
            g["summary"]["max_velocity_ms"].as_f64().unwrap(),
        ),
        s.time_to_apogee_s - g["summary"]["time_to_apogee_s"].as_f64().unwrap(),
    )
}

#[test]
fn replay_6dof_case1() {
    // Gate model: the oracle geometry; the parachute's shroud lines come from
    // its `line_*` fields (rw-mass weighs them with the canopy).
    let case = Case1::new();
    let rk4 = run(&case, IntegratorKind::Rk4);
    let (apo, vmax, tapo) = report("case 1, rk4 0.05 s (oracle conditions)", &rk4);
    let dp = run(&case, IntegratorKind::Dp54);
    let (apo_dp, vmax_dp, tapo_dp) = report("case 1, dp54 (production default)", &dp);
    println!(
        "integrator: rk4 vs dp54 apogee {:+.3}%",
        pct(rk4.summary.apogee_m, dp.summary.apogee_m)
    );
    println!(
        "summary: rk4 apogee {apo:+.2}% vmax {vmax:+.2}% t_apo {tapo:+.3} s; dp54 apogee {apo_dp:+.2}% vmax {vmax_dp:+.2}% t_apo {tapo_dp:+.3} s"
    );
    for (label, a, v, t) in [("rk4", apo, vmax, tapo), ("dp54", apo_dp, vmax_dp, tapo_dp)] {
        assert!(a.abs() <= 3.0, "{label} apogee {a:+.2}%");
        assert!(v.abs() <= 3.0, "{label} max velocity {v:+.2}%");
        assert!(t.abs() <= 0.3, "{label} time to apogee {t:+.3} s");
    }
    // The vehicle flies the whole sequence and lands.
    assert!(rk4.summary.flight_time_s > rk4.summary.time_to_apogee_s);
    assert!(rk4.summary.landing_velocity_ms > 0.0);
}
