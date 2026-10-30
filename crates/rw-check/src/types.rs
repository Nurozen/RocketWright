//! IF7 `CheckReport` and `CheckDelta`. Report JSON is key-sorted with fixed
//! significant figures and no timestamps (I8). Metric paths (`mass.cg`,
//! `aero.cp`, `aero.cna`, `stability.liftoff`, ...) are the dotted field paths
//! of this type; `docs/dev/metric-paths.md` lists them.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use rw_model::{Diagnostic, SchemaTag, Severity};
use rw_sim::RunSummary;
use rw_units::DimKind;

/// Overall status: `errors` if any error diagnostic or failed error-severity
/// assertion, else `warnings` if any warning, else `clean`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Errors,
    Warnings,
    Clean,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckTier {
    Static,
    QuickSim,
}

/// The `rw check --json` report (`design_check`, `rw://project/check`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CheckReport {
    pub schema: SchemaTag,
    pub status: CheckStatus,
    pub tier: CheckTier,
    #[schemars(extend("pattern" = rw_model::HEX64_PATTERN))]
    pub model_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub dims: Dims,
    pub mass: MassReport,
    pub aero: AeroReport,
    pub stability: StabilityReport,
    pub motor: Vec<MotorReport>,
    pub interference: Vec<Interference>,
    pub clearance: Vec<Clearance>,
    pub assertions: Vec<AssertionResult>,
    /// `[report]` values by expression.
    pub report: BTreeMap<String, ReportValue>,
    /// Project-relative file (and `motor:<ref>`) → content hash.
    pub inputs: BTreeMap<String, String>,
    /// Present with `--sim quick`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sim: Option<RunSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Dims {
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub length: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub max_diameter: f64,
    /// Fin span tip to tip, if any fins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub fin_span: Option<f64>,
    /// Overall length in calibers of the reference diameter
    /// (`stability.ref_diameter`); absent without a reference diameter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length_cal: Option<f64>,
    /// Fineness ratio: overall length over the maximum body diameter; absent
    /// without a diameter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fineness: Option<f64>,
    pub components: Vec<ComponentDims>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ComponentDims {
    pub component: String,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub x_fore: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub x_aft: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub length: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub od: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub id: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MassReport {
    /// Without motors.
    #[schemars(extend("x-unit-dimension" = "mass"))]
    pub dry: f64,
    /// With loaded motors (launch mass).
    #[schemars(extend("x-unit-dimension" = "mass"))]
    pub liftoff: f64,
    /// After all motors burn out.
    #[schemars(extend("x-unit-dimension" = "mass"))]
    pub burnout: f64,
    #[schemars(extend("x-unit-dimension" = "mass"))]
    pub propellant: f64,
    /// CG station at liftoff (oracle `cg_m`).
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub cg: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub cg_burnout: f64,
    #[schemars(extend("x-unit-dimension" = "inertia"))]
    pub ixx: f64,
    #[schemars(extend("x-unit-dimension" = "inertia"))]
    pub iyy: f64,
    /// The mass breakdown: each component's dry mass and CG station, in tree
    /// order (metric paths `mass.components.<id>.mass`, `.cg`).
    pub components: Vec<ComponentMassRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ComponentMassRow {
    pub component: String,
    #[schemars(extend("x-unit-dimension" = "mass"))]
    pub mass: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub cg: f64,
    #[serde(rename = "override")]
    pub overridden: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AeroReport {
    /// CP station at `mach` and AoA 0 (oracle `cp_m`).
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub cp: f64,
    /// Normal-force slope per radian (oracle `cna`).
    pub cna: f64,
    pub mach: f64,
    #[schemars(extend("x-unit-dimension" = "angle"))]
    pub alpha: f64,
    /// Zero-AoA drag coefficient at `mach`.
    pub cd: f64,
    /// Per-component aero terms: each component's normal-force slope and CP
    /// station, with its cited model (metric paths `aero.terms.<id>.cna`,
    /// `.cp`). At AoA 0, `cna` is the sum of the terms' `cna` and `cp` their
    /// CNa-weighted station.
    pub terms: Vec<AeroTerm>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AeroTerm {
    pub component: String,
    pub cna: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub cp: f64,
    /// Cited model id.
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StabilityReport {
    /// Margin at liftoff in calibers (oracle `stability_cal`).
    pub liftoff: f64,
    pub burnout: f64,
    /// Minimum over the burn.
    pub min: f64,
    /// Liftoff margin as a percent of overall length.
    pub liftoff_pct_length: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub ref_diameter: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MotorReport {
    pub mount: String,
    pub designation: String,
    #[schemars(extend("x-unit-dimension" = "impulse"))]
    pub total_impulse: f64,
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub burn_time: f64,
    pub thrust_to_weight: f64,
    pub fits_mount: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained: Option<bool>,
    /// Motor ref as configured.
    pub motor: String,
    #[schemars(extend("pattern" = "^[0-9a-f]{64}$"))]
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InterferenceKind {
    Overlap,
    Protrusion,
    FinThroughJoint,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Interference {
    pub a: String,
    pub b: String,
    pub kind: InterferenceKind,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub depth: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub station: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClearanceRule {
    CouplerFit,
    MotorFit,
    FinTabWall,
    FinAcrossJoint,
    RecoveryVolume,
    RailButtonAlignment,
    CenteringRingFit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Clearance {
    pub rule: ClearanceRule,
    pub a: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<String>,
    /// Required and actual value in SI of `dim`.
    pub required: f64,
    pub actual: f64,
    pub dim: DimKind,
    pub pass: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AssertionResult {
    pub id: String,
    pub expr: String,
    /// Evaluated left-hand value (SI); `None` when it needs `--sim` or failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    pub pass: bool,
    pub severity: Severity,
    pub needs_sim: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ReportValue {
    pub value: f64,
    pub dim: DimKind,
}

/// The post-edit check delta every mutating tool returns (S:86, I6; DA:118-123):
///
/// ```json
/// {"status":"warnings","model_hash":"…","step":"s0004",
///  "changed":{"stability.liftoff":[1.42,1.18],"mass.liftoff":[0.512,0.498]},
///  "new_diagnostics":[{"code":"RW-E101","severity":"error","path":"/c/fins/span","message":"…","hint":"…"}],
///  "resolved_diagnostics":["RW-W012@/c/body"]}
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CheckDelta {
    pub status: CheckStatus,
    #[schemars(extend("pattern" = rw_model::HEX64_PATTERN))]
    pub model_hash: String,
    /// The history step this mutation recorded; `None` for dry runs and no-op edits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    /// Metric path → `[before, after]` (SI); `null` when absent on one side.
    pub changed: BTreeMap<String, [Option<f64>; 2]>,
    pub new_diagnostics: Vec<Diagnostic>,
    /// `<code>@<path>` keys of diagnostics that went away.
    pub resolved_diagnostics: Vec<String>,
}
