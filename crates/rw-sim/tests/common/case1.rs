//! Oracle case 1 ("A simple model rocket", generic RW_C6G-7) as our model,
//! built from `tests/oracle/case1.geometry.json` (component tree in SI) and
//! the golden's conditions: geometry, materials, roughness, motor, parachute
//! deployment at ejection, and the simulation definition.
//!
//! Translation choices (also in `docs/dev/parity-log.md`):
//! - fin cross-section rounded (not in the oracle geometry; M1.38 parity);
//! - the parachute shroud lines map to `line_count` / `line_length` /
//!   `line_material` (one shared `shroud_lines` material), so rw-mass weighs
//!   them with the canopy.

use rw_aero::{AeroModel, AeroOptions};
use rw_geom::Geometry;
use rw_mass::MassModel;
use rw_model::{EvalConfig, EvalSim, EvaluatedModel};
use rw_motor::{MountedMotor, generic::generic_motor};
use rw_sim::SimInput;
use serde_json::{Map, Value, json};

fn geometry_json() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/oracle/case1.geometry.json"
    )))
    .expect("geometry json")
}

fn fixture_model() -> EvaluatedModel {
    let v: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/contracts/evaluated-model.json"
    )))
    .expect("fixture json");
    serde_json::from_value(v["payload"].clone()).expect("fixture model")
}

