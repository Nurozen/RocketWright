//! Second-order shock-expansion for pointed bodies of revolution near zero
//! lift (Syvertson and Dennis, NACA TR 1328, 1957, pdf pp 6-10 and 18-20;
//! literature-map BW-1328-01..10).
//!
//! The body is replaced by a tangent body: conical frustums tangent to the
//! profile at chosen stations (figure 1). The flow turns through a
//! Prandtl-Meyer expansion at each corner, as in the generalized
//! shock-expansion method, and along each frustum the pressure then relaxes
//! exponentially toward the pressure on the cone of the same slope, eq (8),
//! at the rate set by the pressure gradient just behind the corner, eq (7).
//! The normal-force loading Λ follows the same law between the loading
//! carried round the corner and the tangent-cone value, eq (19). C_Nα is the
//! integral of Λ r, eq (14), and its first moment gives C_mα, eq (21).
//!
//! The cone inputs come from [`super::cone`]: the surface state at zero
//! incidence by integration (the report reads its figure 3) and the cone
//! normal-force slope from NASA SP-3007 (the report reads its figure 4).
//!
//! Covered: a pointed nose with an attached shock, convex profile, followed
//! by cylinder. Concave corners, boattails, flares and open or blunt noses
//! (the report's Appendix B forms) are not implemented; [`shock_expansion`]
//! returns `None` for them and the caller keeps its slender-body terms.
//!
//! [`shock_expansion`] returns the zero-lift surface pressure along with the
//! loading, so nose pressure drag can be integrated from the same solution.

use crate::mach::{GAMMA, hermite, table_hermite};
use crate::supersonic::cone::{cone_normal_force_slope, cone_surface};

/// Tangent stations on a curved nose, at x/l_n = 0, 0.1, ..., 1 (the report's
/// ten-step solution, pdf p 11).
pub const TANGENT_STEPS: usize = 10;
/// Lowest surface Mach number at the vertex for which the method is used.
/// The corner relations (7) and (B16) are singular at a sonic surface.
pub const MIN_VERTEX_MACH: f64 = 1.2;
/// Upper end and target spacing of the Mach grid of [`BodyLift`]; above it
/// the last value is held.
const GRID_MACH_MAX: f64 = 6.0;
const GRID_STEP: f64 = 0.25;
/// Step of the search for the lowest Mach number at which the method applies.
const SEARCH_STEP: f64 = 0.05;

/// Prandtl-Meyer angle ν(M) (rad).
fn prandtl_meyer(mach: f64) -> f64 {
    let b = (mach * mach - 1.0).max(0.0).sqrt();
    let k = ((GAMMA + 1.0) / (GAMMA - 1.0)).sqrt();
    k * (b / k).atan() - b.atan()
}

/// Mach number after an isentropic expansion through `turn` (rad) from `m1`.
fn mach_after_turn(m1: f64, turn: f64) -> Option<f64> {
    if turn <= 0.0 {
        return Some(m1);
    }
    let target = prandtl_meyer(m1) + turn;
    let k = ((GAMMA + 1.0) / (GAMMA - 1.0)).sqrt();
    if target >= 0.999 * (k - 1.0) * std::f64::consts::FRAC_PI_2 {
        return None;
    }
    let mut m = m1;
    for _ in 0..100 {
        let b = (m * m - 1.0).sqrt();
        let dnu = b / (m * (1.0 + 0.5 * (GAMMA - 1.0) * m * m));
        let step = (prandtl_meyer(m) - target) / dnu;
        m = (m - step).max(m1);
        if step.abs() < 1e-13 * m {
            break;
        }
    }
    Some(m)
}

/// p/p_t at Mach number `m`.
fn pressure_ratio(m: f64) -> f64 {
    (1.0 + 0.5 * (GAMMA - 1.0) * m * m).powf(-GAMMA / (GAMMA - 1.0))
}

/// One-dimensional area ratio Ω = A/A*, eq (B17).
fn area_ratio(m: f64) -> f64 {
    ((1.0 + 0.5 * (GAMMA - 1.0) * m * m) / (0.5 * (GAMMA + 1.0)))
        .powf(0.5 * (GAMMA + 1.0) / (GAMMA - 1.0))
        / m
}

/// B = γ p M²/(2 (M² − 1)), eq (B15).
fn b_factor(p: f64, m: f64) -> f64 {
    GAMMA * p * m * m / (2.0 * (m * m - 1.0))
}

/// λ = 2 γ p/sin 2μ = γ p M²/√(M² − 1), eq (B16).
fn lambda(p: f64, m: f64) -> f64 {
    GAMMA * p * m * m / (m * m - 1.0).sqrt()
}

/// φ_n(z) = ∫_0^1 s^n e^{−z s} ds for n = 0, 1, 2 and z ≥ 0.
fn phi(z: f64) -> [f64; 3] {
    if z < 1.0 {
        // Σ_j (−z)^j / (j! (n + j + 1)); the closed forms cancel at small z.
        let mut out = [0.0; 3];
        let mut term = 1.0;
        for j in 0..24 {
            for (n, o) in out.iter_mut().enumerate() {
                *o += term / (n + j + 1) as f64;
            }
            term *= -z / (j + 1) as f64;
        }
        out
    } else {
        let e = (-z).exp();
        [
            (1.0 - e) / z,
            (1.0 - e * (1.0 + z)) / (z * z),
            (2.0 - e * (z * z + 2.0 * z + 2.0)) / (z * z * z),
        ]
    }
}

