//! Native-callable bodies of the IF9 exports. Each returns a typed result;
//! `lib.rs` wraps it in the `{"ok"}`/`{"error"}` envelope for JS. Kept free of
//! `wasm_bindgen` so the native tests (and `tests/native_equiv.rs`) run the
//! exact code the WASM build runs.

use std::collections::BTreeMap;

use rw_aero::{AeroModel, AeroOptions};
use rw_api::{ApiError, ApiErrorCode};
use rw_check::{CheckInput, CheckReport, mounted_from_config};
use rw_geom::MeshOptions;
use rw_mass::MassModel;
use rw_model::{
    Diagnostic, EvalOptions, EvaluatedModel, PatchError, PatchOp, SourceSet, parse_source,
};
use rw_motor::ThrustCurve;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// `{"ok": payload}` or `{"error": ApiError}` as a JSON string.
pub fn envelope<T: Serialize>(r: Result<T, ApiError>) -> String {
    // Straight to text: `model_hash` already instantiates the byte serializer
    // for the model types, so this adds no second (Value) serializer.
    match r.and_then(|t| {
        serde_json::to_string(&t).map_err(|e| err(ApiErrorCode::Internal, e.to_string()))
    }) {
        Ok(s) => format!("{{\"ok\":{s}}}"),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

fn err(code: ApiErrorCode, message: impl Into<String>) -> ApiError {
    ApiError {
        outcome: None,
        code,
        message: message.into(),
        hint: None,
        diagnostics: Vec::new(),
    }
}

/// Parses through `Value` so each type gets one (Value) deserializer, shared
/// with the crates' own `from_value` calls (M1.32 size budget).
fn parse_json<T: for<'de> Deserialize<'de>>(what: &str, text: &str) -> Result<T, ApiError> {
    let invalid = |e: serde_json::Error| {
        err(
            ApiErrorCode::InvalidInput,
            format!("{what} is not valid: {e}"),
        )
    };
    let v: Value = serde_json::from_str(text).map_err(invalid)?;
    serde_json::from_value(v).map_err(invalid)
}

/// The output of [`apply_and_eval`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DraftEval {
    pub evaluated: EvaluatedModel,
    pub check: CheckReport,
}

/// Source texts by project-relative path. Paths that are not model sources
/// (no `doc_kind`) are ignored, as `layout::read_project` skips them.
fn texts(sources_json: &str) -> Result<BTreeMap<String, String>, ApiError> {
    let all: BTreeMap<String, String> = parse_json("the sources", sources_json)?;
    Ok(all
        .into_iter()
        .filter(|(p, _)| rw_model::source::doc_kind(p).is_some())
        .collect())
}

/// Parses every source file. A file that does not parse fails the call with
/// its diagnostics (the sidecar only serves files that parsed).
fn parse_all(texts: &BTreeMap<String, String>) -> Result<SourceSet, ApiError> {
    let mut set = SourceSet::default();
    let mut diags: Vec<Diagnostic> = Vec::new();
    for (path, text) in texts {
        match parse_source(path, text) {
            Ok(doc) => {
                set.docs.insert(path.clone(), doc);
            }
            Err(ds) => diags.extend(ds.into_iter().map(|mut d| {
                d.file.get_or_insert_with(|| path.clone());
                d
            })),
        }
    }
    if diags.is_empty() {
        Ok(set)
    } else {
        let mut e = err(
            ApiErrorCode::InvalidInput,
            format!(
                "{} source diagnostic(s): the sources do not parse",
                diags.len()
            ),
        );
        e.diagnostics = diags;
        Err(e)
    }
}

fn patch_error(e: PatchError) -> ApiError {
    ApiError {
        outcome: None,
        code: ApiErrorCode::InvalidInput,
        message: format!("op {} at `{}`: {}", e.op, e.path, e.message),
        hint: Some(
            "paths address the id-keyed model (`/c/<id>/<field>`); read it with model_get".into(),
        ),
        diagnostics: Vec::new(),
    }
}

/// Resolves a motor ref the way the sidecar's library does for a project
/// with no `lib/motors` files: `generic:<id>`, then a generic designation,
/// then a bare generic id.
pub fn resolve_motor(r: &str) -> Option<ThrustCurve> {
    if let Some(id) = r.strip_prefix("generic:") {
        return rw_motor::generic::generic_motor(id);
    }
    if r.starts_with("lib:") {
        return None;
    }
    rw_motor::generic::generic_motors()
        .into_iter()
        .find(|c| c.designation.eq_ignore_ascii_case(r))
        .or_else(|| rw_motor::generic::generic_motor(r))
}

/// Filters of [`motor_library`] (`rw motor search` fields; SI units).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MotorLibraryQuery {
    pub query: Option<String>,
    pub class: Option<String>,
    /// Motor diameter (m), matched within 0.5 mm.
    pub diameter: Option<f64>,
}

