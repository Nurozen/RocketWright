//! IF8 tool inputs and outputs (S:85 + D6). MCP input roots are objects, so
//! every input is a struct. Mutating tools return [`MutationOut`] (or embed
//! it), which carries the [`CheckDelta`] (I6). `dry_run` writes nothing.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use rw_check::{CheckDelta, CheckReport};
use rw_model::{Attach, Component, Diagnostic, EvaluatedModel, PatchOp};
use rw_motor::{MotorSource, ThrustCurve};
use rw_sim::RunSummary;
use rw_units::{QImpulse, QLength, QTime};

use crate::history::{ComponentMark, FileChange, HistoryStep, Revision};
use crate::render::{RenderResult, RenderScheme, View};
use crate::run::{JobInfo, Provenance, RunListEntry, RunStatus};

// ---- shared outputs --------------------------------------------------------

/// Output of every mutating tool (S:86).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MutationOut {
    /// Recorded step (`None` for dry runs and edits that change nothing, D3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    #[schemars(extend("pattern" = rw_model::HEX64_PATTERN))]
    pub model_hash: String,
    pub dry_run: bool,
    pub files: Vec<FileChange>,
    pub delta: CheckDelta,
}

/// One metric compared between two runs, versions, or a run and a golden.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MetricDiffRow {
    /// Metric path (`apogee_m`, `stability.liftoff`).
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub a: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_pct: Option<f64>,
    /// Tolerance as given (`3%`, `0.3 s`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pass: Option<bool>,
    /// Unit of `a`, `b`, and `delta` (`m`, `kg`, `cal`); absent for pure
    /// numbers and unknown keys.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

/// Semantic model diff keyed by component id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModelDiff {
    pub a: String,
    pub b: String,
    /// Added component ids.
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<FieldChange>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FieldChange {
    pub component: String,
    /// Source pointer, e.g. `/c/fins/span`.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new: Option<serde_json::Value>,
    /// SI unit of the field (`m`, `kg/m^3`) when a side is a quantity
    /// literal (`"70 mm"`); `old_si`/`new_si` are those sides in that unit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_si: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_si: Option<f64>,
}

