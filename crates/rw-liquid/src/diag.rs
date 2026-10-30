//! Diagnostic codes owned by `rw-liquid` (invariant I9): the liquid design
//! rules, `RW-E220`..`RW-E249`. `rw-model` owns `RW-E200`..`E219` (feed graph,
//! input ranges) and the missing-input warnings `RW-W210`..`W212`. Same row
//! shape as `rw_model::diag::CODES`, so `cargo xtask diag-docs` renders it.

use rw_model::Diagnostic;
use rw_model::Severity;
use rw_model::diag::CodeInfo;

macro_rules! codes {
    ($( $konst:ident = $code:literal, $slug:literal, $sev:ident, $summary:literal; )*) => {
        $( #[doc = $summary] pub const $konst: &str = $code; )*
        /// Every code owned by `rw-liquid`, sorted.
        pub const CODES: &[CodeInfo] = &[
            $( CodeInfo { code: $code, slug: $slug, severity: Severity::$sev, summary: $summary }, )*
        ];
    };
}

codes! {
    E_INJECTOR_DP = "RW-E220", "injector-pressure-drop", Error, "The injector pressure drop lies outside 15-25% of chamber pressure (SP-125 p 137): lower risks chugging, higher wastes feed pressure.";
    E_L_STAR = "RW-E221", "l-star-range", Error, "The characteristic length L* lies outside 0.38-3.05 m (15-120 in, SP-125 p 96).";
    E_CONTRACTION = "RW-E222", "contraction-ratio", Error, "The chamber contraction ratio Ac/At is below 2 (SP-125 p 97 gives 2-5 for pressure-fed engines).";
    E_EXIT_PRESSURE = "RW-E223", "exit-pressure-range", Error, "The nozzle exit pressure lies outside 0.4-3 times ambient at the design point: badly over- or under-expanded.";
    E_TANK_MARGIN = "RW-E224", "tank-margin", Error, "A tank's internal volume is less than 110% of its propellant load (SP-125 eq 8-1 ullage and reserve).";
    E_TANK_HOOP = "RW-E225", "tank-hoop-stress", Error, "A tank's hoop stress at its working pressure leaves a safety factor below 2 on the wall material's yield strength.";
    E_FEED_PRESSURE = "RW-E226", "feed-pressure-low", Error, "A tank's pressure is below the chamber pressure plus the injector and line losses at the design flow.";
    E_THERMO = "RW-E227", "thermo-unavailable", Error, "No thermochemistry for the propellants or operating point: the pair is not tabulated and native CEA is not available, or the point lies outside the table.";
    E_FLUID_MODEL = "RW-E228", "fluid-model-unsupported", Error, "The engine's `fluid_model` is not supported yet (two-phase self-pressurizing N2O needs an equation of state; use single_phase_liquid).";
    E_PROPELLANT = "RW-E229", "propellant-unknown", Error, "A tank holds a liquid or pressurant with no density or gas data in the built-in table.";
}

/// Looks a code up in [`CODES`].
/// cite: n/a table lookup, no physics
pub fn code_info(code: &str) -> Option<&'static CodeInfo> {
    CODES.iter().find(|c| c.code == code)
}

/// A diagnostic for a code in [`CODES`] with a hint.
/// cite: n/a constructor, no physics
pub fn diag(code: &str, path: String, message: String, hint: &str) -> Diagnostic {
    let mut d = Diagnostic::new(code, path, message).with_hint(hint.to_string());
    if let Some(c) = code_info(code) {
        d.severity = c.severity;
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_table_is_sorted_unique_and_in_range() {
        for w in CODES.windows(2) {
            assert!(w[0].code < w[1].code, "{} !< {}", w[0].code, w[1].code);
        }
        for c in CODES {
            let n: u32 = c.code[4..].parse().unwrap();
            assert_eq!(&c.code[3..4], "E", "{}", c.code);
            assert_eq!(c.severity, Severity::Error, "{}", c.code);
            assert!(
                (220..250).contains(&n),
                "{} outside rw-liquid's range",
                c.code
            );
            assert!(rw_model::diag::code_info(c.code).is_none(), "{}", c.code);
        }
    }
}
