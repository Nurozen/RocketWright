//! Side-view drawings: profile, stations, and anchors. Station x runs right
//! from the nose tip; +Z (body frame up) is up the page. Fins are drawn as
//! their planform above and below the body (schematic, whatever the count).

use std::collections::BTreeMap;

use rw_geom::{ComponentGeometry, Geometry};
use rw_model::{AnchorKind, ComponentType, EvalComponent, EvaluatedModel};

use crate::svg::{Anchor, Svg, ink, mm};
use crate::{DrawOptions, Markers};

pub(crate) const MARGIN_X: f64 = 80.0;
pub(crate) const TOP: f64 = 70.0;
/// Room above the body for the slanted anchor labels.
const ANCHOR_TOP: f64 = 190.0;

/// Maps body-frame `(x, z)` to page px.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Frame {
    s: f64,
    x0: f64,
    y0: f64,
    /// Half-height of the drawing in metres (largest radius incl. fins).
    pub half: f64,
}

impl Frame {
    pub fn p(&self, x: f64, z: f64) -> (f64, f64) {
        (self.x0 + self.s * x, self.y0 - self.s * z)
    }
    pub fn px(&self, x: f64) -> f64 {
        self.x0 + self.s * x
    }
    pub fn top(&self) -> f64 {
        self.y0 - self.s * self.half
    }
    pub fn bottom(&self) -> f64 {
        self.y0 + self.s * self.half
    }
}

pub(crate) fn length_of(model: &EvaluatedModel, g: &Geometry) -> f64 {
    let l = if g.length > 0.0 {
        g.length
    } else {
        model.reference.length
    };
    if l > 0.0 { l } else { 1.0 }
}

/// Largest radius of the drawing: body, fin tips, external parts.
pub(crate) fn half_height(g: &Geometry) -> f64 {
    let mut h = 0.5 * g.max_diameter;
    for c in &g.components {
        if let Some(f) = &c.fins {
            h = h.max(f.root_radius + f.span);
        }
        for p in &c.outer {
            h = h.max(p.r);
        }
        h = h.max(c.bbox.max[2]).max(-c.bbox.min[2]);
    }
    if h > 0.0 { h } else { 0.05 }
}

fn frame(model: &EvaluatedModel, g: &Geometry, width: f64, top: f64) -> Frame {
    frame_for(length_of(model, g), half_height(g), width, top)
}

/// The frame of a drawing `len` long and `half` high about the axis.
pub(crate) fn frame_for(len: f64, half: f64, width: f64, top: f64) -> Frame {
    let s = (width - 2.0 * MARGIN_X).max(100.0) / len;
    Frame {
        s,
        x0: MARGIN_X,
        y0: top + s * half,
        half,
    }
}

fn by_id(model: &EvaluatedModel) -> BTreeMap<&str, &EvalComponent> {
    model
        .components
        .iter()
        .map(|c| (c.id.as_str(), c))
        .collect()
}

fn is_inner(c: Option<&&EvalComponent>) -> bool {
    c.is_some_and(|c| c.containment == AnchorKind::Inner)
}

/// Upper outline and mirrored lower outline of a solid of revolution.
pub(crate) fn revolved(f: &Frame, g: &ComponentGeometry) -> Vec<(f64, f64)> {
    let mut pts: Vec<(f64, f64)> = g.outer.iter().map(|p| f.p(p.x, p.r)).collect();
    pts.extend(g.outer.iter().rev().map(|p| f.p(p.x, -p.r)));
    pts
}

