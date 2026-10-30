//! Aerodynamics (IF5): Barrowman normal force and CP extended over Mach
//! (Niskanen 2009), drag buildup, damping (R4.3). M1.5 freezes the
//! `AeroModel::eval` signature and its I/O types.
//!
//! Modules: [`barrowman`] (bodies, combination), [`fins`] (fin sets,
//! interference), [`body_load`] (CP of the fin lift carried onto the body,
//! NACA TR 1307 chart 16), [`mach`] (compressibility, transonic blends), [`drag`]
//! (friction, pressure, base, parasitic, axial), [`damping`] (pitch, roll),
//! [`tube_fins`] (tube fins as annular wings, NACA TN 4117; drag by flow path).
//! Every equation cites its row in `docs/dev/literature-map.md`; model
//! choices and deltas against the oracle are in `docs/dev/parity-log.md`.
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Enforced by the root `clippy.toml`.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod barrowman;
pub mod body_load;
pub mod damping;
pub mod drag;
pub mod fins;
pub mod mach;
pub mod tube_fins;
pub mod types;

#[cfg(test)]
mod testutil;

pub use types::*;

use std::f64::consts::PI;

use rw_geom::Geometry;
use rw_model::{AnchorKind, ComponentType, EvalShape, EvaluatedModel, NoseShape};

use barrowman::{BodyKind, BodySegment, combine, profile_integrals};
use drag::axial::axial_factor;
use drag::base::{base_cd, effective_base_area};
use drag::friction::{
    BoundaryLayer, DEFAULT_ROUGHNESS, body_wetted_factor, compressible_cf, fin_wetted_factor,
    reynolds, skin_friction,
};
use drag::parasitic::{
    LayerProfile, lug_area, lug_cd, profile_bl_factor, rail_button, rail_button_sections,
};
use drag::pressure::{NoseDragModel, boattail_cd, fin_pressure_cd, nose_pressure_cd};
use fins::{FinPlanform, cp_fraction, fin_count_factor, kb_t, kt_b, single_fin_cna};
use mach::{SUBSONIC_LIMIT, beta, stagnation_cd};

/// Sea-level speed of sound and kinematic viscosity (USSA 1976, AT-28), used
/// for the static report at `AeroOptions::static_mach`.
const A0: f64 = 340.294;
const NU0: f64 = 1.4607e-5;
/// α below which the slope and CP use the α → 0 limits.
const ALPHA_EPS: f64 = 1e-9;

const MODEL_NOSE: &str = "niskanen-2009:nose eq 3.19 3.26 3.28";
const MODEL_TUBE: &str = "niskanen-2009:body-tube eq 3.19 3.26 3.28";
const MODEL_TRANSITION: &str = "niskanen-2009:transition eq 3.19 3.26 3.28";
const MODEL_FINS: &str = "niskanen-2009:fins eq 3.40 3.49 3.56 3.36; niskanen-2013 eq 3.54; \
     barrowman-1967 eq 3-7 (K_3) 3-98 (K_B(T))";
const MODEL_FINS_BODY_LOAD: &str = "niskanen-2009:fins eq 3.40 3.49 3.56 3.36; niskanen-2013 eq 3.54; \
     barrowman-1967 eq 3-7 (K_3) 3-98 (K_B(T)); naca-tr-1307 eq 14 D5 chart 16 (body-load CP)";
const MODEL_TUBE_FINS: &str = "naca-tn-4117:tube-fins annular wing 2x rectangular wing of A = d/L; \
     niskanen-2009 eq 3.40 3.49 3.36; niskanen-2013 eq 3.54; barrowman-1967 eq 3-98 (K_B(T))";

/// Pressure-drag model of a body component.
#[derive(Debug, Clone, PartialEq)]
enum BodyDrag {
    /// Nose or shoulder (growing transition): eq 3.86/3.87 and Appendix B on
    /// the frontal area A_1 − A_0.
    Forebody {
        shape: NoseShape,
        param: f64,
        fineness: f64,
        joint: f64,
        area: f64,
    },
    /// Shrinking transition: eq 3.88 on A_0 − A_1.
    Boattail {
        area: f64,
    },
    None,
}

#[derive(Debug, Clone, PartialEq)]
struct BodyTerm {
    body: BodySegment,
    roughness: f64,
    wetted: f64,
    drag: BodyDrag,
}

#[derive(Debug, Clone, PartialEq)]
struct FinTerm {
    id: String,
    fins: FinPlanform,
    roughness: f64,
    wetted: f64,
    drag: FinDrag,
    /// Trapezoidal planform on a constant-radius tube that NACA TR 1307
    /// chart 16 covers: the body-carried load gets its own CP
    /// ([`body_load`]). `None` keeps it at the fin CP.
    body_load: Option<body_load::TrapezoidFin>,
}

/// Pressure-drag model of a fin set.
#[derive(Debug, Clone, Copy, PartialEq)]
enum FinDrag {
    /// Planar fins: leading edge and trailing edge, eq 3.89-3.93.
    Planar,
    /// Tube fins: stagnation drag (B.2) and base drag (3.94) on each tube's
    /// annulus (`tube_fins`).
    Tube { od: f64, id: f64 },
}

#[derive(Debug, Clone, PartialEq)]
enum Parasite {
    Lug {
        length: f64,
        diameter: f64,
        area: f64,
    },
    Button {
        area: f64,
        cd_length: f64,
    },
}

#[derive(Debug, Clone, PartialEq)]
struct ParasiteTerm {
    id: String,
    /// Per-instance reference area and drag model.
    kind: Parasite,
    /// Frontal sections (y₀, y₁, width) above the body surface, for the
    /// boundary-layer immersion.
    profile: Vec<(f64, f64, f64)>,
    /// Velocity profile of the body boundary layer over the guide.
    layer: LayerProfile,
    /// Fore-edge station of each instance from the nose tip (running length
    /// of the body boundary layer).
    stations: Vec<f64>,
}

