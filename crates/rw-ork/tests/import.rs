//! `rw-ork` import tests on RocketWright-authored XML snippets (never the
//! real example files; those are read only under `make parity`).

use std::collections::BTreeMap;

use rw_model::{ComponentKind, ComponentType, DeployEvent, EvalOptions, MotorResolution, Severity};
use rw_ork::{CachedMotor, ImportOptions, MotorCache, MotorKey, OrkFiles, OrkImport, import};
use rw_units::QtyRaw;

/// A single-stage 24 mm rocket written for these tests.
const SIMPLE: &str = include_str!("data/simple.ork.xml");

const EMBEDDED_RSE: &str = r#"<engine-database>
 <engine-list>
  <engine mfg="Testco" code="C6" Type="single" dia="18." len="70." initWt="24.0" propWt="12.3" delays="0,3,5,7" auto-calc-mass="0" auto-calc-cg="0" avgThrust="5.3" peakThrust="14.1" throatDia="0." exitDia="0." Itot="10.0" burn-time="1.86" massFrac="0" Isp="0" tDiv="10" tStep="-1." tFix="1" FDiv="10" FStep="-1." FFix="1" nameDivs="1">
   <data>
    <eng-data t="0." f="0." m="12.3" cg="35."/>
    <eng-data t="0.2" f="14.1" m="11.5" cg="35."/>
    <eng-data t="0.5" f="5.0" m="9.0" cg="35."/>
    <eng-data t="1.86" f="0." m="0." cg="35."/>
   </data>
  </engine>
 </engine-list>
</engine-database>
"#;

fn files(xml: &str) -> OrkFiles {
    OrkFiles {
        xml: xml.as_bytes().to_vec(),
        files: BTreeMap::new(),
    }
}

fn text(q: &rw_units::Qty<impl rw_units::UnitDim>) -> String {
    match &q.raw {
        QtyRaw::Text(s) => s.clone(),
        QtyRaw::Number(n) => n.to_string(),
    }
}

fn eval(imp: &OrkImport, config: Option<&str>) -> rw_model::EvaluatedModel {
    rw_model::eval(
        &imp.source_set(None),
        &EvalOptions {
            config: config.map(str::to_string),
            ..EvalOptions::default()
        },
    )
}

fn simple() -> OrkImport {
    import(&files(SIMPLE), &ImportOptions::default()).expect("imports")
}

#[test]
fn components_get_slug_ids_uuids_and_types() {
    let imp = simple();
    let ids: Vec<&str> = imp.rocket.c.keys().map(String::as_str).collect();
    for id in [
        "nose_cone",
        "body_tube",
        "motor_mount_tube",
        "centering_ring",
        "chute",
        "altimeter",
        "fins",
        "launch_lug",
    ] {
        assert!(ids.contains(&id), "{id} in {ids:?}");
    }
    assert_eq!(
        imp.uuids.get("fins").map(String::as_str),
        Some("00000000-0000-4000-8000-000000000009")
    );
    let fins = &imp.rocket.c["fins"];
    assert_eq!(fins.kind.component_type(), ComponentType::TrapezoidalFinSet);
    assert_eq!(
        fins.import.as_ref().and_then(|i| i.uuid.as_deref()),
        Some("00000000-0000-4000-8000-000000000009")
    );
    assert_eq!(imp.name, "Test Bird");
    assert_eq!(imp.format_version.as_deref(), Some("1.9"));
}

#[test]
fn auto_radii_become_expressions() {
    let imp = simple();
    let ComponentKind::NoseCone(n) = &imp.rocket.c["nose_cone"].kind else {
        panic!()
    };
    assert_eq!(text(&n.od), "= c.body_tube.od");
    let ComponentKind::CenteringRing(r) = &imp.rocket.c["centering_ring"].kind else {
        panic!()
    };
    assert!(r.od.is_none(), "an auto outer radius is the parent's bore");
    assert_eq!(text(&r.id), "= c.motor_mount_tube.od");
}

