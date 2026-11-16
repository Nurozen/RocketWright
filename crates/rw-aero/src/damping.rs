//! Pitch damping, roll forcing, and roll damping (Niskanen 2009 §3.2.3 and
//! §3.3). Barrowman's pitch-damping result (3-115) is blank in the scan
//! (literature-map Errata), so pitch damping uses Niskanen's estimates.
//!
//! Sign convention: the damping coefficients are magnitudes for the given
//! rates and act against them (the caller applies −sign(ω)); roll forcing
//! carries the sign of the cant angle.

use crate::fins::{Strip, TipCone};
use crate::mach::{
    beta, flat_plate_strip_dcp, transonic_blend, wedge_half_angle, wedge_strip_secant,
};

/// Body pitch-damping coefficient of one portion (fore or aft of the CG) of
/// length l and mean radius r_t: 0.55 (l⁴ r_t/(A_ref d)) (ω²/V²).
/// cite: niskanen-2009 eq 3.59 p 45
pub fn pitch_damping_body(
    length: f64,
    mean_radius: f64,
    a_ref: f64,
    d_ref: f64,
    omega: f64,
    speed: f64,
) -> f64 {
    if a_ref <= 0.0 || d_ref <= 0.0 || speed <= 0.0 {
        return 0.0;
    }
    0.55 * length.powi(4) * mean_radius / (a_ref * d_ref) * (omega / speed).powi(2)
}

/// Fin-set pitch-damping coefficient, 0.6 (N A_fin ξ³/(A_ref d)) (ω²/V²), with
/// N capped at 4 (the other fins see no direct cross-flow).
/// cite: niskanen-2009 eq 3.60 p 46
pub fn pitch_damping_fins(
    count: u32,
    a_fin: f64,
    arm: f64,
    a_ref: f64,
    d_ref: f64,
    omega: f64,
    speed: f64,
) -> f64 {
    if a_ref <= 0.0 || d_ref <= 0.0 || speed <= 0.0 {
        return 0.0;
    }
    let n = count.min(4) as f64;
    0.6 * n * a_fin * arm.abs().powi(3) / (a_ref * d_ref) * (omega / speed).powi(2)
}

/// Roll-forcing coefficient of canted fins, N (y_mac + r_t)(C_Nα)_1 δ / d.
/// cite: niskanen-2009 eq 3.66 p 48
pub fn roll_forcing(count: u32, y_mac: f64, r_t: f64, cna1: f64, cant: f64, d_ref: f64) -> f64 {
    if d_ref <= 0.0 {
        return 0.0;
    }
    count as f64 * (y_mac + r_t) * cna1 * cant / d_ref
}

/// Strip sum Σ c ξ² Δξ of a fin (ξ from the body axis).
/// cite: niskanen-2009 eq 3.69 p 49
pub fn strip_sum(strips: &[Strip]) -> f64 {
    strips.iter().map(|s| s.chord * s.xi * s.xi * s.width).sum()
}

/// Closed-form strip sum of a trapezoid fin,
/// (c_r + c_t)/2 r_t² s + (c_r + 2c_t)/3 r_t s² + (c_r + 3c_t)/12 s³.
/// cite: niskanen-2009 eq 3.70 p 49
pub fn trapezoid_strip_sum(c_r: f64, c_t: f64, span: f64, r_t: f64) -> f64 {
    let s = span;
    (c_r + c_t) / 2.0 * r_t * r_t * s
        + (c_r + 2.0 * c_t) / 3.0 * r_t * s * s
        + (c_r + 3.0 * c_t) / 12.0 * s * s * s
}

/// Closed-form strip sum of an elliptical fin, c_r ((π/4) r_t² s + (2/3) r_t s² + (π/16) s³).
/// cite: niskanen-2009 eq 3.71 p 49
pub fn elliptical_strip_sum(c_r: f64, span: f64, r_t: f64) -> f64 {
    let s = span;
    let pi = std::f64::consts::PI;
    c_r * (pi / 4.0 * r_t * r_t * s + 2.0 / 3.0 * r_t * s * s + pi / 16.0 * s * s * s)
}

