//! The case-1 subset (M1.24a): every input number of the case-1 golden
//! geometry (`tests/oracle/case1.geometry.json`) is expressible in the
//! model and evaluates to the golden value. Derived outputs (mass, volume,
//! wetted area) belong to the mass and geometry crates.

use serde_json::Value;

use super::testutil::*;
use crate::types::{EvalComponent, EvalShape, EvaluatedModel};

const GOLDEN: &str = include_str!("../../../../tests/oracle/case1.geometry.json");

/// The `fixtures/case1/` project (plan M1.54b): the hand-authored rocket
/// plus the configurations and simulation that
/// `scripts/fixtures/case1-from-golden.ts` generates from the oracle files.
const FIXTURE: &[(&str, &str)] = &[
    (
        "rocketwright.toml",
        include_str!("../../../../fixtures/case1/rocketwright.toml"),
    ),
    (
        "rocket.rw.toml",
        include_str!("../../../../fixtures/case1/rocket.rw.toml"),
    ),
    (
        "configs/05896b5a-71a7-48ac-b7ae-eadeb267975b.rw.toml",
        include_str!(
            "../../../../fixtures/case1/configs/05896b5a-71a7-48ac-b7ae-eadeb267975b.rw.toml"
        ),
    ),
    (
        "configs/5d9a2765-395d-4d9c-9678-38eed0988c72.rw.toml",
        include_str!(
            "../../../../fixtures/case1/configs/5d9a2765-395d-4d9c-9678-38eed0988c72.rw.toml"
        ),
    ),
    (
        "configs/b13e8ca2-f54d-4ca8-9b23-06c6c9eb237a.rw.toml",
        include_str!(
            "../../../../fixtures/case1/configs/b13e8ca2-f54d-4ca8-9b23-06c6c9eb237a.rw.toml"
        ),
    ),
    (
        "configs/da326836-0959-4c94-bcd5-49dee07235a4.rw.toml",
        include_str!(
            "../../../../fixtures/case1/configs/da326836-0959-4c94-bcd5-49dee07235a4.rw.toml"
        ),
    ),
    (
        "configs/e1dc7488-77c0-403a-b54f-c01db07aba2f.rw.toml",
        include_str!(
            "../../../../fixtures/case1/configs/e1dc7488-77c0-403a-b54f-c01db07aba2f.rw.toml"
        ),
    ),
    (
        "sims/simulation_5.rw.toml",
        include_str!("../../../../fixtures/case1/sims/simulation_5.rw.toml"),
    ),
];

fn case1() -> EvaluatedModel {
    project(FIXTURE)
}

/// Golden input keys that are derived outputs or placement bookkeeping of
/// the other tool, not inputs of this model.
const DERIVED: &[&str] = &[
    "component_mass_kg",
    "volume_m3",
    "wet_area_m2",
    "planform_area_m2",
    "axial_offset_m",
    "radial_direction_rad",
    "radial_position_m",
    "radius_offset_m",
    "body_radius_m",
    "instance_separation_m",
    "cluster_rotation_rad",
    "cluster_scale",
    "cd_automatic",
    "fillet_density_kgm3",
    "filled",
    "clipped",
    "flipped",
];

