//! Fin cross-sections: how the thickness of a fin plate varies along the
//! chord for each `FinCrossSection`, and the volume and thickness-weighted
//! area moments that follow. rw-mass builds the fin's rigid body from the
//! same moments, so volume, mass and centre of mass agree.
//!
//! What `thickness` means for each section:
//! - square: constant thickness, blunt edges.
//! - rounded: constant thickness with half-round leading and trailing edges.
//! - airfoil: the symmetric four-digit thickness distribution of NACA Report
//!   460; `thickness` is the maximum thickness (at 30 % chord).
//! - wedge: zero at the leading edge, linear to `thickness` at a blunt
//!   trailing edge.
//!
//! The fin tab is a slab of the full thickness for every section.

use std::f64::consts::FRAC_PI_4;

use rw_model::FinCrossSection;

/// Coefficients a_0..a_4 of the NACA four-digit thickness form for a 20 %
/// thick section, ±y = a_0 √x + a_1 x + a_2 x² + a_3 x³ + a_4 x⁴ (chord 1),
/// as printed, with the open trailing edge (ordinate 0.0021 at x = 1).
pub const NACA_THICKNESS_COEFFS: [f64; 5] = [0.29690, -0.12600, -0.35160, 0.28430, -0.10150];

/// Full thickness of the NACA four-digit symmetric section over its maximum
/// thickness, τ(ξ) = 2 y_t/t = 10 (a_0 √ξ + a_1 ξ + a_2 ξ² + a_3 ξ³ + a_4 ξ⁴),
/// ξ the chord fraction from the leading edge. The report scales the 20 %
/// ordinates by t/0.20; two faces make the factor 2/0.20 = 10. τ is 1.0003 at
/// ξ = 0.3 and 0.021 at the trailing edge.
/// cite: naca-report-460 eq yt p 6
pub fn airfoil_thickness(xi: f64) -> f64 {
    let x = xi.clamp(0.0, 1.0);
    let [a0, a1, a2, a3, a4] = NACA_THICKNESS_COEFFS;
    10.0 * (a0 * x.sqrt() + x * (a1 + x * (a2 + x * (a3 + x * a4))))
}

/// Thickness of a section over its nominal `thickness` at chord fraction ξ
/// from the leading edge: 1 for the constant-thickness sections (square,
/// rounded; the rounded edges are taken off as a volume factor,
/// [`rounded_plate_factor`]), ξ for a wedge, [`airfoil_thickness`] for an
/// airfoil.
/// cite: naca-report-460 eq yt p 6
pub fn section_thickness(section: FinCrossSection, xi: f64) -> f64 {
    match section {
        FinCrossSection::Square | FinCrossSection::Rounded => 1.0,
        FinCrossSection::Wedge => xi.clamp(0.0, 1.0),
        FinCrossSection::Airfoil => airfoil_thickness(xi),
    }
}

/// Volume of a plate with half-round leading and trailing edges over the
/// volume of the square-edged plate: k = 1 − (1 − π/4) t s / A_fin, at least
/// π/4. A half-round edge of radius t/2 removes the two corners of the
/// square edge, t²/2 − π t²/8 per unit length of edge; the leading and
/// trailing edges together remove (1 − π/4) t² per unit span, so the section
/// of chord c has area t c − (1 − π/4) t², and the plate
/// t A_fin − (1 − π/4) t² s. The edge lengths are measured along the span
/// (sweep and the tip edge are not counted). The floor π/4 is the round rod
/// a plate becomes when its chord equals its thickness.
/// cite: n/a derived (rectangle minus the corners outside two half-round edges)
pub fn rounded_plate_factor(thickness: f64, span: f64, area: f64) -> f64 {
    if area <= 0.0 || thickness <= 0.0 {
        return 1.0;
    }
    (1.0 - (1.0 - FRAC_PI_4) * thickness * span / area).max(FRAC_PI_4)
}

/// Thickness-weighted area moments of a fin planform whose thickness is
/// t τ(ξ) along each chord: `a` = ∫∫ τ dx dy (the volume is t·`a`), the first
/// and second moments of the same weight in the planform frame, and
/// `a3` = ∫∫ τ³ dx dy (the second moment across the thickness is
/// t³·`a3`/12).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ProfileMoments {
    pub a: f64,
    pub ax: f64,
    pub ay: f64,
    pub axx: f64,
    pub ayy: f64,
    pub axy: f64,
    pub a3: f64,
}

