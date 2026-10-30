//! IF2 `EvaluatedModel`: the fully resolved SI model (`rw eval --json`,
//! `model_get`, `rw://project/model`, WASM `eval`). Stations are metres from
//! the nose tip, +aft; the body frame is +X aft, +Z up (G §4.10). Every
//! dimensional `f64` carries `x-unit-dimension` and is in SI.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use rw_units::DimKind;

use super::SchemaTag;
use super::component::{
    AnchorKind, Appearance, EndCap, FinCrossSection, InstancePattern, Joint, MassRole, NoseShape,
};
use super::source::{AttitudeSource, DeployEvent, IgnitionEvent, SeparationEvent, SimKind};
use crate::diag::Diagnostic;

/// Options for [`crate::eval`].
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct EvalOptions {
    /// Active configuration (default: manifest `default_config`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    /// Param variant (`[variants.<name>]`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    /// `--set path=value` overrides, applied after the variant.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub set: BTreeMap<String, String>,
}

/// The evaluated model (IF2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvaluatedModel {
    pub schema: SchemaTag,
    /// blake3 hex of the canonical evaluated model (D19a): comment and
    /// formatting edits do not change it.
    #[schemars(extend("pattern" = super::HEX64_PATTERN))]
    pub model_hash: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    pub reference: Reference,
    /// Resolved params (SI value plus dimension).
    pub params: BTreeMap<String, EvalParam>,
    /// Components in tree order (depth-first from the root body component).
    pub components: Vec<EvalComponent>,
    pub stages: Vec<EvalStage>,
    pub configs: BTreeMap<String, EvalConfig>,
    pub sims: BTreeMap<String, EvalSim>,
    pub materials: BTreeMap<String, EvalMaterial>,
    pub asserts: Vec<EvalAssert>,
    /// `[report]` expressions in source order.
    pub report: Vec<String>,
    /// Liquid engines and their feed systems (`engines/<id>.rw.toml`), SI,
    /// with tank nodes resolved against their `tank` components (M4.4).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub engines: BTreeMap<String, EvalEngine>,
    /// SI unit symbol per dimension name used in this document (`length` → `m`).
    pub units: BTreeMap<String, String>,
    pub diagnostics: Vec<Diagnostic>,
}

/// Reference dimensions used by aero and stability.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Reference {
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub length: f64,
    /// Reference (maximum body) diameter; one caliber.
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub diameter: f64,
    #[schemars(extend("x-unit-dimension" = "area"))]
    pub area: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalParam {
    pub value: f64,
    pub dim: DimKind,
}

/// One placed component. Its kind (`shape.type`) and SI shape parameters
/// are in [`EvalShape`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalComponent {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub children: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    /// How this component sits in its parent.
    pub containment: AnchorKind,
    /// Participates in aerodynamics (external axial chain + surface components).
    pub aero: bool,
    pub cut: bool,
    /// Fore station (m from the nose tip).
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub x_fore: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub x_aft: f64,
    /// Radial offset of the component axis from the body axis.
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub radial: f64,
    /// Roll position about +X from +Y.
    #[schemars(extend("x-unit-dimension" = "angle"))]
    pub roll: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attach: Option<EvalAttach>,
    /// Instances (one entry when not instanced).
    pub instances: Vec<EvalInstance>,
    pub anchors: Vec<EvalAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<String>,
    /// Surface roughness from the finish.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub roughness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Appearance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub joint: Option<Joint>,
    #[serde(rename = "override", default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<EvalOverride>,
    pub shape: EvalShape,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalAttach {
    /// `<id>.<anchor>`.
    pub to: String,
    pub at: String,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub offset: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalInstance {
    pub index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<InstancePattern>,
    /// Body-frame offset `[x, y, z]` of this instance from the component placement.
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub offset: [f64; 3],
    #[schemars(extend("x-unit-dimension" = "angle"))]
    pub roll: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalAnchor {
    pub name: String,
    pub kind: AnchorKind,
    /// Station.
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub x: f64,
    /// Radius from the body axis.
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub r: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "mass"))]
    pub mass: Option<f64>,
    /// CG station.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub cg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cd: Option<f64>,
    pub subtree: bool,
}

