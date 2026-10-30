//! Axisymmetric component profiles (R4.1): outer contour and cavity, both as
//! polylines r(x) in stations (fore to aft, vertical steps allowed), plus the
//! material volume and the exposed (aerodynamic) metrics.
//!
//! Conventions:
//! - `outer` includes shoulders (vertical steps at the base/ends).
//! - `inner` is the cavity radius; it starts and/or ends on the axis (r = 0)
//!   where the cavity is closed (solid tip, capped shoulder, tank dome).
//! - The exposed metrics cover only the shaped length (shoulders excluded).
//! - Shells: the cavity is the inward normal offset of the outer curve by the
//!   wall thickness (a wall of constant thickness t_w, literature-map MI-07),
//!   run to the shaped section's end; a shoulder is a separate tube (MI-18)
//!   whose bore the cavity steps to at the joint, plus its cap disc when
//!   capped. Hollow parts are outer solid minus cavity (MI-25). No material
//!   is added at the joint: the M2.1 45° chamfer from the offset down to the
//!   shoulder bore had no source and weighed +1.0 g on the case-3 ellipsoid
//!   nose (parity-log M2-parity).

use rw_model::{EndCap, EvalShoulder, NoseShape};

use crate::area::{RevMetrics, curve_metrics, polyline_metrics, tube_metrics};
use crate::nose::{ellipsoid_radius, shape_radius};
use crate::types::ProfilePoint;

/// Segments along a curved section in the published profile.
pub const CURVE_SEGMENTS: usize = 40;
/// Segments used to integrate the shell cavity volume.
const FINE_SEGMENTS: usize = 800;

/// A solid of revolution about its own axis.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Revolved {
    pub outer: Vec<ProfilePoint>,
    pub inner: Vec<ProfilePoint>,
    /// Material volume (outer solid minus cavity).
    pub volume: f64,
    /// Exposed outer surface: lateral area and side projection of the shaped
    /// length (shoulders excluded); `volume` here is the enclosed volume.
    pub exposed: RevMetrics,
}

fn pt(x: f64, r: f64) -> ProfilePoint {
    ProfilePoint { x, r }
}

/// Drops consecutive duplicate points.
fn dedup(mut v: Vec<ProfilePoint>) -> Vec<ProfilePoint> {
    v.dedup_by(|a, b| (a.x - b.x).abs() < 1e-15 && (a.r - b.r).abs() < 1e-15);
    v
}

/// Samples a curve given in tip coordinates (ξ from the tip) at stations
/// `x0..x0+len`, clustered toward the tip (ξ = len·u²). `tip_at_fore = false`
/// puts the tip at the aft end. Output runs fore to aft.
/// cite: n/a sampling of an analytic profile
pub fn sample_curve(
    r: impl Fn(f64) -> f64,
    x0: f64,
    len: f64,
    tip_at_fore: bool,
    n: usize,
) -> Vec<ProfilePoint> {
    let n = n.max(1);
    let mut pts: Vec<ProfilePoint> = (0..=n)
        .map(|k| {
            let u = k as f64 / n as f64;
            let xi = len * u * u;
            let x = if tip_at_fore { x0 + xi } else { x0 + len - xi };
            pt(x, r(xi).max(0.0))
        })
        .collect();
    if !tip_at_fore {
        pts.reverse();
    }
    pts
}

/// Inward normal offset of a fore-to-aft profile curve by `t`. Starts at the
/// axis crossing when the tip region is solid; x is kept strictly increasing.
/// Empty when the wall fills the whole section.
/// cite: n/a pure geometry (curve offset)
pub fn offset_inward(c: &[ProfilePoint], t: f64) -> Vec<ProfilePoint> {
    let n = c.len();
    if n < 2 {
        return Vec::new();
    }
    let raw: Vec<ProfilePoint> = (0..n)
        .map(|i| {
            let (a, b) = (c[i.saturating_sub(1)], c[(i + 1).min(n - 1)]);
            let (dx, dr) = (b.x - a.x, b.r - a.r);
            let l = dx.hypot(dr);
            if l == 0.0 {
                return pt(c[i].x, c[i].r - t);
            }
            pt(c[i].x + t * dr / l, c[i].r - t * dx / l)
        })
        .collect();
    let mut out: Vec<ProfilePoint> = Vec::new();
    let start = match raw.iter().rposition(|p| p.r <= 0.0) {
        Some(k) if k + 1 >= n => return Vec::new(),
        Some(k) => {
            let (a, b) = (raw[k], raw[k + 1]);
            let s = a.r / (a.r - b.r);
            out.push(pt(a.x + s * (b.x - a.x), 0.0));
            k + 1
        }
        None => 0,
    };
    for p in &raw[start..] {
        if out.last().is_none_or(|l| p.x > l.x) {
            out.push(*p);
        }
    }
    out
}

