//! Fin-set normal force and CP (Barrowman 1967 as extended by Niskanen 2009):
//! single-fin C_Nα (Diederich subsonic; supersonic two-face Busemann strip
//! load with the tip Mach-cone relief of Barrowman App. A), the N-fin factor,
//! fin–body interference K_T(B), and the Mach-dependent fin CP.
//! Notation follows `docs/dev/literature-map.md`.

use std::f64::consts::PI;

use rw_geom::{FinGeometry, fins::planform_stats};
use rw_model::FinCrossSection;

use crate::mach::{
    beta, flat_plate_strip_secant, hermite, transonic_blend, wedge_half_angle, wedge_strip_secant,
};

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

    /// Trailing-edge minus leading-edge thickness of the section, the
    /// quantity the supersonic thickness lift is proportional to: `thickness`
    /// for a wedge, zero for the sections whose two edges are equally thick
    /// (square, rounded) or both closed (airfoil).
    /// cite: n/a section geometry lookup, no physics
    pub fn wedge_thickness(&self) -> f64 {
        match self.cross_section {
            FinCrossSection::Wedge => self.thickness,
            FinCrossSection::Square | FinCrossSection::Rounded | FinCrossSection::Airfoil => 0.0,
        }
    }

    /// Tip Mach-cone geometry of this panel for the supersonic strip load.
    /// cite: barrowman-1967 eq 38 p 101
    pub fn tip_cone(&self) -> TipCone {
        TipCone {
            xi_root: self.r_t,
            span: self.span,
            tan_le: self.gamma_le.tan(),
            aspect_ratio: self.aspect_ratio(),
        }
    }
}

/// βAR below which the rectangular-wing slope is taken at the slender-wing
/// limit; the TR 1307 chart 8 linear-theory curve for λ = 1 stops here and is
/// extrapolated to the origin.
pub const SLENDER_BETA_AR: f64 = 0.5;

/// What the supersonic strip load needs to know about a panel's tip: the
/// root radius, the exposed span s, tan Γ_L, and the aspect ratio
/// AR = 2s²/A_fin of the two exposed panels joined together (the wing alone
/// of naca-tr-1307, footnote 1 pdf 5).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TipCone {
    pub xi_root: f64,
    pub span: f64,
    pub tan_le: f64,
    pub aspect_ratio: f64,
}

impl TipCone {
    /// Load factor of one strip: [`tip_cone_strip_factor`] at the strip's
    /// spanwise position times [`low_aspect_ratio_factor`] at β·AR.
    /// cite: barrowman-1967 eq 39-44 p 102
    /// cite: naca-tr-1307 eq chart-8 p 63
    pub fn strip_factor(&self, mach: f64, strip: &Strip) -> f64 {
        let b = beta(mach.max(1.0 + 1e-9));
        tip_cone_strip_factor(
            mach,
            strip.chord,
            strip.xi - self.xi_root,
            self.span,
            self.tan_le,
        ) * low_aspect_ratio_factor(b * self.aspect_ratio)
    }

    /// Finite-span factor of the whole panel on its 2D load: the
    /// area-weighted mean of the strip factors, Σ f_i c_i Δξ_i / Σ c_i Δξ_i.
    /// A rectangle gives [`rectangular_tip_relief`] at β·AR.
    /// cite: barrowman-1967 eq 39-44 p 102
    /// cite: naca-tr-1307 eq chart-8 p 63
    pub fn panel_factor(&self, mach: f64, strips: &[Strip]) -> f64 {
        let (mut load, mut area) = (0.0, 0.0);
        for s in strips {
            let a = s.chord * s.width;
            load += self.strip_factor(mach, s) * a;
            area += a;
        }
        if area > 0.0 { load / area } else { 1.0 }
    }