#[test]
fn placement_becomes_attach_with_offsets() {
    let imp = simple();
    let body = imp.rocket.c["body_tube"].attach.as_ref().unwrap();
    assert_eq!(body.to, "nose_cone.base");
    let mmt = imp.rocket.c["motor_mount_tube"].attach.as_ref().unwrap();
    assert_eq!(
        (mmt.to.as_str(), mmt.at.as_deref()),
        ("body_tube.aft", Some("aft"))
    );
    let chute = imp.rocket.c["chute"].attach.as_ref().unwrap();
    assert_eq!(chute.to, "body_tube.fore");
    assert_eq!(chute.offset.as_ref().map(text).as_deref(), Some("30 mm"));
    let ring = imp.rocket.c["centering_ring"].attach.as_ref().unwrap();
    assert_eq!(ring.to, "body_tube.aft");
    assert_eq!(ring.offset.as_ref().map(text).as_deref(), Some("-10 mm"));
    let lug = imp.rocket.c["launch_lug"].attach.as_ref().unwrap();
    assert!(lug.spin.is_some(), "radial direction becomes spin");
}

#[test]
fn imported_model_evaluates_to_the_file_stations() {
    let imp = simple();
    let m = eval(&imp, None);
    let errors: Vec<_> = m
        .diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    assert!(errors.is_empty(), "{errors:#?}");
    let c = |id: &str| m.components.iter().find(|c| c.id == id).unwrap();
    let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
    assert!(close(c("body_tube").x_fore, 0.1));
    assert!(close(c("motor_mount_tube").x_fore, 0.4 - 0.07));
    assert!(close(c("centering_ring").x_fore, 0.4 - 0.005 - 0.01));
    assert!(close(c("chute").x_fore, 0.13));
    assert!(close(c("altimeter").x_fore, 0.1 + (0.3 - 0.02) / 2.0));
    assert!(close(c("fins").x_fore, 0.4 - 0.06));
    assert!(close(c("launch_lug").x_fore, 0.1 + (0.3 - 0.03) / 2.0));
}

#[test]
fn materials_finish_and_appearance_map() {
    let imp = simple();
    assert!(imp.rocket.materials.contains_key("cardboard"));
    assert!(imp.rocket.materials.contains_key("ripstop_nylon"));
    let nose = &imp.rocket.c["nose_cone"];
    assert_eq!(nose.material.as_deref(), Some("polystyrene"));
    assert_eq!(
        nose.appearance.as_ref().and_then(|a| a.color.as_deref()),
        Some("#ff0000")
    );
    assert!(nose.finish.is_some());
    let ComponentKind::Parachute(p) = &imp.rocket.c["chute"].kind else {
        panic!()
    };
    assert_eq!(p.line_material.as_deref(), Some("elastic_cord"));
}

#[test]
fn configs_and_sims_import() {
    let imp = simple();
    assert_eq!(imp.default_config.as_deref(), Some("cfg-a"));
    assert_eq!(imp.configs["cfg-a"].name.as_deref(), Some("Small"));
    assert_eq!(imp.configs["cfg-b"].name.as_deref(), Some("[D12-P]"));
    let b = &imp.configs["cfg-b"];
    assert_eq!(b.deploy["chute"].event, DeployEvent::Altitude);
    assert_eq!(
        imp.configs["cfg-a"].deploy["chute"].event,
        DeployEvent::Ejection
    );
    let sim = &imp.sims["calm_day"];
    assert_eq!(sim.config, "cfg-a");
    let launch = sim.launch.as_ref().unwrap();
    assert_eq!(text(&launch.rail_length), "1 m");
    assert_eq!(text(&sim.wind.as_ref().unwrap().speed), "2 m/s");
    // OpenRocket writes the wind direction in radians.
    let dir = sim.wind.as_ref().unwrap().direction.as_ref().unwrap();
    assert_eq!(text(dir), "90 deg");
}

#[test]
fn motors_without_curves_are_substituted_with_a_diagnostic() {
    let imp = simple();
    assert!(imp.lib_files.is_empty());
    assert!(
        imp.motors
            .iter()
            .all(|m| m.resolution == MotorResolution::Substituted)
    );
    let a = &imp.configs["cfg-a"].motors["motor_mount_tube"];
    assert!(a.motor.as_deref().unwrap().starts_with("generic:"));
    assert_eq!(
        a.import.as_ref().map(|i| i.resolution),
        Some(MotorResolution::Substituted)
    );
    assert_eq!(
        imp.diagnostics
            .iter()
            .filter(|d| d.code == "RW-W103")
            .count(),
        2
    );
    // The substitute evaluates and resolves.
    let m = eval(&imp, Some("cfg-a"));
    assert!(m.configs["cfg-a"].motors[0].motor.is_some());
}

