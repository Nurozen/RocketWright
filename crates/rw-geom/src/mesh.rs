//! Triangle meshes in the component-local frame (see `frames`): solids of
//! revolution from profiles, fin plates, and rail-button spools. Front faces
//! are counter-clockwise seen from outside (glTF convention).

use crate::fins::{polygon_area_signed, triangulate};
use crate::frames::{fin_local_point, rotate_about_y};
use crate::types::{FinGeometry, ProfilePoint};

/// Indexed triangle mesh with per-vertex normals.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mesh {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
}

impl Mesh {
    fn push(&mut self, p: [f64; 3], n: [f64; 3]) -> u32 {
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        let n = if l > 0.0 {
            [n[0] / l, n[1] / l, n[2] / l]
        } else {
            [1.0, 0.0, 0.0]
        };
        self.positions.push(p.map(|v| v as f32));
        self.normals.push(n.map(|v| v as f32));
        (self.positions.len() - 1) as u32
    }

    /// Axis-aligned bounds of the positions (zeros when empty).
    /// cite: n/a pure geometry
    pub fn bounds(&self) -> ([f32; 3], [f32; 3]) {
        if self.positions.is_empty() {
            return ([0.0; 3], [0.0; 3]);
        }
        let mut lo = [f32::INFINITY; 3];
        let mut hi = [f32::NEG_INFINITY; 3];
        for p in &self.positions {
            for (k, v) in p.iter().enumerate() {
                lo[k] = lo[k].min(*v);
                hi[k] = hi[k].max(*v);
            }
        }
        (lo, hi)
    }

    /// True when there are no triangles.
    /// cite: n/a container query
    pub fn is_empty(&self) -> bool {
        self.indices.is_empty()
    }

    /// Applies a linear map (rotation/permutation, det = +1) and translation.
    fn map(&mut self, m: [[f64; 3]; 3], t: [f64; 3]) {
        let mul = |v: [f64; 3]| {
            [
                m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
                m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
                m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
            ]
        };
        for p in &mut self.positions {
            let q = mul(p.map(f64::from));
            *p = [q[0] + t[0], q[1] + t[1], q[2] + t[2]].map(|v| v as f32);
        }
        for n in &mut self.normals {
            *n = mul(n.map(f64::from)).map(|v| v as f32);
        }
    }
}

/// Closed meridian polygon (x, r) of the material between `outer` and the
/// cavity `inner`, closing along the axis where either profile does not reach it.
/// cite: n/a pure geometry
pub fn meridian_polygon(outer: &[ProfilePoint], inner: &[ProfilePoint]) -> Vec<ProfilePoint> {
    let (Some(&of), Some(&ol)) = (outer.first(), outer.last()) else {
        return Vec::new();
    };
    let axis = |x: f64| ProfilePoint { x, r: 0.0 };
    let mut poly: Vec<ProfilePoint> = outer.to_vec();
    // Joins A (current end) to B through the axis when their stations differ.
    let join = |poly: &mut Vec<ProfilePoint>, a: ProfilePoint, b: ProfilePoint| {
        if (a.x - b.x).abs() > 1e-15 {
            if a.r > 0.0 {
                poly.push(axis(a.x));
            }
            if b.r > 0.0 {
                poly.push(axis(b.x));
            }
        }
    };
    match (inner.first(), inner.last()) {
        (Some(&inf), Some(&inl)) => {
            join(&mut poly, ol, inl);
            poly.extend(inner.iter().rev().copied());
            join(&mut poly, inf, of);
        }
        _ => {
            if ol.r > 0.0 {
                poly.push(axis(ol.x));
            }
            if of.r > 0.0 {
                poly.push(axis(of.x));
            }
        }
    }
    poly.dedup_by(|a, b| (a.x - b.x).abs() < 1e-15 && (a.r - b.r).abs() < 1e-15);
    while poly.len() > 1 && poly.first() == poly.last() {
        poly.pop();
    }
    poly
}

