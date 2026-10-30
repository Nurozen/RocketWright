//! Pressure drag: nose cones and shoulders (Niskanen 2009 §3.4.3 and
//! Appendix B), boattails, and fin leading/trailing edges (§3.4.4). Values
//! are C_D• on the component's own frontal area; the caller scales by
//! A_comp/A_ref (CO-11).

use rw_model::{FinCrossSection, NoseShape};

use crate::drag::base::base_cd;
use crate::mach::{GAMMA, hermite, stagnation_cd};

/// Lower Mach bound of the supersonic cone formula (B.4).
const CONE_SUPERSONIC: f64 = 1.3;

/// How the transonic/supersonic nose drag curve was obtained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoseDragModel {
    /// Conical data (B.4-B.6).
    Cone,
    /// Cone scaled by the ogive shape factor (B.8).
    Ogive,
    /// Shapes whose f_N = 3 data (Stoney, PD-19) is not in any local source:
    /// the cone curve of equal length and diameter is used (literature-map Gaps 5).
    ConeFallback,
}

impl NoseDragModel {
    /// The model selected for a profile shape.
    /// cite: niskanen-2009 sec B.5 p 119-120
    pub fn for_shape(shape: NoseShape) -> Self {
        match shape {
            NoseShape::Conical => Self::Cone,
            NoseShape::Ogive => Self::Ogive,
            _ => Self::ConeFallback,
        }
    }
}

/// Low-subsonic nose pressure drag from the joint angle φ: 0.8 sin²φ.
/// cite: niskanen-2009 eq 3.86 p 57
pub fn nose_joint_cd(joint_angle: f64) -> f64 {
    0.8 * joint_angle.sin().powi(2)
}

/// Sine of the cone half-apex angle from the fineness f_N: sin ε = 1/sqrt(1 + 4 f_N²).
/// cite: niskanen-2009 eq B.3 p 117
pub fn cone_sin_half_angle(fineness: f64) -> f64 {
    1.0 / (1.0 + 4.0 * fineness * fineness).sqrt()
}

/// Supersonic cone pressure drag 2.1 sin²ε + 0.5 sin ε/sqrt(M² − 1) (M ≳ 1.3).
/// cite: niskanen-2009 eq B.4 p 117
pub fn cone_cd_supersonic(fineness: f64, mach: f64) -> f64 {
    let s = cone_sin_half_angle(fineness);
    2.1 * s * s + 0.5 * s / (mach * mach - 1.0).max(1e-12).sqrt()
}

/// Cone pressure drag at M = 1, C_D•,M=1 = sin ε.
/// cite: niskanen-2009 eq B.6 p 118
pub fn cone_cd_sonic(fineness: f64) -> f64 {
    cone_sin_half_angle(fineness)
}

/// Cone pressure-drag slope at M = 1, (4/(γ + 1))(1 − 0.5 C_D•,M=1).
/// cite: niskanen-2009 eq B.5 p 117
pub fn cone_slope_sonic(fineness: f64) -> f64 {
    4.0 / (GAMMA + 1.0) * (1.0 - 0.5 * cone_cd_sonic(fineness))
}

/// Cone pressure drag for M ≥ 1: the cubic through (B.5)/(B.6) at M = 1 and
/// (B.4) with its slope at M = 1.3, then (B.4). Returns (value, slope).
/// cite: niskanen-2009 eq B.4 p 117-118
pub fn cone_cd_transonic(fineness: f64, mach: f64) -> (f64, f64) {
    let m = mach.max(1.0);
    let sup = |x: f64| cone_cd_supersonic(fineness, x);
    let s = cone_sin_half_angle(fineness);
    let dsup = |x: f64| -0.5 * s * x / (x * x - 1.0).powf(1.5);
    if m >= CONE_SUPERSONIC {
        return (sup(m), dsup(m));
    }
    let (y0, d0) = (cone_cd_sonic(fineness), cone_slope_sonic(fineness));
    let (y1, d1) = (sup(CONE_SUPERSONIC), dsup(CONE_SUPERSONIC));
    let h = 1e-6;
    let f = |x: f64| hermite(x, 1.0, CONE_SUPERSONIC, y0, d0, y1, d1);
    (f(m), (f(m + h) - f(m)) / h)
}

/// Ogive shape factor on the cone drag, 0.72 (κ − 0.5)² + 0.82.
/// cite: niskanen-2009 eq B.8 p 120
pub fn ogive_factor(kappa: f64) -> f64 {
    let k = kappa.clamp(0.0, 1.0);
    0.72 * (k - 0.5).powi(2) + 0.82
}

