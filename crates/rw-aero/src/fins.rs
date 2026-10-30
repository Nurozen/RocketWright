//! Fin-set normal force and CP (Barrowman 1967 as extended by Niskanen 2009):
//! single-fin C_Nα (Diederich subsonic, Busemann supersonic), the N-fin
//! factor, fin–body interference K_T(B), and the Mach-dependent fin CP.
//! Notation follows `docs/dev/literature-map.md`.

use std::f64::consts::PI;

use rw_geom::{FinGeometry, fins::planform_stats};
use rw_model::FinCrossSection;

use crate::mach::{beta, busemann, transonic_blend};

/// Number of spanwise strips used for the strip sums (sweep angles, roll damping).
pub(crate) const STRIPS: usize = 200;

/// One spanwise strip of a fin: radial distance of its centre from the body
/// axis ξ, chord c, and width Δξ.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Strip {
    pub xi: f64,
    pub chord: f64,
    pub width: f64,
}

/// Planform quantities of one fin set used by the aero terms.
#[derive(Debug, Clone, PartialEq)]
pub struct FinPlanform {
    pub count: u32,
    /// One-sided area of one fin A_fin.
    pub area: f64,
    pub span: f64,
    pub root_chord: f64,
    pub tip_chord: f64,
    /// Mean aerodynamic chord c̄.
    pub mac: f64,
    /// Spanwise MAC position from the root.
    pub y_mac: f64,
    /// Station of the MAC leading edge (m from the nose tip).
    pub x_mac_le: f64,
    /// Station of the root leading edge.
    pub x_root_le: f64,
    /// Mid-chord sweep Γ_c (strip-averaged for non-trapezoids).
    pub gamma_c: f64,
    /// Leading-edge sweep Γ_L (strip-averaged).
    pub gamma_le: f64,
    pub thickness: f64,
    pub cross_section: FinCrossSection,
    pub cant: f64,
    /// Body radius at the root r_t.
    pub r_t: f64,
    pub strips: Vec<Strip>,
}

impl FinPlanform {
    /// Planform quantities from the fin geometry (IF3). Sweep angles are the
    /// mean of the strip-to-strip angles, which equals the natural angle for
    /// trapezoidal and elliptical fins (niskanen-2009 p 29).
    /// cite: niskanen-2009 eq 3.30 p 36
    pub fn from_geometry(fg: &FinGeometry) -> Self {
        let st = planform_stats(&fg.planform);
        let s = st.span;
        let x_root_le = fg
            .planform
            .iter()
            .filter(|p| p[1].abs() < 1e-12)
            .map(|p| p[0])
            .fold(f64::INFINITY, f64::min);
        let mut strips = Vec::with_capacity(STRIPS);
        let (mut sum_c, mut sum_l, mut n_ang) = (0.0, 0.0, 0usize);
        let mut prev: Option<(f64, f64, f64)> = None; // (y, x_le, x_mid)
        for k in 0..=STRIPS {
            let y = s * (k as f64 / STRIPS as f64).clamp(1e-9, 1.0 - 1e-9);
            let (_, x_le, x_mid) = slice(&fg.planform, y);
            if let Some((py, pl, pm)) = prev {
                let dy = y - py;
                if dy > 0.0 {
                    sum_l += ((x_le - pl) / dy).atan();
                    sum_c += ((x_mid - pm) / dy).atan();
                    n_ang += 1;
                }
            }
            prev = Some((y, x_le, x_mid));
            if k < STRIPS {
                let y_mid = s * (k as f64 + 0.5) / STRIPS as f64;
                strips.push(Strip {
                    xi: fg.root_radius + y_mid,
                    chord: slice(&fg.planform, y_mid).0,
                    width: s / STRIPS as f64,
                });
            }
        }
        let mean = |v: f64| if n_ang > 0 { v / n_ang as f64 } else { 0.0 };
        Self {
            count: fg.count,
            area: st.area,
            span: s,
            root_chord: st.root_chord,
            tip_chord: st.tip_chord,
            mac: st.mac,
            y_mac: st.y_mac,
            x_mac_le: st.x_mac_le,
            x_root_le: if x_root_le.is_finite() {
                x_root_le
            } else {
                0.0
            },
            gamma_c: mean(sum_c),
            gamma_le: mean(sum_l),
            thickness: fg.thickness,
            cross_section: fg.cross_section,
            cant: fg.cant,
            r_t: fg.root_radius,
            strips,
        }
    }

