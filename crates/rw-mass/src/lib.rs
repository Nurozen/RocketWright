//! Mass properties (IF5): shells and solids of revolution, fins, parallel-axis
//! composition, overrides, and motor mass over the burn (R4.2). M1.5 freezes
//! the `MassModel::at` signature and its types.
//!
//! - [`revolve`]: solids and thin shells of revolution integrated exactly over
//!   the rw-geom profile polylines (Pappus moments).
//! - [`fins`]: fin plates (planform + tab) by polygon area moments, root
//!   fillets, cant and roll placement.
//! - [`body`]: rigid bodies with the full 3×3 inertia tensor and parallel-axis
//!   composition; [`eigen`]: principal inertia by 3×3 Jacobi.
//! - [`overrides`]: mass/CG overrides on a component or its subtree.
//! - [`motor`]: motor mass, CG, and inertia over the burn from rw-motor.
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Enforced by the root `clippy.toml`.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod body;
pub mod component;
pub mod eigen;
pub mod fins;
pub mod motor;
pub mod overrides;
pub mod revolve;
pub mod types;

pub use body::RigidBody;
pub use eigen::Principal;
pub use types::*;

use std::collections::{BTreeMap, BTreeSet};

use rw_geom::Geometry;
use rw_model::EvaluatedModel;
use rw_motor::MountedMotor;

use crate::component::{Density, material_density};

/// One component's dry contribution (overrides applied).
#[derive(Debug, Clone, PartialEq)]
struct Part {
    id: String,
    body: RigidBody,
    overridden: bool,
}

/// A mounted motor with the body-frame offsets of its mount instances.
#[derive(Debug, Clone, PartialEq)]
struct Motor {
    mounted: MountedMotor,
    offsets: Vec<[f64; 3]>,
}

/// Mass model of one configuration. Internals are private to the mass lane;
/// `new`, `at`, and `breakdown` are frozen.
#[derive(Debug, Clone)]
pub struct MassModel {
    parts: Vec<Part>,
    dry: RigidBody,
    motors: Vec<Motor>,
}

/// Ids of the components in stages that the active configuration disables.
fn inactive_members(model: &EvaluatedModel) -> BTreeSet<&str> {
    let Some(cfg) = model.config.as_deref().and_then(|c| model.configs.get(c)) else {
        return BTreeSet::new();
    };
    cfg.stages
        .iter()
        .filter(|s| !s.active)
        .filter_map(|s| model.stages.iter().find(|st| st.id == s.stage))
        .flat_map(|st| st.members.iter().map(String::as_str))
        .collect()
}

/// Tank components an active liquid engine feeds from: the engine's thrust
/// curve carries their propellant (mass and CG over the burn), so the tank
/// contributes only its shell.
fn engine_fed_tanks<'m>(model: &'m EvaluatedModel, motors: &[MountedMotor]) -> BTreeSet<&'m str> {
    motors
        .iter()
        .filter_map(|m| match &m.curve.source {
            rw_motor::MotorSource::Liquid { engine } => model.engines.get(engine),
            _ => None,
        })
        .flat_map(|e| e.nodes.values())
        .filter(|n| n.kind == rw_model::FeedNodeKind::Tank)
        .filter_map(|n| n.component.as_deref())
        .collect()
}

