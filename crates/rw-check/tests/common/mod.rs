//! Shared fixture pipeline: IF2 JSON → geometry, motors, mass, aero → check.
#![allow(dead_code)]

use std::collections::BTreeMap;

use rw_aero::{AeroModel, AeroOptions};
use rw_check::{CheckInput, CheckReport, check_static, mounted_from_config};
use rw_mass::MassModel;
use rw_model::EvaluatedModel;
use rw_motor::generic::generic_motor;

/// The `simple` project (rw-model M1.22 fixture), evaluated.
pub const SIMPLE: &str = include_str!("../fixtures/simple.eval.json");

pub fn model(json: &str) -> EvaluatedModel {
    serde_json::from_str(json).expect("IF2 fixture")
}

/// Fixed input hashes (the Session supplies real ones).
pub fn inputs() -> BTreeMap<String, String> {
    [
        ("rocketwright.toml", "11"),
        ("rocket.rw.toml", "22"),
        ("parts/fin_can.rw.toml", "33"),
        ("configs/baseline.rw.toml", "44"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.repeat(32)))
    .collect()
}

/// Runs the full static pipeline on an evaluated model.
pub fn run(model: &EvaluatedModel) -> CheckReport {
    let geometry = rw_geom::build(model);
    let motors = mounted_from_config(model, &|r: &str| {
        r.strip_prefix("generic:").and_then(generic_motor)
    });
    let mass = MassModel::new(model, &geometry, &motors);
    let aero = AeroModel::new(model, &geometry, &AeroOptions::default());
    let inputs = inputs();
    check_static(&CheckInput {
        model,
        geometry: &geometry,
        mass: &mass,
        aero: &aero,
        motors: &motors,
        inputs: &inputs,
    })
}