/// One conical frustum of the tangent body with its surface solution.
/// Pressures are over the free-stream static pressure; lengths are in the
/// units of the corner coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frustum {
    /// Fore corner (station from the vertex, radius).
    pub x2: f64,
    pub r2: f64,
    /// Aft corner.
    pub x3: f64,
    pub r3: f64,
    /// Surface slope tan δ.
    pub slope: f64,
    /// Pressure and Mach number just behind the fore corner.
    pub p2: f64,
    pub m2: f64,
    /// Pressure on the cone of the same slope, p_c.
    pub p_cone: f64,
    /// η per unit axial length, eq (9).
    pub rate: f64,
    /// Loading of the cone of the same slope, tan δ (dC_N/dα)_tc.
    pub cone_loading: f64,
    /// Loading just behind the fore corner, (λ_2/λ_1) Λ_1.
    pub loading2: f64,
}

impl Frustum {
    fn decay(&self, x: f64) -> f64 {
        (-self.rate * (x - self.x2).max(0.0)).exp()
    }

    /// Zero-lift surface pressure p/p_∞ at station `x` on this frustum:
    /// p = p_c − (p_c − p_2) e^{−η}.
    /// cite: naca-tr-1328 eq 8 p 8
    pub fn pressure(&self, x: f64) -> f64 {
        self.p_cone - (self.p_cone - self.p2) * self.decay(x)
    }

    /// Normal-force loading Λ at station `x` on this frustum:
    /// Λ = (1 − e^{−η}) tan δ (dC_N/dα)_tc + (λ_2/λ_1) e^{−η} Λ_1.
    /// cite: naca-tr-1328 eq 19 p 10
    pub fn loading(&self, x: f64) -> f64 {
        let e = self.decay(x);
        (1.0 - e) * self.cone_loading + e * self.loading2
    }

    /// (∫ Λ r dx, ∫ Λ r x dx) over [xa, xb] clipped to the frustum, in closed
    /// form: r is linear and Λ is a constant plus an exponential.
    fn load_integrals(&self, xa: f64, xb: f64) -> (f64, f64) {
        let (ua, ub) = (xa.max(self.x2) - self.x2, xb.min(self.x3) - self.x2);
        let len = ub - ua;
        if len <= 0.0 {
            return (0.0, 0.0);
        }
        let (t, d) = (self.cone_loading, self.loading2 - self.cone_loading);
        let p = [
            len,
            0.5 * (ub * ub - ua * ua),
            (ub.powi(3) - ua.powi(3)) / 3.0,
        ];
        let [f0, f1, f2] = phi(self.rate * len);
        let (j0, j1, j2) = (len * f0, len * len * f1, len.powi(3) * f2);
        let ea = (-self.rate * ua).exp();
        let e = [
            ea * j0,
            ea * (ua * j0 + j1),
            ea * (ua * ua * j0 + 2.0 * ua * j1 + j2),
        ];
        let (r2, s) = (self.r2, self.slope);
        let force = t * (r2 * p[0] + s * p[1]) + d * (r2 * e[0] + s * e[1]);
        let moment = self.x2 * force + t * (r2 * p[1] + s * p[2]) + d * (r2 * e[1] + s * e[2]);
        (force, moment)
    }
}

/// Corners (station from the vertex, radius) of the tangent body of a nose of
/// length `length` and base radius `base_radius` with profile `radius(x)`,
/// followed by `afterbody` of cylinder. Tangents are taken at
/// [`TANGENT_STEPS`] + 1 equally spaced stations and consecutive tangents
/// meet at the corners (figure 1); equal neighbours merge, so a cone is one
/// element and a nose that ends tangent to the cylinder runs straight into
/// it. `None` when the profile is not convex (a slope that increases aft or
/// is negative), which the method does not cover.
/// cite: naca-tr-1328 fig 1 p 7
pub fn tangent_body(
    radius: impl Fn(f64) -> f64,
    length: f64,
    base_radius: f64,
    afterbody: f64,
) -> Option<Vec<(f64, f64)>> {
    if !(length > 0.0 && base_radius > 0.0) {
        return None;
    }
    let n = TANGENT_STEPS;
    let h = 1e-5 * length;
    // Second-order one-sided slopes at the two ends, central between.
    let tangent = |i: usize| {
        let x = length * i as f64 / n as f64;
        let slope = if i == 0 {
            (4.0 * radius(h) - radius(2.0 * h) - 3.0 * radius(0.0)) / (2.0 * h)
        } else if i == n {
            (3.0 * radius(x) - 4.0 * radius(x - h) + radius(x - 2.0 * h)) / (2.0 * h)
        } else {
            (radius(x + h) - radius(x - h)) / (2.0 * h)
        };
        (x, radius(x), slope)
    };
    let tol = 1e-6 * (base_radius / length);
    let mut corners = vec![(0.0, 0.0)];
    let (mut xc, mut rc, mut sc) = tangent(0);
    if !(rc.abs() <= 1e-9 * base_radius && sc.is_finite() && sc > tol) {
        return None;
    }
    for i in 1..=n {
        let (x, r, s) = tangent(i);
        if s < -tol || s > sc + tol {
            return None;
        }
        if sc - s <= tol {
            // Same slope: it must be the same line.
            if (rc + sc * (x - xc) - r).abs() > 1e-6 * base_radius {
                return None;
            }
            continue;
        }
        let xi = (r - rc + sc * xc - s * x) / (sc - s);
        let last = corners[corners.len() - 1].0;
        if !(xi > last && xi <= x + 1e-9 * length) {
            return None;
        }
        corners.push((xi, rc + sc * (xi - xc)));
        (xc, rc, sc) = (x, r, s);
    }
    if sc > tol {
        // The nose meets the cylinder at a corner.
        corners.push((length, base_radius));
        if afterbody > 0.0 {
            corners.push((length + afterbody, base_radius));
        }
    } else {
        corners.push((length + afterbody.max(0.0), base_radius));
    }
    Some(corners)
}