/// Gauss-Legendre nodes and weights on [−1, 1] (Newton iteration on P_n).
fn gauss_legendre(n: usize) -> Vec<(f64, f64)> {
    (0..n)
        .map(|i| {
            let mut x = (std::f64::consts::PI * (i as f64 + 0.75) / (n as f64 + 0.5)).cos();
            let mut dp = 1.0;
            for _ in 0..100 {
                let (mut p0, mut p1) = (1.0, x);
                for k in 2..=n {
                    let kf = k as f64;
                    let p2 = ((2.0 * kf - 1.0) * x * p1 - (kf - 1.0) * p0) / kf;
                    p0 = p1;
                    p1 = p2;
                }
                dp = n as f64 * (x * p1 - p0) / (x * x - 1.0);
                let dx = p1 / dp;
                x -= dx;
                if dx.abs() < 1e-15 {
                    break;
                }
            }
            (x, 2.0 / ((1.0 - x * x) * dp * dp))
        })
        .collect()
}

/// Chordwise integrals of a thickness profile over ξ ∈ [ξ_a, ξ_b]:
/// [∫τ dξ, ∫ξ τ dξ, ∫ξ² τ dξ, ∫τ³ dξ], by 16-point Gauss-Legendre in
/// u = √ξ, which is exact for the sections here (polynomials in u of degree
/// at most 25 after the substitution).
/// cite: n/a numerical quadrature (Gauss-Legendre in the square root of the chord fraction)
pub fn chord_integrals(tau: impl Fn(f64) -> f64, xi_a: f64, xi_b: f64) -> [f64; 4] {
    let (ua, ub) = (xi_a.clamp(0.0, 1.0).sqrt(), xi_b.clamp(0.0, 1.0).sqrt());
    let half = 0.5 * (ub - ua);
    let mut out = [0.0; 4];
    if half <= 0.0 {
        return out;
    }
    for (g, w) in gauss_legendre(16) {
        let u = ua + half * (1.0 + g);
        let xi = u * u;
        let t = tau(xi);
        let k = w * half * 2.0 * u;
        out[0] += k * t;
        out[1] += k * xi * t;
        out[2] += k * xi * xi * t;
        out[3] += k * t * t * t;
    }
    out
}

/// [`ProfileMoments`] of a simple planform polygon (`[x, y]`, y up the span)
/// for the thickness profile τ(ξ), ξ running from the leading to the trailing
/// edge of each spanwise strip. A strip of leading edge x_LE and chord c
/// contributes c ∫τ dξ to `a`, c (x_LE ∫τ + c ∫ξτ) to `ax` and
/// c (x_LE² ∫τ + 2 x_LE c ∫ξτ + c² ∫ξ²τ) to `axx`. Between vertex heights
/// x_LE and c are linear in y, so three Gauss points per band integrate the
/// span exactly. Where a strip crosses the outline more than twice (a notched
/// freeform fin) the profile runs over the strip's whole extent and only the
/// covered parts count.
/// cite: n/a pure geometry (strip integration of a thickness profile over a polygon)
pub fn profile_moments(poly: &[[f64; 2]], tau: impl Fn(f64) -> f64) -> ProfileMoments {
    let mut m = ProfileMoments::default();
    let n = poly.len();
    if n < 3 {
        return m;
    }
    let mut ys: Vec<f64> = poly.iter().map(|p| p[1]).collect();
    ys.sort_by(f64::total_cmp);
    ys.dedup_by(|a, b| (*a - *b).abs() <= 1e-15);
    let full = chord_integrals(&tau, 0.0, 1.0);
    let g = 0.6_f64.sqrt();
    let gauss = [(-g, 5.0 / 9.0), (0.0, 8.0 / 9.0), (g, 5.0 / 9.0)];
    let mut xs: Vec<f64> = Vec::new();
    for band in ys.windows(2) {
        let h = band[1] - band[0];
        if h <= 0.0 {
            continue;
        }
        for (node, weight) in gauss {
            let y = band[0] + 0.5 * h * (1.0 + node);
            let wy = 0.5 * h * weight;
            xs.clear();
            for i in 0..n {
                let (a, b) = (poly[i], poly[(i + 1) % n]);
                if (a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y) {
                    let t = (y - a[1]) / (b[1] - a[1]);
                    xs.push(a[0] + t * (b[0] - a[0]));
                }
            }
            xs.sort_by(f64::total_cmp);
            if xs.len() < 2 {
                continue;
            }
            let (lo, c) = (xs[0], xs[xs.len() - 1] - xs[0]);
            if c <= 0.0 {
                continue;
            }
            for pair in xs.chunks_exact(2) {
                let i = if xs.len() == 2 {
                    full
                } else {
                    chord_integrals(&tau, (pair[0] - lo) / c, (pair[1] - lo) / c)
                };
                let m0 = c * i[0];
                let mx = c * (lo * i[0] + c * i[1]);
                let mxx = c * (lo * lo * i[0] + 2.0 * lo * c * i[1] + c * c * i[2]);
                m.a += wy * m0;
                m.ax += wy * mx;
                m.ay += wy * y * m0;
                m.axx += wy * mxx;
                m.ayy += wy * y * y * m0;
                m.axy += wy * y * mx;
                m.a3 += wy * c * i[3];
            }
        }
    }
    m
}

