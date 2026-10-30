//! Signed-frame test against RocketPy conventions (G §4.10): stations, axis
//! direction, fin roll angles, fin cant sign, and rail-button angles for
//! RocketPy's "Calisto" example rocket (docs/user/first_simulation.rst),
//! re-expressed in our frame and built with `rw_geom::build`.
//!
//! The `rp` module below is the test oracle: RocketPy's fin rotation
//! matrices, leading-edge placement, flat-plate fin force, and rail-button
//! placement, transcribed to Rust.
//!
//! Ported from RocketPy (MIT) rocketpy/rocket/aero_surface/fins/fin.py:Fin.evaluate_rotation_matrix,
//! Fin._compute_leading_edge_position, Fin.compute_forces_and_moments; rocketpy/rocket/rocket.py:Rocket.set_rail_buttons
//! (RocketPy commit 9bd6ad3; Copyright (c) 2018 Giovani Hidalgo Ceotto, MIT License).

mod common;

use common::{close, close3, comp, model};
use rw_geom::frames::{
    RocketPyOrientation, body_dir_from_rocketpy, body_from_rocketpy, cant_from_rocketpy,
    fin_chord_dir, fin_point_body, fin_span_dir, place, roll_from_rocketpy, station_from_rocketpy,
};
use rw_geom::{Geometry, build};
use serde_json::json;

/// RocketPy's math, in RocketPy's internal body frame (+z toward the nose,
/// user frame = internal frame for `tail_to_nose`).
mod rp {
    pub type M = [[f64; 3]; 3];

    fn mul(a: M, b: M) -> M {
        let mut c = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                c[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
            }
        }
        c
    }

    pub fn t(a: M) -> M {
        let mut c = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                c[i][j] = a[j][i];
            }
        }
        c
    }

    pub fn apply(a: M, v: [f64; 3]) -> [f64; 3] {
        [0, 1, 2].map(|i| (0..3).map(|k| a[i][k] * v[k]).sum())
    }

    /// `Fin.evaluate_rotation_matrix`: (body→fin, fin→body uncanted).
    pub fn rotations(phi: f64, delta: f64) -> (M, M) {
        let (sp, cp) = phi.sin_cos();
        let (sd, cd) = delta.sin_cos();
        let r_phi = [[cp, -sp, 0.0], [sp, cp, 0.0], [0.0, 0.0, 1.0]];
        let r_delta = [[cd, 0.0, -sd], [0.0, 1.0, 0.0], [sd, 0.0, cd]];
        let r_pi = [[-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, -1.0]];
        let r_uncanted = mul(r_phi, r_pi);
        let r_body_to_fin = mul(r_delta, r_uncanted);
        (r_body_to_fin, t(r_uncanted))
    }

    /// `Fin._compute_leading_edge_position` for a scalar axial position.
    pub fn leading_edge(
        position: f64,
        radius: f64,
        phi: f64,
        delta: f64,
        cr: f64,
        csys: f64,
    ) -> [f64; 3] {
        let p = [-cr / 2.0 * delta.sin(), 0.0, cr / 2.0 * (1.0 - delta.cos())];
        let (_, fin_to_body_uncanted) = rotations(phi, delta);
        let p = apply(fin_to_body_uncanted, p);
        let p = [p[0] * csys, p[1], p[2] * csys];
        let base = [-radius * phi.sin() * csys, radius * phi.cos(), position];
        [base[0] + p[0], base[1] + p[1], base[2] + p[2]]
    }

    /// `Fin.compute_forces_and_moments` with a thin-plate lift slope 2π and no
    /// interference factors: returns the body-frame force and roll moment M3
    /// (about RocketPy's +z) for a fin whose centre of pressure is at `cp`.
    pub fn fin_roll_moment(
        phi: f64,
        delta: f64,
        stream_velocity: [f64; 3],
        cp: [f64; 3],
    ) -> ([f64; 3], f64) {
        let (body_to_fin, _) = rotations(phi, delta);
        let v = apply(body_to_fin, stream_velocity);
        let attack_angle = v[0].atan2(v[2]);
        let x = 2.0 * std::f64::consts::PI * attack_angle;
        let r = apply(t(body_to_fin), [x, 0.0, 0.0]);
        let m3 = cp[0] * r[1] - cp[1] * r[0];
        (r, m3)
    }

    /// `Rocket.set_rail_buttons` position vector.
    pub fn rail_button(radius: f64, angular_position_deg: f64, z: f64) -> [f64; 3] {
        let a = angular_position_deg.to_radians();
        [radius * -a.sin(), radius * a.cos(), z]
    }
}

