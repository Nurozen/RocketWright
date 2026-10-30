//! `schema/testdata/{refs,units,exprs,patches}.json`: shared parser vectors.
//!
//! These are the expected behaviours of the `rw:` ref parser and `PatchOp`
//! application (M1.23), the unit parser (M1.20), and the expression evaluator
//! (M1.21), in Rust and TS alike. Changing an expectation is a contract change
//! (`docs/dev/contract-changes.md`).
//!
//! Each vector carries `schema_valid`: whether the published field schema
//! accepts the input. [`all`] checks every flag against the real schema, so a
//! pattern change that breaks a vector fails `cargo xtask schema`.

use schemars::{JsonSchema, Schema};
use serde_json::{Value, json};

use rw_api::root_schema;
use rw_units::{
    QAngle, QArea, QAreaDensity, QDensity, QForce, QImpulse, QLength, QLineDensity, QMass, QNumber,
    QPressure, QTemperature, QTime, QVelocity,
};

/// Relative tolerance for `si` comparisons (unit factors are exact; only
/// floating-point evaluation order may differ).
const REL_TOL: f64 = 1e-12;

const DEG: f64 = std::f64::consts::PI / 180.0;
const INCH: f64 = 0.0254;
const FOOT: f64 = 0.3048;
const POUND: f64 = 0.453_592_37;
const OUNCE: f64 = POUND / 16.0;
const LBF: f64 = 4.448_221_615_260_5;
const PSI: f64 = LBF / (INCH * INCH);

/// The field schema for a named dimension.
fn qty_schema(dim: &str) -> Result<Schema, String> {
    fn s<T: JsonSchema>() -> Schema {
        root_schema::<T>()
    }
    Ok(match dim {
        "dimensionless" => s::<QNumber>(),
        "length" => s::<QLength>(),
        "mass" => s::<QMass>(),
        "time" => s::<QTime>(),
        "angle" => s::<QAngle>(),
        "temperature" => s::<QTemperature>(),
        "pressure" => s::<QPressure>(),
        "force" => s::<QForce>(),
        "impulse" => s::<QImpulse>(),
        "density" => s::<QDensity>(),
        "area_density" => s::<QAreaDensity>(),
        "area" => s::<QArea>(),
        "line_density" => s::<QLineDensity>(),
        "velocity" => s::<QVelocity>(),
        other => return Err(format!("testdata: no field schema for dimension `{other}`")),
    })
}

fn is_valid(schema: &Schema, input: &Value) -> Result<bool, String> {
    let v = jsonschema::validator_for(schema.as_value()).map_err(|e| e.to_string())?;
    Ok(v.is_valid(input))
}

/// Checks each vector's `schema_valid` flag against `schema_of(vector)`.
fn check_flags(
    file: &str,
    vectors: &[Value],
    schema_of: impl Fn(&Value) -> Result<Schema, String>,
) -> Result<(), String> {
    for v in vectors {
        let want = v["schema_valid"]
            .as_bool()
            .ok_or_else(|| format!("{file}: vector without schema_valid: {v}"))?;
        let got = is_valid(&schema_of(v)?, &v["input"])?;
        if want != got {
            return Err(format!(
                "{file}: `{}` schema_valid is {want} but the schema says {got}",
                v["input"]
            ));
        }
        if v.get("ok").is_some() == v.get("err").is_some() {
            return Err(format!(
                "{file}: `{}` needs exactly one of ok/err",
                v["input"]
            ));
        }
    }
    Ok(())
}

fn ok_ref(
    input: &str,
    kind: &str,
    id: &str,
    anchor: Option<&str>,
    version: Option<&str>,
    pointer: &str,
) -> Value {
    let mut parts = json!({"kind": kind, "id": id});
    if let Some(a) = anchor {
        parts["anchor"] = json!(a);
    }
    if let Some(v) = version {
        parts["version"] = json!(v);
    }
    parts["pointer"] = json!(pointer);
    json!({"input": input, "schema_valid": true, "ok": parts})
}

fn bad_ref(input: &str, why: &str) -> Value {
    json!({"input": input, "schema_valid": false, "err": why})
}

