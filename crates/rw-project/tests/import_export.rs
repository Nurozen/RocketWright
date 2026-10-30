//! `import_file` / `export_file` through the session (M2.5, M2.6), on
//! RocketWright-authored `.ork` snippets.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::BTreeMap;

use rw_api::{
    CallCtx, Command, ExportFileIn, ExportFormat, ImportFileIn, ImportKind, Origin, Response,
};
use rw_model::MotorResolution;
use rw_project::container::{read_container, write_container};
use rw_project::create::import_project;
use rw_project::testutil::{TempDir, fixture_project};
use rw_project::{Session, SessionOptions};

const SIMPLE: &[u8] = include_bytes!("../../rw-ork/tests/data/simple.ork.xml");

fn ctx() -> CallCtx {
    CallCtx {
        origin: Origin::Cli,
        thread: None,
        tool_call: None,
        label: None,
    }
}

fn import(s: &mut Session, path: &str, dry_run: bool) -> rw_api::ImportOut {
    let cmd = Command::ImportFile(ImportFileIn {
        path: path.into(),
        kind: ImportKind::Ork,
        dry_run,
    });
    match s.execute(&cmd, &ctx()).unwrap() {
        Response::ImportFile(o) => o,
        other => panic!("{other:?}"),
    }
}

#[test]
fn import_into_a_new_directory_creates_a_clean_project() {
    let d = TempDir::new("ork-new");
    let src = d.path().join("bird.ork");
    // The zip form, as OpenRocket writes it.
    std::fs::write(&src, write_container(SIMPLE, &BTreeMap::new())).unwrap();
    let dir = d.path().join("proj");
    let dry = import_project(&dir, src.to_str().unwrap(), true, &ctx()).unwrap();
    assert!(dry.mutation.dry_run && !dir.exists());
    let out = import_project(&dir, src.to_str().unwrap(), false, &ctx()).unwrap();
    assert_eq!(out.mutation.model_hash, dry.mutation.model_hash);
    assert!(out.imported.contains(&"fins".to_string()));
    assert!(out.diagnostics.iter().any(|d| d.code == "RW-W103"));
    let s = Session::open(&dir, SessionOptions::read_only()).unwrap();
    let steps = s.steps().unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].title, "Import bird.ork");
    let errors: Vec<_> = s
        .report()
        .diagnostics
        .iter()
        .filter(|d| d.severity == rw_model::Severity::Error)
        .collect();
    assert!(errors.is_empty(), "{errors:#?}");
    assert!(
        s.report().diagnostics.iter().any(|d| d.code == "RW-W103"),
        "substituted motors are reported by the check"
    );
    assert!(dir.join("configs/cfg-a.rw.toml").is_file());
    assert!(dir.join("sims/calm_day.rw.toml").is_file());
    assert!(import_project(&dir, src.to_str().unwrap(), false, &ctx()).is_err());
}

#[test]
fn import_into_a_project_replaces_the_model_in_one_step() {
    let d = TempDir::new("ork-into");
    fixture_project(d.path());
    let src = d.path().join("bird.ork.xml");
    std::fs::write(&src, SIMPLE).unwrap();
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let before = s.steps().unwrap().len();
    let ids_before: Vec<String> = s.model().components.iter().map(|c| c.id.clone()).collect();
    let dry = import(&mut s, "bird.ork.xml", true);
    assert!(dry.mutation.dry_run);
    assert_eq!(s.steps().unwrap().len(), before, "dry run records nothing");
    let out = import(&mut s, "bird.ork.xml", false);
    assert_eq!(out.mutation.model_hash, dry.mutation.model_hash);
    assert_eq!(s.steps().unwrap().len(), before + 1);
    assert!(s.model().components.iter().any(|c| c.id == "fins"));
    for gone in ["nose", "body", "mount", "ring"] {
        assert!(ids_before.iter().any(|i| i == gone));
        assert!(!s.model().components.iter().any(|c| c.id == gone), "{gone}");
    }
    assert!(!d.path().join("parts/fin_can.rw.toml").exists());
    assert_eq!(s.model().config.as_deref(), Some("cfg-a"));
}