/// Piecewise-linear r at x, constant beyond the ends.
fn interp(poly: &[ProfilePoint], x: f64) -> f64 {
    match poly {
        [] => 0.0,
        [p] => p.r,
        _ => {
            if x <= poly[0].x {
                return poly[0].r;
            }
            for w in poly.windows(2) {
                if x <= w[1].x {
                    let dx = w[1].x - w[0].x;
                    if dx <= 0.0 {
                        return w[1].r;
                    }
                    return w[0].r + (x - w[0].x) / dx * (w[1].r - w[0].r);
                }
            }
            poly[poly.len() - 1].r
        }
    }
}

/// Shell cavity between stations x0..x1: the inward offset of the curve by
/// the wall thickness (MI-07), clipped to x0..x1, starting at x0 on the
/// offset radius unless the tip region is solid.
fn shell_cavity(curve: &[ProfilePoint], t: f64, x0: f64, x1: f64) -> Vec<ProfilePoint> {
    let off = offset_inward(curve, t);
    if off.is_empty() {
        return Vec::new();
    }
    let solid_tip = off[0].r == 0.0;
    let mut xs: Vec<f64> = Vec::new();
    if !solid_tip {
        xs.push(x0);
    }
    xs.extend(off.iter().map(|p| p.x).filter(|&x| x >= x0 && x <= x1));
    xs.push(x1);
    xs.dedup_by(|a, b| (*a - *b).abs() < 1e-15);
    xs.iter()
        .map(|&x| pt(x, interp(&off, x).max(0.0)))
        .collect()
}

/// Appends a shoulder bore to a cavity (aft side), closing it if capped.
fn push_aft_bore(cav: &mut Vec<ProfilePoint>, x_base: f64, sh: &EvalShoulder) {
    let rs = 0.5 * sh.od;
    let bore = rs - sh.thickness;
    let end = x_base + sh.length;
    if sh.thickness <= 0.0 || bore <= 0.0 {
        if cav.last().is_some_and(|p| p.r > 0.0) {
            cav.push(pt(x_base, 0.0));
        }
        return;
    }
    if cav.last().is_none_or(|p| p.r == 0.0) {
        cav.push(pt(x_base, 0.0));
    }
    cav.push(pt(x_base, bore));
    if sh.capped {
        let xe = (end - sh.thickness).max(x_base);
        cav.push(pt(xe, bore));
        cav.push(pt(xe, 0.0));
    } else {
        cav.push(pt(end, bore));
    }
}

/// Prepends a shoulder bore to a cavity (fore side), closing it if capped.
fn push_fore_bore(cav: &mut Vec<ProfilePoint>, x_base: f64, sh: &EvalShoulder) {
    let mut rev: Vec<ProfilePoint> = cav.iter().rev().map(|p| pt(-p.x, p.r)).collect();
    push_aft_bore(&mut rev, -x_base, sh);
    *cav = rev.into_iter().rev().map(|p| pt(-p.x, p.r)).collect();
}

fn shoulder_ok(sh: Option<&EvalShoulder>) -> Option<&EvalShoulder> {
    sh.filter(|s| s.length > 0.0 && s.od > 0.0)
}

fn shoulder_volume(sh: Option<&EvalShoulder>) -> f64 {
    shoulder_ok(sh)
        .map(|s| std::f64::consts::PI * (0.5 * s.od).powi(2) * s.length)
        .unwrap_or(0.0)
}