fn f(fields: &Map<String, Value>, k: &str) -> f64 {
    fields.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

/// The shared shroud-line material of the case-1 parachute.
const SHROUD_LINES: &str = "shroud_lines";

/// Our containment, shape, and material for one oracle component.
fn translate(c: &Value) -> (&'static str, Value, Value) {
    let fl = c["fields"].as_object().unwrap();
    let kind = c["type"].as_str().unwrap();
    let len = c["length_m"].as_f64().unwrap();
    let bulk = json!({ "density": f(fl, "density_kgm3") });
    match kind {
        "nose_cone" => (
            "axial",
            json!({"type": "nose_cone", "shape": c["shape"], "shape_param": f(fl, "shape_parameter"),
                "length": len, "od": f(fl, "od_m"), "thickness": f(fl, "thickness_m"),
                "shoulder": {"length": f(fl, "shoulder_length_m"), "od": f(fl, "shoulder_od_m"),
                    "thickness": f(fl, "shoulder_thickness_m"), "capped": f(fl, "shoulder_capped") > 0.5}}),
            bulk,
        ),
        "body_tube" => (
            "axial",
            json!({"type": "body_tube", "length": len, "od": f(fl, "od_m"),
                "id": f(fl, "od_m") - 2.0 * f(fl, "thickness_m")}),
            bulk,
        ),
        "inner_tube" => (
            "inner",
            json!({"type": "inner_tube", "length": len, "od": f(fl, "od_m"),
                "id": f(fl, "od_m") - 2.0 * f(fl, "thickness_m"),
                "motor_mount": f(fl, "motor_mount") > 0.5, "overhang": f(fl, "motor_overhang_m")}),
            bulk,
        ),
        "centering_ring" | "engine_block" => (
            "inner",
            json!({"type": kind, "length": len, "od": f(fl, "od_m"), "id": f(fl, "id_m")}),
            bulk,
        ),
        "launch_lug" => (
            "surface",
            json!({"type": "launch_lug", "length": len, "od": f(fl, "od_m"),
                "id": f(fl, "od_m") - 2.0 * f(fl, "thickness_m")}),
            bulk,
        ),
        "parachute" => (
            "inner",
            json!({"type": "parachute", "diameter": f(fl, "diameter_m"), "cd": f(fl, "cd"),
                "spill_hole": 0.0, "packed_length": f(fl, "packed_length_m"),
                "packed_diameter": 2.0 * f(fl, "packed_radius_m"),
                "line_count": f(fl, "line_count") as u32, "line_length": f(fl, "line_length_m"),
                "line_material": SHROUD_LINES}),
            json!({ "surface_density": f(fl, "surface_density_kgm2") }),
        ),
        "shock_cord" => (
            "inner",
            json!({"type": "shock_cord", "cord_length": f(fl, "cord_length_m"),
                "packed_length": f(fl, "packed_length_m"),
                "packed_diameter": 2.0 * f(fl, "packed_radius_m")}),
            json!({ "line_density": f(fl, "line_density_kgm") }),
        ),
        "mass_component" => (
            "inner",
            json!({"type": "mass_component", "mass": f(fl, "mass_kg"), "length": len,
                "od": 2.0 * f(fl, "packed_radius_m")}),
            json!({}),
        ),
        "trapezoidal_fin_set" => (
            "surface",
            json!({"type": "trapezoidal_fin_set", "count": f(fl, "count") as u32,
                "thickness": f(fl, "thickness_m"), "cross_section": "rounded",
                "cant": f(fl, "cant_rad"), "fillet_radius": f(fl, "fillet_radius_m"),
                "root_chord": f(fl, "root_chord_m"), "tip_chord": f(fl, "tip_chord_m"),
                "span": f(fl, "height_m"), "sweep": f(fl, "sweep_m")}),
            bulk,
        ),
        other => panic!("unmapped oracle type {other}"),
    }
}

fn comp(id: &str, parent: Option<&str>, containment: &str, x: [f64; 2], shape: Value) -> Value {
    json!({
        "id": id, "name": id, "parent": parent, "children": [],
        "containment": containment, "aero": containment != "inner", "cut": false,
        "x_fore": x[0], "x_aft": x[1], "radial": 0.0, "roll": 0.0,
        "instances": [{ "index": 0, "offset": [0.0, 0.0, 0.0], "roll": 0.0 }],
        "anchors": [], "material": id, "shape": shape
    })
}

/// The case-1 vehicle, its IF5 models, and the oracle simulation setup.
pub struct Case1 {
    pub model: EvaluatedModel,
    pub geometry: Geometry,
    pub motor: MountedMotor,
    pub config: EvalConfig,
    pub sim: EvalSim,
}

impl Case1 {
    /// The model as the oracle geometry describes it (shroud lines included).
    ///
    /// cite: n/a test fixture builder
    pub fn new() -> Self {
        let g = geometry_json();
        let comps = g["components"].as_array().unwrap();
        let names: Vec<&str> = comps.iter().map(|c| c["name"].as_str().unwrap()).collect();
        let id_of = |k: usize| format!("c{k}_{}", comps[k]["type"].as_str().unwrap());
        let mut out = Vec::new();
        let mut materials = Map::new();
        for (i, c) in comps.iter().enumerate() {
            let (containment, shape, mat) = translate(c);
            let id = id_of(i);
            let parent = c["parent"]
                .as_str()
                .map(|p| id_of(names.iter().position(|n| *n == p).unwrap()));
            let x0 = c["x_fore_m"].as_f64().unwrap();
            let x1 = x0 + c["length_m"].as_f64().unwrap();
            let mut v = comp(&id, parent.as_deref(), containment, [x0, x1], shape);
            let fl = c["fields"].as_object().unwrap();
            if let Some(eps) = fl.get("roughness_m").and_then(Value::as_f64) {
                v["roughness"] = json!(eps);
            }
            v["roll"] = json!(f(fl, "angle_offset_rad"));
            if c["type"] == "trapezoidal_fin_set" {
                v["instances"] = json!([]);
            }
            if c["type"] == "parachute" {
                materials.insert(
                    SHROUD_LINES.into(),
                    json!({ "line_density": f(fl, "line_line_density_kgm") }),
                );
            }
            materials.insert(id, mat);
            out.push(v);
        }
        let mut model = fixture_model();
        model.config = None;
        model.components = out
            .into_iter()
            .map(|c| serde_json::from_value(c).expect("component"))
            .collect();
        let ids: Vec<(String, Option<String>)> = model
            .components
            .iter()
            .map(|c| (c.id.clone(), c.parent.clone()))
            .collect();
        for c in &mut model.components {
            c.children = ids
                .iter()
                .filter(|(_, p)| p.as_deref() == Some(c.id.as_str()))
                .map(|(id, _)| id.clone())
                .collect();
        }
        model.materials = serde_json::from_value(Value::Object(materials)).unwrap();
        model.reference.diameter = 0.025;
        model.reference.area = core::f64::consts::PI * 0.025 * 0.025 / 4.0;
        model.reference.length = 0.4;
        let geometry = rw_geom::build(&model);

        // RW_C6G-7 in the inner tube: aft end = tube aft + overhang.
        let mmt = model
            .components
            .iter()
            .find(|c| c.id.ends_with("inner_tube"))
            .unwrap();
        let overhang = match &mmt.shape {
            rw_model::EvalShape::InnerTube { overhang, .. } => *overhang,
            _ => 0.0,
        };
        let curve = generic_motor("RW_C6G").expect("generic C6");
        let motor = MountedMotor {
            mount: mmt.id.clone(),
            x_fore: mmt.x_aft + overhang - curve.length,
            curve,
            ignition_time: 0.0,
            delay: Some(7.0),
            count: 1,
        };
        let chute = model
            .components
            .iter()
            .find(|c| c.id.ends_with("_parachute"))
            .unwrap()
            .id
            .clone();
        let config: EvalConfig = serde_json::from_value(json!({
            "id": "c6_7", "name": "[RW_C6G-7]",
            "motors": [{"mount": motor.mount, "motor": "generic:RW_C6G", "delay": 7.0,
                "ignition": "launch", "ignition_delay": 0.0}],
            "stages": [],
            "deployments": [{"component": chute, "event": "ejection", "delay": 0.0}]
        }))
        .expect("config");
        let sim: EvalSim = serde_json::from_value(json!({
            "id": "sim5", "name": "Simulation 5", "kind": "flight", "config": "c6_7",
            "conditions": super::golden()["conditions"],
            "series_dt": 0.01, "max_time": 300.0, "rtol": 1e-6, "atol": 1e-9, "seed": 0
        }))
        .expect("sim");
        Self {
            model,
            geometry,
            motor,
            config,
            sim,
        }
    }

    /// Our aerodynamic model (default options).
    ///
    /// cite: n/a test fixture builder
    pub fn aero(&self) -> AeroModel {
        AeroModel::new(&self.model, &self.geometry, &AeroOptions::default())
    }

    /// Our mass model with the motor.
    ///
    /// cite: n/a test fixture builder
    pub fn mass(&self) -> MassModel {
        MassModel::new(
            &self.model,
            &self.geometry,
            std::slice::from_ref(&self.motor),
        )
    }

    /// The IF6 input, with `integrator` replacing the golden's (`rk4` at
    /// 0.05 s mirrors the oracle; `dp54` is the production default).
    ///
    /// cite: n/a test fixture builder
    pub fn input(&self, integrator: rw_model::IntegratorKind) -> SimInput {
        let mut sim = self.sim.clone();
        sim.conditions.integrator = integrator;
        SimInput {
            schema: rw_model::SchemaTag,
            sim,
            config: self.config.clone(),
            model: self.model.clone(),
            motors: vec![self.motor.clone()],
        }
    }
}
