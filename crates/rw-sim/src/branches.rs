//! Multi-stage branches (R4.5, M2.3): the vehicle of each flight leg and of
//! each released stack, built from the stage-reduced model, and the
//! `branches/<stage>/` output of a released stack.
//!
//! A leg's aerodynamics, mass, motors, and recovery devices come from the
//! model reduced to the stages still attached (`stages::submodel`); the
//! released stack gets the same treatment for its own stages. The reference
//! area and length stay those of the whole vehicle, so coefficients and
//! margins stay comparable across legs.

use rw_aero::{AeroModel, AeroOptions};
use rw_mass::MassModel;
use rw_model::{EvalConfig, EvaluatedModel};
use rw_motor::MountedMotor;

use crate::flight::Flight;
use crate::models::Propulsion;
use crate::recovery::Recovery;
use crate::{Branch, FlightEvent, outputs, stages};

/// The models of one vehicle (a leg or a released stack).
pub struct StackModels {
    pub aero: AeroModel,
    pub mass: MassModel,
    pub propulsion: Propulsion,
    pub recovery: Recovery,
}

/// Builds the models of the stack made of `stages` (ids, top first): the
/// reduced model's geometry, aero, and mass, its own motors, and the
/// deployments of its own recovery devices.
///
/// cite: n/a assembly of the cited aero, mass, and recovery models
pub fn stack_models(
    model: &EvaluatedModel,
    config: &EvalConfig,
    motors: &[MountedMotor],
    stages: &[String],
    aero_opts: &AeroOptions,
) -> StackModels {
    let ids: Vec<&str> = stages.iter().map(String::as_str).collect();
    let sub = stages::submodel(model, &ids);
    let geometry = rw_geom::build(&sub);
    let own: Vec<MountedMotor> = motors
        .iter()
        .filter(|m| sub.components.iter().any(|c| c.id == m.mount))
        .cloned()
        .collect();
    StackModels {
        aero: AeroModel::new(&sub, &geometry, aero_opts),
        mass: MassModel::new(&sub, &geometry, &own),
        propulsion: Propulsion::new(&own),
        recovery: Recovery::from_model(&sub, config, &geometry),
    }
}

/// The `branches/<stage>/` record of a released stack; its events carry
/// `branch = <stage>`.
///
/// cite: n/a tabulation of the flight record, no physics
pub fn branch(stage: &str, f: &Flight, dt: f64) -> Branch {
    Branch {
        stage: stage.to_string(),
        events: f
            .events
            .iter()
            .map(|e| FlightEvent {
                branch: Some(stage.to_string()),
                ..e.clone()
            })
            .collect(),
        series: outputs::series(f, dt),
    }
}