/// Revolves the material between `outer` and `inner` about the local X axis.
/// Normals are smoothed across vertices where the meridian turns < 35°.
/// cite: n/a pure geometry (surface of revolution)
pub fn revolve(outer: &[ProfilePoint], inner: &[ProfilePoint], segments: u32) -> Mesh {
    let poly = meridian_polygon(outer, inner);
    let mut mesh = Mesh::default();
    let n = poly.len();
    if n < 2 {
        return mesh;
    }
    let seg = segments.clamp(3, 1024) as usize;
    let sign = {
        let a: f64 = (0..n)
            .map(|i| {
                let (p, q) = (poly[i], poly[(i + 1) % n]);
                p.x * q.r - q.x * p.r
            })
            .sum();
        if a < 0.0 { 1.0 } else { -1.0 } // clockwise → outward is left of travel
    };
    let edge_n = |i: usize| -> Option<[f64; 2]> {
        let (p, q) = (poly[i], poly[(i + 1) % n]);
        let (dx, dr) = (q.x - p.x, q.r - p.r);
        let l = dx.hypot(dr);
        (l > 1e-15).then(|| [sign * -dr / l, sign * dx / l])
    };
    let normals: Vec<Option<[f64; 2]>> = (0..n).map(edge_n).collect();
    let smooth = |a: [f64; 2], b: [f64; 2]| -> [f64; 2] {
        if a[0] * b[0] + a[1] * b[1] > 35f64.to_radians().cos() {
            let s = [a[0] + b[0], a[1] + b[1]];
            let l = s[0].hypot(s[1]);
            [s[0] / l, s[1] / l]
        } else {
            a
        }
    };
    let prev_n = |i: usize| -> Option<[f64; 2]> {
        (1..n)
            .map(|k| normals[(i + n - k) % n])
            .find(|v| v.is_some())
            .flatten()
    };
    let next_n = |i: usize| -> Option<[f64; 2]> {
        (1..n)
            .map(|k| normals[(i + k) % n])
            .find(|v| v.is_some())
            .flatten()
    };
    let angles: Vec<(f64, f64)> = (0..=seg)
        .map(|j| {
            let t = std::f64::consts::TAU * j as f64 / seg as f64;
            (t.cos(), t.sin())
        })
        .collect();
    for i in 0..n {
        let Some(ne) = normals[i] else { continue };
        let (p, q) = (poly[i], poly[(i + 1) % n]);
        if p.r <= 0.0 && q.r <= 0.0 {
            continue;
        }
        let np = prev_n(i).map_or(ne, |o| smooth(ne, o));
        let nq = next_n(i).map_or(ne, |o| smooth(ne, o));
        let ring = |mesh: &mut Mesh, a: ProfilePoint, nn: [f64; 2]| -> Vec<u32> {
            angles
                .iter()
                .map(|&(c, s)| mesh.push([a.x, a.r * c, a.r * s], [nn[0], nn[1] * c, nn[1] * s]))
                .collect()
        };
        let rp = ring(&mut mesh, p, np);
        let rq = ring(&mut mesh, q, nq);
        for j in 0..seg {
            if p.r > 0.0 {
                mesh.indices.extend([rp[j], rp[j + 1], rq[j]]);
            }
            if q.r > 0.0 {
                mesh.indices.extend([rq[j], rp[j + 1], rq[j + 1]]);
            }
        }
    }
    mesh
}

