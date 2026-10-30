//! Golden check report of the `simple` fixture (Acc 3, I8). Regenerate with
//! `RW_UPDATE_GOLDEN=1 cargo test -p rw-check --test golden`.
#![allow(clippy::disallowed_methods)]

mod common;

use rw_check::{CheckReport, CheckStatus, canonical_json};

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/simple.json");

#[test]
fn simple_matches_golden_and_is_byte_stable() {
    let model = common::model(common::SIMPLE);
    let a = canonical_json(&common::run(&model));
    let b = canonical_json(&common::run(&model));
    assert_eq!(a, b, "two runs differ (I8)");
    if std::env::var_os("RW_UPDATE_GOLDEN").is_some() {
        std::fs::write(GOLDEN, &a).unwrap();
    }
    let want =
        std::fs::read_to_string(GOLDEN).expect("golden missing; run with RW_UPDATE_GOLDEN=1");
    assert_eq!(
        a, want,
        "check report drifted from tests/golden/simple.json"
    );
    // The golden parses back as an IF7 report.
    let r: CheckReport = serde_json::from_str(&want).unwrap();
    assert_eq!(canonical_json(&r), want);
}

#[test]
fn simple_report_is_physically_sane() {
    let r = common::run(&common::model(common::SIMPLE));
    assert_ne!(r.status, CheckStatus::Errors, "{:#?}", r.diagnostics);
    assert!(r.mass.liftoff > r.mass.burnout && r.mass.burnout > r.mass.dry);
    assert!(r.aero.cp > r.mass.cg, "CP aft of CG");
    assert!(r.stability.liftoff > 1.0);
    assert!(r.stability.min <= r.stability.liftoff && r.stability.min <= r.stability.burnout);
    assert_eq!(r.dims.length, 0.55);
    assert!((r.dims.fin_span.unwrap() - (0.0416 + 0.1)).abs() < 1e-9);
    assert_eq!(r.motor.len(), 1);
    assert!(r.motor[0].fits_mount);
    assert!(
        r.aero
            .terms
            .iter()
            .all(|t| t.model.starts_with("niskanen-2009"))
    );
    let stable = r.assertions.iter().find(|a| a.id == "stable").unwrap();
    assert!(stable.pass && stable.value == Some(r.stability.liftoff));
    assert_eq!(r.report["= c.fins.span"].value, 0.05);
    assert!(r.inputs.contains_key("motor:generic:RW_C6G"));
    for rule in [
        "recovery_volume",
        "centering_ring_fit",
        "coupler_fit",
        "motor_fit",
    ] {
        let found = r
            .clearance
            .iter()
            .any(|c| serde_json::to_value(c.rule).unwrap() == rule && c.pass);
        assert!(found, "no passing {rule} row: {:#?}", r.clearance);
    }
    assert!(r.interference.is_empty(), "{:#?}", r.interference);
}
