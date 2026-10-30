//! Skin friction: turbulent (Niskanen), laminar and transitional (Barrowman),
//! roughness by finish, compressibility corrections, and the conversion to
//! the reference area.

use rw_model::FinishPreset;

/// Boundary-layer model for the skin-friction coefficient.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BoundaryLayer {
    /// Fully turbulent from the nose tip (niskanen-2009 §3.4.1 model choice).
    #[default]
    Turbulent,
    /// Laminar below the transition Reynolds number, then Barrowman's
    /// transitional/turbulent law (barrowman-1967 eq 4-2, 4-6).
    Transitional,
}

/// Flow regime that set C_f (selects the compressibility correction).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Regime {
    Laminar,
    Turbulent,
    /// Roughness-limited (Re above Re_crit,ε).
    Rough,
}

/// Transition Reynolds number Re_crit ≈ 5·10⁵.
pub const RE_TRANSITION: f64 = 5.0e5;
/// Lower validity bound of the C_f fits; below it C_f is held at its Re = 10⁴ value.
pub const RE_MIN: f64 = 1.0e4;

/// Roughness height used when a component carries no finish: production
/// paint (Table 3.2, 20 µm).
pub const DEFAULT_ROUGHNESS: f64 = 20e-6;

/// Reynolds number Re = V L / ν.
/// cite: niskanen-2009 eq 3.12 p 39
pub fn reynolds(speed: f64, length: f64, nu: f64) -> f64 {
    if nu <= 0.0 {
        return 0.0;
    }
    (speed * length / nu).abs()
}

/// Roughness height ε of a finish preset, from the surface table: polished
/// 0.5 µm (finished and polished), smooth paint 5 µm (optimum spray paint),
/// regular paint 20 µm (production paint), unfinished 150 µm, rough 500 µm
/// (raw wooden boards).
/// cite: niskanen-2009 tab 3.2 p 54
pub fn roughness_for_finish(finish: FinishPreset) -> f64 {
    match finish {
        FinishPreset::Polished => 0.5e-6,
        FinishPreset::SmoothPaint => 5e-6,
        FinishPreset::RegularPaint => 20e-6,
        FinishPreset::Unfinished => 150e-6,
        FinishPreset::Rough => 500e-6,
    }
}

/// Smooth-wall turbulent C_f = 1/(1.50 ln Re − 5.6)².
/// cite: niskanen-2009 eq 3.78 p 53
pub fn cf_turbulent(re: f64) -> f64 {
    let re = re.max(RE_MIN);
    1.0 / (1.50 * re.ln() - 5.6).powi(2)
}

/// Roughness-limited critical Reynolds number Re_crit,ε = 51 (ε/L)^−1.039.
/// cite: niskanen-2009 eq 3.79 p 54
pub fn re_crit_roughness(eps: f64, length: f64) -> f64 {
    if eps <= 0.0 || length <= 0.0 {
        return f64::INFINITY;
    }
    51.0 * (eps / length).powf(-1.039)
}

/// Roughness-limited C_f = 0.032 (ε/L)^0.2.
/// cite: niskanen-2009 eq 3.80 p 54
pub fn cf_rough(eps: f64, length: f64) -> f64 {
    if eps <= 0.0 || length <= 0.0 {
        return 0.0;
    }
    0.032 * (eps / length).powf(0.2)
}

/// Laminar flat-plate C_f = 1.328/sqrt(Re).
/// cite: barrowman-1967 eq 4-2 p 53
pub fn cf_laminar(re: f64) -> f64 {
    1.328 / re.max(RE_MIN).sqrt()
}

/// Transitional/turbulent smooth C_f = 1/(3.46 log10 Re − 5.6)² − 1700/Re (Re > 5·10⁵).
/// cite: barrowman-1967 eq 4-6 p 57
pub fn cf_transitional(re: f64) -> f64 {
    let re = re.max(RE_MIN);
    1.0 / (3.46 * re.log10() - 5.6).powi(2) - 1700.0 / re
}

/// Incompressible skin-friction coefficient and its regime. Turbulent model:
/// eq 3.81 (held at Re = 10⁴ below it, eq 3.78, or eq 3.80 above Re_crit,ε).
/// Transitional model: laminar eq 4-2 below 5·10⁵, eq 4-6 above, and the
/// same roughness limit.
///
/// The roughness-limited value acts as a floor on the turbulent value: eq 3.79
/// only approximates where the eq 3.78 curve meets the flat eq 3.80 line
/// (Fig 3.10), and switching on Re_crit,ε alone leaves a jump of several
/// percent at the switch. The regime is `Rough` whenever the floor applies.
/// cite: niskanen-2009 eq 3.81 p 54
pub fn skin_friction(re: f64, eps: f64, length: f64, bl: BoundaryLayer) -> (f64, Regime) {
    let rough = cf_rough(eps, length);
    let (cf, regime) = match bl {
        BoundaryLayer::Turbulent => (cf_turbulent(re), Regime::Turbulent),
        BoundaryLayer::Transitional if re < RE_TRANSITION => (cf_laminar(re), Regime::Laminar),
        BoundaryLayer::Transitional => (cf_transitional(re), Regime::Turbulent),
    };
    let turbulent = regime == Regime::Turbulent || re > re_crit_roughness(eps, length);
    if turbulent && rough > cf {
        (rough, Regime::Rough)
    } else {
        (cf, regime)
    }
}

