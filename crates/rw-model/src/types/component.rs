//! IF1 component source types (`[c.<id>]` tables, R2.4-R2.5).
//!
//! Schema metadata: dimensional fields are [`Qty`](rw_units::Qty) and carry
//! `x-unit-dimension` and `x-expr`; each component variant carries
//! `x-anchors` (its named anchors; `fin<n>` stands for `fin0..fin{count-1}`);
//! fields carry `x-ui-group` where they belong to a group other than the
//! enclosing object's (component kinds default to `Geometry`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use rw_units::{
    QAngle, QAreaDensity, QDensity, QLength, QLineDensity, QMass, QNumber, QPressure, QVolume,
};

use super::ID_PATTERN;

/// One `[c.<id>]` table. Common fields first; the `type` key selects the kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Component {
    /// Display name; defaults to the id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "General"))]
    pub name: Option<String>,
    /// Placement relative to a parent anchor. Absent only on the first body component.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Attachment"))]
    pub attach: Option<Attach>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Attachment"))]
    pub instances: Option<Instances>,
    /// Mass, CG, and CD overrides (flagged in the check report).
    #[serde(rename = "override", default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Mass"))]
    pub overrides: Option<Overrides>,
    /// `true`: this component subtracts material from its parent (BOSL2 `diff()`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[schemars(extend("x-ui-group" = "General"))]
    pub cut: bool,
    /// Material name (project `[materials.*]` or library).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Material"))]
    pub material: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Material"))]
    pub finish: Option<Finish>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Appearance"))]
    pub appearance: Option<Appearance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Attachment"))]
    pub joint: Option<Joint>,
    /// Import provenance (`.ork` UUID), kept for event mapping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "General"))]
    pub import: Option<ImportInfo>,
    #[serde(flatten)]
    pub kind: ComponentKind,
}

/// `attach = { to = "<id>.<anchor>", at = "<anchor>", offset, spin, radial }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Attach {
    /// Parent anchor, `<id>.<anchor>`.
    #[schemars(extend("pattern" = r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$"))]
    pub to: String,
    /// Own anchor that lands on `to`; default is the mirrored anchor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// Axial offset, +aft.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<QLength>,
    /// Roll about +X.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spin: Option<QAngle>,
    /// Radial placement: `outer`, `inner`, `axis`, or a radius.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial: Option<Radial>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Radial {
    Keyword(RadialKeyword),
    Radius(QLength),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RadialKeyword {
    Outer,
    Inner,
    Axis,
}

/// `instances = { count = 4, pattern = "radial", start = "0 deg" }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Instances {
    #[schemars(range(min = 1))]
    pub count: u32,
    pub pattern: InstancePattern,
    /// First instance roll angle (radial).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<QAngle>,
    /// Spacing (linear).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spacing: Option<QLength>,
    /// Cluster preset name, e.g. `3-ring`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    /// Cluster scale (center distance).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<QLength>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InstancePattern {
    Radial,
    Cluster,
    Linear,
}

/// `override = { mass, cg, cd, subtree }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Overrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mass: Option<QMass>,
    /// CG measured from this component's fore end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cg: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cd: Option<QNumber>,
    /// `true`: the override replaces the whole subtree's values.
    #[serde(default)]
    pub subtree: bool,
}

/// Surface finish: a named preset or an explicit roughness.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Finish {
    Preset(FinishPreset),
    Custom { roughness: QLength },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FinishPreset {
    Rough,
    Unfinished,
    RegularPaint,
    SmoothPaint,
    Polished,
}

/// Renderer appearance (R2.5). Presets map to PBR materials.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Appearance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<AppearancePreset>,
    /// `#rrggbb`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("pattern" = "^#[0-9a-fA-F]{6}$"))]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0.0, max = 1.0))]
    pub roughness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0.0, max = 1.0))]
    pub metalness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0.0, max = 1.0))]
    pub transmission: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AppearancePreset {
    CompositeWhite,
    CompositeGray,
    CarbonFiber,
    AluminiumBrushed,
    SteelMachined,
    ClearPolycarbonate,
    NylonOrange,
    PcbGreen,
    BlackGloss,
    KraftPaper,
    Wood,
}

