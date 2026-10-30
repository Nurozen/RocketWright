//! Diagnostics with stable codes (invariant I9). Code ranges per owner:
//! E000-049 parse/units/expr and files (E015-019: the opt-in ThrustCurve
//! download), E050-099 anchors/containment, E100-149
//! aero/stability, E150-199 clearance, W100-149 motor, W200-249 liquid missing
//! inputs, W250-299 recovery deployment, E200-249 liquid rules (E200-219 here: feed graph and input ranges;
//! E220-249 in `rw-liquid`: design rules), I900+ info. The code table lands with the
//! owning rows; `cargo xtask diag-docs` renders `docs/agents/diagnostics.md`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Pattern for a diagnostic code, e.g. `RW-E021`.
pub const CODE_PATTERN: &str = r"^RW-[EWI][0-9]{3}$";

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// One finding, phrased for an agent (`hint` says what to do next).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Diagnostic {
    /// Stable code, e.g. `RW-E021`.
    #[schemars(extend("pattern" = CODE_PATTERN))]
    pub code: String,
    pub severity: Severity,
    /// JSON pointer into the source model, e.g. `/c/fins/span`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Project-relative file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub col: Option<u32>,
    pub message: String,
    /// Next action for an agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl Diagnostic {
    /// The `resolved_diagnostics` key: `<code>@<path>`.
    pub fn key(&self) -> String {
        format!("{}@{}", self.code, self.path.as_deref().unwrap_or(""))
    }
}

/// One row of the diagnostic code table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodeInfo {
    pub code: &'static str,
    /// Kebab-case slug, e.g. `unit-missing`.
    pub slug: &'static str,
    pub severity: Severity,
    pub summary: &'static str,
}

