//! IF5 adapters the flight phases evaluate through: aerodynamics
//! ([`AeroEval`], `AeroModel::eval`), mass ([`MassEval`], `MassModel::at`),
//! and thrust from the mounted motors ([`Propulsion`]).
//!
//! The traits let a flight run on the real models or on deterministic doubles
//! (`crate::doubles`) with the same code path. Their method signatures are the
//! frozen IF5 ones.

use rw_aero::{AeroCoeffs, AeroModel, AeroState};
use rw_mass::{MassModel, MassProps};
use rw_motor::MountedMotor;

/// Aerodynamic coefficients at a flight state (IF5 `AeroModel::eval`).
pub trait AeroEval {
    fn eval(&self, state: &AeroState) -> AeroCoeffs;

    /// Coefficients at time `t` after launch with the pitch-damping arms
    /// about the station `x_cg` (IF5 `AeroModel::eval_with_cg`). The flight
    /// phases call this one. The default ignores both: a time-invariant model
    /// without CG-dependent terms is just [`AeroEval::eval`]. Replay doubles
    /// (`crate::doubles`) use `t` to inject coefficients recorded over time.
    fn eval_at(&self, t: f64, state: &AeroState, x_cg: f64) -> AeroCoeffs {
        let _ = (t, x_cg);
        self.eval(state)
    }
}

impl AeroEval for AeroModel {
    fn eval(&self, state: &AeroState) -> AeroCoeffs {
        AeroModel::eval(self, state)
    }

    fn eval_at(&self, _t: f64, state: &AeroState, x_cg: f64) -> AeroCoeffs {
        self.eval_with_cg(state, x_cg)
    }
}

/// Whole-vehicle mass properties at time `t` after launch (IF5 `MassModel::at`).
pub trait MassEval {
    fn at(&self, t: f64) -> MassProps;
}

impl MassEval for MassModel {
    fn at(&self, t: f64) -> MassProps {
        MassModel::at(self, t)
    }
}

/// The mounted motors of one configuration: thrust, motor mass, and the
/// ignition and burnout times that break the integration.
#[derive(Debug, Clone, PartialEq)]
pub struct Propulsion {
    motors: Vec<MountedMotor>,
}

impl Propulsion {
    /// cite: n/a constructor, no physics
    pub fn new(motors: &[MountedMotor]) -> Self {
        Self {
            motors: motors.to_vec(),
        }
    }

    /// The motors.
    ///
    /// cite: n/a accessor, no physics
    pub fn motors(&self) -> &[MountedMotor] {
        &self.motors
    }

    /// Total thrust (N) at time `t` after launch: each motor's curve at
    /// `t - ignition_time`, times its cluster count.
    ///
    /// cite: n/a sum of interpolated thrust samples
    pub fn thrust(&self, t: f64) -> f64 {
        self.motors
            .iter()
            .map(|m| f64::from(m.count) * m.curve.thrust_at(t - m.ignition_time))
            .sum()
    }

    /// Total motor mass (kg) at time `t` after launch (loaded before
    /// ignition, dry after burnout; `ThrustCurve::mass_at` semantics).
    ///
    /// cite: mil-hdbk-762 eq 7-27 p 566
    pub fn mass(&self, t: f64) -> f64 {
        self.motors
            .iter()
            .map(|m| f64::from(m.count) * m.curve.mass_at(t - m.ignition_time))
            .sum()
    }

    /// Burnout time (s after launch) of one motor: ignition plus the time of
    /// its last thrust sample.
    pub(crate) fn motor_burnout(m: &MountedMotor) -> f64 {
        m.ignition_time + m.curve.points.last().map_or(0.0, |p| p.t)
    }

    /// Total thrust (N) at time `t` evaluated as a one-sided limit from inside
    /// the integration segment `seg = (t_a, t_b)` (consecutive [`Propulsion::breaks`]
    /// bound every segment, so each motor is either burning for the whole
    /// segment or not at all). At a burnout time this gives the burning value
    /// to the segment that ends there and zero to the one that starts there.
    ///
    /// cite: n/a one-sided evaluation of interpolated thrust samples
    pub fn thrust_on(&self, t: f64, seg: (f64, f64)) -> f64 {
        let mid = 0.5 * (seg.0 + seg.1);
        self.motors
            .iter()
            .map(|m| {
                let end = m.curve.points.last().map_or(0.0, |p| p.t);
                let tau = mid - m.ignition_time;
                if tau < 0.0 || tau > end {
                    0.0
                } else {
                    f64::from(m.count) * m.curve.thrust_at((t - m.ignition_time).clamp(0.0, end))
                }
            })
            .sum()
    }

