//! The committed example projects (plan M1.54b, M1.54c): `fixtures/case1`,
//! `fixtures/simple`, `fixtures/research-vehicle`, and the `rw init`
//! templates. Every source file parses without warnings and every project
//! evaluates without diagnostics (the parse and model tier of
//! `rw check --strict`). The research vehicle carries the parts, appearance,
//! joints, configurations, and simulations of the concept (concepts.md §4.1).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};

use rw_model::source::doc_kind;
use rw_model::{
    AppearancePreset, AttitudeSource, EvalOptions, EvalShape, EvaluatedModel, JointType, SimKind,
    SourceSet, eval, parse_source_with_warnings,
};

const PROJECTS: &[&str] = &[
    "fixtures/case1",
    "fixtures/simple",
    "fixtures/research-vehicle",
    "templates/simple-rocket",
    "templates/minimum",
];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

/// Every source file of a project, keyed by project-relative path.
fn sources(rel: &str) -> SourceSet {
    let dir = repo_root().join(rel);
    let mut files = Vec::new();
    walk(&dir, &mut files);
    let mut s = SourceSet::default();
    for p in files {
        let path = p
            .strip_prefix(&dir)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if doc_kind(&path).is_none() {
            continue;
        }
        let text = std::fs::read_to_string(&p).unwrap();
        let (doc, warnings) = parse_source_with_warnings(&path, &text)
            .unwrap_or_else(|e| panic!("{rel}/{path}: {e:#?}"));
        assert!(warnings.is_empty(), "{rel}/{path}: {warnings:#?}");
        s.docs.insert(path, doc);
    }
    assert!(
        s.docs.contains_key("rocketwright.toml"),
        "{rel}: no manifest"
    );
    s
}

fn project(rel: &str) -> EvaluatedModel {
    eval(&sources(rel), &EvalOptions::default())
}

/// Diagnostics other than the research vehicle's documented missing inputs
/// of `engines/demo-incomplete.rw.toml` (plan D10b, fixtures/README.md).
fn unexpected(d: Vec<rw_model::Diagnostic>) -> Vec<rw_model::Diagnostic> {
    d.into_iter()
        .filter(|d| {
            !(d.file.as_deref() == Some("engines/demo-incomplete.rw.toml")
                && matches!(d.code.as_str(), "RW-W210" | "RW-W211"))
        })
        .collect()
}

#[test]
fn every_project_evaluates_clean_in_every_config_and_variant() {
    for rel in PROJECTS {
        let s = sources(rel);
        let m = eval(&s, &EvalOptions::default());
        let d = unexpected(m.diagnostics.clone());
        assert!(d.is_empty(), "{rel}: {d:#?}");
        assert!(m.config.is_some(), "{rel}: no default configuration");
        assert!(!m.configs.is_empty() && !m.sims.is_empty(), "{rel}");
        for cfg in m.configs.keys() {
            let opts = EvalOptions {
                config: Some(cfg.clone()),
                ..EvalOptions::default()
            };
            let d = unexpected(eval(&s, &opts).diagnostics);
            assert!(d.is_empty(), "{rel} config {cfg}: {d:#?}");
        }
        let variants: Vec<String> = s
            .docs
            .values()
            .filter_map(|d| match d {
                rw_model::SourceDoc::Rocket(r) => Some(r.variants.keys().cloned()),
                _ => None,
            })
            .flatten()
            .collect();
        for v in variants {
            let opts = EvalOptions {
                variant: Some(v.clone()),
                ..EvalOptions::default()
            };
            let d = unexpected(eval(&s, &opts).diagnostics);
            assert!(d.is_empty(), "{rel} variant {v}: {d:#?}");
        }
        // Every sim names a configuration, and every motor is a generic one.
        for sim in m.sims.values() {
            assert!(m.configs.contains_key(&sim.config), "{rel}: {}", sim.id);
        }
        for c in m.configs.values() {
            assert!(!c.motors.is_empty(), "{rel} {}: no motor", c.id);
            for mm in &c.motors {
                let motor = mm.motor.as_deref().unwrap_or_default();
                assert!(motor.starts_with("generic:RW_"), "{rel} {}: {motor}", c.id);
            }
        }
    }
}

fn comp<'a>(m: &'a EvaluatedModel, id: &str) -> &'a rw_model::EvalComponent {
    m.components
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("no component `{id}`"))
}

