//! Solids and thin shells of revolution by integration of an rw-geom profile
//! polyline r(x) (Pappus–Guldinus moments).
//!
//! Sources (literature-map MI rows; the general integrals are listed under
//! Gaps item 1, derived from the definitions MI-08):
//! - solid:  dm = ρ π r² dx (MI-05), I_xx = ∫ r²/2 dm, I_yy = ∫ (r²/4 + x²) dm
//! - shell:  dm = σ 2π r ds (MI-07 with σ = ρ t_w), I_xx = ∫ r² dm,
//!   I_yy = ∫ (r²/2 + x²) dm
//! - hollow parts by superposition, outer solid minus cavity (MI-25).
//!
//! Each polyline segment is integrated exactly: along a straight segment the
//! integrands are polynomials of degree ≤ 4 in the segment parameter, and the
//! 3-point Gauss–Legendre rule is exact to degree 5.

use rw_geom::ProfilePoint;

use crate::body::RigidBody;

/// Raw moments of a body of revolution about its own axis (the X axis),
/// origin at station 0. Additive, so cavities subtract (MI-25).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RevMoments {
    /// ∫ dm.
    pub m: f64,
    /// ∫ x dm.
    pub mx: f64,
    /// ∫ x² dm.
    pub mxx: f64,
    /// ∫ (y² + z²) dm, the roll inertia about the axis.
    pub mrr: f64,
}

/// 3-point Gauss–Legendre nodes and weights on [0, 1].
const GL3: [(f64, f64); 3] = [
    (0.112_701_665_379_258_31, 5.0 / 18.0),
    (0.5, 8.0 / 18.0),
    (0.887_298_334_620_741_7, 5.0 / 18.0),
];

impl RevMoments {
    /// Sum (`k = 1`) or difference (`k = -1`) of two moment sets.
    /// cite: amcp-706-280 sec 6-2.2 p 108
    pub fn plus(self, o: RevMoments, k: f64) -> RevMoments {
        RevMoments {
            m: self.m + k * o.m,
            mx: self.mx + k * o.mx,
            mxx: self.mxx + k * o.mxx,
            mrr: self.mrr + k * o.mrr,
        }
    }

    /// All moments times `k` (a density, or a mass normalisation).
    /// cite: niskanen-2009 sec 4.2.3 p 74
    pub fn scaled(self, k: f64) -> RevMoments {
        RevMoments {
            m: self.m * k,
            mx: self.mx * k,
            mxx: self.mxx * k,
            mrr: self.mrr * k,
        }
    }

    /// CG station ∫x dm / m (0 when massless).
    /// cite: mil-hdbk-762 eq 7-28 p 566
    pub fn cg(&self) -> f64 {
        if self.m == 0.0 { 0.0 } else { self.mx / self.m }
    }

    /// Roll inertia I_xx about the axis.
    /// cite: mil-hdbk-762 eq 7-20 p 564
    pub fn ixx(&self) -> f64 {
        self.mrr
    }

    /// Transverse inertia about the CG: I_yy = ∫(x² + z²) dm − m x̄²,
    /// with ∫z² dm = ½∫(y² + z²) dm by axial symmetry.
    /// cite: mil-hdbk-762 eq 7-20 p 564
    /// cite: amcp-706-280 eq 6-1 p 103
    pub fn iyy(&self) -> f64 {
        let c = self.cg();
        self.mxx - self.m * c * c + 0.5 * self.mrr
    }

    /// As a rigid body on the X axis.
    /// cite: niskanen-2009 sec 4.2.3 p 74
    pub fn body(&self) -> RigidBody {
        if self.m == 0.0 {
            return RigidBody::ZERO;
        }
        RigidBody::axisymmetric(self.m, [self.cg(), 0.0, 0.0], self.ixx(), self.iyy())
    }
}

/// Moments of the filled solid under the polyline r(x), per unit density.
/// Vertical steps contribute nothing; segments with dx < 0 subtract.
/// cite: niskanen-2009 eq 3.23 p 33
/// cite: mil-hdbk-762 eq 7-20 p 564
pub fn solid_moments(profile: &[ProfilePoint]) -> RevMoments {
    let pi = std::f64::consts::PI;
    let mut out = RevMoments::default();
    for w in profile.windows(2) {
        let (a, b) = (w[0], w[1]);
        let dx = b.x - a.x;
        if dx == 0.0 {
            continue;
        }
        let dr = b.r - a.r;
        for (s, wt) in GL3 {
            let x = a.x + s * dx;
            let r = a.r + s * dr;
            let dm = wt * pi * r * r * dx;
            out.m += dm;
            out.mx += x * dm;
            out.mxx += x * x * dm;
            out.mrr += 0.5 * r * r * dm;
        }
    }
    out
}

