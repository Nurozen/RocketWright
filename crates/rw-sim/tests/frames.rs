//! Signed-frame test of the 6DOF equations against RocketPy (M1.39c): the
//! reference below is a literal transcription of RocketPy's `Flight.u_dot`
//! (coast phase: no motor terms, no Coriolis) and
//! `AeroSurface.compute_forces_and_moments` for one lifting surface with
//! C_L = C_Nα α. For canned states it must give the same sign and magnitude
//! of body forces, body moments, accelerations, angular accelerations, and
//! Euler-parameter rates as `rw_sim::sixdof::loads` / `rhs` with the
//! `LinearAero` double.
//!
//! Ported from RocketPy (MIT) rocketpy/simulation/flight.py:Flight.u_dot and
//! rocketpy/rocket/aero_surface/aero_surface.py:AeroSurface.compute_forces_and_moments
//! (test oracle).

use rw_sim::doubles::{LinearAero, TimedMass};
use rw_sim::env::Environment;
use rw_sim::models::{Propulsion, Vehicle};
use rw_sim::sixdof::{self, State6};

/// Vehicle constants of the canned cases.
const MASS: f64 = 0.06;
const X_CG: f64 = 0.25;
const I11: f64 = 1.0e-3;
const I33: f64 = 1.0e-5;
const AREA: f64 = 4.9e-4;
const CN_ALPHA: f64 = 12.0;
const X_CP: f64 = 0.33;
const CD: f64 = 0.6;
/// Coast time (motor burnt out).
const T: f64 = 10.0;

struct RpOut {
    r: [f64; 3],
    m: [f64; 3],
    a: [f64; 3],
    alpha: [f64; 3],
    e_dot: [f64; 4],
}

