//! M1.42, BC1 static: oracle case 1 through the real pipeline, with no CLI.
//!
//! `fixtures/case1` (re-authored from `tests/oracle/case1*.json` by
//! `scripts/fixtures/case1-from-golden.ts`) is opened with a read-only
//! `rw_project::Session`, which evaluates it and runs the real static check
//! (`rw_check::check_static` via `StaticChecker`). The report is compared with
//! the golden's `static` block (spec B2: CG ±1 mm, CP ±3 mm, stability
//! ±0.1 cal). The same evaluated model then flies through `rw_sim::simulate`
//! with the fixture's own simulation (`Simulation 5`, RK4 at 0.05 s as the
//! golden records), and the summary is compared with the golden's (apogee and
//! max velocity ±3 %, time to apogee ±0.3 s).
//!
//! `ours_record_case1` writes the B2 run record
//! `target/parity/ours/case1-generic.json` (or `$RW_PARITY_OURS/…`) in the
//! format `scripts/bar/parity.ts` scores. `make bar-parity CASE=1` now refreshes
//! it through the CLI instead (`crates/rw-cli/tests/parity_case1.rs`, M1.42b).
//! Deltas print with
//! `--nocapture`; the numbers are logged in `docs/dev/parity-log.md`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rw_aero::{AeroModel, AeroOptions};
use rw_api::oracle::{OracleMotor, conditions_hash, motor_digest};
use rw_check::{CheckReport, CheckStatus, mounted_from_config};
use rw_mass::MassModel;
use rw_model::{EvalSim, EvaluatedModel, IntegratorKind, SchemaTag};
use rw_project::{Session, SessionOptions};
use rw_sim::outputs::{OR_SUMMARY_KEYS, summary_value};
use rw_sim::{SimInput, SimResult, simulate};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

/// Spec B2 static tolerances (`tests/oracle/tolerances.json`, cases 1-3, 5).
const TOL_CG_M: f64 = 1e-3;
const TOL_CP_M: f64 = 3e-3;
const TOL_STABILITY_CAL: f64 = 0.1;
/// Spec B2 flight tolerances.
const TOL_APOGEE_FRAC: f64 = 0.03;
const TOL_VMAX_FRAC: f64 = 0.03;
const TOL_T_APOGEE_S: f64 = 0.3;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn golden() -> &'static Value {
    static G: OnceLock<Value> = OnceLock::new();
    G.get_or_init(|| {
        let text = std::fs::read_to_string(root().join("tests/oracle/case1-generic.json"))
            .expect("golden case1-generic.json");
        serde_json::from_str(&text).expect("golden json")
    })
}

fn g_num(block: &str, key: &str) -> f64 {
    golden()[block][key]
        .as_f64()
        .unwrap_or_else(|| panic!("golden {block}.{key}"))
}

/// Case 1 evaluated and checked through the Session, plus its flight.
struct Case1 {
    model: EvaluatedModel,
    report: CheckReport,
    sim: EvalSim,
    input: SimInput,
}

fn case1() -> &'static Case1 {
    static C: OnceLock<Case1> = OnceLock::new();
    C.get_or_init(|| {
        let s = Session::open(&root().join("fixtures/case1"), SessionOptions::read_only())
            .expect("open fixtures/case1");
        let model = s.model().clone();
        let report = s.report().clone();
        let sim_name = golden()["sim_name"].as_str().unwrap();
        let sim = model
            .sims
            .values()
            .find(|x| x.name == sim_name)
            .unwrap_or_else(|| panic!("fixture has no sim {sim_name:?}"))
            .clone();
        let config = model.configs.get(&sim.config).expect("sim config").clone();
        let library = s.library();
        let motors = mounted_from_config(&model, &|r: &str| library.motor(r));
        let input = SimInput {
            schema: SchemaTag,
            sim: sim.clone(),
            config,
            model: model.clone(),
            motors,
        };
        Case1 {
            model,
            report,
            sim,
            input,
        }
    })
}