/// Second-order shock-expansion solution on the tangent body with the given
/// corners (the first at the vertex, radius 0) at free-stream Mach number
/// `mach`: one [`Frustum`] per element, with the zero-lift pressure law (8)
/// and the loading law (19).
///
/// At each corner the flow expands isentropically through the change of
/// slope; the pressure gradient behind it is eq (7),
/// (∂p/∂s)_2 = (B_2/r)(Ω_1/Ω_2 sin δ_1 − sin δ_2) + (B_2/B_1)(Ω_1/Ω_2)(∂p/∂s)_1,
/// and η = (∂p/∂s)_2 (x − x_2)/((p_c − p_2) cos δ_2), eq (9). The state at
/// the end of the element (pressure (8), gradient (10), Mach number from the
/// pressure at constant total pressure) feeds the next corner.
///
/// The report requires η ≥ 0 (pdf p 10). Where the gradient and p_c − p_2
/// have opposite signs, which happens on the forward part of blunt ogives at
/// high M/f_n, |η| is used: the pressure still relaxes to p_c at the same
/// rate, stays between p_2 and p_c, and is continuous through p_c = p_2
/// (parity-log, supersonic body lift).
///
/// `None` when the method does not apply: detached or subsonic nose flow,
/// tangent-cone angle outside the SP-3007 table, a concave corner, or
/// surface flow that does not stay supersonic.
/// cite: naca-tr-1328 eq 7 p 8
/// cite: naca-tr-1328 eq 8 p 8
/// cite: naca-tr-1328 eq 9 p 8
/// cite: naca-tr-1328 eq 10 p 8
/// cite: naca-tr-1328 eq 19 p 10
pub fn shock_expansion(mach: f64, corners: &[(f64, f64)]) -> Option<Vec<Frustum>> {
    if corners.len() < 2 || corners[0].1 != 0.0 {
        return None;
    }
    let mut out: Vec<Frustum> = Vec::with_capacity(corners.len() - 1);
    // State at the end of the previous element: p, M, ∂p/∂s, δ, Λ.
    let mut prev: Option<(f64, f64, f64, f64, f64)> = None;
    for w in corners.windows(2) {
        let ((x2, r2), (x3, r3)) = (w[0], w[1]);
        if x3.partial_cmp(&x2) != Some(std::cmp::Ordering::Greater) {
            return None;
        }
        // A cylinder's corners can differ by rounding.
        let slope = (r3 - r2) / (x3 - x2);
        let slope = if slope.abs() < 1e-9 { 0.0 } else { slope };
        let delta = slope.atan();
        if delta < 0.0 {
            return None;
        }
        let cone = cone_surface(mach, delta)?;
        let cone_loading = slope * cone_normal_force_slope(mach, delta)?;
        let (p2, m2, gradient, loading2) = match prev {
            None => (cone.pressure, cone.mach, 0.0, cone_loading),
            Some((p1, m1, dp1, d1, load1)) => {
                if delta > d1 + 1e-12 || r2 <= 0.0 {
                    return None;
                }
                let m2 = mach_after_turn(m1, d1 - delta)?;
                let p2 = p1 * pressure_ratio(m2) / pressure_ratio(m1);
                let omega = area_ratio(m1) / area_ratio(m2);
                let b2 = b_factor(p2, m2);
                let gradient = b2 / r2 * (omega * d1.sin() - delta.sin())
                    + b2 / b_factor(p1, m1) * omega * dp1;
                (p2, m2, gradient, lambda(p2, m2) / lambda(p1, m1) * load1)
            }
        };
        let gap = cone.pressure - p2;
        let rate = if gap.abs() > 1e-12 {
            (gradient / (gap * delta.cos())).abs()
        } else {
            0.0
        };
        let f = Frustum {
            x2,
            r2,
            x3,
            r3,
            slope,
            p2,
            m2,
            p_cone: cone.pressure,
            rate,
            cone_loading,
            loading2,
        };
        let p3 = f.pressure(x3);
        // Mach number at the end from p_3 at constant total pressure.
        let t = (p3 / p2).powf(-(GAMMA - 1.0) / GAMMA) * (1.0 + 0.5 * (GAMMA - 1.0) * m2 * m2);
        let m3 = ((t - 1.0) / (0.5 * (GAMMA - 1.0))).max(0.0).sqrt();
        if !(m3 > 1.0 + 1e-6 && p3 > 0.0) {
            return None;
        }
        // (10) for the pressure law in use: ∂p/∂s = η' cos δ (p_c − p).
        let dp3 = rate * delta.cos() * (cone.pressure - p3);
        prev = Some((p3, m3, dp3, delta, f.loading(x3)));
        out.push(f);
    }
    Some(out)
}