/// High-subsonic interpolation a M^b + C_0 fitted to value `c1` and slope
/// `d1` at the lower bound of the transonic method (M = 1); held at C_0 when
/// the transonic value does not exceed it (non-decreasing curve).
/// cite: niskanen-2009 eq 3.87 p 58
pub fn subsonic_fit(mach: f64, c0: f64, c1: f64, d1: f64) -> f64 {
    let a = c1 - c0;
    if a <= 1e-12 || d1 <= 0.0 {
        return c0;
    }
    let b = d1 / a;
    a * mach.max(0.0).powf(b) + c0
}

/// Nose (or shoulder) pressure drag on its own frontal area over the full
/// Mach range: subsonic eq 3.86/3.87 fitted at M = 1 to the transonic curve
/// of the shape's model (cone, ogive-scaled cone, or cone fallback).
/// cite: niskanen-2009 sec B.5 p 119-120
pub fn nose_pressure_cd(
    shape: NoseShape,
    param: f64,
    fineness: f64,
    joint_angle: f64,
    mach: f64,
) -> f64 {
    let k = match NoseDragModel::for_shape(shape) {
        NoseDragModel::Ogive => ogive_factor(param),
        _ => 1.0,
    };
    let c0 = nose_joint_cd(joint_angle);
    if mach >= 1.0 {
        return k * cone_cd_transonic(fineness, mach).0;
    }
    let (c1, d1) = cone_cd_transonic(fineness, 1.0);
    subsonic_fit(mach, c0, k * c1, k * d1)
}

/// Boattail pressure drag on the boattail frontal area: the base drag times
/// 1 (γ < 1), (3 − γ)/2 (1 < γ < 3), or 0 (γ > 3), γ = l/(d_0 − d_1). The
/// printed A_base/A_bt ratio is taken as 1 (the boattail's own frontal area
/// acts as the base; a zero-length boattail then equals the base drag of the
/// step, as the text states).
/// cite: niskanen-2009 eq 3.88 p 59
pub fn boattail_cd(length: f64, d0: f64, d1: f64, mach: f64) -> f64 {
    let dd = d0 - d1;
    if dd <= 0.0 {
        return 0.0;
    }
    let g = length / dd;
    let f = if g < 1.0 {
        1.0
    } else if g < 3.0 {
        (3.0 - g) / 2.0
    } else {
        0.0
    };
    f * base_cd(mach)
}

/// Rounded fin leading-edge drag normal to the edge (cylinder in cross-flow):
/// (1 − M²)^−0.417 − 1 (M < 0.9); 1 − 1.785 (M − 0.9) (0.9 ≤ M < 1);
/// 1.214 − 0.502/M² + 0.1095/M⁴ (M ≥ 1).
/// cite: niskanen-2009 eq 3.89 p 59
pub fn fin_le_rounded_cd(mach: f64) -> f64 {
    let m = mach.max(0.0);
    if m < 0.9 {
        (1.0 - m * m).powf(-0.417) - 1.0
    } else if m < 1.0 {
        1.0 - 1.785 * (m - 0.9)
    } else {
        1.214 - 0.502 / (m * m) + 0.1095 / m.powi(4)
    }
}

/// Fin leading-edge drag on the fin frontal area: square edges take the
/// stagnation value (eq 3.90), rounded and airfoil edges eq 3.89; swept by
/// cos²Γ_L (eq 3.91).
/// cite: niskanen-2009 eq 3.91 p 60
pub fn fin_le_cd(section: FinCrossSection, gamma_le: f64, mach: f64) -> f64 {
    let perp = match section {
        FinCrossSection::Square => stagnation_cd(mach),
        FinCrossSection::Rounded | FinCrossSection::Airfoil => fin_le_rounded_cd(mach),
    };
    perp * gamma_le.cos().powi(2)
}

/// Fin trailing-edge (base) drag on the fin frontal area: the body base
/// drag for square edges, half of it for rounded, zero for tapered (airfoil).
/// cite: niskanen-2009 eq 3.92 p 60
pub fn fin_te_cd(section: FinCrossSection, mach: f64) -> f64 {
    match section {
        FinCrossSection::Square => base_cd(mach),
        FinCrossSection::Rounded => 0.5 * base_cd(mach),
        FinCrossSection::Airfoil => 0.0,
    }
}

