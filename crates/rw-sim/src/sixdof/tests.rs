//! `sixdof::` tests: frame helpers, torque-free precession (analytic, and
//! world angular momentum conserved), quaternion norm drift, 6DOF = 3DOF in
//! vertical flight, weathercocking signs.

use super::*;
use crate::EventKind;
use crate::doubles::{ConstantCd, LinearAero};
use crate::env::Environment;
use crate::env::tests::conditions;
use crate::flight::{FlightOptions, simulate_flight};
use crate::integrator::{Dp54Options, Stop};
use crate::models::MassEval;
use crate::models::tests::{constant_motor, mounted};
use crate::models::{PointMass, Propulsion};
use crate::phase::{IntegratorChoice, PhaseHooks, run_phase};
use crate::recovery::Recovery;
use crate::threedof::{Options3Dof, simulate_3dof};

fn dp54_tight() -> IntegratorChoice {
    IntegratorChoice::Dp54(Dp54Options {
        rtol: 1e-11,
        atol: 1e-12,
        ..Dp54Options::default()
    })
}

#[test]
fn rotation_and_attitude() {
    let id = rotation([1.0, 0.0, 0.0, 0.0]);
    assert_eq!(to_world(&id, [1.0, 2.0, 3.0]), [1.0, 2.0, 3.0]);
    for axis in [
        [0.0, 0.0, 1.0],
        [0.5, 0.0, 0.75f64.sqrt()],
        [0.3, -0.4, 0.5],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, -1.0],
    ] {
        let n = norm(axis);
        let e = attitude_along(axis);
        let k = rotation(e);
        let z = to_world(&k, [0.0, 0.0, 1.0]);
        for i in 0..3 {
            assert!((z[i] - axis[i] / n).abs() < 1e-14, "{axis:?} -> {z:?}");
        }
        // K is orthonormal: Kᵀ K v = v.
        let v = [0.3, -1.2, 2.0];
        let back = to_body(&k, to_world(&k, v));
        for i in 0..3 {
            assert!((back[i] - v[i]).abs() < 1e-14);
        }
    }
    // A body rate about axis 1 tips the nose (axis 3) toward -axis 2:
    // ż_b = ω × z_b = (ω, 0, 0) × (0, 0, 1) = (0, -ω, 0).
    let e = [1.0, 0.0, 0.0, 0.0];
    let ed = quat_rate(e, [1.0, 0.0, 0.0]);
    let h = 1e-6;
    let e1 = [
        e[0] + h * ed[0],
        e[1] + h * ed[1],
        e[2] + h * ed[2],
        e[3] + h * ed[3],
    ];
    let z = to_world(&rotation(e1), [0.0, 0.0, 1.0]);
    assert!(z[1] < 0.0 && (z[1] / h + 1.0).abs() < 1e-6, "{z:?}");
}

/// Rotational state `[e0..e3, ω1..ω3]` of a free axisymmetric body.
fn spin(it: f64, ir: f64, w0: [f64; 3], t_end: f64, choice: IntegratorChoice) -> [f64; 7] {
    let y0 = [1.0, 0.0, 0.0, 0.0, w0[0], w0[1], w0[2]];
    let mut f = |_seg: (f64, f64), _t: f64, y: &[f64; 7], dy: &mut [f64; 7]| {
        let w = [y[4], y[5], y[6]];
        let ed = quat_rate([y[0], y[1], y[2], y[3]], w);
        let wd = angular_accel([0.0; 3], w, it, ir, 0.0, 0.0);
        dy[..4].copy_from_slice(&ed);
        dy[4..].copy_from_slice(&wd);
    };
    let end = run_phase(
        choice,
        0.0,
        y0,
        t_end,
        &[],
        &mut f,
        &mut [],
        PhaseHooks {
            on_step: &mut |_| true,
            on_break: &mut |_, _| {},
        },
    )
    .unwrap();
    assert_eq!(end.stop, Stop::End);
    end.y
}

