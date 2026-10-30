//! Tank propellant (final review, REV-phys): a filled tank's loaded
//! propellant is part of the vehicle mass and CG, except when an active
//! liquid engine feeds from it (its thrust curve then carries that mass).

mod common;

use common::{assert_close, build, comp, model};
use rw_mass::MassModel;
use rw_motor::{MotorSource, MountedMotor, ThrustCurve, ThrustPoint};
use serde_json::json;

fn vehicle(propellant_mass: f64) -> rw_model::EvaluatedModel {
    let mut tank = comp(
        "t",
        Some("body"),
        0.2,
        0.6,
        json!({
            "type": "tank", "length": 0.4, "od": 0.15, "wall": 0.002,
            "end_cap": "flat", "volume": 0.0, "propellant": "n2o",
            "propellant_mass": propellant_mass
        }),
    );
    tank["containment"] = json!("inner");
    model(
        vec![
            comp(
                "body",
                None,
                0.0,
                1.0,
                json!({"type": "body_tube", "length": 1.0, "od": 0.16, "id": 0.156}),
            ),
            tank,
        ],
        1200.0,
    )
}

fn liquid_motor(engine: &str) -> MountedMotor {
    let point = |t: f64| ThrustPoint {
        t,
        thrust: 1000.0,
        mass: None,
        cg: None,
    };
    MountedMotor {
        mount: "body".into(),
        curve: ThrustCurve {
            designation: "demo".into(),
            manufacturer: None,
            class: "J".into(),
            diameter: 0.1,
            length: 0.3,
            delays: vec![],
            prop_mass: 3.0,
            total_mass: 4.0,
            total_impulse: 3000.0,
            burn_time: 3.0,
            average_thrust: 1000.0,
            max_thrust: 1000.0,
            points: vec![point(0.0), point(3.0)],
            sha256: "0".repeat(64),
            source: MotorSource::Liquid {
                engine: engine.into(),
            },
        },
        x_fore: 0.7,
        ignition_time: 0.0,
        delay: None,
        count: 1,
    }
}

#[test]
fn filled_tank_adds_its_propellant_at_the_cavity_centroid() {
    let (_, empty) = build(&vehicle(0.0));
    let (_, full) = build(&vehicle(5.0));
    let (e, f) = (empty.dry(), full.dry());
    assert_close("m", f.mass, e.mass + 5.0, 1e-12);
    // Flat caps: the cavity centroid is the tank middle, x = 0.4.
    let cg = (e.mass * e.cg + 5.0 * 0.4) / (e.mass + 5.0);
    assert_close("cg", f.cg, cg, 1e-9);
    let row = full.breakdown().into_iter().find(|r| r.id == "t").unwrap();
    let row0 = empty.breakdown().into_iter().find(|r| r.id == "t").unwrap();
    assert_close("tank row", row.mass, row0.mass + 5.0, 1e-12);
}

#[test]
fn a_liquid_engine_fed_tank_is_not_counted_twice() {
    let mut m = vehicle(5.0);
    m.engines.insert(
        "demo".into(),
        serde_json::from_value(json!({
            "id": "demo", "name": "demo", "oxidizer": "n2o", "fuel": "ethanol",
            "mixture_ratio": 4.0, "chamber_pressure": 2.0e6, "thrust": 1000.0,
            "nodes": { "ox": { "kind": "tank", "component": "t" } },
            "edges": []
        }))
        .unwrap(),
    );
    let g = rw_geom::build(&m);
    let (_, empty) = build(&vehicle(0.0));
    // Mounted: the curve carries the propellant, the tank only its shell.
    let fed = MassModel::new(&m, &g, &[liquid_motor("demo")]);
    assert_close("fed dry", fed.dry().mass, empty.dry().mass, 1e-12);
    // A different (or no) liquid engine leaves the tank's load in place.
    let other = MassModel::new(&m, &g, &[liquid_motor("other")]);
    assert_close("other dry", other.dry().mass, empty.dry().mass + 5.0, 1e-12);
}
