//! Deterministic IF5 doubles (stub-first rule): stand-ins for `AeroModel`
//! while the aero lane lands, and for replay tests that inject coefficients.
//! Compiled for this crate's unit tests and behind the `doubles` feature
//! (test builds only; `xtask audit` rejects it elsewhere).

use rw_aero::{AeroCoeffs, AeroState, DragBreakdown};
use rw_mass::MassProps;
use rw_motor::{MotorSource, ThrustCurve, ThrustPoint};

use crate::models::{AeroEval, MassEval};

/// Constant drag coefficient on a fixed reference area; no normal force.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConstantCd {
    pub cd: f64,
    /// Reference area (m²).
    pub ref_area: f64,
}

impl AeroEval for ConstantCd {
    fn eval(&self, _state: &AeroState) -> AeroCoeffs {
        AeroCoeffs {
            cn_alpha: 0.0,
            cn: 0.0,
            cp: 0.0,
            cd: self.cd,
            drag: DragBreakdown {
                friction: 0.0,
                pressure: 0.0,
                base: 0.0,
                parasitic: 0.0,
                total: self.cd,
            },
            cm_damping: 0.0,
            cl_forcing: 0.0,
            cl_damping: 0.0,
            ref_area: self.ref_area,
            ref_length: (4.0 * self.ref_area / core::f64::consts::PI).sqrt(),
            components: Vec::new(),
        }
    }
}

/// Coefficients with the given drag and a linear normal force (no damping).
fn coeffs(cd: f64, cn_alpha: f64, alpha: f64, cp: f64, ref_area: f64) -> AeroCoeffs {
    AeroCoeffs {
        cn_alpha,
        cn: cn_alpha * alpha,
        cp,
        cd,
        drag: DragBreakdown {
            friction: 0.0,
            pressure: 0.0,
            base: 0.0,
            parasitic: 0.0,
            total: cd,
        },
        cm_damping: 0.0,
        cl_forcing: 0.0,
        cl_damping: 0.0,
        ref_area,
        ref_length: (4.0 * ref_area / core::f64::consts::PI).sqrt(),
        components: Vec::new(),
    }
}

/// Piecewise-linear interpolation of `ys(xs)` at `x` (`xs` non-decreasing),
/// clamped to the end values outside `[xs[0], xs[n-1]]`. 0 for empty input.
///
/// cite: n/a linear interpolation of recorded samples
pub fn interp(xs: &[f64], ys: &[f64], x: f64) -> f64 {
    let n = xs.len().min(ys.len());
    if n == 0 {
        return 0.0;
    }
    if x <= xs[0] {
        return ys[0];
    }
    if x >= xs[n - 1] {
        return ys[n - 1];
    }
    let i = xs[..n].partition_point(|&v| v <= x).max(1) - 1;
    let (x0, x1) = (xs[i], xs[i + 1]);
    if x1 <= x0 {
        return ys[i + 1];
    }
    ys[i] + (ys[i + 1] - ys[i]) * (x - x0) / (x1 - x0)
}

/// Drag coefficient replayed against time (series injection, M1.39b-p):
/// `cd(t)` interpolated from recorded samples, on a fixed reference area; no
/// normal force. [`AeroEval::eval`] (no time) uses the first sample.
#[derive(Debug, Clone, PartialEq)]
pub struct TimedCd {
    pub t: Vec<f64>,
    pub cd: Vec<f64>,
    /// Reference area (m²).
    pub ref_area: f64,
}

impl AeroEval for TimedCd {
    fn eval(&self, _state: &AeroState) -> AeroCoeffs {
        coeffs(
            self.cd.first().copied().unwrap_or(0.0),
            0.0,
            0.0,
            0.0,
            self.ref_area,
        )
    }

    fn eval_at(&self, t: f64, _state: &AeroState, _x_cg: f64) -> AeroCoeffs {
        coeffs(interp(&self.t, &self.cd, t), 0.0, 0.0, 0.0, self.ref_area)
    }
}

/// Mass properties replayed against time (series injection): every field
/// interpolated from recorded samples.
#[derive(Debug, Clone, PartialEq)]
pub struct TimedMass {
    pub t: Vec<f64>,
    pub mass: Vec<f64>,
    /// CG station from the nose tip (m).
    pub cg: Vec<f64>,
    /// Roll inertia about the CG (kg m²).
    pub ixx: Vec<f64>,
    /// Transverse inertia about the CG (kg m²).
    pub iyy: Vec<f64>,
}

impl MassEval for TimedMass {
    fn at(&self, t: f64) -> MassProps {
        MassProps {
            mass: interp(&self.t, &self.mass, t),
            cg: interp(&self.t, &self.cg, t),
            ixx: interp(&self.t, &self.ixx, t),
            iyy: interp(&self.t, &self.iyy, t),
        }
    }
}

/// A thrust curve through recorded `(t, thrust)` samples (series injection).
/// Mass fields are placeholders: a replay takes mass from [`TimedMass`].
///
/// cite: n/a container for recorded samples
pub fn sampled_curve(t: &[f64], thrust: &[f64]) -> ThrustCurve {
    let points: Vec<ThrustPoint> = t
        .iter()
        .zip(thrust)
        .map(|(&t, &f)| ThrustPoint {
            t,
            thrust: f,
            mass: None,
            cg: None,
        })
        .collect();
    let burn = points.last().map_or(0.0, |p| p.t);
    let impulse: f64 = points
        .windows(2)
        .map(|w| 0.5 * (w[0].thrust + w[1].thrust) * (w[1].t - w[0].t))
        .sum();
    ThrustCurve {
        designation: "REPLAY".into(),
        manufacturer: None,
        class: "C".into(),
        diameter: 0.018,
        length: 0.07,
        delays: vec![],
        prop_mass: 0.0,
        total_mass: 0.0,
        total_impulse: impulse,
        burn_time: burn,
        average_thrust: if burn > 0.0 { impulse / burn } else { 0.0 },
        max_thrust: points.iter().map(|p| p.thrust).fold(0.0, f64::max),
        points,
        sha256: "0".repeat(64),
        source: MotorSource::Generic {
            id: "REPLAY".into(),
        },
    }
}

/// Linear normal force C_N = C_Nα α at a fixed CP with constant drag and
/// optional constant damping coefficients (frame and 6DOF tests).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LinearAero {
    pub cn_alpha: f64,
    /// CP station from the nose tip (m).
    pub cp: f64,
    pub cd: f64,
    /// Reference area (m²).
    pub ref_area: f64,
    /// Pitch damping coefficient per unit (ω/V)² (0 = none).
    pub cm_damping_per_rate2: f64,
    /// Roll forcing coefficient (fin cant).
    pub cl_forcing: f64,
    /// Roll damping coefficient per unit ω/V, signed with ω like rw-aero's
    /// subsonic (3.69) (0 = none).
    pub cl_damping_per_rate: f64,
}

impl AeroEval for LinearAero {
    fn eval(&self, state: &AeroState) -> AeroCoeffs {
        let mut c = coeffs(self.cd, self.cn_alpha, state.alpha, self.cp, self.ref_area);
        if state.speed > 0.0 {
            c.cm_damping = self.cm_damping_per_rate2 * (state.pitch_rate / state.speed).powi(2);
        }
        c.cl_forcing = self.cl_forcing;
        if state.speed > 0.0 {
            c.cl_damping = self.cl_damping_per_rate * state.roll_rate / state.speed;
        }
        c
    }
}