/// `motor_library`: the built-in generic motors matching the query, with
/// their thrust curves (the page 03 motor picker; same data and filter as
/// `rw motor search` offline), smallest impulse first.
pub fn motor_library(query_json: &str) -> Result<Vec<ThrustCurve>, ApiError> {
    let v = opts_value(query_json)?;
    let q: MotorLibraryQuery = serde_json::from_value(v).map_err(|e| {
        err(
            ApiErrorCode::InvalidInput,
            format!("the motor query is not valid: {e}"),
        )
    })?;
    Ok(rw_motor::generic::search_generic(
        &rw_motor::generic::MotorQuery {
            query: q.query.filter(|s| !s.trim().is_empty()),
            class: q.class,
            diameter: q.diameter,
            min_impulse: None,
            max_impulse: None,
        },
    ))
}

/// `rw_check::check_static` with geometry, mass, and aero built from the
/// model (the sidecar's `StaticChecker`).
pub fn check_model(model: &EvaluatedModel, inputs: &BTreeMap<String, String>) -> CheckReport {
    let geometry = rw_geom::build(model);
    let mounted = mounted_from_config(model, &resolve_motor);
    let mass = MassModel::new(model, &geometry, &mounted);
    let aero = AeroModel::new(model, &geometry, &AeroOptions::default());
    rw_check::check_static(&CheckInput {
        model,
        geometry: &geometry,
        mass: &mass,
        aero: &aero,
        motors: &mounted,
        inputs,
    })
}

fn blake3_hex(s: &str) -> String {
    blake3::hash(s.as_bytes()).to_hex().to_string()
}

/// `eval_model`: the evaluated model of the sources (default config).
pub fn eval_model(sources_json: &str) -> Result<EvaluatedModel, ApiError> {
    let set = parse_all(&texts(sources_json)?)?;
    Ok(rw_model::eval(&set, &EvalOptions::default()))
}

/// `apply_and_eval`: applies the ops, evaluates, and checks. `inputs` hashes
/// each source text (blake3, as the sidecar does); a file the ops changed is
/// hashed from its patched document's JSON, because the WASM core has no
/// format-preserving writer (preview only; the sidecar's dry run is authoritative).
pub fn apply_and_eval(sources_json: &str, patch_json: &str) -> Result<DraftEval, ApiError> {
    let texts = texts(sources_json)?;
    let ops: Vec<PatchOp> = parse_json("the patch (PatchOp[])", patch_json)?;
    let base = parse_all(&texts)?;
    let set = if ops.is_empty() {
        base.clone()
    } else {
        rw_model::patch::apply_sources(&base, &ops).map_err(patch_error)?
    };
    let evaluated = rw_model::eval(&set, &EvalOptions::default());
    let mut inputs = BTreeMap::new();
    for (path, doc) in &set.docs {
        let h = match (texts.get(path), base.docs.get(path)) {
            (Some(t), Some(b)) if b == doc => blake3_hex(t),
            _ => blake3_hex(&serde_json::to_string(doc).unwrap_or_default()),
        };
        inputs.insert(path.clone(), h);
    }
    let check = check_model(&evaluated, &inputs);
    Ok(DraftEval { evaluated, check })
}

