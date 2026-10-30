//! Pitch damping, roll forcing, and roll damping (Niskanen 2009 §3.2.3 and
//! §3.3). Barrowman's pitch-damping result (3-115) is blank in the scan
//! (literature-map Errata), so pitch damping uses Niskanen's estimates.
//!
//! Sign convention: the damping coefficients are magnitudes for the given
//! rates and act against them (the caller applies −sign(ω)); roll forcing
//! carries the sign of the cant angle.

use crate::fins::Strip;
use crate::mach::{beta, busemann_cp, transonic_blend};

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

/// Supersonic roll-damping coefficient, (N/(A_ref d)) Σ C_P,i c_i ξ_i Δξ_i with
/// the Busemann C_P at the strip incidence η_i = ω ξ_i / V.
/// cite: niskanen-2009 eq 3.72 p 49
pub fn roll_damping_supersonic(
    count: u32,
    mach: f64,
    omega: f64,
    a_ref: f64,
    d_ref: f64,
    speed: f64,
    strips: &[Strip],
) -> f64 {
    if a_ref <= 0.0 || d_ref <= 0.0 || speed <= 0.0 {
        return 0.0;
    }
    let sum: f64 = strips
        .iter()
        .map(|s| busemann_cp(mach, (omega * s.xi / speed).atan()) * s.chord * s.xi * s.width)
        .sum();
    count as f64 / (a_ref * d_ref) * sum
}

/// Roll damping over the whole Mach range (subsonic to M 0.9, supersonic
/// from M 1.5, C¹ blend between).
/// cite: niskanen-2009 eq 3.69 p 49
pub fn roll_damping(
    count: u32,
    mach: f64,
    omega: f64,
    a_ref: f64,
    d_ref: f64,
    speed: f64,
    strips: &[Strip],
) -> f64 {
    let sum = strip_sum(strips);
    transonic_blend(
        mach,
        |m| roll_damping_subsonic(count, m, omega, a_ref, d_ref, speed, sum),
        |m| roll_damping_supersonic(count, m, omega, a_ref, d_ref, speed, strips),
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
        let d = roll_damping(4, 0.6, 5.0, a, 0.054, 200.0, &strips);
        assert!(close(
            d,
            4.0 * (2.0 * PI / 0.8) * 5.0 / (a * 0.054 * 200.0) * sum,
            1e-12
        ));
        // Supersonic, linear in small ω: K_1 = 2/β term dominates.
        let s2 = roll_damping(4, 2.0, 1e-3, a, 0.054, 600.0, &strips);
        let lin = 4.0 / (a * 0.054) * (2.0 / 3.0_f64.sqrt()) * 1e-3 / 600.0 * sum;
        assert!(close(s2, lin, 1e-4));
        // Odd in ω.
        let neg = roll_damping(4, 2.0, -1e-3, a, 0.054, 600.0, &strips);
        assert!(close(-neg, s2, 1e-12));
    }
}