fn refs() -> Result<Value, String> {
    let vectors = vec![
        ok_ref("rw:c/fins", "c", "fins", None, None, ""),
        ok_ref("rw:c/fins#root", "c", "fins", Some("root"), None, ""),
        ok_ref("rw:c/fins/span", "c", "fins", None, None, "/span"),
        ok_ref("rw:c/body#aft/od", "c", "body", Some("aft"), None, "/od"),
        ok_ref(
            "rw:c/body#aft@s12",
            "c",
            "body",
            Some("aft"),
            Some("s12"),
            "",
        ),
        ok_ref(
            "rw:c/nose@rev-03/shape",
            "c",
            "nose",
            None,
            Some("rev-03"),
            "/shape",
        ),
        ok_ref("rw:cfg/baseline", "cfg", "baseline", None, None, ""),
        ok_ref("rw:sim/fin-revision", "sim", "fin-revision", None, None, ""),
        ok_ref(
            "rw:run/3f9a2c/summary/apogee_m",
            "run",
            "3f9a2c",
            None,
            None,
            "/summary/apogee_m",
        ),
        ok_ref("rw:step/s12", "step", "s12", None, None, ""),
        ok_ref("rw:rev/rev-03", "rev", "rev-03", None, None, ""),
        ok_ref("rw:thread/t1", "thread", "t1", None, None, ""),
        ok_ref("rw:eng/main", "eng", "main", None, None, ""),
        bad_ref("rw:x/fins", "unknown_kind"),
        bad_ref("rw:c/", "empty_id"),
        bad_ref("rw:c/#root", "empty_id"),
        bad_ref("rw:c", "syntax"),
        bad_ref("c/fins", "missing_scheme"),
        bad_ref("rw://project/model", "resource_uri"),
        bad_ref("rw:c/fi ns", "syntax"),
        bad_ref("rw:c/fins#", "empty_anchor"),
        bad_ref("rw:c/fins@", "empty_version"),
    ];
    let schema = root_schema::<rw_model::RwRef>();
    check_flags("refs", &vectors, |_| Ok(schema.clone()))?;
    Ok(json!({
        "$comment": "Generated by `cargo xtask schema`. rw: ref grammar vectors (R2.8, M1.23). ok = RefParts; err = a reason slug (informative only).",
        "pattern": rw_model::REF_PATTERN,
        "vectors": vectors,
    }))
}

fn ok_qty(dim: &str, input: Value, si: f64) -> Value {
    json!({"dim": dim, "input": input, "schema_valid": true, "ok": {"si": si}})
}

fn bad_qty(dim: &str, input: Value, schema_valid: bool, kind: &str) -> Value {
    json!({"dim": dim, "input": input, "schema_valid": schema_valid, "err": kind})
}