#[test]
fn research_vehicle_matches_the_concept() {
    let m = project("fixtures/research-vehicle");
    assert_eq!(m.name, "Research vehicle");

    // Parts per concepts.md §4.1, nose to tail.
    let names: Vec<&str> = m.components.iter().map(|c| c.name.as_str()).collect();
    for want in [
        "Nosecone",
        "Recovery bay",
        "Parachute (stowed)",
        "Airframe tube",
        "Bulkhead",
        "Electronics bay",
        "Fin can",
        "Fins",
        "Centering ring (upper)",
        "Centering ring (lower)",
        "Motor casing",
        "Launch lug",
    ] {
        assert!(names.contains(&want), "missing {want:?} in {names:?}");
    }
    let chain: Vec<&str> = m
        .components
        .iter()
        .filter(|c| c.containment == rw_model::AnchorKind::Axial)
        .map(|c| c.id.as_str())
        .collect();
    assert_eq!(chain, ["nose", "recovery_bay", "airframe", "fin_can"]);
    assert_eq!(comp(&m, "chute").parent.as_deref(), Some("recovery_bay"));
    assert_eq!(comp(&m, "flight_computer").parent.as_deref(), Some("ebay"));

    // Four fins: root 140, tip 60, span 90, sweep 45, thickness 3 mm.
    let EvalShape::TrapezoidalFinSet {
        root_chord,
        tip_chord,
        span,
        sweep,
        fins,
        ..
    } = &comp(&m, "fins").shape
    else {
        panic!("fins")
    };
    let mm = |v: f64| (v * 1e3 * 1e6).round() / 1e6;
    assert_eq!(fins.count, 4);
    assert_eq!(
        [
            mm(*root_chord),
            mm(*tip_chord),
            mm(*span),
            mm(*sweep),
            mm(fins.thickness)
        ],
        [140.0, 60.0, 90.0, 45.0, 3.0]
    );

    // Appearance presets.
    use AppearancePreset as P;
    for (id, want) in [
        ("nose", P::CompositeWhite), // satin white per image 01 (M3.1)
        ("recovery_bay", P::ClearPolycarbonate),
        ("airframe", P::CompositeWhite),
        ("fin_can", P::CompositeWhite),
        ("fins", P::CompositeWhite),
        ("chute", P::NylonOrange),
        ("ebay", P::PcbGreen),
        ("flight_computer", P::PcbGreen),
        ("ring_upper", P::AluminiumBrushed),
        ("ring_lower", P::AluminiumBrushed),
        ("motor_casing", P::AluminiumBrushed),
    ] {
        let got = comp(&m, id).appearance.as_ref().and_then(|a| a.preset);
        assert_eq!(got, Some(want), "{id}");
    }

    // The recovery bay locks with four twist locks.
    let j = comp(&m, "recovery_bay").joint.as_ref().expect("joint");
    assert_eq!((j.kind, j.count), (JointType::TwistLock, Some(4)));

    // Configurations and simulations.
    let cfgs: Vec<&str> = m.configs.values().map(|c| c.name.as_str()).collect();
    assert_eq!(cfgs, ["Baseline", "Higher altitude", "Recovery test"]);
    assert_eq!(m.config.as_deref(), Some("baseline"));
    let named = |kind: SimKind| {
        let mut v: Vec<&str> = m
            .sims
            .values()
            .filter(|s| s.kind == kind)
            .map(|s| s.name.as_str())
            .collect();
        v.sort_unstable();
        v
    };
    assert_eq!(
        named(SimKind::Flight),
        [
            "Baseline",
            "Fin revision",
            "Higher altitude",
            "Recovery test"
        ]
    );
    // Page 06 visual flow studies (D10c) on the demo engine's N2O tank.
    assert_eq!(
        named(SimKind::VisualFlow),
        ["Flow overview", "Study 01", "Tank motion"]
    );
    for s in m.sims.values().filter(|s| s.kind == SimKind::VisualFlow) {
        let v = s.visual_flow.as_ref().expect("study");
        assert_eq!((v.engine.as_str(), v.duration), ("demo", 10.0), "{}", s.id);
        assert_eq!(v.attitude, AttitudeSource::ScriptedTilt, "{}", s.id);
    }

    // The previous fin set (concept page 02) is a variant.
    let s = sources("fixtures/research-vehicle");
    let prev = eval(
        &s,
        &EvalOptions {
            variant: Some("previous_fins".into()),
            ..EvalOptions::default()
        },
    );
    let EvalShape::TrapezoidalFinSet { span, sweep, .. } = &comp(&prev, "fins").shape else {
        panic!("fins")
    };
    assert_eq!([mm(*span), mm(*sweep)], [120.0, 30.0]);
}

#[test]
fn case1_fixture_keys_configs_and_sim_on_the_golden_ids() {
    let m = project("fixtures/case1");
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/oracle/case1-generic.json")).unwrap();
    let cfg = golden["config_id"].as_str().unwrap();
    assert_eq!(m.config.as_deref(), Some(cfg));
    let sim = m
        .sims
        .values()
        .find(|s| s.name == golden["sim_name"].as_str().unwrap())
        .expect("golden sim");
    assert_eq!(sim.config, cfg);
    let delay = golden["motors"][0]["delay_s"].as_f64().unwrap();
    assert_eq!(m.configs[cfg].motors[0].delay, Some(delay));
    assert_eq!(
        m.configs[cfg].motors[0].motor.as_deref(),
        Some("generic:RW_C6G")
    );
}
