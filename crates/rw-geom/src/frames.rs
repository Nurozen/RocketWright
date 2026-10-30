//! Coordinate frames and sign conventions (G §4.10; table in `docs/frames.md`).
//!
//! - Station x: metres from the nose tip, +aft.
//! - Body frame: +X aft (along the station axis), +Z up in the side view,
//!   +Y = Z × X. Roll φ is a right-handed rotation about +X measured from
//!   +Y (φ = +90° puts a fin on +Z).
//! - Component-local frame: the body frame of the component at roll 0 and
//!   zero offset. Fins and rail buttons are built standing on +Y; parts with
//!   their own axis (lugs, tube fins, clustered tubes) are built on the X axis.
//!   An instance places local geometry by `p_body = Rx(roll)·p_local + offset`.
//! - Fin cant δ: right-handed rotation of the fin plate about its outward span
//!   axis through the root mid-chord. δ > 0 turns the chord (LE→TE) from +X
//!   toward −Z on a fin at φ = 0, which gives a positive rolling moment about
//!   +X in forward flight. This equals RocketPy's `cant_angle` sign.

use std::collections::BTreeMap;

use rw_model::ComponentType;

use crate::types::{ComponentGeometry, FinGeometry, Geometry, InstanceGeometry};

/// Rotates `v` about +X by `roll` (right-handed: +Y toward +Z).
/// cite: n/a frame rotation
pub fn roll_about_x(v: [f64; 3], roll: f64) -> [f64; 3] {
    let (s, c) = roll.sin_cos();
    [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]]
}

/// Places a component-local point in the body frame: Rx(roll)·p + offset.
/// cite: n/a frame transform
pub fn place(p: [f64; 3], inst: &InstanceGeometry) -> [f64; 3] {
    let q = roll_about_x(p, inst.roll);
    [
        q[0] + inst.offset[0],
        q[1] + inst.offset[1],
        q[2] + inst.offset[2],
    ]
}

/// Rotates `v` about +Y by `angle` (right-handed: +Z toward +X, so +X → −Z).
/// cite: n/a frame rotation
pub fn rotate_about_y(v: [f64; 3], angle: f64) -> [f64; 3] {
    let (s, c) = angle.sin_cos();
    [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]]
}

/// Root mid-chord station of a fin set (the cant pivot).
/// cite: n/a fin reference point
pub fn fin_pivot_x(fin: &FinGeometry) -> f64 {
    let xs = fin
        .planform
        .iter()
        .filter(|p| p[1].abs() < 1e-12)
        .map(|p| p[0]);
    let (lo, hi) = xs.fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), x| {
        (a.min(x), b.max(x))
    });
    if lo.is_finite() { 0.5 * (lo + hi) } else { 0.0 }
}

/// Component-local position of planform point (x, y) at thickness offset z
/// (|z| ≤ t/2), with the cant applied about the root mid-chord.
/// cite: n/a frame transform
pub fn fin_local_point(fin: &FinGeometry, x: f64, y: f64, z: f64) -> [f64; 3] {
    let xp = fin_pivot_x(fin);
    let q = rotate_about_y([x - xp, 0.0, z], fin.cant);
    [xp + q[0], fin.root_radius + y, q[2]]
}

/// Body-frame position of planform point (x, y, z) on one fin instance.
/// cite: n/a frame transform
pub fn fin_point_body(
    fin: &FinGeometry,
    inst: &InstanceGeometry,
    x: f64,
    y: f64,
    z: f64,
) -> [f64; 3] {
    place(fin_local_point(fin, x, y, z), inst)
}

/// Unit chord direction (LE→TE) of a fin at absolute roll `roll`.
/// cite: n/a frame transform
pub fn fin_chord_dir(cant: f64, roll: f64) -> [f64; 3] {
    roll_about_x(rotate_about_y([1.0, 0.0, 0.0], cant), roll)
}

/// Unit span direction (root→tip) of a fin at absolute roll `roll`.
/// cite: n/a frame transform
pub fn fin_span_dir(roll: f64) -> [f64; 3] {
    roll_about_x([0.0, 1.0, 0.0], roll)
}

