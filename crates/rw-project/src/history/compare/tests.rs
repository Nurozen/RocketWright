use super::*;
use crate::session::{Session, SessionOptions};
use crate::testutil::{TempDir, fixture_project};
use rw_api::{CallCtx, Command, CompareOut, HistoryCompareIn, Origin, Response};
use rw_model::PatchOp;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn ctx() -> CallCtx {
    CallCtx {
        origin: Origin::Cli,
        thread: None,
        tool_call: None,
        label: None,
    }
}

fn patch(s: &mut Session, ops: Vec<PatchOp>, title: &str) {
    s.patch(&ops, false, &ctx(), "model_patch", title.into())
        .unwrap();
}

fn replace(path: &str, v: Value) -> PatchOp {
    PatchOp::Replace {
        path: path.into(),
        value: v,
    }
}

fn compare(s: &mut Session, a: &str, b: &str) -> CompareOut {
    compare_with(s, a, b, false)
}

fn compare_with(s: &mut Session, a: &str, b: &str, breakdown: bool) -> CompareOut {
    let cmd = Command::HistoryCompare(HistoryCompareIn {
        a: a.into(),
        b: b.into(),
        visual: false,
        breakdown,
    });
    match s.execute(&cmd, &ctx()).unwrap() {
        Response::HistoryCompare(c) => c,
        other => panic!("{other:?}"),
    }
}

fn mark<'a>(c: &'a CompareOut, id: &str) -> Option<&'a ComponentMark> {
    c.marks.iter().find(|m| m.id == id)
}

#[test]
fn source_diff_carries_si_values_and_units() {
    let a = json!({"c": {"fins": {"span": "50 mm", "count": 3, "sweep": "= params.s"}},
                   "params": {"span": {"value": "2 in"}}});
    let b = json!({"c": {"fins": {"span": "70 mm", "count": 4, "sweep": "40 mm"}},
                   "params": {"span": {"value": "60 mm"}}});
    let d = model_diff("step:1", &a, "live", &b);
    let get = |p: &str| d.changed.iter().find(|c| c.path == p).unwrap();
    let span = get("/c/fins/span");
    assert_eq!(span.component, "fins");
    assert_eq!(span.unit.as_deref(), Some("m"));
    assert!((span.old_si.unwrap() - 0.05).abs() < 1e-12);
    assert!((span.new_si.unwrap() - 0.07).abs() < 1e-12);
    // A bare count has no unit; an expression side has no SI value.
    let count = get("/c/fins/count");
    assert_eq!((count.unit.as_ref(), count.old_si), (None, None));
    let sweep = get("/c/fins/sweep");
    assert_eq!(sweep.unit.as_deref(), Some("m"));
    assert_eq!(sweep.old_si, None);
    assert!((sweep.new_si.unwrap() - 0.04).abs() < 1e-12);
    // Params convert across units (2 in → 60 mm).
    let p = get("/params/span/value");
    assert!((p.old_si.unwrap() - 0.0508).abs() < 1e-12);
    assert_eq!(p.component, "params");
}

#[test]
fn source_diff_mixed_dimensions_have_no_unit() {
    let d = model_diff(
        "a",
        &json!({"c": {"x": {"mass": "2 g"}}}),
        "b",
        &json!({"c": {"x": {"mass": "2 mm"}}}),
    );
    assert_eq!(d.changed[0].unit, None);
    assert_eq!((d.changed[0].old_si, d.changed[0].new_si), (None, None));
}

#[test]
fn metric_units_follow_metric_paths() {
    assert_eq!(metric_unit("dims.length"), Some("m"));
    assert_eq!(metric_unit("mass.liftoff"), Some("kg"));
    assert_eq!(metric_unit("mass.cg"), Some("m"));
    assert_eq!(metric_unit("aero.cp"), Some("m"));
    assert_eq!(metric_unit("aero.cna"), None);
    assert_eq!(metric_unit("aero.cd"), None);
    assert_eq!(metric_unit("stability.liftoff"), Some("cal"));
    assert_eq!(metric_unit("apogee_m"), Some("m"));
    assert_eq!(metric_unit("max_mach"), None);
    assert_eq!(metric_unit("nope"), None);
    assert_eq!(metric_unit("mass.components.fins.mass"), Some("kg"));
    assert_eq!(metric_unit("mass.components.fins.cg"), Some("m"));
    assert_eq!(metric_unit("aero.terms.fins.cna"), None);
    assert_eq!(metric_unit("aero.terms.fins.cp"), Some("m"));
}

