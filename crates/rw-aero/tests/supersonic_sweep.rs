//! Supersonic sweep: checks that `AeroModel::eval` returns finite outputs for
//! oracle cases 1–7 at Mach 0.1–4 and α 0–15°, and that case 1 is C¹ in CNα
//! and CP, and value-continuous in CD, across the transonic blend boundaries
//! (M 0.9, M 1.5).

use rw_aero::{AeroCoeffs, AeroModel, AeroOptions, AeroState};
use rw_model::EvaluatedModel;
use serde_json::{Map, Value, json};

const A0: f64 = 340.294;
const NU0: f64 = 1.4607e-5;

fn f(fields: &Map<String, Value>, k: &str) -> f64 {
    fields.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

/// The oracle flags the fin cross-section with one `cross_section_<kind>`
/// field. A fin set with neither flag is a schema change, so it panics here
/// instead of evaluating a guessed profile.
fn cross_section(fields: &Map<String, Value>) -> &'static str {
    if f(fields, "cross_section_square") > 0.5 {
        "square"
    } else if f(fields, "cross_section_rounded") > 0.5 {
        "rounded"
    } else {
        panic!("fin set without a known cross_section_* field")
    }
}

/// Every component is translated with a single instance at zero offset. The
/// oracle's `instances` field is a bare count (the fin count for fin sets, 2
/// with `instance_separation_m` for rail buttons); it carries no offsets or
/// roll angles, so there is no faithful mapping to model instances from it.
/// Fin sets take their fin count from `count`.
fn translate(id: &str, parent: Option<&str>, c: &Value) -> Option<Value> {
    let fl = c["fields"].as_object().unwrap();
    let len = c["length_m"].as_f64().unwrap();
    let (containment, shape) = match c["type"].as_str().unwrap() {
        "nose_cone" => (
            "axial",
            json!({
                "type": "nose_cone",
                "shape": c["shape"],
                "shape_param": f(fl, "shape_parameter"),
                "length": len,
                "od": f(fl, "od_m"),
                "thickness": f(fl, "thickness_m"),
                "shoulder": {
                    "length": f(fl, "shoulder_length_m"),
                    "od": f(fl, "shoulder_od_m"),
                    "thickness": f(fl, "shoulder_thickness_m"),
                    "capped": f(fl, "shoulder_capped") > 0.5
                }
            }),
        ),
        "body_tube" => (
            "axial",
            json!({
                "type": "body_tube",
                "length": len,
                "od": f(fl, "od_m"),
                "id": f(fl, "od_m") - 2.0 * f(fl, "thickness_m")
            }),
        ),
        "launch_lug" => (
            "surface",
            json!({
                "type": "launch_lug",
                "length": len,
                "od": f(fl, "od_m"),
                "id": f(fl, "od_m") - 2.0 * f(fl, "thickness_m")
            }),
        ),
        "trapezoidal_fin_set" => (
            "surface",
            json!({
                "type": "trapezoidal_fin_set",
                "count": f(fl, "count") as u32,
                "thickness": f(fl, "thickness_m"),
                "cross_section": cross_section(fl),
                "cant": f(fl, "cant_rad"),
                "fillet_radius": f(fl, "fillet_radius_m"),
                "root_chord": f(fl, "root_chord_m"),
                "tip_chord": f(fl, "tip_chord_m"),
                "span": f(fl, "height_m"),
                "sweep": f(fl, "sweep_m")
            }),
        ),
        "elliptical_fin_set" => (
            "surface",
            json!({
                "type": "elliptical_fin_set",
                "count": f(fl, "count") as u32,
                "thickness": f(fl, "thickness_m"),
                "cross_section": cross_section(fl),
                "cant": f(fl, "cant_rad"),
                "fillet_radius": f(fl, "fillet_radius_m"),
                "root_chord": f(fl, "root_chord_m"),
                "span": f(fl, "height_m")
            }),
        ),
        "tube_fin_set" => (
            "surface",
            json!({
                "type": "tube_fin_set",
                "count": f(fl, "count") as u32,
                "length": len,
                "od": f(fl, "od_m"),
                "id": f(fl, "id_m")
            }),
        ),
        "freeform_fin_set" => {
            let mut npts = 0usize;
            loop {
                let key = format!("point{npts}_x_m");
                if !fl.contains_key(key.as_str()) {
                    break;
                }
                npts += 1;
            }
            let points: Vec<[f64; 2]> = (0..npts)
                .map(|i| {
                    let kx = format!("point{i}_x_m");
                    let ky = format!("point{i}_y_m");
                    [f(fl, kx.as_str()), f(fl, ky.as_str())]
                })
                .collect();
            (
                "surface",
                json!({
                    "type": "freeform_fin_set",
                    "count": f(fl, "count") as u32,
                    "thickness": f(fl, "thickness_m"),
                    "cross_section": cross_section(fl),
                    "cant": f(fl, "cant_rad"),
                    "fillet_radius": f(fl, "fillet_radius_m"),
                    "points": points
                }),
            )
        }
        "inner_tube" => (
            "inner",
            json!({
                "type": "inner_tube",
                "length": len,
                "od": f(fl, "od_m"),
                "id": f(fl, "od_m") - 2.0 * f(fl, "thickness_m"),
                "motor_mount": f(fl, "motor_mount") > 0.5,
                "overhang": f(fl, "motor_overhang_m")
            }),
        ),
        "rail_button" => (
            "surface",
            json!({
                "type": "rail_button",
                "od": f(fl, "od_m"),
                "id": f(fl, "id_m"),
                "height": f(fl, "total_height_m"),
                "base_height": f(fl, "base_height_m"),
                "flange_height": f(fl, "flange_height_m")
            }),
        ),
        _ => return None,
    };
    let x0 = c["x_fore_m"].as_f64().unwrap();
    Some(json!({
        "id": id,
        "name": c["name"],
        "parent": parent,
        "children": [],
        "containment": containment,
        "aero": containment != "inner",
        "cut": false,
        "x_fore": x0,
        "x_aft": x0 + len,
        "radial": 0.0,
        "roll": 0.0,
        "instances": [{ "index": 0, "offset": [0.0, 0.0, 0.0], "roll": 0.0 }],
        "anchors": [],
        "roughness": f(fl, "roughness_m"),
        "shape": shape
    }))
}