/// Nose cone of base diameter `od` at stations x0..x0+len, optional wall
/// `thickness` (0 = solid) and aft shoulder.
/// cite: niskanen-2009 sec A.1 p 110-113
pub fn nose_profile(
    x0: f64,
    shape: NoseShape,
    param: f64,
    len: f64,
    od: f64,
    thickness: f64,
    shoulder: Option<&EvalShoulder>,
) -> Revolved {
    let r_base = 0.5 * od;
    let f = |xi: f64| shape_radius(shape, param, len, r_base, xi);
    let x1 = x0 + len;
    let sh = shoulder_ok(shoulder);
    let exposed = curve_metrics(f, len);
    let mut outer = sample_curve(f, x0, len, true, CURVE_SEGMENTS);
    if let Some(s) = sh {
        outer.push(pt(x1, 0.5 * s.od));
        outer.push(pt(x1 + s.length, 0.5 * s.od));
    }
    let cavity = |n: usize| {
        let mut cav = if thickness > 0.0 {
            let curve = sample_curve(f, x0, len, true, n);
            shell_cavity(&curve, thickness, x0, x1)
        } else {
            Vec::new()
        };
        if let Some(s) = sh {
            push_aft_bore(&mut cav, x1, s);
        }
        dedup(cav)
    };
    let enclosed = exposed.volume + shoulder_volume(sh);
    let fine = cavity(FINE_SEGMENTS);
    Revolved {
        outer: dedup(outer),
        inner: cavity(CURVE_SEGMENTS),
        volume: (enclosed - polyline_metrics(&fine).volume).max(0.0),
        exposed,
    }
}

/// Transition from `fore_od` to `aft_od` at stations x0..x0+len (non-clipped
/// shape, A.7), optional wall and fore/aft shoulders.
/// cite: niskanen-2009 sec A.7 p 113
#[allow(clippy::too_many_arguments)]
pub fn transition_profile(
    x0: f64,
    shape: NoseShape,
    param: f64,
    len: f64,
    fore_od: f64,
    aft_od: f64,
    thickness: f64,
    fore_shoulder: Option<&EvalShoulder>,
    aft_shoulder: Option<&EvalShoulder>,
) -> Revolved {
    let (rf, ra) = (0.5 * fore_od, 0.5 * aft_od);
    let (small, big) = (rf.min(ra), rf.max(ra));
    let f = |xi: f64| small + shape_radius(shape, param, len, big - small, xi);
    let tip_fore = ra >= rf;
    let x1 = x0 + len;
    let (shf, sha) = (shoulder_ok(fore_shoulder), shoulder_ok(aft_shoulder));
    let exposed = curve_metrics(f, len);
    let mut outer = Vec::new();
    if let Some(s) = shf {
        outer.push(pt(x0 - s.length, 0.5 * s.od));
        outer.push(pt(x0, 0.5 * s.od));
    }
    outer.extend(sample_curve(f, x0, len, tip_fore, CURVE_SEGMENTS));
    if let Some(s) = sha {
        outer.push(pt(x1, 0.5 * s.od));
        outer.push(pt(x1 + s.length, 0.5 * s.od));
    }
    let cavity = |n: usize| {
        let mut cav = if thickness > 0.0 {
            let curve = sample_curve(f, x0, len, tip_fore, n);
            shell_cavity(&curve, thickness, x0, x1)
        } else {
            Vec::new()
        };
        if let Some(s) = sha {
            push_aft_bore(&mut cav, x1, s);
        }
        if let Some(s) = shf {
            push_fore_bore(&mut cav, x0, s);
        }
        dedup(cav)
    };
    let enclosed = exposed.volume + shoulder_volume(shf) + shoulder_volume(sha);
    let fine = cavity(FINE_SEGMENTS);
    Revolved {
        outer: dedup(outer),
        inner: cavity(CURVE_SEGMENTS),
        volume: (enclosed - polyline_metrics(&fine).volume).max(0.0),
        exposed,
    }
}

/// Tube (or solid cylinder when `id = 0`) at stations x0..x0+len.
/// cite: amcp-706-280 tab 6-1 p 104
pub fn tube_profile(x0: f64, len: f64, od: f64, id: f64) -> Revolved {
    let (ro, ri) = (0.5 * od.max(0.0), (0.5 * id).clamp(0.0, 0.5 * od.max(0.0)));
    if ro <= 0.0 || len <= 0.0 {
        return Revolved::default();
    }
    let m = tube_metrics(len, ro, ri);
    let inner = if ri > 0.0 {
        vec![pt(x0, ri), pt(x0 + len, ri)]
    } else {
        Vec::new()
    };
    Revolved {
        outer: vec![pt(x0, ro), pt(x0 + len, ro)],
        inner,
        volume: m.volume,
        exposed: RevMetrics {
            volume: tube_metrics(len, ro, 0.0).volume,
            ..m
        },
    }
}

