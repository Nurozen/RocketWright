//! The committed example projects against the oracle and against flight
//! sanity (plan M1.54b, M1.54c), until `rw check --strict` exists:
//!
//! - `fixtures/case1` … `case7`: the golden sim's conditions hash, config id,
//!   sim name, and motor digests equal the golden's (the M1.16 mismatch keys),
//!   and the model evaluates without errors.
//! - Every fixture and template, in every configuration: each motor is a
//!   generic one that fits its mount, the liftoff static margin is at least
//!   1 cal, and the liftoff thrust-to-weight ratio is at least 5 at peak
//!   thrust and 3 at average thrust.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::path::Path;

use rw_aero::{AeroModel, AeroOptions};
use rw_api::oracle::{OracleFile, conditions_hash};
use rw_mass::MassModel;
use rw_model::source::doc_kind;
use rw_model::{EvalOptions, EvalShape, EvaluatedModel, SourceSet, eval, parse_source};
use rw_motor::MountedMotor;
use sha2::{Digest, Sha256};

const PROJECTS: &[&str] = &[
    "fixtures/case1",
    "fixtures/simple",
    "fixtures/research-vehicle",
    "templates/simple-rocket",
    "templates/minimum",
];

const G0: f64 = 9.80665;

fn walk(dir: &Path, base: &Path, s: &mut SourceSet) {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            walk(&p, base, s);
            continue;
        }
        let rel = p
            .strip_prefix(base)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if doc_kind(&rel).is_some() {
            let text = std::fs::read_to_string(&p).unwrap();
            let doc = parse_source(&rel, &text).unwrap_or_else(|e| panic!("{rel}: {e:?}"));
            s.docs.insert(rel, doc);
        }
    }
}

fn sources(rel: &str) -> SourceSet {
    let dir = common::repo_root().join(rel);
    let mut s = SourceSet::default();
    walk(&dir, &dir, &mut s);
    s
}

fn eval_config(s: &SourceSet, config: &str) -> EvaluatedModel {
    let m = eval(
        s,
        &EvalOptions {
            config: Some(config.to_string()),
            ..EvalOptions::default()
        },
    );
    // The research vehicle's incomplete engine variant carries its two
    // documented missing inputs (plan D10b, fixtures/README.md).
    let unexpected: Vec<_> = m
        .diagnostics
        .iter()
        .filter(|d| d.file.as_deref() != Some("engines/demo-incomplete.rw.toml"))
        .collect();
    assert!(unexpected.is_empty(), "{unexpected:#?}");
    m
}

/// The configuration's generic motors, aft end at the mount's aft end plus
/// the overhang.
fn motors(m: &EvaluatedModel, config: &str) -> Vec<MountedMotor> {
    m.configs[config]
        .motors
        .iter()
        .map(|a| {
            let r = a.motor.as_deref().expect("solid motor");
            let curve = rw_motor::generic::generic_motor(r)
                .unwrap_or_else(|| panic!("{config}: `{r}` is not a generic motor"));
            let mount = m.components.iter().find(|c| c.id == a.mount).unwrap();
            let EvalShape::InnerTube {
                length,
                id,
                overhang,
                ..
            } = mount.shape
            else {
                panic!("{config}: {} is not an inner tube", a.mount)
            };
            assert!(
                curve.diameter <= id + 1e-9,
                "{config}: {} ({} mm) does not fit {} (id {} mm)",
                curve.designation,
                curve.diameter * 1e3,
                a.mount,
                id * 1e3
            );
            assert!(
                curve.length <= length + overhang + 1e-9,
                "{config}: {} is longer than {}",
                curve.designation,
                a.mount
            );
            MountedMotor {
                mount: a.mount.clone(),
                x_fore: mount.x_aft + overhang - curve.length,
                curve,
                ignition_time: 0.0,
                delay: a.delay,
                count: 1,
            }
        })
        .collect()
}