/// B3 round 11, T4: a longer body and a longer nose both add mass; the
/// breakdown rows say how much each added, so no agent credits one of them
/// with the whole change.
#[test]
fn breakdown_attributes_mass_and_aero_to_components() {
    let d = TempDir::new("cmp-breakdown");
    fixture_project(d.path());
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    patch(
        &mut s,
        vec![
            replace("/params/span/value", json!("70 mm")),
            replace("/c/body/length", json!("450 mm")),
            replace("/c/nose/length", json!("170 mm")),
        ],
        "longer fins, body, and nose",
    );
    // Without the flag: no breakdown rows.
    assert!(compare(&mut s, "step:1", "live").breakdown.is_empty());
    let c = compare_with(&mut s, "step:1", "live", true);
    let row = |k: &str| {
        c.breakdown
            .iter()
            .find(|r| r.key == k)
            .unwrap_or_else(|| panic!("no {k}: {:?}", c.breakdown))
    };
    let (body, nose) = (
        row("mass.components.body.mass"),
        row("mass.components.nose.mass"),
    );
    assert_eq!(body.unit.as_deref(), Some("kg"));
    assert!(body.delta.unwrap() > 0.0, "{body:?}");
    assert!(nose.delta.unwrap() > 0.0, "{nose:?}");
    assert!(body.delta_pct.is_some());
    // The component deltas add up to the dry-mass delta.
    let dry = c.metrics.iter().find(|r| r.key == "mass.dry").unwrap();
    let sum: f64 = c
        .breakdown
        .iter()
        .filter(|r| r.key.starts_with("mass.components.") && r.key.ends_with(".mass"))
        .filter_map(|r| r.delta)
        .sum();
    assert!((sum - dry.delta.unwrap()).abs() < 1e-6, "{sum} vs {dry:?}");
    // The chute did not change.
    assert_eq!(row("mass.components.chute.mass").delta, Some(0.0));
    // Aero terms: the fins' CNa grows with the span; CP rows are lengths.
    let cna = row("aero.terms.fins.cna");
    assert_eq!(cna.unit, None);
    assert!(cna.delta.unwrap() > 0.0);
    assert_eq!(row("aero.terms.fins.cp").unit.as_deref(), Some("m"));
    // Order: mass rows (mass, cg per component), then aero terms.
    let first_aero = c
        .breakdown
        .iter()
        .position(|r| r.key.starts_with("aero.terms."))
        .unwrap();
    assert!(
        c.breakdown[..first_aero]
            .iter()
            .all(|r| r.key.starts_with("mass.components."))
    );
    assert!(
        c.breakdown[first_aero..]
            .iter()
            .all(|r| r.key.starts_with("aero.terms."))
    );
}

#[test]
fn breakdown_rows_of_added_and_removed_components_have_one_side() {
    let d = TempDir::new("cmp-breakdown-add");
    fixture_project(d.path());
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    patch(
        &mut s,
        vec![PatchOp::Remove {
            path: "/c/chute".into(),
        }],
        "no chute",
    );
    let c = compare_with(&mut s, "step:1", "live", true);
    let r = c
        .breakdown
        .iter()
        .find(|r| r.key == "mass.components.chute.mass")
        .unwrap_or_else(|| panic!("{:?}", c.breakdown));
    assert!(r.a.is_some() && r.b.is_none() && r.delta.is_none(), "{r:?}");
    // Removed components come after `b`'s.
    let last_mass = c
        .breakdown
        .iter()
        .rev()
        .find(|r| r.key.starts_with("mass.components."))
        .unwrap();
    assert_eq!(last_mass.key, "mass.components.chute.cg");
}

#[test]
fn param_edit_marks_the_evaluated_component_changed() {
    let d = TempDir::new("cmp-param");
    fixture_project(d.path());
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    patch(
        &mut s,
        vec![replace("/params/span/value", json!("70 mm"))],
        "span 70",
    );
    let c = compare(&mut s, "step:1", "live");
    // The source diff is the param; the marks follow it to the fins.
    assert_eq!(c.model.changed.len(), 1);
    assert_eq!(c.model.changed[0].path, "/params/span/value");
    assert_eq!(c.model.changed[0].unit.as_deref(), Some("m"));
    let fins = mark(&c, "fins").expect("fins marked");
    assert_eq!(fins.status, MarkStatus::Changed);
    let span = fins
        .fields
        .iter()
        .find(|f| f.path == "/shape/span")
        .unwrap_or_else(|| panic!("{:?}", fins.fields));
    assert_eq!(span.unit.as_deref(), Some("m"));
    assert!((span.old.unwrap() - 0.05).abs() < 1e-12);
    assert!((span.new.unwrap() - 0.07).abs() < 1e-12);
    assert_eq!(c.marks.len(), 1, "{:?}", c.marks);
    // Metrics carry units; a static metric that moved is there.
    let row = |k: &str| c.metrics.iter().find(|r| r.key == k).unwrap();
    assert_eq!(row("dims.fin_span").unit.as_deref(), Some("m"));
    assert_eq!(row("stability.liftoff").unit.as_deref(), Some("cal"));
    assert!(row("dims.fin_span").delta.unwrap() > 0.0);
    // Same version: nothing marked.
    assert!(compare(&mut s, "live", "live").marks.is_empty());
}

