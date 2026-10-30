//! Each clearance, interference, motor, stability, and assertion rule fires on
//! a targeted edit of the `simple` fixture, and `CheckDelta::between` reports it.

mod common;

use rw_check::{CheckDelta, CheckReport, CheckStatus, ClearanceRule, InterferenceKind};
use serde_json::{Value, json};

fn edited(f: impl FnOnce(&mut Value)) -> CheckReport {
    let mut v: Value = serde_json::from_str(common::SIMPLE).unwrap();
    f(&mut v);
    common::run(&serde_json::from_value(v).unwrap())
}

fn comp<'a>(v: &'a mut Value, id: &str) -> &'a mut Value {
    v["components"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["id"] == id)
        .unwrap()
}

fn codes(r: &CheckReport) -> Vec<&str> {
    r.diagnostics.iter().map(|d| d.code.as_str()).collect()
}

fn rule_fails(r: &CheckReport, rule: ClearanceRule) -> bool {
    r.clearance.iter().any(|c| c.rule == rule && !c.pass)
}

#[test]
fn baseline_is_clean() {
    let r = common::run(&common::model(common::SIMPLE));
    assert_eq!(r.status, CheckStatus::Clean, "{:#?}", r.diagnostics);
}

#[test]
fn oversized_ring_fails_ring_fit() {
    let r = edited(|v| comp(v, "ring")["shape"]["od"] = json!(0.0405));
    assert!(rule_fails(&r, ClearanceRule::CenteringRingFit));
    assert!(codes(&r).contains(&"RW-E151"), "{:?}", codes(&r));
    assert!(
        codes(&r).contains(&"RW-E157"),
        "radial protrusion too: {:?}",
        codes(&r)
    );
    assert_eq!(r.status, CheckStatus::Errors);
}

#[test]
fn ring_bore_smaller_than_mount_fails() {
    let r = edited(|v| comp(v, "ring")["shape"]["id"] = json!(0.018));
    assert!(codes(&r).contains(&"RW-E151"));
    assert!(
        codes(&r).contains(&"RW-E156"),
        "ring overlaps the mount: {:?}",
        codes(&r)
    );
    assert!(
        r.interference
            .iter()
            .any(|i| i.kind == InterferenceKind::Overlap)
    );
}

#[test]
fn fat_shoulder_fails_coupler_fit() {
    let r = edited(|v| comp(v, "nose")["shape"]["shoulder"]["od"] = json!(0.0405));
    assert!(rule_fails(&r, ClearanceRule::CouplerFit));
    let d = r.diagnostics.iter().find(|d| d.code == "RW-E150").unwrap();
    assert_eq!(d.path.as_deref(), Some("/c/nose/shoulder/od"));
    assert!(d.hint.as_deref().unwrap().contains("39.80 mm"));
}

#[test]
fn wide_motor_fails_motor_fit() {
    let r = edited(|v| comp(v, "mount")["shape"]["id"] = json!(0.0175));
    assert!(rule_fails(&r, ClearanceRule::MotorFit));
    assert!(!r.motor[0].fits_mount);
    assert!(codes(&r).contains(&"RW-E152"));
}

#[test]
fn short_mount_fails_motor_length() {
    let r = edited(|v| {
        let m = comp(v, "mount");
        m["x_fore"] = json!(0.52);
        m["shape"]["length"] = json!(0.03);
    });
    assert!(!r.motor[0].fits_mount);
    assert!(codes(&r).contains(&"RW-E152"));
}

#[test]
fn packed_chute_too_big_fails_recovery_volume() {
    let r = edited(|v| {
        let c = comp(v, "chute");
        c["x_aft"] = json!(0.47);
        c["shape"]["packed_length"] = json!(0.30);
        c["shape"]["packed_diameter"] = json!(0.0398);
        // A bulkhead closes the bay at 0.30 m.
        let mut bh = comp(v, "ring").clone();
        bh["id"] = json!("bulk");
        bh["x_fore"] = json!(0.30);
        bh["x_aft"] = json!(0.306);
        bh["shape"] = json!({"type": "bulkhead", "length": 0.006, "od": 0.0398});
        v["components"].as_array_mut().unwrap().push(bh);
    });
    assert!(
        rule_fails(&r, ClearanceRule::RecoveryVolume),
        "{:#?}",
        r.clearance
    );
    assert!(codes(&r).contains(&"RW-E155"));
    assert!(
        codes(&r).contains(&"RW-E156"),
        "chute overlaps the bulkhead"
    );
}

#[test]
fn fins_past_tube_end_fail_joint_rule() {
    let r = edited(|v| {
        let f = comp(v, "fins");
        f["x_fore"] = json!(0.50);
        f["x_aft"] = json!(0.57);
    });
    assert!(rule_fails(&r, ClearanceRule::FinAcrossJoint));
    assert!(
        r.interference
            .iter()
            .any(|i| i.kind == InterferenceKind::FinThroughJoint)
    );
    assert!(codes(&r).contains(&"RW-E154"));
}

#[test]
fn swept_tip_past_tube_end_is_not_a_joint_failure() {
    // The root chord stays on the tube; only the swept tip overhangs.
    let r = edited(|v| {
        let f = comp(v, "fins");
        f["shape"]["sweep"] = json!(0.05);
        f["shape"]["tip_chord"] = json!(0.05);
        f["x_aft"] = json!(0.58);
    });
    assert!(!rule_fails(&r, ClearanceRule::FinAcrossJoint));
    assert!(!codes(&r).contains(&"RW-E154"), "{:?}", codes(&r));
}