/// Normal-force slope and its first moment for the part of the body between
/// stations `xa` and `xb`, on the base area π `base_radius`²:
/// (dC_N/dα, x̄ dC_N/dα) = (2π/A_B)(∫ Λ r dx, ∫ Λ r x dx). The second is
/// −d (dC_m/dα) of eq (21), so the CP is their ratio.
/// cite: naca-tr-1328 eq 14 p 9
/// cite: naca-tr-1328 eq 21 p 10
pub fn normal_force(frustums: &[Frustum], xa: f64, xb: f64, base_radius: f64) -> (f64, f64) {
    let k = 2.0 / (base_radius * base_radius);
    frustums.iter().fold((0.0, 0.0), |acc, f| {
        let (force, moment) = f.load_integrals(xa, xb);
        (acc.0 + k * force, acc.1 + k * moment)
    })
}

/// Supersonic normal-force slope and CP of a pointed nose and the cylinder
/// behind it, part by part (the nose, then each stretch of cylinder), over
/// Mach. The shock-expansion solution is tabulated on a Mach grid when the
/// model is built and interpolated with cubic Hermite segments, so `eval`
/// integrates no flow field. Below the grid a C¹ cubic joins the caller's
/// slender-body values at the lower end of [`Self::window`] to the tabulated
/// ones at the upper end.
#[derive(Debug, Clone, PartialEq)]
pub struct BodyLift {
    /// Blend window: the slender-body terms hold up to `m_lo` and the
    /// shock-expansion ones from `m_hi`.
    m_lo: f64,
    m_hi: f64,
    /// Grid origin (= `m_hi`) and spacing.
    dm: f64,
    /// Per part: node values of dC_N/dα on the base area and of x̄ dC_N/dα.
    parts: Vec<(Vec<f64>, Vec<f64>)>,
    base_area: f64,
}

impl BodyLift {
    /// Tabulates the solution for a nose of length `length` and base radius
    /// `base_radius` with profile `radius(x)`, followed by the cylinder
    /// stretches `tubes` (start and end stations from the vertex, in order
    /// and touching). `m_lo` is the Mach number up to which the caller keeps
    /// its slender-body terms.
    ///
    /// The upper end of the window, M_hi, is the lowest Mach number from 1.5
    /// (the first row of the SP-3007 table and the lower bound of the fin
    /// supersonic forms) at which the method applies with a vertex surface
    /// Mach number of at least [`MIN_VERTEX_MACH`]. `None` when it applies
    /// nowhere on the grid; the caller then keeps the slender-body terms at
    /// every Mach number.
    /// cite: naca-tr-1328 eq 14 p 9
    /// cite: naca-tr-1328 eq 21 p 10
    pub fn new(
        radius: impl Fn(f64) -> f64,
        length: f64,
        base_radius: f64,
        tubes: &[(f64, f64)],
        m_lo: f64,
    ) -> Option<Self> {
        let afterbody = tubes.last().map_or(0.0, |t| t.1 - length);
        let corners = tangent_body(radius, length, base_radius, afterbody)?;
        let solve =
            |mach: f64| shock_expansion(mach, &corners).filter(|f| f[0].m2 >= MIN_VERTEX_MACH);
        let mut m_hi = crate::mach::SUPERSONIC_LIMIT;
        while solve(m_hi).is_none() {
            m_hi += SEARCH_STEP;
            if m_hi > GRID_MACH_MAX - GRID_STEP {
                return None;
            }
        }
        let n = (((GRID_MACH_MAX - m_hi) / GRID_STEP).ceil() as usize).max(1) + 1;
        let dm = (GRID_MACH_MAX - m_hi) / (n - 1) as f64;
        let mut ranges = vec![(0.0, length)];
        ranges.extend_from_slice(tubes);
        let mut parts = vec![(Vec::with_capacity(n), Vec::with_capacity(n)); ranges.len()];
        for i in 0..n {
            // A node where the method stops applying ends the grid; the last
            // good value is held above it.
            let Some(frustums) = solve(m_hi + dm * i as f64) else {
                break;
            };
            for (part, &(xa, xb)) in parts.iter_mut().zip(&ranges) {
                let (force, moment) = normal_force(&frustums, xa, xb, base_radius);
                part.0.push(force);
                part.1.push(moment);
            }
        }
        if parts[0].0.len() < 2 {
            return None;
        }
        Some(Self {
            m_lo,
            m_hi,
            dm,
            parts,
            base_area: std::f64::consts::PI * base_radius * base_radius,
        })
    }

    /// Mach numbers between which the body terms go from the slender-body to
    /// the shock-expansion form.
    /// cite: n/a accessor
    pub fn window(&self) -> (f64, f64) {
        (self.m_lo, self.m_hi)
    }

    /// Number of parts: the nose plus the cylinder stretches.
    /// cite: n/a accessor
    pub fn parts(&self) -> usize {
        self.parts.len()
    }

    /// Shock-expansion C_Nα of part `i` on `a_ref` and its first moment
    /// x̄ C_Nα (x̄ from the vertex), valid from the upper end of
    /// [`Self::window`].
    /// cite: naca-tr-1328 eq 14 p 9
    /// cite: naca-tr-1328 eq 21 p 10
    pub fn supersonic(&self, i: usize, mach: f64, a_ref: f64) -> (f64, f64) {
        let k = self.base_area / a_ref;
        let (force, moment) = &self.parts[i];
        (
            k * table_hermite(force, self.m_hi, self.dm, mach).0,
            k * table_hermite(moment, self.m_hi, self.dm, mach).0,
        )
    }

