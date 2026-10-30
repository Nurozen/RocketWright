//! Geometry (IF3): axisymmetric profiles, fin plates, and the triangulated GLB
//! (R4.1). Frames and sign conventions: `docs/frames.md` and [`frames`].
//!
//! Per-component conventions (see `docs/frames.md` for the full table):
//! - `volume`: material volume of all instances (shell minus cavity; fin
//!   plates include the tab).
//! - `wetted_area`: exposed outer area of all instances when `aero`, else 0
//!   (shoulders excluded; fins count both faces, 2·N·A_fin).
//! - `planform_area`: one instance — side projection ∫2r dx of the shaped
//!   length for bodies, A_fin for one fin.
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Enforced by the root `clippy.toml`.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod area;
pub mod fins;
pub mod frames;
pub mod glb;
pub mod mesh;
pub mod nose;
pub mod profile;
pub mod types;

pub use frames::explode_dirs;
pub use types::*;

use std::f64::consts::TAU;

use rw_model::{ComponentType, EvalComponent, EvalFinCommon, EvalShape, EvaluatedModel, SchemaTag};

use crate::area::{RevMetrics, polyline_metrics};
use crate::fins::{
    PlanformStats, elliptical_planform, freeform_planform, planform_stats, plate_volume,
    polygon_area_signed, tab_polygon, trapezoid_area, trapezoid_mac, trapezoid_planform,
};
use crate::frames::{fin_point_body, place, roll_about_x};
use crate::mesh::rail_button_profile;
use crate::profile::{
    Revolved, nose_profile, radius_at, tank_profile, transition_profile, tube_profile,
};

/// Arc segments of an elliptical fin planform.
const ELLIPSE_SEGMENTS: usize = 64;

/// Builds the geometry of every component from the evaluated model.
/// cite: n/a assembly of per-component geometry (shapes cite their equations)
pub fn build(model: &EvaluatedModel) -> Geometry {
    let mut comps: Vec<ComponentGeometry> = Vec::with_capacity(model.components.len());
    for c in &model.components {
        let g = component(c, &comps);
        comps.push(g);
    }
    let max_r = comps
        .iter()
        .filter(|g| is_body(g.kind))
        .flat_map(|g| g.outer.iter().map(|p| p.r))
        .fold(0.0, f64::max);
    let length = comps
        .iter()
        .filter(|g| !g.cut)
        .map(|g| g.bbox.max[0])
        .fold(0.0, f64::max);
    Geometry {
        schema: SchemaTag,
        model_hash: model.model_hash.clone(),
        length,
        max_diameter: 2.0 * max_r,
        ref_diameter: model.reference.diameter,
        ref_area: model.reference.area,
        components: comps,
    }
}

/// Triangulates the geometry into a binary glTF (GLB). Node name = component
/// id (instances `<id>/<n>`); body frame +X aft, +Z up (the loader rotates to Y-up).
/// cite: n/a file format encoding (glTF 2.0)
pub fn mesh_glb(geometry: &Geometry, opts: &MeshOptions) -> Vec<u8> {
    glb::write(geometry, opts)
}

/// [`mesh_glb`] of an evaluated model: with `opts.cutters`, cutter nodes
/// name the parent they subtract from (`extras.rw_cut_parent`).
/// cite: n/a file format encoding (glTF 2.0)
pub fn mesh_model_glb(model: &EvaluatedModel, opts: &MeshOptions) -> Vec<u8> {
    let parents = model
        .components
        .iter()
        .filter(|c| c.cut)
        .filter_map(|c| c.parent.clone().map(|p| (c.id.clone(), p)))
        .collect();
    glb::write_with_parents(&build(model), opts, &parents)
}

fn is_body(t: ComponentType) -> bool {
    matches!(
        t,
        ComponentType::NoseCone | ComponentType::BodyTube | ComponentType::Transition
    )
}

/// Outer radius of the body a component sits on, at station `x`.
fn host_radius(c: &EvalComponent, built: &[ComponentGeometry], x: f64) -> f64 {
    let parent = c
        .parent
        .as_deref()
        .and_then(|p| built.iter().find(|g| g.id == p))
        .and_then(|g| radius_at(&g.outer, x));
    parent
        .or_else(|| {
            built
                .iter()
                .filter(|g| is_body(g.kind))
                .find_map(|g| radius_at(&g.outer, x))
        })
        .or_else(|| {
            c.anchors
                .iter()
                .find(|a| a.name == "root_le" || a.name == "fore")
                .map(|a| a.r)
        })
        .unwrap_or(0.0)
}

