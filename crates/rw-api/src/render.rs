//! IF8 render types. `RenderRequest` goes to `rocketwright-render` on stdin
//! (3D) or to `rw-draw` (2D); `RenderResult` comes back.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use rw_check::CheckReport;
use rw_model::{AnchorKind, ComponentType, EvaluatedModel, SchemaTag};

/// 2D views (Rust SVG/PNG, deterministic) and 3D views (shared TS renderer).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum View {
    Profile,
    Fin,
    Stations,
    Anchors,
    Iso,
    Top,
    Side,
    Front,
    Rear,
    Exploded,
    Section,
}

impl View {
    /// True for the Rust 2D views.
    pub const fn is_2d(self) -> bool {
        matches!(
            self,
            View::Profile | View::Fin | View::Stations | View::Anchors
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RenderScheme {
    /// Flat check materials (default for headless and goldens).
    #[default]
    Check,
    Pbr,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RenderRequest {
    pub schema: SchemaTag,
    pub view: View,
    pub scheme: RenderScheme,
    pub width: u32,
    pub height: u32,
    /// 0..1.
    pub explode: f64,
    pub internals: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    pub evaluated: EvaluatedModel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<CheckReport>,
    /// `--compare <version>`: the other model for the red/amber/green diff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compare_evaluated: Option<EvaluatedModel>,
    /// `--compare`: the marks of `evaluated` against `compare_evaluated`.
    /// Removed components are drawn from `compare_evaluated`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub compare_marks: Vec<crate::history::ComponentMark>,
    /// Output PNG path (project-relative, under `renders/`).
    pub out_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RenderBackend {
    Resvg,
    Webgpu,
    Webgl2,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Camera {
    /// Body-frame position and target.
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub position: [f64; 3],
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub target: [f64; 3],
    pub up: [f64; 3],
    pub orthographic: bool,
    /// Vertical field of view (perspective) in degrees.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fov_deg: Option<f64>,
    /// View height (orthographic).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub ortho_height: Option<f64>,
}

/// The `render` tool output; the MCP reply also carries the PNG as image content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RenderResult {
    pub view: View,
    /// PNG path (project-relative).
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub svg_path: Option<String>,
    #[schemars(extend("pattern" = "^[0-9a-f]{64}$"))]
    pub png_sha256: String,
    pub width: u32,
    pub height: u32,
    pub camera: Camera,
    pub backend: RenderBackend,
    /// GPU adapter description (3D only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    #[schemars(extend("pattern" = rw_model::HEX64_PATTERN))]
    pub model_hash: String,
    /// What the render drew, as numbers: each drawn component's station
    /// range and radial extent, and the notable relations between parts
    /// (B3 round 12: describe a render from this, not from the picture).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legend: Option<RenderLegend>,
}

/// The text legend of a render (`rw render` prints it under the PNG path).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct RenderLegend {
    /// Drawn components in tree order.
    pub components: Vec<LegendComponent>,
    /// Relations between a part and the component it sits on or in.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relations: Vec<LegendRelation>,
}

/// One drawn component: stations from the nose tip, radii from the body axis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LegendComponent {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ComponentType,
    /// How it sits in its parent (`axial` body chain, `inner`, `surface`).
    pub placement: AnchorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Instances (fins in a set, buttons in a pattern).
    pub count: u32,
    /// Foremost station over all instances.
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub x_fore: f64,
    /// Aftmost station over all instances.
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub x_aft: f64,
    /// Innermost radius (0 for a solid on the axis; the root for fins).
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub r_inner: f64,
    /// Outermost radius (the tip for fins).
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub r_outer: f64,
}

/// How a part relates to its parent `other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LegendRelationKind {
    /// Ends `distance` aft of `other`'s aft end (fins past the tube end).
    OverhangsAft,
    /// Ends at `other`'s aft end (within 0.05 mm).
    FlushAft,
    /// Ends `distance` forward of `other`'s aft end.
    ForwardOfAft,
    /// An inner part reaching `distance` past `other`'s aft end.
    ExtendsPastAft,
    /// A surface part (rail button, lug) centred at `station`, `fraction`
    /// of `other`'s length from its fore end (one entry per instance).
    Along,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LegendRelation {
    pub component: String,
    pub kind: LegendRelationKind,
    pub other: String,
    /// Positive distance for `overhangs_aft`, `forward_of_aft`, `extends_past_aft`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub distance: Option<f64>,
    /// Centre station (`along`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub station: Option<f64>,
    /// 0 at `other`'s fore end, 1 at its aft end (`along`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f64>,
}