/// Extrudes CCW polygons (planform frame) to plates of thickness `t`, mapping
/// planform points through `to_local(x, y, z)`; `normal_map` rotates normals.
fn plate_from_polys(
    polys: &[Vec<[f64; 2]>],
    t: f64,
    to_local: impl Fn(f64, f64, f64) -> [f64; 3],
    normal_map: impl Fn([f64; 3]) -> [f64; 3],
) -> Mesh {
    let mut mesh = Mesh::default();
    let h = 0.5 * t.max(1e-6);
    for poly in polys {
        let mut poly = poly.clone();
        if poly.len() < 3 {
            continue;
        }
        if polygon_area_signed(&poly) < 0.0 {
            poly.reverse();
        }
        let tris = triangulate(&poly);
        for (z, nz) in [(h, 1.0), (-h, -1.0)] {
            let nn = normal_map([0.0, 0.0, nz]);
            let base: Vec<u32> = poly
                .iter()
                .map(|p| mesh.push(to_local(p[0], p[1], z), nn))
                .collect();
            for tri in &tris {
                if nz > 0.0 {
                    mesh.indices
                        .extend([base[tri[0]], base[tri[1]], base[tri[2]]]);
                } else {
                    mesh.indices
                        .extend([base[tri[0]], base[tri[2]], base[tri[1]]]);
                }
            }
        }
        let m = poly.len();
        for i in 0..m {
            let (a, b) = (poly[i], poly[(i + 1) % m]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            if dx.hypot(dy) < 1e-15 {
                continue;
            }
            let nn = normal_map([dy, -dx, 0.0]);
            let ab = mesh.push(to_local(a[0], a[1], -h), nn);
            let bb = mesh.push(to_local(b[0], b[1], -h), nn);
            let bt = mesh.push(to_local(b[0], b[1], h), nn);
            let at = mesh.push(to_local(a[0], a[1], h), nn);
            mesh.indices.extend([ab, bb, bt, ab, bt, at]);
        }
    }
    mesh
}

/// One fin plate (planform plus tab) in the component-local frame: standing
/// on +Y from the root radius, canted about the root mid-chord.
/// cite: n/a pure geometry (plate extrusion)
pub fn fin_plate(fin: &FinGeometry) -> Mesh {
    let mut polys = vec![fin.planform.clone()];
    if let Some(tab) = &fin.tab {
        polys.push(tab.clone());
    }
    plate_from_polys(
        &polys,
        fin.thickness,
        |x, y, z| fin_local_point(fin, x, y, z),
        |v| rotate_about_y(v, fin.cant),
    )
}

/// Meridian of a rail-button spool along its own (radial) axis: `x` is the
/// distance from the body axis (base at `base_r`), `r` the spool radius:
/// base (`base_h`, od), neck (id), flange (`flange_h`, od). Base and flange
/// heights are clamped so the neck height is never negative.
/// cite: n/a pure geometry (rail-button shape)
pub fn rail_button_profile(
    base_r: f64,
    od: f64,
    id: f64,
    height: f64,
    base_h: f64,
    flange_h: f64,
) -> Vec<ProfilePoint> {
    let (ro, ri, h) = (0.5 * od, 0.5 * id.min(od), height.max(0.0));
    let b = base_h.clamp(0.0, h);
    let f = flange_h.clamp(0.0, h - b);
    let p = |x: f64, r: f64| ProfilePoint { x: base_r + x, r };
    vec![
        p(0.0, ro),
        p(b, ro),
        p(b, ri),
        p(h - f, ri),
        p(h - f, ro),
        p(h, ro),
    ]
}

/// Rail-button spool at station `x_c` standing on +Y (profile from
/// [`rail_button_profile`]).
/// cite: n/a pure geometry (rail-button display shape)
pub fn rail_button(x_c: f64, profile: &[ProfilePoint], segments: u32) -> Mesh {
    let mut mesh = revolve(profile, &[], segments);
    // (a, b, c) → (b, a, -c): the spool axis X becomes +Y, det = +1.
    mesh.map(
        [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0]],
        [x_c, 0.0, 0.0],
    );
    mesh
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(x: f64, r: f64) -> ProfilePoint {
        ProfilePoint { x, r }
    }

    /// Signed volume from the divergence theorem: Σ (a · (b × c)) / 6.
    fn mesh_volume(m: &Mesh) -> f64 {
        m.indices
            .chunks(3)
            .map(|t| {
                let [a, b, c] = [0, 1, 2].map(|k| m.positions[t[k] as usize].map(f64::from));
                (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                    + a[2] * (b[0] * c[1] - b[1] * c[0]))
                    / 6.0
            })
            .sum()
    }

    #[test]
    fn revolved_tube_is_closed_and_outward() {
        let outer = [pt(0.0, 0.027), pt(0.3, 0.027)];
        let inner = [pt(0.0, 0.0259), pt(0.3, 0.0259)];
        let m = revolve(&outer, &inner, 256);
        let exact = std::f64::consts::PI * (0.027f64.powi(2) - 0.0259f64.powi(2)) * 0.3;
        let v = mesh_volume(&m);
        // A 256-gon underestimates πr² by ~1e-4 relative; positive = outward winding.
        assert!((v - exact).abs() / exact < 1e-3, "{v} vs {exact}");
        let (lo, hi) = m.bounds();
        assert!((hi[1] - 0.027).abs() < 1e-6 && (lo[0]).abs() < 1e-9 && (hi[0] - 0.3).abs() < 1e-6);
    }

    #[test]
    fn solid_cone_volume() {
        let outer = [pt(0.0, 0.0), pt(0.2, 0.03)];
        let m = revolve(&outer, &[], 512);
        let exact = std::f64::consts::PI * 0.03 * 0.03 * 0.2 / 3.0;
        assert!((mesh_volume(&m) - exact).abs() / exact < 1e-3);
    }

    #[test]
    fn meridian_closes_through_axis() {
        // Capped cavity: inner ends on the axis before the outer end.
        let outer = [pt(0.0, 0.0), pt(0.1, 0.02), pt(0.1, 0.018), pt(0.15, 0.018)];
        let inner = [
            pt(0.02, 0.0),
            pt(0.1, 0.015),
            pt(0.148, 0.015),
            pt(0.148, 0.0),
        ];
        let poly = meridian_polygon(&outer, &inner);
        assert!(poly.contains(&pt(0.15, 0.0)));
        let m = revolve(&outer, &inner, 128);
        assert!(mesh_volume(&m) > 0.0);
    }

    #[test]
    fn plate_volume_matches() {
        let fin = FinGeometry {
            count: 1,
            planform: vec![[0.0, 0.0], [0.1, 0.0], [0.08, 0.05], [0.04, 0.05]],
            tab: None,
            root_radius: 0.02,
            thickness: 0.004,
            cross_section: rw_model::FinCrossSection::Square,
            cant: 0.2,
            fillet_radius: 0.0,
            roll: vec![0.0],
            span: 0.05,
            root_chord: 0.1,
            tip_chord: 0.04,
            mid_chord_sweep_length: 0.01,
            mean_aero_chord: 0.0,
        };
        let m = fin_plate(&fin);
        let exact = 0.5 * (0.1 + 0.04) * 0.05 * 0.004;
        assert!(
            (mesh_volume(&m) - exact).abs() / exact < 1e-5,
            "{}",
            mesh_volume(&m)
        );
    }

    #[test]
    fn rail_button_stands_on_plus_y() {
        let m = rail_button(
            0.5,
            &rail_button_profile(0.027, 0.01, 0.006, 0.008, 0.002, 0.002),
            32,
        );
        let (lo, hi) = m.bounds();
        assert!((lo[1] - 0.027).abs() < 1e-6 && (hi[1] - 0.035).abs() < 1e-6);
        assert!((lo[0] - 0.495).abs() < 1e-6 && (hi[0] - 0.505).abs() < 1e-6);
        assert!(mesh_volume(&m) > 0.0);
    }
}
