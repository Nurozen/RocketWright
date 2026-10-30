//! Flight simulation (IF6): rail 1DOF (`rail`), 3DOF point mass with
//! variable mass (`threedof`), 6DOF rigid body with variable mass, DP5(4)
//! with events (plus RK4 for triage), recovery, multi-stage branches (R4.5). M1.5 freezes `SimInput` / `SimResult` / `RunSummary` and `simulate`.
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Enforced by the root `clippy.toml`.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod branches;
#[cfg(any(test, feature = "doubles"))]
pub mod doubles;
pub mod env;
pub mod events;
pub mod flight;
pub mod integrator;
pub mod models;
pub mod outputs;
pub mod phase;
pub mod rail;
pub mod recovery;
pub mod sixdof;
pub mod stages;
pub mod threedof;
pub mod types;

pub use types::*;

use rw_aero::AeroModel;
use rw_mass::MassModel;

/// Runs one flight. `progress` receives the fraction done (0..1); returning
/// `false` cancels the run (`SimError::Cancelled`).
///
/// The flight runs on `input.sim` (conditions, integrator, `max_time`,
/// `series_dt`) with the resolved `input.motors`, the configuration's
/// deployments (`input.config`), and the IF5 models `aero` and `mass`
/// (rail 1DOF → 6DOF → recovery descent, `flight::simulate_flight`).
///
/// cite: n/a assembly of the flight phases and outputs
pub fn simulate(
    input: &SimInput,
    aero: &AeroModel,
    mass: &MassModel,
    progress: &mut dyn FnMut(f64) -> bool,
) -> Result<SimResult, SimError> {
    let env = env::Environment::from_conditions(&input.sim.conditions);
    simulate_in(&env, input, aero, mass, progress)
}

/// [`simulate`] in a given environment (e.g. one with a tabulated
/// atmosphere and wind, [`env::Environment::with_profile`]) instead of the
/// one `input.sim.conditions` describes.
///
/// cite: n/a assembly of the flight phases and outputs
pub fn simulate_in(
    env: &env::Environment,
    input: &SimInput,
    aero: &AeroModel,
    mass: &MassModel,
    progress: &mut dyn FnMut(f64) -> bool,
) -> Result<SimResult, SimError> {
    let opts = flight::FlightOptions::from_sim(&input.sim);
    let plan = stages::leg_plan(&input.model, &input.config, &input.motors);
    let geometry = rw_geom::build(&input.model);
    let propulsion = models::Propulsion::new(&input.motors);
    let recovery = recovery::Recovery::from_model(&input.model, &input.config, &geometry);
    // Leg and released-stack models from the stage-reduced model (M2.3); the
    // first leg flies on the given models unless a stage is inactive.
    let build = |st: &[String]| {
        branches::stack_models(
            &input.model,
            &input.config,
            &input.motors,
            st,
            aero.options(),
        )
    };
    let leg_models: Vec<Option<branches::StackModels>> = plan
        .legs
        .iter()
        .enumerate()
        .map(|(i, (_, st))| (i > 0 || plan.has_inactive).then(|| build(st)))
        .collect();
    let drop_models: Vec<branches::StackModels> =
        plan.drops.iter().map(|d| build(&d.stages)).collect();
    let base = (
        models::Vehicle {
            env,
            aero,
            mass,
            propulsion: &propulsion,
        },
        &recovery,
    );
    let legs: Vec<flight::Leg<'_>> = plan
        .legs
        .iter()
        .zip(&leg_models)
        .map(|((t, _), m)| {
            let (veh, rec) = m.as_ref().map_or(base, |m| stack_vehicle(env, m));
            flight::Leg {
                t_start: *t,
                veh,
                recovery: rec,
            }
        })
        .collect();
    let releases: Vec<flight::Release<'_>> = plan
        .drops
        .iter()
        .zip(&drop_models)
        .map(|(d, m)| {
            let (veh, rec) = stack_vehicle(env, m);
            flight::Release {
                stage: &d.stage,
                first: &d.first,
                leg: flight::Leg {
                    t_start: d.t,
                    veh,
                    recovery: rec,
                },
            }
        })
        .collect();
    let f = flight::simulate_staged(&legs, &releases, &opts, progress)?;
    Ok(SimResult {
        schema: rw_model::SchemaTag,
        summary: outputs::summary(&f.main),
        series: outputs::series(&f.main, opts.sample_dt),
        events: f.main.events,
        branches: f
            .branches
            .iter()
            .map(|(s, b)| branches::branch(s, b, opts.sample_dt))
            .collect(),
        diagnostics: Vec::new(),
    })
}

/// The vehicle and recovery setup of a leg or released stack.
fn stack_vehicle<'a>(
    env: &'a env::Environment,
    m: &'a branches::StackModels,
) -> (models::Vehicle<'a>, &'a recovery::Recovery) {
    (
        models::Vehicle {
            env,
            aero: &m.aero,
            mass: &m.mass,
            propulsion: &m.propulsion,
        },
        &m.recovery,
    )
}