#[test]
fn torque_free_precession() {
    // Euler's equations for I = diag(I_t, I_t, I_r), M = 0: ω_3 constant and
    // (ω_1, ω_2) rotating at λ = (I_r - I_t)/I_t ω_3.
    let (it, ir) = (2.0e-3, 1.0e-4);
    let w0 = [0.5, 0.0, 20.0];
    let t = 1.7;
    let y = spin(it, ir, w0, t, dp54_tight());
    let lam = (ir - it) / it * w0[2];
    assert!((y[4] - w0[0] * (lam * t).cos()).abs() < 1e-8, "{y:?}");
    assert!((y[5] - w0[0] * (lam * t).sin()).abs() < 1e-8, "{y:?}");
    assert!((y[6] - w0[2]).abs() < 1e-12);
    // World angular momentum K (I ω) is conserved (frames consistent).
    let h0 = [it * w0[0], it * w0[1], ir * w0[2]];
    let h1 = to_world(
        &rotation([y[0], y[1], y[2], y[3]]),
        [it * y[4], it * y[5], ir * y[6]],
    );
    for i in 0..3 {
        assert!((h1[i] - h0[i]).abs() < 1e-9 * norm(h0), "{h0:?} {h1:?}");
    }
}

#[test]
fn quaternion_norm_drift_is_bounded() {
    // 100 s (10⁴ steps) of a fast, coning spin on fixed-step RK4 at 0.01 s
    // (h·|ω| = 0.4): the norm term keeps |e| within 1e-5 of 1.
    let y = spin(
        2.0e-3,
        1.0e-4,
        [3.0, -2.0, 40.0],
        100.0,
        IntegratorChoice::Rk4 { h: 0.01 },
    );
    let n = (y[0] * y[0] + y[1] * y[1] + y[2] * y[2] + y[3] * y[3]).sqrt();
    assert!((n - 1.0).abs() < 1e-5, "|e| = {n}");
}

struct Rig {
    env: Environment,
    prop: Propulsion,
    mass: crate::doubles::TimedMass,
}

/// A vehicle with constant inertia (I_t 1e-3, I_r 1e-5, CG at 0.25 m) on the
/// constant-thrust test motor; the conditions' rail and gravity.
fn rig(c: &rw_model::Conditions) -> Rig {
    let prop = Propulsion::new(&[mounted(constant_motor(10.0, 1.23, 0.012, 0.012), 0.0, 1)]);
    let pm = PointMass {
        dry_mass: 0.1,
        propulsion: prop.clone(),
    };
    let t: Vec<f64> = (0..=600).map(|i| i as f64 * 0.1).collect();
    let mass = crate::doubles::TimedMass {
        mass: t.iter().map(|&t| pm.at(t).mass).collect(),
        cg: vec![0.25; t.len()],
        ixx: vec![1e-5; t.len()],
        iyy: vec![1e-3; t.len()],
        t,
    };
    Rig {
        env: Environment::from_conditions(c),
        prop,
        mass,
    }
}

#[test]
fn vertical_6dof_matches_3dof() {
    let r = rig(&conditions());
    let aero = ConstantCd {
        cd: 0.5,
        ref_area: 4.9e-4,
    };
    let veh = Vehicle {
        env: &r.env,
        aero: &aero,
        mass: &r.mass,
        propulsion: &r.prop,
    };
    let six = simulate_flight(
        &veh,
        &Recovery::default(),
        &FlightOptions {
            integrator: dp54_tight(),
            max_time: 60.0,
            sample_dt: 0.01,
        },
        &mut |_| true,
    )
    .unwrap();
    let three = simulate_3dof(
        &veh,
        &Options3Dof {
            integrator: dp54_tight(),
            max_time: 60.0,
            sample_dt: 0.01,
            stop_at_apogee: false,
        },
        &mut |_| true,
    )
    .unwrap();
    let t = |evs: &[crate::FlightEvent], k| evs.iter().find(|e| e.kind == k).unwrap().clone();
    for k in [EventKind::RailExit, EventKind::Apogee, EventKind::Landing] {
        let (a, b) = (t(&six.events, k), t(&three.events, k));
        assert!((a.t - b.t).abs() < 1e-7, "{k:?} {} vs {}", a.t, b.t);
        assert!((a.altitude - b.altitude).abs() < 1e-6 * (1.0 + b.altitude.abs()));
        assert!((a.velocity - b.velocity).abs() < 1e-6 * (1.0 + b.velocity));
    }
}

