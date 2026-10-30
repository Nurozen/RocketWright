//! Diagnostic (not a gate): per-component mass and the static mass/CG of
//! oracle case 1 (`tests/oracle/case1.geometry.json`, `case1-generic.json`)
//! against ours. Run with `--nocapture` to see the table; the numbers are
//! recorded in `docs/dev/parity-log.md`. Assertions are loose sanity bounds.

mod common;

use rw_mass::MassModel;
use rw_model::EvaluatedModel;
use rw_motor::{MountedMotor, generic::generic_motor};
use serde_json::{Map, Value, json};

fn oracle(name: &str) -> Value {
    let text = match name {
        "geometry" => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/oracle/case1.geometry.json"
        )),
        _ => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/oracle/case1-generic.json"
        )),
    };
    serde_json::from_str(text).expect("oracle json")
}

fn f(fields: &Map<String, Value>, k: &str) -> f64 {
    fields.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

/// The shared shroud-line material of the case-1 parachute.
const SHROUD_LINES: &str = "shroud_lines";

/// Our id, shape, and material density for one oracle component.
fn translate(i: usize, c: &Value) -> (String, Value, Value, f64) {
    let fl = c["fields"].as_object().unwrap();
    let kind = c["type"].as_str().unwrap();
    let len = c["length_m"].as_f64().unwrap();
    let id = format!("c{i}_{kind}");
    let bulk = json!({ "density": f(fl, "density_kgm3") });
    let (shape, mat) = match kind {
        "nose_cone" => (
            json!({"type": "nose_cone", "shape": c["shape"], "shape_param": f(fl, "shape_parameter"),
                "length": len, "od": f(fl, "od_m"), "thickness": f(fl, "thickness_m"),
                "shoulder": {"length": f(fl, "shoulder_length_m"), "od": f(fl, "shoulder_od_m"),
                    "thickness": f(fl, "shoulder_thickness_m"), "capped": f(fl, "shoulder_capped") > 0.5}}),
            bulk,
        ),
        "body_tube" => (
            json!({"type": "body_tube", "length": len, "od": f(fl, "od_m"),
                "id": f(fl, "od_m") - 2.0 * f(fl, "thickness_m")}),
            bulk,
        ),
        "inner_tube" => (
            json!({"type": "inner_tube", "length": len, "od": f(fl, "od_m"),
                "id": f(fl, "od_m") - 2.0 * f(fl, "thickness_m"),
                "motor_mount": f(fl, "motor_mount") > 0.5, "overhang": f(fl, "motor_overhang_m")}),
            bulk,
        ),
        "centering_ring" | "engine_block" => (
            json!({"type": kind, "length": len, "od": f(fl, "od_m"), "id": f(fl, "id_m")}),
            bulk,
        ),
        "launch_lug" => (
            json!({"type": "launch_lug", "length": len, "od": f(fl, "od_m"),
                "id": f(fl, "od_m") - 2.0 * f(fl, "thickness_m")}),
            bulk,
        ),
        "parachute" => (
            json!({"type": "parachute", "diameter": f(fl, "diameter_m"), "cd": f(fl, "cd"),
                "spill_hole": 0.0, "packed_length": f(fl, "packed_length_m"),
                "packed_diameter": 2.0 * f(fl, "packed_radius_m"),
                "line_count": f(fl, "line_count") as u32, "line_length": f(fl, "line_length_m"),
                "line_material": SHROUD_LINES}),
            json!({ "surface_density": f(fl, "surface_density_kgm2") }),
        ),
        "shock_cord" => (
            json!({"type": "shock_cord", "cord_length": f(fl, "cord_length_m"),
                "packed_length": f(fl, "packed_length_m"),
                "packed_diameter": 2.0 * f(fl, "packed_radius_m")}),
            json!({ "line_density": f(fl, "line_density_kgm") }),
        ),
        "mass_component" => (
            json!({"type": "mass_component", "mass": f(fl, "mass_kg"), "length": len,
                "od": 2.0 * f(fl, "packed_radius_m")}),
            json!({}),
        ),
        "trapezoidal_fin_set" => {
            let mut s = json!({"type": "trapezoidal_fin_set", "count": f(fl, "count") as u32,
                "thickness": f(fl, "thickness_m"), "cross_section": "square",
                "cant": f(fl, "cant_rad"), "fillet_radius": f(fl, "fillet_radius_m"),
                "root_chord": f(fl, "root_chord_m"), "tip_chord": f(fl, "tip_chord_m"),
                "span": f(fl, "height_m"), "sweep": f(fl, "sweep_m")});
            if f(fl, "tab_height_m") > 0.0 {
                s["tab"] = json!({"height": f(fl, "tab_height_m"), "length": f(fl, "tab_length_m"),
                    "offset": f(fl, "tab_offset_m")});
            }
            (s, bulk)
        }
        other => panic!("unmapped oracle type {other}"),
    };
    (id, shape, mat, f(fl, "component_mass_kg"))
}

fn case1() -> (EvaluatedModel, Vec<(String, f64)>, Value) {
    let g = oracle("geometry");
    let comps = g["components"].as_array().unwrap();
    let names: Vec<&str> = comps.iter().map(|c| c["name"].as_str().unwrap()).collect();
    let mut out = Vec::new();
    let mut golden = Vec::new();
    let mut materials = Map::new();
    for (i, c) in comps.iter().enumerate() {
        let (id, shape, mat, m) = translate(i, c);
        let parent = c["parent"].as_str().map(|p| {
            let k = names.iter().position(|n| *n == p).unwrap();
            format!("c{k}_{}", comps[k]["type"].as_str().unwrap())
        });
        let x0 = c["x_fore_m"].as_f64().unwrap();
        let mut v = common::comp(
            &id,
            parent.as_deref(),
            x0,
            x0 + c["length_m"].as_f64().unwrap(),
            shape,
        );
        v["material"] = json!(id.clone());
        let roll = f(c["fields"].as_object().unwrap(), "angle_offset_rad");
        v["roll"] = json!(roll);
        if c["type"] == "trapezoidal_fin_set" {
            v["instances"] = json!([]);
        }
        if c["type"] == "parachute" {
            let fl = c["fields"].as_object().unwrap();
            materials.insert(
                SHROUD_LINES.into(),
                json!({ "line_density": f(fl, "line_line_density_kgm") }),
            );
        }
        materials.insert(id.clone(), mat);
        golden.push((id, m));
        out.push(v);
    }
    let mut model = common::model(out, 1.0);
    model.materials = serde_json::from_value(Value::Object(materials)).unwrap();
    (model, golden, oracle("golden"))
}

#[test]
fn case1_component_masses_report() {
    let (model, golden, gold) = case1();
    let geo = rw_geom::build(&model);
    // RW_C6G in the inner tube: aft end = tube aft + overhang.
    let curve = generic_motor("RW_C6G").expect("generic C6");
    let mmt = model
        .components
        .iter()
        .find(|c| c.id.ends_with("inner_tube"))
        .unwrap();
    let overhang = match &mmt.shape {
        rw_model::EvalShape::InnerTube { overhang, .. } => *overhang,
        _ => 0.0,
    };
    let motor = MountedMotor {
        mount: mmt.id.clone(),
        x_fore: mmt.x_aft + overhang - curve.length,
        curve,
        ignition_time: 0.0,
        delay: Some(7.0),
        count: 1,
    };
    let mm = MassModel::new(&model, &geo, std::slice::from_ref(&motor));
    let ours = mm.breakdown();
    println!(
        "{:<28} {:>12} {:>12} {:>9}",
        "component", "oracle kg", "ours kg", "delta %"
    );
    let mut worst: f64 = 0.0;
    for (id, m_or) in &golden {
        let m = ours.iter().find(|c| &c.id == id).unwrap().mass;
        let d = 100.0 * (m - m_or) / m_or;
        worst = worst.max(d.abs());
        println!("{id:<28} {m_or:>12.6e} {m:>12.6e} {d:>+9.3}");
    }
    let st = &gold["static"];
    let (m_or, cg_or) = (
        st["mass_kg"].as_f64().unwrap(),
        st["cg_m"].as_f64().unwrap(),
    );
    let at0 = mm.at(0.0);
    println!(
        "static (launch, with motor): mass {m_or:.6} vs {:.6} ({:+.3}%), cg {cg_or:.5} vs {:.5} ({:+.2} mm)",
        at0.mass,
        100.0 * (at0.mass - m_or) / m_or,
        at0.cg,
        1000.0 * (at0.cg - cg_or)
    );
    println!(
        "dry: mass {:.6} cg {:.5}; motor x_fore {:.4}",
        mm.dry().mass,
        mm.dry().cg,
        motor.x_fore
    );
    // Sanity bounds only (diagnostic): parts within 5%, static totals within
    // 10% (the parachute carries its shroud lines via `line_*`).
    assert!(worst < 5.0, "a component differs by {worst:.2}%");
    assert!(((at0.mass - m_or) / m_or).abs() < 0.10);
    assert!((at0.cg - cg_or).abs() < 0.02);
}