#[test]
fn marks_added_removed_and_length_not_stations() {
    let d = TempDir::new("cmp-marks");
    fixture_project(d.path());
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let chute = json!({"type": "parachute", "attach": {"to": "body.inner", "at": "attach"},
        "diameter": "450 mm", "cd": 0.8, "packed_length": "60 mm", "packed_diameter": "35 mm"});
    patch(
        &mut s,
        vec![
            PatchOp::Remove {
                path: "/c/chute".into(),
            },
            PatchOp::Add {
                path: "/c/drogue".into(),
                value: chute,
            },
            replace("/c/nose/length", json!("170 mm")),
        ],
        "swap chute, longer nose",
    );
    let c = compare(&mut s, "step:1", "step:2");
    assert_eq!(c.model.added, ["drogue"]);
    assert_eq!(c.model.removed, ["chute"]);
    assert_eq!(mark(&c, "drogue").unwrap().status, MarkStatus::Added);
    assert_eq!(mark(&c, "chute").unwrap().status, MarkStatus::Removed);
    let nose = mark(&c, "nose").unwrap();
    assert_eq!(nose.status, MarkStatus::Changed);
    assert!(nose.fields.iter().any(|f| f.path == "/length"
        && f.unit.as_deref() == Some("m")
        && (f.new.unwrap() - 0.17).abs() < 1e-12));
    // Body, fins, mount, ring only moved aft with the nose: unmarked.
    for id in ["body", "fins", "mount", "ring"] {
        assert!(mark(&c, id).is_none(), "{id}: {:?}", mark(&c, id));
    }
    // Order: new model order (added/changed), then removed.
    assert_eq!(c.marks.last().unwrap().id, "chute");
    // Reverse direction swaps added and removed.
    let r = compare(&mut s, "step:2", "step:1");
    assert_eq!(mark(&r, "chute").unwrap().status, MarkStatus::Added);
    assert_eq!(mark(&r, "drogue").unwrap().status, MarkStatus::Removed);
}

#[test]
fn unknown_versions_are_errors() {
    let d = TempDir::new("cmp-unknown");
    fixture_project(d.path());
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let cmd = Command::HistoryCompare(HistoryCompareIn {
        a: "run:nope".into(),
        b: "live".into(),
        visual: false,
        breakdown: false,
    });
    let e = s.execute(&cmd, &ctx()).unwrap_err();
    assert_eq!(e.code, rw_api::ApiErrorCode::NotFound);
}

fn case1(dest: &Path) {
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/case1");
    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap().flatten() {
            let d = to.join(e.file_name());
            if e.path().is_dir() {
                copy(&e.path(), &d);
            } else {
                std::fs::copy(e.path(), &d).unwrap();
            }
        }
    }
    copy(&src, dest);
}

fn fly(s: &mut Session) -> String {
    let cmd = Command::Simulate(rw_api::SimulateIn {
        sim: "simulation_5".into(),
        config: None,
        force: false,
        mc: None,
    });
    let Response::Simulate(o) = s.execute(&cmd, &ctx()).unwrap() else {
        unreachable!()
    };
    if let Some(j) = o.job_id.as_deref() {
        let job = s.jobs().wait(j, Duration::from_secs(120)).unwrap();
        assert_eq!(job.state, rw_api::JobState::Complete, "{:?}", job.error);
    }
    o.run_id
}

#[test]
fn runs_compare_as_their_steps_with_flight_metrics_first() {
    let d = TempDir::new("cmp-runs");
    case1(d.path());
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let a = fly(&mut s);
    patch(
        &mut s,
        vec![replace("/c/fins/span", json!("40 mm"))],
        "taller fins",
    );
    let b = fly(&mut s);
    assert_ne!(a, b);
    let c = compare(&mut s, &format!("run:{a}"), &format!("rw:run/{b}"));
    assert_eq!(c.metrics[0].key, "apogee_m");
    assert_eq!(c.metrics[0].unit.as_deref(), Some("m"));
    assert!(c.metrics.iter().any(|r| r.key == "stability.liftoff"));
    assert_eq!(c.model.changed.len(), 1);
    assert_eq!(c.model.changed[0].path, "/c/fins/span");
    assert_eq!(mark(&c, "fins").unwrap().status, MarkStatus::Changed);
    // A run against a step: no flight rows.
    let m = compare(&mut s, &format!("run:{a}"), "step:2");
    assert!(m.metrics.iter().all(|r| r.key != "apogee_m"));
    assert_eq!(m.model.changed.len(), 1);
}
