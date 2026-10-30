//! Six-degree-of-freedom rigid body with variable mass and inertia (R4.5).
//!
//! State `[x, y, z, vx, vy, vz, e0, e1, e2, e3, ω1, ω2, ω3]`: position and
//! ground velocity in the launch-site ENU frame, the Euler parameters
//! (unit quaternion) of the body attitude, and the body angular rates.
//!
//! Body frame (the RocketPy convention, so the equations port directly):
//! axis 3 runs along the rocket axis toward the nose, axes 1 and 2 are
//! transverse. A station `x` (from the nose tip, positive aft) sits at body
//! coordinate `z_b = x_cg - x`. `K(e)` maps body to world, and the
//! quaternion kinematics, the Euler rotational equations with time-varying
//! inertia, and the per-surface lift force/moment follow
//! `rocketpy/simulation/flight.py:Flight.u_dot` and
//! `rocketpy/rocket/aero_surface/aero_surface.py:AeroSurface.compute_forces_and_moments`.
//!
//! Ported from RocketPy (MIT) rocketpy/simulation/flight.py:Flight.u_dot
//! (structure and signs; the aerodynamic coefficients come from our IF5
//! models: normal force C_N(α) at the CP, axial drag, Niskanen pitch damping
//! and roll forcing/damping via `AeroModel::eval_with_cg`).
//!
//! Loads, in body axes:
//! - thrust `F_T` along +3;
//! - axial drag `-sign(v_3) q A_ref C_D(α')` along 3, with α' the angle of
//!   attack folded into [0, 90°] (tail-first flight after apogee sees the
//!   same drag, opposing the motion);
//! - normal force `q A_ref C_N(α')` opposing the lateral air-relative
//!   velocity, applied at the CP: moment `r_cp × F` with `r_cp = (0, 0,
//!   x_cg - x_cp)`;
//! - pitch damping `-q A_ref d C_m,damp ω̂_⊥` and roll `q A_ref d (C_l,f -
//!   sign(ω3) C_l,damp)` (the coefficients are magnitudes, rw-aero
//!   `damping.rs`);
//! - jet damping `ṁ l_n² ω_⊥` (ṁ < 0 while burning, l_n the nozzle arm,
//!   literature-map MM-15) and the inertia-rate term `-İ ω`.

use rw_aero::AeroState;

use crate::models::{Vehicle, norm};

/// 6DOF state (see the module docs).
pub type State6 = [f64; 13];

/// Gain (1/s) of the constraint term that pulls the quaternion back to unit
/// norm: `ė += -λ (|e|² - 1) e`. Keeps the integrated norm drift bounded.
pub const QUAT_NORM_GAIN: f64 = 10.0;

/// Below this airspeed (m/s) no aerodynamic force or moment is applied.
pub const AERO_MIN_SPEED: f64 = 1e-9;

/// Step (s) of the central difference for ṁ and İ.
const RATE_DT: f64 = 1e-5;

/// Body→world rotation matrix `K` of the Euler parameters `e` (normalized
/// first), row-major.
///
/// Ported from RocketPy (MIT) rocketpy/simulation/flight.py:Flight.u_dot
pub fn rotation(e: [f64; 4]) -> [[f64; 3]; 3] {
    let n = (e[0] * e[0] + e[1] * e[1] + e[2] * e[2] + e[3] * e[3]).sqrt();
    let [e0, e1, e2, e3] = if n > 0.0 {
        [e[0] / n, e[1] / n, e[2] / n, e[3] / n]
    } else {
        [1.0, 0.0, 0.0, 0.0]
    };
    [
        [
            1.0 - 2.0 * (e2 * e2 + e3 * e3),
            2.0 * (e1 * e2 - e0 * e3),
            2.0 * (e1 * e3 + e0 * e2),
        ],
        [
            2.0 * (e1 * e2 + e0 * e3),
            1.0 - 2.0 * (e1 * e1 + e3 * e3),
            2.0 * (e2 * e3 - e0 * e1),
        ],
        [
            2.0 * (e1 * e3 - e0 * e2),
            2.0 * (e2 * e3 + e0 * e1),
            1.0 - 2.0 * (e1 * e1 + e2 * e2),
        ],
    ]
}