#[test]
fn oracle_case_sims_match_the_golden_mismatch_keys() {
    let root = common::repo_root();
    for n in 1..=7 {
        let file: OracleFile = serde_json::from_str(
            &std::fs::read_to_string(root.join(format!("tests/oracle/case{n}-generic.json")))
                .unwrap(),
        )
        .unwrap();
        let OracleFile::Golden(golden) = file else {
            panic!("case{n}-generic.json is not a golden")
        };
        let s = sources(&format!("fixtures/case{n}"));
        let m = eval_config(&s, &golden.config_id);
        let errors: Vec<_> = m
            .diagnostics
            .iter()
            .filter(|d| d.code.starts_with("RW-E"))
            .collect();
        assert!(errors.is_empty(), "case{n}: {errors:?}");
        let sim = m
            .sims
            .values()
            .find(|x| x.name == golden.sim_name)
            .unwrap_or_else(|| panic!("case{n}: a sim named like the golden's"));
        assert_eq!(sim.config, golden.config_id, "case{n}");
        assert_eq!(sim.conditions, golden.conditions, "case{n}");
        assert_eq!(
            conditions_hash(&sim.conditions),
            golden.conditions_hash,
            "case{n}"
        );

        // The configuration flies the golden's curve files with their delays
        // (placed as a run places them; oracle mounts may be shorter than
        // the motor, which `rw check` reports).
        let mm = rw_sim::stages::mounted_motors(&m, &rw_motor::generic::generic_motor);
        let mut ours: Vec<(String, Option<f64>)> = mm
            .iter()
            .map(|x| (x.curve.designation.clone(), x.delay))
            .collect();
        let mut theirs: Vec<(String, Option<f64>)> = golden
            .motors
            .iter()
            .map(|x| (x.designation.clone(), x.delay_s))
            .collect();
        let key = |a: &(String, Option<f64>), b: &(String, Option<f64>)| {
            a.0.cmp(&b.0)
                .then(a.1.unwrap_or(-1.0).total_cmp(&b.1.unwrap_or(-1.0)))
        };
        ours.sort_by(key);
        theirs.sort_by(key);
        assert_eq!(ours, theirs, "case{n}");
        for theirs in &golden.motors {
            let rse = root.join(format!("lib/motors/generic/{}.rse", theirs.designation));
            let digest: String = Sha256::digest(std::fs::read(rse).unwrap())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            assert_eq!(digest, theirs.digest, "case{n}");
        }
    }
}

#[test]
fn every_configuration_is_stable_and_leaves_the_pad() {
    for rel in PROJECTS {
        let s = sources(rel);
        let configs: Vec<String> = eval(&s, &EvalOptions::default())
            .configs
            .keys()
            .cloned()
            .collect();
        for cfg in configs {
            let m = eval_config(&s, &cfg);
            let mm = motors(&m, &cfg);
            let geometry = rw_geom::build(&m);
            let mass = MassModel::new(&m, &geometry, &mm).at(0.0);
            let aero = AeroModel::new(&m, &geometry, &AeroOptions::default()).static_coeffs();
            let margin = (aero.cp - mass.cg) / m.reference.diameter;
            let peak: f64 = mm.iter().map(|x| x.curve.max_thrust).sum();
            let avg: f64 = mm.iter().map(|x| x.curve.average_thrust).sum();
            let twr = peak / (mass.mass * G0);
            let avg_twr = avg / (mass.mass * G0);
            println!(
                "{rel} [{cfg}]: mass {:.1} g, cg {:.1} mm, cp {:.1} mm, margin {margin:.2} cal, T/W peak {twr:.1} avg {avg_twr:.1}",
                mass.mass * 1e3,
                mass.cg * 1e3,
                aero.cp * 1e3
            );
            if std::env::var_os("RW_FIXTURE_MASSES").is_some() {
                for c in MassModel::new(&m, &geometry, &mm).breakdown() {
                    println!("  {c:?}");
                }
            }
            assert!(margin >= 1.0, "{rel} [{cfg}]: margin {margin:.2} cal");
            assert!(twr >= 5.0, "{rel} [{cfg}]: peak thrust/weight {twr:.1}");
            assert!(
                avg_twr >= 3.0,
                "{rel} [{cfg}]: average thrust/weight {avg_twr:.1}"
            );
        }
    }
}
