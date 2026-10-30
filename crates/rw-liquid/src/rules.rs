//! Design rules on a sized engine (codes in [`crate::diag`]). Each rule is a
//! pure check returning a finding at the source field an agent would patch.

use rw_model::Diagnostic;

use crate::diag::{self, diag};

/// Injector pressure drop as a fraction of chamber pressure (SP-125 p 137
/// rule of thumb 15-20%; we accept 15-25%).
pub const INJECTOR_DP_BAND: (f64, f64) = (0.15, 0.25);
/// L* band, m (15-120 in, SP-125 p 96).
pub const L_STAR_BAND: (f64, f64) = (0.381, 3.048);
/// Smallest contraction ratio (SP-125 p 97: 2-5 for pressure-fed engines).
pub const MIN_CONTRACTION: f64 = 2.0;
/// Exit-to-ambient pressure band at the design point.
pub const PE_PA_BAND: (f64, f64) = (0.4, 3.0);
/// Tank volume over propellant volume (10% ullage and reserve, SP-125 eq 8-1).
pub const TANK_MARGIN: f64 = 1.10;
/// Smallest hoop-stress safety factor on yield.
pub const MIN_HOOP_SF: f64 = 2.0;

fn pct(x: f64) -> String {
    format!("{:.1}%", 100.0 * x)
}

/// `RW-E220` when ΔP_inj / Pc leaves [`INJECTOR_DP_BAND`].
///
/// cite: sp-125 eq 4-40 p 137
pub fn injector_dp(engine: &str, path: String, dp: f64, pc: f64) -> Option<Diagnostic> {
    let r = dp / pc;
    let (lo, hi) = INJECTOR_DP_BAND;
    (!(lo..=hi).contains(&r)).then(|| {
        diag(
            diag::E_INJECTOR_DP,
            path,
            format!(
                "engine `{engine}`: the injector drop is {} of chamber pressure (band {}-{})",
                pct(r),
                pct(lo),
                pct(hi)
            ),
            "set `injector.pressure_drop_fraction` between 0.15 and 0.25",
        )
    })
}

/// `RW-E221` when L* leaves [`L_STAR_BAND`].
///
/// cite: sp-125 eq 4-4 p 95
pub fn l_star(engine: &str, path: String, l_star: f64) -> Option<Diagnostic> {
    let (lo, hi) = L_STAR_BAND;
    (!(lo..=hi).contains(&l_star)).then(|| {
        diag(
            diag::E_L_STAR,
            path,
            format!("engine `{engine}`: L* is {l_star:.3} m, outside {lo:.2}-{hi:.2} m"),
            "SP-125 table 4-1 lists 0.6-1.3 m for storable pairs; 1-2 m suits N2O/alcohol",
        )
    })
}

/// `RW-E222` when the contraction ratio is below [`MIN_CONTRACTION`].
///
/// cite: sp-125 eq 4-5 p 97
pub fn contraction(engine: &str, path: String, ratio: f64) -> Option<Diagnostic> {
    (ratio < MIN_CONTRACTION).then(|| {
        diag(
            diag::E_CONTRACTION,
            path,
            format!("engine `{engine}`: the contraction ratio Ac/At is {ratio:.2}, below {MIN_CONTRACTION}"),
            "use 2-5 for a pressure-fed chamber",
        )
    })
}

/// `RW-E223` when Pe / Pa leaves [`PE_PA_BAND`].
///
/// cite: sp-125 eq 1-33a p 21
pub fn exit_pressure(engine: &str, path: String, pe: f64, pa: f64) -> Option<Diagnostic> {
    let r = pe / pa;
    let (lo, hi) = PE_PA_BAND;
    (!(lo..=hi).contains(&r)).then(|| {
        diag(
            diag::E_EXIT_PRESSURE,
            path,
            format!(
                "engine `{engine}`: exit pressure is {:.3} bar, {r:.2} times ambient (band {lo}-{hi})",
                pe / 1e5
            ),
            if r < lo {
                "lower the expansion ratio (the nozzle over-expands and may separate)"
            } else {
                "raise the expansion ratio (the nozzle under-expands)"
            },
        )
    })
}

/// `RW-E224` when the tank holds less than [`TANK_MARGIN`] × its load.
///
/// cite: sp-125 eq 8-1 p 341
pub fn tank_margin(node: &str, path: String, tank_volume: f64, liquid: f64) -> Option<Diagnostic> {
    (tank_volume < TANK_MARGIN * liquid).then(|| {
        diag(
            diag::E_TANK_MARGIN,
            path,
            format!(
                "tank `{node}` is {} full; leave at least {} of the load as ullage",
                pct(liquid / tank_volume),
                pct(TANK_MARGIN - 1.0)
            ),
            "reduce the fill or enlarge the tank",
        )
    })
}

/// `RW-E225` when yield over hoop stress is below [`MIN_HOOP_SF`].
///
/// cite: sp-125 eq 8-30 p 348
pub fn hoop(node: &str, path: String, stress: f64, yield_strength: f64) -> Option<Diagnostic> {
    let sf = yield_strength / stress;
    (sf < MIN_HOOP_SF).then(|| {
        diag(
            diag::E_TANK_HOOP,
            path,
            format!(
                "tank `{node}`: hoop stress {:.1} MPa leaves a safety factor of {sf:.2} on yield (need {MIN_HOOP_SF})",
                stress / 1e6
            ),
            "thicken the wall, lower the pressure, or use a stronger material",
        )
    })
}

/// `RW-E226` when the tank pressure is below what the design flow needs.
///
/// cite: sp-125 eq 7-7 p 292
pub fn feed_pressure(node: &str, path: String, have: f64, need: f64) -> Option<Diagnostic> {
    (have < need).then(|| {
        diag(
            diag::E_FEED_PRESSURE,
            path,
            format!(
                "tank `{node}` is at {:.2} bar but the design flow needs {:.2} bar (chamber + injector + lines)",
                have / 1e5,
                need / 1e5
            ),
            "raise the tank pressure, widen the lines, or lower the chamber pressure",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bands() {
        assert!(injector_dp("e", "/p".into(), 4e5, 20e5).is_none());
        assert_eq!(
            injector_dp("e", "/p".into(), 1e5, 20e5).unwrap().code,
            "RW-E220"
        );
        assert!(l_star("e", "/p".into(), 1.5).is_none());
        assert!(l_star("e", "/p".into(), 0.2).is_some());
        assert!(contraction("e", "/p".into(), 1.5).is_some());
        assert!(exit_pressure("e", "/p".into(), 0.8e5, 101_325.0).is_none());
        assert!(exit_pressure("e", "/p".into(), 0.3e5, 101_325.0).is_some());
        assert!(tank_margin("t", "/p".into(), 6.0, 5.0).is_none());
        assert!(tank_margin("t", "/p".into(), 6.0, 5.6).is_some());
        assert!(hoop("t", "/p".into(), 100e6, 276e6).is_none());
        assert!(hoop("t", "/p".into(), 150e6, 276e6).is_some());
        assert!(feed_pressure("t", "/p".into(), 30e5, 25e5).is_none());
        assert!(feed_pressure("t", "/p".into(), 20e5, 25e5).is_some());
    }
}