/// RocketPy `coordinate_system_orientation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RocketPyOrientation {
    /// `tail_to_nose` (RocketPy default, `_csys = 1`): +z points to the nose.
    TailToNose,
    /// `nose_to_tail` (`_csys = -1`).
    NoseToTail,
}

impl RocketPyOrientation {
    fn csys(self) -> f64 {
        match self {
            RocketPyOrientation::TailToNose => 1.0,
            RocketPyOrientation::NoseToTail => -1.0,
        }
    }
}

/// Station of a RocketPy axial position `z` given the nose-tip position.
/// cite: n/a frame mapping (RocketPy docs/user/positions.rst conventions)
pub fn station_from_rocketpy(z: f64, nose_tip_z: f64, o: RocketPyOrientation) -> f64 {
    o.csys() * (nose_tip_z - z)
}

/// Body-frame point of a RocketPy user-frame point `[x, y, z]`:
/// X = csys (z_nose − z), Y = y, Z = csys x (RocketPy x = our +Z for `tail_to_nose`).
/// cite: n/a frame mapping (RocketPy rocket.py set_rail_buttons, fin.py conventions)
pub fn body_from_rocketpy(p: [f64; 3], nose_tip_z: f64, o: RocketPyOrientation) -> [f64; 3] {
    let c = o.csys();
    [c * (nose_tip_z - p[2]), p[1], c * p[0]]
}

/// Body-frame direction of a RocketPy user-frame vector.
/// cite: n/a frame mapping
pub fn body_dir_from_rocketpy(v: [f64; 3], o: RocketPyOrientation) -> [f64; 3] {
    let c = o.csys();
    [-c * v[2], v[1], c * v[0]]
}

/// Our roll from RocketPy's `angular_position` (both from +Y; RocketPy turns
/// right-handed about the nose-pointing axis, we about +X aft): φ = −Γ.
/// cite: n/a frame mapping
pub fn roll_from_rocketpy(angular_position_rad: f64) -> f64 {
    -angular_position_rad
}

/// Our cant from RocketPy's `cant_angle` (same sign, see the module docs).
/// cite: n/a frame mapping
pub fn cant_from_rocketpy(cant_rad: f64) -> f64 {
    cant_rad
}

fn is_axial(t: ComponentType) -> bool {
    matches!(
        t,
        ComponentType::NoseCone | ComponentType::BodyTube | ComponentType::Transition
    )
}

/// Components mounted on the outside of a body (they follow their host).
/// cite: n/a component classification
pub fn is_surface(t: ComponentType) -> bool {
    matches!(
        t,
        ComponentType::TrapezoidalFinSet
            | ComponentType::EllipticalFinSet
            | ComponentType::FreeformFinSet
            | ComponentType::TubeFinSet
            | ComponentType::LaunchLug
            | ComponentType::RailButton
    )
}

/// Components inside the airframe (hidden by `MeshOptions::internals = false`).
/// cite: n/a component classification
pub fn is_internal(t: ComponentType) -> bool {
    !is_axial(t) && !is_surface(t)
}

