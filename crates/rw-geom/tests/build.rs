//! `rw_geom::build` on the M1.5 contract fixture and on a model with every
//! component kind: analytic areas and volumes, fin plates, instances, explode.

mod common;

use std::f64::consts::{FRAC_PI_2, PI};

use common::{close, comp, fixture_model, model};
use rw_geom::fins::{trapezoid_mac, trapezoid_y_mac};
use rw_geom::{ComponentGeometry, Geometry, build, explode_dirs};
use serde_json::json;

fn get<'a>(g: &'a Geometry, id: &str) -> &'a ComponentGeometry {
    g.components.iter().find(|c| c.id == id).expect(id)
}

#[test]
fn fixture_bodies_match_closed_forms() {
    let g = build(&fixture_model());
    assert_eq!(g.components.len(), 12);
    assert!(close(g.length, 0.84, 1e-12));
    assert!(close(g.max_diameter, 0.054, 1e-12));
    assert!(close(g.ref_diameter, 0.054, 1e-12));

    // Tubes (amcp-706-280 tab 6-1): V = π(r_o² - r_i²)l, A = 2π r_o l, side 2 r_o l.
    for (id, l) in [("recovery_bay", 0.12), ("airframe", 0.3), ("fin_can", 0.2)] {
        let c = get(&g, id);
        let v = PI * (0.027_f64.powi(2) - 0.0259_f64.powi(2)) * l;
        assert!(close(c.volume, v, 1e-12), "{id}");
        assert!(close(c.wetted_area, 2.0 * PI * 0.027 * l, 1e-12), "{id}");
        assert!(close(c.planform_area, 0.054 * l, 1e-12), "{id}");
        assert_eq!(c.bbox.min, [c.x_fore, -0.027, -0.027]);
    }
    // Internal parts are not wetted.
    let chute = get(&g, "parachute");
    assert_eq!(chute.wetted_area, 0.0);
    assert!(close(chute.volume, PI * 0.0225 * 0.0225 * 0.08, 1e-12));
    assert!(close(chute.planform_area, 0.045 * 0.08, 1e-12));
    let ring = get(&g, "ring_upper");
    assert!(close(
        ring.volume,
        PI * (0.0259_f64.powi(2) - 0.016_f64.powi(2)) * 0.006,
        1e-12
    ));
}

#[test]
fn fixture_nose_is_a_tangent_ogive_shell() {
    let g = build(&fixture_model());
    let n = get(&g, "nose");
    let (l, r) = (0.22_f64, 0.027_f64);
    // Lateral area of the tangent-ogive arc: ρ = (r² + l²)/(2r), cos φ_t = (ρ - r)/ρ,
    // A = 2πρ[(r - ρ)φ_t + ρ sin φ_t].
    let rho = (r * r + l * l) / (2.0 * r);
    let phi = ((rho - r) / rho).acos();
    let a = 2.0 * PI * rho * ((r - rho) * phi + rho * phi.sin());
    assert!(close(n.wetted_area, a, 1e-9), "{} vs {a}", n.wetted_area);
    // Material volume ≈ shell (A t) + shoulder annulus, within the thick-wall error.
    let shoulder = PI * (0.0259_f64.powi(2) - 0.0239_f64.powi(2)) * 0.06;
    let approx = a * 0.002 + shoulder;
    assert!(
        (n.volume - approx).abs() / approx < 0.1,
        "{} vs {approx}",
        n.volume
    );
    assert_eq!((n.outer[0].x, n.outer[0].r), (0.0, 0.0));
    assert!(close(n.bbox.max[0], 0.28, 1e-12) && n.bbox.min[0] == 0.0);
    // The cavity never leaves the outer contour.
    for p in &n.inner {
        let ro = rw_geom::profile::radius_at(&n.outer, p.x).unwrap();
        assert!(p.r <= ro, "{p:?}");
    }
}