/// `check_static`: the static check of an evaluated model.
pub fn check_static(evaluated_json: &str) -> Result<CheckReport, ApiError> {
    let model: EvaluatedModel = parse_json("the evaluated model", evaluated_json)?;
    Ok(check_model(&model, &BTreeMap::new()))
}

/// Options JSON that may be empty, `null`, or `{}` (defaults).
fn opts_value(text: &str) -> Result<Value, ApiError> {
    if text.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    let v: Value = parse_json("the options", text)?;
    Ok(if v.is_null() {
        Value::Object(Default::default())
    } else {
        v
    })
}

/// `mesh_glb`: the rw-geom GLB of the evaluated model.
pub fn mesh_glb(evaluated_json: &str, opts_json: &str) -> Result<Vec<u8>, ApiError> {
    let model: EvaluatedModel = parse_json("the evaluated model", evaluated_json)?;
    let mut opts = MeshOptions::default();
    let o = opts_value(opts_json)?;
    let obj = o.as_object().ok_or_else(|| {
        err(
            ApiErrorCode::InvalidInput,
            "the mesh options are not an object",
        )
    })?;
    if let Some(v) = obj.get("radial_segments") {
        opts.radial_segments = v
            .as_u64()
            .filter(|n| (3..=1024).contains(n))
            .ok_or_else(|| {
                err(
                    ApiErrorCode::InvalidInput,
                    "radial_segments must be 3..=1024",
                )
            })? as u32;
    }
    if let Some(v) = obj.get("explode") {
        opts.explode = v
            .as_f64()
            .filter(|x| x.is_finite())
            .ok_or_else(|| err(ApiErrorCode::InvalidInput, "explode must be a number"))?;
    }
    if let Some(v) = obj.get("internals") {
        opts.internals = v
            .as_bool()
            .ok_or_else(|| err(ApiErrorCode::InvalidInput, "internals must be a boolean"))?;
    }
    if let Some(v) = obj.get("cutters") {
        opts.cutters = v
            .as_bool()
            .ok_or_else(|| err(ApiErrorCode::InvalidInput, "cutters must be a boolean"))?;
    }
    Ok(rw_geom::mesh_model_glb(&model, &opts))
}

/// `profile_svg`: a 2D drawing (default the side profile) through `rw-draw`.
pub fn profile_svg(
    evaluated_json: &str,
    check_json: &str,
    opts_json: &str,
) -> Result<String, ApiError> {
    let model: EvaluatedModel = parse_json("the evaluated model", evaluated_json)?;
    let check = opts_value(check_json)?;
    let markers = if check.as_object().is_some_and(|m| m.is_empty()) {
        rw_draw::Markers::default()
    } else {
        let r: CheckReport = serde_json::from_value(check).map_err(|e| {
            err(
                ApiErrorCode::InvalidInput,
                format!("the check report is not valid: {e}"),
            )
        })?;
        rw_draw::Markers::from_report(&r)
    };
    let o = opts_value(opts_json)?;
    let mut opts = rw_draw::DrawOptions::default();
    if let Some(w) = o.get("width") {
        opts.width = w
            .as_f64()
            .filter(|w| w.is_finite() && *w >= 100.0 && *w <= 16384.0)
            .ok_or_else(|| err(ApiErrorCode::InvalidInput, "width must be 100..=16384"))?;
    }
    if let Some(v) = o.get("internals") {
        opts.internals = v
            .as_bool()
            .ok_or_else(|| err(ApiErrorCode::InvalidInput, "internals must be a boolean"))?;
    }
    let view = match o.get("view").map(|v| v.as_str()) {
        None => rw_draw::View::Profile,
        Some(Some(name)) => rw_draw::View::ALL
            .into_iter()
            .find(|v| v.name() == name)
            .ok_or_else(|| {
                err(
                    ApiErrorCode::InvalidInput,
                    format!("unknown view `{name}` (profile, fin, stations, anchors)"),
                )
            })?,
        Some(None) => return Err(err(ApiErrorCode::InvalidInput, "view must be a string")),
    };
    Ok(rw_draw::draw(
        view,
        &model,
        &rw_geom::build(&model),
        &markers,
        &opts,
    ))
}