/// Body chain, external parts, fins, and (optionally) dashed internals.
fn body(
    svg: &mut Svg,
    f: &Frame,
    model: &EvaluatedModel,
    g: &Geometry,
    internals: bool,
    detail: bool,
) {
    let comps = by_id(model);
    let (l0, l1) = (f.p(0.0, 0.0), f.p(length_of(model, g), 0.0));
    svg.line(
        (l0.0 - 12.0, l0.1),
        (l1.0 + 12.0, l1.1),
        ink::INNER,
        0.75,
        Some("12 3 2 3"),
    );
    for c in &g.components {
        if let Some(fins) = &c.fins {
            let rr = fins.root_radius;
            let up: Vec<(f64, f64)> = fins.planform.iter().map(|p| f.p(p[0], rr + p[1])).collect();
            let down: Vec<(f64, f64)> = fins
                .planform
                .iter()
                .map(|p| f.p(p[0], -(rr + p[1])))
                .collect();
            svg.polygon(&up, ink::FIN, ink::LINE, 1.25, None);
            svg.polygon(&down, ink::FIN, ink::LINE, 1.25, None);
            if detail && let Some(tab) = &fins.tab {
                let t: Vec<(f64, f64)> = tab.iter().map(|p| f.p(p[0], rr + p[1])).collect();
                svg.polygon(&t, "none", ink::INNER, 1.0, Some("4 3"));
            }
        }
    }
    for c in &g.components {
        let comp = comps.get(c.id.as_str());
        if c.fins.is_some() || is_inner(comp) || c.outer.is_empty() {
            continue;
        }
        let axial = comp.is_some_and(|m| m.containment == AnchorKind::Axial);
        if axial {
            svg.polygon(&revolved(f, c), ink::BODY, ink::LINE, 1.5, None);
        }
    }
    // Rail buttons and launch lugs on the outline at their radial position;
    // other external non-axial parts (tube fins, pods) as their side bounding box.
    for c in &g.components {
        let comp = comps.get(c.id.as_str());
        let external = comp.is_some_and(|m| m.containment == AnchorKind::Surface);
        if c.fins.is_some() || !external {
            continue;
        }
        if let Some(shapes) = surface_part(f, c) {
            for s in &shapes {
                svg.polygon(s, ink::BODY, ink::LINE, 1.0, None);
            }
            continue;
        }
        let a = f.p(c.bbox.min[0], c.bbox.max[2]);
        let b = f.p(c.bbox.max[0], c.bbox.min[2]);
        svg.rect(
            a.0,
            a.1,
            b.0 - a.0,
            b.1 - a.1,
            ink::BODY,
            ink::LINE,
            1.0,
            None,
        );
    }
    if internals {
        for c in &g.components {
            if !is_inner(comps.get(c.id.as_str())) {
                continue;
            }
            if c.outer.is_empty() {
                let a = f.p(c.bbox.min[0], c.bbox.max[2]);
                let b = f.p(c.bbox.max[0], c.bbox.min[2]);
                svg.rect(
                    a.0,
                    a.1,
                    b.0 - a.0,
                    b.1 - a.1,
                    "none",
                    ink::INNER,
                    1.0,
                    Some("4 3"),
                );
            } else {
                svg.polygon(&revolved(f, c), "none", ink::INNER, 1.0, Some("4 3"));
            }
        }
    }
}

/// Side-view outlines of a rail button or launch lug, one per instance,
/// rotated about the body axis into the drawing plane: a part whose roll puts
/// it below the axis (sin roll < 0) is drawn on the lower outline, every
/// other one on the upper. A rail button is its spool silhouette standing on
/// the surface; a lug is its tube, centred at its radial distance. `None` for
/// other kinds.
fn surface_part(f: &Frame, c: &ComponentGeometry) -> Option<Vec<Vec<(f64, f64)>>> {
    if c.outer.is_empty() {
        return None;
    }
    let side = |roll: f64| if roll.sin() < -1e-9 { -1.0 } else { 1.0 };
    match c.kind {
        ComponentType::RailButton => {
            // Profile `x` is the distance from the body axis, `r` the spool radius.
            let xc = 0.5 * (c.x_fore + c.x_aft);
            Some(
                c.instances
                    .iter()
                    .map(|i| {
                        let (dx, s) = (i.offset[0], side(i.roll));
                        let mut pts: Vec<(f64, f64)> = c
                            .outer
                            .iter()
                            .map(|p| f.p(xc + dx - p.r, s * p.x))
                            .collect();
                        pts.extend(c.outer.iter().rev().map(|p| f.p(xc + dx + p.r, s * p.x)));
                        pts
                    })
                    .collect(),
            )
        }
        ComponentType::LaunchLug => Some(
            c.instances
                .iter()
                .map(|i| {
                    let (dx, s) = (i.offset[0], side(i.roll));
                    let radial = i.offset[1].hypot(i.offset[2]);
                    let mut pts: Vec<(f64, f64)> = c
                        .outer
                        .iter()
                        .map(|p| f.p(p.x + dx, s * (radial + p.r)))
                        .collect();
                    pts.extend(
                        c.outer
                            .iter()
                            .rev()
                            .map(|p| f.p(p.x + dx, s * (radial - p.r))),
                    );
                    pts
                })
                .collect(),
        ),
        _ => None,
    }
}

pub(crate) fn title(svg: &mut Svg, model: &EvaluatedModel, what: &str, extra: Option<String>) {
    let mut t = format!("{} · {what}", model.name);
    if let Some(c) = &model.config {
        t = format!("{t} · {c}");
    }
    if let Some(e) = extra {
        t = format!("{t} · {e}");
    }
    svg.text(
        (MARGIN_X - 40.0, 28.0),
        &t,
        15.0,
        Anchor::Start,
        ink::LINE,
        0.0,
    );
}