/// Shape parameters in SI, tagged by `type` (same spelling as
/// [`super::ComponentType`]). Hollow parts carry `id`; solid parts have `id = 0`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EvalShape {
    NoseCone {
        shape: NoseShape,
        shape_param: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        od: f64,
        /// 0 = solid.
        #[schemars(extend("x-unit-dimension" = "length"))]
        thickness: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shoulder: Option<EvalShoulder>,
    },
    BodyTube {
        #[schemars(extend("x-unit-dimension" = "length"))]
        length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        od: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        id: f64,
    },
    Transition {
        shape: NoseShape,
        shape_param: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        fore_od: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        aft_od: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        thickness: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fore_shoulder: Option<EvalShoulder>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        aft_shoulder: Option<EvalShoulder>,
    },
    TrapezoidalFinSet {
        #[serde(flatten)]
        fins: EvalFinCommon,
        #[schemars(extend("x-unit-dimension" = "length"))]
        root_chord: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        tip_chord: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        span: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        sweep: f64,
    },
    EllipticalFinSet {
        #[serde(flatten)]
        fins: EvalFinCommon,
        #[schemars(extend("x-unit-dimension" = "length"))]
        root_chord: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        span: f64,
    },
    FreeformFinSet {
        #[serde(flatten)]
        fins: EvalFinCommon,
        /// Planform `[x, y]` from the root LE.
        #[schemars(extend("x-unit-dimension" = "length"))]
        points: Vec<[f64; 2]>,
    },
    TubeFinSet {
        count: u32,
        #[schemars(extend("x-unit-dimension" = "length"))]
        length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        od: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        id: f64,
    },
    InnerTube {
        #[schemars(extend("x-unit-dimension" = "length"))]
        length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        od: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        id: f64,
        motor_mount: bool,
        #[schemars(extend("x-unit-dimension" = "length"))]
        overhang: f64,
    },
    Coupler {
        #[schemars(extend("x-unit-dimension" = "length"))]
        length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        od: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        id: f64,
    },
    CenteringRing {
        #[schemars(extend("x-unit-dimension" = "length"))]
        length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        od: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        id: f64,
    },
    Bulkhead {
        #[schemars(extend("x-unit-dimension" = "length"))]
        length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        od: f64,
    },
    EngineBlock {
        #[schemars(extend("x-unit-dimension" = "length"))]
        length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        od: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        id: f64,
    },
    LaunchLug {
        #[schemars(extend("x-unit-dimension" = "length"))]
        length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        od: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        id: f64,
    },
    /// A spool: base (od, at the body), neck (id), flange (od, outermost).
    RailButton {
        /// Outer (base and flange) diameter.
        #[schemars(extend("x-unit-dimension" = "length"))]
        od: f64,
        /// Neck (waist) diameter.
        #[schemars(extend("x-unit-dimension" = "length"))]
        id: f64,
        /// Total height above the body surface.
        #[schemars(extend("x-unit-dimension" = "length"))]
        height: f64,
        /// Base height at the body surface (source default `height / 4`;
        /// 0 when absent from older evaluated JSON).
        #[serde(default)]
        #[schemars(extend("x-unit-dimension" = "length"))]
        base_height: f64,
        /// Flange height at the outer face (source default `height / 4`;
        /// 0 when absent from older evaluated JSON).
        #[serde(default)]
        #[schemars(extend("x-unit-dimension" = "length"))]
        flange_height: f64,
    },
    Parachute {
        #[schemars(extend("x-unit-dimension" = "length"))]
        diameter: f64,
        cd: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        spill_hole: f64,
        /// Shroud lines (0 = none given).
        #[serde(default)]
        line_count: u32,
        #[serde(default)]
        #[schemars(extend("x-unit-dimension" = "length"))]
        line_length: f64,
        /// Shroud-line material name (resolved in `materials`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line_material: Option<String>,
        #[schemars(extend("x-unit-dimension" = "length"))]
        packed_length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        packed_diameter: f64,
    },
    Streamer {
        #[schemars(extend("x-unit-dimension" = "length"))]
        length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        width: f64,
        cd: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        packed_length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        packed_diameter: f64,
    },
    ShockCord {
        #[schemars(extend("x-unit-dimension" = "length"))]
        cord_length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        packed_length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        packed_diameter: f64,
    },
    MassComponent {
        #[schemars(extend("x-unit-dimension" = "mass"))]
        mass: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        od: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<MassRole>,
    },
    Tank {
        #[schemars(extend("x-unit-dimension" = "length"))]
        length: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        od: f64,
        #[schemars(extend("x-unit-dimension" = "length"))]
        wall: f64,
        end_cap: EndCap,
        #[schemars(extend("x-unit-dimension" = "volume"))]
        volume: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        propellant: Option<String>,
        #[schemars(extend("x-unit-dimension" = "mass"))]
        propellant_mass: f64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalShoulder {
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub length: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub od: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub thickness: f64,
    pub capped: bool,
}

/// Fields shared by the planar fin sets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalFinCommon {
    pub count: u32,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub thickness: f64,
    pub cross_section: FinCrossSection,
    #[schemars(extend("x-unit-dimension" = "angle"))]
    pub cant: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub fillet_radius: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<EvalFinTab>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalFinTab {
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub height: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub length: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub offset: f64,
}

impl EvalShape {
    /// The kind tag.
    pub fn component_type(&self) -> super::ComponentType {
        use super::ComponentType as T;
        match self {
            EvalShape::NoseCone { .. } => T::NoseCone,
            EvalShape::BodyTube { .. } => T::BodyTube,
            EvalShape::Transition { .. } => T::Transition,
            EvalShape::TrapezoidalFinSet { .. } => T::TrapezoidalFinSet,
            EvalShape::EllipticalFinSet { .. } => T::EllipticalFinSet,
            EvalShape::FreeformFinSet { .. } => T::FreeformFinSet,
            EvalShape::TubeFinSet { .. } => T::TubeFinSet,
            EvalShape::InnerTube { .. } => T::InnerTube,
            EvalShape::Coupler { .. } => T::Coupler,
            EvalShape::CenteringRing { .. } => T::CenteringRing,
            EvalShape::Bulkhead { .. } => T::Bulkhead,
            EvalShape::EngineBlock { .. } => T::EngineBlock,
            EvalShape::LaunchLug { .. } => T::LaunchLug,
            EvalShape::RailButton { .. } => T::RailButton,
            EvalShape::Parachute { .. } => T::Parachute,
            EvalShape::Streamer { .. } => T::Streamer,
            EvalShape::ShockCord { .. } => T::ShockCord,
            EvalShape::MassComponent { .. } => T::MassComponent,
            EvalShape::Tank { .. } => T::Tank,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalStage {
    pub id: String,
    pub name: String,
    /// First body component.
    pub first: String,
    /// Member component ids (axial chain plus contents).
    pub members: Vec<String>,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub x_fore: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub x_aft: f64,
    /// Whole-stage mass/CG override (members' dry parts, motors excluded).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<EvalOverride>,
}

/// An evaluated flight configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalConfig {
    pub id: String,
    pub name: String,
    pub motors: Vec<EvalMotorMount>,
    pub stages: Vec<EvalStageConfig>,
    pub deployments: Vec<EvalDeployment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalMotorMount {
    /// Inner-tube id.
    pub mount: String,
    /// Motor ref as written (`generic:RW_C6G`); resolved by the Session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// Ejection delay; `None` = plugged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub delay: Option<f64>,
    pub ignition: IgnitionEvent,
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub ignition_delay: f64,
    /// Import provenance of the motor (absent for authored configurations).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import: Option<super::source::MotorImport>,
    /// The substituted generic curve is accepted (no `RW-W103`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub accept_substitution: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalStageConfig {
    pub stage: String,
    pub active: bool,
    pub separation: SeparationEvent,
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub separation_delay: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalDeployment {
    /// Recovery component id.
    pub component: String,
    pub event: DeployEvent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub altitude: Option<f64>,
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub delay: f64,
}

/// An evaluated simulation definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalSim {
    pub id: String,
    pub name: String,
    pub kind: SimKind,
    pub config: String,
    pub conditions: Conditions,
    /// Series output grid.
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub series_dt: f64,
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub max_time: f64,
    pub rtol: f64,
    pub atol: f64,
    pub seed: u64,
    /// `kind = "visual_flow"`: the evaluated study (absent for flights, so
    /// flight sims hash as before).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual_flow: Option<EvalVisualFlow>,
}

/// An evaluated visual flow study (`[visual_flow]` in SI, defaults applied).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalVisualFlow {
    pub engine: String,
    /// Feed node id of the tank shown (`None`: the oxidizer branch's tank).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tank: Option<String>,
    pub attitude: AttitudeSource,
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub duration: f64,
    /// Mean tilt from vertical, degrees.
    pub tilt_deg: f64,
    /// Swing amplitude, degrees.
    pub swing_deg: f64,
    #[schemars(extend("x-unit-dimension" = "time"))]
    pub period: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay: Option<String>,
}

/// Launch and environment conditions. Shared verbatim by `EvalSim`,
/// `SimInput`, `RunManifest`, and the oracle golden, so its hash
/// (`rw_api::oracle::conditions_hash`) identifies a setup across all of them.
/// Units are in the key names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Conditions {
    pub rail_length_m: f64,
    /// From vertical.
    pub rod_angle_deg: f64,
    /// Azimuth, clockwise from north.
    pub rod_direction_deg: f64,
    pub site_altitude_m: f64,
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    pub base_temperature_k: f64,
    pub base_pressure_pa: f64,
    pub atmosphere: AtmosphereModel,
    pub geodetic: Geodetic,
    pub wind_speed_ms: f64,
    /// Direction the wind blows from, clockwise from north.
    pub wind_direction_deg: f64,
    /// Turbulence intensity (fraction; 0 = steady).
    pub wind_turbulence: f64,
    /// Fixed step (rk4) or maximum step (dp54).
    pub time_step_s: f64,
    pub integrator: IntegratorKind,
    /// Gravity model. Absent: the engine default (`wgs84`). Added after the
    /// M1.5 freeze as optional, so older files and their hashes are unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gravity: Option<GravityModel>,
    /// Point the rod into the wind (the rod azimuth follows the wind
    /// direction). Absent: `false`. Optional for the same reason as `gravity`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_into_wind: Option<bool>,
}

/// Gravity model (tag `model`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "model", rename_all = "snake_case", deny_unknown_fields)]
pub enum GravityModel {
    /// WGS84 normal gravity at the site latitude, falling off with altitude.
    Wgs84,
    /// Constant gravitational acceleration.
    Constant {
        /// m/s², positive down.
        g_ms2: f64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AtmosphereModel {
    /// U.S. Standard Atmosphere 1976 (R4.4).
    Ussa1976,
    /// ISA with custom base temperature and pressure.
    IsaCustom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Geodetic {
    Flat,
    Spherical,
    Wgs84,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum IntegratorKind {
    /// Dormand-Prince 5(4), adaptive, with event root-finding (default).
    Dp54,
    /// Classic RK4, fixed step (parity triage, D13).
    Rk4,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalMaterial {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "density"))]
    pub density: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "area_density"))]
    pub surface_density: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "line_density"))]
    pub line_density: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "pressure"))]
    pub yield_strength: Option<f64>,
}