/// RocketPy `u_dot` (coast) for state `u`, density `rho`, gravity `g`, no
/// wind; `cpz` = surface CP relative to the CDM along body axis 3.
/// `omega_r = false` drops the ω×r velocity at the CP (RocketPy's implicit
/// pitch damping, which we model with the Niskanen coefficient instead).
fn rocketpy_u_dot(u: &State6, rho: f64, g: f64, cpz: f64, omega_r: bool) -> RpOut {
    let (vx, vy, vz) = (u[3], u[4], u[5]);
    let (e0, e1, e2, e3) = (u[6], u[7], u[8], u[9]);
    let (omega1, omega2, omega3) = (u[10], u[11], u[12]);
    let (mut r1, mut r2, mut m1, mut m2, m3) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let a11 = 1.0 - 2.0 * (e2 * e2 + e3 * e3);
    let a12 = 2.0 * (e1 * e2 - e0 * e3);
    let a13 = 2.0 * (e1 * e3 + e0 * e2);
    let a21 = 2.0 * (e1 * e2 + e0 * e3);
    let a22 = 1.0 - 2.0 * (e1 * e1 + e3 * e3);
    let a23 = 2.0 * (e2 * e3 - e0 * e1);
    let a31 = 2.0 * (e1 * e3 - e0 * e2);
    let a32 = 2.0 * (e2 * e3 + e0 * e1);
    let a33 = 1.0 - 2.0 * (e1 * e1 + e2 * e2);
    let (wind_x, wind_y) = (0.0, 0.0);
    let fsv = [wind_x - vx, wind_y - vy, -vz];
    let fss = (fsv[0] * fsv[0] + fsv[1] * fsv[1] + fsv[2] * fsv[2]).sqrt();
    let mut r3 = -0.5 * rho * fss * fss * AREA * CD;
    let vx_b = a11 * vx + a21 * vy + a31 * vz;
    let vy_b = a12 * vx + a22 * vy + a32 * vz;
    let vz_b = a13 * vx + a23 * vy + a33 * vz;
    // comp_vb = velocity_in_body_frame + (w ^ comp_cp), comp_cp = (0, 0, cpz)
    let k = if omega_r { 1.0 } else { 0.0 };
    let comp_vb = [vx_b + k * omega2 * cpz, vy_b - k * omega1 * cpz, vz_b];
    // comp_wind_vb = Kt @ (wind_x, wind_y, 0)
    let comp_wind_vb = [
        a11 * wind_x + a21 * wind_y,
        a12 * wind_x + a22 * wind_y,
        a13 * wind_x + a23 * wind_y,
    ];
    let s = [
        comp_wind_vb[0] - comp_vb[0],
        comp_wind_vb[1] - comp_vb[1],
        comp_wind_vb[2] - comp_vb[2],
    ];
    let speed = (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt();
    if s[0] * s[0] + s[1] * s[1] != 0.0 {
        let stream_vzn = s[2] / speed;
        if -stream_vzn < 1.0 {
            let attack_angle = (-stream_vzn).acos();
            let c_lift = CN_ALPHA * attack_angle;
            let lift = 0.5 * rho * speed * speed * AREA * c_lift;
            let lift_dir_norm = (s[0] * s[0] + s[1] * s[1]).sqrt();
            let lift_xb = lift * (s[0] / lift_dir_norm);
            let lift_yb = lift * (s[1] / lift_dir_norm);
            r1 += lift_xb;
            r2 += lift_yb;
            m1 += -cpz * lift_yb;
            m2 += cpz * lift_xb;
        }
    }
    r3 += 0.0;
    let alpha1 = (m1 - (omega2 * omega3 * (I33 - I11))) / I11;
    let alpha2 = (m2 - (omega1 * omega3 * (I11 - I33))) / I11;
    let alpha3 = m3 / I33;
    let e0dot = 0.5 * (-omega1 * e1 - omega2 * e2 - omega3 * e3);
    let e1dot = 0.5 * (omega1 * e0 + omega3 * e2 - omega2 * e3);
    let e2dot = 0.5 * (omega2 * e0 - omega3 * e1 + omega1 * e3);
    let e3dot = 0.5 * (omega3 * e0 + omega2 * e1 - omega1 * e2);
    let l = [r1 / MASS, r2 / MASS, r3 / MASS];
    let a = [
        a11 * l[0] + a12 * l[1] + a13 * l[2],
        a21 * l[0] + a22 * l[1] + a23 * l[2],
        a31 * l[0] + a32 * l[1] + a33 * l[2] - g,
    ];
    RpOut {
        r: [r1, r2, r3],
        m: [m1, m2, m3],
        a,
        alpha: [alpha1, alpha2, alpha3],
        e_dot: [e0dot, e1dot, e2dot, e3dot],
    }
}

struct Rig {
    env: Environment,
    prop: Propulsion,
    mass: TimedMass,
}

fn rig() -> Rig {
    let c: rw_model::Conditions = serde_json::from_value(serde_json::json!({
        "rail_length_m": 1.0, "rod_angle_deg": 0.0, "rod_direction_deg": 0.0,
        "site_altitude_m": 0.0, "latitude_deg": 45.0, "longitude_deg": 0.0,
        "base_temperature_k": 288.15, "base_pressure_pa": 101325.0,
        "atmosphere": "ussa1976", "geodetic": "flat", "wind_speed_ms": 0.0,
        "wind_direction_deg": 0.0, "wind_turbulence": 0.0, "time_step_s": 0.01,
        "integrator": "dp54"
    }))
    .unwrap();
    let curve = rw_sim::doubles::sampled_curve(&[0.0, 1.0], &[5.0, 5.0]);
    Rig {
        env: Environment::from_conditions(&c),
        prop: Propulsion::new(&[rw_motor::MountedMotor {
            mount: "mmt".into(),
            curve,
            x_fore: 0.3,
            ignition_time: 0.0,
            delay: None,
            count: 1,
        }]),
        mass: TimedMass {
            t: vec![0.0],
            mass: vec![MASS],
            cg: vec![X_CG],
            ixx: vec![I33],
            iyy: vec![I11],
        },
    }
}

fn unit(e: [f64; 4]) -> [f64; 4] {
    let n = (e[0] * e[0] + e[1] * e[1] + e[2] * e[2] + e[3] * e[3]).sqrt();
    [e[0] / n, e[1] / n, e[2] / n, e[3] / n]
}

fn state(e: [f64; 4], v: [f64; 3], w: [f64; 3]) -> State6 {
    let e = unit(e);
    [
        0.0, 0.0, 100.0, v[0], v[1], v[2], e[0], e[1], e[2], e[3], w[0], w[1], w[2],
    ]
}

#[track_caller]
fn same(what: &str, ours: &[f64], rp: &[f64], scale: f64) {
    for (i, (a, b)) in ours.iter().zip(rp).enumerate() {
        assert!(
            (a - b).abs() <= 1e-10 * scale.max(1e-12),
            "{what}[{i}]: ours {a:.12e} vs rocketpy {b:.12e}"
        );
        if b.abs() > 1e-9 * scale {
            assert_eq!(a.signum(), b.signum(), "{what}[{i}] sign");
        }
    }
}

fn mag(v: &[f64]) -> f64 {
    v.iter().map(|x| x * x).sum::<f64>().sqrt()
}

#[test]
fn forces_and_moments_match_rocketpy() {
    let r = rig();
    let aero = LinearAero {
        cn_alpha: CN_ALPHA,
        cp: X_CP,
        cd: CD,
        ref_area: AREA,
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
    let rho = r.env.air(100.0).density;
    let g = r.env.g(100.0);
    let cpz = X_CG - X_CP;
    // Tilted attitudes with off-axis velocity, no rotation (RocketPy adds ω×r
    // at the CP; with ω = 0 the two models coincide term by term).
    for (e, v) in [
        ([0.95, 0.1, -0.2, 0.05], [3.0, -2.0, 40.0]),
        ([0.9, -0.3, 0.1, 0.2], [-5.0, 4.0, 25.0]),
        ([1.0, 0.0, 0.0, 0.0], [0.0, 6.0, 30.0]),
    ] {
        let y = state(e, v, [0.0; 3]);
        let l = sixdof::loads(&veh, T, None, &y);
        let rp = rocketpy_u_dot(&y, rho, g, cpz, true);
        let mut dy = [0.0; 13];
        sixdof::rhs(&veh, T, None, &y, &mut dy);
        same("force", &l.force_body, &rp.r, mag(&rp.r));
        same("moment", &l.moment_body, &rp.m, mag(&rp.m));
        same("accel", &l.accel, &rp.a, mag(&rp.a));
        same("alpha_dot", &l.alpha_dot, &rp.alpha, mag(&rp.alpha));
        same("e_dot", &dy[6..10], &rp.e_dot, 1.0);
        // Statically stable: the moment turns the nose into the relative
        // wind, i.e. it reduces the angle of attack.
        let k = sixdof::rotation([y[6], y[7], y[8], y[9]]);
        let vb = sixdof::to_body(&k, v);
        let dalpha = -(l.moment_body[1] * vb[0] - l.moment_body[0] * vb[1]);
        assert!(dalpha < 0.0, "restoring moment sign");
    }
}

#[test]
fn rotation_terms_match_rocketpy() {
    // No airspeed: only the gyroscopic coupling and the kinematics remain.
    let r = rig();
    let aero = LinearAero {
        cn_alpha: CN_ALPHA,
        cp: X_CP,
        cd: CD,
        ref_area: AREA,
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
    let (rho, g) = (r.env.air(100.0).density, r.env.g(100.0));
    let y = state([0.8, 0.2, -0.4, 0.3], [0.0; 3], [1.5, -0.7, 12.0]);
    let l = sixdof::loads(&veh, T, None, &y);
    let rp = rocketpy_u_dot(&y, rho, g, X_CG - X_CP, false);
    let mut dy = [0.0; 13];
    sixdof::rhs(&veh, T, None, &y, &mut dy);
    same("alpha_dot", &l.alpha_dot, &rp.alpha, mag(&rp.alpha));
    same("e_dot", &dy[6..10], &rp.e_dot, mag(&rp.e_dot));
    same("accel", &l.accel, &rp.a, g);
}

#[test]
fn pitch_damping_sign_matches_rocketpy() {
    // RocketPy damps pitch through the ω×r velocity at the CP; we use the
    // Niskanen damping coefficient. Both must oppose the transverse rate.
    let r = rig();
    let aero = LinearAero {
        cn_alpha: CN_ALPHA,
        cp: X_CP,
        cd: CD,
        ref_area: AREA,
        cm_damping_per_rate2: 2.0,
        cl_forcing: 0.0,
        cl_damping_per_rate: 0.0,
    };
    let veh = Vehicle {
        env: &r.env,
        aero: &aero,
        mass: &r.mass,
        propulsion: &r.prop,
    };
    let (rho, g) = (r.env.air(100.0).density, r.env.g(100.0));
    let e = [0.97, 0.05, -0.1, 0.0];
    let v = [1.0, -1.0, 40.0];
    for w in [[2.0, 0.0, 0.0], [0.0, -3.0, 0.0], [1.0, 1.5, 0.0]] {
        let y0 = state(e, v, [0.0; 3]);
        let y1 = state(e, v, w);
        let ours = {
            let (a, b) = (
                sixdof::loads(&veh, T, None, &y1).moment_body,
                sixdof::loads(&veh, T, None, &y0).moment_body,
            );
            [a[0] - b[0], a[1] - b[1]]
        };
        let rp = {
            let (a, b) = (
                rocketpy_u_dot(&y1, rho, g, X_CG - X_CP, true).m,
                rocketpy_u_dot(&y0, rho, g, X_CG - X_CP, true).m,
            );
            [a[0] - b[0], a[1] - b[1]]
        };
        let dot = |m: [f64; 2]| m[0] * w[0] + m[1] * w[1];
        assert!(dot(ours) < 0.0, "ours does not damp {w:?}: {ours:?}");
        assert!(dot(rp) < 0.0, "rocketpy does not damp {w:?}: {rp:?}");
        for i in 0..2 {
            if w[i] != 0.0 {
                assert_eq!(ours[i].signum(), rp[i].signum(), "{w:?} axis {i}");
            }
        }
    }
}
