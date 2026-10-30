//! Shared helpers for the rw-mass integration tests. Inputs are embedded with
//! `include_str!`, so the tests touch no filesystem API (I5).
#![allow(dead_code)]

use rw_geom::Geometry;
use rw_mass::MassModel;
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
        "material": "m",
        "shape": shape
    })
}

/// A model with the fixture's envelope, the given components (children lists
/// filled from `parent`), and one material `m` of bulk density `rho`.
pub fn model(components: Vec<Value>, rho: f64) -> EvaluatedModel {
    let mut m = fixture_model();
    m.config = None;
    m.components = components
        .into_iter()
        .map(|c| serde_json::from_value(c).expect("component"))
        .collect();
    let ids: Vec<(String, Option<String>)> = m
        .components
        .iter()
        .map(|c| (c.id.clone(), c.parent.clone()))
        .collect();
    for c in &mut m.components {
        c.children = ids
            .iter()
            .filter(|(_, p)| p.as_deref() == Some(c.id.as_str()))
            .map(|(id, _)| id.clone())
            .collect();
    }
    m.materials.clear();
    m.materials.insert(
        "m".into(),
        serde_json::from_value(json!({ "density": rho })).unwrap(),
    );
    m
}

pub fn build(m: &EvaluatedModel) -> (Geometry, MassModel) {
    let g = rw_geom::build(m);
    let mm = MassModel::new(m, &g, &[]);
    (g, mm)
}

/// Relative closeness `|a − b| ≤ tol·max(|b|, floor)`.
pub fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol * b.abs().max(1e-300)
}

#[track_caller]
pub fn assert_close(what: &str, a: f64, b: f64, tol: f64) {
    assert!(
        close(a, b, tol),
        "{what}: got {a:.15e}, want {b:.15e} (rel {:.2e})",
        ((a - b) / b).abs()
    );
}