/// Subsonic roll-damping coefficient, (N C_Nα0 ω/(A_ref d V)) Σ c ξ² Δξ with
/// C_Nα0 = 2π/β.
/// cite: niskanen-2009 eq 3.69 p 49
pub fn roll_damping_subsonic(
    count: u32,
    mach: f64,
    omega: f64,
    a_ref: f64,
    d_ref: f64,
    speed: f64,
    sum: f64,
) -> f64 {
    if a_ref <= 0.0 || d_ref <= 0.0 || speed <= 0.0 {
        return 0.0;
    }
    let cna0 = 2.0 * std::f64::consts::PI / beta(mach.min(0.999_999));
    count as f64 * cna0 * omega / (a_ref * d_ref * speed) * sum
}

/// Supersonic roll-damping coefficient, (N/(A_ref d)) Σ f_i ΔC_P,i c_i ξ_i Δξ_i
/// with the two-face flat-plate ΔC_P ([`flat_plate_strip_dcp`]) at the strip
/// incidence η_i = atan(ω ξ_i / V) and the strip's tip Mach-cone load factor
/// f_i ([`TipCone::strip_factor`]). niskanen-2009 (3.72) sums one face's C_P,i
/// with no tip factor (literature-map Errata). Roll forcing takes the
/// two-face single-fin slope with the same strip factors area-weighted, so
/// from M 1.5 at small spin the two share the 2D load and differ only in how
/// the tip loss is weighted (ξ here, the panel mean there). A single-wedge
/// section of trailing-edge thickness `wedge_thickness` adds its thickness
/// lift η_i (4 C_2 δ_i + 6 K_3 δ_i²) to each strip's ΔC_P
/// ([`wedge_strip_secant`]); pass 0.0 for a section with equal edge
/// thicknesses, which adds exactly zero.
/// cite: niskanen-2009 eq 3.72 p 49
/// cite: barrowman-1967 eq 8 p 96
/// cite: barrowman-1967 eq 33a-33d p 98
/// cite: barrowman-1967 eq 39-44 p 102
#[allow(clippy::too_many_arguments)]
pub fn roll_damping_supersonic(
    count: u32,
    mach: f64,
    omega: f64,
    a_ref: f64,
    d_ref: f64,
    speed: f64,
    strips: &[Strip],
    tip: &TipCone,
    wedge_thickness: f64,
) -> f64 {
    if a_ref <= 0.0 || d_ref <= 0.0 || speed <= 0.0 {
        return 0.0;
    }
    let sum: f64 = strips
        .iter()
        .map(|s| {
            let eta = (omega * s.xi / speed).atan();
            let wedge = wedge_strip_secant(mach, wedge_half_angle(wedge_thickness, s.chord));
            tip.strip_factor(mach, s)
                * if wedge == 0.0 {
                    flat_plate_strip_dcp(mach, eta)
                } else {
                    flat_plate_strip_dcp(mach, eta) + eta * wedge
                }
                * s.chord
                * s.xi
                * s.width
        })
        .sum();
    count as f64 / (a_ref * d_ref) * sum
}

