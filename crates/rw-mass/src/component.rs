//! Per-component dry mass properties from the rw-geom geometry and the
//! component's material (bulk, surface, or line density).

use rw_geom::nose::shape_radius;
use rw_geom::{ComponentGeometry, ProfilePoint};
use rw_model::{EvalComponent, EvalMaterial, EvalShape, EvaluatedModel};

use crate::body::{RigidBody, rot_x};
use crate::fins::fin_set_body;
use crate::revolve::{
    RevMoments, curve_solid_moments, hollow_moments, shell_moments, solid_moments,
};
use rw_model::EvalShoulder;

/// How a material weighs.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Density {
    /// kg/m³.
    pub bulk: Option<f64>,
    /// kg/m².
    pub surface: Option<f64>,
    /// kg/m.
    pub line: Option<f64>,
}

impl From<&EvalMaterial> for Density {
    fn from(m: &EvalMaterial) -> Self {
        Density {
            bulk: m.density,
            surface: m.surface_density,
            line: m.line_density,
        }
    }
}

/// The density of `name` in the model's resolved materials (none when absent).
/// cite: n/a lookup, no physics
pub fn material_density(model: &EvaluatedModel, name: Option<&str>) -> Density {
    name.and_then(|n| model.materials.get(n))
        .map(Density::from)
        .unwrap_or_default()
}

/// Moments of `profile`'s solid, normalised so the total mass is `mass`
/// (a packed or lumped item spread uniformly over its envelope). A profile
/// with no volume gives a point mass at the profile's mid-station.
fn lumped(mass: f64, outer: &[ProfilePoint], x_mid: f64) -> RigidBody {
    let s = solid_moments(outer);
    if s.m > 0.0 {
        s.scaled(mass / s.m).body()
    } else {
        RigidBody::point(mass, [x_mid, 0.0, 0.0])
    }
}

/// Places a body built on the component axis at every instance
/// (`p = Rx(roll) p + offset`).
fn instanced(local: &RigidBody, g: &ComponentGeometry) -> RigidBody {
    if g.instances.is_empty() {
        return *local;
    }
    let parts: Vec<RigidBody> = g
        .instances
        .iter()
        .map(|i| local.rotated(&rot_x(i.roll)).translated(i.offset))
        .collect();
    RigidBody::combine(&parts)
}

/// Material between `outer` and `inner` with the given density; a
/// surface-density-only material weighs as a thin shell over `outer`. The
/// solid is renormalised to the geometry's per-instance material volume, which
/// rw-geom integrates on a finer grid than the published polyline.
fn revolved(d: Density, c: &EvalComponent, g: &ComponentGeometry) -> RigidBody {
    let n = g.instances.len().max(1) as f64;
    let mom = if let Some(rho) = d.bulk {
        if let Some(m) = shaped(rho, c, g) {
            return m.body();
        }
        let raw = hollow_moments(&g.outer, &g.inner);
        let v_geom = g.volume / n;
        let k = if raw.m > 0.0 && v_geom > 0.0 {
            v_geom / raw.m
        } else {
            1.0
        };
        raw.scaled(rho * k)
    } else if let Some(sigma) = d.surface {
        shell_moments(&g.outer).scaled(sigma)
    } else {
        RevMoments::default()
    };
    mom.body()
}

/// Solid cylinder moments of a shoulder at stations x0..x0+len (per unit density).
fn shoulder_moments(sh: Option<&EvalShoulder>, x0: f64) -> RevMoments {
    match sh {
        Some(s) if s.length > 0.0 && s.od > 0.0 => {
            let r = 0.5 * s.od;
            solid_moments(&[
                ProfilePoint { x: x0, r },
                ProfilePoint {
                    x: x0 + s.length,
                    r,
                },
            ])
        }
        _ => RevMoments::default(),
    }
}

/// Nose cones and transitions with a bulk density: the outer solid from the
/// analytic shape (fine grid) plus shoulders, minus the published cavity
/// rescaled to the cavity volume rw-geom integrated (enclosed − material).
fn shaped(rho: f64, c: &EvalComponent, g: &ComponentGeometry) -> Option<RevMoments> {
    let x0 = c.x_fore;
    let outer = match &c.shape {
        EvalShape::NoseCone {
            shape,
            shape_param,
            length,
            od,
            shoulder,
            ..
        } => {
            let base = 0.5 * od;
            let f = |xi: f64| shape_radius(*shape, *shape_param, *length, base, xi);
            curve_solid_moments(f, x0, *length, true)
                .plus(shoulder_moments(shoulder.as_ref(), x0 + length), 1.0)
        }
        EvalShape::Transition {
            shape,
            shape_param,
            length,
            fore_od,
            aft_od,
            fore_shoulder,
            aft_shoulder,
            ..
        } => {
            let (rf, ra) = (0.5 * fore_od, 0.5 * aft_od);
            let (small, big) = (rf.min(ra), rf.max(ra));
            let f = |xi: f64| small + shape_radius(*shape, *shape_param, *length, big - small, xi);
            let fore_len = fore_shoulder.as_ref().map_or(0.0, |s| s.length);
            curve_solid_moments(f, x0, *length, ra >= rf)
                .plus(shoulder_moments(aft_shoulder.as_ref(), x0 + length), 1.0)
                .plus(shoulder_moments(fore_shoulder.as_ref(), x0 - fore_len), 1.0)
        }
        _ => return None,
    };
    let n = g.instances.len().max(1) as f64;
    let cavity = solid_moments(&g.inner);
    let v_cavity = (outer.m - g.volume / n).max(0.0);
    let cavity = if cavity.m > 0.0 {
        cavity.scaled(v_cavity / cavity.m)
    } else {
        cavity
    };
    Some(outer.plus(cavity, -1.0).scaled(rho))
}