/// Instance placements from the model: offset = Rx(roll)·(0, radial, 0) + instance offset.
fn model_instances(c: &EvalComponent, radial: f64) -> Vec<InstanceGeometry> {
    let mk = |roll_i: f64, off: [f64; 3]| {
        let roll = c.roll + roll_i;
        let r = roll_about_x([0.0, radial, 0.0], roll);
        InstanceGeometry {
            offset: [r[0] + off[0], r[1] + off[1], r[2] + off[2]],
            roll,
        }
    };
    if c.instances.is_empty() {
        return vec![mk(0.0, [0.0; 3])];
    }
    c.instances.iter().map(|i| mk(i.roll, i.offset)).collect()
}

/// `count` instances evenly spaced in roll (model instances when they match).
fn radial_instances(c: &EvalComponent, count: u32, radial: f64) -> Vec<InstanceGeometry> {
    let n = count.max(1) as usize;
    if c.instances.len() == n {
        return model_instances(c, radial);
    }
    let start = c.instances.first().map_or(0.0, |i| i.roll);
    (0..n)
        .map(|k| {
            let roll = c.roll + start + TAU * k as f64 / n as f64;
            InstanceGeometry {
                offset: roll_about_x([0.0, radial, 0.0], roll),
                roll,
            }
        })
        .collect()
}

fn bbox_of(points: impl IntoIterator<Item = [f64; 3]>) -> Option<Aabb> {
    let mut b: Option<Aabb> = None;
    for p in points {
        let a = b.get_or_insert(Aabb { min: p, max: p });
        for (k, v) in p.iter().enumerate() {
            a.min[k] = a.min[k].min(*v);
            a.max[k] = a.max[k].max(*v);
        }
    }
    b
}

fn revolved_bbox(outer: &[ProfilePoint], insts: &[InstanceGeometry], c: &EvalComponent) -> Aabb {
    let (x0, x1, r) = outer.iter().fold(
        (f64::INFINITY, f64::NEG_INFINITY, 0.0_f64),
        |(a, b, r), p| (a.min(p.x), b.max(p.x), r.max(p.r)),
    );
    let (x0, x1) = if x0.is_finite() {
        (x0, x1)
    } else {
        (c.x_fore, c.x_aft)
    };
    bbox_of(insts.iter().flat_map(|i| {
        let o = i.offset;
        [
            [x0 + o[0], o[1] - r, o[2] - r],
            [x1 + o[0], o[1] + r, o[2] + r],
        ]
    }))
    .unwrap_or(Aabb {
        min: [x0, 0.0, 0.0],
        max: [x1, 0.0, 0.0],
    })
}

fn geometry(
    c: &EvalComponent,
    rev: Revolved,
    insts: Vec<InstanceGeometry>,
    extra_wetted: f64,
) -> ComponentGeometry {
    let n = insts.len() as f64;
    let bbox = revolved_bbox(&rev.outer, &insts, c);
    ComponentGeometry {
        id: c.id.clone(),
        kind: c.component_type(),
        aero: c.aero,
        cut: c.cut,
        x_fore: c.x_fore,
        x_aft: c.x_aft,
        outer: rev.outer,
        inner: rev.inner,
        fins: None,
        instances: insts,
        volume: rev.volume * n,
        wetted_area: if c.aero {
            (rev.exposed.wetted_area + extra_wetted) * n
        } else {
            0.0
        },
        planform_area: rev.exposed.planform_area,
        bbox,
    }
}

