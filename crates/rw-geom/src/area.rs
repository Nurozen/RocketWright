//! Volumes, wetted (lateral) areas, and planform (side-projected) areas of
//! solids of revolution (R4.1). Polylines integrate exactly as stacks of
//! frusta; analytic curves use frusta on a tip-clustered grid plus one
//! Richardson step, which stays accurate at the infinite-slope tips of the
//! ellipsoid, power, and Haack shapes.

use crate::types::ProfilePoint;

/// Integrated metrics of a solid of revolution.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RevMetrics {
    /// Enclosed volume π∫r² dx.
    pub volume: f64,
    /// Lateral surface area 2π∫r ds (end faces excluded).
    pub wetted_area: f64,
    /// Side-projected area ∫2r dx.
    pub planform_area: f64,
}

impl RevMetrics {
    fn add(self, o: RevMetrics) -> RevMetrics {
        RevMetrics {
            volume: self.volume + o.volume,
            wetted_area: self.wetted_area + o.wetted_area,
            planform_area: self.planform_area + o.planform_area,
        }
    }
}

/// Volume of a conical frustum of axial length `dx` between radii `r0`, `r1`:
/// V = (π dx/3)(r0² + r0 r1 + r1²).
/// cite: amcp-706-280 tab 6-1 p 104
pub fn frustum_volume(dx: f64, r0: f64, r1: f64) -> f64 {
    std::f64::consts::PI * dx * (r0 * r0 + r0 * r1 + r1 * r1) / 3.0
}

/// Lateral area of a conical frustum: A = π (r0 + r1) sqrt(dx² + (r1 - r0)²).
/// With `dx = 0` it is the annulus π|r1² - r0²|.
/// cite: amcp-706-280 tab 6-1 p 104
pub fn frustum_lateral_area(dx: f64, r0: f64, r1: f64) -> f64 {
    std::f64::consts::PI * (r0 + r1) * dx.hypot(r1 - r0)
}

/// Annular cylinder (tube) metrics: V = π (r_o² - r_i²) l, outside lateral area
/// 2π r_o l, side projection 2 r_o l.
/// cite: amcp-706-280 tab 6-1 p 104
pub fn tube_metrics(len: f64, r_outer: f64, r_inner: f64) -> RevMetrics {
    let pi = std::f64::consts::PI;
    RevMetrics {
        volume: pi * (r_outer * r_outer - r_inner * r_inner) * len,
        wetted_area: 2.0 * pi * r_outer * len,
        planform_area: 2.0 * r_outer * len,
    }
}

/// Metrics of a polyline profile r(x) (fore to aft, vertical steps allowed),
/// summed frustum by frustum: V = π∫r² dx (3.23), planform ∫2r dx.
/// Segments with dx < 0 contribute negatively, so callers pass x non-decreasing.
/// cite: niskanen-2009 eq 3.23 p 33
pub fn polyline_metrics(points: &[ProfilePoint]) -> RevMetrics {
    let mut m = RevMetrics::default();
    for w in points.windows(2) {
        let (a, b) = (w[0], w[1]);
        let dx = b.x - a.x;
        m.volume += frustum_volume(dx, a.r, b.r);
        m.wetted_area += frustum_lateral_area(dx.abs(), a.r, b.r);
        m.planform_area += dx * (a.r + b.r);
    }
    m
}

/// Metrics of an analytic curve r(ξ), ξ in [0, len] from the tip end, where
/// the slope may be infinite at ξ = 0. Frusta on the grid ξ = len·u²
/// (uniform u) for n and 2n segments, then Richardson (4 M_2n - M_n)/3.
/// cite: niskanen-2009 eq 3.27 p 34
pub fn curve_metrics(r: impl Fn(f64) -> f64, len: f64) -> RevMetrics {
    const N: usize = 1024;
    if len <= 0.0 {
        return RevMetrics::default();
    }
    let fine: Vec<ProfilePoint> = (0..=2 * N)
        .map(|k| {
            let u = k as f64 / (2 * N) as f64;
            let xi = len * u * u;
            ProfilePoint { x: xi, r: r(xi) }
        })
        .collect();
    let coarse: Vec<ProfilePoint> = fine.iter().step_by(2).copied().collect();
    let (f, c) = (polyline_metrics(&fine), polyline_metrics(&coarse));
    let rich = |a: f64, b: f64| (4.0 * a - b) / 3.0;
    RevMetrics {
        volume: rich(f.volume, c.volume),
        wetted_area: rich(f.wetted_area, c.wetted_area),
        planform_area: rich(f.planform_area, c.planform_area),
    }
}