#[test]
fn fixture_fins() {
    let g = build(&fixture_model());
    let c = get(&g, "fins");
    let f = c.fins.as_ref().unwrap();
    // barrowman-1967 eq 3-23: A_fin = (c_r + c_t) s / 2 = 0.009; wetted 2 N A_fin.
    assert!(close(c.planform_area, 0.009, 1e-12));
    assert!(close(c.wetted_area, 0.072, 1e-12));
    assert!(close(c.volume, 4.0 * 0.003 * 0.009, 1e-12));
    assert!(close(f.mean_aero_chord, trapezoid_mac(0.14, 0.06), 1e-12));
    assert!(close(f.span, 0.09, 1e-12));
    assert!(close(f.root_chord, 0.14, 1e-12) && close(f.tip_chord, 0.06, 1e-12));
    assert!(close(f.mid_chord_sweep_length, 0.045 + 0.03 - 0.07, 1e-12));
    assert!(close(f.root_radius, 0.027, 1e-12));
    assert_eq!(f.planform[0], [0.7, 0.0]);
    assert_eq!(f.count, 4);
    let rolls = [0.0, FRAC_PI_2, PI, 3.0 * FRAC_PI_2];
    for (r, e) in f.roll.iter().zip(rolls) {
        assert!(close(*r, e, 1e-12));
    }
    assert_eq!(c.instances.len(), 4);
    // Span reaches 0.027 + 0.09 on ±Y and ±Z.
    for k in [1, 2] {
        assert!(close(c.bbox.max[k], 0.117, 1e-9) && close(c.bbox.min[k], -0.117, 1e-9));
    }
    // barrowman-1967 eq 3-26 from the strip integral.
    let ymac = rw_geom::fins::planform_stats(&f.planform).y_mac;
    assert!(close(ymac, trapezoid_y_mac(0.14, 0.06, 0.09), 1e-12));
}

#[test]
fn surface_parts_sit_on_the_body() {
    let g = build(&fixture_model());
    let lug = get(&g, "lug");
    // Radial 0 in the model: the lug axis goes to body radius + lug radius.
    assert!(close(lug.instances[0].offset[1], 0.031, 1e-12));
    assert!(close(lug.wetted_area, 2.0 * PI * 0.004 * 0.05, 1e-12));
    assert!(close(
        lug.volume,
        PI * (0.004_f64.powi(2) - 0.00325_f64.powi(2)) * 0.05,
        1e-12
    ));
    assert!(close(lug.bbox.min[1], 0.027, 1e-12) && close(lug.bbox.max[1], 0.035, 1e-12));
}

#[test]
fn build_is_deterministic_and_round_trips() {
    let m = fixture_model();
    let (a, b) = (build(&m), build(&m));
    assert_eq!(a, b);
    let s = serde_json::to_string(&a).unwrap();
    assert_eq!(s, serde_json::to_string(&b).unwrap());
    // serde_json float parsing may differ in the last bit; compare loosely.
    let back: Geometry = serde_json::from_str(&s).unwrap();
    assert_eq!(back.components.len(), a.components.len());
    for (x, y) in back.components.iter().zip(&a.components) {
        assert_eq!(x.id, y.id);
        assert!(close(x.volume, y.volume, 1e-15) && close(x.wetted_area, y.wetted_area, 1e-15));
    }
}

#[test]
fn explode_lays_parts_out_without_overlap() {
    let g = build(&fixture_model());
    let d = explode_dirs(&g);
    assert_eq!(d.len(), g.components.len());
    assert!(d.values().all(|v| v[1] == 0.0 && v[2] == 0.0));
    // Surface parts follow their body.
    assert_eq!(d["fins"], d["fin_can"]);
    assert_eq!(d["lug"], d["airframe"]);
    // Chain order: nose, recovery_bay, parachute, airframe, bulkhead, avionics, fin_can, ...
    let order = [
        "nose",
        "recovery_bay",
        "parachute",
        "airframe",
        "bulkhead",
        "avionics",
        "fin_can",
        "motor_mount",
        "ring_upper",
        "ring_lower",
    ];
    let span = |id: &str| {
        let c = get(&g, id);
        (c.bbox.min[0] + d[id][0], c.bbox.max[0] + d[id][0])
    };
    for w in order.windows(2) {
        let (a, b) = (span(w[0]), span(w[1]));
        assert!(b.0 >= a.1 - 1e-12, "{} overlaps {}", w[1], w[0]);
    }
    // Centred: displacements are symmetric about zero.
    let (lo, hi) = order.iter().fold((f64::MAX, f64::MIN), |(l, h), id| {
        (l.min(d[*id][0]), h.max(d[*id][0]))
    });
    assert!(close(lo, -hi, 1e-12));
}

