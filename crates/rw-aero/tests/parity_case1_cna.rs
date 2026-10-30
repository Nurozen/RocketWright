//! Parity diagnostic: per-component C_Nα and CP of oracle case 1 at M 0.3,
//! α = 0 (`tests/oracle/case1.aero_sweep.json`), with the model built from
//! `tests/oracle/case1.geometry.json`. Run with `--nocapture` for the table;
//! the numbers are recorded in `docs/dev/parity-log.md`. Inputs are embedded
//! with `include_str!`, so the test touches no filesystem API (I5).
//!
//! Tolerances (M1.38-p): nose ±2 %, fin set ±3 %, total ±3 %, CP ±3 mm.

use rw_aero::{AeroCoeffs, AeroModel, AeroOptions, AeroState};
use rw_model::EvaluatedModel;
use serde_json::{Map, Value, json};

const MACH: f64 = 0.3;
/// Sea-level speed of sound and kinematic viscosity (USSA 1976).
const A0: f64 = 340.294;
const NU0: f64 = 1.4607e-5;

fn geometry() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/oracle/case1.geometry.json"
    )))
    .expect("geometry json")
}

fn sweep() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/oracle/case1.aero_sweep.json"
    )))
    .expect("aero sweep json")
}

fn f(fields: &Map<String, Value>, k: &str) -> f64 {
    fields.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

/// Our component JSON for one oracle component, or `None` when it has no
/// aerodynamic role. The fin cross-section is not in the oracle geometry;
/// rounded is assumed (docs/dev/parity-log.md).
fn translate(id: &str, parent: Option<&str>, c: &Value) -> Option<Value> {
    let fl = c["fields"].as_object().unwrap();
    let len = c["length_m"].as_f64().unwrap();
    let (containment, shape) = match c["type"].as_str().unwrap() {
        "nose_cone" => (
            "axial",
            json!({"type": "nose_cone", "shape": c["shape"], "shape_param": f(fl, "shape_parameter"),
                "length": len, "od": f(fl, "od_m"), "thickness": f(fl, "thickness_m"),
                "shoulder": {"length": f(fl, "shoulder_length_m"), "od": f(fl, "shoulder_od_m"),
                    "thickness": f(fl, "shoulder_thickness_m"), "capped": f(fl, "shoulder_capped") > 0.5}}),
        ),
        "body_tube" => (
            "axial",
            json!({"type": "body_tube", "length": len, "od": f(fl, "od_m"),
                "id": f(fl, "od_m") - 2.0 * f(fl, "thickness_m")}),
        ),
        "launch_lug" => (
            "surface",
            json!({"type": "launch_lug", "length": len, "od": f(fl, "od_m"),
                "id": f(fl, "od_m") - 2.0 * f(fl, "thickness_m")}),
        ),
        "trapezoidal_fin_set" => (
            "surface",
            json!({"type": "trapezoidal_fin_set", "count": f(fl, "count") as u32,
                "thickness": f(fl, "thickness_m"), "cross_section": "rounded",
                "cant": f(fl, "cant_rad"), "fillet_radius": f(fl, "fillet_radius_m"),
                "root_chord": f(fl, "root_chord_m"), "tip_chord": f(fl, "tip_chord_m"),
                "span": f(fl, "height_m"), "sweep": f(fl, "sweep_m")}),
        ),
        "inner_tube" => (
            "inner",
            json!({"type": "inner_tube", "length": len, "od": f(fl, "od_m"),
                "id": f(fl, "od_m") - 2.0 * f(fl, "thickness_m"),
                "motor_mount": f(fl, "motor_mount") > 0.5, "overhang": f(fl, "motor_overhang_m")}),
        ),
        _ => return None,
    };
    let x0 = c["x_fore_m"].as_f64().unwrap();
    Some(json!({
        "id": id, "name": c["name"], "parent": parent, "children": [],
        "containment": containment, "aero": containment != "inner", "cut": false,
        "x_fore": x0, "x_aft": x0 + len, "radial": 0.0, "roll": 0.0,
        "instances": [{ "index": 0, "offset": [0.0, 0.0, 0.0], "roll": 0.0 }],
        "anchors": [], "roughness": f(fl, "roughness_m"), "shape": shape
    }))
}

/// The case-1 model on the oracle's reference (body diameter 0.025 m), with
/// the M1.5 contract fixture as the envelope. Ids are the oracle names.
fn case1() -> EvaluatedModel {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/contracts/evaluated-model.json"
    )))
    .expect("fixture json");
    let mut m: EvaluatedModel =
        serde_json::from_value(fixture["payload"].clone()).expect("fixture model");
    let g = geometry();
    m.components = g["components"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| {
            let id = c["name"].as_str().unwrap();
            translate(id, c["parent"].as_str(), c)
        })
        .map(|v| serde_json::from_value(v).expect("component"))
        .collect();
    let d = 0.025;
    m.reference.diameter = d;
    m.reference.area = std::f64::consts::PI * d * d / 4.0;
    m
}

fn eval(model: &EvaluatedModel, alpha: f64) -> AeroCoeffs {
    let am = AeroModel::new(model, &rw_geom::build(model), &AeroOptions::default());
    am.eval(&AeroState {
        mach: MACH,
        speed: MACH * A0,
        alpha,
        roll_rate: 0.0,
        pitch_rate: 0.0,
        kinematic_viscosity: NU0,
        thrusting: false,
    })
}