/// Overall length below, max diameter at the nose, fin span at the tail.
fn overall_dims(svg: &mut Svg, f: &Frame, model: &EvaluatedModel, g: &Geometry) {
    let len = length_of(model, g);
    let y = f.bottom() + 34.0;
    let (a, b) = ((f.px(0.0), y), (f.px(len), y));
    svg.line((a.0, f.y0), (a.0, y + 6.0), ink::DIM, 0.5, None);
    svg.line((b.0, f.y0), (b.0, y + 6.0), ink::DIM, 0.5, None);
    svg.dimension(a, b, &format!("{} mm", mm(len)), -10.0);

    let r = 0.5 * g.max_diameter;
    if r > 0.0 {
        let x_max = g
            .components
            .iter()
            .flat_map(|c| c.outer.iter())
            .filter(|p| (p.r - r).abs() < 1e-9)
            .map(|p| p.x)
            .fold(f64::INFINITY, f64::min);
        let x_max = if x_max.is_finite() { x_max } else { 0.0 };
        let x = f.px(0.0) - 36.0;
        let (t, bt) = (f.p(x_max, r), f.p(x_max, -r));
        svg.line((t.0, t.1), (x - 6.0, t.1), ink::DIM, 0.5, None);
        svg.line((bt.0, bt.1), (x - 6.0, bt.1), ink::DIM, 0.5, None);
        svg.dimension(
            (x, t.1),
            (x, bt.1),
            &format!("Ø{} mm", mm(g.max_diameter)),
            10.0,
        );
    }
    let tip = g
        .components
        .iter()
        .filter_map(|c| c.fins.as_ref())
        .map(|fg| {
            let x_te = fg
                .planform
                .iter()
                .map(|p| p[0])
                .fold(f64::NEG_INFINITY, f64::max);
            (fg.root_radius + fg.span, x_te)
        })
        .reduce(|a, b| if b.0 > a.0 { b } else { a });
    if let Some((rt, x_te)) = tip {
        let x = f.px(len) + 36.0;
        let (t, bt) = (f.p(x_te, rt), f.p(x_te, -rt));
        svg.line(t, (x + 6.0, t.1), ink::DIM, 0.5, None);
        svg.line(bt, (x + 6.0, bt.1), ink::DIM, 0.5, None);
        svg.dimension(
            (x, t.1),
            (x, bt.1),
            &format!("{} mm span", mm(2.0 * rt)),
            -10.0,
        );
    }
}

/// CG: filled circle. CP: open circle with a cross. Labels sit above the
/// body on leaders, CG to the left of its leader and CP to the right (or the
/// reverse when the CP is forward of the CG).
fn markers(svg: &mut Svg, f: &Frame, m: &Markers) {
    let y_label = f.top() - 14.0;
    let cp_aft = match (m.cg, m.cp) {
        (Some(g), Some(p)) => p >= g,
        _ => true,
    };
    let r = 7.0;
    if let Some(cp) = m.cp {
        let c = (f.px(cp), f.y0);
        svg.line(
            (c.0, c.1 - r),
            (c.0, y_label + 4.0),
            ink::CP,
            0.75,
            Some("2 2"),
        );
        svg.circle(c, r, ink::PAPER, ink::CP, 2.0);
        let d = r * std::f64::consts::FRAC_1_SQRT_2;
        svg.line((c.0 - d, c.1 - d), (c.0 + d, c.1 + d), ink::CP, 1.5, None);
        svg.line((c.0 - d, c.1 + d), (c.0 + d, c.1 - d), ink::CP, 1.5, None);
        let (x, a) = if cp_aft {
            (c.0 + 4.0, Anchor::Start)
        } else {
            (c.0 - 4.0, Anchor::End)
        };
        svg.text(
            (x, y_label),
            &format!("CP {} mm", mm(cp)),
            12.0,
            a,
            ink::CP,
            0.0,
        );
    }
    if let Some(cg) = m.cg {
        let c = (f.px(cg), f.y0);
        svg.line(
            (c.0, c.1 - r),
            (c.0, y_label + 4.0),
            ink::CG,
            0.75,
            Some("2 2"),
        );
        svg.circle(c, r, ink::CG, ink::PAPER, 1.5);
        let (x, a) = if cp_aft {
            (c.0 - 4.0, Anchor::End)
        } else {
            (c.0 + 4.0, Anchor::Start)
        };
        svg.text(
            (x, y_label),
            &format!("CG {} mm", mm(cg)),
            12.0,
            a,
            ink::CG,
            0.0,
        );
    }
}