fn geometry_str(n: usize) -> &'static str {
    match n {
        1 => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/oracle/case1.geometry.json"
        )),
        2 => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/oracle/case2.geometry.json"
        )),
        3 => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/oracle/case3.geometry.json"
        )),
        4 => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/oracle/case4.geometry.json"
        )),
        5 => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/oracle/case5.geometry.json"
        )),
        6 => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/oracle/case6.geometry.json"
        )),
        7 => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/oracle/case7.geometry.json"
        )),
        _ => panic!("unknown case {n}"),
    }
}

fn load_case(n: usize) -> EvaluatedModel {
    let g: Value = serde_json::from_str(geometry_str(n)).expect("geometry json");
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/contracts/evaluated-model.json"
    )))
    .expect("fixture json");
    let mut m: EvaluatedModel =
        serde_json::from_value(fixture["payload"].clone()).expect("fixture model");
    // Oracle names repeat (case 5 has four "Body tube" segments) and the model
    // resolves components by id, so the id is "<name>#<index>". An oracle
    // `parent` is a name: it means the nearest preceding component with that
    // name.
    let oracle = g["components"].as_array().unwrap();
    let ids: Vec<String> = oracle
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{}#{i}", c["name"].as_str().unwrap()))
        .collect();
    let translated: Vec<Value> = oracle
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let parent = c["parent"].as_str().map(|name| {
                let j = oracle[..i]
                    .iter()
                    .rposition(|p| p["name"] == name)
                    .unwrap_or_else(|| panic!("case{n}: no preceding parent {name:?}"));
                ids[j].as_str()
            });
            translate(&ids[i], parent, c)
        })
        .collect();
    let mut seen = std::collections::HashSet::new();
    for v in &translated {
        let id = v["id"].as_str().unwrap();
        assert!(seen.insert(id), "case{n}: duplicate component id {id:?}");
    }
    for v in &translated {
        if let Some(parent) = v["parent"].as_str() {
            assert!(
                seen.contains(parent),
                "case{n}: {} has untranslated parent {parent:?}",
                v["id"]
            );
        }
    }
    m.components = translated
        .into_iter()
        .map(|v| serde_json::from_value(v).expect("component"))
        .collect();
    // Reference diameter is the first body_tube OD.
    let d = g["components"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["type"] == "body_tube")
        .and_then(|c| c["fields"]["od_m"].as_f64())
        .unwrap_or(0.025);
    m.reference.diameter = d;
    m.reference.area = std::f64::consts::PI * d * d / 4.0;
    m
}

fn assert_finite(c: &AeroCoeffs, case: usize, mach: f64, alpha_deg: f64) {
    macro_rules! fin {
        ($name:expr, $val:expr) => {
            assert!(
                ($val as f64).is_finite(),
                "case{case} M={mach:.3} α={alpha_deg:.0}° {} = {}",
                $name,
                $val
            );
        };
    }
    fin!("cn_alpha", c.cn_alpha);
    fin!("cn", c.cn);
    fin!("cp", c.cp);
    fin!("cd", c.cd);
    fin!("drag.friction", c.drag.friction);
    fin!("drag.pressure", c.drag.pressure);
    fin!("drag.base", c.drag.base);
    fin!("drag.parasitic", c.drag.parasitic);
    fin!("drag.total", c.drag.total);
    fin!("cm_damping", c.cm_damping);
    fin!("cl_forcing", c.cl_forcing);
    fin!("cl_damping", c.cl_damping);
    for comp in &c.components {
        fin!(format!("{} cn_alpha", comp.id), comp.cn_alpha);
        fin!(format!("{} cp", comp.id), comp.cp);
    }
}

