//! Shared helpers for the rw-geom integration tests. Inputs are embedded with
//! `include_str!`, so the tests touch no filesystem API (I5).
#![allow(dead_code)]

use rw_model::EvaluatedModel;
use serde_json::{Value, json};

/// The M1.5 contract fixture model (`fixtures/contracts/evaluated-model.json`).
pub fn fixture_model() -> EvaluatedModel {
    let v: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/contracts/evaluated-model.json"
    )))
    .expect("fixture json");
    serde_json::from_value(v["payload"].clone()).expect("fixture model")
}

/// One evaluated component as JSON (`shape` already tagged with `type`).
pub fn comp(id: &str, parent: Option<&str>, x_fore: f64, x_aft: f64, shape: Value) -> Value {
    json!({
        "id": id,
        "name": id,
        "parent": parent,
        "children": [],
        "containment": "axial",
        "aero": true,
        "cut": false,
        "x_fore": x_fore,
        "x_aft": x_aft,
        "radial": 0.0,
        "roll": 0.0,
        "instances": [{ "index": 0, "offset": [0.0, 0.0, 0.0], "roll": 0.0 }],
        "anchors": [],
        "shape": shape
    })
}

/// A model with the fixture's envelope and the given components.
pub fn model(components: Vec<Value>, ref_diameter: f64) -> EvaluatedModel {
    let mut m = fixture_model();
    m.components = components
        .into_iter()
        .map(|c| serde_json::from_value(c).expect("component"))
        .collect();
    m.reference.diameter = ref_diameter;
    m.reference.area = std::f64::consts::PI * ref_diameter * ref_diameter / 4.0;
    m
}

pub fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol * b.abs().max(1.0)
}

pub fn close3(a: [f64; 3], b: [f64; 3], tol: f64) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() <= tol)
}