/// Rail button: the profile meridian runs along the button's own radial axis
/// (+Y in the component frame) at the button's mid-station.
fn rail_button(d: Density, c: &EvalComponent, g: &ComponentGeometry) -> RigidBody {
    let Some(rho) = d.bulk else {
        return RigidBody::ZERO;
    };
    let along = solid_moments(&g.outer).scaled(rho).body();
    // Profile axis X → +Y; (a, b, c) → (b, a, −c) as in the rw-geom mesh.
    let swap = [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0]];
    let xc = 0.5 * (c.x_fore + c.x_aft);
    let local = along.rotated(&swap).translated([xc, 0.0, 0.0]);
    instanced(&local, g)
}

/// Mass of one instance of a recovery item or lump, from its material (or
/// the declared mass), before placement. A parachute adds its shroud lines,
/// `line_count · line_length · λ(line_material)`.
/// cite: niskanen-2009 sec 4.2.3 p 74
fn lump_mass(c: &EvalComponent, d: Density, g: &ComponentGeometry, model: &EvaluatedModel) -> f64 {
    let packed_volume = solid_moments(&g.outer).m;
    let by_volume = d.bulk.map(|rho| rho * packed_volume);
    match &c.shape {
        EvalShape::Parachute {
            diameter,
            spill_hole,
            line_count,
            line_length,
            line_material,
            ..
        } => {
            let area =
                std::f64::consts::FRAC_PI_4 * (diameter * diameter - spill_hole * spill_hole);
            let canopy = d.surface.map(|s| s * area.max(0.0)).or(by_volume);
            let lines = material_density(model, line_material.as_deref())
                .line
                .map(|l| l * f64::from(*line_count) * line_length.max(0.0));
            match (canopy, lines) {
                (Some(a), Some(b)) => Some(a + b),
                (a, b) => a.or(b),
            }
        }
        EvalShape::Streamer { length, width, .. } => {
            d.surface.map(|s| s * length * width).or(by_volume)
        }
        EvalShape::ShockCord { cord_length, .. } => d.line.map(|l| l * cord_length).or(by_volume),
        EvalShape::MassComponent { mass, .. } => Some(*mass),
        _ => by_volume,
    }
    .unwrap_or(0.0)
}

/// The dry rigid body of one component (all instances), before overrides.
/// `parent_density` is used by cut components, which remove their volume of
/// the parent's material (negative mass, MI-25).
/// cite: niskanen-2009 sec 4.2.3 p 74
/// cite: amcp-706-280 sec 6-2.2 p 108
pub fn component_body(
    c: &EvalComponent,
    g: &ComponentGeometry,
    model: &EvaluatedModel,
    parent_density: Density,
) -> RigidBody {
    component_body_loaded(c, g, model, parent_density, true)
}

/// [`component_body`], with a tank's loaded propellant left out when
/// `propellant` is false (an active liquid engine's curve carries it).
/// cite: niskanen-2009 sec 4.2.3 p 74
pub fn component_body_loaded(
    c: &EvalComponent,
    g: &ComponentGeometry,
    model: &EvaluatedModel,
    parent_density: Density,
    propellant: bool,
) -> RigidBody {
    let own = material_density(model, c.material.as_deref());
    let d = if c.cut && own == Density::default() {
        parent_density
    } else {
        own
    };
    let body = match &c.shape {
        EvalShape::NoseCone { .. }
        | EvalShape::BodyTube { .. }
        | EvalShape::Transition { .. }
        | EvalShape::InnerTube { .. }
        | EvalShape::Coupler { .. }
        | EvalShape::CenteringRing { .. }
        | EvalShape::Bulkhead { .. }
        | EvalShape::EngineBlock { .. }
        | EvalShape::LaunchLug { .. }
        | EvalShape::TubeFinSet { .. } => instanced(&revolved(d, c, g), g),
        EvalShape::Tank {
            propellant_mass, ..
        } => {
            let shell = revolved(d, c, g);
            // Loaded propellant fills the cavity uniformly.
            let fill = solid_moments(&g.inner);
            let prop = if propellant && fill.m > 0.0 && *propellant_mass > 0.0 {
                fill.scaled(propellant_mass / fill.m).body()
            } else {
                RigidBody::ZERO
            };
            instanced(&RigidBody::combine([&shell, &prop]), g)
        }
        EvalShape::RailButton { .. } => rail_button(d, c, g),
        EvalShape::Parachute { .. }
        | EvalShape::Streamer { .. }
        | EvalShape::ShockCord { .. }
        | EvalShape::MassComponent { .. } => {
            let m = lump_mass(c, d, g, model);
            let local = lumped(m, &g.outer, 0.5 * (c.x_fore + c.x_aft));
            instanced(&local, g)
        }
        EvalShape::TrapezoidalFinSet { fins, .. }
        | EvalShape::EllipticalFinSet { fins, .. }
        | EvalShape::FreeformFinSet { fins, .. } => match &g.fins {
            Some(fg) => {
                let rho_t = d
                    .bulk
                    .map(|rho| rho * fins.thickness)
                    .or(d.surface)
                    .unwrap_or(0.0);
                let rho_fillet = d.bulk.unwrap_or(0.0);
                fin_set_body(fg, &g.instances, rho_t, rho_fillet)
            }
            None => RigidBody::ZERO,
        },
    };
    if c.cut { body.scaled(-1.0) } else { body }
}