/// Every scalar output of `AeroModel::eval` is finite for all 7 oracle cases
/// across a Mach 0.1–4 × α 0–15° grid. This catches NaN from the transonic
/// blend and division by β near M = 1.
#[test]
fn all_outputs_finite_m0_to_4() {
    let machs = [
        0.1_f64, 0.3, 0.6, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0,
    ];
    let alphas_deg = [0.0_f64, 5.0, 10.0, 15.0];

    for case in 1..=7 {
        let model = load_case(case);
        let am = AeroModel::new(&model, &rw_geom::build(&model), &AeroOptions::default());
        for &mach in &machs {
            for &ad in &alphas_deg {
                let c = am.eval(&AeroState {
                    mach,
                    speed: mach * A0,
                    alpha: ad.to_radians(),
                    roll_rate: 0.0,
                    pitch_rate: 0.0,
                    kinematic_viscosity: NU0,
                    thrusting: false,
                });
                assert_finite(&c, case, mach, ad);
            }
        }
    }
}

/// Value jump and slope jump across the two transonic blend boundaries
/// (M 0.9, M 1.5) are within tolerance for case 1 (trapezoidal fins).
///
/// `transonic_blend` C¹-blends the fin CNα (and K_B(T)) between the two
/// limits, so CNα is checked for value and slope. CP is checked the same way,
/// though it is not blended there: the fin CP fraction is `cp_fraction`'s
/// quintic over M 0.5 to 2 (fins.rs), smooth through both boundaries, and the
/// total CP weights it by the blended CNα terms.
/// CD is checked for value continuity only: the drag rise puts a slope kink at
/// M 0.9 that nothing blends.
#[test]
fn blend_boundaries_are_c1() {
    let model = load_case(1);
    let am = AeroModel::new(&model, &rw_geom::build(&model), &AeroOptions::default());
    let d_ref = model.reference.diameter;

    // Returns [cn_alpha, cd, cp in calibers].
    let eval_scalars = |mach: f64| -> [f64; 3] {
        let c = am.eval(&AeroState {
            mach,
            speed: mach * A0,
            alpha: 0.0,
            roll_rate: 0.0,
            pitch_rate: 0.0,
            kinematic_viscosity: NU0,
            thrusting: false,
        });
        [c.cn_alpha, c.cd, c.cp / d_ref]
    };

    // Both ratios are relative to the value at the boundary, so no absolute
    // floor hides a jump in a small quantity:
    //   value: |y(M+h) − y(M−h)| / |y(M)|
    //   slope: |y'(M+) − y'(M−)| / |y(M)|, one-sided differences, per unit Mach
    // A smooth curve gives a value ratio near 2h·|y'/y| and a slope ratio near
    // h·|y''/y|; a step of size s gives a slope ratio near s/(h·|y|).
    // Measured at h = 1e-3 (case 1):
    //   M 0.9  cn_alpha  value 4.3e-4  slope 4.9e-4
    //   M 0.9  cd        value 3.0e-3 (slope 2.3, the unblended drag-rise kink)
    //   M 0.9  cp        value 1.1e-4  slope 6.9e-5
    //   M 1.5  cn_alpha  value 2.0e-3  slope 5.8e-4
    //   M 1.5  cd        value 5.4e-4
    //   M 1.5  cp        value 3.0e-4  slope 2.7e-4
    // Tolerances are about 10× the larger measured ratio per quantity, in
    // the order [cn_alpha, cd, cp]. The CD slope is not checked.
    const VALUE_TOL: [f64; 3] = [0.02, 0.03, 0.003];
    const SLOPE_TOL: [f64; 3] = [0.006, f64::INFINITY, 0.003];

    let h = 1e-3_f64;
    // These match SUBSONIC_LIMIT and SUPERSONIC_LIMIT in mach.rs.
    for m_bound in [0.9_f64, 1.5] {
        let yl = eval_scalars(m_bound - h);
        let yc = eval_scalars(m_bound);
        let yr = eval_scalars(m_bound + h);

        for (i, name) in ["cn_alpha", "cd", "cp"].iter().enumerate() {
            let (lo, ctr, hi) = (yl[i], yc[i], yr[i]);
            assert!(ctr.abs() > 1e-6, "M={m_bound:.2} {name}: no scale ({ctr})");

            let value_ratio = (hi - lo).abs() / ctr.abs();
            let slope_ratio = ((hi - ctr) / h - (ctr - lo) / h).abs() / ctr.abs();
            assert!(
                value_ratio < VALUE_TOL[i],
                "M={m_bound:.2} {name}: value jump ratio {value_ratio:.3e}"
            );
            assert!(
                slope_ratio < SLOPE_TOL[i],
                "M={m_bound:.2} {name}: slope jump ratio {slope_ratio:.3e}"
            );
        }
    }
}