/// Abrupt change of body radius between two axial components.
#[derive(Debug, Clone, PartialEq)]
enum Step {
    /// Forward-facing face (blunt-cylinder drag, eq B.2) of the given area.
    Up { id: String, area: f64 },
    /// Aft-facing face (base drag, eq 3.94) of the given area.
    Down { id: String, area: f64 },
}

/// One drag contribution on the reference area, with its cited model.
#[derive(Debug, Clone, PartialEq)]
pub struct DragTerm {
    pub id: String,
    pub kind: DragKind,
    pub cd: f64,
    pub model: &'static str,
}

/// Drag breakdown bucket of a [`DragTerm`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DragKind {
    Friction,
    Pressure,
    Base,
    Parasitic,
}

/// Precomputed aerodynamic model of one configuration. Internals are private
/// to the aero lane; only `new` and `eval` are frozen.
#[derive(Debug, Clone)]
pub struct AeroModel {
    ref_area: f64,
    ref_length: f64,
    opts: AeroOptions,
    boundary_layer: BoundaryLayer,
    /// Rocket length L (Reynolds length and fineness).
    length: f64,
    fineness: f64,
    bodies: Vec<BodyTerm>,
    fins: Vec<FinTerm>,
    parasites: Vec<ParasiteTerm>,
    steps: Vec<Step>,
    base_area: f64,
    motor_area: f64,
    /// Reference CG for `eval`: volume centroid of the outer body.
    x_cg_ref: f64,
    /// Component CD overrides in effect (outermost subtree wins).
    cd_overrides: Vec<CdOverride>,
}

/// A user CD override (`override = { cd, subtree }`): a constant zero-α drag
/// coefficient on the rocket reference area that replaces every computed term
/// of `members` (the component, plus its descendants when `subtree = true`).
#[derive(Debug, Clone, PartialEq)]
struct CdOverride {
    id: String,
    cd: f64,
    members: Vec<String>,
}

const MODEL_CD_OVERRIDE: &str = "rw:cd-override (user CD on the reference area, replaces the \
     component's computed terms; subtree = true also its children's)";

/// The CD overrides of the components present in `geometry`. A subtree
/// override absorbs any override inside its subtree, so the outermost one
/// applies (the same nesting rule as the mass overrides).
fn cd_overrides(model: &EvaluatedModel, geometry: &Geometry) -> Vec<CdOverride> {
    let comp = |id: &str| model.components.iter().find(|c| c.id == id);
    // Is `id` `root` or one of its descendants (cycle-guarded walk)?
    let within = |id: &str, root: &str| {
        let mut k = Some(id);
        for _ in 0..=model.components.len() {
            match k {
                Some(x) if x == root => return true,
                Some(x) => k = comp(x).and_then(|c| c.parent.as_deref()),
                None => return false,
            }
        }
        false
    };
    let mut all = Vec::new();
    for g in &geometry.components {
        let Some(c) = comp(&g.id) else { continue };
        let Some((cd, subtree)) = c.overrides.as_ref().and_then(|o| Some((o.cd?, o.subtree)))
        else {
            continue;
        };
        let members = geometry
            .components
            .iter()
            .filter(|m| {
                if subtree {
                    within(&m.id, &c.id)
                } else {
                    m.id == c.id
                }
            })
            .map(|m| m.id.clone())
            .collect();
        all.push(CdOverride {
            id: c.id.clone(),
            cd,
            members,
        });
    }
    let absorbed: Vec<bool> = all
        .iter()
        .map(|o| {
            all.iter()
                .any(|p| p.id != o.id && p.members.contains(&o.id))
        })
        .collect();
    all.into_iter()
        .zip(absorbed)
        .filter_map(|(o, gone)| (!gone).then_some(o))
        .collect()
}

