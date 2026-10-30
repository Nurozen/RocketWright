//! Planar fin sets: trapezoidal (M1), elliptical and freeform (planform
//! checks complete in M2.1). Shared: count, thickness, cant, fillet, tab.

use rw_units::DimKind;

use super::Check;
use crate::diag;
use crate::types::{EvalComponent, EvalFinCommon, EvalShape};

const L: DimKind = DimKind::Length;

/// Fins per set.
pub const MAX_FINS: u32 = 8;

fn common(chk: &mut Check, f: &EvalFinCommon, root_chord: f64) {
    chk.count("count", f.count, 1, MAX_FINS);
    chk.positive("thickness", f.thickness, L);
    chk.non_negative("fillet_radius", f.fillet_radius, L);
    if f.cant.abs() >= std::f64::consts::FRAC_PI_2 {
        chk.push(
            diag::E_GEOMETRY,
            "cant",
            format!("`{}.cant` must be between -90 deg and 90 deg", chk.id),
            "use a small cant angle, e.g. \"1 deg\"",
        );
    }
    if let Some(t) = &f.tab {
        chk.non_negative("tab/height", t.height, L);
        chk.non_negative("tab/offset", t.offset, L);
        if chk.non_negative("tab/length", t.length, L) && root_chord > 0.0 {
            chk.at_most(
                "tab/length",
                t.offset + t.length,
                root_chord,
                "the root chord (tab offset + length)",
                L,
            );
        }
    }
}

pub(crate) fn check(chk: &mut Check, e: &EvalComponent) {
    match &e.shape {
        EvalShape::TrapezoidalFinSet {
            fins,
            root_chord,
            tip_chord,
            span,
            sweep: _,
        } => {
            chk.positive("root_chord", *root_chord, L);
            chk.non_negative("tip_chord", *tip_chord, L);
            chk.positive("span", *span, L);
            common(chk, fins, *root_chord);
        }
        EvalShape::EllipticalFinSet {
            fins,
            root_chord,
            span,
        } => {
            chk.positive("root_chord", *root_chord, L);
            chk.positive("span", *span, L);
            common(chk, fins, *root_chord);
        }
        EvalShape::FreeformFinSet { fins, points } => {
            if points.len() < 3 {
                chk.push(
                    diag::E_GEOMETRY,
                    "points",
                    format!("`{}.points` needs at least 3 points", chk.id),
                    "list the planform from the root leading edge around to the root trailing edge",
                );
            }
            for (i, p) in points.iter().enumerate() {
                chk.non_negative(&format!("points/{i}/1"), p[1], L);
            }
            freeform_outline(chk, points);
            let root = points.iter().map(|p| p[0]).fold(0.0, f64::max);
            common(chk, fins, root);
        }
        _ => {}
    }
}

/// Root tolerance: points within this height of y = 0 count as on the root.
const ROOT_TOL: f64 = 1e-9;

/// Freeform outline rules: root first and last on y = 0, a simple polygon
/// (no self-crossing, which the ear-clipping mesher cannot handle), and a
/// nonzero area.
fn freeform_outline(chk: &mut Check, points: &[[f64; 2]]) {
    let (poly, orig) = dedup_outline(points);
    if poly.len() < 3 {
        if points.len() >= 3 {
            chk.push(
                diag::E_GEOMETRY,
                "points",
                format!("`{}.points` has fewer than 3 distinct points", chk.id),
                "remove the repeated points so the outline has at least 3 corners",
            );
        }
        return;
    }
    let last = orig[orig.len() - 1];
    for (i, y) in [(0, poly[0][1]), (last, poly[poly.len() - 1][1])] {
        if y.abs() > ROOT_TOL {
            chk.push(
                diag::E_GEOMETRY,
                &format!("points/{i}/1"),
                format!(
                    "`{}.points` must start and end on the root (y = 0); point {i} is at y = {}",
                    chk.id,
                    super::show(y, L)
                ),
                "start at the root leading edge [\"0 mm\", \"0 mm\"] and end at the root trailing edge [<root chord>, \"0 mm\"]",
            );
        }
    }
    if let Some((i, j)) = first_crossing(&poly) {
        chk.push(
            diag::E_GEOMETRY,
            "points",
            format!(
                "`{}.points` crosses itself: edges {} and {} intersect (edge k runs from point k to the next point)",
                chk.id, orig[i], orig[j]
            ),
            "reorder the points so the outline runs once around the fin without crossing (root LE, up the leading edge, along the tip, down the trailing edge to the root TE)",
        );
    } else if polygon_area(&poly).abs() <= 1e-12 * bbox_scale(&poly).powi(2) {
        chk.push(
            diag::E_GEOMETRY,
            "points",
            format!("`{}.points` encloses no area", chk.id),
            "give the outline some span: at least one point above the root (y > 0)",
        );
    }
}

