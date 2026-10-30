//! Center of pressure of the fin lift carried over onto the body, K_B(F),
//! at subsonic speeds (NACA TR 1307, Pitts, Nielsen and Kaattari 1957).
//!
//! The fin-set C_Nα is unchanged: (1 + τ)² (Barrowman's K_T(B) + K_B(T)),
//! with τ = r_t/(r_t + s). What changes is where the body-carried part acts.
//! TR 1307 splits the slender-body total into the fin load K_F(B) (eq 14,
//! acting at the wing-alone CP) and the body load K_B(F) = (1 + τ)² − K_F(B)
//! (eq 21), and places the body load from chart 16: the slender-body CP
//! ½ x_LE,t at βA = 0 (pdf p 22: no lift aft of the maximum span), faired to the
//! lifting-line CP of Appendix D (eq D5) at βA ≥ 4 (pdf p 23). The chart
//! ordinates below are our own digitisation of TR 1307 chart 16 (pdf pp
//! 72-74), stored as the fraction from the slender-body CP to the
//! lifting-line CP so both analytic endpoints hold for any planform (the
//! normalisation the OpenRocket technical documentation describes, sec
//! 3.2.2). The applicability bounds are that document's (pdf p 47): a
//! trapezoidal fin on a constant-radius tube, r/s ≤ 0.6, no forward-swept
//! leading edge or aft-swept trailing edge, and not below half taper with a
//! forward-swept mid-chord (the families chart 16 publishes). Elsewhere the
//! body load stays at the fin CP, as before.

use std::f64::consts::FRAC_PI_2;

/// Planform of one trapezoidal fin on a body of radius `r_t`: root and tip
/// chords, tip leading-edge offset `sweep` aft of the root leading edge, and
/// exposed span (all m).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TrapezoidFin {
    pub root_chord: f64,
    pub tip_chord: f64,
    pub sweep: f64,
    pub span: f64,
    pub r_t: f64,
}

impl TrapezoidFin {
    /// Taper ratio λ = c_t / c_r.
    fn taper(&self) -> f64 {
        self.tip_chord / self.root_chord
    }

    /// Radius-semispan ratio r/s of TR 1307 (semispan from the body axis).
    fn r_over_s(&self) -> f64 {
        self.r_t / (self.r_t + self.span)
    }

    /// Position of the leading edge between chart 16's sweep families:
    /// 0 = no leading-edge sweep, ½ = no mid-chord sweep, 1 = no
    /// trailing-edge sweep (x_LE,t / (c_r − c_t)). 0 for a rectangle.
    fn sweep_position(&self) -> f64 {
        let d = self.root_chord - self.tip_chord;
        if d.abs() <= 1e-12 * self.root_chord {
            0.0
        } else {
            self.sweep / d
        }
    }

    /// Effective aspect ratio of the two exposed panels joined,
    /// A = (2s)² / (2 A_fin) = 4 s / (c_r + c_t).
    fn aspect_ratio(&self) -> f64 {
        4.0 * self.span / (self.root_chord + self.tip_chord)
    }
}

/// Whether chart 16 covers the planform (otherwise the body load stays at
/// the fin CP): positive chords and span, 0 ≤ λ ≤ 1, r/s ≤ 0.6, no
/// forward-swept leading edge, no aft-swept trailing edge, and not λ < ½
/// with a forward-swept mid-chord. The constant-radius-body condition is the
/// caller's.
/// cite: openrocket-techdoc-2026 sec 3.2.2 p 47
pub fn chart16_applies(f: &TrapezoidFin) -> bool {
    const EPS: f64 = 1e-9;
    if !(f.root_chord > 0.0 && f.tip_chord >= 0.0 && f.span > 0.0 && f.r_t > 0.0) {
        return false;
    }
    let lam = f.taper();
    let sigma = f.sweep_position();
    let rect = (f.root_chord - f.tip_chord).abs() <= 1e-12 * f.root_chord;
    let le_ok = f.sweep >= -EPS * f.root_chord;
    let te_ok = f.sweep + f.tip_chord <= f.root_chord * (1.0 + EPS);
    lam <= 1.0 + EPS
        && f.r_over_s() <= 0.6 + EPS
        && le_ok
        && te_ok
        && (rect || lam >= 0.5 - EPS || sigma >= 0.5 - EPS)
}

