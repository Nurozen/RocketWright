//! IF3 `Geometry`. Stations in metres from the nose tip (+aft); body frame
//! +X aft, +Z up, roll about +X from +Y (G §4.10).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use rw_model::{ComponentType, FinCrossSection, SchemaTag};

/// The whole vehicle's geometry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Geometry {
    pub schema: SchemaTag,
    #[schemars(extend("pattern" = rw_model::HEX64_PATTERN))]
    pub model_hash: String,
    /// Overall length (nose tip to the aftmost point).
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub length: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub max_diameter: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub ref_diameter: f64,
    #[schemars(extend("x-unit-dimension" = "area"))]
    pub ref_area: f64,
    pub components: Vec<ComponentGeometry>,
}

/// One component's geometry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ComponentGeometry {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ComponentType,
    /// Participates in aerodynamics.
    pub aero: bool,
    pub cut: bool,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub x_fore: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub x_aft: f64,
    /// Outer profile of a solid of revolution, fore to aft (empty for plates).
    pub outer: Vec<ProfilePoint>,
    /// Inner profile (bore), fore to aft; empty when solid.
    pub inner: Vec<ProfilePoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fins: Option<FinGeometry>,
    /// Instance placements (one identity entry when not instanced).
    pub instances: Vec<InstanceGeometry>,
    #[schemars(extend("x-unit-dimension" = "volume"))]
    pub volume: f64,
    #[schemars(extend("x-unit-dimension" = "area"))]
    pub wetted_area: f64,
    /// Planform area (fins) or side projected area (bodies).
    #[schemars(extend("x-unit-dimension" = "area"))]
    pub planform_area: f64,
    pub bbox: Aabb,
}

/// A profile vertex: station `x`, radius `r`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProfilePoint {
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub x: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub r: f64,
}

/// A fin set's plates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FinGeometry {
    pub count: u32,
    /// Planform polygon `[x, y]`: x station, y height above the root (closed, CCW).
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub planform: Vec<[f64; 2]>,
    /// Tab polygon in the same frame (y ≤ 0), if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub tab: Option<Vec<[f64; 2]>>,
    /// Body radius at the root.
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub root_radius: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub thickness: f64,
    pub cross_section: FinCrossSection,
    #[schemars(extend("x-unit-dimension" = "angle"))]
    pub cant: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub fillet_radius: f64,
    /// Roll angle of each fin about +X from +Y.
    #[schemars(extend("x-unit-dimension" = "angle"))]
    pub roll: Vec<f64>,
    /// Derived planform values used by aero.
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub span: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub root_chord: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub tip_chord: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub mid_chord_sweep_length: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub mean_aero_chord: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct InstanceGeometry {
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub offset: [f64; 3],
    #[schemars(extend("x-unit-dimension" = "angle"))]
    pub roll: f64,
}

/// Axis-aligned bounding box in the body frame.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Aabb {
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub min: [f64; 3],
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub max: [f64; 3],
}

/// Options for [`crate::mesh_glb`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MeshOptions {
    /// Segments around a solid of revolution.
    pub radial_segments: u32,
    /// Explode factor 0..1 along the assembly axis.
    pub explode: f64,
    /// Include inner components.
    pub internals: bool,
    /// Also write cut components (`cut = true`) as cutter nodes tagged
    /// `extras.rw_cut` (with `rw_cut_parent`), for a renderer that subtracts
    /// them from their parent. Off: cutters are left out.
    #[serde(default)]
    pub cutters: bool,
}

impl Default for MeshOptions {
    fn default() -> Self {
        Self {
            radial_segments: 64,
            explode: 0.0,
            internals: true,
            cutters: false,
        }
    }
}