/// Drops consecutive duplicate points and a closing point equal to the first.
/// Returns the outline and, per kept point, its index in `points`.
fn dedup_outline(points: &[[f64; 2]]) -> (Vec<[f64; 2]>, Vec<usize>) {
    let mut poly: Vec<[f64; 2]> = Vec::with_capacity(points.len());
    let mut orig = Vec::with_capacity(points.len());
    for (i, p) in points.iter().enumerate() {
        if poly.last().is_some_and(|q| same(*q, *p)) {
            continue;
        }
        poly.push(*p);
        orig.push(i);
    }
    while poly.len() > 1 && same(poly[0], poly[poly.len() - 1]) {
        poly.pop();
        orig.pop();
    }
    (poly, orig)
}

fn same(a: [f64; 2], b: [f64; 2]) -> bool {
    (a[0] - b[0]).abs() <= ROOT_TOL && (a[1] - b[1]).abs() <= ROOT_TOL
}

fn bbox_scale(poly: &[[f64; 2]]) -> f64 {
    let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for p in poly {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    (hi[0] - lo[0]).max(hi[1] - lo[1]).max(0.0)
}

/// Signed shoelace area of a closed polygon (positive when CCW).
/// cite: n/a pure geometry (shoelace formula)
pub fn polygon_area(poly: &[[f64; 2]]) -> f64 {
    let n = poly.len();
    if n < 3 {
        return 0.0;
    }
    0.5 * (0..n)
        .map(|i| {
            let (a, b) = (poly[i], poly[(i + 1) % n]);
            a[0] * b[1] - b[0] * a[1]
        })
        .sum::<f64>()
}

/// Orientation of `c` relative to the directed line a→b (z of (b−a)×(c−a)).
fn orient(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// True when `c`, known collinear with a–b, lies within their bounding box.
fn on_segment(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> bool {
    c[0] >= a[0].min(b[0])
        && c[0] <= a[0].max(b[0])
        && c[1] >= a[1].min(b[1])
        && c[1] <= a[1].max(b[1])
}

/// True when the closed segments p1–p2 and q1–q2 share any point (crossing,
/// touching, or collinear overlap).
/// cite: n/a pure geometry (segment intersection by orientation tests)
pub fn segments_intersect(p1: [f64; 2], p2: [f64; 2], q1: [f64; 2], q2: [f64; 2]) -> bool {
    let d1 = orient(q1, q2, p1);
    let d2 = orient(q1, q2, p2);
    let d3 = orient(p1, p2, q1);
    let d4 = orient(p1, p2, q2);
    if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0))
        && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
    {
        return true;
    }
    (d1 == 0.0 && on_segment(q1, q2, p1))
        || (d2 == 0.0 && on_segment(q1, q2, p2))
        || (d3 == 0.0 && on_segment(p1, p2, q1))
        || (d4 == 0.0 && on_segment(p1, p2, q2))
}

/// First pair of edges `(i, j)`, `i < j`, of the closed polygon `poly` that
/// makes it non-simple: two non-adjacent edges that touch or cross, or two
/// adjacent edges that fold back over each other. Edge `k` runs from
/// `poly[k]` to `poly[(k + 1) % n]`. Consecutive points must be distinct.
/// cite: n/a pure geometry (simple-polygon test)
pub fn first_crossing(poly: &[[f64; 2]]) -> Option<(usize, usize)> {
    let n = poly.len();
    if n < 3 {
        return None;
    }
    let edge = |k: usize| (poly[k], poly[(k + 1) % n]);
    for i in 0..n {
        for j in (i + 1)..n {
            let (a, b) = edge(i);
            let (c, d) = edge(j);
            let adjacent = j == i + 1 || (i == 0 && j == n - 1);
            if adjacent {
                // Shared vertex v; they overlap beyond it only when collinear
                // and pointing the same way out of v.
                let (v, p, q) = if j == i + 1 { (b, a, d) } else { (a, b, c) };
                let (u, w) = ([p[0] - v[0], p[1] - v[1]], [q[0] - v[0], q[1] - v[1]]);
                if orient(v, p, q) == 0.0 && u[0] * w[0] + u[1] * w[1] > 0.0 {
                    return Some((i, j));
                }
            } else if segments_intersect(a, b, c, d) {
                return Some((i, j));
            }
        }
    }
    None
}

/// True when the closed polygon (implicit closing edge; consecutive duplicate
/// points and a repeated first point tolerated) is simple with nonzero area.
/// cite: n/a pure geometry (simple-polygon test)
pub fn is_simple_polygon(poly: &[[f64; 2]]) -> bool {
    let (p, _) = dedup_outline(poly);
    p.len() >= 3
        && first_crossing(&p).is_none()
        && polygon_area(&p).abs() > 1e-12 * bbox_scale(&p).powi(2)
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use crate::types::{EvalShape, FinCrossSection};

    #[test]
    fn case1_trapezoidal_fins() {
        let m = on_body(
            r#"
[c.fins]
type = "trapezoidal_fin_set"
attach = { to = "body.aft", at = "root_te" }
count = 3
root_chord = "50.8 mm"
tip_chord = "50.8 mm"
span = "30 mm"
sweep = "25.4 mm"
thickness = "2 mm"
tab = { height = "0 mm", length = "50 mm" }
"#,
        );
        assert_clean(&m);
        let fins = comp(&m, "fins");
        assert!((fins.x_fore - (0.3 - 0.0508)).abs() < 1e-12);
        let EvalShape::TrapezoidalFinSet {
            fins: f,
            root_chord,
            tip_chord,
            span,
            sweep,
        } = &fins.shape
        else {
            panic!()
        };
        assert_eq!(
            (*root_chord, *tip_chord, *span, *sweep),
            (0.0508, 0.0508, 0.03, 0.0254)
        );
        assert_eq!((f.count, f.thickness, f.cant), (3, 0.002, 0.0));
        assert_eq!(f.cross_section, FinCrossSection::Square);
        assert_eq!(fins.instances.len(), 3);
        // Roots sit on the body surface.
        let le = fins.anchors.iter().find(|a| a.name == "root_le").unwrap();
        assert!((le.r - 0.0125).abs() < 1e-12);
    }

    #[test]
    fn fin_errors() {
        let m = on_body(
            r#"
[c.fins]
type = "trapezoidal_fin_set"
attach = { to = "body.aft", at = "root_te" }
count = 9
root_chord = "50 mm"
tip_chord = "-1 mm"
span = "0 mm"
sweep = "20 mm"
thickness = "0 mm"
cant = "95 deg"
tab = { height = "5 mm", length = "40 mm", offset = "20 mm" }
"#,
        );
        for f in [
            "count",
            "tip_chord",
            "span",
            "thickness",
            "cant",
            "tab/length",
        ] {
            assert_diag(&m, "RW-E061", &format!("/c/fins/{f}"));
        }
    }

    #[test]
    fn elliptical_and_freeform() {
        let m = on_body(
            r#"
[c.ell]
type = "elliptical_fin_set"
attach = { to = "body.aft", at = "root_te" }
count = 4
root_chord = "60 mm"
span = "40 mm"
thickness = "2 mm"

[c.ff]
type = "freeform_fin_set"
attach = { to = "body.fore", at = "root_le", offset = "20 mm" }
count = 3
points = [["0 mm", "0 mm"], ["20 mm", "-5 mm"]]
thickness = "2 mm"
"#,
        );
        assert!(!codes(&m).iter().any(|(_, p)| p.starts_with("/c/ell")));
        assert_diag(&m, "RW-E061", "/c/ff/points");
        assert_diag(&m, "RW-E061", "/c/ff/points/1/1");
    }

    fn freeform(points: &str) -> crate::types::EvaluatedModel {
        on_body(&format!(
            r#"
[c.ff]
type = "freeform_fin_set"
attach = {{ to = "body.aft", at = "root_te" }}
count = 3
points = {points}
thickness = "2 mm"
"#
        ))
    }

    #[test]
    fn freeform_bow_tie_crosses_itself() {
        // Root LE, then a bow-tie: edges 1 and 3 cross.
        let m = freeform(
            r#"[["0 mm", "0 mm"], ["40 mm", "30 mm"], ["40 mm", "0 mm"], ["0 mm", "30 mm"], ["20 mm", "0 mm"]]"#,
        );
        assert_diag(&m, "RW-E061", "/c/ff/points");
        let d = m
            .diagnostics
            .iter()
            .find(|d| d.path.as_deref() == Some("/c/ff/points"))
            .unwrap();
        assert!(d.message.contains("crosses itself"), "{}", d.message);
        assert!(d.hint.is_some());
    }

    #[test]
    fn freeform_valid_concave_is_clean() {
        // Notched (concave) fin, with a repeated point and an explicit closing point.
        let m = freeform(
            r#"[["0 mm", "0 mm"], ["20 mm", "50 mm"], ["20 mm", "50 mm"], ["50 mm", "30 mm"], ["80 mm", "50 mm"], ["100 mm", "0 mm"], ["0 mm", "0 mm"]]"#,
        );
        assert_clean(&m);
    }

    #[test]
    fn freeform_root_and_area_rules() {
        let m = freeform(r#"[["0 mm", "0 mm"], ["30 mm", "20 mm"], ["60 mm", "10 mm"]]"#);
        assert_diag(&m, "RW-E061", "/c/ff/points/2/1");
        let m = freeform(r#"[["0 mm", "0 mm"], ["30 mm", "0 mm"], ["60 mm", "0 mm"]]"#);
        assert_diag(&m, "RW-E061", "/c/ff/points");
        // A spike that folds back along itself is not simple.
        let m = freeform(
            r#"[["0 mm", "0 mm"], ["0 mm", "30 mm"], ["0 mm", "10 mm"], ["40 mm", "0 mm"]]"#,
        );
        assert_diag(&m, "RW-E061", "/c/ff/points");
    }

    #[test]
    fn simple_polygon_predicate() {
        use super::{first_crossing, is_simple_polygon, segments_intersect};
        let sq = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        assert!(is_simple_polygon(&sq));
        let bow = [[0.0, 0.0], [1.0, 1.0], [1.0, 0.0], [0.0, 1.0]];
        assert!(!is_simple_polygon(&bow));
        assert_eq!(first_crossing(&bow), Some((0, 2)));
        // Touching at a vertex counts as an intersection.
        assert!(segments_intersect(
            [0.0, 0.0],
            [1.0, 0.0],
            [0.5, 0.0],
            [0.5, 1.0]
        ));
        assert!(!segments_intersect(
            [0.0, 0.0],
            [1.0, 0.0],
            [0.0, 0.1],
            [1.0, 0.1]
        ));
        // Collinear overlap.
        assert!(segments_intersect(
            [0.0, 0.0],
            [2.0, 0.0],
            [1.0, 0.0],
            [3.0, 0.0]
        ));
        // Degenerate (zero area) and too few points.
        assert!(!is_simple_polygon(&[[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]]));
        assert!(!is_simple_polygon(&[[0.0, 0.0], [1.0, 0.0]]));
    }
}