impl AeroModel {
    /// Prepares per-component terms from the model and its geometry.
    /// cite: n/a assembly of the cited per-component terms
    pub fn new(model: &EvaluatedModel, geometry: &Geometry, opts: &AeroOptions) -> Self {
        let ref_area = if model.reference.area > 0.0 {
            model.reference.area
        } else {
            geometry.ref_area
        };
        let ref_length = if model.reference.diameter > 0.0 {
            model.reference.diameter
        } else {
            geometry.ref_diameter
        };
        let by_id = |id: &str| model.components.iter().find(|c| c.id == id);
        let mut bodies = Vec::new();
        let mut fins = Vec::new();
        let mut parasites = Vec::new();
        let mut motor_area = 0.0;
        for g in &geometry.components {
            let Some(c) = by_id(&g.id) else { continue };
            let roughness = c.roughness.unwrap_or(DEFAULT_ROUGHNESS);
            if let EvalShape::InnerTube {
                id,
                motor_mount: true,
                ..
            } = c.shape
            {
                // Every instance of a clustered mount exhausts through the base.
                motor_area += PI * 0.25 * id * id * g.instances.len().max(1) as f64;
            }
            if !c.aero {
                continue;
            }
            match g.kind {
                ComponentType::NoseCone | ComponentType::BodyTube | ComponentType::Transition
                    if c.containment == AnchorKind::Axial =>
                {
                    if let Some(body) = BodySegment::from_shape(&c.id, c.x_fore, &c.shape) {
                        let drag = body_drag(&body);
                        bodies.push(BodyTerm {
                            body,
                            roughness,
                            wetted: g.wetted_area,
                            drag,
                        });
                    }
                }
                ComponentType::TrapezoidalFinSet
                | ComponentType::EllipticalFinSet
                | ComponentType::FreeformFinSet => {
                    if let Some(fg) = &g.fins {
                        let planform = FinPlanform::from_geometry(fg);
                        let body_load = match c.shape {
                            EvalShape::TrapezoidalFinSet {
                                root_chord,
                                tip_chord,
                                span,
                                sweep,
                                ..
                            } => Some(body_load::TrapezoidFin {
                                root_chord,
                                tip_chord,
                                sweep,
                                span,
                                r_t: planform.r_t,
                            })
                            .filter(body_load::chart16_applies),
                            _ => None,
                        };
                        fins.push(FinTerm {
                            id: c.id.clone(),
                            fins: planform,
                            roughness,
                            wetted: g.wetted_area,
                            drag: FinDrag::Planar,
                            body_load,
                        });
                    }
                }
                ComponentType::TubeFinSet => {
                    if let EvalShape::TubeFinSet {
                        count,
                        length,
                        od,
                        id,
                    } = c.shape
                    {
                        let n = if g.instances.is_empty() {
                            count
                        } else {
                            g.instances.len() as u32
                        };
                        let r_t = tube_fins::root_radius(c, g, od);
                        fins.push(FinTerm {
                            id: c.id.clone(),
                            fins: tube_fins::equivalent_planform(n, length, od, id, c.x_fore, r_t),
                            roughness,
                            wetted: g.wetted_area,
                            drag: FinDrag::Tube { od, id },
                            body_load: None,
                        });
                    }
                }
                _ => {}
            }
            let stations: Vec<f64> = if g.instances.is_empty() {
                vec![g.x_fore]
            } else {
                g.instances.iter().map(|i| g.x_fore + i.offset[0]).collect()
            };
            match c.shape {
                EvalShape::LaunchLug { length, od, id } => parasites.push(ParasiteTerm {
                    id: c.id.clone(),
                    kind: Parasite::Lug {
                        length,
                        diameter: od,
                        area: lug_area(0.5 * od, 0.5 * id, length, od),
                    },
                    profile: vec![(0.0, od, od)],
                    layer: LayerProfile::SeventhPower,
                    stations,
                }),
                EvalShape::RailButton {
                    od,
                    id,
                    height,
                    base_height,
                    flange_height,
                } => {
                    let profile = rail_button_sections(od, id, height, base_height, flange_height);
                    parasites.push(ParasiteTerm {
                        id: c.id.clone(),
                        kind: Parasite::Button {
                            area: rail_button(&profile, od, 0.0).0,
                            cd_length: od,
                        },
                        profile: profile.to_vec(),
                        layer: LayerProfile::Linear,
                        stations,
                    });
                }
                _ => {}
            }
        }
        bodies.sort_by(|a, b| a.body.x_fore.total_cmp(&b.body.x_fore));
        // Chart 16 is for fins on a constant-radius body: the root chord must
        // lie on tubes (flush tubes in a row count) of the root radius.
        for f in &mut fins {
            let p = &f.fins;
            if f.body_load.is_some()
                && !on_constant_tube(&bodies, p.x_root_le, p.x_root_le + p.root_chord, p.r_t)
            {
                f.body_load = None;
            }
        }
        let steps = steps(&bodies);
        let base_area = bodies.last().map_or(0.0, |b| b.body.areas().1);
        let body_end = bodies.last().map_or(0.0, |b| b.body.x_fore + b.body.length);
        let length = if geometry.length > 0.0 {
            geometry.length
        } else {
            body_end
        };
        let max_d = bodies
            .iter()
            .map(|b| 2.0 * b.body.r0.max(b.body.r1))
            .fold(0.0, f64::max)
            .max(geometry.max_diameter);
        let fineness = if max_d > 0.0 { length / max_d } else { 0.0 };
        let x_cg_ref = volume_centroid(&bodies).unwrap_or(0.5 * length);
        let cd_overrides = cd_overrides(model, geometry);
        Self {
            ref_area,
            ref_length,
            opts: opts.clone(),
            boundary_layer: BoundaryLayer::default(),
            length,
            fineness,
            bodies,
            fins,
            parasites,
            steps,
            base_area,
            motor_area: motor_area.min(base_area),
            x_cg_ref,
            cd_overrides,
        }
    }

    /// Selects the boundary-layer model (default: fully turbulent).
    /// cite: n/a option setter
    pub fn with_boundary_layer(mut self, bl: BoundaryLayer) -> Self {
        self.boundary_layer = bl;
        self
    }

    /// The options this model was built with (`check` reports `static_mach`).
    /// cite: n/a accessor
    pub fn options(&self) -> &AeroOptions {
        &self.opts
    }

    /// Station used as the CG by [`AeroModel::eval`] for the damping terms
    /// (the outer body's volume centroid). [`AeroModel::eval_with_cg`] takes
    /// the actual CG.
    /// cite: n/a accessor
    pub fn reference_cg(&self) -> f64 {
        self.x_cg_ref
    }

    /// Coefficients at one flight state.
    /// cite: n/a assembly of the cited per-component terms
    pub fn eval(&self, state: &AeroState) -> AeroCoeffs {
        self.eval_with_cg(state, self.x_cg_ref)
    }

    /// Static coefficients at `AeroOptions::static_mach`, α = 0, sea level
    /// (USSA 1976 a_0 and ν_0).
    /// cite: ussa-1976 tab 10 p 36
    pub fn static_coeffs(&self) -> AeroCoeffs {
        let m = self.opts.static_mach;
        self.eval(&AeroState {
            mach: m,
            speed: m * A0,
            alpha: 0.0,
            roll_rate: 0.0,
            pitch_rate: 0.0,
            kinematic_viscosity: NU0,
            thrusting: false,
        })
    }

