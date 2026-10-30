//! Building a validated [`ThrustCurve`] from parsed samples, and linear
//! interpolation of thrust, mass, and CG over time.

use sha2::{Digest, Sha256};

use crate::class::impulse_class;
use crate::types::{MotorError, MotorSource, ThrustCurve, ThrustPoint};

pub(crate) fn err(line: u32, message: impl Into<String>) -> MotorError {
    MotorError {
        line,
        message: message.into(),
    }
}

/// sha256 hex of `bytes` (the motor digest).
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Header data common to both readers, already in SI.
pub(crate) struct Header {
    pub designation: String,
    pub manufacturer: Option<String>,
    pub diameter: f64,
    pub length: f64,
    pub delays: Vec<f64>,
    pub prop_mass: f64,
    pub total_mass: f64,
}

/// Validates samples (finite, `t` non-decreasing, `F >= 0`), prepends
/// `t = 0` when missing, and fills the derived header fields.
pub(crate) fn build(
    h: Header,
    mut points: Vec<ThrustPoint>,
    line: u32,
    sha256: &str,
    source: &MotorSource,
) -> Result<ThrustCurve, MotorError> {
    let name = &h.designation;
    if points.is_empty() {
        return Err(err(line, format!("{name}: no thrust samples")));
    }
    for p in &points {
        let finite = p.t.is_finite()
            && p.thrust.is_finite()
            && p.mass.is_none_or(f64::is_finite)
            && p.cg.is_none_or(f64::is_finite);
        if !finite {
            return Err(err(line, format!("{name}: non-finite sample at t={}", p.t)));
        }
        if p.t < 0.0 || p.thrust < 0.0 || p.mass.is_some_and(|m| m < 0.0) {
            return Err(err(line, format!("{name}: negative value at t={}", p.t)));
        }
    }
    if let Some(w) = points.windows(2).find(|w| w[1].t < w[0].t) {
        return Err(err(
            line,
            format!("{name}: time decreases ({} after {})", w[1].t, w[0].t),
        ));
    }
    let has_mass = points.iter().all(|p| p.mass.is_some());
    let has_cg = points.iter().all(|p| p.cg.is_some());
    if !has_mass {
        points.iter_mut().for_each(|p| p.mass = None);
    }
    if !has_cg {
        points.iter_mut().for_each(|p| p.cg = None);
    }
    if points[0].t > 0.0 {
        let first = points[0];
        points.insert(
            0,
            ThrustPoint {
                t: 0.0,
                thrust: 0.0,
                ..first
            },
        );
    }
    let burn_time = points[points.len() - 1].t;
    if burn_time <= 0.0 {
        return Err(err(line, format!("{name}: zero burn time")));
    }
    let total_impulse = *cumulative_impulse(&points).last().unwrap_or(&0.0);
    let class = impulse_class(total_impulse).ok_or_else(|| {
        err(
            line,
            format!("{name}: total impulse {total_impulse} N s is outside classes 1/8A..O"),
        )
    })?;
    if !(h.diameter.is_finite() && h.diameter > 0.0 && h.length.is_finite() && h.length >= 0.0) {
        return Err(err(line, format!("{name}: bad diameter or length")));
    }
    let masses_ok = h.prop_mass.is_finite()
        && h.total_mass.is_finite()
        && h.prop_mass >= 0.0
        && h.total_mass >= h.prop_mass;
    if !masses_ok {
        return Err(err(
            line,
            format!(
                "{name}: propellant mass {} kg exceeds total {} kg (or is invalid)",
                h.prop_mass, h.total_mass
            ),
        ));
    }
    let max_thrust = points.iter().map(|p| p.thrust).fold(0.0, f64::max);
    Ok(ThrustCurve {
        designation: h.designation,
        manufacturer: h.manufacturer,
        class,
        diameter: h.diameter,
        length: h.length,
        delays: h.delays,
        prop_mass: h.prop_mass,
        total_mass: h.total_mass,
        total_impulse,
        burn_time,
        average_thrust: total_impulse / burn_time,
        max_thrust,
        points,
        sha256: sha256.to_string(),
        source: source.clone(),
    })
}

/// Cumulative trapezoid impulse at each sample (N s); first entry 0.
fn cumulative_impulse(points: &[ThrustPoint]) -> Vec<f64> {
    let mut cum = Vec::with_capacity(points.len());
    let mut acc = 0.0;
    cum.push(acc);
    for w in points.windows(2) {
        acc += (w[1].t - w[0].t) * (w[0].thrust + w[1].thrust) / 2.0;
        cum.push(acc);
    }
    cum
}