fn fly(integrator: IntegratorKind) -> SimResult {
    let c = case1();
    let mut input = c.input.clone();
    input.sim.conditions.integrator = integrator;
    let geometry = rw_geom::build(&input.model);
    let mass = MassModel::new(&input.model, &geometry, &input.motors);
    let aero = AeroModel::new(&input.model, &geometry, &AeroOptions::default());
    simulate(&input, &aero, &mass, &mut |_| true).expect("case 1 flight")
}

/// The gate flight: the fixture's own integrator (RK4 at 0.05 s, as the
/// golden's `conditions` record).
fn flight() -> &'static SimResult {
    static F: OnceLock<SimResult> = OnceLock::new();
    F.get_or_init(|| fly(case1().sim.conditions.integrator))
}

fn pct(ours: f64, oracle: f64) -> f64 {
    100.0 * (ours / oracle - 1.0)
}

#[test]
fn case1_static_block_matches_golden() {
    let c = case1();
    let r = &c.report;
    assert_ne!(r.status, CheckStatus::Errors, "{:#?}", r.diagnostics);
    assert_eq!(
        c.model.config.as_deref(),
        golden()["config_id"].as_str(),
        "default configuration is the golden's"
    );
    let cg = g_num("static", "cg_m");
    let cp = g_num("static", "cp_m");
    let cna = g_num("static", "cna");
    let stab = g_num("static", "stability_cal");
    let mass = g_num("static", "mass_kg");
    let d_ref = g_num("static", "ref_diameter_m");
    let mach = g_num("static", "mach");
    println!(
        "case 1 static (fixtures/case1 via Session, check at M {})",
        r.aero.mach
    );
    println!(
        "{:<22} {:>12} {:>12} {:>12}",
        "key", "oracle", "ours", "delta"
    );
    let row = |k: &str, o: f64, v: f64, d: String| println!("{k:<22} {o:>12.6} {v:>12.6} {d:>12}");
    row(
        "mass.cg (m)",
        cg,
        r.mass.cg,
        format!("{:+.3} mm", (r.mass.cg - cg) * 1e3),
    );
    row(
        "aero.cp (m)",
        cp,
        r.aero.cp,
        format!("{:+.3} mm", (r.aero.cp - cp) * 1e3),
    );
    row(
        "aero.cna",
        cna,
        r.aero.cna,
        format!("{:+.3}%", pct(r.aero.cna, cna)),
    );
    row(
        "stability.liftoff",
        stab,
        r.stability.liftoff,
        format!("{:+.4} cal", r.stability.liftoff - stab),
    );
    row(
        "mass.liftoff (kg)",
        mass,
        r.mass.liftoff,
        format!("{:+.3}%", pct(r.mass.liftoff, mass)),
    );
    row(
        "ref diameter (m)",
        d_ref,
        r.stability.ref_diameter,
        format!("{:+.3} mm", (r.stability.ref_diameter - d_ref) * 1e3),
    );

    assert!(
        (r.aero.mach - mach).abs() < 1e-9,
        "check Mach {} vs golden {mach}",
        r.aero.mach
    );
    assert!((r.stability.ref_diameter - d_ref).abs() < 1e-9);
    assert!(
        (r.mass.cg - cg).abs() <= TOL_CG_M,
        "CG {} vs {cg}",
        r.mass.cg
    );
    assert!(
        (r.aero.cp - cp).abs() <= TOL_CP_M,
        "CP {} vs {cp}",
        r.aero.cp
    );
    assert!(
        (r.stability.liftoff - stab).abs() <= TOL_STABILITY_CAL,
        "stability {} vs {stab}",
        r.stability.liftoff
    );
}