    /// Coefficients at one flight state with the pitch-damping arms taken
    /// about `x_cg` (station from the nose tip). Total C_Nα and CP combine the
    /// component terms by eq 3.29; drag sums eq 3.97 and scales by f_A(α).
    /// cite: niskanen-2009 eq 3.97 p 62
    pub fn eval_with_cg(&self, state: &AeroState, x_cg: f64) -> AeroCoeffs {
        let mach = state.mach.max(0.0);
        let alpha = state.alpha.abs();
        let a_ref = self.ref_area;
        let mut components = Vec::with_capacity(self.bodies.len() + self.fins.len());
        let (mut slope0, mut force) = (Vec::new(), Vec::new());
        for b in &self.bodies {
            let cna0 = b.body.cna0(a_ref);
            let (cn, x) = b.body.cn_at(a_ref, alpha);
            let x0 = b.body.cp();
            slope0.push((cna0, x0));
            force.push((cn, x));
            let lifting = alpha > ALPHA_EPS;
            components.push(ComponentAero {
                id: b.body.id.clone(),
                cn_alpha: if lifting { cn / alpha } else { cna0 },
                cp: if lifting && cn.abs() > 1e-15 { x } else { x0 },
                model: match b.body.kind {
                    BodyKind::Nose => MODEL_NOSE,
                    BodyKind::Tube => MODEL_TUBE,
                    BodyKind::Transition => MODEL_TRANSITION,
                }
                .to_string(),
            });
        }
        for f in &self.fins {
            let p = &f.fins;
            // Fin lift with fin–body interference K_T(B) plus the lift carried
            // over onto the body, K_B(T), both reported on the fin-set row
            // (barrowman-1967 3-93, 3-94, 3-106). The body-carried load acts
            // at its NACA TR 1307 chart 16 CP where the chart covers the
            // planform (`fin_body_cp`), else at the fin CP.
            // Tube fins: annular wings, each tube 2x the rectangular wing of
            // A = d/L, summed over N tubes (`tube_fins`).
            let interference = kt_b(p.r_t, p.span) + kb_t(mach, p.r_t, p.span);
            let set = |a: f64| match f.drag {
                FinDrag::Planar => {
                    single_fin_cna(mach, a, p.span, p.area, a_ref, p.gamma_c)
                        * fin_count_factor(p.count)
                        * interference
                }
                FinDrag::Tube { od, id } => {
                    tube_fins::tube_set_cna(mach, a, p.count, od, id, p.root_chord, p.r_t, a_ref)
                }
            };
            let x = fin_cp(f, mach);
            let x = match &f.body_load {
                Some(t) => fin_body_cp(t, x, p.x_root_le, mach, alpha),
                None => x,
            };
            let cna0 = set(0.0);
            let cna = set(alpha);
            slope0.push((cna0, x));
            force.push((cna * alpha, x));
            components.push(ComponentAero {
                id: f.id.clone(),
                cn_alpha: cna,
                cp: x,
                model: match f.drag {
                    FinDrag::Planar if f.body_load.is_some() => MODEL_FINS_BODY_LOAD,
                    FinDrag::Planar => MODEL_FINS,
                    FinDrag::Tube { .. } => MODEL_TUBE_FINS,
                }
                .to_string(),
            });
        }
        let cna0: f64 = slope0.iter().map(|t| t.0).sum();
        let cn: f64 = force.iter().map(|t| t.0).sum();
        let (cn_alpha, cp) = if alpha > ALPHA_EPS && cn.abs() > 1e-15 {
            (cn / alpha, combine(&force).unwrap_or(0.0))
        } else {
            (cna0, combine(&slope0).unwrap_or(0.0))
        };

        let terms = self.drag_terms(state);
        let fa = axial_factor(alpha);
        let sum = |k: DragKind| {
            fa * terms
                .iter()
                .filter(|t| t.kind == k)
                .map(|t| t.cd)
                .sum::<f64>()
        };
        let mut drag = DragBreakdown {
            friction: sum(DragKind::Friction),
            pressure: sum(DragKind::Pressure),
            base: sum(DragKind::Base),
            parasitic: sum(DragKind::Parasitic),
            total: 0.0,
        };
        drag.total = drag.friction + drag.pressure + drag.base + drag.parasitic;

        let (cm_damping, cl_forcing, cl_damping) = self.damping(state, x_cg, mach);
        AeroCoeffs {
            cn_alpha,
            cn,
            cp,
            cd: drag.total,
            drag,
            cm_damping,
            cl_forcing,
            cl_damping,
            ref_area: self.ref_area,
            ref_length: self.ref_length,
            components,
        }
    }

