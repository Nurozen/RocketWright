//! `.ork` export → import round trip on a RocketWright-authored snippet:
//! evaluated component ids and dimensions survive within 1e-9 m.

use std::collections::BTreeMap;

use rw_model::{EvalOptions, EvaluatedModel};
use rw_ork::export::write_ork;
use rw_ork::{ImportOptions, OrkFiles, import};
use serde_json::Value;

const SNIPPETS: [&str; 2] = [
    include_str!("data/simple.ork.xml"),
    include_str!("data/two_stage.ork.xml"),
];

fn eval(xml: &[u8]) -> (EvaluatedModel, rw_ork::OrkImport) {
    let imp = import(
        &OrkFiles {
            xml: xml.to_vec(),
            files: BTreeMap::new(),
        },
        &ImportOptions::default(),
    )
    .expect("imports");
    let m = rw_model::eval(&imp.source_set(None), &EvalOptions::default());
    (m, imp)
}

fn close(a: &Value, b: &Value, path: &str) {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            assert!((x - y).abs() <= 1e-9, "{path}: {x} vs {y}");
        }
        (Value::Object(x), Value::Object(y)) => {
            for (k, v) in x {
                close(v, y.get(k).unwrap_or(&Value::Null), &format!("{path}/{k}"));
            }
        }
        (Value::Array(x), Value::Array(y)) => {
            assert_eq!(x.len(), y.len(), "{path}");
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                close(p, q, &format!("{path}/{i}"));
            }
        }
        _ => assert_eq!(a, b, "{path}"),
    }
}

#[test]
fn export_then_import_keeps_ids_and_dimensions() {
    for s in SNIPPETS {
        round_trip(s);
    }
}

fn round_trip(snippet: &str) {
    let (a, imp) = eval(snippet.as_bytes());
    let source = imp.rocket.c.clone();
    let out = write_ork(&a, &source, &|_| None, "RocketWright test");
    let (b, _) = eval(out.xml.as_bytes());
    let ids = |m: &EvaluatedModel| {
        m.components
            .iter()
            .map(|c| c.id.clone())
            .collect::<Vec<_>>()
    };
    let (mut ia, mut ib) = (ids(&a), ids(&b));
    ia.sort();
    ib.sort();
    assert_eq!(ia, ib);
    for ca in &a.components {
        let cb = b.components.iter().find(|c| c.id == ca.id).unwrap();
        assert_eq!(ca.component_type(), cb.component_type(), "{}", ca.id);
        assert!((ca.x_fore - cb.x_fore).abs() <= 1e-9, "{} x_fore", ca.id);
        close(
            &serde_json::to_value(&ca.shape).unwrap(),
            &serde_json::to_value(&cb.shape).unwrap(),
            &ca.id,
        );
    }
    // UUIDs carry over.
    let (_, again) = eval(out.xml.as_bytes());
    for (id, uuid) in &imp.uuids {
        assert_eq!(again.uuids.get(id), Some(uuid), "{id}");
    }
}

/// A stage mass/CG override that covers its subcomponents (oracle case 5)
/// imports as `[stage.<id>] override` and survives the round trip; one that
/// leaves them out is dropped with a diagnostic.
#[test]
fn stage_override_round_trips() {
    let with = |extra: &str| {
        include_str!("data/two_stage.ork.xml").replacen(
            "<name>Sustainer</name>",
            &format!("<name>Sustainer</name>{extra}"),
            1,
        )
    };
    let xml = with(
        "<overridemass>0.5</overridemass><overridecg>0.1</overridecg>\
         <overridesubcomponents>true</overridesubcomponents>",
    );
    let (a, imp) = eval(xml.as_bytes());
    assert!(imp.rocket.stage["sustainer"].overrides.is_some());
    let oa = a.stages[0].overrides.clone().expect("stage override");
    assert!((oa.mass.unwrap() - 0.5).abs() < 1e-12);
    assert!((oa.cg.unwrap() - (a.stages[0].x_fore + 0.1)).abs() < 1e-12);
    let out = write_ork(&a, &imp.rocket.c, &|_| None, "RocketWright test");
    let (b, _) = eval(out.xml.as_bytes());
    assert_eq!(b.stages[0].overrides, Some(oa));

    let xml = with("<overridemass>0.5</overridemass>");
    let (a, imp) = eval(xml.as_bytes());
    assert!(a.stages[0].overrides.is_none());
    assert!(
        imp.diagnostics
            .iter()
            .any(|d| d.message.contains("leaves out the subcomponents"))
    );
}

/// A rail button's base and flange heights import (an explicit 0 stays 0,
/// an absent one takes the `height / 4` default) and survive the round trip.
#[test]
fn rail_button_heights_round_trip() {
    let lug = "<launchlug>
                <name>Launch lug</name>
                <id>00000000-0000-4000-8000-00000000000a</id>
                <axialoffset method=\"middle\">0.0</axialoffset>
                <radialdirection>30.0</radialdirection>
                <radius>0.0025</radius>
                <thickness>0.0005</thickness>
                <length>0.03</length>
              </launchlug>";
    let button = |heights: &str| {
        format!(
            "<railbutton><name>Rail Button</name>\
             <id>00000000-0000-4000-8000-00000000000a</id>\
             <axialoffset method=\"middle\">0.0</axialoffset>\
             <outerdiameter>0.0097</outerdiameter><innerdiameter>0.008</innerdiameter>\
             <height>0.0097</height>{heights}</railbutton>"
        )
    };
    let base = include_str!("data/simple.ork.xml");
    assert!(base.contains(lug));
    let shape = |xml: &str| {
        let (m, _) = eval(xml.as_bytes());
        m.components
            .iter()
            .find_map(|c| match c.shape {
                rw_model::EvalShape::RailButton {
                    base_height,
                    flange_height,
                    ..
                } => Some((base_height, flange_height)),
                _ => None,
            })
            .expect("rail button")
    };
    let xml = base.replacen(
        lug,
        &button("<baseheight>0.002</baseheight><flangeheight>0.0</flangeheight>"),
        1,
    );
    assert_eq!(shape(&xml), (0.002, 0.0));
    round_trip(&xml);
    let xml = base.replacen(lug, &button(""), 1);
    let (b, f) = shape(&xml);
    assert!((b - 0.0097 / 4.0).abs() < 1e-15 && (f - 0.0097 / 4.0).abs() < 1e-15);
    round_trip(&xml);
}
