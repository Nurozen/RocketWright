//! Thrust-chamber sizing (SP-125 ch. 1 and sec. 4.3): throat from the thrust
//! coefficient, flow from c*, exit from the area ratio, chamber volume from
//! L*, cylinder length from the contraction ratio, and a conical nozzle.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::solve::brent;
use crate::thermo::Thermo;

/// Convergent half-angle of the chamber (SP-125 sample calc. 4-2), rad.
pub const CONVERGENT_HALF_ANGLE: f64 = 20.0 * std::f64::consts::PI / 180.0;
/// Divergent half-angle of the conical nozzle (12-18 deg, SP-125 p 99), rad.
pub const DIVERGENT_HALF_ANGLE: f64 = 15.0 * std::f64::consts::PI / 180.0;
/// Throat contour radius over throat radius (0.5-1.5, SP-125 p 98).
pub const THROAT_CONTOUR_RATIO: f64 = 1.0;

/// Thrust coefficient at ambient pressure `pa`: the vacuum coefficient minus
/// the pressure-thrust deficit, Cf = Cf_vac − ε pa / Pc.
///
/// cite: sp-125 eq 1-33a p 21
pub fn cf_at_ambient(cf_vac: f64, eps: f64, pc: f64, pa: f64) -> f64 {
    cf_vac - eps * pa / pc
}

/// Throat area for thrust `f` at chamber pressure `pc`: At = F / (Cf Pc).
///
/// cite: sp-125 eq 1-34 p 22
pub fn throat_area(f: f64, cf: f64, pc: f64) -> f64 {
    f / (cf * pc)
}

/// Propellant mass flow through the throat: ṁ = Pc At / c*.
///
/// cite: sp-125 eq 1-32 p 21
pub fn mass_flow(pc: f64, at: f64, c_star: f64) -> f64 {
    pc * at / c_star
}

/// Thrust from the thrust coefficient: F = Cf At Pc.
///
/// cite: sp-125 eq 1-33 p 21
pub fn thrust(cf: f64, at: f64, pc: f64) -> f64 {
    cf * at * pc
}

/// Chamber volume (injector face to throat) from L*: Vc = L* At.
///
/// cite: sp-125 eq 4-4 p 95
pub fn chamber_volume(l_star: f64, at: f64) -> f64 {
    l_star * at
}

/// Cylindrical chamber length Lc for volume `vc`, throat area `at`,
/// contraction ratio εc = Ac/At, and convergent half-angle θ:
/// Vc = At [Lc εc + (1/3) √(At/π) cot θ (εc^(1/3) − 1)], solved for Lc.
///
/// cite: sp-125 eq 4-5 p 97
pub fn chamber_cylinder_length(vc: f64, at: f64, contraction: f64, theta: f64) -> f64 {
    let conv = (at / std::f64::consts::PI).sqrt() / theta.tan() * (contraction.cbrt() - 1.0) / 3.0;
    (vc / at - conv) / contraction
}

/// Axial length of the convergent cone from the chamber radius to the throat
/// radius at half-angle θ (geometry of SP-125 fig. 4-9).
///
/// cite: sp-125 eq 4-5 p 97
pub fn convergent_length(rc: f64, rt: f64, theta: f64) -> f64 {
    (rc - rt) / theta.tan()
}

/// Conical nozzle length from the throat to the exit:
/// Ln = [Rt (√ε − 1) + R (sec α − 1)] / tan α.
///
/// cite: sp-125 eq 4-7 p 99
pub fn conical_nozzle_length(rt: f64, eps: f64, alpha: f64, r_contour: f64) -> f64 {
    (rt * (eps.sqrt() - 1.0) + r_contour * (1.0 / alpha.cos() - 1.0)) / alpha.tan()
}

/// Diameter of a circle of area `a`.
/// cite: n/a circle geometry
pub fn diameter(a: f64) -> f64 {
    (4.0 * a / std::f64::consts::PI).sqrt()
}

/// The thrust-chamber design at the design point (SI).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "EngineSizing")]
pub struct Sizing {
    /// Ambient pressure the thrust target holds at, Pa.
    pub ambient_pressure: f64,
    pub chamber_pressure: f64,
    pub mixture_ratio: f64,
    pub expansion_ratio: f64,
    pub exit_pressure: f64,
    pub c_star: f64,
    pub cf_vac: f64,
    /// At `ambient_pressure`.
    pub cf: f64,
    pub isp_vac: f64,
    /// At `ambient_pressure` (m/s).
    pub isp: f64,
    pub thrust: f64,
    pub thrust_vac: f64,
    pub mdot: f64,
    pub mdot_ox: f64,
    pub mdot_fuel: f64,
    pub chamber_temperature: f64,
    pub gamma_c: f64,
    pub throat_area: f64,
    pub throat_diameter: f64,
    pub exit_area: f64,
    pub exit_diameter: f64,
    pub contraction_ratio: f64,
    pub chamber_area: f64,
    pub chamber_diameter: f64,
    pub l_star: f64,
    pub chamber_volume: f64,
    /// Cylindrical section (injector face to the start of the convergence).
    pub chamber_length: f64,
    pub convergent_length: f64,
    pub nozzle_length: f64,
    /// Injector face to the exit plane.
    pub total_length: f64,
}

