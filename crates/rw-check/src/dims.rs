//! Overall and per-component dimensions (`dims`), plus shape accessors the
//! other checks share. Matches list the kinds they use and fall through for
//! the rest, so new IF2 component kinds compile unchanged.

use rw_geom::Geometry;
use rw_model::{EvalComponent, EvalShape, EvaluatedModel};

use crate::{ComponentDims, Dims};

/// Outer and inner diameter of a component, where the kind has them.
/// Transitions report their larger end. Zero bores are omitted.
pub(crate) fn od_id(shape: &EvalShape) -> (Option<f64>, Option<f64>) {
    let (od, id) = match *shape {
        EvalShape::NoseCone { od, .. }
        | EvalShape::Bulkhead { od, .. }
        | EvalShape::MassComponent { od, .. }
        | EvalShape::Tank { od, .. } => (Some(od), None),
        EvalShape::Transition {
            fore_od, aft_od, ..
        } => (Some(fore_od.max(aft_od)), None),
        EvalShape::BodyTube { od, id, .. }
        | EvalShape::TubeFinSet { od, id, .. }
        | EvalShape::InnerTube { od, id, .. }
        | EvalShape::Coupler { od, id, .. }
        | EvalShape::CenteringRing { od, id, .. }
        | EvalShape::EngineBlock { od, id, .. }
        | EvalShape::LaunchLug { od, id, .. }
        | EvalShape::RailButton { od, id, .. } => (Some(od), Some(id)),
        _ => (None, None),
    };
    (od, id.filter(|d| *d > 0.0))
}

/// Inner (bore) diameter of a tube-like component that can hold others.
pub(crate) fn bore(shape: &EvalShape) -> Option<f64> {
    match *shape {
        EvalShape::BodyTube { id, .. }
        | EvalShape::InnerTube { id, .. }
        | EvalShape::Coupler { id, .. } => Some(id),
        _ => None,
    }
}

/// Packed diameter and length of a recovery item.
pub(crate) fn packed(shape: &EvalShape) -> Option<(f64, f64)> {
    match *shape {
        EvalShape::Parachute {
            packed_diameter,
            packed_length,
            ..
        }
        | EvalShape::Streamer {
            packed_diameter,
            packed_length,
            ..
        }
        | EvalShape::ShockCord {
            packed_diameter,
            packed_length,
            ..
        } => Some((packed_diameter, packed_length)),
        _ => None,
    }
}

/// True for the planar fin sets.
pub(crate) fn is_fin_set(c: &EvalComponent) -> bool {
    matches!(
        c.shape,
        EvalShape::TrapezoidalFinSet { .. }
            | EvalShape::EllipticalFinSet { .. }
            | EvalShape::FreeformFinSet { .. }
    )
}

/// `num / den`, or `None` without a positive denominator.
/// cite: n/a ratio of two computed lengths
pub(crate) fn ratio(num: f64, den: f64) -> Option<f64> {
    (den > 0.0 && num.is_finite()).then(|| num / den)
}

/// The `dims` block (`length_cal` is filled in once the reference diameter
/// is known).
pub(crate) fn dims(model: &EvaluatedModel, geometry: &Geometry) -> Dims {
    let length = if geometry.length > 0.0 {
        geometry.length
    } else {
        model.reference.length
    };
    let fin_span = geometry
        .components
        .iter()
        .filter_map(|g| g.fins.as_ref())
        .map(|f| 2.0 * (f.root_radius + f.span))
        .reduce(f64::max);
    let components = model
        .components
        .iter()
        .map(|c| {
            let (od, id) = od_id(&c.shape);
            ComponentDims {
                component: c.id.clone(),
                x_fore: c.x_fore,
                x_aft: c.x_aft,
                length: c.x_aft - c.x_fore,
                od,
                id,
            }
        })
        .collect();
    Dims {
        length,
        max_diameter: geometry.max_diameter,
        fin_span,
        length_cal: None,
        fineness: ratio(length, geometry.max_diameter),
        components,
    }
}