/// `joint = { type, count }` (display and check metadata).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Joint {
    #[serde(rename = "type")]
    pub kind: JointType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JointType {
    Friction,
    TwistLock,
    ShearPin,
    Screw,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ImportInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// A material in `[materials.<name>]` (bulk, surface, or line density).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Material {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub density: Option<QDensity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_density: Option<QAreaDensity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_density: Option<QLineDensity>,
    /// Yield strength (tank hoop-stress check, liquid engines).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yield_strength: Option<QPressure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
}

/// Anchor kinds drive containment (G §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AnchorKind {
    /// Body chain: `fore`, `aft`, `tip`, `base`.
    Axial,
    /// Inside a tube: rings, inner tubes, recovery, mass.
    Inner,
    /// On the outer surface: fins, lugs, buttons.
    Surface,
}

macro_rules! component_kinds {
    ($( $variant:ident($ty:ident) => $name:literal, [$($anchor:literal),* $(,)?]; )*) => {
        /// The component kind, selected by `type = "<kind>"`.
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(tag = "type", rename_all = "snake_case")]
        pub enum ComponentKind {
            $(
                #[schemars(extend("x-anchors" = [$($anchor),*]))]
                $variant($ty),
            )*
        }

        /// The component kind as a plain tag (`"nose_cone"`, ...).
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "snake_case")]
        pub enum ComponentType {
            $( $variant, )*
        }

        impl ComponentType {
            pub const ALL: &'static [ComponentType] = &[$(ComponentType::$variant,)*];
            /// The `type = "..."` spelling.
            pub const fn name(self) -> &'static str {
                match self { $(ComponentType::$variant => $name,)* }
            }
            /// Named anchors of this kind (`fin<n>` = per-fin anchors).
            pub const fn anchors(self) -> &'static [&'static str] {
                match self { $(ComponentType::$variant => &[$($anchor),*],)* }
            }
        }

        impl ComponentKind {
            pub const fn component_type(&self) -> ComponentType {
                match self { $(ComponentKind::$variant(_) => ComponentType::$variant,)* }
            }
        }
    };
}

component_kinds! {
    NoseCone(NoseCone) => "nose_cone", ["tip", "base", "shoulder_fore", "shoulder_aft", "inner"];
    BodyTube(BodyTube) => "body_tube", ["fore", "aft", "mid", "inner", "outer"];
    Transition(Transition) => "transition", ["fore", "aft", "shoulder_fore", "shoulder_aft", "inner"];
    TrapezoidalFinSet(TrapezoidalFinSet) => "trapezoidal_fin_set", ["root_le", "root_te", "tip_le", "tip_te", "tab_fore", "tab_aft", "fin<n>"];
    EllipticalFinSet(EllipticalFinSet) => "elliptical_fin_set", ["root_le", "root_te", "tip_le", "tip_te", "tab_fore", "tab_aft", "fin<n>"];
    FreeformFinSet(FreeformFinSet) => "freeform_fin_set", ["root_le", "root_te", "tab_fore", "tab_aft", "fin<n>"];
    TubeFinSet(TubeFinSet) => "tube_fin_set", ["fore", "aft", "fin<n>"];
    InnerTube(InnerTube) => "inner_tube", ["fore", "aft", "motor_retainer", "inner", "outer"];
    Coupler(Coupler) => "coupler", ["fore", "aft", "mid", "inner", "outer"];
    CenteringRing(CenteringRing) => "centering_ring", ["fore", "aft"];
    Bulkhead(Bulkhead) => "bulkhead", ["fore", "aft"];
    EngineBlock(EngineBlock) => "engine_block", ["fore", "aft"];
    LaunchLug(LaunchLug) => "launch_lug", ["fore", "aft", "mid"];
    RailButton(RailButton) => "rail_button", ["fore", "aft", "mid", "top"];
    Parachute(Parachute) => "parachute", ["attach"];
    Streamer(Streamer) => "streamer", ["attach"];
    ShockCord(ShockCord) => "shock_cord", ["attach"];
    MassComponent(MassComponent) => "mass_component", ["fore", "aft", "cg"];
    Tank(Tank) => "tank", ["fore", "aft", "inner", "outlet"];
}