/// Compressibility-corrected C_fc. Subsonic: C_f (1 − 0.1 M²) for turbulent
/// and roughness-limited layers (laminar unchanged, barrowman-1967 p 47).
/// Supersonic: turbulent C_f/(1 + 0.15 M²)^0.58; roughness-limited
/// C_f/(1 + 0.18 M²) but never below the corrected smooth turbulent value at
/// the same Re; laminar C_f/(1 + 0.045 M²)^¼ (barrowman-1967 eq 4-11).
/// cite: niskanen-2009 eq 3.82 p 55
pub fn compressible_cf(cf: f64, regime: Regime, re: f64, mach: f64) -> f64 {
    let m2 = mach * mach;
    if mach < 1.0 {
        return match regime {
            Regime::Laminar => cf,
            _ => cf * (1.0 - 0.1 * m2),
        };
    }
    let turb = |c: f64| c / (1.0 + 0.15 * m2).powf(0.58);
    match regime {
        Regime::Laminar => cf / (1.0 + 0.045 * m2).powf(0.25),
        Regime::Turbulent => turb(cf),
        Regime::Rough => (cf / (1.0 + 0.18 * m2)).max(turb(cf_turbulent(re))),
    }
}

/// Body wetted-area factor for its cylindrical geometry, 1 + 1/(2 f_B).
/// cite: niskanen-2009 eq 3.85 p 56
pub fn body_wetted_factor(fineness: f64) -> f64 {
    if fineness <= 0.0 {
        return 1.0;
    }
    1.0 + 1.0 / (2.0 * fineness)
}

/// Fin wetted-area factor for finite thickness, 1 + 2 t/c̄.
/// cite: niskanen-2009 eq 3.85 p 56
pub fn fin_wetted_factor(thickness: f64, mac: f64) -> f64 {
    if mac <= 0.0 {
        return 1.0;
    }
    1.0 + 2.0 * thickness / mac
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * b.abs().max(1e-300)
    }

    #[test]
    fn turbulent_cf_worked_values() {
        // Re = 10⁶: 1/(1.5·13.8155 − 5.6)² = 1/15.1233² = 4.3723e-3.
        assert!(close(cf_turbulent(1e6), 4.3723e-3, 1e-4));
        // Low-Re clamp: C_f(Re < 10⁴) = 1.48e-2 (eq 3.81 first branch).
        assert!(close(cf_turbulent(10.0), 1.48e-2, 3e-3));
        assert_eq!(cf_turbulent(10.0), cf_turbulent(1e4));
    }

    #[test]
    fn roughness_limit_worked_values() {
        // ε = 60 µm on L = 0.4 m: ε/L = 1.5e-4.
        let (eps, l) = (60e-6, 0.4);
        let rc = 51.0 * 1.5e-4_f64.powf(-1.039);
        assert!(close(re_crit_roughness(eps, l), rc, 1e-12));
        assert!(close(cf_rough(eps, l), 0.032 * 1.5e-4_f64.powf(0.2), 1e-12));
        let (cf, reg) = skin_friction(rc * 1.01, eps, l, BoundaryLayer::Turbulent);
        assert_eq!(reg, Regime::Rough);
        assert!(close(cf, 0.032 * 1.5e-4_f64.powf(0.2), 1e-12));
        // Floor: just below Re_crit,ε the smooth value is still under the rough one.
        let (cf, reg) = skin_friction(rc * 0.99, eps, l, BoundaryLayer::Turbulent);
        assert_eq!(reg, Regime::Rough);
        assert!(cf >= cf_turbulent(rc * 0.99));
        // Far below it the smooth turbulent law governs.
        let (cf, reg) = skin_friction(1e5, eps, l, BoundaryLayer::Turbulent);
        assert_eq!(reg, Regime::Turbulent);
        assert!(close(cf, cf_turbulent(1e5), 1e-12));
    }

    #[test]
    fn laminar_and_transitional() {
        assert!(close(cf_laminar(4e5), 1.328 / 4e5_f64.sqrt(), 1e-12));
        // Re = 10⁶: 1/(3.46·6 − 5.6)² − 1700e-6 = 1/15.16² − 1.7e-3.
        assert!(close(
            cf_transitional(1e6),
            1.0 / 15.16_f64.powi(2) - 1.7e-3,
            1e-12
        ));
        let (_, r) = skin_friction(1e5, 1e-7, 1.0, BoundaryLayer::Transitional);
        assert_eq!(r, Regime::Laminar);
        let (_, r) = skin_friction(1e6, 1e-7, 1.0, BoundaryLayer::Transitional);
        assert_eq!(r, Regime::Turbulent);
    }

    #[test]
    fn compressibility_corrections() {
        let cf = 4e-3;
        assert!(close(
            compressible_cf(cf, Regime::Turbulent, 1e6, 0.5),
            cf * 0.975,
            1e-12
        ));
        assert!(close(
            compressible_cf(cf, Regime::Laminar, 1e6, 0.5),
            cf,
            1e-12
        ));
        assert!(close(
            compressible_cf(cf, Regime::Turbulent, 1e6, 2.0),
            cf / 1.6_f64.powf(0.58),
            1e-12
        ));
        // Rough value floored at the corrected smooth turbulent value.
        let rough = compressible_cf(1e-4, Regime::Rough, 1e6, 2.0);
        assert!(close(rough, cf_turbulent(1e6) / 1.6_f64.powf(0.58), 1e-12));
        assert!(close(
            compressible_cf(cf, Regime::Laminar, 1e6, 2.0),
            cf / 1.18_f64.powf(0.25),
            1e-12
        ));
    }

    #[test]
    fn finish_table_and_factors() {
        assert!(
            roughness_for_finish(FinishPreset::Polished)
                < roughness_for_finish(FinishPreset::Rough)
        );
        assert!(close(body_wetted_factor(10.0), 1.05, 1e-12));
        assert!(close(fin_wetted_factor(0.003, 0.1), 1.06, 1e-12));
        assert!(close(
            reynolds(100.0, 0.4, 1.5e-5),
            100.0 * 0.4 / 1.5e-5,
            1e-12
        ));
    }
}