    /// Earliest ignition time, or `None` without motors.
    ///
    /// cite: n/a min over the mounted motors
    pub fn first_ignition(&self) -> Option<f64> {
        self.motors.iter().map(|m| m.ignition_time).reduce(f64::min)
    }

    /// Latest burnout time (the `Burnout` event), or `None` without motors.
    ///
    /// cite: n/a max over the mounted motors
    pub fn burnout(&self) -> Option<f64> {
        self.motors.iter().map(Self::motor_burnout).reduce(f64::max)
    }

    /// Every ignition and burnout time, sorted and deduplicated. Thrust and
    /// mass flow are discontinuous (or kinked) there, so the integrator
    /// restarts at each one instead of stepping across it (explicit burnout
    /// break, F:144).
    ///
    /// cite: n/a event bookkeeping, no physics
    pub fn breaks(&self) -> Vec<f64> {
        let mut v: Vec<f64> = self
            .motors
            .iter()
            .flat_map(|m| [m.ignition_time, Self::motor_burnout(m)])
            .collect();
        v.sort_by(f64::total_cmp);
        v.dedup();
        v
    }
}

/// Point-mass vehicle: a fixed dry mass plus the motors' mass over the burn.
/// CG and inertia are not modelled (zero); 3DOF does not use them.
#[derive(Debug, Clone, PartialEq)]
pub struct PointMass {
    /// Vehicle mass without motors (kg).
    pub dry_mass: f64,
    pub propulsion: Propulsion,
}

impl MassEval for PointMass {
    fn at(&self, t: f64) -> MassProps {
        MassProps {
            mass: self.dry_mass + self.propulsion.mass(t),
            cg: 0.0,
            ixx: 0.0,
            iyy: 0.0,
        }
    }
}

/// What a point-mass flight phase evaluates: environment, aerodynamics,
/// mass, and thrust.
#[derive(Clone, Copy)]
pub struct Vehicle<'a> {
    pub env: &'a crate::env::Environment,
    pub aero: &'a dyn AeroEval,
    pub mass: &'a dyn MassEval,
    pub propulsion: &'a Propulsion,
}

/// Air-relative quantities at one state, shared by the rail and 3DOF phases.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AirLoads {
    /// Air-relative velocity v - w (ENU, m/s).
    pub v_rel: [f64; 3],
    /// |v_rel| (m/s).
    pub speed: f64,
    pub mach: f64,
    pub density: f64,
    pub cd: f64,
    /// Reference area (m²).
    pub ref_area: f64,
    pub thrust: f64,
    pub mass: f64,
    /// Gravity magnitude (m/s², acting along -z).
    pub g: f64,
}

impl Vehicle<'_> {
    /// Thrust, mass, gravity, and drag coefficient at time `t`, height `z`
    /// above the site, and ground velocity `v`. Drag is evaluated at zero
    /// angle of attack (point mass); Mach is V/a (CO-09). Inside an
    /// integration segment `seg`, thrust is the one-sided value
    /// ([`Propulsion::thrust_on`]); `None` evaluates the curve directly.
    ///
    /// cite: niskanen-2009 eq 3.11 p 38
    pub fn loads(&self, t: f64, seg: Option<(f64, f64)>, z: f64, v: [f64; 3]) -> AirLoads {
        let air = self.env.air(z);
        let w = self.env.wind_at(z);
        let v_rel = [v[0] - w[0], v[1] - w[1], v[2] - w[2]];
        let speed = norm(v_rel);
        let thrust = match seg {
            Some(seg) => self.propulsion.thrust_on(t, seg),
            None => self.propulsion.thrust(t),
        };
        let mach = speed / air.speed_of_sound;
        let mp = self.mass.at(t);
        let state = AeroState {
            mach,
            speed,
            alpha: 0.0,
            roll_rate: 0.0,
            pitch_rate: 0.0,
            kinematic_viscosity: air.kinematic_viscosity,
            thrusting: thrust > 0.0,
        };
        let c = self.aero.eval_at(t, &state, mp.cg);
        AirLoads {
            v_rel,
            speed,
            mach,
            density: air.density,
            cd: c.cd,
            ref_area: c.ref_area,
            thrust,
            mass: mp.mass,
            g: self.env.g(z),
        }
    }
}