    /// Zero-α drag contributions on the reference area, one per component and
    /// mechanism, each with its cited model (`eval` scales them by f_A(α)).
    /// A component CD override replaces its members' terms with one term.
    /// cite: niskanen-2009 eq 3.97 p 62
    pub fn drag_terms(&self, state: &AeroState) -> Vec<DragTerm> {
        let mach = state.mach.max(0.0);
        let a_ref = self.ref_area;
        if a_ref <= 0.0 {
            return Vec::new();
        }
        let re = reynolds(state.speed, self.length, state.kinematic_viscosity);
        let cfc = |eps: f64| {
            let (cf, regime) = skin_friction(re, eps, self.length, self.boundary_layer);
            compressible_cf(cf, regime, re, mach)
        };
        let mut out = Vec::new();
        let mut push = |id: &str, kind, cd: f64, model| {
            if cd != 0.0 {
                out.push(DragTerm {
                    id: id.to_string(),
                    kind,
                    cd,
                    model,
                });
            }
        };
        let body_factor = body_wetted_factor(self.fineness);
        for b in &self.bodies {
            let id = b.body.id.as_str();
            push(
                id,
                DragKind::Friction,
                cfc(b.roughness) * body_factor * b.wetted / a_ref,
                "niskanen-2009:friction eq 3.81 3.82 3.85",
            );
            match b.drag {
                BodyDrag::Forebody {
                    shape,
                    param,
                    fineness,
                    joint,
                    area,
                } => push(
                    id,
                    DragKind::Pressure,
                    area / a_ref * nose_pressure_cd(shape, param, fineness, joint, mach),
                    match NoseDragModel::for_shape(shape) {
                        NoseDragModel::Cone => {
                            "niskanen-2009:nose-pressure eq 3.86 3.87 B.4 B.5 B.6"
                        }
                        NoseDragModel::Ogive => "niskanen-2009:nose-pressure eq 3.86 3.87 B.8",
                        NoseDragModel::ConeFallback => {
                            "niskanen-2009:nose-pressure eq 3.86 3.87 B.4 (cone fallback, gap PD-19)"
                        }
                    },
                ),
                BodyDrag::Boattail { area } => push(
                    id,
                    DragKind::Pressure,
                    area / a_ref
                        * boattail_cd(b.body.length, 2.0 * b.body.r0, 2.0 * b.body.r1, mach),
                    "niskanen-2009:boattail eq 3.88",
                ),
                BodyDrag::None => {}
            }
        }
        for s in &self.steps {
            match s {
                Step::Up { id, area } => push(
                    id,
                    DragKind::Pressure,
                    area / a_ref * stagnation_cd(mach),
                    "niskanen-2009:blunt-step eq B.2",
                ),
                Step::Down { id, area } => push(
                    id,
                    DragKind::Base,
                    area / a_ref * base_cd(mach),
                    "niskanen-2009:step-base eq 3.94",
                ),
            }
        }
        for f in &self.fins {
            let p = &f.fins;
            match f.drag {
                FinDrag::Planar => {
                    push(
                        &f.id,
                        DragKind::Friction,
                        cfc(f.roughness) * fin_wetted_factor(p.thickness, p.mac) * f.wetted / a_ref,
                        "niskanen-2009:friction eq 3.81 3.82 3.85",
                    );
                    push(
                        &f.id,
                        DragKind::Pressure,
                        fin_pressure_cd(
                            p.cross_section,
                            p.gamma_le,
                            p.count,
                            p.thickness,
                            p.span,
                            a_ref,
                            mach,
                        ),
                        "niskanen-2009:fin-pressure eq 3.89 3.90 3.91 3.92 3.93",
                    );
                }
                // Tube fins: outside friction off the corner channels, pipe
                // flow in the bores, blunt wall edges and corner channels
                // (`tube_fins`, PARITY-tubes).
                FinDrag::Tube { od, id } => {
                    let (n, l) = (p.count, p.root_chord);
                    push(
                        &f.id,
                        DragKind::Friction,
                        tube_fins::outside_friction_cd(cfc(f.roughness), n, l, p.r_t, od, a_ref),
                        "niskanen-2009:friction eq 3.81 3.82; mil-hdbk-762 eq 5-40 (tube outsides)",
                    );
                    push(
                        &f.id,
                        DragKind::Friction,
                        tube_fins::bore_cd(
                            n,
                            id,
                            l,
                            f.roughness,
                            state.speed.abs(),
                            state.kinematic_viscosity,
                            a_ref,
                        ),
                        "sp-125:tube-fin bores eq 7-7 7-8 fig 7-20 (Darcy-Weisbach, Moody)",
                    );
                    push(
                        &f.id,
                        DragKind::Pressure,
                        tube_fins::pressure_cd(n, od, id, p.r_t, a_ref, mach),
                        "rw:tube-fins wall edges and corner channels, niskanen-2009 eq B.2",
                    );
                    push(
                        &f.id,
                        DragKind::Base,
                        tube_fins::base_drag_cd(n, od, id, p.r_t, a_ref, mach),
                        "rw:tube-fins wall edges and corner channels, niskanen-2009 eq 3.94",
                    );
                }
            }
        }
        for p in &self.parasites {
            let (area, cd, model) = match p.kind {
                Parasite::Lug {
                    length,
                    diameter,
                    area,
                } => (
                    area,
                    lug_cd(length, diameter, mach),
                    "niskanen-2009:lug eq 3.95 3.96; naca-tm-1299 boundary-layer q",
                ),
                Parasite::Button { area, cd_length } => (
                    area,
                    lug_cd(cd_length, cd_length, mach),
                    "niskanen-2009:rail-button eq 3.95 sec 3.4.6; naca-tm-1299 q (linear layer profile)",
                ),
            };
            // Each instance sees the mean dynamic pressure of the body
            // boundary layer over its frontal profile at its own station.
            let bl: f64 = p
                .stations
                .iter()
                .map(|&x| {
                    let re_x = reynolds(state.speed, x, state.kinematic_viscosity);
                    profile_bl_factor(&p.profile, x, re_x, p.layer)
                })
                .sum();
            push(&p.id, DragKind::Parasitic, area / a_ref * cd * bl, model);
        }
        let base = if state.thrusting && self.opts.base_drag_power_off_only {
            0.0
        } else {
            effective_base_area(self.base_area, self.motor_area, state.thrusting)
        };
        let base_id = self.bodies.last().map_or("", |b| b.body.id.as_str());
        push(
            base_id,
            DragKind::Base,
            base / a_ref * base_cd(mach),
            "niskanen-2009:base eq 3.94",
        );
        // CD overrides replace the computed terms of their members with one
        // constant term (booked as pressure drag in the breakdown).
        if !self.cd_overrides.is_empty() {
            out.retain(|t| !self.cd_overrides.iter().any(|o| o.members.contains(&t.id)));
            out.extend(self.cd_overrides.iter().map(|o| DragTerm {
                id: o.id.clone(),
                kind: DragKind::Pressure,
                cd: o.cd,
                model: MODEL_CD_OVERRIDE,
            }));
        }
        out
    }