/// `thermo_lookup` (M4.3): interpolates a `.rwtbl` thermo table (bytes from
/// `pkg/thermo/<pair>.rwtbl`, shipped beside the wasm, D19d) at a
/// [`rw_thermo::Query`] (`{oxidizer?, fuel?, of, pc (Pa), eps?, frozen?}`).
/// Returns [`rw_thermo::Performance`] (SI). A point outside the table, or
/// next to a node CEA did not converge on, is `invalid_input`/`not_found`.
pub fn thermo_lookup(table: &[u8], query_json: &str) -> Result<rw_thermo::Performance, ApiError> {
    let query: rw_thermo::Query = parse_json("thermo query", query_json)?;
    let table = rw_thermo::Table::from_bytes(table)
        .map_err(|e| err(ApiErrorCode::InvalidInput, e.to_string()))?;
    table.lookup(&query).map_err(|e| {
        let code = match e {
            rw_thermo::ThermoError::NoData | rw_thermo::ThermoError::NoMode(_) => {
                ApiErrorCode::NotFound
            }
            _ => ApiErrorCode::InvalidInput,
        };
        err(code, e.to_string())
    })
}

/// The chamber part of a liquid engine design (`LiquidEngineDesign` with
/// only `engine`, `thermo`, `sizing`, `assumptions`).
#[derive(Debug, Serialize)]
pub struct ChamberDesign {
    pub engine: String,
    pub thermo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sizing: Option<rw_liquid::sizing::Sizing>,
    pub assumptions: Vec<String>,
}

/// The WASM `engine_design` payload: an `EngineDesignOut` whose `design`
/// carries the chamber only (the feed budget, tanks, and blowdown are
/// computed by the sidecar's `engine_design`). Kept small for the wasm size
/// gate: the blowdown and curve code never links into the module.
#[derive(Debug, Serialize)]
pub struct EngineDesignPreview {
    pub engine: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub performance: Option<rw_api::EnginePerformance>,
    pub missing_inputs: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub design: ChamberDesign,
}

