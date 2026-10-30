//! Fin planform sheet: one panel per fin set, root on the body line, with
//! root chord, tip chord, span, and sweep dimensions and the tab (dashed).

use rw_geom::{FinGeometry, Geometry};
use rw_model::EvaluatedModel;

use crate::DrawOptions;
use crate::svg::{Anchor, Svg, ink, mm};

const MARGIN: f64 = 90.0;
const PANEL_H: f64 = 260.0;
const HEAD: f64 = 50.0;

fn cross_section(f: &FinGeometry) -> String {
    format!("{:?}", f.cross_section).to_lowercase()
}

pub(crate) fn fins(model: &EvaluatedModel, g: &Geometry, opts: &DrawOptions) -> String {
    let sets: Vec<(&str, &FinGeometry)> = g
        .components
        .iter()
        .filter_map(|c| c.fins.as_ref().map(|f| (c.id.as_str(), f)))
        .collect();
    let h = HEAD + PANEL_H * sets.len().max(1) as f64;
    let mut svg = Svg::new(opts.width, h);
    svg.text(
        (MARGIN - 50.0, 28.0),
        &format!("{} · fins", model.name),
        15.0,
        Anchor::Start,
        ink::LINE,
        0.0,
    );
    if sets.is_empty() {
        svg.text(
            (0.5 * opts.width, HEAD + 0.5 * PANEL_H),
            "no fin sets",
            14.0,
            Anchor::Middle,
            ink::DIM,
            0.0,
        );
        return svg.finish();
    }
    for (i, (id, f)) in sets.iter().enumerate() {
        panel(&mut svg, id, f, HEAD + PANEL_H * i as f64, opts.width);
    }
    svg.finish()
}

fn panel(svg: &mut Svg, id: &str, f: &FinGeometry, top: f64, width: f64) {
    let pts = &f.planform;
    if pts.is_empty() {
        return;
    }
    let tab = f.tab.as_deref().unwrap_or(&[]);
    let x_min = pts
        .iter()
        .chain(tab)
        .map(|p| p[0])
        .fold(f64::INFINITY, f64::min);
    let x_max = pts
        .iter()
        .chain(tab)
        .map(|p| p[0])
        .fold(f64::NEG_INFINITY, f64::max);
    let y_max = pts.iter().map(|p| p[1]).fold(0.0, f64::max);
    let y_min = tab.iter().map(|p| p[1]).fold(0.0, f64::min);
    let (w_m, h_m) = ((x_max - x_min).max(1e-6), (y_max - y_min).max(1e-6));
    let avail_w = width - 2.0 * MARGIN - 120.0;
    let avail_h = PANEL_H - 110.0;
    let s = (avail_w / w_m).min(avail_h / h_m);
    let ox = MARGIN + 0.5 * (avail_w - s * w_m);
    let base = top + 50.0 + s * y_max;
    let p = |x: f64, y: f64| (ox + s * (x - x_min), base - s * y);

    svg.text(
        (MARGIN - 50.0, top + 18.0),
        &format!(
            "{id} · {} fins · {} · t = {} mm",
            f.count,
            cross_section(f),
            mm(f.thickness)
        ),
        13.0,
        Anchor::Start,
        ink::LINE,
        0.0,
    );
    // Body surface at the root.
    let (b0, b1) = (p(x_min, 0.0), p(x_max, 0.0));
    svg.line(
        (b0.0 - 30.0, b0.1),
        (b1.0 + 30.0, b1.1),
        ink::LINE,
        2.0,
        None,
    );
    let poly: Vec<(f64, f64)> = pts.iter().map(|q| p(q[0], q[1])).collect();
    svg.polygon(&poly, ink::FIN, ink::LINE, 1.5, None);
    if !tab.is_empty() {
        let t: Vec<(f64, f64)> = tab.iter().map(|q| p(q[0], q[1])).collect();
        svg.polygon(&t, "none", ink::INNER, 1.0, Some("4 3"));
    }

    // Root chord: the planform's extent on y = 0.
    let root: Vec<f64> = pts
        .iter()
        .filter(|q| q[1].abs() < 1e-9)
        .map(|q| q[0])
        .collect();
    let r_le = root.iter().copied().fold(f64::INFINITY, f64::min);
    let r_te = root.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let y_dim = base + s * (-y_min) + 26.0;
    if r_le.is_finite() && r_te > r_le {
        let (a, b) = (p(r_le, 0.0), p(r_te, 0.0));
        svg.line(a, (a.0, y_dim + 6.0), ink::DIM, 0.5, None);
        svg.line(b, (b.0, y_dim + 6.0), ink::DIM, 0.5, None);
        svg.dimension(
            (a.0, y_dim),
            (b.0, y_dim),
            &format!("root {} mm", mm(f.root_chord)),
            -8.0,
        );
    }
    // Tip chord and sweep along the tip.
    let tip: Vec<f64> = pts
        .iter()
        .filter(|q| (q[1] - y_max).abs() < 1e-9)
        .map(|q| q[0])
        .collect();
    let t_le = tip.iter().copied().fold(f64::INFINITY, f64::min);
    let t_te = tip.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let y_tip = p(0.0, y_max).1;
    if t_le.is_finite() && t_te - t_le > 1e-9 {
        let (a, b) = (p(t_le, y_max), p(t_te, y_max));
        svg.line(a, (a.0, y_tip - 24.0), ink::DIM, 0.5, None);
        svg.line(b, (b.0, y_tip - 24.0), ink::DIM, 0.5, None);
        svg.dimension(
            (a.0, y_tip - 18.0),
            (b.0, y_tip - 18.0),
            &format!("tip {} mm", mm(f.tip_chord)),
            8.0,
        );
    }
    if r_le.is_finite() && t_le.is_finite() && (t_le - r_le).abs() > 1e-9 {
        let (a, b) = (p(r_le, y_max), p(t_le, y_max));
        svg.line(
            p(r_le, 0.0),
            (a.0, y_tip - 44.0),
            ink::DIM,
            0.5,
            Some("2 2"),
        );
        svg.dimension(
            (a.0, y_tip - 38.0),
            (b.0, y_tip - 38.0),
            &format!("sweep {} mm", mm(t_le - r_le)),
            8.0,
        );
    }
    // Span at the right.
    let x_span = ox + s * w_m + 40.0;
    let (sb, st) = ((x_span, base), (x_span, y_tip));
    let x_tip = if t_te.is_finite() { t_te } else { x_max };
    svg.line(p(x_tip, y_max), (x_span + 6.0, y_tip), ink::DIM, 0.5, None);
    svg.line(b1, (x_span + 6.0, base), ink::DIM, 0.5, None);
    svg.dimension(sb, st, &format!("span {} mm", mm(f.span)), -10.0);
}