/// Fin load in the presence of the body, slender-body K_F(B)(τ) with
/// τ = r/s (TR 1307 notation, semispan from the axis); 1 at τ = 0.
/// cite: naca-tr-1307 eq 14 p 8
pub fn k_fin_body(tau: f64) -> f64 {
    if tau <= 1e-12 {
        return 1.0;
    }
    if tau >= 1.0 - 1e-9 {
        return 2.0;
    }
    let it = 1.0 / tau;
    let first =
        (1.0 + tau.powi(4)) * (0.5 * (0.5 * (it - tau)).atan() + std::f64::consts::FRAC_PI_4);
    let second = tau * tau * ((it - tau) + 2.0 * tau.atan());
    2.0 / (std::f64::consts::PI * (1.0 - tau).powi(2)) * (first - second)
}

/// Slender-body CP of the body load from the root leading edge, ½ x_LE,t
/// (chart 16 ordinate at βA = 0; no lift aft of the maximum span, pdf p 22).
/// cite: naca-tr-1307 eq chart-16 p 72
pub fn slender_cp(f: &TrapezoidFin) -> f64 {
    0.5 * f.sweep
}

/// Lifting-line CP of the body load from the root leading edge (elliptic
/// loading on the quarter-chord line and its image in the body):
/// x̄ = c_r/4 + tan Λ_¼ ∫ Γ (η − r)/η² dη / ∫ Γ/η² dη over r ≤ η ≤ s,
/// Γ = √((s − r)² − (η − r)²), with (s − r) tan Λ_¼ = x_LE,t + (c_t − c_r)/4.
/// Integrated with η − r = (s − r) sin θ (Simpson, 256 panels).
/// cite: naca-tr-1307 eq D5 p 40
pub fn lifting_line_cp(f: &TrapezoidFin) -> f64 {
    let (r, b) = (f.r_t.max(0.0), f.span.max(0.0));
    let quarter = f.sweep + 0.25 * (f.tip_chord - f.root_chord);
    if b <= 0.0 {
        return 0.25 * f.root_chord;
    }
    if r <= 0.0 {
        // r/s → 0: the image load concentrates at the root.
        return 0.25 * f.root_chord;
    }
    const N: usize = 256;
    let h = FRAC_PI_2 / N as f64;
    let (mut num, mut den) = (0.0, 0.0);
    for k in 0..=N {
        let t = k as f64 * h;
        let w = if k == 0 || k == N {
            1.0
        } else if k % 2 == 1 {
            4.0
        } else {
            2.0
        };
        let (s, c) = t.sin_cos();
        let eta = r + b * s;
        let g = c * c / (eta * eta);
        num += w * g * s;
        den += w * g;
    }
    // ∫ Γ (η − r)/η² dη / ∫ Γ/η² dη = b · num/den; times tan Λ_¼ = quarter/b.
    0.25 * f.root_chord + quarter * num / den
}

/// βA grid of the stored chart 16 ordinates.
const BETA_A: [f64; 18] = [
    0.0, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0,
];
/// r/s of the chart's four curves per panel.
const R_OVER_S: [f64; 4] = [0.0, 0.2, 0.4, 0.6];

type Panel = [[f64; 18]; 4];

