//! IF1 source documents: `rocketwright.toml`, `rocket.rw.toml` (and
//! `parts/*.rw.toml`), `configs/<id>.rw.toml`, `sims/<id>.rw.toml`,
//! `engines/<id>.rw.toml` (R2.1-R2.7). TOML is canonical; a JSON twin with the
//! same schema is accepted.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use rw_units::{
    QAcceleration, QAngle, QArea, QForce, QLength, QMass, QNumber, QPressure, QTemperature, QTime,
    QVelocity, QVolume,
};

use super::component::{Component, Material, Overrides};
use super::eval::{AtmosphereModel, Geodetic, IntegratorKind};

/// Every parsed source file of one project, keyed by project-relative path.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct SourceSet {
    pub docs: BTreeMap<String, SourceDoc>,
}

/// One parsed source file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "doc", rename_all = "snake_case")]
pub enum SourceDoc {
    Project(ProjectManifest),
    Rocket(RocketDoc),
    Config(ConfigDoc),
    Sim(SimDoc),
    Engine(EngineDoc),
}

/// `rocketwright.toml`: the project manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectManifest {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema_url: Option<String>,
    /// Format version (`1`).
    pub format: u32,
    pub name: String,
    /// Model file (default `rocket.rw.toml`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_config: Option<String>,
    /// Display unit per dimension name, e.g. `length = "mm"`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub display_units: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lib: Option<LibManifest>,
}

/// `[lib]`: project library paths and the sha256 of every file under `lib/`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct LibManifest {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    /// Project-relative path → sha256 hex.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sha256: BTreeMap<String, String>,
}

/// `rocket.rw.toml` (also `parts/*.rw.toml`): params, components, materials,
/// asserts, and report values.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct RocketDoc {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Part files merged into this document (`parts/fin_can.rw.toml`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub include: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, Param>,
    /// Named param sets: variant → param → value.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub variants: BTreeMap<String, BTreeMap<String, ParamValue>>,
    /// `[stage.<id>]`: stages by their first body component.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub stage: BTreeMap<String, StageDef>,
    /// `[c.<id>]`: components keyed by stable id.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[schemars(extend("propertyNames" = { "pattern": super::ID_PATTERN }))]
    pub c: BTreeMap<String, Component>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub materials: BTreeMap<String, Material>,
    /// `[[assert]]` design rules.
    #[serde(rename = "assert", default, skip_serializing_if = "Vec::is_empty")]
    pub asserts: Vec<AssertRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<ReportSpec>,
}

/// `[params.<name>]` (the OpenSCAD Customizer analogue).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Param {
    pub value: ParamValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<ParamValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<ParamValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<ParamValue>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<ParamValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
}

/// A param value: a number, a bool, or a string (`"140 mm"`, `"= expr"`, or a choice).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ParamValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StageDef {
    /// First body component of the stage.
    pub first: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Mass and CG override of the whole stage (`subtree = true`: a stage
    /// owns no mass of its own). CG is measured from the stage's fore end.
    #[serde(rename = "override", default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<Overrides>,
}

/// `[[assert]] id, expr, severity, message`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AssertRule {
    pub id: String,
    /// Expression over metric paths, e.g. `stability.liftoff >= 1.0 cal`.
    pub expr: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<crate::diag::Severity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `[report] values = ["= c.fins.span", ...]`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct ReportSpec {
    #[serde(default)]
    pub values: Vec<String>,
}

/// `configs/<id>.rw.toml`: a flight configuration (R2.6).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct ConfigDoc {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Motor per mount (inner-tube id → assignment).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[schemars(extend("x-ui-group" = "Motors"))]
    pub motors: BTreeMap<String, MotorAssignment>,
    /// Stage id → separation settings.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[schemars(extend("x-ui-group" = "Stages"))]
    pub stages: BTreeMap<String, StageConfig>,
    /// Recovery component id → deployment.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[schemars(extend("x-ui-group" = "Recovery"))]
    pub deploy: BTreeMap<String, Deployment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MotorAssignment {
    /// Motor ref: `generic:RW_C6G`, `lib:<path>`, or a designation `rw motor search` resolves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motor: Option<String>,
    /// Liquid engine id (`engines/<id>.rw.toml`), in place of a solid motor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// Ejection delay; absent means plugged (no ejection charge).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay: Option<QTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignition: Option<IgnitionEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignition_delay: Option<QTime>,
    /// Import provenance: the motor the imported file named and how it was
    /// resolved (`substituted` is reported as `RW-W103 motor-substituted`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import: Option<MotorImport>,
    /// `true`: the generic curve standing in for a `substituted` import is
    /// accepted, so `RW-W103 motor-substituted` is no longer reported.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub accept_substitution: bool,
}

