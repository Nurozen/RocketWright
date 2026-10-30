//! Diagnostic codes owned by `rw-check` (invariant I9): E100-149
//! aero/stability, E150-199 clearance and interference (W150-199 for the
//! advisory clearance findings), W100-149 motor, W250-299 recovery
//! deployment (W200-249 stays with liquid). Same row shape as
//! `rw_model::diag::CODES`, so `cargo xtask diag-docs` can render both.

use rw_model::Diagnostic;
use rw_model::Severity;
use rw_model::diag::CodeInfo;

macro_rules! codes {
    ($( $konst:ident = $code:literal, $slug:literal, $sev:ident, $summary:literal; )*) => {
        $( #[doc = $summary] pub const $konst: &str = $code; )*
        /// Every code owned by `rw-check`, sorted.
        pub const CODES: &[CodeInfo] = &[
            $( CodeInfo { code: $code, slug: $slug, severity: Severity::$sev, summary: $summary }, )*
        ];
    };
}

codes! {
    E_NO_REFERENCE = "RW-E100", "no-reference-diameter", Error, "The model has no reference diameter, so stability margins cannot be computed.";
    E_UNSTABLE = "RW-E101", "unstable", Error, "The CP is forward of the CG at liftoff or during the burn (negative stability margin).";
    E_COUPLER_FIT = "RW-E150", "coupler-fit", Error, "A coupler or shoulder is wider than the inner diameter of the tube it slides into.";
    E_RING_FIT = "RW-E151", "centering-ring-fit", Error, "A centering ring is wider than its tube's inner diameter, or its bore is smaller than the mount tube.";
    E_MOTOR_FIT = "RW-E152", "motor-fit", Error, "The motor is wider than the mount's inner diameter or longer than the mount allows.";
    E_FIN_TAB = "RW-E153", "fin-tab-wall", Error, "A fin tab reaches deeper than the room between the body wall and the inner tube.";
    E_FIN_JOINT = "RW-E154", "fin-across-joint", Error, "A fin root runs past the end of the body tube it is mounted on.";
    E_RECOVERY_VOLUME = "RW-E155", "recovery-volume", Error, "The packed recovery items need more volume than their bay holds.";
    E_OVERLAP = "RW-E156", "overlap", Error, "Two internal components occupy the same space.";
    E_PROTRUSION = "RW-E157", "protrusion", Error, "An internal component sticks out of its parent tube.";
    W_MOTOR_UNRESOLVED = "RW-W101", "motor-unresolved", Warning, "A configured motor was not resolved to a thrust curve, so it is missing from mass and motor checks.";
    W_LOW_THRUST_TO_WEIGHT = "RW-W102", "low-thrust-to-weight", Warning, "The liftoff thrust-to-weight ratio is below 5.";
    W_MOTOR_SUBSTITUTED = "RW-W103", "motor-substituted", Warning, "An imported motor had no curve offline, so the nearest built-in generic curve by impulse class and diameter stands in for it. Accept it with `accept_substitution = true` on the configuration's motor.";
    W_FIN_TAB_SHORT = "RW-W150", "fin-tab-short", Warning, "A fin tab is shallower than the body wall, so it does not reach through it.";
    W_NO_DEPLOYMENT = "RW-W250", "recovery-never-deploys", Warning, "A parachute or streamer deploys in no configuration: its event is `never` everywhere, or `ejection` with only plugged motors (no `delay`).";
}

/// Looks a code up in [`CODES`].
/// cite: n/a table lookup, no physics
pub fn code_info(code: &str) -> Option<&'static CodeInfo> {
    CODES.iter().find(|c| c.code == code)
}

/// A diagnostic for a code in [`CODES`] (severity from the table).
pub(crate) fn diag(code: &str, path: Option<String>, message: String, hint: String) -> Diagnostic {
    let mut d = Diagnostic::new(code, path, message).with_hint(hint);
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
            let sev = match &c.code[3..4] {
                "E" => Severity::Error,
                "W" => Severity::Warning,
                _ => Severity::Info,
            };
            assert_eq!(sev, c.severity, "{}", c.code);
            match (&c.code[3..4], n) {
                ("E", 100..=199) | ("W", 100..=199) | ("W", 250..=299) => {}
                _ => panic!("{} outside rw-check's ranges", c.code),
            }
            assert!(rw_model::diag::code_info(c.code).is_none(), "{}", c.code);
        }
    }
}