fn units() -> Result<Value, String> {
    let vectors = vec![
        // length
        ok_qty("length", json!("54 mm"), 0.054),
        ok_qty("length", json!("54mm"), 0.054),
        ok_qty("length", json!("5.4 cm"), 0.054),
        ok_qty("length", json!("1.5 m"), 1.5),
        ok_qty("length", json!("-2 mm"), -0.002),
        ok_qty("length", json!("1e3 mm"), 1.0),
        ok_qty("length", json!("1/4 in"), 0.25 * INCH),
        ok_qty("length", json!("3 ft"), 3.0 * FOOT),
        ok_qty("length", json!(0), 0.0),
        bad_qty("length", json!(54), false, "unit_missing"),
        bad_qty("length", json!("54"), false, "unit_missing"),
        bad_qty("length", json!("mm"), false, "syntax"),
        bad_qty("length", json!("54 furlongs"), true, "unknown_unit"),
        bad_qty("length", json!("54 kg"), true, "dimension_mismatch"),
        // mass
        ok_qty("mass", json!("120 g"), 0.12),
        ok_qty("mass", json!("1.5 kg"), 1.5),
        ok_qty("mass", json!("2 lb"), 2.0 * POUND),
        ok_qty("mass", json!("4 oz"), 4.0 * OUNCE),
        // time
        ok_qty("time", json!("1.6 s"), 1.6),
        ok_qty("time", json!("250 ms"), 0.25),
        // angle (never a bare number: angle is its own dimension)
        ok_qty("angle", json!("5 deg"), 5.0 * DEG),
        ok_qty("angle", json!("0.1 rad"), 0.1),
        bad_qty("angle", json!(5), false, "unit_missing"),
        // temperature (offset units)
        ok_qty("temperature", json!("300 K"), 300.0),
        ok_qty("temperature", json!("20 degC"), 293.15),
        ok_qty(
            "temperature",
            json!("68 degF"),
            (68.0 - 32.0) * 5.0 / 9.0 + 273.15,
        ),
        // pressure
        ok_qty("pressure", json!("101.325 kPa"), 101_325.0),
        ok_qty("pressure", json!("3 MPa"), 3.0e6),
        ok_qty("pressure", json!("2 bar"), 2.0e5),
        ok_qty("pressure", json!("14.7 psi"), 14.7 * PSI),
        // force and impulse
        ok_qty("force", json!("10 N"), 10.0),
        ok_qty("force", json!("5 lbf"), 5.0 * LBF),
        ok_qty("impulse", json!("20 N*s"), 20.0),
        ok_qty("impulse", json!("1.2 kN*s"), 1200.0),
        // densities
        ok_qty("density", json!("1200 kg/m^3"), 1200.0),
        ok_qty("density", json!("1.25 g/cm^3"), 1250.0),
        ok_qty("area_density", json!("200 g/m^2"), 0.2),
        ok_qty("line_density", json!("5 g/m"), 0.005),
        // velocity
        ok_qty("velocity", json!("3 m/s"), 3.0),
        ok_qty("velocity", json!("10 ft/s"), 10.0 * FOOT),
        // dimensionless: bare numbers allowed
        ok_qty("dimensionless", json!(3), 3.0),
        ok_qty("dimensionless", json!(0.5), 0.5),
    ];
    check_flags("units", &vectors, |v| {
        qty_schema(v["dim"].as_str().unwrap_or_default())
    })?;
    Ok(json!({
        "$comment": "Generated by `cargo xtask schema`. Quantity vectors (R2.2, M1.20): `input` on a field of dimension `dim` parses to `ok.si` (SI) or fails with `err` (UnitError kind; unit_missing is RW-E021). Compare si with rel_tol.",
        "rel_tol": REL_TOL,
        "pattern": rw_units::QTY_PATTERN,
        "vectors": vectors,
    }))
}

fn ok_expr(dim: &str, input: &str, si: f64, refs: &[&str]) -> Value {
    json!({"dim": dim, "input": input, "schema_valid": true, "ok": {"si": si, "refs": refs}})
}

fn bad_expr(dim: &str, input: &str, schema_valid: bool, kind: &str) -> Value {
    json!({"dim": dim, "input": input, "schema_valid": schema_valid, "err": kind})
}