    /// C_Nα of part `i` on `a_ref` and its first moment at any Mach number
    /// above the lower end of the window: the shock-expansion values from
    /// M_hi, and below it the cubic that matches the slender-body pair
    /// `slender` (C_Nα and x̄ C_Nα, constant in Mach) at the lower end and the
    /// shock-expansion value and slope at M_hi.
    /// cite: naca-tr-1328 eq 14 p 9
    /// cite: niskanen-2009 eq 3.19 p 32
    pub fn blended(&self, i: usize, mach: f64, a_ref: f64, slender: (f64, f64)) -> (f64, f64) {
        if mach >= self.m_hi {
            return self.supersonic(i, mach, a_ref);
        }
        let k = self.base_area / a_ref;
        let join = |v: &[f64], y0: f64| {
            let (y1, d1) = table_hermite(v, self.m_hi, self.dm, self.m_hi);
            hermite(mach, self.m_lo, self.m_hi, y0, 0.0, k * y1, k * d1)
        };
        (
            join(&self.parts[i].0, slender.0),
            join(&self.parts[i].1, slender.1),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    /// Corners of a cone of fineness `f_n` on a unit-diameter base with `f_a`
    /// diameters of cylinder.
    fn cone_cylinder(f_n: f64, f_a: f64) -> Vec<(f64, f64)> {
        tangent_body(|x| 0.5 * x / f_n, f_n, 0.5, f_a).unwrap()
    }

    /// Circular-arc tangent ogive of fineness `f_n`, unit diameter.
    fn ogive_radius(f_n: f64) -> impl Fn(f64) -> f64 {
        let rho = (0.25 + f_n * f_n) / 1.0;
        move |x: f64| (rho * rho - (f_n - x).powi(2)).max(0.0).sqrt() + 0.5 - rho
    }

    fn ogive_cylinder(f_n: f64, f_a: f64) -> Vec<(f64, f64)> {
        tangent_body(ogive_radius(f_n), f_n, 0.5, f_a).unwrap()
    }

    fn slope_and_cp(mach: f64, corners: &[(f64, f64)]) -> (f64, f64) {
        let f = shock_expansion(mach, corners).expect("applies");
        let end = corners[corners.len() - 1].0;
        let (cna, moment) = normal_force(&f, 0.0, end, 0.5);
        (cna, moment / cna)
    }

    #[test]
    fn gas_relations() {
        // ν(2) = 26.3798°, Ω(2) = 1.6875 (NACA TR 1135 tables).
        assert!((prandtl_meyer(2.0).to_degrees() - 26.3798).abs() < 1e-4);
        assert!((area_ratio(2.0) - 1.6875).abs() < 1e-12);
        assert!((area_ratio(1.0) - 1.0).abs() < 1e-12);
        for (m, turn) in [(1.3_f64, 0.05_f64), (2.0, 0.3), (4.0, 0.2)] {
            let m2 = mach_after_turn(m, turn).unwrap();
            assert!((prandtl_meyer(m2) - prandtl_meyer(m) - turn).abs() < 1e-12);
        }
        assert_eq!(mach_after_turn(2.0, 0.0), Some(2.0));
        assert!(mach_after_turn(2.0, 2.0).is_none());
        // λ = 2γp/sin 2μ.
        let mu = (1.0_f64 / 2.5).asin();
        assert!((lambda(1.3, 2.5) - 2.0 * GAMMA * 1.3 / (2.0 * mu).sin()).abs() < 1e-12);
    }

    #[test]
    fn exponential_moments() {
        for z in [0.0_f64, 1e-6, 0.3, 0.999, 1.0, 4.0, 60.0] {
            let f = phi(z);
            // Composite Simpson on [0, 1].
            let n = 4000;
            for (k, fk) in f.iter().enumerate() {
                let g = |s: f64| s.powi(k as i32) * (-z * s).exp();
                let mut sum = g(0.0) + g(1.0);
                for i in 1..n {
                    sum += g(i as f64 / n as f64) * if i % 2 == 1 { 4.0 } else { 2.0 };
                }
                let simpson = sum / (3.0 * n as f64);
                assert!((fk - simpson).abs() < 1e-10, "z={z} n={k}: {fk} {simpson}");
            }
        }
    }

    #[test]
    fn tangent_bodies() {
        // A cone is one element; with a cylinder, two.
        assert_eq!(cone_cylinder(3.0, 0.0), vec![(0.0, 0.0), (3.0, 0.5)]);
        assert_eq!(
            cone_cylinder(3.0, 7.0),
            vec![(0.0, 0.0), (3.0, 0.5), (10.0, 0.5)]
        );
        // A tangent ogive: ten corners, the last tangent being the cylinder.
        let c = ogive_cylinder(3.0, 4.0);
        assert_eq!(c.len(), 12);
        assert_eq!(c[11], (7.0, 0.5));
        assert!((c[10].1 - 0.5).abs() < 1e-9 && c[10].0 < 3.0 && c[10].0 > 2.7);
        for w in c.windows(2) {
            assert!(w[1].0 > w[0].0 && w[1].1 >= w[0].1);
        }
        // The tangent body lies outside a convex profile.
        let r = ogive_radius(3.0);
        for w in c[..11].windows(2) {
            let xm = 0.5 * (w[0].0 + w[1].0);
            assert!(0.5 * (w[0].1 + w[1].1) >= r(xm) - 1e-12);
        }
        // A concave profile is refused. A blunt one has a tangent body with
        // a near-normal first element, which the flow solution refuses.
        assert!(tangent_body(|x| 0.5 * (x / 2.0).powi(2), 2.0, 0.5, 1.0).is_none());
        let blunt = tangent_body(|x| 0.5 * (x / 2.0).sqrt(), 2.0, 0.5, 1.0).unwrap();
        assert!(shock_expansion(3.0, &blunt).is_none());
    }

    #[test]
    fn cone_alone_is_the_cone_solution() {
        for (f_n, mach) in [(3.0_f64, 2.0_f64), (5.0, 3.0), (2.84, 1.832)] {
            let delta = (0.5 / f_n).atan();
            let (cna, cp) = slope_and_cp(mach, &cone_cylinder(f_n, 0.0));
            let table = cone_normal_force_slope(mach, delta).unwrap();
            assert!((cna - table).abs() < 1e-12, "{cna} {table}");
            assert!((cp - 2.0 * f_n / 3.0).abs() < 1e-12);
        }
    }

    #[test]
    fn cone_cylinder_corner_and_closed_form() {
        let (f_n, f_a, mach) = (3.0_f64, 6.0_f64, 3.0_f64);
        let delta = (0.5 / f_n).atan();
        let f = shock_expansion(mach, &cone_cylinder(f_n, f_a)).unwrap();
        assert_eq!(f.len(), 2);
        let (cone, cyl) = (f[0], f[1]);
        // On the cone: the cone pressure, constant.
        let c = cone_surface(mach, delta).unwrap();
        assert_eq!(cone.pressure(1.0), c.pressure);
        assert_eq!(cone.loading(2.0), cone.cone_loading);
        // Behind the corner: Prandtl-Meyer state, gradient (7) with
        // (∂p/∂s)_1 = 0 and δ_2 = 0, relaxing to free-stream pressure.
        let m2 = mach_after_turn(c.mach, delta).unwrap();
        let p2 = c.pressure * pressure_ratio(m2) / pressure_ratio(c.mach);
        assert!((cyl.m2 - m2).abs() < 1e-14 && (cyl.p2 - p2).abs() < 1e-14);
        assert!(p2 < 1.0 && cyl.p_cone == 1.0);
        let gradient = b_factor(p2, m2) / 0.5 * area_ratio(c.mach) / area_ratio(m2) * delta.sin();
        let h = 1e-7;
        let numeric = (cyl.pressure(f_n + h) - cyl.pressure(f_n)) / h;
        assert!(
            (numeric / gradient - 1.0).abs() < 1e-5,
            "{numeric} {gradient}"
        );
        assert!(cyl.pressure(f_n + 200.0) > 1.0 - 1e-12);
        // Loading: (λ_2/λ_1) Λ_1 at the corner, decaying to zero.
        let load2 = lambda(p2, m2) / lambda(c.pressure, c.mach) * cone.cone_loading;
        assert!((cyl.loading(f_n) - load2).abs() < 1e-14);
        assert_eq!(cyl.cone_loading, 0.0);
        // C_Nα of the afterbody: (2/R)(Λ_2/η')(1 − e^{−η' l_a}), and its CP.
        let k = cyl.rate;
        let closed = 2.0 / 0.5 * load2 / k * (1.0 - (-k * f_a).exp());
        let (cna, moment) = normal_force(&f, f_n, f_n + f_a, 0.5);
        assert!((cna / closed - 1.0).abs() < 1e-12, "{cna} {closed}");
        let arm = 1.0 / k - f_a * (-k * f_a).exp() / (1.0 - (-k * f_a).exp());
        assert!((moment / cna - (f_n + arm)).abs() < 1e-10);
        // The parts add up to the whole.
        let whole = normal_force(&f, 0.0, f_n + f_a, 0.5);
        let nose = normal_force(&f, 0.0, f_n, 0.5);
        assert!((whole.0 - nose.0 - cna).abs() < 1e-12);
        assert!((whole.1 - nose.1 - moment).abs() < 1e-12);
    }

    #[test]
    fn closed_form_integrals_match_quadrature() {
        // An ogive at M 4 has both relaxing and non-trivial elements.
        let c = ogive_cylinder(4.0, 5.0);
        let f = shock_expansion(4.0, &c).unwrap();
        for fr in &f {
            let (xa, xb) = (fr.x2 + 0.2 * (fr.x3 - fr.x2), fr.x2 + 0.9 * (fr.x3 - fr.x2));
            let n = 20_000;
            let h = (xb - xa) / n as f64;
            let (mut s0, mut s1) = (0.0, 0.0);
            for i in 0..=n {
                let x = xa + h * i as f64;
                let w = if i == 0 || i == n {
                    1.0
                } else if i % 2 == 1 {
                    4.0
                } else {
                    2.0
                };
                let g = fr.loading(x) * (fr.r2 + fr.slope * (x - fr.x2));
                s0 += w * g;
                s1 += w * g * x;
            }
            let (force, moment) = fr.load_integrals(xa, xb);
            assert!((force - s0 * h / 3.0).abs() < 1e-10, "{force}");
            assert!((moment - s1 * h / 3.0).abs() < 1e-10, "{moment}");
        }
    }

    #[test]
    fn inapplicable_cases_return_none() {
        // Detached shock on a 35° cone at M 1.6; half-angle above the table.
        assert!(shock_expansion(1.6, &cone_cylinder(0.714, 2.0)).is_none());
        assert!(shock_expansion(4.0, &cone_cylinder(0.8, 2.0)).is_none());
        // Below the first row of the SP-3007 table.
        assert!(shock_expansion(1.4, &cone_cylinder(3.0, 2.0)).is_none());
        // A flare (concave corner) and a blunt start.
        assert!(shock_expansion(3.0, &[(0.0, 0.0), (2.0, 0.3), (3.0, 0.6)]).is_none());
        assert!(shock_expansion(3.0, &[(0.0, 0.1), (2.0, 0.5)]).is_none());
        // A boattail.
        assert!(shock_expansion(3.0, &[(0.0, 0.0), (3.0, 0.5), (5.0, 0.5), (6.0, 0.4)]).is_none());
    }

    struct Row {
        ogive: bool,
        f_n: f64,
        mach: f64,
        f_a: f64,
        cna_so: f64,
        cna_exp: f64,
        xcp_so: f64,
        xcp_exp: f64,
    }

    fn tr1328_rows() -> Vec<Row> {
        let csv = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/validation/naca_tr_1328/naca-tr-1328_tables-I-II_cna-xcp.csv"
        ));
        let rows: Vec<Row> = csv
            .lines()
            .filter(|l| !l.starts_with('#') && !l.starts_with("nose") && !l.trim().is_empty())
            .map(|l| {
                let c: Vec<&str> = l.split(',').collect();
                assert_eq!(c.len(), 8, "{l}");
                let v = |i: usize| c[i].parse::<f64>().expect("number");
                Row {
                    ogive: c[0] == "ogive",
                    f_n: v(1),
                    mach: v(2),
                    f_a: v(3),
                    cna_so: v(4),
                    cna_exp: v(5),
                    xcp_so: v(6),
                    xcp_exp: v(7),
                }
            })
            .collect();
        assert_eq!(rows.len(), 120);
        rows
    }