    /// Thickness lift of a single-wedge panel per unit incidence and unit
    /// panel area: W = Σ f_i w_i c_i Δξ_i / Σ c_i Δξ_i, with
    /// w_i = 4 C_2 δ_i + 6 K_3 δ_i² ([`wedge_strip_secant`]) at the strip
    /// half-angle δ_i = [`wedge_half_angle`] of `wedge_thickness` and the
    /// same strip factor f_i as the flat-plate load. The fin slope is
    /// (A_fin/A_ref)(flat secant · F + W). Exactly 0.0 when
    /// `wedge_thickness` is zero.
    /// cite: barrowman-1967 eq 33a-33d p 98
    /// cite: barrowman-1967 eq 39-44 p 102
    pub fn thickness_lift(&self, mach: f64, strips: &[Strip], wedge_thickness: f64) -> f64 {
        if wedge_thickness <= 0.0 {
            return 0.0;
        }
        let (mut load, mut area) = (0.0, 0.0);
        for s in strips {
            let a = s.chord * s.width;
            let w = wedge_strip_secant(mach, wedge_half_angle(wedge_thickness, s.chord));
            load += self.strip_factor(mach, s) * w * a;
            area += a;
        }
        if area > 0.0 { load / area } else { 0.0 }
    }
}

/// Fraction of a strip's chord that lies behind a tip Mach line crossing the
/// strip a distance `l_w` from its leading edge: (c − l_w)/c within [0, 1].
fn chord_fraction_behind(chord: f64, l_w: f64) -> f64 {
    if chord <= 0.0 {
        return 0.0;
    }
    ((chord - l_w.max(0.0)) / chord).clamp(0.0, 1.0)
}

/// Tip Mach-cone load factor of a flat-plate strip at spanwise distance y
/// from the root of a panel of exposed span s and leading-edge sweep Γ_L:
/// f = 1 − ½ r_own − ½ r_opp, r the fraction of the chord behind a tip Mach
/// line. Barrowman takes the pressure coefficient behind the tip Mach cone as
/// half the 2D value ((39)-(44) and the sentence after them); the Mach line
/// from the panel's own tip leading edge crosses the strip
/// l_w = (s − y)(tan Γ_L + β) from its leading edge (38). The second term is
/// the same rule for the tip of the opposite panel of the wing alone (the two
/// exposed panels joined at the root, naca-tr-1307 footnote 1 pdf 5), whose
/// Mach line crosses at (s − y) tan Γ_L + β(s + y); it acts only when β·AR < 2
/// for a rectangle. Summed over a rectangular panel the factor is the
/// linear-theory 1 − 1/(2 β AR) for β·AR ≥ 1 (naca-tr-1307 chart 8, λ = 1:
/// β C_Lα = 2 at βA = 1, 3 at βA = 2) and β·AR/2 below.
///
/// The rule is sourced for aft-swept and unswept leading edges. A
/// forward-swept leading edge (tan Γ_L < 0) is treated as unswept here: the
/// Mach-line distances use max(tan Γ_L, 0). With the negative value both
/// distances shrink and the panel loses far more than half the load behind
/// the cone. By the reverse-flow theorem a forward-swept panel should carry
/// the load of its flow-reversed twin, which this clamp only approximates
/// (model choice, parity-log).
/// cite: barrowman-1967 eq 38 p 101
/// cite: barrowman-1967 eq 39-44 p 102
pub fn tip_cone_strip_factor(mach: f64, chord: f64, y: f64, span: f64, tan_le: f64) -> f64 {
    let b = beta(mach.max(1.0 + 1e-9));
    let to_tip = (span - y).max(0.0);
    let tan_le = tan_le.max(0.0);
    let own = to_tip * (tan_le + b);
    let opposite = to_tip * tan_le + (span + y) * b;
    1.0 - 0.5 * (chord_fraction_behind(chord, own) + chord_fraction_behind(chord, opposite))
}