/// Chart 16 ordinates as the fraction (x̄ − x̄_slender)/(x̄_LL − x̄_slender),
/// read from TR 1307 (pdf pp 72-74; our digitisation, ±0.005 c_r). Rows are
/// r/s = 0, 0.2, 0.4, 0.6. Where the r/s = 0 curve is degenerate (slender
/// and lifting-line CP coincide: panels (d), (h)) its row repeats r/s = 0.2.
/// Panel (c) (λ = 1) is one curve for every r/s, the same in (f) and (i).
const PANEL_A: Panel = [
    [
        0.0, 0.443, 0.562, 0.66, 0.729, 0.783, 0.833, 0.867, 0.921, 0.957, 0.981, 0.988, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.446, 0.571, 0.651, 0.734, 0.79, 0.835, 0.872, 0.927, 0.965, 0.986, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.423, 0.538, 0.641, 0.715, 0.769, 0.818, 0.851, 0.921, 0.965, 0.987, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.41, 0.513, 0.607, 0.689, 0.753, 0.802, 0.845, 0.911, 0.956, 0.985, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
];
const PANEL_B: Panel = [
    [
        0.0, 0.396, 0.53, 0.642, 0.728, 0.786, 0.853, 0.898, 0.95, 0.978, 0.992, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.399, 0.54, 0.631, 0.725, 0.789, 0.837, 0.874, 0.933, 0.97, 0.993, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.384, 0.517, 0.601, 0.695, 0.772, 0.823, 0.869, 0.931, 0.969, 0.992, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.395, 0.485, 0.578, 0.679, 0.761, 0.814, 0.866, 0.93, 0.967, 0.991, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
];
const RECT: [f64; 18] = [
    0.0, 0.415, 0.544, 0.643, 0.719, 0.776, 0.821, 0.854, 0.9, 0.931, 0.95, 0.964, 1.0, 1.0, 1.0,
    1.0, 1.0, 1.0,
];
const PANEL_C: Panel = [RECT, RECT, RECT, RECT];
const PANEL_D: Panel = [
    [
        0.0, 0.259, 0.37, 0.463, 0.556, 0.63, 0.704, 0.759, 0.889, 0.944, 0.981, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.259, 0.37, 0.463, 0.556, 0.63, 0.704, 0.759, 0.889, 0.944, 0.981, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.295, 0.394, 0.508, 0.594, 0.685, 0.735, 0.798, 0.894, 0.96, 0.992, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.309, 0.433, 0.525, 0.626, 0.697, 0.753, 0.806, 0.89, 0.944, 0.982, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
];
const PANEL_E: Panel = [
    [
        0.0, 0.298, 0.42, 0.52, 0.615, 0.681, 0.745, 0.802, 0.882, 0.934, 0.966, 0.984, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.346, 0.472, 0.566, 0.649, 0.72, 0.774, 0.833, 0.906, 0.955, 0.985, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.412, 0.499, 0.59, 0.669, 0.729, 0.793, 0.834, 0.911, 0.956, 0.987, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.419, 0.54, 0.639, 0.715, 0.777, 0.82, 0.865, 0.933, 0.975, 0.996, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
];
const PANEL_G: Panel = [
    [
        0.0, 0.136, 0.2, 0.268, 0.332, 0.396, 0.456, 0.516, 0.62, 0.712, 0.796, 0.852, 0.88, 0.928,
        0.956, 0.976, 0.992, 1.0,
    ],
    [
        0.0, 0.179, 0.268, 0.358, 0.437, 0.518, 0.599, 0.664, 0.797, 0.904, 0.967, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.13, 0.192, 0.264, 0.36, 0.448, 0.54, 0.625, 0.77, 0.893, 0.958, 1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.306, 0.417, 0.542, 0.632, 0.701, 0.757, 0.806, 0.875, 0.924, 0.972, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
];
const PANEL_H: Panel = [
    [
        0.0, 0.298, 0.417, 0.53, 0.646, 0.707, 0.765, 0.819, 0.901, 0.958, 0.989, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.298, 0.417, 0.53, 0.646, 0.707, 0.765, 0.819, 0.901, 0.958, 0.989, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.271, 0.384, 0.48, 0.574, 0.658, 0.733, 0.785, 0.875, 0.935, 0.976, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
    [
        0.0, 0.297, 0.416, 0.511, 0.59, 0.675, 0.748, 0.803, 0.885, 0.941, 0.977, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0,
    ],
];

/// Linear interpolation in a sorted grid, clamped at both ends.
fn lerp_grid(grid: &[f64], vals: &[f64], x: f64) -> f64 {
    if x <= grid[0] {
        return vals[0];
    }
    for i in 1..grid.len() {
        if x <= grid[i] {
            let t = (x - grid[i - 1]) / (grid[i] - grid[i - 1]);
            return vals[i - 1] + t * (vals[i] - vals[i - 1]);
        }
    }
    vals[vals.len() - 1]
}

/// One panel's fraction at (βA, r/s): linear in βA on each curve, then in r/s.
fn panel_fraction(p: &Panel, beta_a: f64, r_over_s: f64) -> f64 {
    let rows: Vec<f64> = p
        .iter()
        .map(|row| lerp_grid(&BETA_A, row, beta_a))
        .collect();
    lerp_grid(&R_OVER_S, &rows, r_over_s)
}

/// Chart 16 fraction (x̄ − x̄_slender)/(x̄_LL − x̄_slender) at effective
/// aspect ratio βA, radius-semispan ratio r/s, taper λ, and sweep position σ
/// (0 no leading-edge, ½ no mid-chord, 1 no trailing-edge sweep): linear
/// between the sweep families at λ = 0 and ½, then linear in λ to the
/// rectangular panel at λ = 1.
/// cite: naca-tr-1307 eq chart-16 p 72
pub fn chart16_fraction(beta_a: f64, r_over_s: f64, taper: f64, sigma: f64) -> f64 {
    let s = sigma.clamp(0.0, 1.0);
    let by_sweep = |le: &Panel, mid: &Panel, te: &Panel| {
        let (a, b, c) = (
            panel_fraction(le, beta_a, r_over_s),
            panel_fraction(mid, beta_a, r_over_s),
            panel_fraction(te, beta_a, r_over_s),
        );
        if s <= 0.5 {
            a + (b - a) * s / 0.5
        } else {
            b + (c - b) * (s - 0.5) / 0.5
        }
    };
    let f0 = by_sweep(&PANEL_A, &PANEL_D, &PANEL_G);
    let f_half = by_sweep(&PANEL_B, &PANEL_E, &PANEL_H);
    let f1 = panel_fraction(&PANEL_C, beta_a, r_over_s);
    let lam = taper.clamp(0.0, 1.0);
    if lam <= 0.5 {
        f0 + (f_half - f0) * lam / 0.5
    } else {
        f_half + (f1 - f_half) * (lam - 0.5) / 0.5
    }
}

/// Subsonic CP of the body-carried fin load from the root leading edge at
/// Prandtl-Glauert factor `beta` = √(1 − M²): slender-body CP plus the
/// chart 16 fraction of the way to the lifting-line CP.
/// cite: naca-tr-1307 eq chart-16 p 72
pub fn body_load_cp(f: &TrapezoidFin, beta: f64) -> f64 {
    let sb = slender_cp(f);
    let ll = lifting_line_cp(f);
    let frac = chart16_fraction(
        beta.max(0.0) * f.aspect_ratio(),
        f.r_over_s(),
        f.taper(),
        f.sweep_position(),
    );
    sb + frac * (ll - sb)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fin(cr: f64, ct: f64, sweep: f64, span: f64, rt: f64) -> TrapezoidFin {
        TrapezoidFin {
            root_chord: cr,
            tip_chord: ct,
            sweep,
            span,
            r_t: rt,
        }
    }

    /// TR 1307 eq D6, the closed form of D5 for s > 2r (semispan s from the
    /// axis): the lifting-line quadrature must reproduce it.
    #[test]
    fn lifting_line_matches_closed_form_d6() {
        for &(rt, span) in &[(0.1, 0.9), (0.2, 0.8), (0.3, 0.7), (0.0283, 0.0762)] {
            let f = fin(0.15, 0.09, 0.044, span, rt);
            let (r, s) = (rt, rt + span);
            let a = (s * (s - 2.0 * r)).sqrt();
            let ch = ((s - r) / r).acosh();
            let num = a * ch - (s - r) + std::f64::consts::FRAC_PI_2 * r;
            let den =
                (s - r) * r / a * ch + (s - r).powi(2) / r - std::f64::consts::FRAC_PI_2 * (s - r);
            let tan_q = (f.sweep + 0.25 * (f.tip_chord - f.root_chord)) / span;
            let d6 = 0.25 * f.root_chord + (s - r) * tan_q * (r / (r - s) + num / den);
            let ours = lifting_line_cp(&f);
            assert!((ours - d6).abs() < 1e-7, "r {rt} s {span}: {ours} vs {d6}");
        }
    }

    /// Chart 16's analytic endpoints, in units of c_r: the lifting-line
    /// levels the curves reach at βA ≥ 4 (no-mid-chord, λ = ½: 0.277,
    /// 0.288, 0.294 for r/s = 0.2, 0.4, 0.6; no-trailing-edge, λ = 0: 0.415,
    /// 0.476, 0.516) and the slender-body starts (½ x_LE,t).
    #[test]
    fn chart16_endpoints() {
        let ll = |lam: f64, sigma: f64, rs: f64| {
            let span = 1.0;
            let rt = rs * span / (1.0 - rs);
            let f = fin(1.0, lam, sigma * (1.0 - lam), span, rt);
            lifting_line_cp(&f)
        };
        for (rs, want) in [(0.2, 0.2774), (0.4, 0.2876), (0.6, 0.2943)] {
            assert!((ll(0.5, 0.5, rs) - want).abs() < 5e-4, "{rs}");
        }
        for (rs, want) in [(0.2, 0.4146), (0.4, 0.4758), (0.6, 0.5156)] {
            assert!((ll(0.0, 1.0, rs) - want).abs() < 5e-4, "{rs}");
        }
        // Rectangle: quarter chord for every r/s.
        assert!((ll(1.0, 0.0, 0.4) - 0.25).abs() < 1e-12);
        // Fraction 0 at βA = 0 and 1 from βA = 7 on, for every family.
        for lam in [0.0, 0.3, 0.5, 0.8, 1.0] {
            for sigma in [0.0, 0.5, 1.0] {
                assert_eq!(chart16_fraction(0.0, 0.3, lam, sigma), 0.0);
                assert!((chart16_fraction(7.5, 0.3, lam, sigma) - 1.0).abs() < 1e-12);
            }
        }
        let f = fin(0.1524, 0.0889, 0.043994, 0.0762, 0.028321);
        assert!((body_load_cp(&f, 0.0) - 0.5 * 0.043994).abs() < 1e-12);
        assert!((body_load_cp(&f, 10.0) - lifting_line_cp(&f)).abs() < 1e-12);
    }

    /// Chart 16 readings at sample points (panel (e), λ = ½, no mid-chord
    /// sweep, r/s = 0.2: x̄/c_r ≈ 0.223 at βA = 1.25; panel (c), λ = 1:
    /// ≈ 0.160 at βA = 1) through the normalised table.
    #[test]
    fn chart16_sample_readings() {
        let span = 1.0;
        let rt = 0.2 * span / 0.8;
        let e = fin(1.0, 0.5, 0.25, span, rt);
        let beta = 1.25 / e.aspect_ratio();
        assert!(
            (body_load_cp(&e, beta) - 0.223).abs() < 0.004,
            "{}",
            body_load_cp(&e, beta)
        );
        let c = fin(1.0, 1.0, 0.0, span, rt);
        let beta = 1.0 / c.aspect_ratio();
        assert!(
            (body_load_cp(&c, beta) - 0.160).abs() < 0.004,
            "{}",
            body_load_cp(&c, beta)
        );
    }

    #[test]
    fn applicability() {
        // Tapered, swept, trailing edge swept forward: covered.
        assert!(chart16_applies(&fin(0.1524, 0.0889, 0.044, 0.0762, 0.0283)));
        // Parallelogram (aft-swept trailing edge): not covered.
        assert!(!chart16_applies(&fin(0.0508, 0.0508, 0.0254, 0.03, 0.0125)));
        // Unswept rectangle: covered (λ = 1 panel).
        assert!(chart16_applies(&fin(0.05, 0.05, 0.0, 0.03, 0.0125)));
        // Forward-swept leading edge, aft-swept trailing edge: not covered.
        assert!(!chart16_applies(&fin(0.1, 0.05, -0.01, 0.05, 0.02)));
        assert!(!chart16_applies(&fin(0.1, 0.05, 0.06, 0.05, 0.02)));
        // λ < ½ with a forward-swept mid-chord: not covered; at the
        // no-mid-chord boundary it is.
        assert!(!chart16_applies(&fin(0.08, 0.03, 0.02, 0.04, 0.0125)));
        assert!(chart16_applies(&fin(0.08, 0.03, 0.025, 0.04, 0.0125)));
        // r/s > 0.6: not covered.
        assert!(!chart16_applies(&fin(0.1, 0.05, 0.03, 0.01, 0.02)));
    }

    #[test]
    fn k_fin_body_limits() {
        assert_eq!(k_fin_body(0.0), 1.0);
        // Same function as Barrowman's K_T(B) in τ_B = 1/τ (fins::kt_b_slender_body).
        for tau in [0.1, 0.25, 0.5] {
            let kb = crate::fins::kt_b_slender_body(1.0 / tau);
            assert!((k_fin_body(tau) - kb).abs() < 1e-12);
            assert!(k_fin_body(tau) < (1.0 + tau) * (1.0 + tau));
        }
    }
}