fn dome_height(end_cap: EndCap, r: f64, len: f64) -> f64 {
    let h = match end_cap {
        EndCap::Flat => 0.0,
        EndCap::Hemispherical => r,
        EndCap::Ellipsoidal => 0.5 * r, // 2:1 ellipsoidal head
    };
    h.min(0.5 * len).max(0.0)
}

/// Closed capsule profile: domes of height `h` (half-ellipsoids, A.6) on a cylinder.
fn capsule(x0: f64, len: f64, r: f64, h: f64, n: usize) -> (Vec<ProfilePoint>, f64) {
    if h <= 0.0 {
        return (
            vec![pt(x0, r), pt(x0 + len, r)],
            std::f64::consts::PI * r * r * len,
        );
    }
    let dome = |xi: f64| ellipsoid_radius(h, r, xi);
    let mut p = sample_curve(dome, x0, h, true, n);
    let aft = sample_curve(dome, x0 + len - h, h, false, n);
    if len - 2.0 * h > 0.0 {
        p.extend(aft);
    } else {
        p.extend(aft.into_iter().skip(1));
    }
    let v = 2.0 * curve_metrics(dome, h).volume
        + std::f64::consts::PI * r * r * (len - 2.0 * h).max(0.0);
    (p, v)
}

/// Propellant tank: cylinder with flat, hemispherical, or 2:1 ellipsoidal
/// heads; the cavity is the same shape shrunk by the wall.
/// cite: niskanen-2009 eq A.6 p 111
pub fn tank_profile(x0: f64, len: f64, od: f64, wall: f64, end_cap: EndCap) -> Revolved {
    let r = 0.5 * od;
    if r <= 0.0 || len <= 0.0 {
        return Revolved::default();
    }
    let h = dome_height(end_cap, r, len);
    let (outer, v_out) = capsule(x0, len, r, h, CURVE_SEGMENTS / 2);
    let (ri, li) = (r - wall, len - 2.0 * wall);
    let (inner, v_in) = if wall > 0.0 && ri > 0.0 && li > 0.0 {
        let hi = dome_height(end_cap, ri, li).min((h - wall).max(0.0));
        let (mut c, v) = capsule(x0 + wall, li, ri, hi, CURVE_SEGMENTS / 2);
        if hi <= 0.0 {
            c.insert(0, pt(x0 + wall, 0.0));
            c.push(pt(x0 + wall + li, 0.0));
        }
        (c, v)
    } else {
        (Vec::new(), 0.0)
    };
    let exposed = polyline_metrics(&outer);
    Revolved {
        outer,
        inner,
        volume: (v_out - v_in).max(0.0),
        exposed: RevMetrics {
            volume: v_out,
            ..exposed
        },
    }
}

