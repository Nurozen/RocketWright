//! SVG goldens of every 2D view on the `simple` fixture, plus a PNG
//! tolerance compare through the M1.12 resvg path (Acc 3, I8). Regenerate
//! with `RW_UPDATE_GOLDEN=1 cargo test -p rw-draw --test golden`.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use rw_aero::{AeroModel, AeroOptions};
use rw_check::{CheckInput, check_static, mounted_from_config};
use rw_cli::render2d::{Tolerance, compare_png, rasterize, svg_to_png};
use rw_draw::{DrawOptions, Markers, View, draw};
use rw_mass::MassModel;
use rw_model::EvaluatedModel;
use rw_motor::generic::generic_motor;

const SIMPLE: &str = include_str!("../../rw-check/tests/fixtures/simple.eval.json");

fn golden(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(name)
}

fn update() -> bool {
    std::env::var_os("RW_UPDATE_GOLDEN").is_some()
}

fn drawings() -> Vec<(View, String)> {
    let model: EvaluatedModel = serde_json::from_str(SIMPLE).unwrap();
    let geometry = rw_geom::build(&model);
    let motors = mounted_from_config(&model, &|r: &str| {
        r.strip_prefix("generic:").and_then(generic_motor)
    });
    let mass = MassModel::new(&model, &geometry, &motors);
    let aero = AeroModel::new(&model, &geometry, &AeroOptions::default());
    let inputs = BTreeMap::new();
    let report = check_static(&CheckInput {
        model: &model,
        geometry: &geometry,
        mass: &mass,
        aero: &aero,
        motors: &motors,
        inputs: &inputs,
    });
    let markers = Markers::from_report(&report);
    View::ALL
        .into_iter()
        .map(|v| {
            (
                v,
                draw(v, &model, &geometry, &markers, &DrawOptions::default()),
            )
        })
        .collect()
}

#[test]
fn svg_goldens() {
    let a = drawings();
    let b = drawings();
    assert_eq!(a, b, "two runs differ (I8)");
    for (view, svg) in &a {
        let path = golden(&format!("simple.{}.svg", view.name()));
        if update() {
            std::fs::write(&path, svg).unwrap();
        }
        let want =
            std::fs::read_to_string(&path).expect("golden missing; run with RW_UPDATE_GOLDEN=1");
        assert_eq!(
            svg,
            &want,
            "{} drifted from {}",
            view.name(),
            path.display()
        );
    }
}

#[test]
fn png_tolerance_compare() {
    for (view, svg) in drawings() {
        let png = svg_to_png(&svg, 1.0).unwrap();
        let path = golden(&format!("simple.{}.png", view.name()));
        if update() {
            std::fs::write(&path, &png).unwrap();
        }
        let want = std::fs::read(&path).expect("golden missing; run with RW_UPDATE_GOLDEN=1");
        let r = compare_png(&png, &want, Tolerance::default()).unwrap();
        assert!(r.pass, "{} PNG differs from golden: {r:?}", view.name());
    }
}

#[test]
fn profile_has_markers_and_dimensions() {
    let all = drawings();
    let profile = &all.iter().find(|(v, _)| *v == View::Profile).unwrap().1;
    // CG: filled circle; CP: open circle with a cross.
    assert!(
        profile.contains("fill=\"#1f2933\" stroke=\"#ffffff\""),
        "CG marker"
    );
    assert!(
        profile.contains("fill=\"#ffffff\" stroke=\"#c0392b\""),
        "CP marker"
    );
    assert!(profile.contains(">CG ") && profile.contains(">CP "));
    assert!(profile.contains(">550.0 mm<"), "overall length");
    assert!(profile.contains(">Ø41.6 mm<"), "max diameter");
    assert!(profile.contains(">141.6 mm span<"), "fin span");
    assert!(
        profile.contains("stroke-dasharray=\"4 3\""),
        "internals dashed"
    );
    let fin = &all.iter().find(|(v, _)| *v == View::Fin).unwrap().1;
    for label in [
        "root 70.0 mm",
        "tip 30.0 mm",
        "span 50.0 mm",
        "sweep 35.0 mm",
    ] {
        assert!(fin.contains(label), "{label}");
    }
    let stations = &all.iter().find(|(v, _)| *v == View::Stations).unwrap().1;
    assert!(stations.contains(">485.0 mm<"), "ring station");
    let anchors = &all.iter().find(|(v, _)| *v == View::Anchors).unwrap().1;
    assert!(anchors.contains("nose.base"), "anchor label");
    // Every view parses and rasterizes with the vendored font only.
    for (v, svg) in &all {
        let r = rasterize(svg, 1.0).unwrap();
        assert!(
            r.width == 1200 && r.height > 100,
            "{}: {}x{}",
            v.name(),
            r.width,
            r.height
        );
    }
}