/// `engine_design` for the WASM preview: `engine_json` is one evaluated
/// engine (`EvaluatedModel.engines.<id>`), `table` the pair's `.rwtbl` (empty
/// when the pair has no shipped table: the design then carries `RW-E227` and
/// no performance, and the UI shows "computed by sidecar").
pub fn engine_design(engine_json: &str, table: &[u8]) -> Result<EngineDesignPreview, ApiError> {
    let engine: rw_model::EvalEngine = parse_json("evaluated engine", engine_json)?;
    let parsed = if table.is_empty() {
        None
    } else {
        Some(
            rw_thermo::Table::from_bytes(table)
                .map_err(|e| err(ApiErrorCode::InvalidInput, e.to_string()))?,
        )
    };
    let thermo = parsed.as_ref().map(rw_liquid::TableThermo::new);
    let th: Option<&dyn rw_liquid::Thermo> = thermo.as_ref().map(|t| t as &dyn rw_liquid::Thermo);
    let c = rw_liquid::design::chamber(&engine, th, &rw_liquid::DesignOptions::default());
    let mut diagnostics = rw_model::components::engine::check(&engine);
    diagnostics.extend(c.diagnostics);
    Ok(EngineDesignPreview {
        engine: engine.id.clone(),
        performance: c.sizing.as_ref().map(rw_api::EnginePerformance::from),
        missing_inputs: c.missing_inputs,
        diagnostics,
        design: ChamberDesign {
            engine: engine.id,
            thermo: c.thermo,
            sizing: c.sizing,
            assumptions: vec![
                "Chamber preview; the feed budget, tanks, and blowdown are computed by the sidecar (engine_design).".into(),
            ],
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINI: &[(&str, &str)] = &[
        ("rocketwright.toml", "format = 1\nname = \"Mini\"\n"),
        (
            "rocket.rw.toml",
            "name = \"Mini\"\n\n[c.nose]\ntype = \"nose_cone\"\nshape = \"ogive\"\nlength = \"100 mm\"\nod = \"30 mm\"\n\n[c.body]\ntype = \"body_tube\"\nattach = { to = \"nose.base\" }\nlength = \"300 mm\"\nod = \"30 mm\"\nid = \"29 mm\"\n",
        ),
    ];

    fn mini() -> String {
        serde_json::to_string(&MINI.iter().copied().collect::<BTreeMap<_, _>>()).unwrap()
    }

    #[test]
    fn motor_library_lists_generic_curves() {
        let all = motor_library("{}").unwrap();
        assert!(all.len() >= 3);
        assert!(all.iter().all(|m| !m.points.is_empty()));
        let b = motor_library(r#"{"query":"b4"}"#).unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].designation, "RW_B4G");
        let d18 = motor_library(r#"{"diameter":0.018}"#).unwrap();
        assert!(d18.iter().all(|m| (m.diameter - 0.018).abs() < 1e-6));
        assert!(motor_library(r#"{"bogus":1}"#).is_err());
    }

    #[test]
    fn evaluates_and_meshes_a_minimal_project() {
        let m = eval_model(&mini()).unwrap();
        let ids: Vec<&str> = m.components.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["nose", "body"]);
        let glb = mesh_glb(&serde_json::to_string(&m).unwrap(), "{}").unwrap();
        assert_eq!(&glb[0..4], b"glTF");
        let svg = profile_svg(&serde_json::to_string(&m).unwrap(), "null", "{}").unwrap();
        assert!(svg.starts_with("<svg"), "{svg:.80}");
    }

    #[test]
    fn apply_and_eval_with_no_ops_equals_eval() {
        let d = apply_and_eval(&mini(), "[]").unwrap();
        assert_eq!(d.evaluated, eval_model(&mini()).unwrap());
        assert_eq!(d.check.model_hash, d.evaluated.model_hash);
        assert_eq!(d.check.inputs.len(), 2);
    }

    #[test]
    fn apply_and_eval_applies_ops() {
        let ops = r#"[{"op":"replace","path":"/c/body/length","value":"400 mm"}]"#;
        let d = apply_and_eval(&mini(), ops).unwrap();
        let body = d
            .evaluated
            .components
            .iter()
            .find(|c| c.id == "body")
            .unwrap();
        assert!((body.x_aft - body.x_fore - 0.4).abs() < 1e-12);
        let bad = apply_and_eval(
            &mini(),
            r#"[{"op":"replace","path":"/c/nope/length","value":1}]"#,
        );
        assert_eq!(bad.unwrap_err().code, ApiErrorCode::InvalidInput);
    }

    #[test]
    fn errors_are_enveloped() {
        let v: Value = serde_json::from_str(&envelope(eval_model("not json"))).unwrap();
        assert_eq!(v["error"]["code"], "invalid_input");
        let broken = r#"{"rocket.rw.toml": "[c.x\n"}"#;
        let e = eval_model(broken).unwrap_err();
        assert!(!e.diagnostics.is_empty());
        assert!(mesh_glb("{}", "{}").is_err());
        assert!(
            profile_svg(
                &serde_json::to_string(&eval_model(&mini()).unwrap()).unwrap(),
                "null",
                r#"{"view":"iso"}"#
            )
            .is_err()
        );
    }
}