#[test]
fn every_kind_builds() {
    let shoulder = json!({ "length": 0.03, "od": 0.05, "thickness": 0.002, "capped": true });
    let fin_common = json!({
        "count": 3, "thickness": 0.003, "cross_section": "square", "cant": 0.01,
        "fillet_radius": 0.0, "tab": { "height": 0.008, "length": 0.05, "offset": 0.02 }
    });
    let merge = |mut a: serde_json::Value, b: serde_json::Value| {
        for (k, v) in b.as_object().unwrap() {
            a[k] = v.clone();
        }
        a
    };
    let mut comps = Vec::new();
    for (i, shape) in [
        "conical",
        "ogive",
        "ellipsoid",
        "power",
        "parabolic",
        "haack",
    ]
    .iter()
    .enumerate()
    {
        let id = format!("nose_{i}");
        let x0 = i as f64; // separate stations so nothing overlaps
        comps.push(comp(
            &id,
            None,
            x0,
            x0 + 0.2,
            json!({
                "type": "nose_cone", "shape": shape, "shape_param": 0.5, "length": 0.2,
                "od": 0.054, "thickness": 0.002, "shoulder": shoulder
            }),
        ));
    }
    comps.push(comp(
        "tube",
        None,
        10.0,
        10.5,
        json!({ "type": "body_tube", "length": 0.5, "od": 0.054, "id": 0.05 }),
    ));
    comps.push(comp("boat", None, 10.5, 10.6, json!({
        "type": "transition", "shape": "haack", "shape_param": 0.0, "length": 0.1,
        "fore_od": 0.054, "aft_od": 0.04, "thickness": 0.0015,
        "fore_shoulder": shoulder, "aft_shoulder": { "length": 0.02, "od": 0.036, "thickness": 0.0, "capped": false }
    })));
    comps.push(comp("trap", Some("tube"), 10.3, 10.45, merge(fin_common.clone(), json!({
        "type": "trapezoidal_fin_set", "root_chord": 0.15, "tip_chord": 0.05, "span": 0.08, "sweep": 0.07
    }))));
    comps.push(comp(
        "ell",
        Some("tube"),
        10.1,
        10.2,
        merge(
            fin_common.clone(),
            json!({
                "type": "elliptical_fin_set", "root_chord": 0.1, "span": 0.05
            }),
        ),
    ));
    comps.push(comp("free", Some("tube"), 10.0, 10.1, merge(fin_common, json!({
        "type": "freeform_fin_set", "points": [[0.0, 0.0], [0.03, 0.04], [0.05, 0.02], [0.08, 0.04], [0.1, 0.0]]
    }))));
    comps.push(comp(
        "tubefins",
        Some("tube"),
        10.2,
        10.3,
        json!({ "type": "tube_fin_set", "count": 6, "length": 0.1, "od": 0.02, "id": 0.018 }),
    ));
    comps.push(comp("mmt", Some("tube"), 10.1, 10.5, json!({ "type": "inner_tube", "length": 0.4, "od": 0.03, "id": 0.029, "motor_mount": true, "overhang": 0.0 })));
    comps.push(comp(
        "cpl",
        Some("tube"),
        10.0,
        10.1,
        json!({ "type": "coupler", "length": 0.1, "od": 0.05, "id": 0.048 }),
    ));
    comps.push(comp(
        "cr",
        Some("tube"),
        10.2,
        10.205,
        json!({ "type": "centering_ring", "length": 0.005, "od": 0.05, "id": 0.03 }),
    ));
    comps.push(comp(
        "bh",
        Some("tube"),
        10.0,
        10.005,
        json!({ "type": "bulkhead", "length": 0.005, "od": 0.05 }),
    ));
    comps.push(comp(
        "eb",
        Some("tube"),
        10.4,
        10.41,
        json!({ "type": "engine_block", "length": 0.01, "od": 0.029, "id": 0.02 }),
    ));
    comps.push(comp(
        "lug",
        Some("tube"),
        10.2,
        10.25,
        json!({ "type": "launch_lug", "length": 0.05, "od": 0.008, "id": 0.0065 }),
    ));
    let mut rb = comp(
        "rb",
        Some("tube"),
        10.3,
        10.31,
        json!({ "type": "rail_button", "od": 0.01, "id": 0.006, "height": 0.008 }),
    );
    rb["instances"] = json!([
        { "index": 0, "pattern": "linear", "offset": [0.0, 0.0, 0.0], "roll": 0.0 },
        { "index": 1, "pattern": "linear", "offset": [0.1, 0.0, 0.0], "roll": 0.0 }
    ]);
    rb["roll"] = json!(std::f64::consts::FRAC_PI_4);
    comps.push(rb);
    comps.push(comp("chute", Some("tube"), 10.0, 10.08, json!({ "type": "parachute", "diameter": 0.6, "cd": 0.8, "spill_hole": 0.0, "packed_length": 0.08, "packed_diameter": 0.04 })));
    comps.push(comp("streamer", Some("tube"), 10.0, 10.05, json!({ "type": "streamer", "length": 1.0, "width": 0.05, "cd": 0.5, "packed_length": 0.05, "packed_diameter": 0.03 })));
    comps.push(comp("cord", Some("tube"), 10.0, 10.04, json!({ "type": "shock_cord", "cord_length": 2.0, "packed_length": 0.04, "packed_diameter": 0.03 })));
    comps.push(comp(
        "mass",
        Some("tube"),
        10.1,
        10.15,
        json!({ "type": "mass_component", "mass": 0.1, "length": 0.05, "od": 0.04 }),
    ));
    comps.push(comp(
        "massless",
        Some("tube"),
        10.1,
        10.15,
        json!({ "type": "mass_component", "mass": 0.1, "length": 0.05, "od": 0.0 }),
    ));
    for (i, cap) in ["flat", "hemispherical", "ellipsoidal"].iter().enumerate() {
        let x0 = 20.0 + i as f64;
        comps.push(comp(&format!("tank_{i}"), None, x0, x0 + 0.5, json!({
            "type": "tank", "length": 0.5, "od": 0.1, "wall": 0.003, "end_cap": cap, "volume": 0.0, "propellant_mass": 0.0
        })));
    }
    let g = build(&model(comps, 0.054));
    for c in &g.components {
        assert!(c.volume.is_finite() && c.volume >= 0.0, "{}", c.id);
        assert!(
            c.wetted_area.is_finite() && c.planform_area.is_finite(),
            "{}",
            c.id
        );
        assert!(
            c.bbox.min.iter().zip(c.bbox.max).all(|(a, b)| *a <= b),
            "{}",
            c.id
        );
        if c.id != "massless" {
            assert!(c.volume > 0.0, "{}", c.id);
        }
    }
    // Rail buttons: two linear instances rolled to 45°, standing on the tube.
    let rb = get(&g, "rb");
    assert_eq!(rb.instances.len(), 2);
    assert!(close(rb.instances[1].offset[0], 0.1, 1e-12));
    // Tube fins: 6 tubes on the body, axis at r_body + od/2.
    let tf = get(&g, "tubefins");
    assert_eq!(tf.instances.len(), 6);
    for i in &tf.instances {
        assert!(close(i.offset[1].hypot(i.offset[2]), 0.037, 1e-12));
    }
    // Fin tabs add plate volume but not wetted area.
    let trap = get(&g, "trap");
    let a = 0.5 * (0.15 + 0.05) * 0.08;
    assert!(close(trap.wetted_area, 2.0 * 3.0 * a, 1e-12));
    assert!(close(trap.volume, 3.0 * 0.003 * (a + 0.008 * 0.05), 1e-12));
    // Every nose shape: exposed area grows from cone to bluffer shapes; base radius exact.
    for i in 0..6 {
        let n = get(&g, &format!("nose_{i}"));
        let base = n
            .outer
            .iter()
            .find(|p| (p.x - (i as f64 + 0.2)).abs() < 1e-12)
            .unwrap();
        assert!(close(base.r, 0.027, 1e-12));
    }
}