/// Max |angle of attack| after rail exit for a crosswind launch, and the
/// nose x component 0.5 s after rail exit.
fn crosswind(cp: f64) -> (f64, f64, f64) {
    let mut c = conditions();
    c.wind_speed_ms = 4.0;
    c.wind_direction_deg = 270.0; // from the west, blowing east (+x)
    let r = rig(&c);
    let aero = LinearAero {
        cn_alpha: 10.0,
        cp,
        cd: 0.5,
        ref_area: 4.9e-4,
        cm_damping_per_rate2: 0.0,
        cl_forcing: 0.0,
        cl_damping_per_rate: 0.0,
    };
    let veh = Vehicle {
        env: &r.env,
        aero: &aero,
        mass: &r.mass,
        propulsion: &r.prop,
    };
    let f = simulate_flight(
        &veh,
        &Recovery::default(),
        &FlightOptions {
            integrator: IntegratorChoice::Dp54(Dp54Options::default()),
            max_time: 3.0,
            sample_dt: 0.01,
        },
        &mut |_| true,
    )
    .unwrap();
    let t_exit = f
        .events
        .iter()
        .find(|e| e.kind == EventKind::RailExit)
        .unwrap()
        .t;
    let early = f
        .samples
        .iter()
        .filter(|s| s.t > t_exit && s.t < t_exit + 0.05)
        .map(|s| s.aoa)
        .fold(0.0, f64::max);
    let late = f
        .samples
        .iter()
        .filter(|s| s.t > t_exit + 0.8 && s.t < 1.2)
        .map(|s| s.aoa)
        .fold(0.0, f64::max);
    let x = f
        .samples
        .iter()
        .find(|s| s.t >= t_exit + 0.5)
        .map(|s| s.vel[0])
        .unwrap();
    (early, late, x)
}

#[test]
fn weathercocking_signs() {
    // CP aft of the CG (0.25 m): the nose turns into the wind, so the
    // vehicle accelerates upwind (-x) and the angle of attack shrinks.
    let (early, late, vx) = crosswind(0.35);
    assert!(early > 0.05, "crosswind α at rail exit {early}");
    assert!(late < early, "stable α grows: {early} -> {late}");
    assert!(vx < 0.0, "stable rocket drifts downwind: vx {vx}");
    // CP ahead of the CG: unstable, the angle of attack grows.
    let (e2, l2, _) = crosswind(0.15);
    assert!(l2 > e2, "unstable α shrinks: {e2} -> {l2}");
}

/// Roll rate 1 s after rail exit for an initial spin `w3` (rad/s, given at
/// rail exit through the state), roll forcing `cl_f`, damping `k`.
fn roll_after(w3: f64, cl_f: f64, k: f64) -> f64 {
    let r = rig(&conditions());
    let aero = LinearAero {
        cn_alpha: 10.0,
        cp: 0.35,
        cd: 0.5,
        ref_area: 4.9e-4,
        cm_damping_per_rate2: 0.0,
        cl_forcing: cl_f,
        cl_damping_per_rate: k,
    };
    let veh = Vehicle {
        env: &r.env,
        aero: &aero,
        mass: &r.mass,
        propulsion: &r.prop,
    };
    let mut y = initial_state([0.0, 0.0, 1.0], [0.0, 0.0, 20.0], [0.0, 0.0, 1.0]);
    y[12] = w3;
    let end = run_phase(
        dp54_tight(),
        0.2,
        y,
        1.2,
        &[],
        &mut |seg, t, y: &State6, dy: &mut State6| rhs(&veh, t, Some(seg), y, dy),
        &mut [],
        PhaseHooks {
            on_step: &mut |_| true,
            on_break: &mut |_, _| {},
        },
    )
    .unwrap();
    end.y[12]
}

#[test]
fn roll_forcing_and_damping_signs() {
    // Damping slows a spin of either sign without reversing it.
    for w in [30.0, -30.0] {
        let after = roll_after(w, 0.0, 5.0);
        assert!(
            after.abs() < w.abs() && after.signum() == w.signum(),
            "{w} -> {after}"
        );
        assert_eq!(roll_after(w, 0.0, 0.0), w);
    }
    // Cant forcing spins the vehicle up in its own sign from rest.
    assert!(roll_after(0.0, 1e-3, 5.0) > 0.0);
    assert!(roll_after(0.0, -1e-3, 5.0) < 0.0);
}
