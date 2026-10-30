//! Fin plates (R4.1): planform polygons and their planform statistics.
//!
//! Planform frame: `[x, y]` with x the station (m from the nose tip, +aft)
//! and y the height above the fin root (outward, along the span). Polygons
//! are closed implicitly and counter-clockwise in (x, y). Notation follows
//! `docs/dev/literature-map.md`: c_r, c_t, s, x_t (LE sweep), c̄, y_mac, x_mac.

/// Trapezoid planform, CCW: root LE, root TE, tip TE, tip LE.
/// cite: n/a polygon construction from the trapezoid parameters
pub fn trapezoid_planform(
    x_le: f64,
    root_chord: f64,
    tip_chord: f64,
    span: f64,
    sweep: f64,
) -> Vec<[f64; 2]> {
    let mut p = vec![[x_le, 0.0], [x_le + root_chord, 0.0]];
    if span > 0.0 {
        p.push([x_le + sweep + tip_chord, span]);
        if tip_chord > 0.0 {
            p.push([x_le + sweep, span]);
        }
    }
    p
}

/// Elliptical planform (half ellipse on the root chord), CCW, `n` arc segments.
/// cite: n/a polygon construction from the ellipse parameters
pub fn elliptical_planform(x_le: f64, root_chord: f64, span: f64, n: usize) -> Vec<[f64; 2]> {
    let n = n.max(4);
    let at = |k: usize| {
        // φ = 0 at the root TE, φ = π at the root LE; walking φ up is CCW.
        let phi = std::f64::consts::PI * k as f64 / n as f64;
        let y = if k == 0 || k == n {
            0.0
        } else {
            span * phi.sin()
        };
        [x_le + 0.5 * root_chord * (1.0 + phi.cos()), y]
    };
    std::iter::once(at(n)).chain((0..n).map(at)).collect()
}

/// Freeform planform from points relative to the root LE, made CCW.
/// cite: n/a polygon construction from user points
pub fn freeform_planform(x_le: f64, points: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut p: Vec<[f64; 2]> = Vec::with_capacity(points.len());
    for q in points {
        let v = [x_le + q[0], q[1]];
        if p.last() != Some(&v) {
            p.push(v);
        }
    }
    while p.len() > 1 && p.first() == p.last() {
        p.pop();
    }
    if polygon_area_signed(&p) < 0.0 {
        p.reverse();
    }
    p
}

/// True when the closed planform polygon (implicit closing edge; consecutive
/// duplicate points and a repeated first point tolerated) is simple with
/// nonzero area, so [`triangulate`] covers it exactly. Same rule as the
/// model's freeform check (RW-E061 at `points`).
/// cite: n/a pure geometry (simple-polygon test)
pub fn is_simple_polygon(poly: &[[f64; 2]]) -> bool {
    rw_model::components::fins::is_simple_polygon(poly)
}

/// Tab polygon below the root (y ≤ 0), CCW. `offset` is from the root LE, +aft.
/// cite: n/a polygon construction from the tab parameters
pub fn tab_polygon(x_le: f64, height: f64, length: f64, offset: f64) -> Vec<[f64; 2]> {
    let (a, b) = (x_le + offset, x_le + offset + length);
    vec![[a, -height], [b, -height], [b, 0.0], [a, 0.0]]
}

/// Single trapezoidal fin planform area A_fin = (c_r + c_t) s / 2.
/// cite: barrowman-1967 eq 3-23 p 19
pub fn trapezoid_area(root_chord: f64, tip_chord: f64, span: f64) -> f64 {
    0.5 * (root_chord + tip_chord) * span
}

/// Trapezoid mean aerodynamic chord c̄ = (2/3)[c_r + c_t - c_r c_t/(c_r + c_t)].
/// cite: barrowman-1967 eq 3-24 p 20
pub fn trapezoid_mac(root_chord: f64, tip_chord: f64) -> f64 {
    let sum = root_chord + tip_chord;
    if sum <= 0.0 {
        return 0.0;
    }
    2.0 / 3.0 * (sum - root_chord * tip_chord / sum)
}

/// Trapezoid MAC spanwise position from the root, y_mac = (s/3)(c_r + 2c_t)/(c_r + c_t).
/// cite: barrowman-1967 eq 3-26 p 20
pub fn trapezoid_y_mac(root_chord: f64, tip_chord: f64, span: f64) -> f64 {
    let sum = root_chord + tip_chord;
    if sum <= 0.0 {
        return 0.0;
    }
    span / 3.0 * (root_chord + 2.0 * tip_chord) / sum
}