#[test]
fn embedded_curves_land_in_lib_with_recorded_hashes() {
    let d = TempDir::new("ork-embed");
    let rse = br#"<engine-database><engine-list>
<engine mfg="Testco" code="C6" Type="single" dia="18." len="70." initWt="24.0" propWt="12.3" delays="0,3,5,7" auto-calc-mass="0" auto-calc-cg="0" avgThrust="5.3" peakThrust="14.1" throatDia="0." exitDia="0." Itot="10.0" burn-time="1.86" massFrac="0" Isp="0" tDiv="10" tStep="-1." tFix="1" FDiv="10" FStep="-1." FFix="1" nameDivs="1">
<data><eng-data t="0." f="0." m="12.3" cg="35."/><eng-data t="0.2" f="14.1" m="11.5" cg="35."/><eng-data t="0.5" f="5.0" m="9.0" cg="35."/><eng-data t="1.86" f="0." m="0." cg="35."/></data>
</engine></engine-list></engine-database>"#;
    let mut files = BTreeMap::new();
    files.insert("thrustcurves/abc123.rse".to_string(), rse.to_vec());
    let src = d.path().join("bird.ork");
    std::fs::write(&src, write_container(SIMPLE, &files)).unwrap();
    let dir = d.path().join("p");
    import_project(&dir, src.to_str().unwrap(), false, &ctx()).unwrap();
    let s = Session::open(&dir, SessionOptions::read_only()).unwrap();
    assert!(
        !s.report()
            .diagnostics
            .iter()
            .any(|d| d.code == "RW-W003" || d.code == "RW-E006"),
        "{:#?}",
        s.report().diagnostics
    );
    let (m, _) = s.evaluated(Some("cfg-a")).unwrap();
    let mm = &m.configs["cfg-a"].motors[0];
    assert_eq!(
        mm.import.as_ref().map(|i| i.resolution),
        Some(MotorResolution::Embedded)
    );
    assert!(s.library().motor(mm.motor.as_deref().unwrap()).is_some());
}

#[test]
fn exports_write_every_format() {
    let d = TempDir::new("export");
    fixture_project(d.path());
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    for (format, path) in [
        (ExportFormat::Ork, "out/rocket.ork"),
        (ExportFormat::Rasp, "out/motors.eng"),
        (ExportFormat::Glb, "out/rocket.glb"),
        (ExportFormat::Stl, "out/rocket.stl"),
    ] {
        let cmd = Command::ExportFile(ExportFileIn {
            format,
            path: path.into(),
            config: None,
            run: None,
            allow_outside: false,
        });
        let Response::ExportFile(o) = s.execute(&cmd, &ctx()).unwrap() else {
            panic!()
        };
        assert_eq!(o.path, path);
        let bytes = std::fs::read(d.path().join(path)).unwrap();
        assert_eq!(o.bytes, bytes.len() as u64);
        assert!(o.bytes > 0, "{path}");
    }
    let ork = std::fs::read(d.path().join("out/rocket.ork")).unwrap();
    let files = read_container(&ork).unwrap();
    assert!(!files.files.is_empty(), "motor curves are embedded");
    let csv = Command::ExportFile(ExportFileIn {
        format: ExportFormat::Csv,
        path: "out/x.csv".into(),
        config: None,
        run: None,
        allow_outside: false,
    });
    assert!(s.execute(&csv, &ctx()).is_err(), "csv needs a run");
}

/// REV-core item 2: `export_file` stays inside the project unless the call
/// sets `allow_outside` (a gated MCP call).
#[test]
fn export_outside_the_project_needs_allow_outside() {
    let d = TempDir::new("export-contain");
    let root = d.path().join("p");
    std::fs::create_dir_all(&root).unwrap();
    fixture_project(&root);
    let mut s = Session::open(&root, SessionOptions::writer()).unwrap();
    let abs = d.path().join("abs.glb");
    let export = |s: &mut Session, v: serde_json::Value| {
        let i: ExportFileIn = serde_json::from_value(v).unwrap();
        s.execute(&Command::ExportFile(i), &ctx())
    };
    for path in [
        "../escape.glb".to_string(),
        "out/../../escape2.glb".to_string(),
        abs.display().to_string(),
    ] {
        let r = export(&mut s, serde_json::json!({"format": "glb", "path": path}));
        let e = r.expect_err(&path);
        assert_eq!(e.code, rw_api::ApiErrorCode::InvalidInput, "{path}: {e:?}");
        assert!(e.hint.unwrap_or_default().contains("allow_outside"));
    }
    assert!(!d.path().join("escape.glb").exists());
    assert!(!d.path().join("escape2.glb").exists());
    assert!(!abs.exists());
    // Absolute paths inside the project are fine.
    let inside = root.canonicalize().unwrap().join("out/in.glb");
    export(
        &mut s,
        serde_json::json!({"format": "glb", "path": inside.display().to_string()}),
    )
    .unwrap();
    assert!(inside.is_file());
    // Explicitly allowed.
    export(
        &mut s,
        serde_json::json!({"format": "glb", "path": abs.display().to_string(), "allow_outside": true}),
    )
    .unwrap();
    assert!(abs.is_file());
}