    /// Aspect ratio AR = 2 s² / A_fin.
    /// cite: niskanen-2009 eq 3.39 p 39
    pub fn aspect_ratio(&self) -> f64 {
        if self.area > 0.0 {
            2.0 * self.span * self.span / self.area
        } else {
            0.0
        }
    }
}

/// Horizontal slice of a planform polygon at height y: (chord, LE station,
/// mid-chord station of the slice's overall extent).
fn slice(poly: &[[f64; 2]], y: f64) -> (f64, f64, f64) {
    let n = poly.len();
    let mut xs = Vec::new();
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        if (a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y) {
            let t = (y - a[1]) / (b[1] - a[1]);
            xs.push(a[0] + t * (b[0] - a[0]));
        }
    }
    xs.sort_by(f64::total_cmp);
    if xs.len() < 2 {
        return (0.0, 0.0, 0.0);
    }
    let (lo, hi) = (xs[0], xs[xs.len() - 1]);
    // Jagged planforms: the chord spans LE to TE (niskanen-2009 p 37-38).
    (hi - lo, lo, 0.5 * (lo + hi))
}

/// Subsonic single-fin normal-force slope (Diederich, simplified):
/// (C_Nα)_1 = 2π (s²/A_ref) / (1 + sqrt(1 + (β s²/(A_fin cos Γ_c))²)).
/// cite: niskanen-2009 eq 3.40 p 39
pub fn single_fin_cna_subsonic(mach: f64, span: f64, a_fin: f64, a_ref: f64, gamma_c: f64) -> f64 {
    if a_fin <= 0.0 || a_ref <= 0.0 {
        return 0.0;
    }
    let b = beta(mach.min(1.0));
    let k = b * span * span / (a_fin * gamma_c.cos().max(1e-6));
    2.0 * PI * (span * span / a_ref) / (1.0 + (1.0 + k * k).sqrt())
}

/// Supersonic single-fin secant slope at angle of attack α (flat plate,
/// uncanted, no roll): (C_Nα)_1 = (A_fin/A_ref)(K_1 + K_2 α + K_3 α²).
/// cite: niskanen-2009 eq 3.49 p 41
pub fn single_fin_cna_supersonic(mach: f64, alpha: f64, a_fin: f64, a_ref: f64) -> f64 {
    if a_ref <= 0.0 {
        return 0.0;
    }
    let [k1, k2, k3] = busemann(mach);
    let a = alpha.abs();
    a_fin / a_ref * (k1 + k2 * a + k3 * a * a)
}

/// Single-fin secant slope over the whole Mach range: subsonic (3.40) up to
/// M 0.9, supersonic (3.49) from M 1.5, C¹ cubic blend between.
/// cite: niskanen-2009 eq 3.40 p 39
pub fn single_fin_cna(
    mach: f64,
    alpha: f64,
    span: f64,
    a_fin: f64,
    a_ref: f64,
    gamma_c: f64,
) -> f64 {
    transonic_blend(
        mach,
        |m| single_fin_cna_subsonic(m, span, a_fin, a_ref, gamma_c),
        |m| single_fin_cna_supersonic(m, alpha, a_fin, a_ref),
    )
}

/// Multiplier from the single-fin slope to the N-fin set,
/// (C_Nα)_N = factor · (C_Nα)_1: Σ sin²Λ_k = N/2 (roll-averaged for N = 1, 2;
/// exact for N ≥ 3 by eq 3.53) times the fin–fin interference factor 1.000
/// for N ≤ 4, 0.948, 0.913, 0.854, 0.810 for N = 5..8 and 0.750 above.
/// N = 3 gives 1.50 and N = 4 gives 2.00, Barrowman's (C_Nα)_T = (N/2)(C_Nα)_1;
/// the thesis's 15 % / 6 % roll reduction for N = 3, 4 is dropped, as
/// niskanen-2013 does (literature-map Errata).
/// cite: niskanen-2013 eq 3.54 p 43
/// cite: barrowman-1967 eq 3-11 p 14
pub fn fin_count_factor(count: u32) -> f64 {
    let interference = match count {
        0..=4 => 1.000,
        5 => 0.948,
        6 => 0.913,
        7 => 0.854,
        8 => 0.810,
        _ => 0.750,
    };
    count as f64 / 2.0 * interference
}

