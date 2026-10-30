//! Test models: the M1.5 contract fixture and a case-1 equivalent built from
//! the oracle geometry numbers (`tests/oracle/case1.geometry.json`). Inputs
//! are embedded with `include_str!`, so tests touch no filesystem API (I5).

use rw_model::EvaluatedModel;
use serde_json::{Value, json};

pub(crate) fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol * b.abs().max(1e-12)
}

fn fixture() -> EvaluatedModel {
    let v: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/contracts/evaluated-model.json"
    )))
    .expect("fixture json");
    serde_json::from_value(v["payload"].clone()).expect("fixture model")
}

/// One evaluated component as JSON.
pub(crate) fn comp(
    id: &str,
    parent: Option<&str>,
    containment: &str,
    x: [f64; 2],
    roughness: Option<f64>,
    shape: Value,
) -> Value {
    json!({
        "id": id, "name": id, "parent": parent, "children": [],
        "containment": containment, "aero": containment != "inner", "cut": false,
        "x_fore": x[0], "x_aft": x[1], "radial": 0.0, "roll": 0.0,
        "instances": [{ "index": 0, "offset": [0.0, 0.0, 0.0], "roll": 0.0 }],
        "anchors": [], "roughness": roughness, "shape": shape
    })
}

/// A model with the fixture's envelope and the given components.
pub(crate) fn model(components: Vec<Value>, ref_diameter: f64) -> EvaluatedModel {
    let mut m = fixture();
    m.components = components
        .into_iter()
        .map(|c| serde_json::from_value(c).expect("component"))
        .collect();
    m.reference.diameter = ref_diameter;
    m.reference.area = std::f64::consts::PI * ref_diameter * ref_diameter / 4.0;
    m
}

/// `"fixture"`: the M1.5 contract model. `"case1"`: oracle case 1 ("A simple
/// model rocket": 0.1 m tangent ogive, 0.3 m tube of 25 mm, 3 trapezoid fins,
/// one lug, 60 µm roughness). The fin cross-section is not in the oracle
/// geometry; rounded is assumed (see docs/dev/parity-log.md).
pub(crate) fn case_model(name: &str) -> EvaluatedModel {
    match name {
        "fixture" => fixture(),
        "case1" => {
            let eps = Some(60e-6);
            model(
                vec![
                    comp(
                        "nose",
                        None,
                        "axial",
                        [0.0, 0.1],
                        eps,
                        json!({
                            "type": "nose_cone", "shape": "ogive", "shape_param": 1.0,
                            "length": 0.1, "od": 0.025, "thickness": 0.002,
                            "shoulder": { "length": 0.02, "od": 0.023, "thickness": 0.002, "capped": true }
                        }),
                    ),
                    comp(
                        "body",
                        Some("nose"),
                        "axial",
                        [0.1, 0.4],
                        eps,
                        json!({
                            "type": "body_tube", "length": 0.3, "od": 0.025, "id": 0.023
                        }),
                    ),
                    comp(
                        "lug",
                        Some("body"),
                        "surface",
                        [0.2325, 0.2675],
                        eps,
                        json!({
                            "type": "launch_lug", "length": 0.035, "od": 0.007, "id": 0.005
                        }),
                    ),
                    comp(
                        "fins",
                        Some("body"),
                        "surface",
                        [0.3492, 0.4],
                        eps,
                        json!({
                            "type": "trapezoidal_fin_set", "count": 3, "thickness": 0.002,
                            "cross_section": "rounded", "cant": 0.0, "fillet_radius": 0.0,
                            "root_chord": 0.0508, "tip_chord": 0.0508, "span": 0.03, "sweep": 0.0254
                        }),
                    ),
                    comp(
                        "mount",
                        Some("body"),
                        "inner",
                        [0.33, 0.405],
                        None,
                        json!({
                            "type": "inner_tube", "length": 0.075, "od": 0.019, "id": 0.018,
                            "motor_mount": true, "overhang": 0.003
                        }),
                    ),
                ],
                0.025,
            )
        }
        other => panic!("unknown test model {other}"),
    }
}