#[test]
fn motor_mount_may_stick_out_of_the_airframe_aft_end() {
    let shift = |motor_mount: bool| {
        edited(move |v| {
            let m = comp(v, "mount");
            m["x_fore"] = json!(0.485);
            m["x_aft"] = json!(0.555);
            m["shape"]["motor_mount"] = json!(motor_mount);
        })
    };
    assert!(!codes(&shift(true)).contains(&"RW-E157"));
    // Any other inner tube must stay inside its parent.
    assert!(codes(&shift(false)).contains(&"RW-E157"));
}

#[test]
fn deep_fin_tab_hits_mount() {
    let r = edited(|v| {
        comp(v, "fins")["shape"]["tab"] = json!({"height": 0.015, "length": 0.05, "offset": 0.0});
    });
    let row = r
        .clearance
        .iter()
        .find(|c| c.rule == ClearanceRule::FinTabWall);
    let row = row.expect("fin tab row");
    assert!(!row.pass && row.b.as_deref() == Some("mount"), "{row:#?}");
    assert!(codes(&r).contains(&"RW-E153"));
}

#[test]
fn heavy_tail_is_unstable_and_fails_assert() {
    let r = edited(|v| {
        let b = comp(v, "body");
        b["override"] = json!({"mass": 1.0, "cg": 0.54, "subtree": false});
    });
    assert!(r.stability.liftoff < 0.0);
    let d = r.diagnostics.iter().find(|d| d.code == "RW-E101").unwrap();
    assert_eq!(d.path.as_deref(), Some("/c/fins/span"));
    let a = r.assertions.iter().find(|a| a.id == "stable").unwrap();
    assert!(!a.pass && a.message.is_some());
    assert_eq!(r.status, CheckStatus::Errors);
    assert!(
        codes(&r).contains(&"RW-W102"),
        "1 kg on a C6 is underpowered"
    );
}

#[test]
fn asserts_handle_units_sim_and_errors() {
    let r = edited(|v| {
        v["asserts"] = json!([
            {"id": "light", "expr": "mass.liftoff <= 200 g", "severity": "warning", "needs_sim": false},
            {"id": "short", "expr": "length < 0.5 m", "severity": "warning", "needs_sim": false},
            {"id": "apogee", "expr": "apogee_m >= 100 m", "severity": "error", "needs_sim": true},
            {"id": "typo", "expr": "stability.lifoff >= 1", "severity": "error", "needs_sim": false},
            {"id": "mixed", "expr": "mass.liftoff >= 1 m", "severity": "error", "needs_sim": false},
            {"id": "param", "expr": "c.fins.span >= params.span", "severity": "error", "needs_sim": false},
            {"id": "bore", "expr": "c.body.id - c.mount.od > 20 mm", "severity": "error", "needs_sim": false}
        ]);
        v["report"] = json!(["= c.fins.span * 2", "= stability.liftoff", "= c.nope.od"]);
    });
    let by = |id: &str| r.assertions.iter().find(|a| a.id == id).unwrap();
    assert!(by("light").pass);
    assert!(!by("short").pass && by("short").value == Some(0.55));
    assert!(by("apogee").pass && by("apogee").value.is_none());
    assert_eq!(by("apogee").message.as_deref(), Some("needs --sim quick"));
    assert!(!by("typo").pass && by("typo").message.as_deref().unwrap().contains("lifoff"));
    assert!(!by("mixed").pass);
    assert!(by("param").pass);
    assert!(by("bore").pass && (by("bore").value.unwrap() - 0.0201).abs() < 1e-9);
    assert_eq!(r.report["= c.fins.span * 2"].value, 0.1);
    assert_eq!(r.report["= stability.liftoff"].value, r.stability.liftoff);
    assert!(!r.report.contains_key("= c.nope.od"));
    assert!(codes(&r).contains(&"RW-E041"));
    assert_eq!(r.status, CheckStatus::Errors);
}

#[test]
fn delta_reports_changed_metrics_and_diagnostics() {
    let before = common::run(&common::model(common::SIMPLE));
    let after = edited(|v| comp(v, "ring")["shape"]["od"] = json!(0.0405));
    let d = CheckDelta::between(&before, &after, Some("s0002".into()));
    assert_eq!(d.status, CheckStatus::Errors);
    assert_eq!(d.step.as_deref(), Some("s0002"));
    let ring = &d.changed["dims.components.ring.od"];
    assert_eq!(ring, &[Some(0.0398), Some(0.0405)]);
    assert!(d.new_diagnostics.iter().any(|x| x.code == "RW-E151"));
    assert!(d.resolved_diagnostics.is_empty());
    let back = CheckDelta::between(&after, &before, None);
    assert!(
        back.resolved_diagnostics
            .iter()
            .any(|k| k == "RW-E151@/c/ring/od")
    );
    assert!(back.new_diagnostics.is_empty());
    let none = CheckDelta::between(&before, &before, None);
    assert!(none.changed.is_empty() && none.new_diagnostics.is_empty());
    assert!(
        !d.changed.contains_key("mass.liftoff")
            || d.changed["mass.liftoff"][0] != d.changed["mass.liftoff"][1]
    );
}