/// Our value for a golden field key.
fn ours(m: &EvaluatedModel, c: &EvalComponent, key: &str) -> Option<f64> {
    let mat = c.material.as_ref().and_then(|n| m.materials.get(n));
    let s = &c.shape;
    let tube = |od: f64, id: f64| (od - id) / 2.0;
    Some(match (key, s) {
        ("density_kgm3", _) => mat?.density?,
        ("surface_density_kgm2", _) => mat?.surface_density?,
        ("line_density_kgm", _) => mat?.line_density?,
        ("roughness_m", _) => c.roughness?,
        ("instances", _) => c.instances.len() as f64,
        ("angle_offset_rad", _) => c.roll,
        ("od_m", EvalShape::NoseCone { od, .. })
        | ("od_m", EvalShape::BodyTube { od, .. })
        | ("od_m", EvalShape::InnerTube { od, .. })
        | ("od_m", EvalShape::CenteringRing { od, .. })
        | ("od_m", EvalShape::EngineBlock { od, .. })
        | ("od_m", EvalShape::LaunchLug { od, .. }) => *od,
        ("id_m", EvalShape::CenteringRing { id, .. })
        | ("id_m", EvalShape::EngineBlock { id, .. }) => *id,
        ("thickness_m", EvalShape::NoseCone { thickness, .. }) => *thickness,
        ("thickness_m", EvalShape::BodyTube { od, id, .. })
        | ("thickness_m", EvalShape::InnerTube { od, id, .. })
        | ("thickness_m", EvalShape::LaunchLug { od, id, .. })
        | ("thickness_m", EvalShape::EngineBlock { od, id, .. }) => tube(*od, *id),
        ("thickness_m", EvalShape::TrapezoidalFinSet { fins, .. }) => fins.thickness,
        ("shape_parameter", EvalShape::NoseCone { shape_param, .. }) => *shape_param,
        ("shoulder_length_m", EvalShape::NoseCone { shoulder, .. }) => shoulder.as_ref()?.length,
        ("shoulder_od_m", EvalShape::NoseCone { shoulder, .. }) => shoulder.as_ref()?.od,
        ("shoulder_thickness_m", EvalShape::NoseCone { shoulder, .. }) => {
            shoulder.as_ref()?.thickness
        }
        ("shoulder_capped", EvalShape::NoseCone { shoulder, .. }) => {
            f64::from(u8::from(shoulder.as_ref()?.capped))
        }
        ("motor_mount", EvalShape::BodyTube { .. }) => 0.0,
        ("motor_mount", EvalShape::InnerTube { motor_mount, .. }) => {
            f64::from(u8::from(*motor_mount))
        }
        ("motor_overhang_m", EvalShape::InnerTube { overhang, .. }) => *overhang,
        ("cd", EvalShape::Parachute { cd, .. }) => *cd,
        ("diameter_m", EvalShape::Parachute { diameter, .. }) => *diameter,
        ("line_count", EvalShape::Parachute { line_count, .. }) => f64::from(*line_count),
        ("line_length_m", EvalShape::Parachute { line_length, .. }) => *line_length,
        ("line_line_density_kgm", EvalShape::Parachute { line_material, .. }) => {
            m.materials.get(line_material.as_ref()?)?.line_density?
        }
        ("packed_length_m", EvalShape::Parachute { packed_length, .. })
        | ("packed_length_m", EvalShape::ShockCord { packed_length, .. }) => *packed_length,
        ("packed_length_m", EvalShape::MassComponent { length, .. }) => *length,
        (
            "packed_radius_m",
            EvalShape::Parachute {
                packed_diameter, ..
            },
        )
        | (
            "packed_radius_m",
            EvalShape::ShockCord {
                packed_diameter, ..
            },
        ) => packed_diameter / 2.0,
        ("packed_radius_m", EvalShape::MassComponent { od, .. }) => od / 2.0,
        ("cord_length_m", EvalShape::ShockCord { cord_length, .. }) => *cord_length,
        ("mass_kg", EvalShape::MassComponent { mass, .. }) => *mass,
        ("count", EvalShape::TrapezoidalFinSet { fins, .. }) => f64::from(fins.count),
        ("cant_rad", EvalShape::TrapezoidalFinSet { fins, .. }) => fins.cant,
        (k, EvalShape::TrapezoidalFinSet { fins, .. }) if k.starts_with("cross_section_") => {
            let want = serde_json::to_value(fins.cross_section).ok()?;
            f64::from(u8::from(
                Some(&k["cross_section_".len()..]) == want.as_str(),
            ))
        }
        ("fillet_radius_m", EvalShape::TrapezoidalFinSet { fins, .. }) => fins.fillet_radius,
        ("root_chord_m", EvalShape::TrapezoidalFinSet { root_chord, .. }) => *root_chord,
        ("tip_chord_m", EvalShape::TrapezoidalFinSet { tip_chord, .. }) => *tip_chord,
        ("height_m", EvalShape::TrapezoidalFinSet { span, .. }) => *span,
        ("sweep_m", EvalShape::TrapezoidalFinSet { sweep, .. }) => *sweep,
        ("tab_height_m", EvalShape::TrapezoidalFinSet { fins, .. }) => fins.tab.as_ref()?.height,
        ("tab_length_m", EvalShape::TrapezoidalFinSet { fins, .. }) => fins.tab.as_ref()?.length,
        ("tab_offset_m", EvalShape::TrapezoidalFinSet { fins, .. }) => fins.tab.as_ref()?.offset,
        ("deploy_altitude_m", EvalShape::Parachute { .. }) => {
            m.configs
                .values()
                .next()?
                .deployments
                .iter()
                .find(|d| d.component == c.id)?
                .altitude?
        }
        ("deploy_delay_s", EvalShape::Parachute { .. }) => {
            m.configs
                .values()
                .next()?
                .deployments
                .iter()
                .find(|d| d.component == c.id)?
                .delay
        }
        _ => return None,
    })
}

