//! Writes the GLB of `fixtures/contracts/evaluated-model.json` (explode 0,
//! internals on) to stdout through rw-geom, the same writer rw-wasm
//! `mesh_glb` wraps. Output: `app/apps/web/public/fixtures/contract-vehicle.glb`.
use std::io::Write;

fn main() {
    let v: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../../fixtures/contracts/evaluated-model.json"
    )))
    .expect("fixture json");
    let model: rw_model::EvaluatedModel =
        serde_json::from_value(v["payload"].clone()).expect("fixture model");
    let geometry = rw_geom::build(&model);
    let glb = rw_geom::mesh_glb(&geometry, &rw_geom::MeshOptions::default());
    std::io::stdout().write_all(&glb).expect("stdout");
}