fn fin_set(
    c: &EvalComponent,
    common: &EvalFinCommon,
    poly: Vec<[f64; 2]>,
    stats: PlanformStats,
    built: &[ComponentGeometry],
) -> ComponentGeometry {
    let root_x = 0.5 * (stats_root(&poly).0 + stats_root(&poly).1);
    let root_radius = host_radius(c, built, root_x);
    let insts = radial_instances(c, common.count, 0.0);
    let tab = common
        .tab
        .as_ref()
        .filter(|t| t.height > 0.0 && t.length > 0.0)
        .map(|t| tab_polygon(c.x_fore, t.height, t.length, t.offset));
    let tab_area = tab.as_deref().map_or(0.0, polygon_area_signed);
    let fin = FinGeometry {
        count: insts.len() as u32,
        planform: poly,
        tab,
        root_radius,
        thickness: common.thickness,
        cross_section: common.cross_section,
        cant: common.cant,
        fillet_radius: common.fillet_radius,
        roll: insts.iter().map(|i| i.roll).collect(),
        span: stats.span,
        root_chord: stats.root_chord,
        tip_chord: stats.tip_chord,
        mid_chord_sweep_length: stats.mid_chord_sweep_length,
        mean_aero_chord: stats.mac,
    };
    let h = 0.5 * fin.thickness;
    let corners: Vec<[f64; 2]> = fin
        .planform
        .iter()
        .chain(fin.tab.iter().flatten())
        .copied()
        .collect();
    let bbox = bbox_of(insts.iter().flat_map(|i| {
        let fin = &fin;
        corners
            .iter()
            .flat_map(move |p| [-h, h].map(|z| fin_point_body(fin, i, p[0], p[1], z)))
    }))
    .unwrap_or(Aabb {
        min: [c.x_fore, 0.0, 0.0],
        max: [c.x_aft, 0.0, 0.0],
    });
    let n = insts.len() as f64;
    ComponentGeometry {
        id: c.id.clone(),
        kind: c.component_type(),
        aero: c.aero,
        cut: c.cut,
        x_fore: c.x_fore,
        x_aft: c.x_aft,
        outer: Vec::new(),
        inner: Vec::new(),
        volume: n * plate_volume(stats.area + tab_area, fin.thickness),
        wetted_area: if c.aero { 2.0 * n * stats.area } else { 0.0 },
        planform_area: stats.area,
        fins: Some(fin),
        instances: insts,
        bbox,
    }
}

/// Root LE and TE stations of a planform polygon (points on y = 0).
fn stats_root(poly: &[[f64; 2]]) -> (f64, f64) {
    poly.iter()
        .filter(|p| p[1].abs() < 1e-12)
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), p| {
            (a.min(p[0]), b.max(p[0]))
        })
}