/// Roll damping over the whole Mach range (subsonic to M 0.9, supersonic
/// with tip relief from M 1.5, C¹ blend between). `wedge_thickness` as in
/// [`roll_damping_supersonic`].
/// cite: niskanen-2009 eq 3.69 p 49
#[allow(clippy::too_many_arguments)]
pub fn roll_damping(
    count: u32,
    mach: f64,
    omega: f64,
    a_ref: f64,
    d_ref: f64,
    speed: f64,
    strips: &[Strip],
    tip: &TipCone,
    wedge_thickness: f64,
) -> f64 {
    let sum = strip_sum(strips);
    transonic_blend(
        mach,
        |m| roll_damping_subsonic(count, m, omega, a_ref, d_ref, speed, sum),
        |m| {
            roll_damping_supersonic(
                count,
                m,
                omega,
                a_ref,
                d_ref,
                speed,
                strips,
                tip,
                wedge_thickness,
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * b.abs().max(1e-300)
    }

    fn trapezoid_strips(c_r: f64, c_t: f64, s: f64, r_t: f64, n: usize) -> Vec<Strip> {
        (0..n)
            .map(|k| {
                let y = s * (k as f64 + 0.5) / n as f64;
                Strip {
                    xi: r_t + y,
                    chord: c_r + (c_t - c_r) * y / s,
                    width: s / n as f64,
                }
            })
            .collect()
    }

    #[test]
    fn pitch_damping_worked_values() {
        // l = 0.3, r = 0.0125, d = 0.025, ω = 2, V = 10.
        let a = PI * 0.0125 * 0.0125;
        let v = pitch_damping_body(0.3, 0.0125, a, 0.025, 2.0, 10.0);
        assert!(close(v, 0.55 * 0.0081 * 0.0125 / (a * 0.025) * 0.04, 1e-12));
        // 6 fins count as 4.
        let f6 = pitch_damping_fins(6, 0.0015, 0.1, a, 0.025, 2.0, 10.0);
        let f4 = pitch_damping_fins(4, 0.0015, 0.1, a, 0.025, 2.0, 10.0);
        assert_eq!(f6, f4);
        assert!(close(
            f4,
            0.6 * 4.0 * 0.0015 * 1e-3 / (a * 0.025) * 0.04,
            1e-12
        ));
    }

    #[test]
    fn strip_sum_matches_closed_forms() {
        let (cr, ct, s, rt) = (0.14, 0.06, 0.09, 0.027);
        let num = strip_sum(&trapezoid_strips(cr, ct, s, rt, 4000));
        assert!(close(num, trapezoid_strip_sum(cr, ct, s, rt), 1e-6));
        // Elliptical: c(y) = c_r sqrt(1 − (y/s)²).
        let n = 20000;
        let ell: Vec<Strip> = (0..n)
            .map(|k| {
                let y = s * (k as f64 + 0.5) / n as f64;
                Strip {
                    xi: rt + y,
                    chord: cr * (1.0 - (y / s).powi(2)).sqrt(),
                    width: s / n as f64,
                }
            })
            .collect();
        assert!(close(
            strip_sum(&ell),
            elliptical_strip_sum(cr, s, rt),
            1e-5
        ));
    }

    #[test]
    fn roll_terms() {
        let a = PI * 0.027 * 0.027;
        // Roll forcing: N (y_mac + r_t) C_Nα1 δ / d.
        let f = roll_forcing(4, 0.04, 0.027, 3.0, 0.01, 0.054);
        assert!(close(f, 4.0 * 0.067 * 3.0 * 0.01 / 0.054, 1e-12));
        // Subsonic damping at M = 0.6 (β = 0.8).
        let strips = trapezoid_strips(0.14, 0.06, 0.09, 0.027, 400);
        let sum = strip_sum(&strips);
        // Tip geometry of the same trapezoid (unswept leading edge).
        let tip = TipCone {
            xi_root: 0.027,
            span: 0.09,
            tan_le: 0.0,
            aspect_ratio: 2.0 * 0.09 * 0.09 / (0.5 * (0.14 + 0.06) * 0.09),
        };
        let d = roll_damping(4, 0.6, 5.0, a, 0.054, 200.0, &strips, &tip, 0.0);
        assert!(close(
            d,
            4.0 * (2.0 * PI / 0.8) * 5.0 / (a * 0.054 * 200.0) * sum,
            1e-12
        ));
        // Supersonic, linear in small ω, with no tip in reach (a panel whose
        // tip is far outboard of these strips): both faces, 2 K_1 = 4/β.
        let far = TipCone {
            span: 100.0,
            aspect_ratio: 1e6,
            ..tip
        };
        let s2 = roll_damping(4, 2.0, 1e-3, a, 0.054, 600.0, &strips, &far, 0.0);
        let lin = 4.0 / (a * 0.054) * (4.0 / 3.0_f64.sqrt()) * 1e-3 / 600.0 * sum;
        assert!(close(s2, lin, 1e-4));
        // Damping and forcing use the same two-face slope per unit fin area.
        // The small-rate equilibrium spin is then the ratio of the two: the
        // (3.74) closed form with 8π for 4π when there is no tip relief
        // (DM-15). With tip relief the factor enters both, the forcing as
        // the area mean and the damping strip by strip, so only the ratio
        // form holds.
        let per_area = crate::fins::single_fin_cna_supersonic(2.0, 0.0, 1.0, 1.0);
        assert!(close(per_area, 4.0 / 3.0_f64.sqrt(), 1e-12));
        assert!(close(
            s2,
            4.0 / (a * 0.054) * per_area * 1e-3 / 600.0 * sum,
            1e-4
        ));
        // Odd in ω.
        let neg = roll_damping(4, 2.0, -1e-3, a, 0.054, 600.0, &strips, &far, 0.0);
        assert!(close(-neg, s2, 1e-12));
        // With the real tip the damping is less than the 2D value, and
        // reduced more than the panel's area-weighted factor because the tip
        // strips have the longest arm.
        let s3 = roll_damping(4, 2.0, 1e-3, a, 0.054, 600.0, &strips, &tip, 0.0);
        let panel = tip.panel_factor(2.0, &strips);
        assert!(s3 / s2 < panel && panel < 1.0 && s3 / s2 > 0.5);
        // Hand value on a rectangle: c = 0.1, r = 0.02, s = 0.1 (R = 0.12),
        // M 2 (β = √3, β AR = 3.46, only the own tip's Mach line on the
        // panel, c/β = 0.0577350 < s). Unrelieved ∫ c ξ² dξ = c(R³ − r³)/3 =
        // 5.7333333e-5; the cone takes ½∫₀^(c/β) (c − βu)(R − u)² du =
        // 1.4919818e-5 (u from the tip), leaving 4.2413515e-5: ratio
        // 0.7397706.
        let (c, r, s) = (0.1, 0.02, 0.1);
        let rect = trapezoid_strips(c, c, s, r, 20_000);
        let rect_tip = TipCone {
            xi_root: r,
            span: s,
            tan_le: 0.0,
            aspect_ratio: 2.0 * s / c,
        };
        let rect_far = TipCone {
            span: 100.0,
            aspect_ratio: 1e6,
            ..rect_tip
        };
        let with_tip = roll_damping(4, 2.0, 1e-3, a, 0.054, 600.0, &rect, &rect_tip, 0.0);
        let no_tip = roll_damping(4, 2.0, 1e-3, a, 0.054, 600.0, &rect, &rect_far, 0.0);
        assert!(close(with_tip / no_tip, 0.739_770_6, 1e-6));
    }

    #[test]
    fn supersonic_roll_damping_is_bounded_at_high_spin() {
        // Strip incidence above 17.5° takes the held secant slope, so the
        // damping per unit incidence stops growing with spin.
        let strips = trapezoid_strips(0.14, 0.06, 0.09, 0.027, 400);
        let a = PI * 0.027 * 0.027;
        let tip = TipCone {
            xi_root: 0.027,
            span: 100.0,
            tan_le: 0.0,
            aspect_ratio: 1e6,
        };
        // ω ξ/V from 0.58 to 2.5 across the span: every strip above the limit.
        let w = 13_000.0;
        let d = roll_damping_supersonic(4, 2.0, w, a, 0.054, 600.0, &strips, &tip, 0.0);
        let secant = crate::mach::flat_plate_strip_secant(2.0, 1.0);
        let by_hand: f64 = strips
            .iter()
            .map(|s| secant * (w * s.xi / 600.0).atan() * s.chord * s.xi * s.width)
            .sum::<f64>()
            * 4.0
            / (a * 0.054);
        assert!(close(d, by_hand, 1e-12));
    }

    #[test]
    fn wedge_section_adds_its_thickness_lift_to_roll_damping() {
        // Rectangular panel c = s = 0.03 at r_t = 0.015, t = 0.0024
        // (δ = atan 0.04), M 2, no tip in reach: every strip's ΔC_P/η is
        // 2.5528999 against the flat plate's 2.3094011 (mach.rs hand values),
        // so the damping is larger by that ratio at small spin.
        let strips: Vec<Strip> = (0..400)
            .map(|k| Strip {
                xi: 0.015 + 0.03 * (k as f64 + 0.5) / 400.0,
                chord: 0.03,
                width: 0.03 / 400.0,
            })
            .collect();
        let far = TipCone {
            xi_root: 0.015,
            span: 100.0,
            tan_le: 0.0,
            aspect_ratio: 1e6,
        };
        let (a, d) = (7.0e-4, 0.03);
        let flat = roll_damping_supersonic(4, 2.0, 1e-3, a, d, 600.0, &strips, &far, 0.0);
        let wedge = roll_damping_supersonic(4, 2.0, 1e-3, a, d, 600.0, &strips, &far, 0.0024);
        assert!((wedge / flat - 2.552_899_9 / 2.309_401_1).abs() < 1e-6);
        // Odd in the spin, and the zero-thickness call is the flat plate's
        // own sum to the last bit.
        let neg = roll_damping_supersonic(4, 2.0, -1e-3, a, d, 600.0, &strips, &far, 0.0024);
        assert!(close(-neg, wedge, 1e-12));
        let was: f64 = strips
            .iter()
            .map(|s| {
                far.strip_factor(2.0, s)
                    * flat_plate_strip_dcp(2.0, (1e-3 * s.xi / 600.0_f64).atan())
                    * s.chord
                    * s.xi
                    * s.width
            })
            .sum();
        assert_eq!(flat.to_bits(), (4.0 / (a * d) * was).to_bits());
    }
}
