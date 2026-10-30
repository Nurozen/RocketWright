//! The text legend of a render (B3 round 12): what `rw render` drew, as
//! numbers. Agents described renders from the picture ("fins flush with the
//! aft end" when the fins overhung the tube by 25.4 mm), so every render now
//! prints, per drawn component, its station range and radial extent, plus the
//! notable relations between a part and its parent: where fins end against
//! the tube's aft end, where a rail button or lug sits along its tube, and an
//! inner part reaching past its tube's aft end. Values are SI here; the CLI
//! prints them in display units ([`human`]).

use std::collections::BTreeMap;

use rw_api::{LegendComponent, LegendRelation, LegendRelationKind, RenderLegend, View};
use rw_geom::{ComponentGeometry, Geometry};
use rw_model::{AnchorKind, ComponentType, EvaluatedModel};
use rw_units::DimKind;
use serde_json::Value;

use crate::display::{Class, Units};

/// Two stations closer than this are "flush" (0.05 mm).
pub const FLUSH_TOL: f64 = 5e-5;

/// Drops float noise (`0.24999999999999997` → `0.25`) from the JSON.
fn clean(x: f64) -> f64 {
    rw_check::canon::round_sig(x, 9)
}

fn clean_opt(x: Option<f64>) -> Option<f64> {
    x.map(clean)
}

fn is_fin(kind: ComponentType) -> bool {
    matches!(
        kind,
        ComponentType::TrapezoidalFinSet
            | ComponentType::EllipticalFinSet
            | ComponentType::FreeformFinSet
    )
}

/// Station range over all instances (instance offsets move parts along x).
fn stations(g: &ComponentGeometry) -> (f64, f64) {
    let dx = g.instances.iter().map(|i| i.offset[0]);
    let lo = dx.clone().fold(f64::INFINITY, f64::min);
    let hi = dx.fold(f64::NEG_INFINITY, f64::max);
    if lo.is_finite() {
        (g.x_fore + lo, g.x_aft + hi)
    } else {
        (g.x_fore, g.x_aft)
    }
}

/// Radial extent from the body axis.
fn radii(g: &ComponentGeometry) -> (f64, f64) {
    let max_r = |pts: &[rw_geom::ProfilePoint]| pts.iter().map(|p| p.r).fold(0.0_f64, f64::max);
    if let Some(f) = &g.fins {
        return (f.root_radius, f.root_radius + f.span);
    }
    match g.kind {
        // A rail button's profile `x` is the distance from the body axis.
        ComponentType::RailButton if !g.outer.is_empty() => {
            let xs = g.outer.iter().map(|p| p.x);
            (
                xs.clone().fold(f64::INFINITY, f64::min),
                xs.fold(f64::NEG_INFINITY, f64::max),
            )
        }
        // A lug is a tube centred at its radial distance.
        ComponentType::LaunchLug if !g.outer.is_empty() => {
            let radial = g
                .instances
                .first()
                .map_or(0.0, |i| i.offset[1].hypot(i.offset[2]));
            let r = max_r(&g.outer);
            ((radial - r).max(0.0), radial + r)
        }
        _ if !g.outer.is_empty() => {
            let inner = g.inner.iter().map(|p| p.r).fold(f64::INFINITY, f64::min);
            (if inner.is_finite() { inner } else { 0.0 }, max_r(&g.outer))
        }
        // Packed recovery and other parts without a profile: their box.
        _ => {
            let b = &g.bbox;
            let r = [b.min[1], b.max[1], b.min[2], b.max[2]]
                .iter()
                .fold(0.0_f64, |m, v| m.max(v.abs()));
            (0.0, r)
        }
    }
}