/// What sizing needs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SizingInput {
    pub thrust: f64,
    pub chamber_pressure: f64,
    pub mixture_ratio: f64,
    /// Area ratio, or `None` to solve it from `exit_pressure`.
    pub expansion_ratio: Option<f64>,
    pub exit_pressure: Option<f64>,
    pub contraction_ratio: f64,
    pub l_star: f64,
    pub ambient_pressure: f64,
}

/// The area ratio whose exit pressure is `pe` (Brent on ln ε over the
/// thermo's range).
///
/// cite: sp-125 eq 1-33a p 21
pub fn eps_for_exit_pressure(
    thermo: &dyn Thermo,
    of: f64,
    pc: f64,
    pe: f64,
) -> Result<f64, String> {
    let (lo, hi) = thermo.eps_range().unwrap_or((1.1, 400.0));
    let g = |le: f64| match thermo.point(of, pc, le.exp()) {
        Ok(p) => pc / p.pc_pe - pe,
        Err(_) => f64::NAN,
    };
    brent(g, lo.ln(), hi.ln(), 1e-10)
        .map(f64::exp)
        .map_err(|e| format!("no area ratio gives exit pressure {pe} Pa: {e}"))
}

/// Sizes the chamber and nozzle for the thrust target at the design point.
///
/// cite: sp-125 eq 1-34 p 22
pub fn size(input: &SizingInput, thermo: &dyn Thermo) -> Result<Sizing, String> {
    let (pc, of, pa) = (
        input.chamber_pressure,
        input.mixture_ratio,
        input.ambient_pressure,
    );
    let eps = match (input.expansion_ratio, input.exit_pressure) {
        (Some(e), _) => e,
        (None, Some(pe)) => eps_for_exit_pressure(thermo, of, pc, pe)?,
        (None, None) => return Err("neither an expansion ratio nor an exit pressure".into()),
    };
    let tp = thermo.point(of, pc, eps)?;
    let cf = cf_at_ambient(tp.cf_vac, eps, pc, pa);
    if cf <= 0.0 {
        return Err(format!(
            "the thrust coefficient at ambient pressure is {cf:.3}: the nozzle is far over-expanded"
        ));
    }
    let at = throat_area(input.thrust, cf, pc);
    let mdot = mass_flow(pc, at, tp.c_star);
    let ae = eps * at;
    let ac = input.contraction_ratio * at;
    let vc = chamber_volume(input.l_star, at);
    let lc = chamber_cylinder_length(vc, at, input.contraction_ratio, CONVERGENT_HALF_ANGLE);
    let (rt, rc) = (diameter(at) / 2.0, diameter(ac) / 2.0);
    let lconv = convergent_length(rc, rt, CONVERGENT_HALF_ANGLE);
    let ln = conical_nozzle_length(rt, eps, DIVERGENT_HALF_ANGLE, THROAT_CONTOUR_RATIO * rt);
    Ok(Sizing {
        ambient_pressure: pa,
        chamber_pressure: pc,
        mixture_ratio: of,
        expansion_ratio: eps,
        exit_pressure: pc / tp.pc_pe,
        c_star: tp.c_star,
        cf_vac: tp.cf_vac,
        cf,
        isp_vac: tp.c_star * tp.cf_vac,
        isp: tp.c_star * cf,
        thrust: input.thrust,
        thrust_vac: thrust(tp.cf_vac, at, pc),
        mdot,
        mdot_ox: mdot * of / (1.0 + of),
        mdot_fuel: mdot / (1.0 + of),
        chamber_temperature: tp.t_c,
        gamma_c: tp.gamma_c,
        throat_area: at,
        throat_diameter: 2.0 * rt,
        exit_area: ae,
        exit_diameter: diameter(ae),
        contraction_ratio: input.contraction_ratio,
        chamber_area: ac,
        chamber_diameter: 2.0 * rc,
        l_star: input.l_star,
        chamber_volume: vc,
        chamber_length: lc.max(0.0),
        convergent_length: lconv,
        nozzle_length: ln,
        total_length: lc.max(0.0) + lconv + ln,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chamber_volume_round_trips_through_the_cylinder_length() {
        // SP-125 eq 4-5: the volume rebuilt from Lc equals L* At.
        let (at, ec, ls) = (5e-4, 4.0, 1.5);
        let vc = chamber_volume(ls, at);
        let lc = chamber_cylinder_length(vc, at, ec, CONVERGENT_HALF_ANGLE);
        let rebuilt = at
            * (lc * ec
                + (at / std::f64::consts::PI).sqrt() / CONVERGENT_HALF_ANGLE.tan()
                    * (ec.cbrt() - 1.0)
                    / 3.0);
        assert!((rebuilt - vc).abs() < 1e-15);
        assert!(lc > 0.0);
    }

    #[test]
    fn nozzle_length_is_zero_at_unit_area_ratio_and_sharp_throat() {
        assert!(conical_nozzle_length(0.01, 1.0, DIVERGENT_HALF_ANGLE, 0.0).abs() < 1e-15);
        let l = conical_nozzle_length(0.01, 4.0, DIVERGENT_HALF_ANGLE, 0.0);
        assert!((l - 0.01 / DIVERGENT_HALF_ANGLE.tan()).abs() < 1e-12);
    }
}