/// Tail-in-presence-of-body interference factor K_T(B) = 1 + r_t/(s + r_t).
/// cite: niskanen-2009 eq 3.56 p 44
pub fn kt_b(r_t: f64, span: f64) -> f64 {
    if r_t + span <= 0.0 {
        return 1.0;
    }
    1.0 + r_t / (span + r_t)
}

/// Body-in-presence-of-tail interference factor (slender-body, subsonic):
/// K_B(T) = (1 + r_t/(s + r_t))² − K_T(B), so that K_T(B) + K_B(T) =
/// (1 + r_t/(s + r_t))². Barrowman's (1 − 1/τ²)²/(1 − 1/τ)² with
/// τ = (s + r_t)/r_t is the same (1 + 1/τ)². This is the lift the fins carry
/// over onto the body between and behind them, which niskanen-2009 (3.55)
/// neglects. The supersonic form needs K'_B(T) from Barrowman's Fig 3-9
/// (not digitised, literature-map Gaps), so above M 0.9 the term is faded to
/// the thesis's neglect (0 from M 1.5) with the fin-slope transonic blend.
/// cite: barrowman-1967 eq 3-98 p 41
/// cite: barrowman-1967 eq 3-94 p 40
pub fn kb_t(mach: f64, r_t: f64, span: f64) -> f64 {
    if r_t + span <= 0.0 {
        return 0.0;
    }
    let kt = kt_b(r_t, span);
    transonic_blend(mach, |_| kt * kt - kt, |_| 0.0)
}

/// Slender-body K_T(B) as a function of τ = (s + r_t)/r_t, with the +π/4 term
/// that barrowman-1967 (3-96) drops (literature-map Errata). Cross-check for
/// [`kt_b`]; tends to 1 as τ → ∞ and to 2 as τ → 1.
/// cite: barrowman-1967 eq 3-96 p 41
pub fn kt_b_slender_body(tau: f64) -> f64 {
    if tau <= 1.0 + 1e-6 {
        return 2.0;
    }
    let it = 1.0 / tau;
    let first = (1.0 + it.powi(4)) * (0.5 * (0.5 * (tau - it)).atan() + PI / 4.0);
    let second = it * it * ((tau - it) + 2.0 * it.atan());
    2.0 / (PI * (1.0 - it).powi(2)) * (first - second)
}

/// Supersonic fin CP as a fraction of the MAC from its leading edge,
/// X_f/c̄ = (AR β − 0.67)/(2 AR β − 1), held within the quarter- to
/// half-chord band where the fit is meaningful. Returns (value, dvalue/dM).
/// cite: niskanen-2009 eq 3.35 p 37
pub fn supersonic_cp_fraction(mach: f64, ar: f64) -> (f64, f64) {
    let b = beta(mach.max(1.0 + 1e-9));
    let g = ar * b;
    let den = 2.0 * g - 1.0;
    if den <= 1e-9 {
        return (0.25, 0.0);
    }
    let f = (g - 0.67) / den;
    let df = 0.34 / (den * den) * ar * mach / b;
    if f < 0.25 {
        (0.25, 0.0)
    } else if f > 0.5 {
        (0.5, 0.0)
    } else {
        (f, df)
    }
}

/// Fin CP as a fraction of the MAC from its leading edge: 0.25 up to M 0.5,
/// the eq 3.35 fit above M 2, and between them the fifth-order p(M) with
/// p(0.5) = 0.25, p'(0.5) = 0, p(2) = f(2), p'(2) = f'(2), p''(2) = p'''(2) = 0.
/// cite: niskanen-2009 eq 3.36 p 37
pub fn cp_fraction(mach: f64, ar: f64) -> f64 {
    if mach <= 0.5 {
        return 0.25;
    }
    let (a0, a1) = supersonic_cp_fraction(2.0, ar);
    if mach >= 2.0 {
        return supersonic_cp_fraction(mach, ar).0;
    }
    // p(t) = a0 + a1 t + a4 t⁴ + a5 t⁵, t = M − 2 (a2 = a3 = 0 from p'' = p''' = 0).
    let t0: f64 = -1.5;
    let r1 = 0.25 - a0 - a1 * t0;
    let r2 = -a1;
    let a4 = (5.0 * r1 - t0 * r2) / t0.powi(4);
    let a5 = (t0 * r2 - 4.0 * r1) / t0.powi(5);
    let t = mach - 2.0;
    a0 + a1 * t + a4 * t.powi(4) + a5 * t.powi(5)
}