/// Sum of metrics of several pieces (e.g. a nose plus its shoulder).
/// cite: n/a additive bookkeeping, no physics
pub fn sum_metrics(parts: &[RevMetrics]) -> RevMetrics {
    parts.iter().fold(RevMetrics::default(), |a, b| a.add(*b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nose::*;
    use std::f64::consts::PI;

    fn close(a: f64, b: f64, rel: f64) -> bool {
        (a - b).abs() <= rel * b.abs().max(1e-30)
    }

    #[test]
    fn cone_is_exact() {
        // amcp-706-280 tab 6-1: A = π r sqrt(r² + l²), V = π r² l / 3.
        let (l, r) = (0.3, 0.05);
        let m = curve_metrics(|x| conical_radius(l, r, x), l);
        assert!(close(m.volume, PI * r * r * l / 3.0, 1e-12));
        assert!(close(m.wetted_area, PI * r * (r * r + l * l).sqrt(), 1e-12));
        assert!(close(m.planform_area, r * l, 1e-12));
    }

    #[test]
    fn ellipsoid_matches_half_spheroid() {
        // Half prolate spheroid (semi-axes l > r): V = 2πr²l/3,
        // lateral A = πr² (1 + l asin(e) / (r e)), e = sqrt(1 - r²/l²); planform πrl/2.
        let (l, r) = (0.2, 0.03);
        let m = curve_metrics(|x| ellipsoid_radius(l, r, x), l);
        let e = (1.0 - r * r / (l * l)).sqrt();
        assert!(
            close(m.volume, 2.0 * PI * r * r * l / 3.0, 1e-9),
            "{}",
            m.volume
        );
        assert!(close(
            m.wetted_area,
            PI * r * r * (1.0 + l * e.asin() / (r * e)),
            1e-8
        ));
        assert!(close(m.planform_area, PI * r * l / 2.0, 1e-8));
        // r = l: hemisphere, A = 2πr², V = 2πr³/3.
        let h = curve_metrics(|x| ellipsoid_radius(0.05, 0.05, x), 0.05);
        assert!(close(h.wetted_area, 2.0 * PI * 0.05 * 0.05, 1e-8));
        assert!(close(h.volume, 2.0 * PI * 0.05_f64.powi(3) / 3.0, 1e-9));
    }

    #[test]
    fn half_power_is_a_paraboloid() {
        // amcp-706-280 tab 6-1 (paraboloid): V = π l r²/2,
        // A = (4π r/(3 l²)) [(r²/4 + l²)^{3/2} - (r/2)³]; planform ∫2r = 4rl/3.
        let (l, r) = (0.15, 0.04);
        let m = curve_metrics(|x| power_radius(l, r, 0.5, x), l);
        assert!(close(m.volume, PI * l * r * r / 2.0, 1e-10));
        let a =
            4.0 * PI * r / (3.0 * l * l) * ((r * r / 4.0 + l * l).powf(1.5) - (r / 2.0).powi(3));
        assert!(close(m.wetted_area, a, 1e-9), "{} vs {a}", m.wetted_area);
        assert!(close(m.planform_area, 4.0 * r * l / 3.0, 1e-9));
    }

    #[test]
    fn full_parabola() {
        // r = R u (2 - u): V = π R² l ∫(2u - u²)² du = 8πR²l/15; planform 4Rl/3.
        let (l, r) = (0.25, 0.04);
        let m = curve_metrics(|x| parabolic_radius(l, r, 1.0, x), l);
        assert!(close(m.volume, 8.0 * PI * r * r * l / 15.0, 1e-10));
        assert!(close(m.planform_area, 4.0 * r * l / 3.0, 1e-10));
    }

    #[test]
    fn haack_volume() {
        // With x = l(1 - cos θ)/2: V = (r² l/2) ∫₀^π (θ - sin2θ/2 + C sin³θ) sinθ dθ
        //   = π r² l (1/2 + 3C/16).
        let (l, r) = (0.3, 0.035);
        for c in [0.0, 1.0 / 3.0] {
            let m = curve_metrics(|x| haack_radius(l, r, c, x), l);
            let v = PI * r * r * l * (0.5 + 3.0 * c / 16.0);
            assert!(close(m.volume, v, 1e-7), "C={c}: {} vs {v}", m.volume);
        }
    }

    #[test]
    fn tangent_ogive_volume_and_area() {
        // Barrowman 1967 (3-90), corrected per the equation sheet (MI-06): the
        // printed right-hand side equals V/(π d³), not V/(d A(L)).
        let (l, r) = (0.22_f64, 0.027_f64);
        let d = 2.0 * r;
        let f = l / d;
        let q = f * f + 0.25;
        let rhs = f * q * q - f.powi(3) / 3.0 - (f * f - 0.25) * q * q * (f / q).asin();
        let m = curve_metrics(|x| ogive_radius(l, r, 1.0, x), l);
        assert!(
            close(m.volume, PI * d.powi(3) * rhs, 1e-9),
            "{} vs {}",
            m.volume,
            PI * d.powi(3) * rhs
        );
        // Lateral area of a circle-arc profile: centre (l, r - ρ), ρ = (r² + l²)/(2r);
        // A = 2πρ [(r - ρ) φ_t + ρ sin φ_t], cos φ_t = (ρ - r)/ρ.
        let rho = (r * r + l * l) / (2.0 * r);
        let phi = ((rho - r) / rho).acos();
        let a = 2.0 * PI * rho * ((r - rho) * phi + rho * phi.sin());
        assert!(close(m.wetted_area, a, 1e-9), "{} vs {a}", m.wetted_area);
    }

    #[test]
    fn frustum_and_tube() {
        // amcp-706-280 tab 6-1 frustum.
        let (l, r0, r1) = (0.1, 0.02, 0.035);
        let m = polyline_metrics(&[ProfilePoint { x: 0.0, r: r0 }, ProfilePoint { x: l, r: r1 }]);
        assert!(close(
            m.volume,
            PI * l / 3.0 * (r0 * r0 + r1 * r1 + r0 * r1),
            1e-14
        ));
        assert!(close(
            m.wetted_area,
            PI * (r0 + r1) * (l * l + (r0 - r1).powi(2)).sqrt(),
            1e-14
        ));
        assert!(close(m.planform_area, l * (r0 + r1), 1e-14));
        let t = tube_metrics(0.3, 0.027, 0.0259);
        assert!(close(
            t.volume,
            PI * (0.027_f64.powi(2) - 0.0259_f64.powi(2)) * 0.3,
            1e-14
        ));
        assert!(close(t.wetted_area, 2.0 * PI * 0.027 * 0.3, 1e-14));
        assert!(close(t.planform_area, 0.054 * 0.3, 1e-14));
        let s = sum_metrics(&[t, t]);
        assert!(close(s.volume, 2.0 * t.volume, 1e-15));
    }
}