/// Moments of the filled solid under an analytic curve, per unit density.
/// `r(ξ)` is the radius at distance ξ ∈ [0, len] from the tip end, which may
/// have an infinite slope (ellipsoid, power, Haack). The tip sits at station
/// `x0` (`tip_at_fore`) or `x0 + len`. Frusta on the tip-clustered grid
/// ξ = len·u² for n and 2n segments, then one Richardson step (the same
/// scheme rw-geom uses for the enclosed volume).
/// cite: niskanen-2009 eq 3.23 p 33
/// cite: mil-hdbk-762 eq 7-20 p 564
pub fn curve_solid_moments(
    r: impl Fn(f64) -> f64,
    x0: f64,
    len: f64,
    tip_at_fore: bool,
) -> RevMoments {
    const N: usize = 1024;
    if len <= 0.0 {
        return RevMoments::default();
    }
    let grid = |n: usize| {
        let mut v: Vec<ProfilePoint> = (0..=n)
            .map(|k| {
                let u = k as f64 / n as f64;
                let xi = len * u * u;
                let x = if tip_at_fore { x0 + xi } else { x0 + len - xi };
                ProfilePoint {
                    x,
                    r: r(xi).max(0.0),
                }
            })
            .collect();
        if !tip_at_fore {
            v.reverse();
        }
        v
    };
    let (f, c) = (solid_moments(&grid(2 * N)), solid_moments(&grid(N)));
    f.scaled(4.0 / 3.0).plus(c, -1.0 / 3.0)
}

/// Moments of the thin shell traced by the polyline (including vertical
/// steps, which are annular faces), per unit areal density σ = ρ t_w.
/// cite: amcp-706-280 sec 6-2.1 p 103
/// cite: mil-hdbk-762 eq 7-20 p 564
pub fn shell_moments(profile: &[ProfilePoint]) -> RevMoments {
    let tau = std::f64::consts::TAU;
    let mut out = RevMoments::default();
    for w in profile.windows(2) {
        let (a, b) = (w[0], w[1]);
        let (dx, dr) = (b.x - a.x, b.r - a.r);
        let len = dx.hypot(dr);
        if len == 0.0 {
            continue;
        }
        for (s, wt) in GL3 {
            let x = a.x + s * dx;
            let r = (a.r + s * dr).abs();
            let dm = wt * tau * r * len;
            out.m += dm;
            out.mx += x * dm;
            out.mxx += x * x * dm;
            out.mrr += r * r * dm;
        }
    }
    out
}

/// Material between an outer profile and a cavity profile, per unit density:
/// solid(outer) − solid(inner) (MI-25).
/// cite: amcp-706-280 sec 6-2.2 p 108
pub fn hollow_moments(outer: &[ProfilePoint], inner: &[ProfilePoint]) -> RevMoments {
    solid_moments(outer).plus(solid_moments(inner), -1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, r: f64) -> ProfilePoint {
        ProfilePoint { x, r }
    }

    fn rel(a: f64, b: f64) -> f64 {
        (a - b).abs() / b.abs().max(1e-300)
    }

    #[test]
    fn solid_cylinder() {
        let (r, l) = (0.3, 2.0);
        let m = solid_moments(&[p(1.0, r), p(1.0 + l, r)]);
        let mass = std::f64::consts::PI * r * r * l;
        assert!(rel(m.m, mass) < 1e-14);
        assert!(rel(m.cg(), 2.0) < 1e-14);
        assert!(rel(m.ixx(), mass * r * r / 2.0) < 1e-14);
        assert!(rel(m.iyy(), mass * (3.0 * r * r + l * l) / 12.0) < 1e-12);
    }

    #[test]
    fn thin_cylinder_shell() {
        let (r, l) = (0.3, 2.0);
        let m = shell_moments(&[p(0.0, r), p(l, r)]);
        let mass = std::f64::consts::TAU * r * l;
        assert!(rel(m.m, mass) < 1e-14);
        assert!(rel(m.ixx(), mass * r * r) < 1e-14);
        // MI-19 thin-tube limit: m (r²/2 + l²/12).
        assert!(rel(m.iyy(), mass * (r * r / 2.0 + l * l / 12.0)) < 1e-12);
    }
}
