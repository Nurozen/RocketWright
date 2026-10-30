//! IF5 aero I/O types.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Model options.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AeroOptions {
    /// Mach at which static CP/CNα are reported by `check` (default 0.3).
    pub static_mach: f64,
    /// Apply base drag only while the motor is not burning. When false (the
    /// default, niskanen-2009 sec 3.4.5), the thrusting motors' exhaust area
    /// is removed from the base area instead.
    pub base_drag_power_off_only: bool,
}

impl Default for AeroOptions {
    fn default() -> Self {
        Self {
            static_mach: 0.3,
            base_drag_power_off_only: false,
        }
    }
}

/// The flight state for one evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AeroState {
    pub mach: f64,
    /// Airspeed.
    #[schemars(extend("x-unit-dimension" = "velocity"))]
    pub speed: f64,
    /// Total angle of attack.
    #[schemars(extend("x-unit-dimension" = "angle"))]
    pub alpha: f64,
    #[schemars(extend("x-unit-dimension" = "angular_velocity"))]
    pub roll_rate: f64,
    /// Pitch/yaw rate magnitude.
    #[schemars(extend("x-unit-dimension" = "angular_velocity"))]
    pub pitch_rate: f64,
    #[schemars(extend("x-unit-dimension" = "kinematic_viscosity"))]
    pub kinematic_viscosity: f64,
    /// Motor burning (base drag switch).
    pub thrusting: bool,
}

/// Coefficients referenced to [`AeroCoeffs::ref_area`] and `ref_length`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AeroCoeffs {
    /// Normal-force slope, per radian.
    pub cn_alpha: f64,
    pub cn: f64,
    /// Center of pressure station.
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub cp: f64,
    /// Axial drag coefficient (total).
    pub cd: f64,
    pub drag: DragBreakdown,
    /// Pitch damping moment coefficient.
    pub cm_damping: f64,
    /// Roll forcing (fin cant) and damping.
    pub cl_forcing: f64,
    pub cl_damping: f64,
    #[schemars(extend("x-unit-dimension" = "area"))]
    pub ref_area: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub ref_length: f64,
    /// Per-component normal-force terms (for check `aero.terms`).
    pub components: Vec<ComponentAero>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DragBreakdown {
    pub friction: f64,
    pub pressure: f64,
    pub base: f64,
    pub parasitic: f64,
    pub total: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ComponentAero {
    pub id: String,
    pub cn_alpha: f64,
    #[schemars(extend("x-unit-dimension" = "length"))]
    pub cp: f64,
    /// Cited model id (`docs/dev/citations.toml`), e.g. `barrowman1967:nose`.
    pub model: String,
}
