//! M1.39d-p: recovery replay of oracle case 1 (RW_C6G-7, parachute at
//! ejection). Two runs:
//!
//! 1. **Injected ascent**: thrust, mass, and C_D(t) from
//!    `tests/oracle/case1-generic.series.json` (IF5 doubles), so the ascent
//!    matches the oracle and only our event sequencing and recovery model
//!    (`rw_sim::recovery`: parachute C_D·A, point-mass descent) are under
//!    test. This run is the gate.
//! 2. **Our physics end to end** (`rw_sim::simulate` on the case-1 model,
//!    shroud lines from the parachute's `line_*` fields): reported.
//!
//! `tests/oracle/tolerances.json` has no descent keys (BAR owns it), so the
//! gate uses the B2 group's 3 % for velocities and flight time, and 0.05 s
//! (one oracle step) for event times. RK4 at 0.05 s mirrors the golden.

mod common;

use common::case1::Case1;
use common::{Series, event, pct, summary};
use rw_model::IntegratorKind;
use rw_sim::doubles::{TimedCd, TimedMass, sampled_curve};
use rw_sim::env::Environment;
use rw_sim::flight::{FlightOptions, simulate_flight};
use rw_sim::models::{Propulsion, Vehicle};
use rw_sim::outputs::{or_event_name, summary as run_summary};
use rw_sim::phase::IntegratorChoice;
use rw_sim::recovery::Recovery;
use rw_sim::{EventKind, FlightEvent, simulate};

const TOL_PCT: f64 = 3.0;
const TOL_T: f64 = 0.05;

fn injected() -> (TimedCd, TimedMass, Propulsion) {
    let s = Series::case1();
    let t = s.col("time_s");
    let burnout = event("burnout")["t_s"].as_f64().unwrap();
    let (tb, fb): (Vec<f64>, Vec<f64>) = t
        .iter()
        .zip(s.col("thrust_n"))
        .filter(|(t, _)| **t <= burnout + 1e-12)
        .map(|(a, b)| (*a, b))
        .unzip();
    let motor = rw_motor::MountedMotor {
        mount: "mmt".into(),
        curve: sampled_curve(&tb, &fb),
        x_fore: 0.0,
        ignition_time: 0.0,
        delay: Some(7.0),
        count: 1,
    };
    (
        TimedCd {
            t: t.clone(),
            cd: s.col("cd"),
            ref_area: s.col("reference_area_m2")[0],
        },
        TimedMass {
            t,
            mass: s.col("mass_kg"),
            cg: s.col("cg_m"),
            ixx: s.col("inertia_rot_kgm2"),
            iyy: s.col("inertia_long_kgm2"),
        },
        Propulsion::new(&[motor]),
    )
}

/// Compares our events against the golden's; returns the worst time delta
/// over ejection, deployment, and landing.
fn compare_events(events: &[FlightEvent]) -> f64 {
    let mut worst: f64 = 0.0;
    println!(
        "{:<28} {:>9} {:>9} {:>9} {:>9}",
        "event", "t oracle", "t ours", "v oracle", "v ours"
    );
    for k in [
        EventKind::RailExit,
        EventKind::Burnout,
        EventKind::Apogee,
        EventKind::Ejection,
        EventKind::Deployment,
        EventKind::Landing,
    ] {
        let name = or_event_name(k).unwrap();
        let g = event(name);
        let ours = events.iter().find(|e| e.kind == k).expect("event");
        let (tg, vg) = (
            g["t_s"].as_f64().unwrap(),
            g["velocity_ms"].as_f64().unwrap(),
        );
        println!(
            "{name:<28} {tg:>9.4} {:>9.4} {vg:>9.4} {:>9.4}",
            ours.t, ours.velocity
        );
        if matches!(
            k,
            EventKind::Ejection | EventKind::Deployment | EventKind::Landing
        ) && k != EventKind::Landing
        {
            worst = worst.max((ours.t - tg).abs());
        }
    }
    worst
}

#[test]
fn replay_recovery_case1() {
    // ---- 1. injected ascent, our recovery -----------------------------------
    let case = Case1::new();
    let (cd, mass, prop) = injected();
    let env = Environment::from_conditions(&common::conditions());
    let veh = Vehicle {
        env: &env,
        aero: &cd,
        mass: &mass,
        propulsion: &prop,
    };
    let recovery = Recovery::from_model(&case.model, &case.config, &case.geometry);
    assert_eq!(recovery.devices.len(), 1);
    let opts = FlightOptions {
        integrator: IntegratorChoice::Rk4 { h: 0.05 },
        max_time: 300.0,
        sample_dt: 0.01,
    };
    let f = simulate_flight(&veh, &recovery, &opts, &mut |_| true).expect("flight");
    assert!(f.landed);
    let s = run_summary(&f);
    println!("injected ascent + our recovery (rk4 0.05 s)");
    let worst_t = compare_events(&f.events);
    let rows = [
        ("deployment_velocity_ms", s.deployment_velocity_ms.unwrap()),
        ("ground_hit_velocity_ms", s.landing_velocity_ms),
        ("flight_time_s", s.flight_time_s),
        ("max_altitude_m", s.apogee_m),
        ("time_to_apogee_s", s.time_to_apogee_s),
    ];
    let mut worst_pct: f64 = 0.0;
    for (k, v) in rows {
        let o = summary(k);
        let d = pct(v, o);
        println!("{k:<26} {o:>10.4} {v:>10.4} {d:>+8.3}%");
        if k != "max_altitude_m" && k != "time_to_apogee_s" {
            worst_pct = worst_pct.max(d.abs());
        }
    }
    // Event ordering: ... apogee < ejection <= deployment < landing.
    let t_of = |k| f.events.iter().find(|e| e.kind == k).unwrap().t;
    assert!(t_of(EventKind::Apogee) < t_of(EventKind::Ejection));
    assert!(t_of(EventKind::Ejection) <= t_of(EventKind::Deployment));
    assert!(t_of(EventKind::Deployment) < t_of(EventKind::Landing));
    assert!(!f.events.iter().any(|e| e.kind == EventKind::Tumble));

    // ---- 2. our physics end to end -------------------------------------------
    let (aero, mm) = (case.aero(), case.mass());
    let full =
        simulate(&case.input(IntegratorKind::Rk4), &aero, &mm, &mut |_| true).expect("flight");
    println!("our physics end to end (case 1, rk4 0.05 s)");
    compare_events(&full.events);
    for (k, v) in [
        (
            "deployment_velocity_ms",
            full.summary.deployment_velocity_ms.unwrap(),
        ),
        ("ground_hit_velocity_ms", full.summary.landing_velocity_ms),
        ("flight_time_s", full.summary.flight_time_s),
    ] {
        let o = summary(k);
        println!("{k:<26} {o:>10.4} {v:>10.4} {:>+8.3}%", pct(v, o));
    }

    assert!(worst_t <= TOL_T, "event time off by {worst_t:.4} s");
    assert!(worst_pct <= TOL_PCT, "descent key off by {worst_pct:.3}%");
}