    /// NACA TR 1328 Tables I and II (pdf pp 23-24): measured C_Nα and CP of
    /// cone- and ogive-cylinders, f_n = 3, 5, 7, f_a = 0..10, M 3.00..6.28,
    /// and the report's own second-order shock-expansion values. Prints the
    /// comparison (`--nocapture`) and holds the error statistics.
    #[test]
    fn tr_1328_tables_i_and_ii() {
        let rows = tr1328_rows();
        // (max |Δ|, Σ Δ², rows beyond ±0.2) against experiment, C_Nα and CP,
        // then against the report's column.
        let mut exp = [(0.0_f64, 0.0_f64, 0_usize); 2];
        let mut rep = [(0.0_f64, 0.0_f64, 0_usize); 2];
        let mut misses = Vec::new();
        for r in &rows {
            let corners = if r.ogive {
                ogive_cylinder(r.f_n, r.f_a)
            } else {
                cone_cylinder(r.f_n, r.f_a)
            };
            let (cna, cp) = slope_and_cp(r.mach, &corners);
            let d_exp = [cna - r.cna_exp, cp - r.xcp_exp];
            let d_rep = [cna - r.cna_so, cp - r.xcp_so];
            for i in 0..2 {
                for (acc, d) in [(&mut exp[i], d_exp[i]), (&mut rep[i], d_rep[i])] {
                    acc.0 = acc.0.max(d.abs());
                    acc.1 += d * d;
                    acc.2 += usize::from(d.abs() > 0.2);
                }
            }
            if d_exp[0].abs() > 0.2 || d_exp[1].abs() > 0.2 {
                misses.push(format!(
                    "{} f_n={} M={} f_a={}: C_Nα {cna:.2} (exp {}, report {}), CP {cp:.2} (exp {}, report {})",
                    if r.ogive { "ogive" } else { "cone" },
                    r.f_n, r.mach, r.f_a, r.cna_exp, r.cna_so, r.xcp_exp, r.xcp_so
                ));
            }
        }
        let n = rows.len() as f64;
        let rms = |a: (f64, f64, usize)| (a.1 / n).sqrt();
        println!(
            "TR 1328 Tables I/II, 120 rows, this model vs experiment and vs the report's column"
        );
        println!(
            "  C_Nα vs experiment: max {:.3}, RMS {:.3}, {} rows beyond ±0.2",
            exp[0].0,
            rms(exp[0]),
            exp[0].2
        );
        println!(
            "  CP   vs experiment: max {:.3} cal, RMS {:.3} cal, {} rows beyond ±0.2",
            exp[1].0,
            rms(exp[1]),
            exp[1].2
        );
        println!(
            "  C_Nα vs report:     max {:.3}, RMS {:.3}, {} rows beyond ±0.2",
            rep[0].0,
            rms(rep[0]),
            rep[0].2
        );
        println!(
            "  CP   vs report:     max {:.3} cal, RMS {:.3} cal, {} rows beyond ±0.2",
            rep[1].0,
            rms(rep[1]),
            rep[1].2
        );
        // The report's own column against experiment, for scale.
        let own = |f: &dyn Fn(&Row) -> f64| {
            let beyond = rows.iter().filter(|r| f(r).abs() > 0.2).count();
            let max = rows.iter().map(|r| f(r).abs()).fold(0.0, f64::max);
            (max, beyond)
        };
        let own_cna = own(&|r| r.cna_so - r.cna_exp);
        let own_cp = own(&|r| r.xcp_so - r.xcp_exp);
        println!(
            "  report vs experiment: C_Nα max {:.2}, {} beyond; CP max {:.2}, {} beyond",
            own_cna.0, own_cna.1, own_cp.0, own_cp.1
        );
        for m in &misses {
            println!("  miss: {m}");
        }
        assert!(exp[0].0.is_finite() && exp[1].0.is_finite());
        assert!(rms(exp[0]) < TR1328_CNA_RMS && rms(exp[1]) < TR1328_CP_RMS);
        assert!(exp[0].2 <= TR1328_CNA_MISSES && exp[1].2 <= TR1328_CP_MISSES);
        assert!(rep[0].0 < TR1328_CNA_VS_REPORT);
    }

