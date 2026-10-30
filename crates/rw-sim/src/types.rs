//! IF6 `SimInput`, `SimResult`, `RunSummary`, events, and series.
//! `RunSummary` keys follow S:177 (the oracle key map's RocketWright side).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use rw_model::{Diagnostic, EvalConfig, EvalSim, EvaluatedModel, SchemaTag};
use rw_motor::MountedMotor;
use rw_units::DimKind;

/// Everything one flight needs (also the canonical input of `run_id`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SimInput {
    pub schema: SchemaTag,
    pub sim: EvalSim,
    pub config: EvalConfig,
    pub model: EvaluatedModel,
    /// Resolved motors (sha256 recorded in each curve).
    pub motors: Vec<MountedMotor>,
}

/// The result of one flight (`runs/<sim>/<run-id>/`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SimResult {
    pub schema: SchemaTag,
    pub summary: RunSummary,
    pub events: Vec<FlightEvent>,
    pub series: Series,
    /// Per-stage branches after separation (`branches/<stage>/`).
    pub branches: Vec<Branch>,
    pub diagnostics: Vec<Diagnostic>,
}

/// `summary.json`. Key-sorted, fixed significant figures (I8). Absent values
/// (no deployment, no delay) are omitted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunSummary {
    pub schema: SchemaTag,
    pub apogee_m: f64,
    pub max_velocity_ms: f64,
    pub max_accel_ms2: f64,
    pub max_mach: f64,
    pub time_to_apogee_s: f64,
    pub flight_time_s: f64,
    pub landing_velocity_ms: f64,
    pub rail_exit_velocity_ms: f64,
    /// Speed at the last recovery deployment (the main of a dual deploy).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment_velocity_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optimum_delay_s: Option<f64>,
    /// Minimum stability margin in flight (calibers), rail exit to apogee.
    pub min_stability_cal: f64,
    pub burnout_time_s: f64,
    pub burnout_altitude_m: f64,
    pub landing_x_m: f64,
    pub landing_y_m: f64,
    pub drift_m: f64,
    /// Coast from the last burnout to apogee (apogee time minus last burnout
    /// time; the same number as `optimum_delay_s`). Absent with no burnout
    /// before apogee.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coast_time_s: Option<f64>,
    /// Derived timing of each recovery deployment of the main flight, in time
    /// order (so agents never subtract event times by hand).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deployments: Vec<DeploymentTiming>,
    /// Derived timing of each motor's ejection charge (motors with a
    /// configured delay), by mount id.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ejections: Vec<EjectionTiming>,
}

/// One recovery deployment, relative to apogee.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DeploymentTiming {
    /// The deployed device (rw:c/<id>).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<rw_model::RwRef>,
    /// Deployment time after ignition.
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub t_s: f64,
    /// Deployment time minus apogee time: negative = before apogee.
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub deploy_minus_apogee_s: f64,
    /// Altitude above the launch site at deployment.
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub deploy_altitude_m: f64,
    /// Speed at deployment.
    #[schemars(extend("x-unit-dimension" = "velocity"))]
    pub deploy_velocity_ms: f64,
}

/// One motor's ejection charge against its optimum delay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EjectionTiming {
    /// The motor mount (rw:c/<mount>).
    pub source: rw_model::RwRef,
    /// Ejection time after ignition (the motor's burnout plus its delay).
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub t_s: f64,
    /// The configured ejection delay.
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub delay_s: f64,
    /// Apogee time minus this motor's burnout time.
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub optimum_delay_s: f64,
    /// Configured delay minus optimum delay (= ejection time minus apogee
    /// time): negative = the charge fires before apogee.
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub delay_minus_optimum_s: f64,
}

/// `events.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunEvents {
    pub schema: SchemaTag,
    pub events: Vec<FlightEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FlightEvent {
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub t: f64,
    pub kind: EventKind,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub altitude: f64,
    #[schemars(extend("x-unit-dimension" = "velocity"))]
    pub velocity: f64,
    /// Component that caused the event (rw:c/<id>), when one did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<rw_model::RwRef>,
    /// The released stage whose branch flew the event (`branches/<stage>/`,
    /// M2.3); absent on the main (top-stage) flight.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Ignition,
    Liftoff,
    RailExit,
    Burnout,
    Ejection,
    Apogee,
    StageSeparation,
    Deployment,
    Tumble,
    Landing,
}

/// Fixed-grid series (`series.csv`): one row per `dt` plus exact event rows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Series {
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub dt: f64,
    pub columns: Vec<SeriesColumn>,
    /// Row-major values, one per column.
    pub rows: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SeriesColumn {
    pub name: String,
    pub dim: DimKind,
}

/// The standard series columns, in order.
pub const SERIES_COLUMNS: &[(&str, DimKind)] = &[
    ("t", DimKind::Time),
    ("altitude", DimKind::Length),
    ("x", DimKind::Length),
    ("y", DimKind::Length),
    ("vz", DimKind::Velocity),
    ("speed", DimKind::Velocity),
    ("accel", DimKind::Acceleration),
    ("mach", DimKind::Dimensionless),
    ("aoa", DimKind::Angle),
    ("stability", DimKind::Dimensionless),
    ("thrust", DimKind::Force),
    ("mass", DimKind::Mass),
    ("cg", DimKind::Length),
    ("cp", DimKind::Length),
    ("cd", DimKind::Dimensionless),
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Branch {
    pub stage: String,
    pub events: Vec<FlightEvent>,
    pub series: Series,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SimError {
    Cancelled,
    /// No thrust: no motor in any mount, or ignition never happens.
    NoMotor,
    /// Integration failed (step size underflow, NaN state).
    Integration {
        t: f64,
        message: String,
    },
    /// Input rejected (missing config, bad conditions).
    Input {
        message: String,
    },
}