fn exprs() -> Result<Value, String> {
    let vectors = vec![
        ok_expr("length", "= params.d", 0.054, &["params.d"]),
        ok_expr("length", "=params.d", 0.054, &["params.d"]),
        ok_expr("length", "= params.d * 2", 0.108, &["params.d"]),
        ok_expr("length", "= params.d + 2 mm", 0.056, &["params.d"]),
        ok_expr("length", "= (params.d + 6 mm) / 2", 0.03, &["params.d"]),
        ok_expr("length", "= -params.d", -0.054, &["params.d"]),
        ok_expr("length", "= params.len", 0.54, &["params.len"]),
        ok_expr(
            "dimensionless",
            "= params.len / params.d",
            10.0,
            &["params.len", "params.d"],
        ),
        ok_expr("dimensionless", "= params.n * 2", 8.0, &["params.n"]),
        ok_expr("angle", "= params.cant * 2", 10.0 * DEG, &["params.cant"]),
        ok_expr("length", "= c.body.od / 2", 0.027, &["c.body.od"]),
        ok_expr("length", "= c.body.length", 0.54, &["c.body.length"]),
        ok_expr(
            "length",
            "= c.fins.tab.height * 2",
            0.01,
            &["c.fins.tab.height"],
        ),
        ok_expr(
            "length",
            "= c.body.od - 2 * c.body.thickness",
            0.0518,
            &["c.body.od", "c.body.thickness"],
        ),
        ok_expr("length", "= 1/4 in + 0.5 in", 0.75 * INCH, &[]),
        ok_expr("length", "= 54mm", 0.054, &[]),
        ok_expr("mass", "= 1.25 g/cm^3 * 2 cm^3", 0.0025, &[]),
        ok_expr("area", "= params.d^2", 0.054 * 0.054, &["params.d"]),
        ok_expr(
            "length",
            "= sqrt(params.d * params.d)",
            0.054,
            &["params.d"],
        ),
        ok_expr(
            "length",
            "= min(params.d, 50 mm, c.body.od)",
            0.05,
            &["params.d", "c.body.od"],
        ),
        ok_expr("length", "= max(params.d - 60 mm, 0)", 0.0, &["params.d"]),
        ok_expr(
            "length",
            "= clamp(params.d, 10 mm, 40 mm)",
            0.04,
            &["params.d"],
        ),
        ok_expr("length", "= abs(-params.d)", 0.054, &["params.d"]),
        ok_expr("length", "= 0", 0.0, &[]),
        ok_expr("dimensionless", "= 2 * pi", std::f64::consts::TAU, &[]),
        ok_expr("angle", "= 90 deg / params.n", 22.5 * DEG, &["params.n"]),
        bad_expr("length", "= params.d + 1", true, "dimension_mismatch"),
        bad_expr("mass", "= params.d", true, "dimension_mismatch"),
        bad_expr(
            "length",
            "= params.d * params.d",
            true,
            "dimension_mismatch",
        ),
        bad_expr("length", "= sqrt(params.d)", true, "dimension_mismatch"),
        bad_expr("length", "= params.d ^ 0.5", true, "dimension_mismatch"),
        bad_expr("length", "= params.zz", true, "unknown_ref"),
        bad_expr("length", "= d", true, "unknown_ref"),
        bad_expr("length", "= c.body.x_fore", true, "unknown_ref"),
        bad_expr("length", "= c.body.id", true, "unknown_ref"),
        bad_expr("length", "= c.nope.od", true, "unknown_ref"),
        bad_expr("length", "= params.a", true, "cycle"),
        bad_expr("length", "= c.loop.length", true, "cycle"),
        bad_expr("length", "= params.shape", true, "not_numeric"),
        bad_expr("dimensionless", "= params.flag", true, "not_numeric"),
        bad_expr("length", "= c.body.type", true, "not_numeric"),
        bad_expr("dimensionless", "= params.n / 0", true, "domain"),
        bad_expr("length", "= sqrt(0 - params.d * params.d)", true, "domain"),
        bad_expr("length", "= params.d + 2 furlongs", true, "unknown_unit"),
        bad_expr("length", "= params.d *", true, "syntax"),
        bad_expr("length", "= (params.d", true, "syntax"),
        bad_expr("length", "= floor(params.d)", true, "syntax"),
        bad_expr("length", "= clamp(params.d, 1 mm)", true, "syntax"),
        bad_expr("length", "=", false, "syntax"),
    ];
    check_flags("exprs", &vectors, |v| {
        qty_schema(v["dim"].as_str().unwrap_or_default())
    })?;
    // The context is a valid `rocket.rw.toml` (JSON twin) fragment.
    let context = json!({
        "params": {
            "d": {"value": "54 mm", "min": "20 mm", "max": "100 mm"},
            "len": {"value": "= params.d * 10"},
            "n": {"value": 4},
            "cant": {"value": "5 deg"},
            "a": {"value": "= params.b"},
            "b": {"value": "= params.a"},
            "shape": {"value": "ogive", "choices": ["ogive", "conical"]},
            "flag": {"value": true},
        },
        "c": {
            "body": {"type": "body_tube", "od": "54 mm", "thickness": "1.1 mm", "length": "= params.len"},
            "fins": {
                "type": "trapezoidal_fin_set",
                "count": 4,
                "root_chord": "140 mm",
                "tip_chord": "60 mm",
                "span": "90 mm",
                "sweep": "45 mm",
                "thickness": "3 mm",
                "tab": {"height": "5 mm", "length": "100 mm"},
            },
            "loop": {"type": "body_tube", "od": "54 mm", "length": "= c.loop.length + 1 mm"},
        },
    });
    let rocket = root_schema::<rw_model::RocketDoc>();
    if !is_valid(&rocket, &context)? {
        return Err("exprs: context is not a valid RocketDoc".into());
    }
    Ok(json!({
        "$comment": "Generated by `cargo xtask schema`. Expression vectors (R2.3, M1.21): evaluate `input` against `context` (a rocket.rw.toml JSON twin) on a field of dimension `dim`; ok = SI value and the refs it reads directly (in order of first use, no duplicates); err = kind: syntax RW-E040, unknown_ref RW-E041, cycle RW-E042, dimension_mismatch RW-E043, not_numeric RW-E044, domain RW-E045, unknown_unit RW-E022. Refs read source inputs only: `params.<name>` (its `value`) and `c.<id>.<field>[.<sub>]` as written; derived or absent fields are unknown_ref. A bare `0` takes any dimension.",
        "rel_tol": REL_TOL,
        "pattern": rw_units::EXPR_PATTERN,
        "context": context,
        "vectors": vectors,
    }))
}

