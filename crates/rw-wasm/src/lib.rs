//! WebAssembly exports (IF9) for the web UI: JSON strings in and out, GLB as
//! `Uint8Array`. WASM is a pure function of sidecar state plus a draft, never
//! the source of truth (invariant I4).
//!
//! Frozen at M1.5. Every JSON-returning export returns an envelope:
//! `{"ok": <payload>}` or `{"error": <rw-api ApiError>}`. Payload types are
//! the published schemas (`schema/<name>.json`). No tsify, no handles across
//! the boundary. `mesh_glb` returns the GLB bytes and throws on bad input.
//! The JS name of the evaluator is `eval_model`, not `eval`: `eval` cannot be
//! bound as an identifier in a strict-mode ES module (found at M1.9).
//!
//! The bodies (M1.32) run the same code as the sidecar's `Session` for a
//! project without a `lib/` directory: `rw_model::eval` over the parsed
//! sources, then `rw_check::check_static` with geometry, mass, and aero built
//! from the evaluated model and motors resolved from the embedded generic
//! curves. Project `lib/` files (materials, motor files) are not part of
//! `rw://project/files`, so the WASM core does not see them.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod api;

use wasm_bindgen::prelude::{JsError, wasm_bindgen};

/// Core version string, compared against the sidecar's version by the app.
#[wasm_bindgen]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// `sources_json`: `{"<project-relative path>": "<file text>"}` (the `files`
/// of `rw://project/files`). Returns `{"ok": EvaluatedModel}`.
#[wasm_bindgen]
pub fn eval_model(sources_json: &str) -> String {
    api::envelope(api::eval_model(sources_json))
}

/// Applies `patch_json` (`PatchOp[]`) to the sources, then evaluates and runs
/// the static check. Returns `{"ok": {"evaluated": EvaluatedModel, "check": CheckReport}}`.
#[wasm_bindgen]
pub fn apply_and_eval(sources_json: &str, patch_json: &str) -> String {
    api::envelope(api::apply_and_eval(sources_json, patch_json))
}

/// Static check tier on an evaluated model. Returns `{"ok": CheckReport}`.
/// Without the source texts, `inputs` lists only the mounted motors.
#[wasm_bindgen]
pub fn check_static(evaluated_json: &str) -> String {
    api::envelope(api::check_static(evaluated_json))
}

/// Binary glTF of the evaluated model. `opts_json` is `rw_geom::MeshOptions`
/// (`{}` or `null` for the defaults). Node name = component id (instances
/// `<id>/<n>`); body frame +X aft, +Z up; `extras.rw_explode` per node.
/// Throws on an invalid model or options.
#[wasm_bindgen]
pub fn mesh_glb(evaluated_json: &str, opts_json: &str) -> Result<Vec<u8>, JsError> {
    api::mesh_glb(evaluated_json, opts_json).map_err(|e| JsError::new(&e.message))
}

/// The `rw render --view profile` SVG (same `rw-draw` code path as the CLI).
/// `check_json` (a `CheckReport`, or `null`) supplies the CG/CP markers;
/// `opts_json` is `{"view"?: "profile"|"fin"|"stations"|"anchors", "width"?, "internals"?}`.
/// Returns `{"ok": "<svg …>"}`.
#[wasm_bindgen]
pub fn profile_svg(evaluated_json: &str, check_json: &str, opts_json: &str) -> String {
    api::envelope(api::profile_svg(evaluated_json, check_json, opts_json))
}

/// The built-in generic motor library with thrust curves (page 03 motor
/// picker). `query_json` is `{"query"?, "class"?, "diameter"?}` (SI), or `{}`.
/// Returns `{"ok": ThrustCurve[]}`.
#[wasm_bindgen]
pub fn motor_library(query_json: &str) -> String {
    api::envelope(api::motor_library(query_json))
}

/// Thermo table lookup (M4.3): `table` is a `.rwtbl` file (`pkg/thermo/`),
/// `query_json` is `{oxidizer?, fuel?, of, pc, eps?, frozen?}` (SI: `pc` in
/// Pa; `eps` = Ae/At; ids checked against the table). Returns
/// `{"ok": Performance}` (`rw_thermo::Performance`, SI).
#[wasm_bindgen]
pub fn thermo_lookup(table: &[u8], query_json: &str) -> String {
    api::envelope(api::thermo_lookup(table, query_json))
}

/// Liquid engine design (M4.6) from one evaluated engine
/// (`EvaluatedModel.engines.<id>` JSON) and its propellant table (`pkg/thermo/
/// <oxidizer>-<fuel>.rwtbl`; empty bytes for an untabulated pair, which the
/// sidecar computes with native CEA). Returns `{"ok": EngineDesignOut}`
/// (`schema/tools/engine_design.output.json`).
#[wasm_bindgen]
pub fn engine_design(engine_json: &str, table: &[u8]) -> String {
    api::envelope(api::engine_design(engine_json, table))
}

#[cfg(test)]
mod tests {
    #[test]
    fn core_version_is_package_version() {
        assert_eq!(super::core_version(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn engine_design_sizes_an_evaluated_engine() {
        let bad: serde_json::Value =
            serde_json::from_str(&super::engine_design("{}", &[])).unwrap();
        assert_eq!(bad["error"]["code"], "invalid_input");
        let dir = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/research-vehicle"
        ));
        let s = rw_project::Session::open(dir, rw_project::SessionOptions::read_only()).unwrap();
        let m = s.model().clone();
        let table = include_bytes!("../../../data/thermo/n2o-ethanol.rwtbl");
        for (id, missing) in [("demo", 0), ("demo-incomplete", 2)] {
            let e = serde_json::to_string(&m.engines[id]).unwrap();
            let v: serde_json::Value =
                serde_json::from_str(&super::engine_design(&e, table)).unwrap();
            let ok = &v["ok"];
            assert!(
                (ok["performance"]["thrust"].as_f64().unwrap() - 1500.0).abs() < 1e-6,
                "{v}"
            );
            assert_eq!(
                ok["missing_inputs"].as_array().unwrap().len(),
                missing,
                "{v}"
            );
        }
        // No table: the sidecar computes it.
        let e = serde_json::to_string(&m.engines["demo"]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&super::engine_design(&e, &[])).unwrap();
        assert!(v["ok"]["performance"].is_null());
        assert_eq!(v["ok"]["design"]["thermo"], "none");
        assert!(v.to_string().contains("RW-E227"));
    }

    #[test]
    fn thermo_lookup_interpolates_a_committed_table() {
        let table = include_bytes!("../../../data/thermo/lox-ethanol.rwtbl");
        let q = r#"{"oxidizer":"lox","fuel":"ethanol","of":1.4,"pc":2e6,"eps":4}"#;
        let v: serde_json::Value = serde_json::from_str(&super::thermo_lookup(table, q)).unwrap();
        let isp = v["ok"]["nozzle"]["isp"].as_f64().unwrap();
        assert!((isp - 2456.38).abs() / 2456.38 < 5e-3, "{v}");
        assert_eq!(v["ok"]["mode"], "equilibrium");
        let bad = super::thermo_lookup(table, r#"{"fuel":"ipa","of":1.4,"pc":2e6}"#);
        assert!(bad.contains("invalid_input"), "{bad}");
        let out = super::thermo_lookup(table, r#"{"of":9,"pc":2e6}"#);
        assert!(out.contains("outside the table range"), "{out}");
        let junk = super::thermo_lookup(b"junk", r#"{"of":1.4,"pc":2e6}"#);
        assert!(junk.contains("invalid_input"), "{junk}");
    }
}