#[test]
fn no_fins_draws_a_placeholder() {
    let mut v: serde_json::Value = serde_json::from_str(SIMPLE).unwrap();
    v["components"]
        .as_array_mut()
        .unwrap()
        .retain(|c| c["id"] != "fins");
    let model: EvaluatedModel = serde_json::from_value(v).unwrap();
    let g = rw_geom::build(&model);
    let svg = draw(
        View::Fin,
        &model,
        &g,
        &Markers::default(),
        &DrawOptions::default(),
    );
    assert!(svg.contains("no fin sets"));
    let p = draw(
        View::Profile,
        &model,
        &g,
        &Markers::default(),
        &DrawOptions::default(),
    );
    assert!(!p.contains(">CG ") && rasterize(&p, 1.0).is_ok());
}

/// M2.7: the compare profile colours parts by mark, ghosts changed parts,
/// draws removed parts from the old model, and carries the legend.
#[test]
fn compare_profile_marks_parts() {
    use rw_draw::{Mark, Side, draw_compare, mark_ink};
    let old: EvaluatedModel = serde_json::from_str(SIMPLE).unwrap();
    let mut v: serde_json::Value = serde_json::from_str(SIMPLE).unwrap();
    let comps = v["components"].as_array_mut().unwrap();
    let ids: Vec<String> = comps
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_string())
        .collect();
    // Drop the last component (removed) and rename the first (added).
    let removed = ids.last().unwrap().clone();
    comps.pop();
    let added = format!("{}_new", ids[0]);
    comps[0]["id"] = serde_json::json!(added.clone());
    let new: EvaluatedModel = serde_json::from_value(v).unwrap();
    let (go, gn) = (rw_geom::build(&old), rw_geom::build(&new));
    let changed = ids[1].clone();
    let marks: BTreeMap<String, Mark> = [
        (removed.clone(), Mark::Removed),
        (ids[0].clone(), Mark::Removed),
        (added.clone(), Mark::Added),
        (changed.clone(), Mark::Changed),
    ]
    .into_iter()
    .collect();
    let side = |m, g, label| Side {
        model: m,
        geometry: g,
        label,
    };
    let svg = draw_compare(
        side(&old, &go, "Step 01"),
        side(&new, &gn, "live"),
        &marks,
        &DrawOptions::default(),
    );
    assert!(svg.contains("Step 01 → live"), "title");
    for c in [
        mark_ink::REMOVED,
        mark_ink::CHANGED,
        mark_ink::ADDED,
        mark_ink::DIM,
    ] {
        assert!(svg.contains(&format!("stroke=\"{c}\"")), "{c}");
    }
    assert!(svg.contains("stroke-dasharray=\"5 3\""), "changed ghost");
    assert!(svg.contains(&format!("<!-- {removed} Removed -->")));
    assert!(
        svg.contains(">Removed 2<") && svg.contains(">Changed 1<") && svg.contains(">Added 1<")
    );
    assert!(svg.contains(">Unchanged<"));
    // Deterministic, and rasterizes with the vendored font.
    let again = draw_compare(
        side(&old, &go, "Step 01"),
        side(&new, &gn, "live"),
        &marks,
        &DrawOptions::default(),
    );
    assert_eq!(svg, again);
    let r = rasterize(&svg, 1.0).unwrap();
    assert_eq!(r.width, 1200);
}