#[test]
fn case1_flight_summary_matches_golden() {
    let c = case1();
    assert_eq!(c.sim.conditions.integrator, IntegratorKind::Rk4);
    let rk4 = flight();
    let dp = fly(IntegratorKind::Dp54);
    println!("case 1 flight (fixtures/case1, {})", c.sim.name);
    println!(
        "{:<26} {:>12} {:>12} {:>10} {:>12} {:>10}",
        "key (ours)", "oracle", "rk4 0.05 s", "delta", "dp54", "delta"
    );
    for (or, ours) in OR_SUMMARY_KEYS {
        let o = g_num("summary", or);
        let a = summary_value(&rk4.summary, ours).unwrap_or(f64::NAN);
        let b = summary_value(&dp.summary, ours).unwrap_or(f64::NAN);
        let d = |v: f64| {
            if ours.ends_with("_s") {
                format!("{:+.3} s", v - o)
            } else {
                format!("{:+.2}%", pct(v, o))
            }
        };
        println!(
            "{ours:<26} {o:>12.4} {a:>12.4} {:>10} {b:>12.4} {:>10}",
            d(a),
            d(b)
        );
    }
    println!(
        "integrator: rk4 vs dp54 apogee {:+.3}%",
        pct(rk4.summary.apogee_m, dp.summary.apogee_m)
    );
    let apo = g_num("summary", "max_altitude_m");
    let vmax = g_num("summary", "max_velocity_ms");
    let tapo = g_num("summary", "time_to_apogee_s");
    for (label, r) in [("rk4", rk4), ("dp54", &dp)] {
        let s = &r.summary;
        assert!(
            (s.apogee_m - apo).abs() <= TOL_APOGEE_FRAC * apo,
            "{label} apogee {:+.2}%",
            pct(s.apogee_m, apo)
        );
        assert!(
            (s.max_velocity_ms - vmax).abs() <= TOL_VMAX_FRAC * vmax,
            "{label} max velocity {:+.2}%",
            pct(s.max_velocity_ms, vmax)
        );
        assert!(
            (s.time_to_apogee_s - tapo).abs() <= TOL_T_APOGEE_S,
            "{label} time to apogee {:+.3} s",
            s.time_to_apogee_s - tapo
        );
    }
}

/// The B2 run record (`OurRun`, `tests/oracle/README.md`) for case 1.
fn ours_record() -> Value {
    let c = case1();
    let geometry = std::fs::read(root().join("tests/oracle/case1.geometry.json"))
        .expect("case1.geometry.json");
    let geometry_sha256: String = Sha256::digest(&geometry)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let motors: Vec<OracleMotor> = c
        .input
        .motors
        .iter()
        .map(|m| OracleMotor {
            mount: m.mount.clone(),
            designation: m.curve.designation.clone(),
            digest: m.curve.sha256.clone(),
            delay_s: m.delay,
        })
        .collect();
    let mut summary = Map::new();
    for (_, ours) in OR_SUMMARY_KEYS {
        summary.insert(
            (*ours).to_string(),
            summary_value(&flight().summary, ours).map_or(Value::Null, |v| json!(v)),
        );
    }
    let r = &c.report;
    json!({
        "kind": "ours",
        "case": 1,
        "matrix": "generic",
        "sim_name": c.sim.name,
        "config_id": c.sim.config,
        "geometry_sha256": geometry_sha256,
        "conditions_hash": conditions_hash(&c.sim.conditions),
        "motor_digest": motor_digest(&motors),
        "summary": summary,
        "check": {
            "mass.cg": r.mass.cg,
            "aero.cp": r.aero.cp,
            "aero.cna": r.aero.cna,
            "stability.liftoff": r.stability.liftoff,
        },
    })
}

#[test]
fn ours_record_case1() {
    let rec = ours_record();
    let dir = std::env::var_os("RW_PARITY_OURS")
        .map(PathBuf::from)
        .unwrap_or_else(|| root().join("target/parity/ours"));
    std::fs::create_dir_all(&dir).expect("parity ours dir");
    let path = dir.join("case1-generic.json");
    let text = serde_json::to_string_pretty(&rec).unwrap() + "\n";
    std::fs::write(&path, &text).expect("write ours record");
    println!("wrote {}", path.display());
    // Written before the identity check, so the scoreboard can show a
    // mismatch; the setup must still be the golden's for rows to score.
    let g = golden();
    for f in [
        "sim_name",
        "config_id",
        "geometry_sha256",
        "conditions_hash",
        "motor_digest",
    ] {
        assert_eq!(rec[f], g[f], "{f}: ours vs golden");
    }
    // Deterministic (I8): a second assembly is identical.
    assert_eq!(rec, ours_record());
}
