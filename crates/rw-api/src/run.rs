//! IF8 run types: `RunManifest` (`runs/<sim>/<run-id>/manifest.json`), run
//! status (computed, never stored, I7), and jobs.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use rw_model::{AttitudeSource, Conditions, SchemaTag, SimKind};
use rw_motor::MotorSource;
use rw_sim::RunSummary;

/// Result provenance (I13). Visual results never feed engineering numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    Engineering,
    Visual,
    Cfd,
}

/// `manifest.json`: inputs and their hashes. The only run file with
/// timestamps (`started`, `wall_time_s`), which are excluded from `run_id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunManifest {
    pub schema: SchemaTag,
    /// First 12 hex of blake3 over the canonical inputs (I7).
    #[schemars(extend("pattern" = "^[0-9a-f]{12}$"))]
    pub run_id: String,
    pub sim: String,
    pub sim_name: String,
    pub kind: SimKind,
    pub config: String,
    #[schemars(extend("pattern" = rw_model::HEX64_PATTERN))]
    pub model_hash: String,
    /// Required (I7).
    pub provenance: Provenance,
    pub conditions: Conditions,
    /// `sha256:<hex>` of the JCS-canonical `conditions` ([`crate::conditions_hash`]).
    #[schemars(extend("pattern" = crate::oracle::CONDITIONS_HASH_PATTERN))]
    pub conditions_hash: String,
    pub motors: Vec<ManifestMotor>,
    /// Project-relative input file → blake3 hex.
    pub inputs: BTreeMap<String, String>,
    pub core_version: String,
    pub seed: u64,
    pub rtol: f64,
    pub atol: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wall_time_s: Option<f64>,
}

/// `runs/<study>/<run-id>/visual.json`: a visual flow study's timeline
/// (M5.1, D10c). The tank drains with the engine's engineering blowdown
/// while the attitude source tilts the vehicle; the page 06 GPU fluid reads
/// the body-frame specific force and the fill fraction at each time.
/// `provenance` is always `visual` (I13): nothing here feeds an
/// engineering number.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VisualRun {
    pub schema: SchemaTag,
    pub sim: String,
    pub sim_name: String,
    #[schemars(extend("pattern" = "^[0-9a-f]{12}$"))]
    pub run_id: String,
    pub provenance: Provenance,
    pub engine: String,
    pub engine_name: String,
    pub attitude: AttitudeSource,
    /// `run` attitude: the replayed flight run (`<sim>/<run-id>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay_run: Option<String>,
    /// Study length, s.
    pub duration: f64,
    /// The engine's blowdown burn time, s (the tank is empty or the burn
    /// ended after it).
    pub burn_time: f64,
    pub tank: VisualTank,
    pub geometry: VisualEngineGeometry,
    /// On a fixed grid from 0 to `duration`.
    pub samples: Vec<VisualSample>,
    pub assumptions: Vec<String>,
}

/// The tank the study shows (SI).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VisualTank {
    /// Feed node id.
    pub node: String,
    pub fluid: String,
    pub length: f64,
    pub od: f64,
    pub wall: f64,
    pub end_cap: rw_model::EndCap,
    /// Internal volume, m³.
    pub volume: f64,
    /// Liquid volume over the internal volume at t = 0.
    pub fill0: f64,
}

/// Engine and feed proportions for the cutaway (SI, from the design).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VisualEngineGeometry {
    pub throat_diameter: f64,
    pub exit_diameter: f64,
    pub chamber_diameter: f64,
    pub chamber_length: f64,
    pub convergent_length: f64,
    pub nozzle_length: f64,
    /// The tank's feed line inner diameter.
    pub feed_diameter: f64,
}

/// One study sample.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VisualSample {
    pub t: f64,
    /// Vehicle axis from vertical, degrees.
    pub tilt_deg: f64,
    /// Body-frame specific force (what an accelerometer reads), m/s²: +X
    /// aft, +Y starboard, +Z up. The liquid settles along its opposite.
    pub specific_force: [f64; 3],
    /// Total propellant mass flow over its peak (0..1).
    pub relative_flow: f64,
    /// Tank liquid over its initial liquid (0..1).
    pub relative_fill: f64,
    /// Tank liquid volume over the tank volume (0..1).
    pub fill_fraction: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ManifestMotor {
    pub mount: String,
    pub designation: String,
    /// The motor digest: sha256 hex of the curve file.
    #[schemars(extend("pattern" = "^[0-9a-f]{64}$"))]
    pub sha256: String,
    pub source: MotorSource,
}

/// Run status per sim, computed from `model_hash` (I7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Complete,
    Outdated,
    Running,
    Failed,
    NotRun,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunListEntry {
    pub sim: String,
    pub sim_name: String,
    pub config: String,
    pub kind: SimKind,
    pub status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Provenance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<RunSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    /// Set on a sim's earlier run that `run_list` keeps beside its latest one
    /// for before/after comparison (the newest earlier run on another model):
    /// the id of the run that replaced it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    /// The listed run's `conditions_hash` (from its manifest): two runs with
    /// equal hashes flew in the same environment (site, atmosphere, wind,
    /// rail, integrator).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conditions_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Simulate,
    EngineSimulate,
    Render,
    Import,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Complete,
    Failed,
    Cancelled,
}

/// `job_status` output and the `rw://jobs/<id>` resource.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct JobInfo {
    pub job_id: String,
    pub kind: JobKind,
    pub state: JobState,
    /// 0..1.
    pub progress: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sim: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<RunSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