/// Index `i` with `points[i].t <= t < points[i+1].t`, and the fraction along
/// that segment. `None` outside `[t0, t_end]`.
fn segment(points: &[ThrustPoint], t: f64) -> Option<(usize, f64)> {
    let n = points.len();
    if n < 2 || !(t >= points[0].t && t <= points[n - 1].t) {
        return None;
    }
    // First index whose t is > the query; the segment starts one before.
    let hi = points.partition_point(|p| p.t <= t).clamp(1, n - 1);
    let (a, b) = (points[hi - 1], points[hi]);
    let dt = b.t - a.t;
    let f = if dt > 0.0 { (t - a.t) / dt } else { 1.0 };
    Some((hi - 1, f.clamp(0.0, 1.0)))
}

fn lerp(a: f64, b: f64, f: f64) -> f64 {
    a + (b - a) * f
}

/// Linear interpolation of `field` at `t`, held at the end values outside
/// the sampled range.
fn lerp_clamped(points: &[ThrustPoint], t: f64, field: impl Fn(&ThrustPoint) -> f64) -> f64 {
    let (first, last) = (&points[0], &points[points.len() - 1]);
    if t.is_nan() || t <= first.t {
        return field(first);
    }
    if t >= last.t {
        return field(last);
    }
    match segment(points, t) {
        Some((i, f)) => lerp(field(&points[i]), field(&points[i + 1]), f),
        None => field(last),
    }
}

impl ThrustCurve {
    /// Thrust at time `t` after ignition (N); 0 outside the burn.
    ///
    /// cite: n/a linear interpolation of tabulated thrust samples
    pub fn thrust_at(&self, t: f64) -> f64 {
        match segment(&self.points, t) {
            Some((i, f)) => lerp(self.points[i].thrust, self.points[i + 1].thrust, f),
            None => 0.0,
        }
    }

    /// Impulse delivered from ignition to `t` (N s): the exact integral of the
    /// piecewise-linear thrust, 0 before ignition and `total_impulse` after.
    ///
    /// cite: n/a trapezoid integral of the piecewise-linear thrust samples
    pub fn impulse_at(&self, t: f64) -> f64 {
        let pts = &self.points;
        if t.is_nan() || t <= pts[0].t {
            return 0.0;
        }
        let Some((i, f)) = segment(pts, t) else {
            return self.total_impulse;
        };
        let cum = cumulative_impulse(&pts[..=i]);
        let (a, b) = (pts[i], pts[i + 1]);
        let ft = lerp(a.thrust, b.thrust, f);
        cum[i] + (t - a.t) * (a.thrust + ft) / 2.0
    }

    /// Total motor mass at `t` (kg): `m(0) = dry + prop`, `m(burnout) = dry`,
    /// `m(t) = dry + prop * (1 - I(t)/I_total)` (M1.36a semantics).
    ///
    /// With a per-sample mass column (`.rse` `m`) the samples are interpolated
    /// linearly and held at the end values outside the burn. Without one
    /// (`.eng`) the depletion law above is evaluated directly.
    ///
    /// cite: n/a linear interpolation; depletion law m = dry + prop*(1 - I/Itot) from lib/motors/generic/PROVENANCE.md
    pub fn mass_at(&self, t: f64) -> f64 {
        if self.points.iter().all(|p| p.mass.is_some()) {
            return lerp_clamped(&self.points, t, |p| p.mass.unwrap_or(0.0));
        }
        let dry = self.total_mass - self.prop_mass;
        if self.total_impulse <= 0.0 {
            return self.total_mass;
        }
        dry + self.prop_mass * (1.0 - self.impulse_at(t) / self.total_impulse)
    }

    /// Motor CG at `t`, measured from the motor's fore end (m).
    ///
    /// With a per-sample CG column (`.rse` `cg`) the samples are interpolated
    /// linearly and held outside the burn; otherwise the casing midpoint
    /// `length / 2` (uniform-casing assumption).
    ///
    /// cite: n/a linear interpolation of tabulated CG samples
    pub fn cg_at(&self, t: f64) -> f64 {
        if self.points.iter().all(|p| p.cg.is_some()) {
            return lerp_clamped(&self.points, t, |p| p.cg.unwrap_or(0.0));
        }
        self.length / 2.0
    }
}