impl MassModel {
    /// Builds the dry mass model from the evaluated model and its geometry,
    /// and keeps the motors for [`MassModel::at`]. Overrides apply deepest
    /// first, so a subtree override on a parent sees its children's
    /// overridden values.
    /// cite: mil-hdbk-762 eq 7-27 p 566
    pub fn new(model: &EvaluatedModel, geometry: &Geometry, motors: &[MountedMotor]) -> Self {
        let skip = inactive_members(model);
        let fed = engine_fed_tanks(model, motors);
        let geo: BTreeMap<&str, &rw_geom::ComponentGeometry> = geometry
            .components
            .iter()
            .map(|g| (g.id.as_str(), g))
            .collect();
        let index: BTreeMap<&str, usize> = model
            .components
            .iter()
            .enumerate()
            .map(|(i, c)| (c.id.as_str(), i))
            .collect();
        let parent_of = |i: usize| {
            model.components[i]
                .parent
                .as_deref()
                .and_then(|p| index.get(p).copied())
        };

        let mut parts: Vec<Part> = model
            .components
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let body = match geo.get(c.id.as_str()) {
                    Some(g) if !skip.contains(c.id.as_str()) => {
                        let pd = parent_of(i)
                            .map(|p| {
                                material_density(model, model.components[p].material.as_deref())
                            })
                            .unwrap_or(Density::default());
                        component::component_body_loaded(
                            c,
                            g,
                            model,
                            pd,
                            !fed.contains(c.id.as_str()),
                        )
                    }
                    _ => RigidBody::ZERO,
                };
                Part {
                    id: c.id.clone(),
                    body,
                    overridden: false,
                }
            })
            .collect();

        // Descendant test: walk the parent chain (guarded against cycles).
        let is_within = |j: usize, root: usize| {
            let mut k = Some(j);
            for _ in 0..=model.components.len() {
                match k {
                    Some(x) if x == root => return true,
                    Some(x) => k = parent_of(x),
                    None => return false,
                }
            }
            false
        };
        for i in (0..model.components.len()).rev() {
            let c = &model.components[i];
            let Some(o) = c.overrides.as_ref() else {
                continue;
            };
            if skip.contains(c.id.as_str()) {
                continue;
            }
            let members: Vec<usize> = if o.subtree {
                (0..parts.len())
                    .filter(|&j| is_within(j, i) && !skip.contains(parts[j].id.as_str()))
                    .collect()
            } else {
                vec![i]
            };
            let mut group: Vec<RigidBody> = members.iter().map(|&j| parts[j].body).collect();
            let x_ref = 0.5 * (c.x_fore + c.x_aft);
            if overrides::apply_override(&mut group, o.mass, o.cg, x_ref) {
                for (&j, b) in members.iter().zip(group) {
                    parts[j].body = b;
                    parts[j].overridden = true;
                }
            }
        }

        // Stage overrides last: a stage is the outermost group (MI-03, MI-04).
        for st in &model.stages {
            let Some(o) = st.overrides.as_ref() else {
                continue;
            };
            let members: Vec<usize> = st
                .members
                .iter()
                .filter(|id| !skip.contains(id.as_str()))
                .filter_map(|id| index.get(id.as_str()).copied())
                .collect();
            let mut group: Vec<RigidBody> = members.iter().map(|&j| parts[j].body).collect();
            let x_ref = 0.5 * (st.x_fore + st.x_aft);
            if overrides::apply_override(&mut group, o.mass, o.cg, x_ref) {
                for (&j, b) in members.iter().zip(group) {
                    parts[j].body = b;
                    parts[j].overridden = true;
                }
            }
        }

        let dry = RigidBody::combine(parts.iter().map(|p| &p.body));
        let motors = motors
            .iter()
            .map(|m| Motor {
                mounted: m.clone(),
                offsets: geo
                    .get(m.mount.as_str())
                    .map(|g| g.instances.iter().map(|i| i.offset).collect())
                    .unwrap_or_default(),
            })
            .collect();
        Self { parts, dry, motors }
    }

    /// Whole-vehicle properties at time `t` after launch (motors burning).
    /// cite: mil-hdbk-762 eq 7-28 p 566
    pub fn at(&self, t: f64) -> MassProps {
        self.body_at(t).props()
    }

    /// Per-component dry breakdown (overrides applied and flagged). Inertias
    /// are about each component's own CG; the entries sum (by the parallel-axis
    /// theorem) to [`MassModel::dry`].
    /// cite: n/a reporting of computed per-component values
    pub fn breakdown(&self) -> Vec<ComponentMass> {
        self.parts
            .iter()
            .map(|p| {
                let s = p.body.props();
                ComponentMass {
                    id: p.id.clone(),
                    mass: s.mass,
                    cg: s.cg,
                    ixx: s.ixx,
                    iyy: s.iyy,
                    overridden: p.overridden,
                }
            })
            .collect()
    }

    /// Dry vehicle (no motors).
    /// cite: n/a accessor
    pub fn dry(&self) -> MassProps {
        self.dry.props()
    }

    /// Dry vehicle with the full inertia tensor.
    /// cite: n/a accessor
    pub fn dry_body(&self) -> RigidBody {
        self.dry
    }

    /// All motors at `t` (MM-05..MM-09).
    /// cite: mil-hdbk-762 eq 7-27 p 566
    pub fn motors_at(&self, t: f64) -> RigidBody {
        let ms: Vec<RigidBody> = self
            .motors
            .iter()
            .map(|m| motor::mounted_motors(&m.mounted, t, &m.offsets))
            .collect();
        RigidBody::combine(&ms)
    }

    /// Whole vehicle at `t` with the full inertia tensor about its CG
    /// (MI-31/MI-32: dry plus motors by the parallel-axis theorem).
    /// cite: mil-hdbk-762 eq 7-22 p 564
    pub fn body_at(&self, t: f64) -> RigidBody {
        RigidBody::combine([&self.dry, &self.motors_at(t)])
    }

    /// Principal moments and axes of the whole vehicle at `t`.
    /// cite: n/a eigen-decomposition of body_at (see eigen::jacobi_eigen)
    pub fn principal_at(&self, t: f64) -> Principal {
        eigen::principal(&self.body_at(t))
    }
}
