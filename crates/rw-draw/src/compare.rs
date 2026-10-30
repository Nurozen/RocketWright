//! The compare profile (`rw render --view profile --compare <version>`,
//! R2.10 visual diff, M2.7): the new model's side profile with each
//! component coloured by its mark (changed amber, added green), unchanged
//! components dimmed, removed components drawn from the old model in red,
//! the prior outline of each changed component as a dashed amber ghost, and
//! a legend. Both models share one frame, so geometry lines up.

use std::collections::BTreeMap;

use rw_geom::{ComponentGeometry, Geometry};
use rw_model::{AnchorKind, EvalComponent, EvaluatedModel};

use crate::DrawOptions;
use crate::profile::{Frame, MARGIN_X, TOP, frame_for, half_height, length_of, revolved, title};
use crate::svg::{Anchor, Svg, ink};

/// How a component differs between the two versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Mark {
    Removed,
    Changed,
    Added,
}

/// Compare palette (sRGB hex): stroke and fill per mark, and the dimmed rest.
pub mod mark_ink {
    pub const REMOVED: &str = "#d9453a";
    pub const REMOVED_FILL: &str = "#f8d6d2";
    pub const CHANGED: &str = "#d98e1f";
    pub const CHANGED_FILL: &str = "#fbe5c2";
    pub const ADDED: &str = "#2f9e5b";
    pub const ADDED_FILL: &str = "#cfecd9";
    pub const DIM: &str = "#c3cad2";
    pub const DIM_FILL: &str = "#f2f4f6";
}

/// Stroke and fill of a mark (`None`: unchanged, dimmed).
fn style(m: Option<Mark>) -> (&'static str, &'static str) {
    match m {
        Some(Mark::Removed) => (mark_ink::REMOVED, mark_ink::REMOVED_FILL),
        Some(Mark::Changed) => (mark_ink::CHANGED, mark_ink::CHANGED_FILL),
        Some(Mark::Added) => (mark_ink::ADDED, mark_ink::ADDED_FILL),
        None => (mark_ink::DIM, mark_ink::DIM_FILL),
    }
}

/// One side of the comparison.
#[derive(Debug, Clone, Copy)]
pub struct Side<'a> {
    pub model: &'a EvaluatedModel,
    pub geometry: &'a Geometry,
    /// `Step 03`, `Rev 07`, `live`.
    pub label: &'a str,
}

/// How a part is drawn: its outline, fill, and dash.
#[derive(Clone, Copy)]
struct Pen<'s> {
    stroke: &'s str,
    fill: &'s str,
    width: f64,
    dash: Option<&'s str>,
}

/// Draws one component's side view with `pen`. Inner parts are always
/// dashed outlines; fins draw both planform copies.
fn part(svg: &mut Svg, f: &Frame, comp: Option<&EvalComponent>, g: &ComponentGeometry, pen: Pen) {
    if let Some(fins) = &g.fins {
        let rr = fins.root_radius;
        for sign in [1.0, -1.0] {
            let pts: Vec<(f64, f64)> = fins
                .planform
                .iter()
                .map(|p| f.p(p[0], sign * (rr + p[1])))
                .collect();
            svg.polygon(&pts, pen.fill, pen.stroke, pen.width, pen.dash);
        }
        return;
    }
    let containment = comp.map(|c| c.containment);
    let inner = containment == Some(AnchorKind::Inner);
    let (fill, dash) = if inner {
        ("none", Some(pen.dash.unwrap_or("4 3")))
    } else {
        (pen.fill, pen.dash)
    };
    if !g.outer.is_empty() && containment != Some(AnchorKind::Surface) {
        svg.polygon(&revolved(f, g), fill, pen.stroke, pen.width, dash);
    } else {
        let a = f.p(g.bbox.min[0], g.bbox.max[2]);
        let b = f.p(g.bbox.max[0], g.bbox.min[2]);
        svg.rect(
            a.0,
            a.1,
            b.0 - a.0,
            b.1 - a.1,
            fill,
            pen.stroke,
            pen.width,
            dash,
        );
    }
}

/// Draw order: fins, axial bodies, surface parts, then inner parts (so the
/// dashed internals stay visible over the bodies).
fn layer(comp: Option<&EvalComponent>, g: &ComponentGeometry) -> u8 {
    if g.fins.is_some() {
        return 0;
    }
    match comp.map(|c| c.containment) {
        Some(AnchorKind::Inner) => 3,
        Some(AnchorKind::Surface) => 2,
        _ => 1,
    }
}