fn ok_patch(name: &str, doc: &Value, patch: Value, ok: Value) -> Value {
    json!({"name": name, "doc": doc, "patch": patch, "ok": ok})
}

fn bad_patch(name: &str, doc: &Value, patch: Value, op: u32, kind: &str) -> Value {
    json!({"name": name, "doc": doc, "patch": patch, "err": {"op": op, "kind": kind}})
}

/// `PatchOp` vectors (M1.23): RFC 6902 on the id-keyed model value, plus the
/// `rw:` path sugar. Expectations are written by hand, never computed.
fn patches() -> Result<Value, String> {
    let doc = json!({
        "params": {"span": {"value": "90 mm"}},
        "c": {
            "body": {"type": "body_tube", "od": "54 mm", "length": "300 mm"},
            "fins": {"type": "trapezoidal_fin_set", "count": 4, "span": "= params.span"},
        },
        "assert": [{"id": "stable", "expr": "stability.liftoff >= 1 cal"}],
        "configs": {"baseline": {"motors": {"mount": {"motor": "generic:RW_C6G"}}}},
        "sims": {"baseline": {"config": "baseline"}},
    });
    let with = |f: &dyn Fn(&mut Value)| {
        let mut d = doc.clone();
        f(&mut d);
        d
    };
    let lug = json!({"type": "launch_lug", "length": "50 mm", "od": "8 mm"});
    let a2 = json!({"id": "rail", "expr": "rail_exit_velocity_ms >= 15"});
    let esc = json!({"a/b": {"m~n": 1}, "list": [1, 2, 3]});
    let vectors = vec![
        ok_patch(
            "replace a field",
            &doc,
            json!([{"op": "replace", "path": "/c/fins/span", "value": "110 mm"}]),
            with(&|d| d["c"]["fins"]["span"] = json!("110 mm")),
        ),
        ok_patch(
            "rw: ref as a path",
            &doc,
            json!([{"op": "replace", "path": "rw:c/fins/span", "value": "110 mm"}]),
            with(&|d| d["c"]["fins"]["span"] = json!("110 mm")),
        ),
        ok_patch(
            "add a component",
            &doc,
            json!([{"op": "add", "path": "/c/lug", "value": lug}]),
            with(&|d| d["c"]["lug"] = lug.clone()),
        ),
        ok_patch(
            "add replaces an existing member",
            &doc,
            json!([{"op": "add", "path": "/c/fins/count", "value": 3}]),
            with(&|d| d["c"]["fins"]["count"] = json!(3)),
        ),
        ok_patch(
            "remove a component",
            &doc,
            json!([{"op": "remove", "path": "/c/fins"}]),
            with(&|d| {
                d["c"].as_object_mut().unwrap().remove("fins");
            }),
        ),
        ok_patch(
            "move renames an id",
            &doc,
            json!([{"op": "move", "from": "/c/fins", "path": "/c/fin_set"}]),
            with(&|d| {
                let f = d["c"].as_object_mut().unwrap().remove("fins").unwrap();
                d["c"]["fin_set"] = f;
            }),
        ),
        ok_patch(
            "move onto itself is a no-op",
            &doc,
            json!([{"op": "move", "from": "/c/fins", "path": "/c/fins"}]),
            doc.clone(),
        ),
        ok_patch(
            "copy a component",
            &doc,
            json!([{"op": "copy", "from": "/c/body", "path": "/c/body2"}]),
            with(&|d| d["c"]["body2"] = d["c"]["body"].clone()),
        ),
        ok_patch(
            "test compares numbers by value",
            &doc,
            json!([{"op": "test", "path": "/c/fins/count", "value": 4.0}]),
            doc.clone(),
        ),
        ok_patch(
            "test compares objects regardless of key order",
            &doc,
            json!([{"op": "test", "path": "/c/body", "value": {"length": "300 mm", "od": "54 mm", "type": "body_tube"}}]),
            doc.clone(),
        ),
        ok_patch(
            "append to an array",
            &doc,
            json!([{"op": "add", "path": "/assert/-", "value": a2}]),
            with(&|d| d["assert"].as_array_mut().unwrap().push(a2.clone())),
        ),
        ok_patch(
            "insert at an array index",
            &doc,
            json!([{"op": "add", "path": "/assert/0", "value": a2}]),
            with(&|d| d["assert"].as_array_mut().unwrap().insert(0, a2.clone())),
        ),
        ok_patch(
            "add at the array end index",
            &doc,
            json!([{"op": "add", "path": "/assert/1", "value": a2}]),
            with(&|d| d["assert"].as_array_mut().unwrap().push(a2.clone())),
        ),
        ok_patch(
            "remove an array element",
            &doc,
            json!([{"op": "remove", "path": "/assert/0"}]),
            with(&|d| d["assert"] = json!([])),
        ),
        ok_patch(
            "rw:cfg ref maps to /configs",
            &doc,
            json!([{"op": "add", "path": "rw:cfg/baseline/motors/mount/delay", "value": "7 s"}]),
            with(&|d| d["configs"]["baseline"]["motors"]["mount"]["delay"] = json!("7 s")),
        ),
        ok_patch(
            "rw:sim ref maps to /sims",
            &doc,
            json!([{"op": "replace", "path": "rw:sim/baseline/config", "value": "other"}]),
            with(&|d| d["sims"]["baseline"]["config"] = json!("other")),
        ),
        ok_patch(
            "rw:eng ref maps to /engines",
            &with(&|d| d["engines"] = json!({"main": {"thrust": "1 kN"}})),
            json!([{"op": "replace", "path": "rw:eng/main/thrust", "value": "2 kN"}]),
            with(&|d| d["engines"] = json!({"main": {"thrust": "2 kN"}})),
        ),
        ok_patch(
            "ops apply in order",
            &doc,
            json!([
                {"op": "add", "path": "/c/lug", "value": lug},
                {"op": "replace", "path": "/c/lug/length", "value": "60 mm"},
                {"op": "test", "path": "/c/lug/length", "value": "60 mm"},
            ]),
            with(&|d| {
                d["c"]["lug"] = lug.clone();
                d["c"]["lug"]["length"] = json!("60 mm");
            }),
        ),
        ok_patch(
            "pointer escapes",
            &esc,
            json!([{"op": "replace", "path": "/a~1b/m~0n", "value": 2}]),
            json!({"a/b": {"m~n": 2}, "list": [1, 2, 3]}),
        ),
        ok_patch(
            "replace the whole document",
            &esc,
            json!([{"op": "replace", "path": "", "value": {"x": 1}}]),
            json!({"x": 1}),
        ),
        bad_patch(
            "test fails",
            &doc,
            json!([{"op": "test", "path": "/c/fins/count", "value": 3}]),
            0,
            "test_failed",
        ),
        bad_patch(
            "the patch is atomic and reports the failing op",
            &doc,
            json!([
                {"op": "replace", "path": "/c/fins/span", "value": "110 mm"},
                {"op": "test", "path": "/c/fins/span", "value": "90 mm"},
            ]),
            1,
            "test_failed",
        ),
        bad_patch(
            "replace a missing component",
            &doc,
            json!([{"op": "replace", "path": "/c/nope/span", "value": "1 mm"}]),
            0,
            "not_found",
        ),
        bad_patch(
            "replace a missing field",
            &doc,
            json!([{"op": "replace", "path": "/c/fins/cant", "value": "1 deg"}]),
            0,
            "not_found",
        ),
        bad_patch(
            "remove a missing field",
            &doc,
            json!([{"op": "remove", "path": "/c/fins/cant"}]),
            0,
            "not_found",
        ),
        bad_patch(
            "add under a missing parent",
            &doc,
            json!([{"op": "add", "path": "/c/nope/span", "value": "1 mm"}]),
            0,
            "not_found",
        ),
        bad_patch(
            "add under a scalar",
            &doc,
            json!([{"op": "add", "path": "/c/body/od/x", "value": 1}]),
            0,
            "not_found",
        ),
        bad_patch(
            "move from a missing path",
            &doc,
            json!([{"op": "move", "from": "/c/nope", "path": "/c/x"}]),
            0,
            "not_found",
        ),
        bad_patch(
            "copy from a missing path",
            &doc,
            json!([{"op": "copy", "from": "/c/nope", "path": "/c/x"}]),
            0,
            "not_found",
        ),
        bad_patch(
            "move into its own child",
            &doc,
            json!([{"op": "move", "from": "/c", "path": "/c/x"}]),
            0,
            "move_into_child",
        ),
        bad_patch(
            "array index out of range",
            &doc,
            json!([{"op": "replace", "path": "/assert/1", "value": a2}]),
            0,
            "invalid_index",
        ),
        bad_patch(
            "add past the array end",
            &doc,
            json!([{"op": "add", "path": "/assert/2", "value": a2}]),
            0,
            "invalid_index",
        ),
        bad_patch(
            "leading zero index",
            &esc,
            json!([{"op": "remove", "path": "/list/01"}]),
            0,
            "invalid_index",
        ),
        bad_patch(
            "non-numeric index",
            &esc,
            json!([{"op": "remove", "path": "/list/x"}]),
            0,
            "invalid_index",
        ),
        bad_patch(
            "dash outside add",
            &esc,
            json!([{"op": "remove", "path": "/list/-"}]),
            0,
            "invalid_index",
        ),
        bad_patch(
            "pointer without a leading slash",
            &doc,
            json!([{"op": "remove", "path": "c/fins"}]),
            0,
            "invalid_pointer",
        ),
        bad_patch(
            "bad escape",
            &esc,
            json!([{"op": "remove", "path": "/a~2b"}]),
            0,
            "invalid_pointer",
        ),
        bad_patch(
            "remove the root",
            &doc,
            json!([{"op": "remove", "path": ""}]),
            0,
            "invalid_pointer",
        ),
        bad_patch(
            "rw: ref with an anchor",
            &doc,
            json!([{"op": "replace", "path": "rw:c/fins#root_le", "value": 1}]),
            0,
            "invalid_pointer",
        ),
        bad_patch(
            "rw: ref to a run",
            &doc,
            json!([{"op": "remove", "path": "rw:run/3f9a2c/summary"}]),
            0,
            "invalid_pointer",
        ),
        bad_patch(
            "malformed rw: ref",
            &doc,
            json!([{"op": "remove", "path": "rw:c/"}]),
            0,
            "invalid_pointer",
        ),
    ];
    let op_schema = root_schema::<rw_model::PatchOp>();
    for v in &vectors {
        for op in v["patch"].as_array().into_iter().flatten() {
            if !is_valid(&op_schema, op)? {
                return Err(format!(
                    "patches: `{}` has an op the PatchOp schema rejects",
                    v["name"]
                ));
            }
        }
    }
    Ok(json!({
        "$comment": "Generated by `cargo xtask schema`. PatchOp vectors (R3.3, M1.23): apply `patch` (RFC 6902) to `doc`, a model value keyed by id. ok = the resulting document; err = the index of the failing op and its kind (invalid_pointer, not_found, invalid_index, test_failed, move_into_child). The patch is atomic. A path may be an `rw:` ref: c -> /c/<id>, cfg -> /configs/<id>, sim -> /sims/<id>, eng -> /engines/<id>, then its pointer; other kinds, anchors, and versions are invalid_pointer. `test` compares numbers by value and objects without regard to key order.",
        "vectors": vectors,
    }))
}

/// The vector files, by stem.
pub fn all() -> Result<Vec<(&'static str, Value)>, String> {
    Ok(vec![
        ("refs", refs()?),
        ("units", units()?),
        ("exprs", exprs()?),
        ("patches", patches()?),
    ])
}