/// `K v` (body → world).
///
/// cite: n/a matrix-vector product
pub fn to_world(k: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        k[0][0] * v[0] + k[0][1] * v[1] + k[0][2] * v[2],
        k[1][0] * v[0] + k[1][1] * v[1] + k[1][2] * v[2],
        k[2][0] * v[0] + k[2][1] * v[1] + k[2][2] * v[2],
    ]
}

/// `Kᵀ v` (world → body).
///
/// cite: n/a matrix-vector product
pub fn to_body(k: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        k[0][0] * v[0] + k[1][0] * v[1] + k[2][0] * v[2],
        k[0][1] * v[0] + k[1][1] * v[1] + k[2][1] * v[2],
        k[0][2] * v[0] + k[1][2] * v[1] + k[2][2] * v[2],
    ]
}

/// Euler parameters of the shortest rotation taking body axis 3 onto the
/// unit vector `axis` (world), with no roll about it.
///
/// cite: n/a axis-angle to quaternion, no physics
pub fn attitude_along(axis: [f64; 3]) -> [f64; 4] {
    let n = norm(axis);
    if n <= 0.0 {
        return [1.0, 0.0, 0.0, 0.0];
    }
    let a = [axis[0] / n, axis[1] / n, axis[2] / n];
    // Rotation axis ẑ × a, angle acos(a_z).
    let c = a[2].clamp(-1.0, 1.0);
    let (rx, ry) = (-a[1], a[0]);
    let s = (rx * rx + ry * ry).sqrt();
    if s < 1e-15 {
        return if c > 0.0 {
            [1.0, 0.0, 0.0, 0.0]
        } else {
            [0.0, 1.0, 0.0, 0.0]
        };
    }
    let half = 0.5 * c.acos();
    let k = half.sin() / s;
    [half.cos(), rx * k, ry * k, 0.0]
}

/// Euler-parameter rates `ė = ½ Ω(ω) e` for body rates `w`, plus the
/// norm-constraint term (gain [`QUAT_NORM_GAIN`]).
///
/// Ported from RocketPy (MIT) rocketpy/simulation/flight.py:Flight.u_dot
pub fn quat_rate(e: [f64; 4], w: [f64; 3]) -> [f64; 4] {
    let [e0, e1, e2, e3] = e;
    let [w1, w2, w3] = w;
    let k = -QUAT_NORM_GAIN * (e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3 - 1.0);
    [
        0.5 * (-w1 * e1 - w2 * e2 - w3 * e3) + k * e0,
        0.5 * (w1 * e0 + w3 * e2 - w2 * e3) + k * e1,
        0.5 * (w2 * e0 - w3 * e1 + w1 * e3) + k * e2,
        0.5 * (w3 * e0 + w2 * e1 - w1 * e2) + k * e3,
    ]
}

/// Angular acceleration from the Euler rotational equations of an
/// axisymmetric body with time-varying inertia, `I ω̇ = M - ω × (I ω) - İ ω`,
/// `I = diag(I_t, I_t, I_r)` about the CG. A non-positive inertia gives zero
/// angular acceleration about that axis.
///
/// Ported from RocketPy (MIT) rocketpy/simulation/flight.py:Flight.u_dot
pub fn angular_accel(
    m: [f64; 3],
    w: [f64; 3],
    it: f64,
    ir: f64,
    it_dot: f64,
    ir_dot: f64,
) -> [f64; 3] {
    let [w1, w2, w3] = w;
    let div = |num: f64, i: f64| if i > 0.0 { num / i } else { 0.0 };
    [
        div(m[0] - w2 * w3 * (ir - it) - it_dot * w1, it),
        div(m[1] - w1 * w3 * (it - ir) - it_dot * w2, it),
        div(m[2] - ir_dot * w3, ir),
    ]
}

