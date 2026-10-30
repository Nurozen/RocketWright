//! IF5 mass types.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Mass properties about the CG. Inertia about the body axes through the CG.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MassProps {
    #[schemars(extend("x-unit-dimension" = "mass"))]
    pub mass: f64,
    /// CG station.
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub cg: f64,
    /// Roll (longitudinal) moment of inertia.
    #[schemars(extend("x-unit-dimension" = "inertia"))]
    pub ixx: f64,
    /// Pitch/yaw (transverse) moment of inertia.
    #[schemars(extend("x-unit-dimension" = "inertia"))]
    pub iyy: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ComponentMass {
    pub id: String,
    #[schemars(extend("x-unit-dimension" = "mass"))]
    pub mass: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub cg: f64,
    #[schemars(extend("x-unit-dimension" = "inertia"))]
    pub ixx: f64,
    #[schemars(extend("x-unit-dimension" = "inertia"))]
    pub iyy: f64,
    /// An override replaced the computed mass or CG.
    pub overridden: bool,
}