fn legend(svg: &mut Svg, x0: f64, y: f64, counts: &BTreeMap<Mark, usize>) {
    let mut x = x0;
    for (m, name) in [
        (Mark::Removed, "Removed"),
        (Mark::Changed, "Changed"),
        (Mark::Added, "Added"),
    ] {
        let (stroke, fill) = style(Some(m));
        svg.rect(x, y - 10.0, 12.0, 12.0, fill, stroke, 1.5, None);
        let n = counts.get(&m).copied().unwrap_or(0);
        let label = format!("{name} {n}");
        svg.text((x + 18.0, y), &label, 12.0, Anchor::Start, ink::DIM, 0.0);
        x += 30.0 + 7.0 * label.len() as f64;
    }
    let (stroke, fill) = style(None);
    svg.rect(x, y - 10.0, 12.0, 12.0, fill, stroke, 1.0, None);
    svg.text(
        (x + 18.0, y),
        "Unchanged",
        12.0,
        Anchor::Start,
        ink::DIM,
        0.0,
    );
}

/// Draws `new` against `old` with the per-component `marks` (id → mark;
/// absent = unchanged). Removed ids are looked up in `old`.
/// cite: n/a 2D drawing of computed geometry, no physics
pub fn draw_compare(
    old: Side<'_>,
    new: Side<'_>,
    marks: &BTreeMap<String, Mark>,
    opts: &DrawOptions,
) -> String {
    let len = length_of(new.model, new.geometry).max(length_of(old.model, old.geometry));
    let half = half_height(new.geometry).max(half_height(old.geometry));
    let f = frame_for(len, half, opts.width, TOP);
    let mut svg = Svg::new(opts.width, f.bottom() + 76.0);
    title(
        &mut svg,
        new.model,
        "compare",
        Some(format!("{} → {}", old.label, new.label)),
    );
    let (l0, l1) = (f.p(0.0, 0.0), f.p(len, 0.0));
    svg.line(
        (l0.0 - 12.0, l0.1),
        (l1.0 + 12.0, l1.1),
        ink::INNER,
        0.75,
        Some("12 3 2 3"),
    );
    let by_id = |m: &'_ EvaluatedModel| -> BTreeMap<String, EvalComponent> {
        m.components
            .iter()
            .map(|c| (c.id.clone(), c.clone()))
            .collect()
    };
    let (old_c, new_c) = (by_id(old.model), by_id(new.model));
    let old_g: BTreeMap<&str, &ComponentGeometry> = old
        .geometry
        .components
        .iter()
        .map(|g| (g.id.as_str(), g))
        .collect();

    // New model: unchanged (dim) first, then marked, each in layer order.
    let mut items: Vec<(u8, u8, usize, &ComponentGeometry)> = new
        .geometry
        .components
        .iter()
        .enumerate()
        .map(|(i, g)| {
            let marked = u8::from(marks.contains_key(&g.id));
            (marked, layer(new_c.get(&g.id), g), i, g)
        })
        .collect();
    items.sort_by_key(|(m, l, i, _)| (*m, *l, *i));
    for (_, _, _, g) in &items {
        let m = marks.get(&g.id).copied().filter(|m| *m != Mark::Removed);
        let (stroke, fill) = style(m);
        let pen = Pen {
            stroke,
            fill,
            width: if m.is_some() { 1.75 } else { 1.0 },
            dash: None,
        };
        svg.comment(&format!("{} {:?}", g.id, m));
        part(&mut svg, &f, new_c.get(&g.id), g, pen);
    }
    // Ghosts of the prior outline of changed parts, then removed parts.
    for g in &old.geometry.components {
        if marks.get(&g.id) == Some(&Mark::Changed) {
            let pen = Pen {
                stroke: mark_ink::CHANGED,
                fill: "none",
                width: 1.0,
                dash: Some("5 3"),
            };
            part(&mut svg, &f, old_c.get(&g.id), g, pen);
        }
    }
    for (id, m) in marks {
        if *m != Mark::Removed {
            continue;
        }
        if let Some(g) = old_g.get(id.as_str()) {
            let (stroke, fill) = style(Some(Mark::Removed));
            let pen = Pen {
                stroke,
                fill,
                width: 1.75,
                dash: None,
            };
            svg.comment(&format!("{id} Removed"));
            part(&mut svg, &f, old_c.get(id), g, pen);
        }
    }
    let mut counts: BTreeMap<Mark, usize> = BTreeMap::new();
    for m in marks.values() {
        *counts.entry(*m).or_default() += 1;
    }
    legend(&mut svg, MARGIN_X - 40.0, f.bottom() + 46.0, &counts);
    svg.finish()
}