/// Low-aspect-ratio correction to the tip-cone strip rule, as a function of
/// g = β·AR. The strip rule gives a rectangular wing β C_Lα = 2g below g = 1,
/// where each tip Mach line crosses the other tip and the half-load rule no
/// longer holds. naca-tr-1307 chart 8 (λ = 1) falls from β C_Lα = 2 at g = 1
/// to the slender-wing line (π/2) g at g = 0.5, where the linear-theory curve
/// ends and is extrapolated to the origin. This factor is that curve over the
/// strip rule's 2g: 1 for g ≥ 1; π/4 for g ≤ 0.5 (so for a rectangular panel
/// the slope is the slender-wing (π/2) AR on its own area at any Mach, the
/// same limit as the subsonic (3.40)); between, a cubic in g matching value
/// and slope at both ends, H(g)/(2g) with H from (0.5, π/4, slope π/2) to
/// (1, 2, slope 2). On other planforms the strip rule's tip loss differs (a
/// delta has none), so the same factor does not give them the slender-wing
/// limit. The cubic and its use on non-rectangular planforms are model
/// choices (parity-log).
/// cite: naca-tr-1307 eq chart-8 p 63
pub fn low_aspect_ratio_factor(beta_ar: f64) -> f64 {
    let (g0, g1) = (SLENDER_BETA_AR, 1.0);
    if beta_ar >= g1 {
        1.0
    } else if beta_ar <= g0 {
        PI / 4.0
    } else {
        hermite(beta_ar, g0, g1, PI / 2.0 * g0, PI / 2.0, 2.0, 2.0) / (2.0 * beta_ar)
    }
}