    /// (C_m,damp, C_l,forcing, C_l,damping) at the state's rates.
    fn damping(&self, state: &AeroState, x_cg: f64, mach: f64) -> (f64, f64, f64) {
        let (a, d, v) = (self.ref_area, self.ref_length, state.speed.abs());
        let w = state.pitch_rate;
        let mut cm = 0.0;
        // Body fore and aft of the CG, each with its mean radius (eq 3.59).
        let fore = x_cg.clamp(0.0, self.length);
        let aft = (self.length - fore).max(0.0);
        if w != 0.0 && v > 0.0 {
            cm += damping::pitch_damping_body(fore, self.mean_radius(0.0, fore), a, d, w, v);
            cm += damping::pitch_damping_body(aft, self.mean_radius(fore, self.length), a, d, w, v);
        }
        let (mut forcing, mut roll) = (0.0, 0.0);
        for f in &self.fins {
            let p = &f.fins;
            let x_f = fin_cp(f, mach);
            cm += damping::pitch_damping_fins(p.count, p.area, x_f - x_cg, a, d, w, v);
            let cna1 = single_fin_cna(mach, 0.0, p.span, p.area, a, p.gamma_c);
            forcing += damping::roll_forcing(p.count, p.y_mac, p.r_t, cna1, p.cant, d);
            roll += damping::roll_damping(p.count, mach, state.roll_rate, a, d, v, &p.strips);
        }
        (cm, forcing, roll)
    }

    /// Mean body radius over stations `[x0, x1]` (0 when empty).
    fn mean_radius(&self, x0: f64, x1: f64) -> f64 {
        if x1 - x0 <= 1e-12 {
            return 0.0;
        }
        let r = |x: f64| {
            self.bodies
                .iter()
                .find(|b| x >= b.body.x_fore - 1e-12 && x <= b.body.x_fore + b.body.length + 1e-12)
                .map_or(0.0, |b| b.body.radius(x - b.body.x_fore))
        };
        let (_, plan, _) = profile_integrals(|s| r(x0 + s), x1 - x0);
        plan / (2.0 * (x1 - x0))
    }
}

/// CP station of a fin set: the MAC leading edge plus the (3.36) fraction of
/// the MAC at the planform aspect ratio; tube fins use the annular-wing aspect
/// ratio A = d/L (NACA TN 4117 conclusion 1, `tube_fins`).
fn fin_cp(f: &FinTerm, mach: f64) -> f64 {
    let p = &f.fins;
    let ar = match f.drag {
        FinDrag::Planar => p.aspect_ratio(),
        FinDrag::Tube { od, id } => {
            tube_fins::ring_aspect_ratio(tube_fins::ring_diameter(od, id), p.root_chord)
        }
    };
    p.x_mac_le + p.mac * cp_fraction(mach, ar)
}

/// Whether the body over stations [x0, x1] is tube of radius `r` (flush
/// tubes in a row count; a transition, step, or gap does not).
fn on_constant_tube(bodies: &[BodyTerm], x0: f64, x1: f64, r: f64) -> bool {
    let tol = 1e-6 * r.max(1e-3);
    let mut covered = x0;
    for b in bodies {
        let (lo, hi) = (b.body.x_fore, b.body.x_fore + b.body.length);
        if hi <= covered + tol || lo >= x1 - tol {
            continue;
        }
        let tube = b.body.kind == BodyKind::Tube
            && (b.body.r0 - r).abs() <= tol
            && (b.body.r1 - r).abs() <= tol;
        if !tube || lo > covered + tol {
            return false;
        }
        covered = hi;
        if covered >= x1 - tol {
            return true;
        }
    }
    covered >= x1 - tol
}