/// Nose and transition profile shapes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NoseShape {
    Conical,
    Ogive,
    Ellipsoid,
    Power,
    Parabolic,
    Haack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FinCrossSection {
    Square,
    Rounded,
    Airfoil,
}

/// A shoulder on a nose cone or transition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Shoulder {
    pub length: QLength,
    pub od: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thickness: Option<QLength>,
    /// Closed end (bulkhead) at the shoulder's free end.
    #[serde(default)]
    pub capped: bool,
}

/// A fin tab through the body wall.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FinTab {
    pub height: QLength,
    pub length: QLength,
    /// Offset of the tab's fore edge from the root leading edge, +aft.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<QLength>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Geometry"))]
pub struct NoseCone {
    pub shape: NoseShape,
    /// Power exponent, Haack C, or parabolic K (shape-dependent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape_param: Option<QNumber>,
    pub length: QLength,
    /// Base outer diameter.
    pub od: QLength,
    /// Wall thickness; absent means solid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thickness: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Shoulder"))]
    pub shoulder: Option<Shoulder>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Geometry"))]
pub struct BodyTube {
    pub length: QLength,
    pub od: QLength,
    /// Inner diameter (or give `thickness`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thickness: Option<QLength>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Geometry"))]
pub struct Transition {
    pub shape: NoseShape,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape_param: Option<QNumber>,
    pub length: QLength,
    pub fore_od: QLength,
    pub aft_od: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thickness: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Shoulder"))]
    pub fore_shoulder: Option<Shoulder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Shoulder"))]
    pub aft_shoulder: Option<Shoulder>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Fins"))]
pub struct TrapezoidalFinSet {
    #[schemars(range(min = 1, max = 8))]
    pub count: u32,
    pub root_chord: QLength,
    pub tip_chord: QLength,
    /// Height from root to tip.
    pub span: QLength,
    /// Leading-edge sweep length (root LE to tip LE, axial).
    pub sweep: QLength,
    pub thickness: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cross_section: Option<FinCrossSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cant: Option<QAngle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Tab"))]
    pub tab: Option<FinTab>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fillet_radius: Option<QLength>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Fins"))]
pub struct EllipticalFinSet {
    #[schemars(range(min = 1, max = 8))]
    pub count: u32,
    pub root_chord: QLength,
    pub span: QLength,
    pub thickness: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cross_section: Option<FinCrossSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cant: Option<QAngle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Tab"))]
    pub tab: Option<FinTab>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fillet_radius: Option<QLength>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Fins"))]
pub struct FreeformFinSet {
    #[schemars(range(min = 1, max = 8))]
    pub count: u32,
    /// Planform `[x, y]` points from the root LE (x +aft, y outward), root first and last on y = 0.
    #[schemars(length(min = 3))]
    pub points: Vec<[QLength; 2]>,
    pub thickness: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cross_section: Option<FinCrossSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cant: Option<QAngle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Tab"))]
    pub tab: Option<FinTab>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fillet_radius: Option<QLength>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Fins"))]
pub struct TubeFinSet {
    #[schemars(range(min = 1, max = 12))]
    pub count: u32,
    pub length: QLength,
    pub od: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thickness: Option<QLength>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Geometry"))]
pub struct InnerTube {
    pub length: QLength,
    pub od: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thickness: Option<QLength>,
    /// Accepts a motor (configs assign one by this component's id).
    #[serde(default)]
    #[schemars(extend("x-ui-group" = "Motor"))]
    pub motor_mount: bool,
    /// Motor overhang past the aft end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Motor"))]
    pub overhang: Option<QLength>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Geometry"))]
pub struct Coupler {
    pub length: QLength,
    pub od: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thickness: Option<QLength>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Geometry"))]
pub struct CenteringRing {
    /// Axial thickness.
    pub length: QLength,
    /// Defaults to the parent's inner diameter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub od: Option<QLength>,
    pub id: QLength,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Geometry"))]
pub struct Bulkhead {
    pub length: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub od: Option<QLength>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Geometry"))]
pub struct EngineBlock {
    pub length: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub od: Option<QLength>,
    pub id: QLength,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Geometry"))]
pub struct LaunchLug {
    pub length: QLength,
    pub od: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thickness: Option<QLength>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Geometry"))]
pub struct RailButton {
    /// Outer diameter of the base and the flange.
    pub od: QLength,
    /// Neck (waist) diameter.
    pub id: QLength,
    /// Total height above the body surface.
    pub height: QLength,
    /// Height of the base at the body surface (default `height / 4`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_height: Option<QLength>,
    /// Height of the flange at the outer face (default `height / 4`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flange_height: Option<QLength>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Recovery"))]
pub struct Parachute {
    pub diameter: QLength,
    pub cd: QNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spill_hole: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_length: Option<QLength>,
    /// Shroud-line material (needs a `line_density`); the canopy uses `material`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Material"))]
    pub line_material: Option<String>,
    #[schemars(extend("x-ui-group" = "Packed"))]
    pub packed_length: QLength,
    #[schemars(extend("x-ui-group" = "Packed"))]
    pub packed_diameter: QLength,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Recovery"))]
pub struct Streamer {
    pub length: QLength,
    pub width: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cd: Option<QNumber>,
    #[schemars(extend("x-ui-group" = "Packed"))]
    pub packed_length: QLength,
    #[schemars(extend("x-ui-group" = "Packed"))]
    pub packed_diameter: QLength,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Recovery"))]
pub struct ShockCord {
    pub cord_length: QLength,
    #[schemars(extend("x-ui-group" = "Packed"))]
    pub packed_length: QLength,
    #[schemars(extend("x-ui-group" = "Packed"))]
    pub packed_diameter: QLength,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MassRole {
    FlightComputer,
    Altimeter,
    Battery,
    Tracker,
    Payload,
    Ballast,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Mass"))]
pub struct MassComponent {
    pub mass: QMass,
    #[schemars(extend("x-ui-group" = "Packed"))]
    pub length: QLength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Packed"))]
    pub od: Option<QLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<MassRole>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EndCap {
    Flat,
    Hemispherical,
    Ellipsoidal,
}

/// A propellant tank (inner component) used by liquid engines (R2.5, R2.7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(extend("x-ui-group" = "Tank"))]
pub struct Tank {
    pub length: QLength,
    pub od: QLength,
    pub wall: QLength,
    pub end_cap: EndCap,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-ui-group" = "Propellant"))]
    pub fill: Option<TankFill>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TankFill {
    /// Propellant name (e.g. `n2o`, `ethanol`).
    pub propellant: String,
    /// Fill as a fraction of internal volume, or give `volume`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fraction: Option<QNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<QVolume>,
}

/// Default anchor kind of each named anchor.
pub fn anchor_kind(name: &str) -> AnchorKind {
    match name {
        "inner" | "motor_retainer" | "attach" | "cg" | "outlet" => AnchorKind::Inner,
        "outer" | "top" | "root_le" | "root_te" | "tip_le" | "tip_te" | "tab_fore" | "tab_aft" => {
            AnchorKind::Surface
        }
        n if n.starts_with("fin") => AnchorKind::Surface,
        _ => AnchorKind::Axial,
    }
}

/// Pattern for ids, re-exported for schema consumers.
pub const COMPONENT_ID_PATTERN: &str = ID_PATTERN;
