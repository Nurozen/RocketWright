//! Motor mass, CG, and inertia over the burn, from the rw-motor curve.
//!
//! - Mass: `ThrustCurve::mass_at` (MM-05/MM-06: m = dry + prop·(1 − I(t)/I_tot),
//!   or the `.rse` per-sample mass), held at the loaded mass before ignition.
//! - CG: the motor's fore-end station plus `ThrustCurve::cg_at` (MM-07).
//! - Inertia: the motor as a solid cylinder of its diameter and length with
//!   the current mass (MM-09 applied to the whole motor).

use rw_motor::MountedMotor;

use crate::body::RigidBody;

/// One motor (not the cluster) at time `t` after launch, on the body axis.
// Ported from RocketPy (MIT) rocketpy/motors/motor.py:GenericMotor.propellant_I_11 (MM-09)
/// cite: mil-hdbk-762 eq 7-28 p 566
pub fn single_motor(m: &MountedMotor, t: f64) -> RigidBody {
    let tau = t - m.ignition_time;
    let c = &m.curve;
    let mass = c.mass_at(tau);
    let x = m.x_fore + c.cg_at(tau);
    let r = 0.5 * c.diameter;
    let l = c.length;
    let ixx = mass * r * r / 2.0;
    let iyy = mass * (3.0 * r * r + l * l) / 12.0;
    RigidBody::axisymmetric(mass, [x, 0.0, 0.0], ixx, iyy)
}

/// All `count` motors of a mount at time `t`. When the mount has exactly
/// `count` instance offsets the motors sit on them (y, z); otherwise all on
/// the axis.
/// cite: mil-hdbk-762 eq 7-22 p 564
pub fn mounted_motors(m: &MountedMotor, t: f64, mount_offsets: &[[f64; 3]]) -> RigidBody {
    let one = single_motor(m, t);
    let n = m.count.max(1) as usize;
    let parts: Vec<RigidBody> = if mount_offsets.len() == n {
        mount_offsets
            .iter()
            .map(|o| one.translated([0.0, o[1], o[2]]))
            .collect()
    } else {
        vec![one; n]
    };
    RigidBody::combine(&parts)
}