/// The legend of `view` over `model` (`internals`: inner parts are drawn).
pub fn legend(
    model: &EvaluatedModel,
    geometry: &Geometry,
    view: View,
    internals: bool,
) -> RenderLegend {
    let geoms: BTreeMap<&str, &ComponentGeometry> = geometry
        .components
        .iter()
        .map(|g| (g.id.as_str(), g))
        .collect();
    let mut out = RenderLegend::default();
    for c in &model.components {
        let Some(g) = geoms.get(c.id.as_str()) else {
            continue;
        };
        if view == View::Fin && !is_fin(g.kind) {
            continue;
        }
        if !internals && c.containment == AnchorKind::Inner {
            continue;
        }
        let (x_fore, x_aft) = stations(g);
        let (r_inner, r_outer) = radii(g);
        let count = g
            .fins
            .as_ref()
            .map_or(g.instances.len().max(1) as u32, |f| f.count);
        out.components.push(LegendComponent {
            id: c.id.clone(),
            kind: g.kind,
            placement: c.containment,
            parent: c.parent.clone(),
            count,
            x_fore: clean(x_fore),
            x_aft: clean(x_aft),
            r_inner: clean(r_inner),
            r_outer: clean(r_outer),
        });
        let Some(p) = c.parent.as_deref() else {
            continue;
        };
        let Some(pg) = geoms.get(p) else {
            continue;
        };
        let (p_fore, p_aft) = stations(pg);
        let rel = |kind, distance: Option<f64>, station: Option<f64>, fraction: Option<f64>| {
            LegendRelation {
                component: c.id.clone(),
                kind,
                other: p.to_string(),
                distance: clean_opt(distance),
                station: clean_opt(station),
                fraction: clean_opt(fraction),
            }
        };
        match c.containment {
            AnchorKind::Surface if is_fin(g.kind) => {
                let d = x_aft - p_aft;
                out.relations.push(if d.abs() <= FLUSH_TOL {
                    rel(LegendRelationKind::FlushAft, None, None, None)
                } else if d > 0.0 {
                    rel(LegendRelationKind::OverhangsAft, Some(d), None, None)
                } else {
                    rel(LegendRelationKind::ForwardOfAft, Some(-d), None, None)
                });
            }
            AnchorKind::Surface => {
                let len = p_aft - p_fore;
                let mid = 0.5 * (g.x_fore + g.x_aft);
                for i in &g.instances {
                    let x = mid + i.offset[0];
                    let f = (len > 0.0).then(|| (x - p_fore) / len);
                    out.relations
                        .push(rel(LegendRelationKind::Along, None, Some(x), f));
                }
            }
            AnchorKind::Inner if x_aft - p_aft > FLUSH_TOL => {
                out.relations.push(rel(
                    LegendRelationKind::ExtendsPastAft,
                    Some(x_aft - p_aft),
                    None,
                    None,
                ));
            }
            _ => {}
        }
    }
    out
}

fn snake(v: &Value) -> String {
    v.as_str().unwrap_or("?").to_string()
}

/// The legend's text lines in display units, from the render JSON's `legend`.
pub fn human(legend: &Value, u: &Units) -> String {
    let len = Class::Dim(DimKind::Length);
    let sym = u.symbol(len);
    let n = |v: &Value| crate::cmd::fmt_f(u.value(v.as_f64().unwrap_or(0.0), len));
    let comps = legend["components"].as_array().cloned().unwrap_or_default();
    if comps.is_empty() {
        return String::new();
    }
    let mut s = format!("\ndrawn (x: stations from the nose tip, r: radius from the axis, {sym}):");
    for c in &comps {
        let mut what = vec![snake(&c["type"])];
        let count = c["count"].as_u64().unwrap_or(1);
        if count > 1 {
            what.push(format!("x{count}"));
        }
        match (c["placement"].as_str(), c["parent"].as_str()) {
            (Some("inner"), Some(p)) => what.push(format!("inside {p}")),
            (Some("surface"), Some(p)) => what.push(format!("on {p}")),
            _ => {}
        }
        s.push_str(&format!(
            "\n  {} ({}): x {}-{} {sym}, r {}-{} {sym}",
            snake(&c["id"]),
            what.join(", "),
            n(&c["x_fore"]),
            n(&c["x_aft"]),
            n(&c["r_inner"]),
            n(&c["r_outer"]),
        ));
    }
    let rels = legend["relations"].as_array().cloned().unwrap_or_default();
    if !rels.is_empty() {
        s.push_str("\nrelations:");
    }
    for r in &rels {
        let (c, o) = (snake(&r["component"]), snake(&r["other"]));
        let d = || u.num(&r["distance"], len);
        let line = match r["kind"].as_str().unwrap_or("") {
            "overhangs_aft" => format!("{c}: aft end {} past the {o} aft end (overhang)", d()),
            "flush_aft" => format!("{c}: aft end flush with the {o} aft end"),
            "forward_of_aft" => format!("{c}: aft end {} forward of the {o} aft end", d()),
            "extends_past_aft" => format!("{c}: aft end {} past the {o} aft end", d()),
            "along" => {
                let at = u.num(&r["station"], len);
                match r["fraction"].as_f64() {
                    Some(f) => format!("{c}: at {at}, {}% along {o}", crate::cmd::fmt_f(f * 100.0)),
                    None => format!("{c}: at {at} on {o}"),
                }
            }
            k => format!("{c}: {k} {o}"),
        };
        s.push_str(&format!("\n  {line}"));
    }
    s
}