/// Lift force and moment of one surface (or the whole vehicle) in body axes:
/// force `q A C_N` along the lateral components of the body-frame stream
/// velocity `stream = w - v` (so it opposes the lateral motion), applied at
/// body station `cp_z` (axis 3, positive toward the nose): moment
/// `(-cp_z F_2, cp_z F_1, 0)`.
///
/// Ported from RocketPy (MIT) rocketpy/rocket/aero_surface/aero_surface.py:AeroSurface.compute_forces_and_moments
pub fn lift_force_moment(stream: [f64; 3], q_area_cn: f64, cp_z: f64) -> ([f64; 3], [f64; 3]) {
    let lat = (stream[0] * stream[0] + stream[1] * stream[1]).sqrt();
    if lat <= 0.0 {
        return ([0.0; 3], [0.0; 3]);
    }
    let f = [
        q_area_cn * stream[0] / lat,
        q_area_cn * stream[1] / lat,
        0.0,
    ];
    (f, [-cp_z * f[1], cp_z * f[0], 0.0])
}

/// Everything the 6DOF right-hand side evaluates at one state, kept for the
/// output series.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Loads6 {
    /// Thrust plus aerodynamic force, body axes (N).
    pub force_body: [f64; 3],
    /// Moment about the CG, body axes (N m).
    pub moment_body: [f64; 3],
    /// Translational acceleration, world (m/s²), gravity included.
    pub accel: [f64; 3],
    /// Angular acceleration, body axes (rad/s²).
    pub alpha_dot: [f64; 3],
    /// Total angle of attack, 0..π (rad).
    pub aoa: f64,
    pub airspeed: f64,
    pub mach: f64,
    pub thrust: f64,
    pub mass: f64,
    /// CG and CP stations from the nose tip (m).
    pub cg: f64,
    pub cp: f64,
    pub cd: f64,
    pub cn: f64,
    /// Reference length (m) for calibers.
    pub ref_length: f64,
}

impl Loads6 {
    /// Static margin in calibers, (x_cp - x_cg) / d_ref.
    ///
    /// cite: niskanen-2009 sec 2.4 p 22
    pub fn stability_cal(&self) -> f64 {
        if self.ref_length > 0.0 {
            (self.cp - self.cg) / self.ref_length
        } else {
            0.0
        }
    }
}

/// Station of the aft end (nozzle exit) of the mounted motors, or `None`.
fn nozzle_station(veh: &Vehicle<'_>) -> Option<f64> {
    veh.propulsion
        .motors()
        .iter()
        .map(|m| m.x_fore + m.curve.length)
        .reduce(f64::max)
}