pub(crate) fn profile(
    model: &EvaluatedModel,
    g: &Geometry,
    m: &Markers,
    opts: &DrawOptions,
) -> String {
    let f = frame(model, g, opts.width, TOP);
    let mut svg = Svg::new(opts.width, f.bottom() + 70.0);
    title(
        &mut svg,
        model,
        "profile",
        m.stability.map(|s| format!("stability {s:.2} cal")),
    );
    body(&mut svg, &f, model, g, opts.internals, true);
    overall_dims(&mut svg, &f, model, g);
    markers(&mut svg, &f, m);
    svg.finish()
}

pub(crate) fn stations(model: &EvaluatedModel, g: &Geometry, opts: &DrawOptions) -> String {
    let f = frame(model, g, opts.width, TOP);
    let mut svg = Svg::new(opts.width, f.bottom() + 110.0);
    title(&mut svg, model, "stations", None);
    body(&mut svg, &f, model, g, true, false);
    // Unique stations (0.1 mm), each with the components that start or end there.
    let mut st: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for c in &model.components {
        for (x, end) in [(c.x_fore, "fore"), (c.x_aft, "aft")] {
            st.entry((x * 1e4).round() as i64)
                .or_default()
                .push(format!("{}.{end}", c.id));
        }
    }
    let xs: Vec<f64> = st.keys().map(|k| f.px(*k as f64 * 1e-4)).collect();
    let labels = spread(&xs, 14.0, 12.0, opts.width - 12.0);
    let y = f.bottom() + 12.0;
    for (((k, names), x), lx) in st.iter().zip(&xs).zip(&labels) {
        let station = *k as f64 * 1e-4;
        svg.line((*x, f.top() - 6.0), (*x, y), ink::DIM, 0.5, Some("1 3"));
        svg.line((*x, y), (*lx, y + 12.0), ink::DIM, 0.5, None);
        svg.text(
            (lx + 4.0, y + 16.0),
            &format!("{} mm", mm(station)),
            11.0,
            Anchor::End,
            ink::DIM,
            -90.0,
        );
        svg.comment(&format!("{}: {}", mm(station), names.join(", ")));
    }
    // Component names centred over the axial chain.
    for c in model
        .components
        .iter()
        .filter(|c| c.containment == AnchorKind::Axial)
    {
        let x = f.px(0.5 * (c.x_fore + c.x_aft));
        svg.text(
            (x, f.top() - 12.0),
            &c.id,
            12.0,
            Anchor::Middle,
            ink::LINE,
            0.0,
        );
    }
    svg.finish()
}

/// Label positions near `xs` (ascending) at least `gap` apart within
/// `[lo, hi]`: a forward push, then a backward pull from the right edge.
fn spread(xs: &[f64], gap: f64, lo: f64, hi: f64) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::with_capacity(xs.len());
    for &x in xs {
        let prev = out.last().map_or(lo, |p| p + gap);
        out.push(x.max(prev));
    }
    let mut next = hi + gap;
    for v in out.iter_mut().rev() {
        *v = v.min(next - gap);
        next = *v;
    }
    out
}

/// Every named anchor as a diamond, labelled on a leader to a row above the
/// drawing (one label per anchor, spread so none overlap).
pub(crate) fn anchors(model: &EvaluatedModel, g: &Geometry, opts: &DrawOptions) -> String {
    let f = frame(model, g, opts.width, ANCHOR_TOP);
    let mut svg = Svg::new(opts.width, f.bottom() + 40.0);
    title(&mut svg, model, "anchors", None);
    body(&mut svg, &f, model, g, true, false);
    let mut all: Vec<(f64, f64, String)> = model
        .components
        .iter()
        .flat_map(|c| {
            c.anchors
                .iter()
                .map(move |a| (a.x, a.r, format!("{}.{}", c.id, a.name)))
        })
        .collect();
    all.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.2.cmp(&b.2)));
    let xs: Vec<f64> = all.iter().map(|a| f.px(a.0)).collect();
    let labels = spread(&xs, 11.0, 12.0, opts.width - 12.0);
    let row = f.top() - 24.0;
    for ((x, r, _), lx) in all.iter().zip(&labels) {
        let p = f.p(*x, *r);
        svg.polyline(&[p, (p.0, row + 10.0), (*lx, row)], ink::ANCHOR, 0.4, None);
    }
    for ((x, r, name), lx) in all.iter().zip(&labels) {
        let p = f.p(*x, *r);
        let d = 3.5;
        svg.polygon(
            &[
                (p.0, p.1 - d),
                (p.0 + d, p.1),
                (p.0, p.1 + d),
                (p.0 - d, p.1),
            ],
            ink::ANCHOR,
            ink::PAPER,
            0.75,
            None,
        );
        svg.text(
            (lx + 3.0, row - 3.0),
            name,
            9.0,
            Anchor::Start,
            ink::ANCHOR,
            -90.0,
        );
    }
    svg.finish()
}