/// Exploded-view displacement of every component at explode = 1, body frame
/// (pure +X). The external chain is laid out fore to aft with each body's
/// internal parts pulled out right behind it, separated by half a body
/// diameter, then centred so the assembly midpoint stays put. Surface parts
/// move with the body they sit on. Keys are component ids.
/// cite: n/a display layout, no physics
pub fn explode_dirs(geometry: &Geometry) -> BTreeMap<String, [f64; 3]> {
    let comps = &geometry.components;
    let gap = 0.5 * geometry.max_diameter.max(1e-3);
    let mut axial: Vec<usize> = (0..comps.len())
        .filter(|&i| is_axial(comps[i].kind) && !comps[i].cut)
        .collect();
    axial.sort_by(|&a, &b| comps[a].x_fore.total_cmp(&comps[b].x_fore).then(a.cmp(&b)));
    let host = |c: &ComponentGeometry| -> Option<usize> {
        let mid = 0.5 * (c.x_fore + c.x_aft);
        axial
            .iter()
            .copied()
            .find(|&a| mid >= comps[a].x_fore && mid <= comps[a].x_aft)
            .or_else(|| {
                axial.iter().copied().min_by(|&a, &b| {
                    let d = |k: usize| (comps[k].x_fore - mid).max(mid - comps[k].x_aft).max(0.0);
                    d(a).total_cmp(&d(b))
                })
            })
    };
    let hosts: Vec<Option<usize>> = comps.iter().map(host).collect();
    let mut order = Vec::new();
    for &a in &axial {
        order.push(a);
        let mut inner: Vec<usize> = (0..comps.len())
            .filter(|&i| {
                i != a
                    && hosts[i] == Some(a)
                    && !is_axial(comps[i].kind)
                    && !is_surface(comps[i].kind)
            })
            .collect();
        inner.sort_by(|&p, &q| {
            comps[p]
                .x_fore
                .total_cmp(&comps[q].x_fore)
                .then(comps[p].id.cmp(&comps[q].id))
        });
        order.extend(inner);
    }
    let mut dx = vec![0.0; comps.len()];
    let mut cursor: Option<f64> = None;
    for &i in &order {
        let (lo, hi) = (comps[i].bbox.min[0], comps[i].bbox.max[0]);
        let target = cursor.map_or(lo, |c| c.max(lo));
        dx[i] = target - lo;
        cursor = Some(target + (hi - lo) + gap);
    }
    let shift = order.iter().map(|&i| dx[i]).fold(0.0, f64::max) / 2.0;
    for &i in &order {
        dx[i] -= shift;
    }
    comps
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let d = if order.contains(&i) {
                dx[i]
            } else {
                hosts[i].map_or(0.0, |h| dx[h])
            };
            (c.id.clone(), [d, 0.0, 0.0])
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close3(a: [f64; 3], b: [f64; 3]) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-12)
    }

    #[test]
    fn roll_is_right_handed_about_x() {
        let q = std::f64::consts::FRAC_PI_2;
        assert!(close3(roll_about_x([0.0, 1.0, 0.0], q), [0.0, 0.0, 1.0]));
        assert!(close3(roll_about_x([0.0, 0.0, 1.0], q), [0.0, -1.0, 0.0]));
        assert!(close3(fin_span_dir(q), [0.0, 0.0, 1.0]));
    }

    #[test]
    fn positive_cant_turns_chord_toward_minus_z() {
        let d = fin_chord_dir(0.1, 0.0);
        assert!(d[0] > 0.0 && d[2] < 0.0 && d[1].abs() < 1e-15);
        // Flow +X past a fin on +Y whose TE points −Z is turned −Z; the reaction
        // on the fin is +Z at y = +r: moment (r ŷ) × (F ẑ) = +r F x̂.
        let force = [0.0, 0.0, -d[2]];
        let arm = [0.0, 1.0, 0.0];
        let mx = arm[1] * force[2] - arm[2] * force[1];
        assert!(mx > 0.0);
    }

    #[test]
    fn rocketpy_axes_are_a_proper_rotation() {
        for o in [
            RocketPyOrientation::TailToNose,
            RocketPyOrientation::NoseToTail,
        ] {
            let ex = body_dir_from_rocketpy([1.0, 0.0, 0.0], o);
            let ey = body_dir_from_rocketpy([0.0, 1.0, 0.0], o);
            let ez = body_dir_from_rocketpy([0.0, 0.0, 1.0], o);
            let cross = [
                ex[1] * ey[2] - ex[2] * ey[1],
                ex[2] * ey[0] - ex[0] * ey[2],
                ex[0] * ey[1] - ex[1] * ey[0],
            ];
            assert!(close3(cross, ez), "{o:?}");
        }
        // Station: tail_to_nose with the nose at z = 1.278 (RocketPy Calisto).
        let o = RocketPyOrientation::TailToNose;
        assert!((station_from_rocketpy(1.278, 1.278, o)).abs() < 1e-15);
        assert!((station_from_rocketpy(-1.04956, 1.278, o) - 2.32756).abs() < 1e-12);
        let n = RocketPyOrientation::NoseToTail;
        assert!((station_from_rocketpy(2.5, 0.2, n) - 2.3).abs() < 1e-12);
    }
}