/// Forces, moments, and accelerations at time `t`, state `y` (`seg`: the
/// integration segment for one-sided thrust, `None` for the curve value).
///
/// Ported from RocketPy (MIT) rocketpy/simulation/flight.py:Flight.u_dot
pub fn loads(veh: &Vehicle<'_>, t: f64, seg: Option<(f64, f64)>, y: &State6) -> Loads6 {
    let pos_z = y[2];
    let v = [y[3], y[4], y[5]];
    let e = [y[6], y[7], y[8], y[9]];
    let w = [y[10], y[11], y[12]];
    let k = rotation(e);
    let air = veh.env.air(pos_z);
    let wind = veh.env.wind_at(pos_z);
    let v_rel = [v[0] - wind[0], v[1] - wind[1], v[2] - wind[2]];
    let vb = to_body(&k, v_rel);
    let speed = norm(vb);
    let lat = (vb[0] * vb[0] + vb[1] * vb[1]).sqrt();
    let aoa = lat.atan2(vb[2]);
    let aoa_fold = if aoa > core::f64::consts::FRAC_PI_2 {
        core::f64::consts::PI - aoa
    } else {
        aoa
    };
    let thrust = match seg {
        Some(s) => veh.propulsion.thrust_on(t, s),
        None => veh.propulsion.thrust(t),
    };
    let mp = veh.mass.at(t);
    let mach = speed / air.speed_of_sound;
    let w_lat = (w[0] * w[0] + w[1] * w[1]).sqrt();
    let c = veh.aero.eval_at(
        t,
        &AeroState {
            mach,
            speed,
            alpha: aoa_fold,
            roll_rate: w[2],
            pitch_rate: w_lat,
            kinematic_viscosity: air.kinematic_viscosity,
            thrusting: thrust > 0.0,
        },
        mp.cg,
    );
    let mut f = [0.0, 0.0, thrust];
    let mut m = [0.0; 3];
    if speed > AERO_MIN_SPEED {
        let qa = 0.5 * air.density * speed * speed * c.ref_area;
        if vb[2] != 0.0 {
            f[2] -= vb[2].signum() * qa * c.cd;
        }
        let stream = [-vb[0], -vb[1], -vb[2]];
        let (fl, ml) = lift_force_moment(stream, qa * c.cn, mp.cg - c.cp);
        for i in 0..3 {
            f[i] += fl[i];
            m[i] += ml[i];
        }
        let qad = qa * c.ref_length;
        if w_lat > 0.0 {
            m[0] -= qad * c.cm_damping.abs() * w[0] / w_lat;
            m[1] -= qad * c.cm_damping.abs() * w[1] / w_lat;
        }
        // The damping terms oppose the rate whatever sign rw-aero gives them.
        let roll_sign = if w[2] > 0.0 {
            1.0
        } else if w[2] < 0.0 {
            -1.0
        } else {
            0.0
        };
        m[2] += qad * (c.cl_forcing - roll_sign * c.cl_damping.abs());
    }
    // Variable mass: jet damping and the inertia-rate term (MM-15).
    let lo = seg.map_or(t - RATE_DT, |s| (t - RATE_DT).max(s.0));
    let hi = seg.map_or(t + RATE_DT, |s| (t + RATE_DT).min(s.1));
    let (mut m_dot, mut it_dot, mut ir_dot) = (0.0, 0.0, 0.0);
    if hi > lo {
        let (a, b) = (veh.mass.at(lo), veh.mass.at(hi));
        let h = hi - lo;
        m_dot = (b.mass - a.mass) / h;
        it_dot = (b.iyy - a.iyy) / h;
        ir_dot = (b.ixx - a.ixx) / h;
    }
    if let Some(xn) = nozzle_station(veh).filter(|_| m_dot < 0.0) {
        let ln = xn - mp.cg;
        m[0] += m_dot * ln * ln * w[0];
        m[1] += m_dot * ln * ln * w[1];
    }
    let alpha_dot = angular_accel(m, w, mp.iyy, mp.ixx, it_dot, ir_dot);
    let fw = to_world(&k, f);
    let g = veh.env.g(pos_z);
    let accel = if mp.mass > 0.0 {
        [fw[0] / mp.mass, fw[1] / mp.mass, fw[2] / mp.mass - g]
    } else {
        [0.0, 0.0, -g]
    };
    Loads6 {
        force_body: f,
        moment_body: m,
        accel,
        alpha_dot,
        aoa,
        airspeed: speed,
        mach,
        thrust,
        mass: mp.mass,
        cg: mp.cg,
        cp: c.cp,
        cd: c.cd,
        cn: c.cn,
        ref_length: c.ref_length,
    }
}

/// Right-hand side of the 6DOF state.
///
/// Ported from RocketPy (MIT) rocketpy/simulation/flight.py:Flight.u_dot
pub fn rhs(veh: &Vehicle<'_>, t: f64, seg: Option<(f64, f64)>, y: &State6, dy: &mut State6) {
    let l = loads(veh, t, seg, y);
    let qd = quat_rate([y[6], y[7], y[8], y[9]], [y[10], y[11], y[12]]);
    dy[0] = y[3];
    dy[1] = y[4];
    dy[2] = y[5];
    dy[3..6].copy_from_slice(&l.accel);
    dy[6..10].copy_from_slice(&qd);
    dy[10..13].copy_from_slice(&l.alpha_dot);
}

/// The 6DOF state leaving the rail at `pos`/`vel` (ENU): attitude along
/// `axis`, no rotation.
///
/// cite: n/a initial-state assembly, no physics
pub fn initial_state(pos: [f64; 3], vel: [f64; 3], axis: [f64; 3]) -> State6 {
    let e = attitude_along(axis);
    [
        pos[0], pos[1], pos[2], vel[0], vel[1], vel[2], e[0], e[1], e[2], e[3], 0.0, 0.0, 0.0,
    ]
}

/// Body axis 3 (the nose direction) in world coordinates.
///
/// cite: n/a frame transform
pub fn nose_axis(y: &State6) -> [f64; 3] {
    let k = rotation([y[6], y[7], y[8], y[9]]);
    [k[0][2], k[1][2], k[2][2]]
}

#[cfg(test)]
mod tests;