// ---- project ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct ProjectCreateIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Template id from `templates/` (default `minimal`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct ProjectValidateIn {
    /// Files to validate; empty = all project files.
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ValidateOut {
    pub ok: bool,
    pub files: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct FmtIn {
    /// Report only; exit 1 when a file would change.
    #[serde(default)]
    pub check: bool,
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FmtOut {
    pub changed: Vec<String>,
}

/// `rw://project/files`: every source file's text (the web never reads disk).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectFiles {
    #[schemars(extend("pattern" = rw_model::HEX64_PATTERN))]
    pub model_hash: String,
    /// Project-relative path → text.
    pub files: BTreeMap<String, String>,
}

// ---- model -----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct ModelGetIn {
    /// JSON pointer into the evaluated model (`/components/3`); absent = whole model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// `live` (default), `step:<n>`, `rev:<NN>`, `commit:<sha>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModelGetOut {
    #[schemars(extend("pattern" = rw_model::HEX64_PATTERN))]
    pub model_hash: String,
    pub path: String,
    /// The whole model, when `path` is empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<EvaluatedModel>,
    /// The selected subtree, when `path` is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModelPatchIn {
    #[schemars(length(min = 1))]
    pub ops: Vec<PatchOp>,
    #[serde(default)]
    pub dry_run: bool,
    /// Step title override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ComponentAddIn {
    #[schemars(extend("pattern" = rw_model::ID_PATTERN))]
    pub id: String,
    pub component: Component,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ComponentRemoveIn {
    pub id: String,
    /// Also remove components attached to it (otherwise they error).
    #[serde(default)]
    pub recursive: bool,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ComponentMoveIn {
    pub id: String,
    pub attach: Attach,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckSimMode {
    Quick,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct DesignCheckIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    /// `--set path=value` overrides (not written).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub set: BTreeMap<String, String>,
    /// Warnings fail (D18).
    #[serde(default)]
    pub strict: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sim: Option<CheckSimMode>,
}

// ---- render ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RenderIn {
    pub view: View,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    /// 0..1 (3D views).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0.0, max = 1.0))]
    pub explode: Option<f64>,
    /// Version to diff against (red/amber/green).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compare: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheme: Option<RenderScheme>,
}

// ---- library and motors ----------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibKind {
    Component,
    Material,
    Preset,
    Motor,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct LibrarySearchIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<LibKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LibItem {
    /// Library ref, e.g. `preset:bt-55` or `lib:components/fin_can.rw.toml`.
    pub id: String,
    pub kind: LibKind,
    pub name: String,
    /// Origin and license, e.g. `openrocket-database (Apache-2.0)`.
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// Source-form fields (units as strings).
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LibrarySearchOut {
    pub items: Vec<LibItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LibraryShowIn {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct MotorSearchIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// Impulse class letter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diameter: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_impulse: Option<QImpulse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_impulse: Option<QImpulse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MotorInfo {
    /// Motor ref usable in a config, e.g. `generic:RW_C6G`.
    pub id: String,
    pub designation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    pub class: String,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub diameter: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub length: f64,
    #[schemars(extend("x-unit-dimension" = "impulse"))]
    pub total_impulse: f64,
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub burn_time: f64,
    #[schemars(extend("x-unit-dimension" = "force"))]
    pub average_thrust: f64,
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub delays: Vec<f64>,
    #[schemars(extend("x-unit-dimension" = "mass"))]
    pub total_mass: f64,
    pub source: MotorSource,
    #[schemars(extend("pattern" = "^[0-9a-f]{64}$"))]
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MotorSearchOut {
    pub motors: Vec<MotorInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MotorShowIn {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MotorShowOut {
    pub info: MotorInfo,
    pub curve: ThrustCurve,
}

// ---- runs and jobs ---------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SimulateIn {
    /// Sim id (`sims/<id>.rw.toml`).
    pub sim: String,
    /// Override the sim's config.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    /// Re-run even on a cache hit.
    #[serde(default)]
    pub force: bool,
    /// Monte Carlo sample count (large counts need approval).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mc: Option<u32>,
}

/// Returns within 100 ms: a cache hit (`Complete`, `summary` set) or a job.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SimulateOut {
    pub sim: String,
    #[schemars(extend("pattern" = "^[0-9a-f]{12}$"))]
    pub run_id: String,
    pub status: RunStatus,
    pub cached: bool,
    /// Poll `job_status` or subscribe to `rw://jobs/<id>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<RunSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct JobRef {
    pub job_id: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct RunListIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sim: Option<String>,
}

/// `run_list` and `rw://runs/index`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunListOut {
    /// Current model hash (runs with another hash are Outdated).
    #[schemars(extend("pattern" = rw_model::HEX64_PATTERN))]
    pub model_hash: String,
    pub runs: Vec<RunListEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunDiffIn {
    /// Run ref (rw:run/<id> or `<sim>/<run-id>`).
    pub a: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<String>,
    /// Oracle golden path (`tests/oracle/case1-generic.json`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub golden: Option<String>,
    /// Metric key → tolerance (`apogee_m = "3%"`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tol: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunDiffOut {
    pub a: String,
    pub b: String,
    /// Setup mismatches against a golden (geometry, conditions, config,
    /// sim, motor digest). Any mismatch means rows are not scored.
    pub mismatches: Vec<String>,
    pub rows: Vec<MetricDiffRow>,
    /// Flight phases in time order (rail exit, burnout, apogee, the last
    /// deployment, landing): the time, altitude, and speed of each event of
    /// the main flight on both sides (`burnout.velocity_ms`; no apogee speed,
    /// no landing altitude), so where the `a - b` gap opens is read from the
    /// tool. Compared, never gated.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub phases: Vec<MetricDiffRow>,
    pub pass: bool,
    /// Notes on how the rows were computed (which model the static rows of a
    /// golden diff came from, or why they are missing). Not verdicts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModelDiffIn {
    pub a: String,
    pub b: String,
}

// ---- history ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct HistoryListIn {
    /// Filter to one thread (`cli`, `ui`, a thread id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Only steps with `seq` below this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<u32>,
}

/// `history_list` and `rw://project/history`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HistoryListOut {
    pub steps: Vec<HistoryStep>,
    pub revisions: Vec<Revision>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HistoryShowIn {
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HistoryShowOut {
    pub step: HistoryStep,
    /// Diff against the previous step.
    pub diff: ModelDiff,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HistoryCompareIn {
    pub a: String,
    pub b: String,
    /// Also render a visual diff (M2).
    #[serde(default)]
    pub visual: bool,
    /// Also return the per-component mass and CG rows
    /// (`mass.components.<id>.mass|cg`) and the per-component aero terms
    /// (`aero.terms.<id>.cna|cp`) in `breakdown`.
    #[serde(default)]
    pub breakdown: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CompareOut {
    pub a: String,
    pub b: String,
    pub model: ModelDiff,
    pub metrics: Vec<MetricDiffRow>,
    /// Per-component visual-diff marks on the evaluated models (removed
    /// red, changed amber, added green; unmarked components are unchanged).
    #[serde(default)]
    pub marks: Vec<ComponentMark>,
    /// With `breakdown`: one row per component and metric
    /// (`mass.components.<id>.mass`, `mass.components.<id>.cg`,
    /// `aero.terms.<id>.cna`, `aero.terms.<id>.cp`), components in `b`'s
    /// order then those only `a` has; a side without the component has no
    /// value. Which component a change came from is read from these rows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub breakdown: Vec<MetricDiffRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual: Option<RenderResult>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HistoryTagIn {
    pub name: String,
    /// Default: the latest step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Revision number (`Rev NN`); default: one above the highest. An
    /// explicit number must exceed every existing one (e.g. continuing a
    /// numbering that started outside RocketWright).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub number: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HistoryRestoreIn {
    pub version: String,
    #[serde(default)]
    pub dry_run: bool,
}

// ---- import/export ---------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ImportKind {
    Ork,
    Motor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ImportFileIn {
    pub path: String,
    pub kind: ImportKind,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ImportOut {
    #[serde(flatten)]
    pub mutation: MutationOut,
    /// Imported component ids (`.ork`) or motor refs (motor file).
    pub imported: Vec<String>,
    /// Import findings: `RW-W010 import-approximated` (something the file
    /// holds that RocketWright approximated or skipped) and `RW-W103
    /// motor-substituted`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Ork,
    Rasp,
    Glb,
    Stl,
    Csv,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ExportFileIn {
    pub format: ExportFormat,
    /// Output path, project-relative (or absolute inside the project).
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    /// Run ref (CSV export).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    /// Allow a path outside the project (absolute or `..`); the gated
    /// approval names the path. Default: the path must stay inside.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub allow_outside: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ExportOut {
    pub path: String,
    pub bytes: u64,
    #[schemars(extend("pattern" = "^[0-9a-f]{64}$"))]
    pub sha256: String,
}

// ---- ThrustCurve (opt-in network) -------------------------------------------

/// Search thrustcurve.org's motor database. The only network access in
/// RocketWright, and only when the user asks for it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct ThrustcurveSearchIn {
    /// Designation or common name (`C6`, `H128W`); a leading word may name
    /// the manufacturer (`Estes C6`). A delay suffix (`C6-5`) is ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// Manufacturer name or abbreviation (`Estes`, `AeroTech`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    /// Motor diameter, e.g. `"18 mm"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diameter: Option<QLength>,
    /// Impulse class letter (`C`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("pattern" = "^(1/8A|1/4A|1/2A|[A-Oa-o])$"))]
    pub impulse_class: Option<String>,
    /// Most motors to return (default 20, at most 100).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 100))]
    pub limit: Option<u32>,
}

/// One ThrustCurve motor (SI units).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThrustcurveMotor {
    /// ThrustCurve motor id (24 hex digits); `thrustcurve_fetch` takes it.
    pub motor_id: String,
    /// Manufacturer abbreviation (`Estes`).
    pub manufacturer: String,
    /// Designation (`C6`).
    pub designation: String,
    /// Common name (`C6`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub common_name: Option<String>,
    /// Impulse class letter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub impulse_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub diameter: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub length: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "impulse"))]
    pub total_impulse: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "force"))]
    pub average_thrust: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub burn_time: Option<f64>,
    /// `SU`, `reload`, or `hybrid`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motor_type: Option<String>,
    /// Delays as ThrustCurve lists them (`0,3,5,7`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delays: Option<String>,
    /// `regular`, `occasional`, or `OOP` (out of production).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub availability: Option<String>,
    /// Number of data files ThrustCurve holds for the motor.
    pub data_files: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThrustcurveSearchOut {
    pub motors: Vec<ThrustcurveMotor>,
    /// Motors matching every criterion (may exceed `motors.len()`).
    pub matches: u32,
    /// The host that answered (`www.thrustcurve.org`).
    pub host: String,
}

/// Simulator file format at ThrustCurve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThrustcurveFormat {
    /// RASP `.eng`.
    #[default]
    Eng,
    /// RockSim `.rse` (carries mass and CG per sample).
    Rse,
}

/// Download one motor's data file from thrustcurve.org into `lib/motors/`
/// (as `import_file` does with a local file), recording its sha256 and its
/// source under `rocketwright.toml [lib]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThrustcurveFetchIn {
    /// A ThrustCurve motor id (from `thrustcurve_search`), or a designation
    /// (`C6`, `Estes C6-5`) that matches exactly one motor.
    #[schemars(length(min = 1))]
    pub motor: String,
    /// Manufacturer, to narrow a designation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    #[serde(default)]
    pub format: ThrustcurveFormat,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThrustcurveFetchOut {
    #[serde(flatten)]
    pub mutation: MutationOut,
    /// Motor refs of the saved file (`lib:motors/Estes_C6.eng#C6`).
    pub imported: Vec<String>,
    /// The saved file, project-relative (`lib/motors/Estes_C6.eng`).
    pub path: String,
    pub motor: ThrustcurveMotor,
    /// What `rocketwright.toml [lib.source]` records for the file.
    pub source: rw_model::LibSource,
    /// The file's thrust curves, as the library reads them.
    pub curves: Vec<ThrustCurve>,
}

// ---- schema ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct SchemaGetIn {
    /// Registry name (`check-report`); absent = list names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SchemaGetOut {
    pub names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<serde_json::Value>,
}

// ---- liquid (M4) -----------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EngineDesignIn {
    /// Engine id (`engines/<id>.rw.toml`).
    pub engine: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EnginePerformance {
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub isp_vac: f64,
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub isp_sl: f64,
    #[schemars(extend("x-unit-dimension" = "velocity"))]
    pub c_star: f64,
    #[schemars(extend("x-unit-dimension" = "force"))]
    pub thrust: f64,
    #[schemars(extend("x-unit-dimension" = "mass_flow"))]
    pub mdot: f64,
    #[schemars(extend("x-unit-dimension" = "mass_flow"))]
    pub mdot_ox: f64,
    #[schemars(extend("x-unit-dimension" = "mass_flow"))]
    pub mdot_fuel: f64,
    #[schemars(extend("x-unit-dimension" = "temperature"))]
    pub chamber_temperature: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub throat_diameter: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub exit_diameter: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub chamber_diameter: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub chamber_length: f64,
    pub expansion_ratio: f64,
}

impl From<&rw_liquid::sizing::Sizing> for EnginePerformance {
    /// The headline numbers of a sizing (`isp_*` in seconds: Isp / g0).
    fn from(s: &rw_liquid::sizing::Sizing) -> Self {
        let g0 = rw_liquid::G0;
        EnginePerformance {
            isp_vac: s.isp_vac / g0,
            isp_sl: s.isp / g0,
            c_star: s.c_star,
            thrust: s.thrust,
            mdot: s.mdot,
            mdot_ox: s.mdot_ox,
            mdot_fuel: s.mdot_fuel,
            chamber_temperature: s.chamber_temperature,
            throat_diameter: s.throat_diameter,
            exit_diameter: s.exit_diameter,
            chamber_diameter: s.chamber_diameter,
            chamber_length: s.chamber_length,
            expansion_ratio: s.expansion_ratio,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EngineDesignOut {
    pub engine: String,
    /// Absent while the chamber inputs (area ratio or exit pressure, L*,
    /// contraction ratio, injector drop) are missing or the thermochemistry
    /// is unavailable. `isp_*` in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub performance: Option<EnginePerformance>,
    /// Source pointers of unset inputs (`Missing inputs · N`).
    pub missing_inputs: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
    /// The full design (SI): sizing, injector, feed budget per propellant,
    /// tanks, blowdown totals, assumptions. The feed, tank, and blowdown
    /// parts are absent while feed inputs are missing (M4.6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design: Option<rw_liquid::Design>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EngineSimulateIn {
    pub engine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<QTime>,
}

// ---- CFD -------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CfdImportIn {
    /// A CSV file (one step) or a directory of `<prefix>_t<seconds>.csv`
    /// steps (R6.15); absolute or relative to the project.
    pub path: String,
    /// Dataset id (`[a-z0-9_-]`); default: the file prefix before `_t<s>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub study: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

/// One scalar column's range over every point of the dataset's steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ScalarRange {
    pub name: String,
    pub min: f64,
    pub max: f64,
    /// Unit from the `# rw-cfd: units=` line, as written (`Pa`, `K`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CfdDataset {
    pub id: String,
    /// Run directory under `runs/` (`cfd.<id>`).
    pub sim: String,
    /// First 12 hex of blake3 over the source files' hashes (I7); the
    /// record is `runs/<sim>/<run_id>/cfd.json`.
    #[schemars(extend("pattern" = "^[0-9a-f]{12}$"))]
    pub run_id: String,
    /// Source files, project-relative when inside the project, by time.
    pub files: Vec<String>,
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub times: Vec<f64>,
    pub scalars: Vec<ScalarRange>,
    pub has_velocity: bool,
    /// Points over all steps.
    pub point_count: u64,
    /// Always `cfd` (I13).
    pub provenance: Provenance,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CfdImportOut {
    #[serde(flatten)]
    pub mutation: MutationOut,
    pub dataset: CfdDataset,
}

/// `JobInfo` is the output of `job_status` and `job_cancel`.
pub type JobStatusOut = JobInfo;
/// `history_tag` output.
pub type HistoryTagOut = Revision;
/// `design_check` output.
pub type DesignCheckOut = CheckReport;