fn oracle_point() -> Value {
    sweep()["points"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| (p["mach"].as_f64().unwrap() - MACH).abs() < 1e-9)
        .cloned()
        .expect("M 0.3 point")
}

#[test]
fn case1_component_cna_and_cp() {
    let model = case1();
    let c = eval(&model, 0.0);
    let gold = oracle_point();
    assert!((c.ref_area - 4.909e-4).abs() < 1e-7);

    println!(
        "{:<22} {:>9} {:>9} {:>8} {:>9} {:>9} {:>8}",
        "component", "CNa or", "CNa ours", "d %", "CP or", "CP ours", "d mm"
    );
    // (oracle name, C_Nα tolerance, CP tolerance in m); body tube is printed only.
    let checks = [
        ("Nose cone", Some(0.02), Some(0.003)),
        ("Body tube", None, None),
        ("Trapezoidal fin set", Some(0.03), Some(0.003)),
    ];
    for (name, tol_cna, tol_cp) in checks {
        let or = gold["components"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .unwrap();
        let (cna_or, cp_or) = (or["cna"].as_f64().unwrap(), or["cp_m"].as_f64().unwrap());
        let ours = c.components.iter().find(|t| t.id == name).unwrap();
        let d = ours.cn_alpha / cna_or - 1.0;
        let dx = ours.cp - cp_or;
        println!(
            "{name:<22} {cna_or:>9.4} {:>9.4} {:>+8.2} {cp_or:>9.4} {:>9.4} {:>+8.2}",
            ours.cn_alpha,
            100.0 * d,
            ours.cp,
            1000.0 * dx
        );
        if let Some(t) = tol_cna {
            assert!(d.abs() <= t, "{name} C_Nα {} vs {cna_or}", ours.cn_alpha);
        }
        if let Some(t) = tol_cp {
            assert!(dx.abs() <= t, "{name} CP {} vs {cp_or}", ours.cp);
        }
    }
    let (cna_or, cp_or) = (
        gold["cna"].as_f64().unwrap(),
        gold["cp_m"].as_f64().unwrap(),
    );
    let d = c.cn_alpha / cna_or - 1.0;
    let dx = c.cp - cp_or;
    println!(
        "{:<22} {cna_or:>9.4} {:>9.4} {:>+8.2} {cp_or:>9.4} {:>9.4} {:>+8.2}",
        "total",
        c.cn_alpha,
        100.0 * d,
        c.cp,
        1000.0 * dx
    );
    assert!(d.abs() <= 0.03, "total C_Nα {} vs {cna_or}", c.cn_alpha);
    assert!(dx.abs() <= 0.003, "total CP {} vs {cp_or}", c.cp);
}

/// Drag breakdown at M 0.3 against the oracle (report only; the lug term is
/// an open literature-vs-oracle delta, see parity-log).
#[test]
fn case1_drag_report() {
    let model = case1();
    let c = eval(&model, 0.0);
    let gold = oracle_point();
    let cd_or = gold["cd_total"].as_f64().unwrap();
    let am = AeroModel::new(&model, &rw_geom::build(&model), &AeroOptions::default());
    let terms = am.drag_terms(&AeroState {
        mach: MACH,
        speed: MACH * A0,
        alpha: 0.0,
        roll_rate: 0.0,
        pitch_rate: 0.0,
        kinematic_viscosity: NU0,
        thrusting: false,
    });
    let lug: f64 = terms
        .iter()
        .filter(|t| t.id == "Launch lug")
        .map(|t| t.cd)
        .sum();
    let lug_or = gold["components"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "Launch lug")
        .and_then(|t| t["cd_total"].as_f64())
        .unwrap();
    println!(
        "CD total {cd_or:.4} vs {:.4} ({:+.2}%); lug {lug_or:.4} vs {lug:.4}; \
         total without the lug difference {:+.2}%",
        c.cd,
        100.0 * (c.cd / cd_or - 1.0),
        100.0 * ((c.cd - lug + lug_or) / cd_or - 1.0)
    );
    // Sanity bound only: everything except the lug term is within 1 %.
    assert!(((c.cd - lug + lug_or) / cd_or - 1.0).abs() < 0.01);
}

/// Secant C_N/α per component at α = 5°, M 0.3 (report only; no α > 0 golden
/// is exported yet). Body lift (niskanen-2009 eq 3.26) shows on the nose and
/// tube rows; the fin set is linear in α subsonically.
#[test]
fn case1_alpha5_report() {
    let model = case1();
    let c = eval(&model, 5f64.to_radians());
    for t in &c.components {
        println!(
            "α 5°: {:<22} C_N/α {:>8.4}  CP {:.4}",
            t.id, t.cn_alpha, t.cp
        );
    }
    println!("α 5°: total C_N/α {:.4}  CP {:.4}", c.cn_alpha, c.cp);
    let fins = c
        .components
        .iter()
        .find(|t| t.id == "Trapezoidal fin set")
        .unwrap();
    let fins0 = eval(&model, 0.0)
        .components
        .into_iter()
        .find(|t| t.id == "Trapezoidal fin set")
        .unwrap();
    assert!((fins.cn_alpha / fins0.cn_alpha - 1.0).abs() < 1e-12);
}
