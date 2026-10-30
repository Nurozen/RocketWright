//! M1.39b-p: 3DOF replay of oracle case 1. Thrust, mass, and C_D(t) are
//! injected from `tests/oracle/case1-generic.series.json` through IF5 doubles
//! (`rw_sim::doubles::{TimedCd, TimedMass, sampled_curve}`), so only our
//! integrator, rail, atmosphere, gravity, and equations of motion are under
//! test. RK4 at 0.05 s mirrors the golden's `conditions` block.
//!
//! Gate: altitude and vertical velocity within ±1 % of the oracle series at
//! every oracle row from rail exit to apogee (velocity against 1 % of its
//! peak, since it passes through 0 at apogee); rail-exit velocity ±2 %.
//! Run with `--nocapture` for the table (recorded in `docs/dev/parity-log.md`).

mod common;

use common::{Series, event, lerp, pct, summary};
use rw_sim::doubles::{TimedCd, TimedMass, sampled_curve};
use rw_sim::env::Environment;
use rw_sim::models::{Propulsion, Vehicle};
use rw_sim::phase::IntegratorChoice;
use rw_sim::threedof::{Options3Dof, simulate_3dof};
use rw_sim::{EventKind, FlightEvent};

/// The injected doubles and propulsion from the oracle series.
pub struct Replay {
    pub cd: TimedCd,
    pub mass: TimedMass,
    pub propulsion: Propulsion,
}

fn replay(s: &Series) -> Replay {
    let t = s.col("time_s");
    let burnout = event("burnout")["t_s"].as_f64().unwrap();
    let thrust = s.col("thrust_n");
    let (tb, fb): (Vec<f64>, Vec<f64>) = t
        .iter()
        .zip(&thrust)
        .filter(|(t, _)| **t <= burnout + 1e-12)
        .map(|(a, b)| (*a, *b))
        .unzip();
    let curve = sampled_curve(&tb, &fb);
    let motor = rw_motor::MountedMotor {
        mount: "mmt".into(),
        curve,
        x_fore: 0.0,
        ignition_time: 0.0,
        delay: Some(7.0),
        count: 1,
    };
    Replay {
        cd: TimedCd {
            t: t.clone(),
            cd: s.col("cd"),
            ref_area: s.col("reference_area_m2")[0],
        },
        mass: TimedMass {
            t,
            mass: s.col("mass_kg"),
            cg: s.col("cg_m"),
            ixx: s.col("inertia_rot_kgm2"),
            iyy: s.col("inertia_long_kgm2"),
        },
        propulsion: Propulsion::new(&[motor]),
    }
}

fn ev(events: &[FlightEvent], k: EventKind) -> &FlightEvent {
    events.iter().find(|e| e.kind == k).unwrap()
}

#[test]
fn replay_3dof_case1() {
    let s = Series::case1();
    let r = replay(&s);
    // The injected thrust is the oracle's sampling of our generic curve.
    let c6 = rw_motor::generic::generic_motor("RW_C6G").unwrap();
    let t_or = s.col("time_s");
    let worst_f = t_or
        .iter()
        .zip(s.col("thrust_n"))
        .filter(|(t, _)| **t < 1.6)
        .map(|(t, f)| (c6.thrust_at(*t) - f).abs())
        .fold(0.0, f64::max);
    let env = Environment::from_conditions(&common::conditions());
    let veh = Vehicle {
        env: &env,
        aero: &r.cd,
        mass: &r.mass,
        propulsion: &r.propulsion,
    };
    let opts = Options3Dof {
        integrator: IntegratorChoice::Rk4 { h: 0.05 },
        max_time: 60.0,
        sample_dt: 0.005,
        stop_at_apogee: true,
    };
    let fl = simulate_3dof(&veh, &opts, &mut |_| true).expect("flight");
    let ts: Vec<f64> = fl.samples.iter().map(|x| x.t).collect();
    let zs: Vec<f64> = fl.samples.iter().map(|x| x.pos[2]).collect();
    let vs: Vec<f64> = fl.samples.iter().map(|x| x.vel[2]).collect();

    let t_exit = ev(&fl.events, EventKind::RailExit).t;
    let t_apo_or = summary("time_to_apogee_s");
    let (alt_or, vz_or) = (s.col("altitude_m"), s.col("velocity_z_ms"));
    let v_peak = vz_or.iter().copied().fold(0.0, f64::max);
    let (mut worst_z, mut worst_v) = ((0.0f64, 0.0f64), (0.0f64, 0.0f64));
    println!(
        "{:>7} {:>10} {:>10} {:>8} {:>9} {:>9} {:>8}",
        "t", "alt or", "alt ours", "d %", "vz or", "vz ours", "d %pk"
    );
    for (i, &t) in t_or.iter().enumerate() {
        if t < t_exit || t > t_apo_or {
            continue;
        }
        let z = lerp(&ts, &zs, t);
        let v = lerp(&ts, &vs, t);
        let dz = pct(z, alt_or[i]);
        let dv = 100.0 * (v - vz_or[i]) / v_peak;
        if dz.abs() > worst_z.1.abs() {
            worst_z = (t, dz);
        }
        if dv.abs() > worst_v.1.abs() {
            worst_v = (t, dv);
        }
        if i % 10 == 0 {
            println!(
                "{t:>7.3} {:>10.4} {z:>10.4} {dz:>+8.3} {:>9.4} {v:>9.4} {dv:>+8.3}",
                alt_or[i], vz_or[i]
            );
        }
    }
    let exit_or = event("launch_rod_clearance");
    let (v_exit_or, t_exit_or) = (
        exit_or["velocity_ms"].as_f64().unwrap(),
        exit_or["t_s"].as_f64().unwrap(),
    );
    let exit = ev(&fl.events, EventKind::RailExit);
    let d_exit = pct(exit.velocity, v_exit_or);
    let apo = fl.summary.apogee_m;
    println!("injected thrust vs RW_C6G curve: max |dF| = {worst_f:.3e} N");
    println!(
        "rail exit: t {:.5} vs {t_exit_or:.5} s, v {:.4} vs {v_exit_or:.4} m/s ({d_exit:+.3}%)",
        exit.t, exit.velocity
    );
    println!(
        "apogee {apo:.3} vs {:.3} m ({:+.3}%), t_apogee {:.4} vs {t_apo_or:.4} s ({:+.4} s), vmax {:.4} vs {:.4} ({:+.3}%)",
        summary("max_altitude_m"),
        pct(apo, summary("max_altitude_m")),
        fl.summary.time_to_apogee_s,
        fl.summary.time_to_apogee_s - t_apo_or,
        fl.summary.max_velocity_ms,
        summary("max_velocity_ms"),
        pct(fl.summary.max_velocity_ms, summary("max_velocity_ms")),
    );
    println!(
        "worst altitude {:+.3}% at t {:.3}; worst vz {:+.3}% of peak at t {:.3}",
        worst_z.1, worst_z.0, worst_v.1, worst_v.0
    );
    assert!(worst_f < 1e-6, "series thrust is not the generic curve");
    assert!(d_exit.abs() <= 2.0, "rail-exit velocity {d_exit:+.3}%");
    assert!(
        worst_z.1.abs() <= 1.0,
        "altitude {:+.3}% at {}",
        worst_z.1,
        worst_z.0
    );
    assert!(
        worst_v.1.abs() <= 1.0,
        "vz {:+.3}% at {}",
        worst_v.1,
        worst_v.0
    );
}