#[test]
fn case1_subset_expresses_the_golden_geometry() {
    let m = case1();
    assert_clean(&m);
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let close = |a: f64, b: f64| (a - b).abs() <= 1e-9 * (1.0 + b.abs());
    let mut unmapped = Vec::new();
    let mut checked = 0;
    for (i, g) in golden["components"].as_array().unwrap().iter().enumerate() {
        let name = g["name"].as_str().unwrap();
        // Two rings share a name; match by station.
        let x = g["x_fore_m"].as_f64().unwrap();
        let c = m
            .components
            .iter()
            .filter(|c| c.name == name)
            .min_by(|a, b| (a.x_fore - x).abs().total_cmp(&(b.x_fore - x).abs()))
            .unwrap_or_else(|| panic!("no component named {name:?}"));
        assert_eq!(
            c.component_type().name(),
            g["type"].as_str().unwrap(),
            "{name}"
        );
        assert!(
            close(c.x_fore, x),
            "{name} #{i}: x_fore {} vs {x}",
            c.x_fore
        );
        let len = g["length_m"].as_f64().unwrap();
        let ours_len = match &c.shape {
            EvalShape::TrapezoidalFinSet { root_chord, .. } => *root_chord,
            _ => c.x_aft - c.x_fore,
        };
        assert!(close(ours_len, len), "{name}: length {ours_len} vs {len}");
        if let Some(s) = g["shape"].as_str() {
            let EvalShape::NoseCone { shape, .. } = &c.shape else {
                panic!("{name}")
            };
            assert_eq!(serde_json::to_value(shape).unwrap(), s);
        }
        match g["parent"].as_str() {
            // The other tool parents the body chain to its stage.
            None => assert_eq!(c.containment, crate::types::AnchorKind::Axial, "{name}"),
            Some(p) => assert_eq!(
                c.parent.as_ref().map(|id| comp(&m, id).name.as_str()),
                Some(p),
                "{name}: parent"
            ),
        }
        for (k, v) in g["fields"].as_object().unwrap() {
            let Some(want) = v.as_f64() else { continue };
            match ours(&m, c, k) {
                Some(got) => {
                    assert!(close(got, want), "{name}.{k}: {got} vs {want}");
                    checked += 1;
                }
                None if DERIVED.contains(&k.as_str()) => {}
                None => unmapped.push(format!("{name}.{k}")),
            }
        }
    }
    assert!(
        unmapped.is_empty(),
        "golden inputs we cannot express: {unmapped:?}"
    );
    assert!(checked >= 76, "{checked}");

    // Configurations: one per golden delay, motor in the inner tube.
    let mut delays: Vec<f64> = golden["configurations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["motors"][0]["delay_s"].as_f64().unwrap())
        .collect();
    delays.sort_by(f64::total_cmp);
    delays.dedup();
    let mut ours_d: Vec<f64> = m
        .configs
        .values()
        .map(|c| {
            assert_eq!(comp(&m, &c.motors[0].mount).name, "Inner Tube");
            c.motors[0].delay.unwrap()
        })
        .collect();
    ours_d.sort_by(f64::total_cmp);
    ours_d.dedup();
    assert_eq!(ours_d, delays);
    // One configuration per golden configuration, keyed by its id verbatim.
    let mut ids: Vec<&str> = golden["configurations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    ids.sort_unstable();
    assert_eq!(
        m.configs.keys().map(String::as_str).collect::<Vec<_>>(),
        ids
    );
}

#[test]
fn case1_tree_and_reference() {
    let m = case1();
    let ids: Vec<&str> = m.components.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids[..2], ["nose", "body"]);
    assert_eq!(comp(&m, "block").parent.as_deref(), Some("mmt"));
    assert!((m.reference.diameter - 0.025).abs() < 1e-12);
    assert!((m.reference.length - 0.4).abs() < 1e-12);
    assert_eq!(m.stages.len(), 1);
}