/// Volume of one fin plate (planform only, no tab) of the given section:
/// t A_fin for square, [`rounded_plate_factor`] times that for rounded, and
/// t ∫∫τ dA ([`profile_moments`]) for wedge and airfoil: half the slab for a
/// wedge and 0.68508 of it for an airfoil, on any planform.
/// cite: amcp-706-280 tab 6-1 p 104
/// cite: naca-report-460 eq yt p 6
pub fn section_plate_volume(
    section: FinCrossSection,
    planform: &[[f64; 2]],
    area: f64,
    span: f64,
    thickness: f64,
) -> f64 {
    match section {
        FinCrossSection::Square => area * thickness,
        FinCrossSection::Rounded => rounded_plate_factor(thickness, span, area) * area * thickness,
        FinCrossSection::Wedge | FinCrossSection::Airfoil => {
            thickness * profile_moments(planform, |xi| section_thickness(section, xi)).a
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * b.abs().max(1e-300)
    }

    #[test]
    fn airfoil_polynomial_integrals_match_hand_values() {
        // Term by term from the printed coefficients, times 10:
        // ∫τ   = 10 (a0·2/3 + a1/2 + a2/3 + a3/4 + a4/5)
        //      = 10 (0.19793333 − 0.063 − 0.1172 + 0.071075 − 0.0203) = 0.6850833
        // ∫ξτ  = 10 (a0·2/5 + a1/3 + a2/4 + a3/5 + a4/6)
        //      = 10 (0.11876 − 0.042 − 0.0879 + 0.05686 − 0.01691667) = 0.2880333
        // ∫ξ²τ = 10 (a0·2/7 + a1/4 + a2/5 + a3/6 + a4/7)
        //      = 10 (0.08482857 − 0.0315 − 0.07032 + 0.04738333 − 0.0145) = 0.1589190
        let i = chord_integrals(airfoil_thickness, 0.0, 1.0);
        assert!((i[0] - 0.685_083_3).abs() < 1e-7, "{}", i[0]);
        assert!((i[1] - 0.288_033_3).abs() < 1e-7, "{}", i[1]);
        assert!((i[2] - 0.158_919_0).abs() < 1e-7, "{}", i[2]);
        // Centroid 0.2880333/0.6850833 = 0.42043 of the chord from the LE.
        assert!((i[1] / i[0] - 0.420_435).abs() < 1e-6);
        // Printed conditions: ordinate 0.1 at 0.3 chord and 0.002 at the
        // trailing edge of the 20 % section, so τ = 1.00 and 0.021.
        assert!((airfoil_thickness(0.3) - 1.0).abs() < 5e-4);
        assert!((airfoil_thickness(1.0) - 0.021).abs() < 1e-12);
        assert_eq!(airfoil_thickness(0.0), 0.0);
        // ∫τ³ against a plain midpoint sum in u = √ξ.
        let n = 200_000;
        let mut s = 0.0;
        for k in 0..n {
            let u = (k as f64 + 0.5) / n as f64;
            s += airfoil_thickness(u * u).powi(3) * 2.0 * u / n as f64;
        }
        assert!((i[3] - s).abs() < 1e-9, "{} vs {s}", i[3]);
    }

    #[test]
    fn wedge_integrals_are_the_triangle() {
        let w = |xi: f64| section_thickness(FinCrossSection::Wedge, xi);
        let i = chord_integrals(w, 0.0, 1.0);
        for (got, hand) in i.iter().zip([0.5, 1.0 / 3.0, 0.25, 0.25]) {
            assert!(close(*got, hand, 1e-14), "{got} vs {hand}");
        }
        // Part of the chord: ∫ξ dξ over [0.2, 0.6] = 0.16.
        assert!(close(chord_integrals(w, 0.2, 0.6)[0], 0.16, 1e-14));
    }

    #[test]
    fn rectangular_wedge_moments() {
        // c = 0.2, s = 0.1, LE at x = 1.0: a = c s/2, centroid at
        // x_LE + 2c/3, ∫(x − x̄)² = a c²/18, a3 = c s/4.
        let (x0, c, s) = (1.0, 0.2, 0.1);
        let poly = [[x0, 0.0], [x0 + c, 0.0], [x0 + c, s], [x0, s]];
        let m = profile_moments(&poly, |xi| xi);
        assert!(close(m.a, c * s / 2.0, 1e-14));
        let xbar = m.ax / m.a;
        assert!(close(xbar, x0 + 2.0 * c / 3.0, 1e-14));
        assert!(close(m.ay / m.a, s / 2.0, 1e-14));
        assert!(close(m.axx - m.a * xbar * xbar, m.a * c * c / 18.0, 1e-11));
        assert!(close(m.ayy, m.a * s * s / 3.0, 1e-13));
        assert!(close(m.axy, m.ax * s / 2.0, 1e-13));
        assert!(close(m.a3, c * s / 4.0, 1e-14));
    }

    #[test]
    fn uniform_profile_reproduces_polygon_moments_of_a_swept_trapezoid() {
        // c_r = 0.12, c_t = 0.06, s = 0.08, sweep 0.05: area 0.0072.
        let poly = crate::fins::trapezoid_planform(0.3, 0.12, 0.06, 0.08, 0.05);
        let m = profile_moments(&poly, |_| 1.0);
        assert!(close(m.a, 0.0072, 1e-14));
        // Spanwise centroid (s/3)(c_r + 2 c_t)/(c_r + c_t) = 0.0355556.
        assert!(close(m.ay / m.a, 0.08 / 3.0 * 0.24 / 0.18, 1e-13));
        // Wedge on the same planform is half the slab; airfoil 0.68508.
        let w = profile_moments(&poly, |xi| xi);
        assert!(close(w.a, 0.0036, 1e-14));
        let a = profile_moments(&poly, airfoil_thickness);
        assert!((a.a / m.a - 0.685_083_3).abs() < 1e-7);
        // Pointed tip (c_t = 0) integrates too.
        let tri = crate::fins::trapezoid_planform(0.0, 0.1, 0.0, 0.05, 0.03);
        assert!(close(profile_moments(&tri, |xi| xi).a, 0.00125, 1e-13));
    }

    #[test]
    fn notched_planform_counts_only_the_covered_chord() {
        // A 0.2 × 0.1 rectangle with a 0.1 × 0.05 notch cut into the tip
        // between x = 0.05 and 0.15: slab area 0.02 − 0.005 = 0.015. The
        // wedge profile runs over the whole 0.2 extent, so the notch removes
        // ∫ξ dξ over [0.25, 0.75] = 0.25 of the strip's chord: a =
        // 0.2·0.1/2 − 0.05·0.2·0.25 = 0.0075.
        let poly = [
            [0.0, 0.0],
            [0.2, 0.0],
            [0.2, 0.1],
            [0.15, 0.1],
            [0.15, 0.05],
            [0.05, 0.05],
            [0.05, 0.1],
            [0.0, 0.1],
        ];
        assert!(close(profile_moments(&poly, |_| 1.0).a, 0.015, 1e-13));
        assert!(close(profile_moments(&poly, |xi| xi).a, 0.0075, 1e-13));
    }

    #[test]
    fn rounded_factor_and_section_volumes() {
        // t = 3 mm, c = 60 mm, s = 50 mm rectangle: k = 1 − 0.2146018·0.003/0.06
        // = 0.9892699.
        let (t, c, s) = (0.003, 0.06, 0.05);
        let k = rounded_plate_factor(t, s, c * s);
        assert!((k - 0.989_269_9).abs() < 1e-7, "{k}");
        // The section area is the stadium: t c − (1 − π/4) t².
        assert!(close(k * t * c, t * c - (1.0 - FRAC_PI_4) * t * t, 1e-14));
        // Chord equal to the thickness: a round rod, π/4; never below it.
        assert!(close(rounded_plate_factor(t, s, t * s), FRAC_PI_4, 1e-14));
        assert_eq!(rounded_plate_factor(t, s, 0.1 * t * s), FRAC_PI_4);
        assert_eq!(rounded_plate_factor(0.0, s, c * s), 1.0);
        let poly = [[0.0, 0.0], [c, 0.0], [c, s], [0.0, s]];
        let vol = |sec| section_plate_volume(sec, &poly, c * s, s, t);
        assert_eq!(vol(FinCrossSection::Square), c * s * t);
        assert!(close(vol(FinCrossSection::Rounded), k * c * s * t, 1e-15));
        assert!(close(vol(FinCrossSection::Wedge), 0.5 * c * s * t, 1e-14));
        assert!((vol(FinCrossSection::Airfoil) / (c * s * t) - 0.685_083_3).abs() < 1e-7);
    }
}