/// Volume of one constant-thickness fin plate, V = t_f A_fin.
/// cite: amcp-706-280 tab 6-1 p 104
pub fn plate_volume(area: f64, thickness: f64) -> f64 {
    area * thickness
}

/// Signed shoelace area (positive when CCW).
/// cite: n/a pure geometry (shoelace formula)
pub fn polygon_area_signed(poly: &[[f64; 2]]) -> f64 {
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

/// Planform statistics of one fin.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PlanformStats {
    pub area: f64,
    pub span: f64,
    pub root_chord: f64,
    pub tip_chord: f64,
    /// c̄ = (1/A)∫c(y)² dy.
    pub mac: f64,
    /// y_mac = (1/A)∫y c(y) dy, from the root.
    pub y_mac: f64,
    /// Station of the MAC leading edge, x_mac = (1/A)∫x_LE(y) c(y) dy (absolute).
    pub x_mac_le: f64,
    /// Axial offset of the tip mid-chord from the root mid-chord (+aft).
    pub mid_chord_sweep_length: f64,
}

/// MAC, its position, and chords of any simple planform polygon (y ≥ 0 part),
/// integrating the strip chord c(y) exactly (piecewise linear between vertex heights).
/// cite: niskanen-2009 eq 3.30 p 36
pub fn planform_stats(poly: &[[f64; 2]]) -> PlanformStats {
    let mut ys: Vec<f64> = poly.iter().map(|p| p[1].max(0.0)).collect();
    ys.sort_by(f64::total_cmp);
    ys.dedup_by(|a, b| (*a - *b).abs() <= 1e-15);
    let span = ys.last().copied().unwrap_or(0.0);
    let (mut a, mut cc, mut yc, mut xc) = (0.0, 0.0, 0.0, 0.0);
    let mut root = None;
    let mut tip = (0.0, 0.0, 0.0); // (chord, mid-x) at the top
    for w in ys.windows(2) {
        let (ya, yb) = (w[0], w[1]);
        let h = yb - ya;
        if h <= 0.0 {
            continue;
        }
        // c and x_LE are linear inside (ya, yb): sample at 1/3 and 2/3, extrapolate.
        let s1 = slice(poly, ya + h / 3.0);
        let s2 = slice(poly, ya + 2.0 * h / 3.0);
        let lin = |f1: f64, f2: f64| (2.0 * f1 - f2, 2.0 * f2 - f1, 0.5 * (f1 + f2));
        let (ca, cb, cm) = lin(s1.0, s2.0);
        let (xa, xb, xm) = lin(s1.1, s2.1);
        let (ma, mb, _) = lin(s1.2, s2.2);
        let simpson = |fa: f64, fm: f64, fb: f64| h / 6.0 * (fa + 4.0 * fm + fb);
        a += simpson(ca, cm, cb);
        cc += simpson(ca * ca, cm * cm, cb * cb);
        yc += simpson(ya * ca, (ya + 0.5 * h) * cm, yb * cb);
        xc += simpson(xa * ca, xm * cm, xb * cb);
        if root.is_none() {
            root = Some((ca, ma));
        }
        tip = (cb, mb, yb);
    }
    let (root_chord, root_mid) = root.unwrap_or((0.0, 0.0));
    let (tip_chord, tip_mid, _) = tip;
    if a <= 0.0 {
        return PlanformStats::default();
    }
    PlanformStats {
        area: a,
        span,
        root_chord,
        tip_chord: tip_chord.max(0.0),
        mac: cc / a,
        y_mac: yc / a,
        x_mac_le: xc / a,
        mid_chord_sweep_length: tip_mid - root_mid,
    }
}

/// Horizontal slice of a polygon at height y: (total chord, leading-edge x,
/// mid-chord x of the slice's overall extent).
fn slice(poly: &[[f64; 2]], y: f64) -> (f64, f64, f64) {
    let n = poly.len();
    let mut xs = Vec::new();
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        if (a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y) {
            let t = (y - a[1]) / (b[1] - a[1]);
            xs.push(a[0] + t * (b[0] - a[0]));
        }
    }
    xs.sort_by(f64::total_cmp);
    if xs.len() < 2 {
        return (0.0, 0.0, 0.0);
    }
    let chord: f64 = xs
        .chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| c[1] - c[0])
        .sum();
    let (lo, hi) = (xs[0], xs[xs.len() - 1]);
    (chord, lo, 0.5 * (lo + hi))
}