/// Fin pressure drag (LE + TE) of `count` fins on the reference area; the
/// component frontal area is N t s.
/// cite: niskanen-2009 eq 3.93 p 60
pub fn fin_pressure_cd(
    section: FinCrossSection,
    gamma_le: f64,
    count: u32,
    thickness: f64,
    span: f64,
    a_ref: f64,
    mach: f64,
) -> f64 {
    if a_ref <= 0.0 {
        return 0.0;
    }
    let a = count as f64 * thickness * span;
    a / a_ref * (fin_le_cd(section, gamma_le, mach) + fin_te_cd(section, mach))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * b.abs().max(1e-12)
    }

    #[test]
    fn cone_appendix_b_worked_values() {
        // f_N = 3: sin ε = 1/sqrt(37).
        let s = 1.0 / 37.0_f64.sqrt();
        assert!(close(cone_cd_sonic(3.0), s, 1e-12));
        assert!(close(
            cone_slope_sonic(3.0),
            4.0 / 2.4 * (1.0 - 0.5 * s),
            1e-12
        ));
        // M = 2: 2.1/37 + 0.5/sqrt(37·3).
        assert!(close(
            cone_cd_supersonic(3.0, 2.0),
            2.1 / 37.0 + 0.5 / 111.0_f64.sqrt(),
            1e-12
        ));
        // Transonic cubic meets both ends.
        assert!(close(cone_cd_transonic(3.0, 1.0).0, s, 1e-12));
        assert!(close(
            cone_cd_transonic(3.0, 1.3).0,
            cone_cd_supersonic(3.0, 1.3),
            1e-12
        ));
    }

    #[test]
    fn nose_subsonic_fit() {
        // Tangent joint: zero drag at M = 0, rising to the sonic cone value.
        let c = |m: f64| nose_pressure_cd(NoseShape::Ogive, 1.0, 4.0, 0.0, m);
        assert_eq!(c(0.0), 0.0);
        assert!(c(0.3) < c(0.6) && c(0.6) < c(0.9));
        assert!(close(c(1.0 - 1e-12), cone_cd_sonic(4.0), 1e-6));
        // Cone: joint angle = half-apex angle; M = 0 value 0.8 sin²ε.
        let eps = (1.0_f64 / 6.0).atan();
        let cone0 = nose_pressure_cd(NoseShape::Conical, 0.0, 3.0, eps, 0.0);
        assert!(close(cone0, 0.8 / 37.0, 1e-12));
        // Secant ogive κ = 0.5 is 18% under the cone above M = 1.
        let og = nose_pressure_cd(NoseShape::Ogive, 0.5, 3.0, 0.0, 2.0);
        assert!(close(og, 0.82 * cone_cd_supersonic(3.0, 2.0), 1e-12));
    }

    #[test]
    fn boattail_rule() {
        assert!(close(
            boattail_cd(0.005, 0.05, 0.04, 0.3),
            base_cd(0.3),
            1e-12
        ));
        assert!(close(
            boattail_cd(0.02, 0.05, 0.04, 0.3),
            0.5 * base_cd(0.3),
            1e-12
        ));
        assert_eq!(boattail_cd(0.04, 0.05, 0.04, 0.3), 0.0);
    }

    #[test]
    fn fin_edges() {
        // eq 3.89 is continuous at M = 0.9 (≈ 1) and M = 1 (0.8215).
        assert!((fin_le_rounded_cd(0.9 - 1e-9) - fin_le_rounded_cd(0.9)).abs() < 2e-3);
        assert!((fin_le_rounded_cd(1.0 - 1e-9) - 0.8215).abs() < 1e-6);
        assert!(close(fin_le_rounded_cd(1.0), 0.8215, 1e-12));
        assert!(close(
            fin_le_cd(FinCrossSection::Square, 0.0, 0.0),
            0.85,
            1e-12
        ));
        assert!(close(
            fin_le_cd(FinCrossSection::Rounded, 0.5, 0.5),
            fin_le_rounded_cd(0.5) * 0.5_f64.cos().powi(2),
            1e-12
        ));
        assert!(close(
            fin_te_cd(FinCrossSection::Rounded, 0.5),
            0.5 * base_cd(0.5),
            1e-12
        ));
        assert_eq!(fin_te_cd(FinCrossSection::Airfoil, 0.5), 0.0);
        // 3 fins, t = 2 mm, s = 30 mm on A_ref = 4.909e-4.
        let a_ref = std::f64::consts::PI * 0.0125 * 0.0125;
        let v = fin_pressure_cd(FinCrossSection::Square, 0.0, 3, 0.002, 0.03, a_ref, 0.0);
        assert!(close(v, 3.0 * 0.002 * 0.03 / a_ref * (0.85 + 0.12), 1e-12));
    }
}
