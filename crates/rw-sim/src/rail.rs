//! Launch rail: one degree of freedom along the rail until rail exit (R4.5).
//!
//! State `[s, v]`: distance travelled up the rail (m) and speed along it
//! (m/s). The axial equation of motion with time-varying mass (MM-12) is
//!
//! a = (F_T + F_A,axial) / m(t) - g cos θ,
//!
//! with θ the rail angle from vertical (`g cos θ` = `g * rail_axis.z`) and the
//! axial aerodynamic force `F_A,axial = -q C_D A_ref (v_rel · û) / |v_rel|`
//! (drag projected on the rail; crosswind adds to the dynamic pressure but
//! the rail carries the side load). The launcher holds the vehicle: while it
//! is not moving up the rail, a negative net acceleration is reacted (a = 0),
//! so the vehicle never slides back below its start.

use crate::models::{Vehicle, dot};

/// Rail state `[s, v]`.
pub type RailState = [f64; 2];

/// Axial acceleration on the rail before the launcher reaction, at time `t`
/// and state `y` (`seg`: see `Vehicle::loads`).
///
/// cite: mil-hdbk-762 eq 7-33 p 567
pub fn free_accel(veh: &Vehicle<'_>, t: f64, seg: Option<(f64, f64)>, y: &RailState) -> f64 {
    let u = veh.env.rail_axis;
    let (s, v) = (y[0], y[1]);
    let l = veh.loads(t, seg, s * u[2], [v * u[0], v * u[1], v * u[2]]);
    let axial_drag = dot(l.drag(), u);
    (l.thrust + axial_drag) / l.mass - l.g * u[2]
}

/// Axial acceleration with the launcher reaction: zero while the vehicle is
/// at rest or moving down the rail and the net force points down the rail.
///
/// cite: mil-hdbk-762 eq 7-33 p 567
pub fn accel(veh: &Vehicle<'_>, t: f64, seg: Option<(f64, f64)>, y: &RailState) -> f64 {
    let a = free_accel(veh, t, seg, y);
    if y[1] <= 0.0 && a < 0.0 { 0.0 } else { a }
}

/// Right-hand side `[ds/dt, dv/dt] = [v, a]`.
///
/// cite: mil-hdbk-762 eq 7-33 p 567
pub fn rhs(veh: &Vehicle<'_>, t: f64, seg: Option<(f64, f64)>, y: &RailState, dy: &mut RailState) {
    dy[0] = y[1];
    dy[1] = accel(veh, t, seg, y);
}

/// Position and velocity (ENU) of a rail state.
///
/// cite: n/a projection onto the rail axis
pub fn to_enu(veh: &Vehicle<'_>, y: &RailState) -> ([f64; 3], [f64; 3]) {
    let u = veh.env.rail_axis;
    (
        [y[0] * u[0], y[0] * u[1], y[0] * u[2]],
        [y[1] * u[0], y[1] * u[1], y[1] * u[2]],
    )
}