macro_rules! codes {
    ($( $konst:ident = $code:literal, $slug:literal, $sev:ident, $summary:literal; )*) => {
        $( #[doc = $summary] pub const $konst: &str = $code; )*
        /// Every code owned by `rw-model` (and the `rw-units` codes it reports),
        /// sorted. `cargo xtask diag-docs` renders this table.
        pub const CODES: &[CodeInfo] = &[
            $( CodeInfo { code: $code, slug: $slug, severity: Severity::$sev, summary: $summary }, )*
        ];
    };
}

codes! {
    E_PARSE = "RW-E001", "parse-error", Error, "The file is not valid TOML or JSON.";
    E_SCHEMA = "RW-E002", "schema-error", Error, "A value has the wrong type, or a required field is missing.";
    E_DUPLICATE_ID = "RW-E003", "duplicate-id", Error, "The same id is defined in two source files.";
    E_INCLUDE = "RW-E004", "include-missing", Error, "An `include` names a part file that is not in the project.";
    E_DOC_KIND = "RW-E005", "unknown-file", Error, "The path is not a RocketWright source file.";
    E_LIB_HASH = "RW-E006", "lib-hash", Error, "A file under `lib/` does not match the sha256 recorded in `rocketwright.toml [lib]`, or a recorded file is missing.";
    E_LOCKED = "RW-E007", "locked-by", Error, "Another live process owns the project (`.rw/lock`); mutating calls go through its sidecar.";
    E_MOTOR_DIALECT = "RW-E008", "motor-dialect", Error, "An imported motor file is neither a RASP `.eng` nor a RockSim `.rse` file, or does not parse as one.";
    E_SET = "RW-E010", "bad-override", Error, "A variant or `--set` override names an unknown param or field, or gives an invalid value.";
    E_PARAM_RANGE = "RW-E011", "param-out-of-range", Error, "A param value lies outside its `min`/`max`.";
    E_PARAM_CHOICE = "RW-E012", "param-not-a-choice", Error, "A param value is not one of its `choices`.";
    E_PARAM_DIM = "RW-E013", "param-dimension", Error, "A param's `min`, `max`, `step`, or `choices` differ in dimension from its value.";
    E_VARIANT = "RW-E014", "unknown-variant", Error, "The selected variant is not defined under `[variants]`.";
    E_TC_UNREACHABLE = "RW-E015", "thrustcurve-unreachable", Error, "A ThrustCurve search or download the user asked for could not reach thrustcurve.org (offline, timed out, or the server answered with an error); nothing was written.";
    E_TC_NOT_FOUND = "RW-E016", "thrustcurve-not-found", Error, "ThrustCurve has no motor matching the request, or the motor has no data file in the requested format.";
    E_TC_AMBIGUOUS = "RW-E017", "thrustcurve-ambiguous", Error, "A designation matches several ThrustCurve motors; pass the motor id or a manufacturer.";
    E_UNIT_SYNTAX = "RW-E020", "quantity-syntax", Error, "A quantity cannot be parsed.";
    E_UNIT_MISSING = "RW-E021", "unit-missing", Error, "A bare number on a dimensional field (only `0` may omit the unit).";
    E_UNIT_UNKNOWN = "RW-E022", "unknown-unit", Error, "The unit symbol is not in the unit table.";
    E_UNIT_DIM = "RW-E023", "dimension-mismatch", Error, "The unit has the wrong dimension for the field.";
    E_INVALID_PARENT = "RW-E030", "invalid-parent", Error, "The containment rule table does not allow this component in that parent.";
    E_EXPR_SYNTAX = "RW-E040", "expr-syntax", Error, "An `=` expression cannot be parsed.";
    E_EXPR_UNKNOWN_REF = "RW-E041", "expr-unknown-ref", Error, "An expression refers to a param or input field that does not exist.";
    E_EXPR_CYCLE = "RW-E042", "expr-cycle", Error, "Expressions refer to each other in a cycle.";
    E_EXPR_DIM = "RW-E043", "expr-dimension", Error, "An expression mixes dimensions or has the wrong dimension for its field.";
    E_EXPR_NOT_NUMERIC = "RW-E044", "expr-not-numeric", Error, "An expression refers to a value that is not a number or quantity.";
    E_EXPR_DOMAIN = "RW-E045", "expr-domain", Error, "An expression divides by zero or leaves the domain of a function.";
    E_ATTACH_MISSING = "RW-E050", "attach-missing", Error, "A component other than the first body component has no `attach`.";
    E_ATTACH_TARGET = "RW-E051", "attach-unknown-target", Error, "`attach.to` names a component that does not exist.";
    E_ATTACH_ANCHOR = "RW-E052", "attach-unknown-anchor", Error, "`attach.to` names an anchor the target component does not have.";
    E_ATTACH_AT = "RW-E053", "attach-unknown-self-anchor", Error, "`attach.at` names an anchor this component does not have.";
    E_ATTACH_CYCLE = "RW-E054", "attach-cycle", Error, "Components attach to each other in a cycle.";
    E_STAGE = "RW-E055", "stage-invalid", Error, "A `[stage]` names a component that is not on the body chain, or its `override` does not cover the whole stage (`subtree = true`, no `cd`).";
    E_INSTANCES = "RW-E056", "instances-invalid", Error, "An `instances` pattern is missing its spacing, scale, or a known preset.";
    E_CUT = "RW-E057", "cut-invalid", Error, "A `cut` component has no parent to cut from.";
    E_CONFIG = "RW-E059", "config-invalid", Error, "A configuration names an unknown mount, stage, or recovery component.";
    E_SIM_CONFIG = "RW-E060", "sim-unknown-config", Error, "A simulation names a configuration that does not exist.";
    E_GEOMETRY = "RW-E061", "geometry-invalid", Error, "A component dimension is out of range: a length that must be positive is not, an inner diameter is not below the outer, or a part does not fit its own shape.";
    E_SHAPE_PARAM = "RW-E062", "shape-param-range", Error, "A nose or transition `shape_param` lies outside the range of its profile.";
    E_MATERIAL_UNKNOWN = "RW-E063", "material-unknown", Error, "A component names a material that is not defined under `[materials]`.";
    E_MATERIAL_DENSITY = "RW-E064", "material-density", Error, "A material lacks the density kind the component needs (bulk for solids, surface for canopies and streamers, line for cords), or a density is not positive.";
    E_JOINT = "RW-E065", "joint-invalid", Error, "A `joint` sits on a component that cannot carry one, or has a zero `count`.";
    E_APPEARANCE = "RW-E066", "appearance-invalid", Error, "An `appearance` color is not `#rrggbb`, or roughness, metalness, or transmission is outside 0..1.";
    E_SIM_CONDITIONS = "RW-E067", "sim-conditions-invalid", Error, "A simulation condition is out of range (rail length, rod angle, site, atmosphere, wind, gravity, or integrator settings).";
    E_VISUAL_FLOW = "RW-E068", "visual-flow-invalid", Error, "A `kind = \"visual_flow\"` study is inconsistent: it has no `[visual_flow]` table (or a flight has one), names an unknown engine or tank, has a duration or period that is not positive or a tilt outside 0..90 deg, or its `run` attitude names no flight sim to replay.";
    E_FEED_GRAPH = "RW-E200", "feed-graph-invalid", Error, "A liquid engine's feed graph is inconsistent: an edge names an unknown node, a tank node names a component that is not a `tank`, the graph has no single `engine` node, or a tank has no open path to the engine.";
    E_ENGINE_INPUT = "RW-E201", "engine-input-invalid", Error, "A liquid engine input is out of range (a pressure, thrust, ratio, or volume that must be positive is not; a fraction outside 0..1; a tank fill larger than the tank; a node `volume` that disagrees with its tank geometry).";
    W_UNKNOWN_FIELD = "RW-W001", "unknown-field", Warning, "A key is not part of the schema and is ignored.";
    W_JOINT_COUNT = "RW-W002", "joint-count-missing", Warning, "A shear-pin or screw joint has no `count`.";
    W_LIB_UNRECORDED = "RW-W003", "lib-unrecorded", Warning, "A file under `lib/` has no sha256 in `rocketwright.toml [lib]`.";
    W_IMPORT_APPROX = "RW-W010", "import-approximated", Warning, "An imported file holds something RocketWright cannot represent exactly; it was approximated or skipped (the message says which).";
    W_FLUID_MODEL_MISSING = "RW-W210", "fluid-model-missing", Warning, "A liquid engine has no `fluid_model`, so its tank and feed analysis cannot run (missing input).";
    W_FEED_BC_MISSING = "RW-W211", "feed-bc-missing", Warning, "A feed-graph edge has no boundary condition `bc` (open, closed, check_valve, orifice) (missing input).";
    W_ENGINE_INPUT_MISSING = "RW-W212", "engine-input-missing", Warning, "A liquid engine lacks an input its design needs (nozzle area ratio or exit pressure, L*, contraction ratio, injector pressure drop, or a tank's fluid, pressure, pressurant, geometry, or fill) (missing input).";
}

/// Looks a code up in [`CODES`].
pub fn code_info(code: &str) -> Option<&'static CodeInfo> {
    CODES.iter().find(|c| c.code == code)
}