// Calisto (tail_to_nose, origin at the dry CG), RocketPy docs.
const RADIUS: f64 = 127.0 / 2000.0;
const NOSE_POS: f64 = 1.278;
const NOSE_LEN: f64 = 0.55829;
const FIN_POS: f64 = -1.04956;
const ROOT: f64 = 0.120;
const TIP: f64 = 0.060;
const SPAN: f64 = 0.110;
const CANT_DEG: f64 = 0.5;
const TAIL_POS: f64 = -1.194656;
const TAIL_LEN: f64 = 0.060;
const TAIL_BOTTOM_R: f64 = 0.0435;
const BUTTONS: [f64; 2] = [0.0818, -0.6182];
const BUTTON_ANGLE_DEG: f64 = 45.0;
/// First fin's RocketPy angular position; non-zero so roll signs matter.
const FIN0_DEG: f64 = 10.0;
const O: RocketPyOrientation = RocketPyOrientation::TailToNose;

fn st(z: f64) -> f64 {
    station_from_rocketpy(z, NOSE_POS, O)
}

/// RocketPy angular position of fin k (RocketPy's own sense).
fn gamma(k: usize) -> f64 {
    (FIN0_DEG + 90.0 * k as f64).to_radians()
}

fn calisto() -> Geometry {
    let tail_fore = st(TAIL_POS);
    let fins_x = st(FIN_POS);
    let mut fins = comp(
        "fins",
        Some("body"),
        fins_x,
        fins_x + ROOT,
        json!({
            "type": "trapezoidal_fin_set", "count": 4, "thickness": 0.003, "cross_section": "square",
            "cant": cant_from_rocketpy(CANT_DEG.to_radians()), "fillet_radius": 0.0,
            "root_chord": ROOT, "tip_chord": TIP, "span": SPAN,
            // RocketPy's default sweep: root − tip (right trapezoid, square TE).
            "sweep": ROOT - TIP
        }),
    );
    fins["instances"] = json!((0..4)
        .map(|k| json!({ "index": k, "pattern": "radial", "offset": [0.0, 0.0, 0.0], "roll": roll_from_rocketpy(gamma(k)) }))
        .collect::<Vec<_>>());
    let lower = st(BUTTONS[1]);
    let mut buttons = comp(
        "buttons",
        Some("body"),
        lower - 0.005,
        lower + 0.005,
        json!({
            "type": "rail_button", "od": 0.01, "id": 0.006, "height": 0.008
        }),
    );
    buttons["roll"] = json!(roll_from_rocketpy(BUTTON_ANGLE_DEG.to_radians()));
    buttons["instances"] = json!([
        { "index": 0, "pattern": "linear", "offset": [0.0, 0.0, 0.0], "roll": 0.0 },
        { "index": 1, "pattern": "linear", "offset": [st(BUTTONS[0]) - lower, 0.0, 0.0], "roll": 0.0 }
    ]);
    let comps = vec![
        comp(
            "nose",
            None,
            0.0,
            NOSE_LEN,
            json!({
                "type": "nose_cone", "shape": "haack", "shape_param": 0.0, "length": NOSE_LEN,
                "od": 2.0 * RADIUS, "thickness": 0.0
            }),
        ),
        comp(
            "body",
            Some("nose"),
            NOSE_LEN,
            tail_fore,
            json!({
                "type": "body_tube", "length": tail_fore - NOSE_LEN, "od": 2.0 * RADIUS, "id": 2.0 * RADIUS - 0.004
            }),
        ),
        fins,
        buttons,
        comp(
            "tail",
            Some("body"),
            tail_fore,
            tail_fore + TAIL_LEN,
            json!({
                "type": "transition", "shape": "conical", "shape_param": 0.0, "length": TAIL_LEN,
                "fore_od": 2.0 * RADIUS, "aft_od": 2.0 * TAIL_BOTTOM_R, "thickness": 0.0
            }),
        ),
    ];
    build(&model(comps, 2.0 * RADIUS))
}

fn get<'a>(g: &'a Geometry, id: &str) -> &'a rw_geom::ComponentGeometry {
    g.components.iter().find(|c| c.id == id).unwrap()
}

#[test]
fn stations_and_axis_direction() {
    let g = calisto();
    // Nose tip is station 0; +X runs aft (toward RocketPy −z for tail_to_nose).
    let nose = get(&g, "nose");
    assert_eq!((nose.outer[0].x, nose.outer[0].r), (0.0, 0.0));
    assert!(close3(
        body_from_rocketpy([0.0, 0.0, NOSE_POS], NOSE_POS, O),
        [0.0; 3],
        1e-15
    ));
    assert!(close3(
        body_dir_from_rocketpy([0.0, 0.0, -1.0], O),
        [1.0, 0.0, 0.0],
        0.0
    ));
    // Fin root LE: RocketPy z = −1.04956 → x = 1.278 + 1.04956.
    let fins = get(&g, "fins").fins.as_ref().unwrap();
    assert!(close(fins.planform[0][0], 2.32756, 1e-12));
    // Tail aft end is the aftmost point: x = 1.278 + 1.194656 + 0.06.
    assert!(close(g.length, 2.532656, 1e-12));
    let tail = get(&g, "tail");
    assert!(close(tail.outer.last().unwrap().r, TAIL_BOTTOM_R, 1e-12));
    // Ordering along +X matches RocketPy's decreasing z.
    let xs = ["nose", "body", "fins", "tail"].map(|id| get(&g, id).x_fore);
    assert!(xs.windows(2).all(|w| w[0] < w[1]));
    // nose_to_tail with the origin at the tip maps z straight to x.
    let n = RocketPyOrientation::NoseToTail;
    assert!(close3(
        body_from_rocketpy([0.0, 0.0, 2.0], 0.0, n),
        [2.0, 0.0, 0.0],
        1e-15
    ));
}