/// Outer radius of a profile at station x (largest value at a vertical step).
/// cite: n/a interpolation of a profile polyline
pub fn radius_at(outer: &[ProfilePoint], x: f64) -> Option<f64> {
    let (first, last) = (outer.first()?, outer.last()?);
    if x < first.x - 1e-12 || x > last.x + 1e-12 {
        return None;
    }
    let mut best: Option<f64> = None;
    for w in outer.windows(2) {
        let (a, b) = (w[0], w[1]);
        if x >= a.x.min(b.x) - 1e-12 && x <= a.x.max(b.x) + 1e-12 {
            let r = if (b.x - a.x).abs() < 1e-15 {
                a.r.max(b.r)
            } else {
                a.r + (x - a.x) / (b.x - a.x) * (b.r - a.r)
            };
            best = Some(best.map_or(r, |q: f64| q.max(r)));
        }
    }
    best.or(Some(first.r))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn close(a: f64, b: f64, rel: f64) -> bool {
        (a - b).abs() <= rel * b.abs()
    }

    #[test]
    fn conical_shell_is_exact() {
        // A cone shell's inward offset is a similar cone whose apex sits
        // t / sin α aft of the tip (tan α = R/L).
        let (l, r, t) = (0.2_f64, 0.03_f64, 0.002_f64);
        let p = nose_profile(0.0, NoseShape::Conical, 0.0, l, 2.0 * r, t, None);
        let alpha = (r / l).atan();
        let x0 = t / alpha.sin();
        let v_cav = PI * alpha.tan().powi(2) * (l - x0).powi(3) / 3.0;
        let v = PI * r * r * l / 3.0 - v_cav;
        assert!(close(p.volume, v, 1e-9), "{} vs {v}", p.volume);
        assert!((p.inner[0].x - x0).abs() < 1e-12 && p.inner[0].r == 0.0);
        let last = p.inner.last().unwrap();
        assert!((last.x - l).abs() < 1e-12);
        assert!((last.r - (r - t / alpha.cos())).abs() < 1e-12);
    }

    #[test]
    fn thin_shells_approach_area_times_thickness() {
        // amcp-706-280 (MI-07): V ≈ A_wet t for a thin wall.
        for shape in [
            NoseShape::Ogive,
            NoseShape::Haack,
            NoseShape::Ellipsoid,
            NoseShape::Power,
        ] {
            let t = 1e-4;
            let p = nose_profile(0.0, shape, f64::NAN, 0.25, 0.06, t, None);
            let approx = p.exposed.wetted_area * t;
            assert!(
                close(p.volume, approx, 0.02),
                "{shape:?}: {} vs {approx}",
                p.volume
            );
        }
    }

    #[test]
    fn nose_with_shoulder() {
        let sh = EvalShoulder {
            length: 0.06,
            od: 0.0518,
            thickness: 0.002,
            capped: false,
        };
        let solid = nose_profile(0.0, NoseShape::Ogive, 1.0, 0.22, 0.054, 0.0, Some(&sh));
        let bare = nose_profile(0.0, NoseShape::Ogive, 1.0, 0.22, 0.054, 0.0, None);
        // Solid nose + hollow shoulder: shoulder adds an annulus.
        let ann = PI * (0.0259_f64.powi(2) - 0.0239_f64.powi(2)) * 0.06;
        assert!(close(solid.volume - bare.volume, ann, 1e-9));
        // Exposed metrics ignore the shoulder.
        assert_eq!(solid.exposed, bare.exposed);
        // Outer ends with the step to the shoulder.
        let n = solid.outer.len();
        assert_eq!(solid.outer[n - 2], pt(0.22, 0.0259));
        assert_eq!(solid.outer[n - 1], pt(0.28, 0.0259));
        // Hollow nose: the wall offset runs to the base, then the cavity
        // steps to the shoulder bore (no joint material, MI-07 + MI-18).
        let hollow = nose_profile(0.0, NoseShape::Ogive, 1.0, 0.22, 0.054, 0.002, Some(&sh));
        assert!(
            hollow
                .inner
                .iter()
                .all(|p| p.r <= 0.0239 + 1e-12 || p.x <= 0.22)
        );
        let at_base: Vec<f64> = hollow
            .inner
            .iter()
            .filter(|p| (p.x - 0.22).abs() < 1e-15)
            .map(|p| p.r)
            .collect();
        // Offset of the 40-segment published polyline: r_base − t to 2e-6.
        assert!(
            close(at_base[0], 0.025, 2e-6) && close(at_base[1], 0.0239, 1e-12),
            "{at_base:?}"
        );
        // Volume = the bare shell + the shoulder annulus, exactly (MI-25).
        let bare_shell = nose_profile(0.0, NoseShape::Ogive, 1.0, 0.22, 0.054, 0.002, None);
        assert!(close(hollow.volume - bare_shell.volume, ann, 1e-9));
        let last = *hollow.inner.last().unwrap();
        assert!((last.x - 0.28).abs() < 1e-15 && (last.r - 0.0239).abs() < 1e-15);
        assert!(hollow.volume < solid.volume && hollow.volume > 0.0);
        // Capped shoulder adds the cap disc.
        let capped = EvalShoulder {
            capped: true,
            ..sh.clone()
        };
        let c = nose_profile(
            0.0,
            NoseShape::Ogive,
            1.0,
            0.22,
            0.054,
            0.002,
            Some(&capped),
        );
        assert!(close(
            c.volume - hollow.volume,
            PI * 0.0239_f64.powi(2) * 0.002,
            1e-9
        ));
        assert_eq!(c.inner.last().unwrap().r, 0.0);
    }

    #[test]
    fn transition_frustum() {
        // Solid conical transition = frustum (amcp-706-280 tab 6-1).
        let p = transition_profile(
            0.5,
            NoseShape::Conical,
            0.0,
            0.1,
            0.054,
            0.04,
            0.0,
            None,
            None,
        );
        let (r0, r1, l) = (0.027, 0.02, 0.1);
        assert!(close(
            p.volume,
            PI * l / 3.0 * (r0 * r0 + r1 * r1 + r0 * r1),
            1e-12
        ));
        assert!(close(
            p.exposed.wetted_area,
            PI * (r0 + r1) * (l * l + (r0 - r1) * (r0 - r1)).sqrt(),
            1e-12
        ));
        assert_eq!(p.outer.first().unwrap().r, r0);
        assert_eq!(p.outer.last().unwrap().r, r1);
        assert!(p.outer.windows(2).all(|w| w[1].x >= w[0].x));
        // Hollow, both shoulders, both directions: positive volume, cavity inside outer.
        let sh = EvalShoulder {
            length: 0.03,
            od: 0.05,
            thickness: 0.002,
            capped: false,
        };
        let sh2 = EvalShoulder {
            length: 0.03,
            od: 0.036,
            thickness: 0.002,
            capped: true,
        };
        for (fo, ao, fs, as_) in [(0.054, 0.04, &sh, &sh2), (0.04, 0.054, &sh2, &sh)] {
            let h = transition_profile(
                0.5,
                NoseShape::Ogive,
                1.0,
                0.1,
                fo,
                ao,
                0.0015,
                Some(fs),
                Some(as_),
            );
            assert!(h.volume > 0.0);
            for q in &h.inner {
                let ro = radius_at(&h.outer, q.x).unwrap();
                assert!(q.r <= ro + 1e-12, "cavity outside at {q:?}");
            }
            assert!(h.inner.windows(2).all(|w| w[1].x >= w[0].x - 1e-15));
        }
    }

    #[test]
    fn tube_and_tank() {
        let t = tube_profile(0.22, 0.12, 0.054, 0.0518);
        assert!(close(t.volume, 2.1937e-5, 1e-4));
        assert!(close(t.exposed.wetted_area, 2.0 * PI * 0.027 * 0.12, 1e-12));
        let flat = tank_profile(0.0, 0.5, 0.1, 0.005, EndCap::Flat);
        let v = PI * 0.05 * 0.05 * 0.5 - PI * 0.045 * 0.045 * 0.49;
        assert!(close(flat.volume, v, 1e-12));
        let hemi = tank_profile(0.0, 0.5, 0.1, 0.005, EndCap::Hemispherical);
        let v_out = 4.0 / 3.0 * PI * 0.05_f64.powi(3) + PI * 0.05 * 0.05 * 0.4;
        let v_in = 4.0 / 3.0 * PI * 0.045_f64.powi(3) + PI * 0.045 * 0.045 * 0.4;
        assert!(
            close(hemi.volume, v_out - v_in, 1e-8),
            "{} vs {}",
            hemi.volume,
            v_out - v_in
        );
        assert_eq!(hemi.inner.first().unwrap().r, 0.0);
        assert_eq!(hemi.inner.last().unwrap().r, 0.0);
    }

    #[test]
    fn radius_lookup() {
        let sh = EvalShoulder {
            length: 0.06,
            od: 0.048,
            thickness: 0.0,
            capped: false,
        };
        let p = nose_profile(0.0, NoseShape::Conical, 0.0, 0.2, 0.05, 0.0, Some(&sh));
        assert!(close(radius_at(&p.outer, 0.1).unwrap(), 0.0125, 1e-12));
        // At the step the larger radius wins.
        assert!(close(radius_at(&p.outer, 0.2).unwrap(), 0.025, 1e-12));
        assert!(close(radius_at(&p.outer, 0.25).unwrap(), 0.024, 1e-12));
        assert!(radius_at(&p.outer, 0.3).is_none());
    }
}