/// Finite-span factor of a rectangular wing on its 2D slope 4/β, as a
/// function of g = β·AR: 1 − 1/(2g) for g ≥ 1 (linear theory, tip Mach lines
/// on the wing), (g/2)·[`low_aspect_ratio_factor`] below, which is (π/8) g
/// for g ≤ 0.5 (slender wing, C_Lα = (π/2) AR). Continuous with a continuous
/// slope, positive, and increasing in g. Equals the strip sum
/// [`TipCone::panel_factor`] of a rectangular panel.
/// cite: naca-tr-1307 eq chart-8 p 63
/// cite: barrowman-1967 eq 39-44 p 102
pub fn rectangular_tip_relief(beta_ar: f64) -> f64 {
    let g = beta_ar.max(0.0);
    if g >= 1.0 {
        1.0 - 0.5 / g
    } else {
        0.5 * g * low_aspect_ratio_factor(g)
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
/// uncanted, no roll), both faces loaded, infinite span:
/// (C_Nα)_1 = (A_fin/A_ref) ΔC_P(α)/α = (A_fin/A_ref) 2(K_1 + K_3 α_c²),
/// ΔC_P/α from [`crate::mach::flat_plate_strip_secant`], α_c = min(α, 17.5°)
/// ([`crate::mach::SERIES_INCIDENCE_LIMIT`]). At α → 0 this is the
/// Ackeret slope (A_fin/A_ref) 4/β. niskanen-2009 (3.48)/(3.49) build the same
/// strip sum from one face's C_P, (A_fin/A_ref)(K_1 + K_2 α + K_3 α²), which is
/// half at α → 0 (literature-map Errata). The finite-span loss is applied by
/// [`single_fin_cna`] through its `relief` factor.
/// cite: barrowman-1967 eq 8 p 96
/// cite: barrowman-1967 eq 16 p 97
/// cite: barrowman-1967 eq 33a-33d p 98
/// cite: niskanen-2009 eq 3.47 p 41
pub fn single_fin_cna_supersonic(mach: f64, alpha: f64, a_fin: f64, a_ref: f64) -> f64 {
    if a_ref <= 0.0 {
        return 0.0;
    }
    // ΔC_P/α as the secant slope, so α = 0 gives the limit, not 0/0.
    a_fin / a_ref * flat_plate_strip_secant(mach, alpha)
}

/// Single-fin secant slope over the whole Mach range: subsonic (3.40) up to
/// M 0.9; from M 1.5 the supersonic two-face strip load times `relief(M)`,
/// the panel's finite-span factor ([`TipCone::panel_factor`] for a planar
/// fin, [`rectangular_tip_relief`] for a wing given by its aspect ratio);
/// C¹ cubic blend between, whose M 1.5 end takes the value and Mach slope of
/// the relieved load. `thickness_lift(M)` is the section's supersonic
/// thickness lift per unit panel area ([`TipCone::thickness_lift`] for a
/// wedge; the constant 0.0 for a section with equal edge thicknesses, which
/// leaves the flat-plate value unchanged to the last bit), added to the
/// supersonic law as (A_fin/A_ref) W.
/// cite: niskanen-2009 eq 3.40 p 39
/// cite: barrowman-1967 eq 39-44 p 102
/// cite: barrowman-1967 eq 33a-33d p 98
#[allow(clippy::too_many_arguments)]
pub fn single_fin_cna(
    mach: f64,
    alpha: f64,
    span: f64,
    a_fin: f64,
    a_ref: f64,
    gamma_c: f64,
    relief: impl Fn(f64) -> f64,
    thickness_lift: impl Fn(f64) -> f64,
) -> f64 {
    transonic_blend(
        mach,
        |m| single_fin_cna_subsonic(m, span, a_fin, a_ref, gamma_c),
        |m| {
            let flat = single_fin_cna_supersonic(m, alpha, a_fin, a_ref) * relief(m);
            let w = thickness_lift(m);
            if w == 0.0 || a_ref <= 0.0 {
                flat
            } else {
                flat + a_fin / a_ref * w
            }
        },
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
        let ar = 2.0 * s * s / a_fin;
        let relief = |m: f64| rectangular_tip_relief(beta(m) * ar);
        let lo = single_fin_cna(0.9, 0.0, s, a_fin, a_ref, gc, relief, |_| 0.0);
        assert!((lo - single_fin_cna_subsonic(0.9, s, a_fin, a_ref, gc)).abs() < 1e-12);
        let hi = single_fin_cna(1.5, 0.0, s, a_fin, a_ref, gc, relief, |_| 0.0);
        let sup = single_fin_cna_supersonic(1.5, 0.0, a_fin, a_ref) * relief(1.5);
        assert!((hi - sup).abs() < 1e-12);
        // The blend's M 1.5 end slope includes the relief's Mach dependence.
        let h = 1e-5;
        let below = single_fin_cna(1.5 - h, 0.0, s, a_fin, a_ref, gc, relief, |_| 0.0);
        let above = single_fin_cna(1.5 + h, 0.0, s, a_fin, a_ref, gc, relief, |_| 0.0);
        let (dl, dr) = ((hi - below) / h, (above - hi) / h);
        assert!((dl - dr).abs() < 1e-3 * dr.abs().max(1.0), "{dl} vs {dr}");
        // Both faces at α → 0: the Ackeret slope (A_fin/A_ref)(4/β).
        let k1 = single_fin_cna_supersonic(2.0, 0.0, a_fin, a_ref);
        assert!((k1 - a_fin / a_ref * 4.0 / 3.0_f64.sqrt()).abs() < 1e-12);
    }

    #[test]
    fn supersonic_slope_is_two_face_ackeret_at_small_alpha() {
        let (a_fin, a_ref) = (0.003, 0.002);
        for m in [1.5_f64, 2.0, 2.5, 4.3] {
            let ackeret = a_fin / a_ref * 4.0 / beta(m);
            let at0 = single_fin_cna_supersonic(m, 0.0, a_fin, a_ref);
            assert!((at0 - ackeret).abs() <= 1e-12 * ackeret, "M={m}");
            // Secant slope at small α is the strip ΔC_P over α on the fin area.
            let alpha = 1e-3;
            let secant = a_fin / a_ref * crate::mach::flat_plate_strip_dcp(m, alpha) / alpha;
            let s = single_fin_cna_supersonic(m, alpha, a_fin, a_ref);
            assert!((s - secant).abs() <= 1e-12 * secant, "M={m}");
            assert!(((s - ackeret) / ackeret).abs() < 1e-4, "M={m}");
            // Even in α.
            assert_eq!(s, single_fin_cna_supersonic(m, -alpha, a_fin, a_ref));
        }
    }

    #[test]
    fn supersonic_slope_is_bounded_at_high_alpha() {
        // M 1.5: K_1 = 1.7888544, K_3 = 3.0590364 (hand, γ = 1.4), limit
        // 17.5° = 0.3054326 rad: 2(K_1 + K_3·0.0932891) = 4.1484582 at every
        // α from the limit to 90°. The unbounded series gave 18.67 at 90°.
        let at = |deg: f64| single_fin_cna_supersonic(1.5, deg.to_radians(), 1.0, 1.0);
        for deg in [17.5, 30.0, 60.0, 90.0] {
            assert!((at(deg) - 4.148_458_2).abs() < 1e-6, "{deg}: {}", at(deg));
        }
        assert!(at(10.0) < at(17.5) && at(0.0) < at(10.0));
    }

    #[test]
    fn wedge_thickness_lift_adds_to_the_flat_plate_slope() {
        // Rectangular panel c = s = 0.03 (AR 2), t = 0.0024 (δ = atan 0.04),
        // M 2: flat secant 2.3094011, wedge secant 2.5528999 (mach.rs hand
        // values), tip factor 1 − 1/(2√3·2) = 0.8556624 on both.
        let (c, s, r_t, t) = (0.03, 0.03, 0.015, 0.0024);
        let strips = rect_strips(c, s, r_t, 2000);
        let cone = TipCone {
            xi_root: r_t,
            span: s,
            tan_le: 0.0,
            aspect_ratio: 2.0,
        };
        let w = cone.thickness_lift(2.0, &strips, t);
        assert!(
            (w - 0.855_662_4 * (2.552_899_9 - 2.309_401_1)).abs() < 2e-5,
            "{w}"
        );
        let relief = |m: f64| cone.panel_factor(m, &strips);
        let (a_fin, a_ref) = (c * s, 7.0e-4);
        let flat = single_fin_cna(2.0, 0.0, s, a_fin, a_ref, 0.0, relief, |_| 0.0);
        let wedge = single_fin_cna(2.0, 0.0, s, a_fin, a_ref, 0.0, relief, |m| {
            cone.thickness_lift(m, &strips, t)
        });
        assert!((wedge / flat - 2.552_899_9 / 2.309_401_1).abs() < 1e-5);
        // Subsonic: no thickness term at all.
        let sub =
            |f: &dyn Fn(f64) -> f64| single_fin_cna(0.6, 0.0, s, a_fin, a_ref, 0.0, relief, f);
        assert_eq!(sub(&|_| 0.0), sub(&|m| cone.thickness_lift(m, &strips, t)));
        // The blend's M 1.5 end carries the wedge value and slope.
        let at = |m: f64| {
            single_fin_cna(m, 0.0, s, a_fin, a_ref, 0.0, relief, |m| {
                cone.thickness_lift(m, &strips, t)
            })
        };
        let h = 1e-5;
        let (dl, dr) = ((at(1.5) - at(1.5 - h)) / h, (at(1.5 + h) - at(1.5)) / h);
        assert!((dl - dr).abs() < 1e-3 * dr.abs().max(1.0), "{dl} vs {dr}");
        // No wedge thickness: exactly zero.
        assert_eq!(cone.thickness_lift(2.0, &strips, 0.0), 0.0);
    }

    #[test]
    fn sections_with_equal_edges_keep_the_flat_plate_slope_bit_for_bit() {
        // The slope with the zero thickness term against the expression the
        // flat-plate model has always used, over Mach and α.
        let (s, a_fin, a_ref, gc) = (0.05, 0.003, 0.002, 0.3);
        let ar = 2.0 * s * s / a_fin;
        let relief = |m: f64| rectangular_tip_relief(beta(m) * ar);
        for k in 0..=450 {
            let m = 0.01 * k as f64;
            for alpha in [0.0, 0.02, 0.2, 0.5] {
                let was = transonic_blend(
                    m,
                    |m| single_fin_cna_subsonic(m, s, a_fin, a_ref, gc),
                    |m| single_fin_cna_supersonic(m, alpha, a_fin, a_ref) * relief(m),
                );
                let now = single_fin_cna(m, alpha, s, a_fin, a_ref, gc, relief, |_| 0.0);
                assert_eq!(now.to_bits(), was.to_bits(), "M={m} α={alpha}");
            }
        }
    }

    fn rect_strips(chord: f64, span: f64, r_t: f64, n: usize) -> Vec<Strip> {
        (0..n)
            .map(|k| Strip {
                xi: r_t + span * (k as f64 + 0.5) / n as f64,
                chord,
                width: span / n as f64,
            })
            .collect()
    }

    #[test]
    fn tip_relief_of_a_rectangle_is_linear_theory() {
        // Rectangular panel, c = 0.1, s = 0.1: AR = 2. Hand values of
        // 1 − 1/(2 β AR): M 2 (β = √3) 0.8556624, M 3 (β = √8) 0.9116117,
        // M 1.25 (β = 0.75, β AR = 1.5) 0.6666667.
        let (c, s, r_t) = (0.1, 0.1, 0.02);
        let cone = TipCone {
            xi_root: r_t,
            span: s,
            tan_le: 0.0,
            aspect_ratio: 2.0 * s / c,
        };
        let strips = rect_strips(c, s, r_t, 20_000);
        for (m, hand) in [(2.0, 0.855_662_4), (3.0, 0.911_611_7), (1.25, 0.666_666_7)] {
            let f = cone.panel_factor(m, &strips);
            assert!((f - hand).abs() < 2e-6, "M={m}: {f}");
            assert!((rectangular_tip_relief(beta(m) * 2.0) - hand).abs() < 1e-7);
        }
        // TR 1307 chart 8, λ = 1: β C_Lα = 4·factor is 2 at βA = 1 and 3 at
        // βA = 2.
        assert!((4.0 * rectangular_tip_relief(1.0) - 2.0).abs() < 1e-12);
        assert!((4.0 * rectangular_tip_relief(2.0) - 3.0).abs() < 1e-12);
        // No relief far from the tip; half load right at it.
        assert_eq!(tip_cone_strip_factor(2.0, c, 0.0, 10.0, 0.0), 1.0);
        let at_tip = tip_cone_strip_factor(2.0, c, s * (1.0 - 1e-12), s, 0.0);
        assert!((at_tip - 0.5).abs() < 1e-9);
    }

    #[test]
    fn strip_sum_matches_rectangular_closed_form_at_low_beta_ar() {
        // The strip rule with both tips, times the low-aspect-ratio factor,
        // against the closed form across β·AR from 0.1 to 6.
        let (s, r_t) = (0.05, 0.01);
        for ar in [0.1_f64, 0.3, 0.6, 0.9, 1.3, 2.0, 5.0] {
            let c = 2.0 * s / ar;
            let cone = TipCone {
                xi_root: r_t,
                span: s,
                tan_le: 0.0,
                aspect_ratio: ar,
            };
            let strips = rect_strips(c, s, r_t, 20_000);
            for m in [1.5_f64, 2.0, 4.0] {
                let f = cone.panel_factor(m, &strips);
                let closed = rectangular_tip_relief(beta(m) * ar);
                assert!((f - closed).abs() < 1e-5, "AR={ar} M={m}: {f} vs {closed}");
            }
        }
    }

    #[test]
    fn low_beta_ar_slope_is_continuous_positive_monotone_and_slender() {
        // β C_Lα = 4·factor of the rectangular wing against g = β·AR.
        let slope = |g: f64| 4.0 * rectangular_tip_relief(g);
        // Slender-wing line (π/2) g up to g = 0.5: π/8 at 0.25, π/4 at 0.5,
        // 0.6283185 at 0.4.
        assert!((slope(0.25) - std::f64::consts::FRAC_PI_8).abs() < 1e-12);
        assert!((slope(0.5) - std::f64::consts::FRAC_PI_4).abs() < 1e-12);
        assert!((slope(0.4) - 0.628_318_5).abs() < 1e-7);
        // Mid-blend, hand: H(0.75) = (π/4 + 2)/2 + 0.5(π/2 − 2)/8 = 1.3658739.
        assert!((slope(0.75) - 1.365_873_9).abs() < 1e-7);
        // Continuous in value and slope at both switches.
        let h = 1e-6;
        for g in [0.5_f64, 1.0] {
            let (l, c, r) = (slope(g - h), slope(g), slope(g + h));
            assert!((l - c).abs() < 1e-5 && (r - c).abs() < 1e-5, "C0 at {g}");
            assert!(((c - l) / h - (r - c) / h).abs() < 1e-4, "C1 at {g}");
        }
        // Positive and strictly increasing from 0.01 to 20; below 4.
        let mut prev = 0.0;
        for k in 1..=2000 {
            let v = slope(0.01 * k as f64);
            assert!(v > prev && v < 4.0, "g={}", 0.01 * k as f64);
            prev = v;
        }
        // Up to g = 1 the slope never drops below the slender-wing (π/2) g.
        for k in 1..=100 {
            let g = 0.01 * k as f64;
            assert!(slope(g) >= PI / 2.0 * g * (1.0 - 1e-12), "g={g}");
        }
    }

    #[test]
    fn tip_relief_handles_sweep_and_taper() {
        // Swept trapezoid c_r = 0.12, c_t = 0.06, s = 0.08, Γ_L = 30°.
        let (cr, ct, s, r_t) = (0.12, 0.06, 0.08, 0.02);
        let n = 4000;
        let strips: Vec<Strip> = (0..n)
            .map(|k| {
                let y = s * (k as f64 + 0.5) / n as f64;
                Strip {
                    xi: r_t + y,
                    chord: cr + (ct - cr) * y / s,
                    width: s / n as f64,
                }
            })
            .collect();
        let area = 0.5 * (cr + ct) * s;
        let cone = TipCone {
            xi_root: r_t,
            span: s,
            tan_le: 30f64.to_radians().tan(),
            aspect_ratio: 2.0 * s * s / area,
        };
        // M 2: β AR = 3.079, the opposite tip is off the panel, and the own
        // tip's Mach line l_w = (s − y)(tan 30° + √3) meets the chord
        // c(y) at s − y = c_t/(tan Γ_L + β − (c_r − c_t)/s) = 0.0384763. The
        // cone covers the triangle ½·0.0384763·0.06, half its load is lost:
        // 1 − ½(0.0011543)/0.0072 = 0.9198410.
        let f = cone.panel_factor(2.0, &strips);
        assert!((f - 0.919_841_0).abs() < 2e-6, "{f}");
        // Sweep moves the Mach line aft on every strip, so the loss is less
        // than the unswept panel's.
        let unswept = TipCone {
            tan_le: 0.0,
            ..cone
        };
        assert!(unswept.panel_factor(2.0, &strips) < f);
        // More relief (smaller factor) toward M 1.5, none in the limit of
        // high Mach.
        assert!(cone.panel_factor(1.5, &strips) < f);
        assert!(cone.panel_factor(50.0, &strips) > 0.99);
        // Every strip factor stays within [0, 1].
        for m in [1.01_f64, 1.5, 3.0] {
            for st in &strips {
                let v = cone.strip_factor(m, st);
                assert!((0.0..=1.0).contains(&v));
            }
        }
    }

    #[test]
    fn forward_swept_leading_edge_is_treated_as_unswept() {
        // c_r = 1, c_t = 0.5, s = 0.5, Γ_L = −30°: the tip-cone geometry
        // clamps tan Γ_L at 0, so the panel factor equals the unswept
        // panel's and stays between the half-load floor and 1.
        let (cr, ct, s, r_t) = (1.0, 0.5, 0.5, 0.1);
        let n = 4000;
        let strips: Vec<Strip> = (0..n)
            .map(|k| {
                let y = s * (k as f64 + 0.5) / n as f64;
                Strip {
                    xi: r_t + y,
                    chord: cr + (ct - cr) * y / s,
                    width: s / n as f64,
                }
            })
            .collect();
        let unswept = TipCone {
            xi_root: r_t,
            span: s,
            tan_le: 0.0,
            aspect_ratio: 2.0 * s * s / (0.5 * (cr + ct) * s),
        };
        let forward = TipCone {
            tan_le: (-30f64).to_radians().tan(),
            ..unswept
        };
        for m in [1.5_f64, 2.0] {
            let f = forward.panel_factor(m, &strips);
            assert_eq!(f, unswept.panel_factor(m, &strips), "M={m}");
            assert!(f > 0.5 && f < 1.0, "M={m}: {f}");
            println!("forward-swept panel factor M={m}: {f:.6}");
        }
    }
}