fn component(c: &EvalComponent, built: &[ComponentGeometry]) -> ComponentGeometry {
    let x0 = c.x_fore;
    match &c.shape {
        EvalShape::NoseCone {
            shape,
            shape_param,
            length,
            od,
            thickness,
            shoulder,
        } => {
            let rev = nose_profile(
                x0,
                *shape,
                *shape_param,
                *length,
                *od,
                *thickness,
                shoulder.as_ref(),
            );
            geometry(c, rev, model_instances(c, c.radial), 0.0)
        }
        EvalShape::Transition {
            shape,
            shape_param,
            length,
            fore_od,
            aft_od,
            thickness,
            fore_shoulder,
            aft_shoulder,
        } => {
            let rev = transition_profile(
                x0,
                *shape,
                *shape_param,
                *length,
                *fore_od,
                *aft_od,
                *thickness,
                fore_shoulder.as_ref(),
                aft_shoulder.as_ref(),
            );
            geometry(c, rev, model_instances(c, c.radial), 0.0)
        }
        EvalShape::BodyTube { length, od, id }
        | EvalShape::Coupler { length, od, id }
        | EvalShape::CenteringRing { length, od, id }
        | EvalShape::EngineBlock { length, od, id }
        | EvalShape::InnerTube { length, od, id, .. } => geometry(
            c,
            tube_profile(x0, *length, *od, *id),
            model_instances(c, c.radial),
            0.0,
        ),
        EvalShape::Bulkhead { length, od } => geometry(
            c,
            tube_profile(x0, *length, *od, 0.0),
            model_instances(c, c.radial),
            0.0,
        ),
        EvalShape::LaunchLug { length, od, id } => {
            let radial = if c.radial > 0.0 {
                c.radial
            } else {
                host_radius(c, built, x0 + 0.5 * length) + 0.5 * od
            };
            geometry(
                c,
                tube_profile(x0, *length, *od, *id),
                model_instances(c, radial),
                0.0,
            )
        }
        EvalShape::TubeFinSet {
            count,
            length,
            od,
            id,
        } => {
            let radial = if c.radial > 0.0 {
                c.radial
            } else {
                host_radius(c, built, x0 + 0.5 * length) + 0.5 * od
            };
            let rev = tube_profile(x0, *length, *od, *id);
            // Tube fins are open: the bore is wetted too.
            let bore = std::f64::consts::PI * id * length;
            geometry(c, rev, radial_instances(c, *count, radial), bore)
        }
        EvalShape::Parachute {
            packed_length,
            packed_diameter,
            ..
        }
        | EvalShape::Streamer {
            packed_length,
            packed_diameter,
            ..
        }
        | EvalShape::ShockCord {
            packed_length,
            packed_diameter,
            ..
        } => geometry(
            c,
            tube_profile(x0, *packed_length, *packed_diameter, 0.0),
            model_instances(c, c.radial),
            0.0,
        ),
        EvalShape::MassComponent { length, od, .. } => geometry(
            c,
            tube_profile(x0, *length, *od, 0.0),
            model_instances(c, c.radial),
            0.0,
        ),
        EvalShape::Tank {
            length,
            od,
            wall,
            end_cap,
            ..
        } => geometry(
            c,
            tank_profile(x0, *length, *od, *wall, *end_cap),
            model_instances(c, c.radial),
            0.0,
        ),
        EvalShape::RailButton {
            od,
            id,
            height,
            base_height,
            flange_height,
        } => rail_button_geometry(c, built, [*od, *id, *height, *base_height, *flange_height]),
        EvalShape::TrapezoidalFinSet {
            fins,
            root_chord,
            tip_chord,
            span,
            sweep,
        } => {
            let poly = trapezoid_planform(x0, *root_chord, *tip_chord, *span, *sweep);
            let mut stats = planform_stats(&poly);
            stats.area = trapezoid_area(*root_chord, *tip_chord, *span);
            stats.mac = trapezoid_mac(*root_chord, *tip_chord);
            fin_set(c, fins, poly, stats, built)
        }
        EvalShape::EllipticalFinSet {
            fins,
            root_chord,
            span,
        } => {
            let poly = elliptical_planform(x0, *root_chord, *span, ELLIPSE_SEGMENTS);
            let stats = planform_stats(&poly);
            fin_set(c, fins, poly, stats, built)
        }
        EvalShape::FreeformFinSet { fins, points } => {
            let poly = freeform_planform(x0, points);
            let stats = planform_stats(&poly);
            fin_set(c, fins, poly, stats, built)
        }
    }
}

/// `dims` = [od, id, height, base height, flange height].
fn rail_button_geometry(
    c: &EvalComponent,
    built: &[ComponentGeometry],
    dims: [f64; 5],
) -> ComponentGeometry {
    let [od, id, height, base_h, flange_h] = dims;
    let xc = 0.5 * (c.x_fore + c.x_aft);
    let base = if c.radial > 0.0 {
        c.radial
    } else {
        host_radius(c, built, xc)
    };
    let profile = rail_button_profile(base, od, id, height, base_h, flange_h);
    let m = polyline_metrics(&profile);
    let ro = 0.5 * od;
    let insts = model_instances(c, 0.0);
    let n = insts.len() as f64;
    let bbox = bbox_of(insts.iter().flat_map(|i| {
        let mut v = Vec::with_capacity(8);
        for x in [xc - ro, xc + ro] {
            for y in [base, base + height] {
                for z in [-ro, ro] {
                    v.push(place([x, y, z], i));
                }
            }
        }
        v
    }))
    .unwrap_or(Aabb {
        min: [c.x_fore, 0.0, 0.0],
        max: [c.x_aft, 0.0, 0.0],
    });
    let exposed = RevMetrics {
        wetted_area: m.wetted_area + std::f64::consts::PI * ro * ro,
        ..m
    };
    ComponentGeometry {
        id: c.id.clone(),
        kind: c.component_type(),
        aero: c.aero,
        cut: c.cut,
        x_fore: c.x_fore,
        x_aft: c.x_aft,
        outer: profile,
        inner: Vec::new(),
        fins: None,
        volume: m.volume * n,
        wetted_area: if c.aero { exposed.wetted_area * n } else { 0.0 },
        planform_area: exposed.planform_area,
        instances: insts,
        bbox,
    }
}