/// One liquid engine in SI (`engines/<id>.rw.toml`, M4.4). Unset inputs stay
/// `None` and are reported as `RW-W21x` missing inputs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalEngine {
    pub id: String,
    pub name: String,
    /// Oxidizer and fuel ids (`n2o`, `ethanol`, or a CEA species name).
    pub oxidizer: String,
    pub fuel: String,
    pub mixture_ratio: f64,
    #[schemars(extend("x-unit-dimension" = "pressure"))]
    pub chamber_pressure: f64,
    #[schemars(extend("x-unit-dimension" = "force"))]
    pub thrust: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expansion_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "pressure"))]
    pub exit_pressure: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contraction_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub l_star: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injector: Option<EvalInjector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fluid_model: Option<super::source::FluidModel>,
    /// Feed nodes by id.
    pub nodes: BTreeMap<String, EvalFeedNode>,
    pub edges: Vec<EvalFeedEdge>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalInjector {
    pub kind: super::source::InjectorType,
    /// Injector pressure drop (given, or the fraction times chamber pressure).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "pressure"))]
    pub pressure_drop: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalFeedNode {
    pub kind: super::source::FeedNodeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fluid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "volume"))]
    pub volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "pressure"))]
    pub pressure: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressurant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "mass"))]
    pub pressurant_mass: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "area"))]
    pub flow_area: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cd: Option<f64>,
    /// Centre station (the tank component's mid-length when unset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub station: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub radial: Option<f64>,
    /// Resolved tank geometry (from `component` or the inline `tank`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tank: Option<EvalTankSpec>,
}

/// A tank's geometry, fill, and wall material in SI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalTankSpec {
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub length: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub od: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub wall: f64,
    pub end_cap: EndCap,
    /// Internal volume.
    #[schemars(extend("x-unit-dimension" = "volume"))]
    pub volume: f64,
    /// Loaded liquid volume (from `fill.volume` or `fill.fraction`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "volume"))]
    pub fill_volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "density"))]
    pub density: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "pressure"))]
    pub yield_strength: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalFeedEdge {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub diameter: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub length: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bc: Option<super::source::EdgeBc>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub waypoints: Vec<EvalFeedPoint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalFeedPoint {
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub station: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub radial: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub depth: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvalAssert {
    pub id: String,
    pub expr: String,
    pub severity: crate::diag::Severity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The rule references simulation metrics; it runs only with `--sim`.
    pub needs_sim: bool,
}

/// Per-component `type` plus shape access used by consumers.
impl EvalComponent {
    pub fn component_type(&self) -> super::ComponentType {
        self.shape.component_type()
    }
}