impl Diagnostic {
    /// A diagnostic for a code in [`CODES`] (severity from the table).
    pub fn new(code: &str, path: impl Into<Option<String>>, message: impl Into<String>) -> Self {
        let severity = code_info(code).map_or(Severity::Error, |c| c.severity);
        Diagnostic {
            code: code.to_string(),
            severity,
            path: path.into(),
            file: None,
            line: None,
            col: None,
            message: message.into(),
            hint: None,
        }
    }

    /// Adds a next-action hint.
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_table_is_sorted_unique_and_in_range() {
        let re = |c: &str| {
            c.len() == 7
                && c.starts_with("RW-")
                && matches!(&c[3..4], "E" | "W" | "I")
                && c[4..].bytes().all(|b| b.is_ascii_digit())
        };
        for w in CODES.windows(2) {
            assert!(w[0].code < w[1].code, "{} !< {}", w[0].code, w[1].code);
        }
        for c in CODES {
            assert!(re(c.code), "{}", c.code);
            let n: u32 = c.code[4..].parse().unwrap();
            // I9: rw-model owns E000-E099 (parse/units/expr, anchors/containment),
            // W000-W099, and the liquid model's E200-E219 (feed graph, input
            // ranges) and W200-W249 (missing inputs); rw-liquid owns E220-E249.
            let ok = n < 100
                || (&c.code[3..4] == "E" && (200..220).contains(&n))
                || (&c.code[3..4] == "W" && (200..250).contains(&n));
            assert!(ok, "{} outside rw-model's range", c.code);
            let sev = match &c.code[3..4] {
                "E" => Severity::Error,
                "W" => Severity::Warning,
                _ => Severity::Info,
            };
            assert_eq!(sev, c.severity, "{}", c.code);
            assert!(
                c.slug.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'),
                "{}",
                c.slug
            );
        }
    }

    #[test]
    fn unit_error_codes_are_in_the_table() {
        use rw_units::{DimKind, UnitError};
        let errs = [
            UnitError::Syntax {
                text: String::new(),
                at: 0,
            },
            UnitError::UnitMissing {
                expected: DimKind::Length,
            },
            UnitError::UnknownUnit {
                unit: String::new(),
            },
            UnitError::DimensionMismatch {
                expected: DimKind::Length.dimension(),
                found: DimKind::Mass.dimension(),
            },
        ];
        for e in errs {
            assert!(code_info(e.code()).is_some(), "{}", e.code());
        }
    }
}