/// Fin-set CP with the body-carried load at its own CP (NACA TR 1307):
/// x = x_F + (K_B(F)/(K_F(B) + K_B(F))) (x_B − x_F), where K_F(B) is eq 14,
/// K_F(B) + K_B(F) = (1 + τ)² (eq 21), x_F the fin CP, and x_B the chart 16
/// body-load CP (β frozen at the subsonic limit). The shift fades with the
/// body-load term through the transonic blend (K_B(T) → 0 by M 1.5, as
/// `fins::kb_t`), and with α from full at 10° to none at 20°, where the
/// small-angle theory gives way to the previous scalar model (openrocket-
/// techdoc-2026 pdf p 47).
/// cite: naca-tr-1307 eq 21 p 10
fn fin_body_cp(
    t: &body_load::TrapezoidFin,
    x_fin: f64,
    x_root_le: f64,
    mach: f64,
    alpha: f64,
) -> f64 {
    let kt = kt_b(t.r_t, t.span);
    let kb_sub = kt * kt - kt;
    let w_mach = if kb_sub > 0.0 {
        (kb_t(mach, t.r_t, t.span) / kb_sub).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (a0, a1) = (10f64.to_radians(), 20f64.to_radians());
    let w_alpha = ((a1 - alpha) / (a1 - a0)).clamp(0.0, 1.0);
    let tau = t.r_t / (t.r_t + t.span);
    let total = (1.0 + tau) * (1.0 + tau);
    let share = (total - body_load::k_fin_body(tau)) / total;
    let x_b = x_root_le + body_load::body_load_cp(t, beta(mach.min(SUBSONIC_LIMIT)));
    x_fin + w_mach * w_alpha * share * (x_b - x_fin)
}

/// Pressure-drag model of one body component.
fn body_drag(b: &BodySegment) -> BodyDrag {
    let (a0, a1) = b.areas();
    match (b.kind, b.shape) {
        (BodyKind::Tube, _) | (_, None) => BodyDrag::None,
        (_, Some((shape, param))) if b.r1 > b.r0 => {
            // Nose, or shoulder treated as a nose of base radius r_1 − r_0 (A.7, PD-03).
            let dr = b.r1 - b.r0;
            let h = (b.length * 1e-6).max(1e-12);
            let slope = (b.radius(b.length) - b.radius(b.length - h)) / h;
            BodyDrag::Forebody {
                shape,
                param,
                fineness: if dr > 0.0 { b.length / (2.0 * dr) } else { 0.0 },
                joint: slope.max(0.0).atan(),
                area: a1 - a0,
            }
        }
        (_, Some(_)) if b.r1 < b.r0 => BodyDrag::Boattail { area: a0 - a1 },
        _ => BodyDrag::None,
    }
}

/// Abrupt radius changes between consecutive body components, plus a blunt
/// front when the first component does not start at a point.
fn steps(bodies: &[BodyTerm]) -> Vec<Step> {
    let mut out = Vec::new();
    let mut prev_r = 0.0;
    for b in bodies {
        let (r0, id) = (b.body.r0, b.body.id.clone());
        let da = PI * (r0 * r0 - prev_r * prev_r);
        if da > 1e-15 {
            out.push(Step::Up { id, area: da });
        } else if da < -1e-15 {
            out.push(Step::Down { id, area: -da });
        }
        prev_r = b.body.r1;
    }
    out
}

/// Volume centroid of the outer body (the default damping reference point).
fn volume_centroid(bodies: &[BodyTerm]) -> Option<f64> {
    let (mut v, mut m) = (0.0, 0.0);
    for b in bodies {
        let r = |x: f64| b.body.radius(x);
        let (vol, _, _) = profile_integrals(r, b.body.length);
        let (mom, _, _) = profile_integrals(|x| r(x) * x.max(0.0).sqrt(), b.body.length);
        // ∫π r² x dx via the substitution r·sqrt(x) in the volume integral.
        v += vol;
        m += mom + vol * b.body.x_fore;
    }
    (v > 0.0).then(|| m / v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{case_model, close};

    fn state(mach: f64) -> AeroState {
        AeroState {
            mach,
            speed: mach * A0,
            alpha: 0.0,
            roll_rate: 0.0,
            pitch_rate: 0.0,
            kinematic_viscosity: NU0,
            thrusting: false,
        }
    }

    fn case1() -> AeroModel {
        let m = case_model("case1");
        AeroModel::new(&m, &rw_geom::build(&m), &AeroOptions::default())
    }

    #[test]
    fn volume_centroid_of_a_cylinder() {
        let m = crate::testutil::model(
            vec![crate::testutil::comp(
                "t",
                None,
                "axial",
                [0.0, 1.0],
                None,
                serde_json::json!({ "type": "body_tube", "length": 1.0, "od": 0.1, "id": 0.0 }),
            )],
            0.1,
        );
        let am = AeroModel::new(&m, &rw_geom::build(&m), &AeroOptions::default());
        assert!(close(am.reference_cg(), 0.5, 1e-9));
    }

    #[test]
    fn breakdown_sums_and_alpha_scaling() {
        let am = case1();
        let c = am.eval(&state(0.3));
        let d = c.drag;
        assert!(close(
            d.total,
            d.friction + d.pressure + d.base + d.parasitic,
            1e-12
        ));
        assert_eq!(c.cd, d.total);
        let mut s = state(0.3);
        s.alpha = 17f64.to_radians();
        assert!(close(am.eval(&s).cd, 1.3 * c.cd, 1e-9));
        // Power-off-only base drag disappears while thrusting.
        s = state(0.3);
        s.thrusting = true;
        let am_off = AeroModel::new(
            &case_model("case1"),
            &rw_geom::build(&case_model("case1")),
            &AeroOptions {
                static_mach: 0.3,
                base_drag_power_off_only: true,
            },
        );
        assert_eq!(am_off.eval(&s).drag.base, 0.0);
        // Default (niskanen-2009 sec 3.4.5): the motor exhaust area is
        // removed from the base area while thrusting.
        let b = am.eval(&s).drag.base;
        let a_mount = PI * 0.009 * 0.009;
        let a_base = PI * 0.0125 * 0.0125;
        assert!(close(b, (a_base - a_mount) / a_base * base_cd(0.3), 1e-9));
    }

    #[test]
    fn normal_force_at_alpha() {
        let am = case1();
        let mut s = state(0.3);
        let c0 = am.eval(&s);
        s.alpha = 0.05;
        let c = am.eval(&s);
        assert!(close(c.cn, c.cn_alpha * 0.05, 1e-12));
        // Body lift adds normal force; it acts near mid-body, pulling the CP forward.
        assert!(c.cn_alpha > c0.cn_alpha * 0.99);
        assert!(c.cp < c0.cp);
        assert_eq!(c.components.len(), 3);
    }

    #[test]
    fn damping_signs_and_scaling() {
        let am = case1();
        let mut s = state(0.3);
        s.pitch_rate = 2.0;
        s.roll_rate = 10.0;
        let c = am.eval_with_cg(&s, 0.25);
        assert!(c.cm_damping > 0.0 && c.cl_damping > 0.0);
        assert_eq!(c.cl_forcing, 0.0);
        s.pitch_rate = 4.0;
        let c2 = am.eval_with_cg(&s, 0.25);
        assert!(close(c2.cm_damping, 4.0 * c.cm_damping, 1e-12));
        let st = am.static_coeffs();
        assert_eq!(st.cm_damping, 0.0);
        assert!(st.cn_alpha > 2.0);
    }
}

#[cfg(test)]
mod cluster {
    use super::*;
    use crate::testutil::{close, comp, model};
    use serde_json::json;

    #[test]
    fn clustered_mounts_remove_every_exhaust_from_the_base() {
        let mut mount = comp(
            "mmt",
            Some("body"),
            "inner",
            [0.42, 0.5],
            None,
            json!({
                "type": "inner_tube", "length": 0.08, "od": 0.019, "id": 0.018,
                "motor_mount": true, "overhang": 0.0
            }),
        );
        mount["instances"] = json!([
            { "index": 0, "offset": [0.0, 0.0, 0.0], "roll": 0.0 },
            { "index": 1, "offset": [0.0, 0.0, 0.0], "roll": 2.0943951023931953 },
            { "index": 2, "offset": [0.0, 0.0, 0.0], "roll": 4.1887902047863905 }
        ]);
        mount["radial"] = json!(0.012);
        let m = model(
            vec![
                comp(
                    "body",
                    None,
                    "axial",
                    [0.0, 0.5],
                    None,
                    json!({ "type": "body_tube", "length": 0.5, "od": 0.05, "id": 0.048 }),
                ),
                mount,
            ],
            0.05,
        );
        let g = rw_geom::build(&m);
        assert_eq!(g.components[1].instances.len(), 3);
        let am = AeroModel::new(&m, &g, &AeroOptions::default());
        let s = AeroState {
            mach: 0.3,
            speed: 0.3 * A0,
            alpha: 0.0,
            roll_rate: 0.0,
            pitch_rate: 0.0,
            kinematic_viscosity: NU0,
            thrusting: true,
        };
        let (a_base, a_mount) = (PI * 0.025 * 0.025, PI * 0.009 * 0.009);
        let want = (a_base - 3.0 * a_mount) / a_base * base_cd(0.3);
        assert!(close(am.eval(&s).drag.base, want, 1e-9));
    }
}

#[cfg(test)]
mod cd_override {
    use super::*;
    use crate::testutil::{case_model, close};

    fn state(mach: f64) -> AeroState {
        AeroState {
            mach,
            speed: mach * A0,
            alpha: 0.0,
            roll_rate: 0.0,
            pitch_rate: 0.0,
            kinematic_viscosity: NU0,
            thrusting: false,
        }
    }

    fn with_override(id: &str, cd: f64, subtree: bool) -> AeroModel {
        let mut m = case_model("case1");
        let c = m.components.iter_mut().find(|c| c.id == id).unwrap();
        c.overrides = Some(rw_model::EvalOverride {
            mass: None,
            cg: None,
            cd: Some(cd),
            subtree,
        });
        AeroModel::new(&m, &rw_geom::build(&m), &AeroOptions::default())
    }

    fn cd_of(terms: &[DragTerm], id: &str) -> f64 {
        terms.iter().filter(|t| t.id == id).map(|t| t.cd).sum()
    }

    #[test]
    fn component_override_replaces_only_its_own_terms() {
        let base = AeroModel::new(
            &case_model("case1"),
            &rw_geom::build(&case_model("case1")),
            &AeroOptions::default(),
        );
        let am = with_override("fins", 0.2, false);
        for mach in [0.1, 0.3, 0.8] {
            let t0 = base.drag_terms(&state(mach));
            let t = am.drag_terms(&state(mach));
            assert!(close(cd_of(&t, "fins"), 0.2, 1e-12));
            for id in ["nose", "body", "lug"] {
                assert!(close(cd_of(&t, id), cd_of(&t0, id), 1e-12), "{id}");
            }
            let want = base.eval(&state(mach)).cd - cd_of(&t0, "fins") + 0.2;
            assert!(close(am.eval(&state(mach)).cd, want, 1e-12));
        }
    }

    #[test]
    fn subtree_override_replaces_the_component_and_its_children() {
        let am = with_override("body", 2.0, true);
        let t = am.drag_terms(&state(0.3));
        // body, lug and fins (children of body) collapse into the override.
        assert!(close(cd_of(&t, "body"), 2.0, 1e-12));
        assert_eq!(cd_of(&t, "lug"), 0.0);
        assert_eq!(cd_of(&t, "fins"), 0.0);
        assert!(cd_of(&t, "nose") > 0.0);
        let c = am.eval(&state(0.3));
        assert!(close(c.cd, 2.0 + cd_of(&t, "nose"), 1e-12));
        // The axial factor f_A(α) still scales the overridden total.
        let mut s = state(0.3);
        s.alpha = 17f64.to_radians();
        assert!(close(am.eval(&s).cd, 1.3 * c.cd, 1e-9));
    }

    #[test]
    fn outer_subtree_override_wins_over_a_nested_one() {
        let mut m = case_model("case1");
        for (id, cd, subtree) in [("fins", 5.0, false), ("body", 1.0, true)] {
            let c = m.components.iter_mut().find(|c| c.id == id).unwrap();
            c.overrides = Some(rw_model::EvalOverride {
                mass: None,
                cg: None,
                cd: Some(cd),
                subtree,
            });
        }
        let am = AeroModel::new(&m, &rw_geom::build(&m), &AeroOptions::default());
        let t = am.drag_terms(&state(0.3));
        assert!(close(cd_of(&t, "body"), 1.0, 1e-12));
        assert_eq!(cd_of(&t, "fins"), 0.0);
    }
}