    // Ceilings of `tr_1328_tables_i_and_ii`, just above what the model gives
    // (C_Nα RMS 0.090 with 3 rows beyond ±0.2; CP RMS 0.135 cal with 12; the
    // report's own column has 1 and 8). The rows are listed in parity-log,
    // supersonic body lift.
    const TR1328_CNA_RMS: f64 = 0.10;
    const TR1328_CP_RMS: f64 = 0.15;
    const TR1328_CNA_MISSES: usize = 3;
    const TR1328_CP_MISSES: usize = 12;
    /// Largest C_Nα difference from the report's second-order column (0.150).
    const TR1328_CNA_VS_REPORT: f64 = 0.16;

    #[test]
    fn body_lift_table() {
        // 10° cone and 7.16 cal of cylinder in two stretches, d = 30 mm.
        let (d, l_n) = (0.03_f64, 2.84 * 0.03);
        let tubes = [(l_n, 0.18), (0.18, 0.30)];
        let radius = |x: f64| 0.5 * d * x / l_n;
        let b = BodyLift::new(radius, l_n, 0.5 * d, &tubes, 0.9).expect("applies");
        assert_eq!(b.window(), (0.9, 1.5));
        assert_eq!(b.parts(), 3);
        let a_ref = PI * 0.25 * d * d;
        let corners = tangent_body(radius, l_n, 0.5 * d, 0.30 - l_n).unwrap();
        for mach in [1.5, 1.832, 2.375, 3.03, 4.3, 5.9] {
            let f = shock_expansion(mach, &corners).unwrap();
            let ranges = [(0.0, l_n), tubes[0], tubes[1]];
            let mut total = 0.0;
            for (i, &(xa, xb)) in ranges.iter().enumerate() {
                let direct = normal_force(&f, xa, xb, 0.5 * d);
                let table = b.supersonic(i, mach, a_ref);
                assert!((table.0 - direct.0).abs() < 2e-3, "M={mach} part {i}");
                assert!((table.1 - direct.1).abs() < 2e-3 * 0.3, "M={mach} part {i}");
                assert_eq!(b.blended(i, mach, a_ref, (9.0, 9.0)), table);
                total += table.0;
            }
            // Slender-body theory gives 2; the afterbody adds lift.
            assert!(total > 2.5 && total < 3.7, "M={mach}: {total}");
        }
        // Held above the grid; a different reference area rescales.
        assert_eq!(b.supersonic(1, 7.0, a_ref), b.supersonic(1, 6.0, a_ref));
        let twice = b.supersonic(0, 2.0, 2.0 * a_ref);
        assert!((twice.0 * 2.0 - b.supersonic(0, 2.0, a_ref).0).abs() < 1e-14);
        // The blend meets the slender pair with zero slope at the lower end
        // and the table with its slope at the upper end.
        let slender = (2.0, 2.0 * 0.0568);
        assert_eq!(b.blended(0, 0.9, a_ref, slender), slender);
        let h = 1e-6;
        let lo = b.blended(0, 0.9 + h, a_ref, slender);
        assert!((lo.0 - 2.0).abs() < 1e-9);
        let (below, at, above) = (
            b.blended(1, 1.5 - h, a_ref, (0.0, 0.0)),
            b.blended(1, 1.5, a_ref, (0.0, 0.0)),
            b.blended(1, 1.5 + h, a_ref, (0.0, 0.0)),
        );
        let kink = ((above.0 - at.0) - (at.0 - below.0)).abs() / h;
        assert!(kink < 1e-4, "{kink}");
    }

    #[test]
    fn window_follows_the_nose() {
        // A 20° cone has a vertex surface Mach number of 1.15 at M 1.5, so
        // its window ends higher; a 35° cone is outside the table.
        let cone = |deg: f64| {
            let l = 0.5 / deg.to_radians().tan();
            BodyLift::new(move |x| 0.5 * x / l, l, 0.5, &[(l, l + 5.0)], 0.9)
        };
        let b = cone(20.0).unwrap();
        assert!(b.window().1 > 1.5 && b.window().1 < 1.8, "{:?}", b.window());
        assert!(cone(35.0).is_none());
        // Blunt: no tangent body.
        assert!(BodyLift::new(|x| 0.5 * (x / 2.0).sqrt(), 2.0, 0.5, &[], 0.9).is_none());
    }
}
