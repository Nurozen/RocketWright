//! Injector sizing (SP-125 sec. 4.6, "Design Calculations"): the orifice
//! flow relation ṁ = Cd A √(2 ρ ΔP) and the injection velocity.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Discharge coefficient used when none is given (SP-125 p 137: 0.5-0.92).
pub const DEFAULT_CD: f64 = 0.7;

/// Pressure drop across an orifice of area `a` and discharge coefficient
/// `cd` passing `mdot` of a liquid of density `rho`: ΔP = (ṁ / (Cd A))² / (2ρ).
///
/// cite: sp-125 eq 4-40 p 137
pub fn pressure_drop(mdot: f64, cd: f64, a: f64, rho: f64) -> f64 {
    let g = mdot / (cd * a);
    g * g / (2.0 * rho)
}

/// Total orifice area that passes `mdot` with pressure drop `dp`:
/// A = ṁ / (Cd √(2 ρ ΔP)) (eq 4-40 solved for A).
///
/// cite: sp-125 eq 4-40 p 137
pub fn orifice_area(mdot: f64, cd: f64, rho: f64, dp: f64) -> f64 {
    mdot / (cd * (2.0 * rho * dp).sqrt())
}

/// Mass flow through an orifice with pressure drop `dp` (eq 4-40 solved for ṁ).
///
/// cite: sp-125 eq 4-40 p 137
pub fn orifice_flow(cd: f64, a: f64, rho: f64, dp: f64) -> f64 {
    cd * a * (2.0 * rho * dp.max(0.0)).sqrt()
}

/// Injection velocity V = ṁ / (A ρ).
///
/// cite: sp-125 eq 4-39 p 137
pub fn injection_velocity(mdot: f64, a: f64, rho: f64) -> f64 {
    mdot / (a * rho)
}

/// One propellant's injector elements at the design point.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct InjectorSide {
    pub mdot: f64,
    pub density: f64,
    pub cd: f64,
    pub pressure_drop: f64,
    /// Total orifice area.
    pub area: f64,
    pub velocity: f64,
}

/// Sizes one side of the injector for `mdot` at pressure drop `dp`.
///
/// cite: sp-125 eq 4-40 p 137
pub fn size_side(mdot: f64, rho: f64, cd: f64, dp: f64) -> InjectorSide {
    let area = orifice_area(mdot, cd, rho, dp);
    InjectorSide {
        mdot,
        density: rho,
        cd,
        pressure_drop: dp,
        area,
        velocity: injection_velocity(mdot, area, rho),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn area_flow_and_drop_are_consistent() {
        let (m, cd, rho, dp) = (0.55, 0.7, 786.6, 4e5);
        let a = orifice_area(m, cd, rho, dp);
        assert!((pressure_drop(m, cd, a, rho) - dp).abs() < 1e-6);
        assert!((orifice_flow(cd, a, rho, dp) - m).abs() < 1e-12);
        // Bernoulli: V = Cd √(2ΔP/ρ) for the vena-contracta-corrected area.
        let s = size_side(m, rho, cd, dp);
        assert!((s.velocity - cd * (2.0 * dp / rho).sqrt()).abs() < 1e-9);
    }
}