#[test]
fn embedded_curves_are_used_in_place() {
    let mut f = files(SIMPLE);
    f.files.insert(
        "thrustcurves/abc123.rse".into(),
        EMBEDDED_RSE.as_bytes().to_vec(),
    );
    let imp = import(&f, &ImportOptions::default()).unwrap();
    let a = &imp.configs["cfg-a"].motors["motor_mount_tube"];
    assert_eq!(
        a.import.as_ref().map(|i| i.resolution),
        Some(MotorResolution::Embedded)
    );
    let r = a.motor.as_deref().unwrap();
    assert!(r.starts_with("lib:motors/"), "{r}");
    assert_eq!(imp.lib_files.len(), 1);
    let (path, bytes) = imp.lib_files.iter().next().unwrap();
    assert!(r.contains(path.trim_start_matches("lib/")));
    assert_eq!(bytes, EMBEDDED_RSE.as_bytes());
}

struct OneCurve;

impl MotorCache for OneCurve {
    fn lookup(&self, key: &MotorKey) -> Option<CachedMotor> {
        (key.designation == "D12").then(|| CachedMotor {
            file_name: "Nobody_D12.eng".into(),
            bytes: b"; test curve\nD12 24 70 0-3-5 0.021 0.043 Nobody\n0.1 20\n0.5 10\n1.6 0\n;\n"
                .to_vec(),
        })
    }
}

#[test]
fn a_cache_hit_is_used_before_a_substitute() {
    let imp = import(&files(SIMPLE), &ImportOptions { cache: &OneCurve }).unwrap();
    let b = &imp.configs["cfg-b"].motors["motor_mount_tube"];
    assert_eq!(
        b.import.as_ref().map(|i| i.resolution),
        Some(MotorResolution::Cache)
    );
    assert!(b.motor.as_deref().unwrap().ends_with("#D12"));
    assert!(imp.lib_files.keys().any(|p| p.ends_with(".eng")));
}

#[test]
fn stored_flight_data_is_skipped_and_non_ork_rejected() {
    assert!(import(&files("<rocket/>"), &ImportOptions::default()).is_err());
    assert!(import(&files("not xml <"), &ImportOptions::default()).is_err());
}

/// Two stages, a transition, a cluster, and an unknown component.
const TWO_STAGE: &str = include_str!("data/two_stage.ork.xml");

#[test]
fn stages_transitions_clusters_and_skips() {
    let imp = import(&files(TWO_STAGE), &ImportOptions::default()).unwrap();
    assert_eq!(imp.rocket.stage.len(), 2);
    assert_eq!(imp.rocket.stage["booster"].first, "interstage");
    let ComponentKind::Transition(t) = &imp.rocket.c["interstage"].kind else {
        panic!()
    };
    assert_eq!(text(&t.fore_od), "= c.nose.od");
    let ComponentKind::BodyTube(u) = &imp.rocket.c["upper"].kind else {
        panic!()
    };
    assert_eq!(text(&u.od), "= c.nose.od");
    let mounts = imp.rocket.c["booster_mounts"].instances.as_ref().unwrap();
    assert_eq!(mounts.count, 3);
    assert!(
        imp.diagnostics
            .iter()
            .any(|d| d.code == "RW-W010" && d.message.contains("Pods"))
    );
    let c1 = &imp.configs["c1"];
    assert_eq!(c1.motors.len(), 2);
    assert!(c1.stages.contains_key("booster"));
    let m = eval(&imp, None);
    let errors: Vec<_> = m
        .diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    assert!(errors.is_empty(), "{errors:#?}");
    let lower = m.components.iter().find(|c| c.id == "lower").unwrap();
    assert!((lower.x_fore - 0.5).abs() < 1e-9);
}