impl AirLoads {
    /// Drag force (N) opposing the air-relative velocity,
    /// D = -q C_D A_ref v_rel/|v_rel| with q = ρ V²/2 (CO-07).
    ///
    /// cite: niskanen-2009 eq 3.9 p 37
    pub fn drag(&self) -> [f64; 3] {
        let k = -0.5 * self.density * self.speed * self.cd * self.ref_area;
        [k * self.v_rel[0], k * self.v_rel[1], k * self.v_rel[2]]
    }
}

/// Euclidean norm.
///
/// cite: n/a vector algebra
pub fn norm(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

/// Dot product.
///
/// cite: n/a vector algebra
pub fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use rw_motor::{MotorSource, ThrustCurve, ThrustPoint};

    /// A constant-thrust motor: `thrust` N for `burn` s, `prop` kg of
    /// propellant, `dry` kg casing; no mass column, so the mass depletes in
    /// proportion to impulse (linear in time here).
    pub(crate) fn constant_motor(thrust: f64, burn: f64, prop: f64, dry: f64) -> ThrustCurve {
        ThrustCurve {
            designation: "T1".into(),
            manufacturer: None,
            class: "C".into(),
            diameter: 0.018,
            length: 0.07,
            delays: vec![],
            prop_mass: prop,
            total_mass: prop + dry,
            total_impulse: thrust * burn,
            burn_time: burn,
            average_thrust: thrust,
            max_thrust: thrust,
            points: vec![
                ThrustPoint {
                    t: 0.0,
                    thrust,
                    mass: None,
                    cg: None,
                },
                ThrustPoint {
                    t: burn,
                    thrust,
                    mass: None,
                    cg: None,
                },
            ],
            sha256: "0".repeat(64),
            source: MotorSource::Generic { id: "TEST".into() },
        }
    }

    pub(crate) fn mounted(curve: ThrustCurve, ignition_time: f64, count: u32) -> MountedMotor {
        MountedMotor {
            mount: "mmt".into(),
            curve,
            x_fore: 0.3,
            ignition_time,
            delay: None,
            count,
        }
    }

    #[test]
    fn propulsion_sums_and_breaks() {
        let p = Propulsion::new(&[
            mounted(constant_motor(10.0, 2.0, 0.02, 0.01), 0.0, 2),
            mounted(constant_motor(5.0, 1.0, 0.01, 0.01), 3.0, 1),
        ]);
        assert_eq!(p.thrust(1.0), 20.0);
        assert_eq!(p.thrust(2.5), 0.0);
        assert_eq!(p.thrust(3.5), 5.0);
        // One-sided at the first burnout (t = 2): burning from the left
        // segment, off from the right one.
        assert_eq!(p.thrust_on(2.0, (0.0, 2.0)), 20.0);
        assert_eq!(p.thrust_on(2.0, (2.0, 3.0)), 0.0);
        assert_eq!(p.thrust_on(3.0, (2.0, 3.0)), 0.0);
        assert_eq!(p.thrust_on(3.0, (3.0, 4.0)), 5.0);
        assert!((p.mass(0.0) - (2.0 * 0.03 + 0.02)).abs() < 1e-15);
        assert!((p.mass(1.0) - (2.0 * 0.02 + 0.02)).abs() < 1e-15);
        assert!((p.mass(10.0) - (2.0 * 0.01 + 0.01)).abs() < 1e-15);
        assert_eq!(p.breaks(), vec![0.0, 2.0, 3.0, 4.0]);
        assert_eq!(p.first_ignition(), Some(0.0));
        assert_eq!(p.burnout(), Some(4.0));
        let pm = PointMass {
            dry_mass: 0.1,
            propulsion: p,
        };
        assert!((pm.at(10.0).mass - 0.13).abs() < 1e-15);
        assert_eq!(Propulsion::new(&[]).burnout(), None);
    }

    #[test]
    fn generic_motor_mass_endpoints() {
        let c = rw_motor::generic::generic_motor("RW_C6G").expect("RW_C6G");
        let p = Propulsion::new(&[mounted(c.clone(), 0.0, 1)]);
        assert!((p.mass(0.0) - c.total_mass).abs() < 1e-12);
        let tb = p.burnout().unwrap();
        assert!((p.mass(tb + 1.0) - (c.total_mass - c.prop_mass)).abs() < 1e-9);
    }
}