#[test]
fn fin_leading_edges_match_rocketpy() {
    let g = calisto();
    let c = get(&g, "fins");
    let fin = c.fins.as_ref().unwrap();
    let delta = CANT_DEG.to_radians();
    let x_le = st(FIN_POS);
    for (k, inst) in c.instances.iter().enumerate() {
        let ours = fin_point_body(fin, inst, x_le, 0.0, 0.0);
        let theirs = body_from_rocketpy(
            rp::leading_edge(FIN_POS, RADIUS, gamma(k), delta, ROOT, 1.0),
            NOSE_POS,
            O,
        );
        assert!(
            close3(ours, theirs, 1e-12),
            "fin {k}: {ours:?} vs {theirs:?}"
        );
        // Same through the nose_to_tail user frame (origin at the nose tip).
        let n2t = rp::leading_edge(st(FIN_POS), RADIUS, gamma(k), delta, ROOT, -1.0);
        let theirs2 = body_from_rocketpy(n2t, 0.0, RocketPyOrientation::NoseToTail);
        assert!(close3(ours, theirs2, 1e-12), "fin {k} (nose_to_tail)");
    }
}

#[test]
fn fin_axes_match_rocketpy() {
    let g = calisto();
    let c = get(&g, "fins");
    let delta = CANT_DEG.to_radians();
    for (k, inst) in c.instances.iter().enumerate() {
        let (body_to_fin, _) = rp::rotations(gamma(k), delta);
        let fin_to_body = rp::t(body_to_fin);
        // Fin z = LE→TE chord, fin y = span (RocketPy fin frame).
        let chord = body_dir_from_rocketpy(rp::apply(fin_to_body, [0.0, 0.0, 1.0]), O);
        let span = body_dir_from_rocketpy(
            rp::apply(rp::t(rp::rotations(gamma(k), 0.0).0), [0.0, 1.0, 0.0]),
            O,
        );
        assert!(
            close3(
                fin_chord_dir(c.fins.as_ref().unwrap().cant, inst.roll),
                chord,
                1e-12
            ),
            "chord {k}"
        );
        assert!(close3(fin_span_dir(inst.roll), span, 1e-12), "span {k}");
    }
    // First fin at RocketPy 10°: our roll is −10° (toward −Z from +Y).
    assert!(close(c.instances[0].roll, -FIN0_DEG.to_radians(), 1e-15));
    assert!(fin_span_dir(c.instances[0].roll)[2] < 0.0);
}

#[test]
fn positive_cant_rolls_positive_about_plus_x() {
    // RocketPy: a positive cant gives a negative moment about its +z (nose);
    // our +X points aft, so the same moment is positive about +X.
    let delta = CANT_DEG.to_radians();
    let v = [0.0, 0.0, -50.0]; // nose-first flight: air moves toward −z
    let mut total = 0.0;
    for k in 0..4 {
        let phi = gamma(k);
        let cp = [-RADIUS * 1.5 * phi.sin(), RADIUS * 1.5 * phi.cos(), FIN_POS];
        let (_, m3) = rp::fin_roll_moment(phi, delta, v, cp);
        assert!(m3 < 0.0, "fin {k}: RocketPy M3 = {m3}");
        let ours = body_dir_from_rocketpy([0.0, 0.0, m3], O);
        assert!(ours[0] > 0.0);
        total += ours[0];
    }
    assert!(total > 0.0);
    // Zero cant: no roll moment.
    let (_, m0) = rp::fin_roll_moment(0.3, 0.0, v, [0.0, RADIUS, 0.0]);
    assert!(m0.abs() < 1e-12);
}

#[test]
fn rail_buttons_match_rocketpy_angles() {
    let g = calisto();
    let b = get(&g, "buttons");
    let base = b.outer[0].x; // spool base radius (distance from the axis)
    assert!(close(base, RADIUS, 1e-12));
    let xc = 0.5 * (b.x_fore + b.x_aft);
    for (inst, z) in b.instances.iter().zip([BUTTONS[1], BUTTONS[0]]) {
        let ours = place([xc, base, 0.0], inst);
        let theirs = body_from_rocketpy(rp::rail_button(RADIUS, BUTTON_ANGLE_DEG, z), NOSE_POS, O);
        assert!(close3(ours, theirs, 1e-12), "{ours:?} vs {theirs:?}");
    }
    // 45° in RocketPy puts the buttons at −Z (RocketPy x = −r sin 45°).
    assert!(place([xc, base, 0.0], &b.instances[0])[2] < 0.0);
}