/// Ear-clipping triangulation of a simple CCW polygon (indices into `poly`).
/// cite: n/a pure geometry (ear clipping)
pub fn triangulate(poly: &[[f64; 2]]) -> Vec<[usize; 3]> {
    let mut idx: Vec<usize> = (0..poly.len()).collect();
    let mut out = Vec::new();
    let cross = |o: [f64; 2], a: [f64; 2], b: [f64; 2]| {
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    };
    let mut guard = 0;
    while idx.len() > 3 && guard < 10_000 {
        guard += 1;
        let m = idx.len();
        let mut clipped = false;
        for i in 0..m {
            let (ia, ib, ic) = (idx[(i + m - 1) % m], idx[i], idx[(i + 1) % m]);
            let (a, b, c) = (poly[ia], poly[ib], poly[ic]);
            let turn = cross(a, b, c);
            if turn <= 0.0 {
                continue; // reflex or degenerate
            }
            let inside = idx.iter().any(|&j| {
                j != ia
                    && j != ib
                    && j != ic
                    && cross(a, b, poly[j]) >= 0.0
                    && cross(b, c, poly[j]) >= 0.0
                    && cross(c, a, poly[j]) >= 0.0
            });
            if !inside {
                out.push([ia, ib, ic]);
                idx.remove(i);
                clipped = true;
                break;
            }
        }
        if !clipped {
            // Degenerate remainder (collinear points): drop the flattest vertex.
            let m = idx.len();
            let i = (0..m)
                .min_by(|&i, &j| {
                    let t = |k: usize| {
                        cross(
                            poly[idx[(k + m - 1) % m]],
                            poly[idx[k]],
                            poly[idx[(k + 1) % m]],
                        )
                        .abs()
                    };
                    t(i).total_cmp(&t(j))
                })
                .unwrap_or(0);
            idx.remove(i);
        }
    }
    if idx.len() == 3 && cross(poly[idx[0]], poly[idx[1]], poly[idx[2]]) > 0.0 {
        out.push([idx[0], idx[1], idx[2]]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * b.abs().max(1.0)
    }

    #[test]
    fn trapezoid_closed_forms_match_strip_integrals() {
        // Fixture fin: c_r 140, c_t 60, s 90, x_t 45 mm.
        let (cr, ct, s, xt, xle) = (0.14, 0.06, 0.09, 0.045, 0.7);
        let p = trapezoid_planform(xle, cr, ct, s, xt);
        assert!(polygon_area_signed(&p) > 0.0, "CCW");
        let st = planform_stats(&p);
        assert!(close(st.area, trapezoid_area(cr, ct, s), 1e-12));
        assert!(close(st.area, 0.009, 1e-12));
        assert!(close(st.mac, trapezoid_mac(cr, ct), 1e-12));
        assert!(close(st.y_mac, trapezoid_y_mac(cr, ct, s), 1e-12));
        // x_mac = x_t y_mac / s (barrowman-1967 eq 3-29).
        assert!(close(st.x_mac_le - xle, xt * st.y_mac / s, 1e-12));
        assert!(close(st.root_chord, cr, 1e-12) && close(st.tip_chord, ct, 1e-12));
        assert!(close(st.span, s, 1e-12));
        assert!(close(
            st.mid_chord_sweep_length,
            xt + ct / 2.0 - cr / 2.0,
            1e-12
        ));
        // MAC in taper ratio (3-22): (2/3) c_r (λ² + λ + 1)/(1 + λ).
        let lam = ct / cr;
        assert!(close(
            trapezoid_mac(cr, ct),
            2.0 / 3.0 * cr * (lam * lam + lam + 1.0) / (1.0 + lam),
            1e-12
        ));
    }

    #[test]
    fn triangle_fin() {
        let p = trapezoid_planform(0.0, 0.1, 0.0, 0.05, 0.1);
        assert_eq!(p.len(), 3);
        let st = planform_stats(&p);
        assert!(close(st.area, 0.0025, 1e-12));
        assert!(close(st.mac, 2.0 / 3.0 * 0.1, 1e-12));
        assert!(close(st.y_mac, 0.05 / 3.0, 1e-12));
    }

    #[test]
    fn elliptical_area() {
        let p = elliptical_planform(0.0, 0.12, 0.08, 128);
        assert!(polygon_area_signed(&p) > 0.0);
        let st = planform_stats(&p);
        let exact = std::f64::consts::PI * 0.12 * 0.08 / 4.0;
        assert!(
            (st.area - exact).abs() / exact < 2e-4,
            "{} vs {exact}",
            st.area
        );
        assert!((st.root_chord - 0.12).abs() < 1e-9);
        // c̄ of an elliptical planform = 8 c_r/(3π).
        let mac = 8.0 * 0.12 / (3.0 * std::f64::consts::PI);
        assert!((st.mac - mac).abs() / mac < 1e-3, "{} vs {mac}", st.mac);
    }

    #[test]
    fn freeform_orientation_and_triangulation() {
        // Concave (notched) freeform fin given clockwise.
        let pts = [
            [0.0, 0.0],
            [0.02, 0.05],
            [0.05, 0.03],
            [0.08, 0.05],
            [0.1, 0.0],
        ];
        let p = freeform_planform(1.0, &pts);
        assert!(polygon_area_signed(&p) > 0.0);
        let tris = triangulate(&p);
        assert_eq!(tris.len(), p.len() - 2);
        let area: f64 = tris
            .iter()
            .map(|t| polygon_area_signed(&[p[t[0]], p[t[1]], p[t[2]]]))
            .sum();
        assert!(close(area, polygon_area_signed(&p), 1e-12));
        assert!(close(
            planform_stats(&p).area,
            polygon_area_signed(&p),
            1e-12
        ));
    }

    #[test]
    fn tab_is_below_root() {
        let t = tab_polygon(0.7, 0.01, 0.08, 0.03);
        assert!(polygon_area_signed(&t) > 0.0);
        assert!(t.iter().all(|p| p[1] <= 0.0));
        assert!(close(
            plate_volume(polygon_area_signed(&t), 0.003),
            0.01 * 0.08 * 0.003,
            1e-12
        ));
    }
}

#[cfg(test)]
mod freeform {
    use super::*;
    use std::f64::consts::PI;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * b.abs().max(1e-12)
    }

    fn tri_area(p: &[[f64; 2]]) -> f64 {
        triangulate(p)
            .iter()
            .map(|t| polygon_area_signed(&[p[t[0]], p[t[1]], p[t[2]]]))
            .sum()
    }

    #[test]
    fn cw_input_is_made_ccw() {
        // Root LE, root TE, then over the tip back: clockwise in (x, y).
        let cw = [[0.0, 0.0], [0.0, 0.04], [0.05, 0.04], [0.08, 0.0]];
        assert!(polygon_area_signed(&cw) < 0.0);
        let p = freeform_planform(0.5, &cw);
        assert!(polygon_area_signed(&p) > 0.0);
        assert_eq!(p.len(), 4);
        assert!(p.contains(&[0.5, 0.0]) && p.contains(&[0.58, 0.0]));
        // CCW input is kept as given (shifted to the root LE station).
        let ccw: Vec<[f64; 2]> = cw.iter().rev().copied().collect();
        let q = freeform_planform(0.5, &ccw);
        assert_eq!(q[0], [0.58, 0.0]);
        assert!(polygon_area_signed(&q) > 0.0);
    }

    #[test]
    fn closing_and_repeated_points_removed() {
        let pts = [
            [0.0, 0.0],
            [0.02, 0.03],
            [0.02, 0.03],
            [0.06, 0.03],
            [0.08, 0.0],
            [0.0, 0.0],
        ];
        let p = freeform_planform(0.0, &pts);
        assert_eq!(p.len(), 4, "{p:?}");
        assert_ne!(p.first(), p.last());
        assert!(is_simple_polygon(&pts));
        assert!(is_simple_polygon(&p));
    }

    #[test]
    fn concave_triangulation_matches_shoelace() {
        // Two-lobed (concave) planform with a deep notch in the tip.
        let pts = [
            [0.0, 0.0],
            [0.01, 0.06],
            [0.03, 0.06],
            [0.04, 0.02],
            [0.06, 0.07],
            [0.09, 0.07],
            [0.12, 0.0],
        ];
        let p = freeform_planform(1.2, &pts);
        assert!(is_simple_polygon(&p));
        let tris = triangulate(&p);
        assert_eq!(tris.len(), p.len() - 2);
        let a = polygon_area_signed(&p);
        assert!(close(tri_area(&p), a, 1e-12), "{} vs {a}", tri_area(&p));
        assert!(close(planform_stats(&p).area, a, 1e-12));
        // Every triangle is CCW (none inverted).
        for t in &tris {
            assert!(polygon_area_signed(&[p[t[0]], p[t[1]], p[t[2]]]) > 0.0);
        }
    }

    #[test]
    fn rectangle_matches_trapezoid_formulas() {
        let (c, s, x_le) = (0.07, 0.04, 0.3);
        let p = freeform_planform(x_le, &[[0.0, 0.0], [0.0, s], [c, s], [c, 0.0]]);
        let st = planform_stats(&p);
        assert!(close(st.area, trapezoid_area(c, c, s), 1e-12));
        assert!(close(st.mac, trapezoid_mac(c, c), 1e-12));
        assert!(close(st.y_mac, trapezoid_y_mac(c, c, s), 1e-12));
        assert!(close(st.span, s, 1e-12));
        assert!(close(st.root_chord, c, 1e-12) && close(st.tip_chord, c, 1e-12));
        assert!(close(st.x_mac_le, x_le, 1e-12));
        assert!(st.mid_chord_sweep_length.abs() < 1e-12);
        // Swept freeform trapezoid: same as the closed forms with sweep.
        let (cr, ct, sw) = (0.1, 0.04, 0.05);
        let p = freeform_planform(0.0, &[[0.0, 0.0], [sw, s], [sw + ct, s], [cr, 0.0]]);
        let st = planform_stats(&p);
        assert!(close(st.area, trapezoid_area(cr, ct, s), 1e-12));
        assert!(close(st.mac, trapezoid_mac(cr, ct), 1e-12));
        assert!(close(st.x_mac_le, sw * st.y_mac / s, 1e-12));
    }

    #[test]
    fn elliptical_area_converges() {
        let (cr, s) = (0.12, 0.08);
        let exact = PI * cr * s / 4.0;
        let mut prev = f64::INFINITY;
        for n in [8, 16, 32, 64, 128, 256] {
            let p = elliptical_planform(0.0, cr, s, n);
            let err = (planform_stats(&p).area - exact).abs() / exact;
            assert!(close(tri_area(&p), polygon_area_signed(&p), 1e-12));
            assert!(err < prev, "n {n}: {err} !< {prev}");
            prev = err;
        }
        assert!(prev < 1e-4, "{prev}");
    }

    #[test]
    fn self_crossing_is_not_simple() {
        let bow = [[0.0, 0.0], [0.04, 0.03], [0.04, 0.0], [0.0, 0.03]];
        assert!(!is_simple_polygon(&bow));
        assert!(!is_simple_polygon(&[[0.0, 0.0], [0.1, 0.0], [0.2, 0.0]]));
    }

    #[test]
    fn freeform_set_through_build() {
        use rw_model::EvaluatedModel;
        let pts = [
            [0.0, 0.0],
            [0.02, 0.05],
            [0.05, 0.03],
            [0.08, 0.05],
            [0.1, 0.0],
        ];
        let area = polygon_area_signed(&freeform_planform(0.0, &pts));
        let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/evaluated-model.json"
        )))
        .unwrap();
        let mut m: EvaluatedModel = serde_json::from_value(fixture["payload"].clone()).unwrap();
        let body = serde_json::json!({
            "id": "body", "name": "body", "parent": null, "children": ["ff"],
            "containment": "axial", "aero": true, "cut": false,
            "x_fore": 0.0, "x_aft": 0.5, "radial": 0.0, "roll": 0.0,
            "instances": [{ "index": 0, "offset": [0.0, 0.0, 0.0], "roll": 0.0 }],
            "anchors": [], "shape": { "type": "body_tube", "length": 0.5, "od": 0.05, "id": 0.048 }
        });
        let ff = serde_json::json!({
            "id": "ff", "name": "ff", "parent": "body", "children": [],
            "containment": "surface", "aero": true, "cut": false,
            "x_fore": 0.4, "x_aft": 0.5, "radial": 0.0, "roll": 0.0,
            "instances": [], "anchors": [],
            "shape": { "type": "freeform_fin_set", "count": 4, "thickness": 0.003,
                "cross_section": "square", "cant": 0.0, "fillet_radius": 0.0,
                "points": pts }
        });
        m.components = vec![
            serde_json::from_value(body).unwrap(),
            serde_json::from_value(ff).unwrap(),
        ];
        let g = crate::build(&m);
        let c = g.components.iter().find(|c| c.id == "ff").unwrap();
        let f = c.fins.as_ref().expect("fin geometry");
        assert_eq!(f.count, 4);
        assert!(close(polygon_area_signed(&f.planform), area, 1e-12));
        assert!(close(c.planform_area, area, 1e-12));
        assert!(close(c.wetted_area, 2.0 * 4.0 * area, 1e-12));
        assert!(close(c.volume, 4.0 * area * 0.003, 1e-12));
        assert!(close(f.root_radius, 0.025, 1e-12));
        assert!(close(f.span, 0.05, 1e-12));
        assert!(close(
            f.planform.iter().map(|p| p[0]).fold(0.0, f64::max),
            0.5,
            1e-12
        ));
    }
}