/// Trapezoid fin CP from the root leading edge (subsonic, quarter chord of the MAC):
/// X_f = (x_t/3)(c_r + 2c_t)/(c_r + c_t) + (1/6)(c_r² + c_t² + c_r c_t)/(c_r + c_t).
/// cite: niskanen-2009 eq 3.34 p 37
pub fn trapezoid_cp_from_root_le(c_r: f64, c_t: f64, x_t: f64) -> f64 {
    let sum = c_r + c_t;
    if sum <= 0.0 {
        return 0.0;
    }
    x_t / 3.0 * (c_r + 2.0 * c_t) / sum + (c_r * c_r + c_t * c_t + c_r * c_t) / (6.0 * sum)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interference_limits() {
        assert!((kt_b(0.0, 0.1) - 1.0).abs() < 1e-15);
        assert!((kt_b(0.1, 0.0) - 2.0).abs() < 1e-15);
        assert!((kt_b_slender_body(1.0) - 2.0).abs() < 1e-12);
        assert!((kt_b_slender_body(1.0 + 1e-3) - 2.0).abs() < 1e-2);
        assert!((kt_b_slender_body(1e6) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn count_factor_matches_barrowman_and_table() {
        // Barrowman (3-11): N/2 for N = 3, 4.
        assert!((fin_count_factor(3) - 1.5).abs() < 1e-12);
        assert!((fin_count_factor(4) - 2.0).abs() < 1e-12);
        // niskanen-2009 (3.54) prints the products 2.37, 2.74, 2.99, 3.24.
        for (n, v) in [(5, 2.37), (6, 2.74), (7, 2.99), (8, 3.24)] {
            assert!((fin_count_factor(n) - v).abs() < 1e-2, "{n}");
        }
        assert_eq!(fin_count_factor(0), 0.0);
    }

    #[test]
    fn body_in_tail_factor() {
        let (r, s) = (0.0125, 0.03);
        let kt = kt_b(r, s);
        // K_T(B) + K_B(T) = (1 + r/(s + r))², Barrowman (3-98) with τ = (s + r)/r.
        let tau = (s + r) / r;
        let barrowman = (1.0 - 1.0 / (tau * tau)).powi(2) / (1.0 - 1.0 / tau).powi(2);
        assert!((kt + kb_t(0.3, r, s) - barrowman).abs() < 1e-12);
        assert!(kb_t(0.3, 0.0, s).abs() < 1e-15);
        assert_eq!(kb_t(2.0, r, s), 0.0);
        assert!(kb_t(1.2, r, s) > 0.0 && kb_t(1.2, r, s) < kb_t(0.9, r, s));
    }

    #[test]
    fn cp_fraction_polynomial_constraints() {
        let ar = 1.5;
        let h = 1e-6;
        let p = |m: f64| cp_fraction(m, ar);
        assert!((p(0.5) - 0.25).abs() < 1e-12);
        assert!((p(0.5 + h) - p(0.5)).abs() / h < 1e-4);
        let (f2, df2) = supersonic_cp_fraction(2.0, ar);
        assert!((p(2.0 - 1e-12) - f2).abs() < 1e-9);
        assert!(((p(2.0) - p(2.0 - h)) / h - df2).abs() < 1e-4);
        // Rearward drift with Mach.
        assert!(p(1.0) > 0.25 && p(1.5) > p(1.0) && p(3.0) > 0.25);
    }

    #[test]
    fn supersonic_slope_continuity_and_blend() {
        let (s, a_fin, a_ref, gc) = (0.05, 0.003, 0.002, 0.3);
        let lo = single_fin_cna(0.9, 0.0, s, a_fin, a_ref, gc);
        assert!((lo - single_fin_cna_subsonic(0.9, s, a_fin, a_ref, gc)).abs() < 1e-12);
        let hi = single_fin_cna(1.5, 0.0, s, a_fin, a_ref, gc);
        assert!((hi - single_fin_cna_supersonic(1.5, 0.0, a_fin, a_ref)).abs() < 1e-12);
        // Supersonic K_1 term alone: (A_fin/A_ref)(2/β).
        let k1 = single_fin_cna_supersonic(2.0, 0.0, a_fin, a_ref);
        assert!((k1 - a_fin / a_ref * 2.0 / 3.0_f64.sqrt()).abs() < 1e-12);
    }
}