/// The motor an imported file (`.ork`) named for a mount, and how
/// `rw import` resolved it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MotorImport {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    pub designation: String,
    /// The imported file's motor digest, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    pub resolution: MotorResolution,
}

/// How an imported motor was resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MotorResolution {
    /// A curve embedded in the imported file, copied into `lib/motors/`.
    Embedded,
    /// A curve from the local ThrustCurve cache, copied into `lib/motors/`.
    Cache,
    /// No curve was available offline: the nearest built-in generic curve
    /// by impulse class and diameter stands in.
    Substituted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum IgnitionEvent {
    Launch,
    PreviousBurnout,
    StageSeparation,
    Never,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StageConfig {
    #[serde(default = "default_true")]
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub separation: Option<SeparationEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub separation_delay: Option<QTime>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SeparationEvent {
    UpperIgnition,
    Burnout,
    Ejection,
    Launch,
    Never,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Deployment {
    pub event: DeployEvent,
    /// For `altitude` (on descent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub altitude: Option<QLength>,
    /// Delay after the event (`timer`: after launch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay: Option<QTime>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeployEvent {
    Ejection,
    Apogee,
    Altitude,
    Timer,
    Never,
}

/// `sims/<id>.rw.toml`: a simulation definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SimDoc {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub kind: SimKind,
    /// Config id (`configs/<id>.rw.toml`).
    pub config: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Launch"))]
    pub launch: Option<LaunchSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Atmosphere"))]
    pub atmosphere: Option<AtmosphereSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Wind"))]
    pub wind: Option<WindSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Integrator"))]
    pub integrator: Option<IntegratorSpec>,
    /// Series grid (default 0.01 s).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Output"))]
    pub series_dt: Option<QTime>,
    /// Gravity model (absent: the engine default, `wgs84`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Launch"))]
    pub gravity: Option<GravitySpec>,
    /// Point the rod into the wind: the rod azimuth follows the wind
    /// direction (absent: `false`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Launch"))]
    pub launch_into_wind: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
    /// `kind = "visual_flow"` studies (page 06, D10c).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual_flow: Option<Box<VisualFlowSpec>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SimKind {
    #[default]
    Flight,
    VisualFlow,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LaunchSpec {
    pub rail_length: QLength,
    /// From vertical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rod_angle: Option<QAngle>,
    /// Azimuth, clockwise from north.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rod_direction: Option<QAngle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub altitude: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latitude: Option<QAngle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub longitude: Option<QAngle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geodetic: Option<Geodetic>,
}

/// `gravity = { model = "wgs84" }` or `{ model = "constant", g = "9.80665 m/s^2" }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "model", rename_all = "snake_case", deny_unknown_fields)]
pub enum GravitySpec {
    /// WGS84 normal gravity at the site latitude, falling off with altitude.
    Wgs84,
    /// Constant gravitational acceleration, positive down.
    Constant { g: QAcceleration },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AtmosphereSpec {
    pub model: AtmosphereModel,
    /// Sea-level base temperature (ISA/USSA default 288.15 K).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_temperature: Option<QTemperature>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_pressure: Option<QPressure>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WindSpec {
    pub speed: QVelocity,
    /// Direction the wind blows from, clockwise from north.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<QAngle>,
    /// Turbulence intensity (fraction).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turbulence: Option<QNumber>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct IntegratorSpec {
    pub method: IntegratorKind,
    /// Fixed step (rk4) or initial/max step (dp54).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dt: Option<QTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtol: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub atol: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_time: Option<QTime>,
}

/// A page 06 visual flow study (`kind = "visual_flow"`, D10c): the GPU
/// fluid in one tank of a liquid engine, draining with the engine's
/// engineering blowdown while the vehicle tilts. Its runs carry
/// `provenance = "visual"` and never feed engineering numbers (I13).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VisualFlowSpec {
    /// Engine id (`engines/<id>.rw.toml`) whose blowdown drains the tank.
    pub engine: String,
    pub attitude: AttitudeSource,
    /// Study length (default 10 s).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<QTime>,
    /// Feed node id of the tank shown (default: the oxidizer branch's tank).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tank: Option<String>,
    /// `scripted_tilt`: mean tilt from vertical (default 50 deg).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tilt: Option<QAngle>,
    /// `scripted_tilt`: swing amplitude about the mean (default 10 deg).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swing: Option<QAngle>,
    /// `scripted_tilt`: swing period (default 4 s).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period: Option<QTime>,
    /// `run`: the flight sim whose latest run supplies the attitude and the
    /// body-frame specific force (6DOF replay).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay: Option<String>,
}

/// Where a visual flow study's attitude comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AttitudeSource {
    /// A scripted rocking tilt (`tilt`, `swing`, `period`) on a static stand.
    ScriptedTilt,
    /// Replay of a flight run (`replay`).
    Run,
}

/// `engines/<id>.rw.toml`: a liquid engine and its feed system (R2.7; M4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EngineDoc {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[schemars(extend("x-ui-group" = "Propellants"))]
    pub propellants: Propellants,
    #[schemars(extend("x-ui-group" = "Engine"))]
    pub mixture_ratio: QNumber,
    #[schemars(extend("x-ui-group" = "Engine"))]
    pub chamber_pressure: QPressure,
    #[schemars(extend("x-ui-group" = "Engine"))]
    pub thrust: QForce,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Nozzle"))]
    pub expansion_ratio: Option<QNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Nozzle"))]
    pub exit_pressure: Option<QPressure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Chamber"))]
    pub contraction_ratio: Option<QNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Chamber"))]
    pub l_star: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Injector"))]
    pub injector: Option<Injector>,
    /// Fluid model (unset → `RW-W210 fluid-model-missing`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fluid_model: Option<FluidModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Feed"))]
    pub feed: Option<FeedGraph>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Propellants {
    pub oxidizer: String,
    pub fuel: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Injector {
    #[serde(rename = "type")]
    pub kind: InjectorType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressure_drop: Option<QPressure>,
    /// Pressure drop as a fraction of chamber pressure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressure_drop_fraction: Option<QNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cd: Option<QNumber>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InjectorType {
    Impinging,
    Showerhead,
    Pintle,
    Swirl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FluidModel {
    SinglePhaseLiquid,
    TwoPhaseEquilibrium,
}

/// `[feed.node.<id>]` + `[[feed.edge]]`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct FeedGraph {
    #[serde(default)]
    pub node: BTreeMap<String, FeedNode>,
    #[serde(default)]
    pub edge: Vec<FeedEdge>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FeedNode {
    pub kind: FeedNodeKind,
    /// The `tank` component this node stands for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fluid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<QVolume>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressure: Option<QPressure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressurant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressurant_mass: Option<QMass>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow_area: Option<QArea>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cd: Option<QNumber>,
    /// Viewport placement: station of the node's centre (from the nose
    /// tip, +aft) and signed radial offset in the layout plane (+Y).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub station: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial: Option<QLength>,
    /// Tank geometry and fill given on the node itself (a tank outside the
    /// rocket's tubes, e.g. a propulsion test module), in place of `component`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tank: Option<super::component::Tank>,
    /// Wall material of an inline `tank` (`[materials.*]`), for its mass and
    /// hoop-stress check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FeedNodeKind {
    Tank,
    Valve,
    Line,
    Engine,
    Sensor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FeedEdge {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diameter: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<QLength>,
    /// Boundary condition (unset → `RW-W211 feed-bc-missing`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bc: Option<EdgeBc>,
    /// Explicit routing between the two nodes, in order (replaces the
    /// viewport's automatic elbows).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub waypoints: Vec<FeedPoint>,
}

/// A routing point of a feed line: station from the nose tip (+aft), signed
/// radial offset in the layout plane (+Y), and an optional offset normal to
/// that plane (+Z).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FeedPoint {
    pub station: QLength,
    pub radial: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<QLength>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EdgeBc {
    Open,
    Closed,
    CheckValve,
    Orifice,
}
