use super::*;
use crate::testutil::{TempDir, fixture_project};
use std::sync::atomic::{AtomicUsize, Ordering};

fn ctx(origin: Origin) -> CallCtx {
    CallCtx {
        origin,
        thread: Some("t1".into()),
        tool_call: Some("tc1".into()),
        label: None,
    }
}

fn project(tag: &str) -> TempDir {
    let d = TempDir::new(tag);
    fixture_project(d.path());
    d
}

fn replace(path: &str, v: &str) -> PatchOp {
    PatchOp::Replace {
        path: path.into(),
        value: Value::String(v.into()),
    }
}

fn read(d: &TempDir, rel: &str) -> String {
    std::fs::read_to_string(d.path().join(rel)).unwrap()
}

/// Every file under the project except `.rw/lock` → (len, mtime).
fn tree_state(root: &Path) -> BTreeMap<String, (u64, std::time::SystemTime)> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, (u64, std::time::SystemTime)>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let e = e.unwrap();
            let p = e.path();
            if e.file_type().unwrap().is_dir() {
                walk(root, &p, out);
            } else {
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                if rel == ".rw/lock" {
                    continue;
                }
                let m = e.metadata().unwrap();
                out.insert(rel, (m.len(), m.modified().unwrap()));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

#[test]
fn open_records_an_initial_snapshot_once() {
    let d = project("sess-open");
    let s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let steps = s.steps().unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].title, "Initial snapshot");
    assert_eq!(steps[0].origin, Origin::Watcher);
    assert_eq!(steps[0].files.len(), 5);
    assert_eq!(steps[0].model_hash, s.model().model_hash);
    drop(s);
    // Re-opening an unchanged project adds nothing (D3 tree dedupe).
    let s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    assert_eq!(s.steps().unwrap().len(), 1);
}

#[test]
fn snapshot_title_names_the_step_recorded_on_open() {
    let d = project("sess-snap-title");
    let opts = || SessionOptions::writer().with_snapshot_title(Some("Initial concept\nx".into()));
    let s = Session::open(d.path(), opts()).unwrap();
    let steps = s.steps().unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].title, "Initial concept");
    drop(s);
    // Nothing unrecorded: the title names no step.
    let s = Session::open(d.path(), opts()).unwrap();
    assert_eq!(s.steps().unwrap().len(), 1);
    drop(s);
    // A blank title means the default (`External edit` for an edit made while no owner ran).
    let mut text = std::fs::read_to_string(d.path().join("rocketwright.toml")).unwrap();
    text.push_str("\n# edited\n");
    std::fs::write(d.path().join("rocketwright.toml"), text).unwrap();
    let s = Session::open(
        d.path(),
        SessionOptions::writer().with_snapshot_title(Some("  ".into())),
    )
    .unwrap();
    let steps = s.steps().unwrap();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[1].title, "External edit");
}

#[test]
fn patch_writes_atomically_records_a_step_and_returns_the_delta() {
    let d = project("sess-patch");
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let before = s.model().model_hash.clone();
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev = events.clone();
    s.on_event(move |e| ev.lock().unwrap().push(e.clone()));

    let out = s
        .patch(
            &[replace("/params/span/value", "60 mm")],
            false,
            &ctx(Origin::Mcp),
            "model_patch",
            "Fin span 60 mm".into(),
        )
        .unwrap();
    assert_eq!(out.step.as_deref(), Some("step:2"));
    assert!(!out.dry_run);
    assert_eq!(
        out.files,
        vec![FileChange {
            path: "rocket.rw.toml".into(),
            status: FileStatus::M
        }]
    );
    assert_ne!(out.model_hash, before);
    assert_eq!(out.model_hash, s.model().model_hash);
    assert_eq!(out.delta.model_hash, out.model_hash);
    assert_eq!(out.delta.step.as_deref(), Some("step:2"));
    // The real static check (rw_check): a longer fin moves the CP aft and
    // raises the margin; the delta is `CheckDelta::between`.
    let before_report = s.report().clone();
    assert!(before_report.mass.liftoff > 0.0 && before_report.aero.cp > 0.0);
    let [cp0, cp1] = out.delta.changed["aero.cp"];
    assert!(cp1.unwrap() > cp0.unwrap(), "{:?}", out.delta.changed);
    let [m0, m1] = out.delta.changed["stability.liftoff"];
    assert!(m1.unwrap() > m0.unwrap());
    assert!(out.delta.changed.contains_key("dims.fin_span"));
    assert!(!out.delta.changed.contains_key("dims.length"));
    // Comments survive (M1.25 store) and the disk matches the store.
    let text = read(&d, "rocket.rw.toml");
    assert!(text.contains("value = \"60 mm\"   # nominal"), "{text}");
    assert!(text.contains("# The nose: printed PLA, keep this comment."));
    assert_eq!(s.files().files["rocket.rw.toml"], text);
    // No temp files left in the project.
    assert!(
        tree_state(d.path())
            .keys()
            .all(|k| !fsutil::is_temp_name(k)),
        "{:?}",
        tree_state(d.path()).keys()
    );

    let steps = s.steps().unwrap();
    assert_eq!(steps.len(), 2);
    let st = &steps[1];
    assert_eq!(st.seq, 2);
    assert_eq!(st.origin, Origin::Mcp);
    assert_eq!(st.thread.as_deref(), Some("t1"));
    assert_eq!(st.tool.as_deref(), Some("model_patch"));
    assert_eq!(st.tool_call.as_deref(), Some("tc1"));
    assert_eq!(st.title, "Fin span 60 mm");
    assert_eq!(st.prev.as_deref(), Some(steps[0].id.as_str()));
    assert_eq!(st.model_hash, out.model_hash);
    let r = s.report();
    assert_eq!(st.metrics.mass_liftoff, Some(r.mass.liftoff));
    assert_eq!(st.metrics.stability_liftoff, Some(r.stability.liftoff));
    assert_eq!(st.metrics.apogee_m, None);

    let evs = events.lock().unwrap();
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].uris, MUTATION_URIS.to_vec());
    assert_eq!(evs[0].step.as_ref().map(|s| s.seq), Some(2));
}

#[test]
fn dry_run_writes_nothing() {
    let d = project("sess-dry");
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let events = Arc::new(AtomicUsize::new(0));
    let ev = events.clone();
    s.on_event(move |_| {
        ev.fetch_add(1, Ordering::SeqCst);
    });
    let hash = s.model().model_hash.clone();
    let state = tree_state(d.path());
    // Coarse mtime filesystems: make any write visible.
    std::thread::sleep(std::time::Duration::from_millis(20));
    let out = s
        .patch(
            &[replace("/params/span/value", "70 mm")],
            true,
            &ctx(Origin::Mcp),
            "model_patch",
            "x".into(),
        )
        .unwrap();
    assert!(out.dry_run);
    assert_eq!(out.step, None);
    assert_eq!(out.files.len(), 1, "a dry run reports what it would write");
    assert_ne!(out.model_hash, hash, "the delta is for the would-be model");
    assert_eq!(out.delta.step, None);
    assert_eq!(
        tree_state(d.path()),
        state,
        "no file, mtime, or history change"
    );
    assert_eq!(s.model().model_hash, hash);
    assert_eq!(s.steps().unwrap().len(), 1);
    assert_eq!(events.load(Ordering::SeqCst), 0);
}

#[test]
fn no_op_patch_records_no_step() {
    let d = project("sess-noop");
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let out = s
        .patch(
            &[replace("/params/span/value", "50 mm")],
            false,
            &ctx(Origin::Cli),
            "model_patch",
            "same".into(),
        )
        .unwrap();
    assert_eq!(out.step, None);
    assert!(out.files.is_empty());
    assert_eq!(s.steps().unwrap().len(), 1);
}

#[test]
fn delta_carries_new_and_resolved_diagnostics() {
    let d = project("sess-diag");
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    assert!(s.model().diagnostics.iter().all(|d| d.code != "RW-E061"));
    let bad = s
        .patch(
            &[replace("/c/body/id", "50 mm")],
            false,
            &ctx(Origin::Mcp),
            "model_patch",
            "bad".into(),
        )
        .unwrap();
    assert!(
        !bad.delta.new_diagnostics.is_empty(),
        "an inner diameter above the outer is diagnosed: {:?}",
        bad.delta
    );
    assert_eq!(bad.delta.status, rw_check::CheckStatus::Errors);
    let keys: Vec<String> = bad
        .delta
        .new_diagnostics
        .iter()
        .map(Diagnostic::key)
        .collect();
    let good = s
        .patch(
            &[replace("/c/body/id", "39.8 mm")],
            false,
            &ctx(Origin::Mcp),
            "model_patch",
            "fix".into(),
        )
        .unwrap();
    for k in keys {
        assert!(good.delta.resolved_diagnostics.contains(&k), "{k}");
    }
}

#[test]
fn invalid_patch_is_rejected_and_writes_nothing() {
    let d = project("sess-bad");
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let state = tree_state(d.path());
    let e = s
        .patch(
            &[PatchOp::Remove {
                path: "/c/nope".into(),
            }],
            false,
            &ctx(Origin::Mcp),
            "model_patch",
            "x".into(),
        )
        .unwrap_err();
    assert_eq!(e.code, ApiErrorCode::InvalidInput);
    assert!(e.message.contains("/c/nope"), "{}", e.message);
    assert_eq!(tree_state(d.path()), state);
}

#[test]
fn component_add_remove_move() {
    let d = project("sess-comp");
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let c = ctx(Origin::Cli);
    let lug: rw_model::Component = serde_json::from_value(serde_json::json!({
        "type": "launch_lug",
        "attach": {"to": "body.outer", "offset": "100 mm"},
        "length": "30 mm",
        "od": "5 mm",
        "id": "4 mm"
    }))
    .unwrap();
    let add = Command::ComponentAdd(ComponentAddIn {
        id: "lug".into(),
        component: lug.clone(),
        dry_run: false,
    });
    let r = s.execute(&add, &c).unwrap();
    let Response::ComponentAdd(out) = r else {
        panic!()
    };
    assert_eq!(out.step.as_deref(), Some("step:2"));
    assert!(read(&d, "rocket.rw.toml").contains("[c.lug]"));
    assert_eq!(
        s.execute(&add, &c).unwrap_err().code,
        ApiErrorCode::Conflict
    );

    let rm = |recursive| {
        Command::ComponentRemove(ComponentRemoveIn {
            id: "body".into(),
            recursive,
            dry_run: false,
        })
    };
    let e = s.execute(&rm(false), &c).unwrap_err();
    assert_eq!(e.code, ApiErrorCode::Conflict);
    assert!(e.message.contains("fins"), "{}", e.message);

    let mv = Command::ComponentMove(ComponentMoveIn {
        id: "lug".into(),
        attach: serde_json::from_value(serde_json::json!({"to": "body.outer", "offset": "120 mm"}))
            .unwrap(),
        dry_run: false,
    });
    let Response::ComponentMove(out) = s.execute(&mv, &c).unwrap() else {
        panic!()
    };
    assert_eq!(out.step.as_deref(), Some("step:3"));
    assert!(read(&d, "rocket.rw.toml").contains("120 mm"));

    let Response::ComponentRemove(out) = s.execute(&rm(true), &c).unwrap() else {
        panic!()
    };
    assert_eq!(out.step.as_deref(), Some("step:4"));
    let paths: Vec<&str> = out.files.iter().map(|f| f.path.as_str()).collect();
    assert!(
        paths.contains(&"rocket.rw.toml") && paths.contains(&"parts/fin_can.rw.toml"),
        "{paths:?}"
    );
    let rocket = read(&d, "rocket.rw.toml");
    assert!(
        !rocket.contains("[c.body]")
            && !rocket.contains("[c.lug]")
            && !rocket.contains("[c.chute]")
    );
    assert!(!read(&d, "parts/fin_can.rw.toml").contains("[c.fins]"));
    assert!(rocket.contains("[c.nose]"));
}

#[test]
fn model_get_reads_live_paths_and_versions() {
    let d = project("sess-get");
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let c = ctx(Origin::Mcp);
    let get = |s: &mut Session, path: Option<&str>, version: Option<&str>| {
        let cmd = Command::ModelGet(ModelGetIn {
            path: path.map(String::from),
            version: version.map(String::from),
            config: None,
            variant: None,
        });
        match s.execute(&cmd, &c) {
            Ok(Response::ModelGet(o)) => Ok(o),
            Ok(_) => panic!(),
            Err(e) => Err(e),
        }
    };
    let whole = get(&mut s, None, None).unwrap();
    assert_eq!(whole.model.as_ref().unwrap().model_hash, whole.model_hash);
    let v1 = get(&mut s, Some("/params/span/value"), None).unwrap();
    assert!((v1.value.unwrap().as_f64().unwrap() - 0.05).abs() < 1e-12);
    s.patch(
        &[replace("/params/span/value", "60 mm")],
        false,
        &c,
        "model_patch",
        "x".into(),
    )
    .unwrap();
    let live = get(&mut s, Some("/params/span/value"), Some("live")).unwrap();
    assert!((live.value.unwrap().as_f64().unwrap() - 0.06).abs() < 1e-12);
    let old = get(&mut s, Some("/params/span/value"), Some("step:1")).unwrap();
    assert!((old.value.unwrap().as_f64().unwrap() - 0.05).abs() < 1e-12);
    assert_eq!(old.model_hash, whole.model_hash);
    assert_eq!(
        get(&mut s, Some("/nope"), None).unwrap_err().code,
        ApiErrorCode::NotFound
    );
    assert_eq!(
        get(&mut s, None, Some("step:99")).unwrap_err().code,
        ApiErrorCode::NotFound
    );
    // execute_json matches the output schema shape.
    let v = s
        .execute_json(&Command::ModelGet(ModelGetIn::default()), &c)
        .unwrap();
    assert_eq!(v["model_hash"], s.model().model_hash.as_str());
    let def = rw_api::command_def("model_get").unwrap();
    (def.check_output)(&v).unwrap();
}

#[test]
fn single_writer_and_read_only_sessions() {
    let d = project("sess-lock");
    let _w = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let e = Session::open(d.path(), SessionOptions::writer()).unwrap_err();
    assert_eq!(e.code, ApiErrorCode::Locked);
    assert_eq!(e.diagnostics[0].code, "RW-E007");
    assert!(
        e.message
            .contains(&format!("locked-by {}", std::process::id())),
        "{}",
        e.message
    );
    // Readers need no lock and refuse writes.
    let mut r = Session::open(d.path(), SessionOptions::read_only()).unwrap();
    assert_eq!(r.steps().unwrap().len(), 1, "readers see history");
    let e = r
        .patch(
            &[replace("/params/span/value", "60 mm")],
            false,
            &ctx(Origin::Cli),
            "model_patch",
            "x".into(),
        )
        .unwrap_err();
    assert_eq!(e.code, ApiErrorCode::Locked);
    // A dry run is fine without the lock.
    let out = r
        .patch(
            &[replace("/params/span/value", "60 mm")],
            true,
            &ctx(Origin::Cli),
            "model_patch",
            "x".into(),
        )
        .unwrap();
    assert!(out.dry_run);
}

#[test]
fn not_a_project_is_not_found() {
    let d = TempDir::new("sess-empty");
    let e = Session::open(d.path(), SessionOptions::read_only()).unwrap_err();
    assert_eq!(e.code, ApiErrorCode::NotFound);
    assert!(e.hint.unwrap().contains("rw init"));
}

#[test]
fn external_edits_parse_errors_and_own_writes() {
    let d = project("sess-sync");
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let c = ctx(Origin::Cli);
    // Own write: the watcher echo is a no-op.
    s.patch(
        &[replace("/params/span/value", "60 mm")],
        false,
        &c,
        "model_patch",
        "x".into(),
    )
    .unwrap();
    assert_eq!(
        s.sync_from_disk(Origin::Watcher).unwrap(),
        SyncOutcome::Unchanged
    );
    assert_eq!(s.steps().unwrap().len(), 2);

    // A half-written file: last good model kept, RW-E001 reported.
    let good_hash = s.model().model_hash.clone();
    let path = d.path().join("rocket.rw.toml");
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, &text[..text.len() / 2]).unwrap();
    match s.sync_from_disk(Origin::Watcher).unwrap() {
        SyncOutcome::ParseError(ds) => assert!(
            ds.iter()
                .any(|d| d.code == "RW-E001" || d.code == "RW-E002"),
            "{ds:?}"
        ),
        o => panic!("{o:?}"),
    }
    assert_eq!(s.model().model_hash, good_hash, "last good model");
    assert!(
        s.report()
            .diagnostics
            .iter()
            .any(|d| d.file.as_deref() == Some("rocket.rw.toml"))
    );
    assert_eq!(s.report().status, rw_check::CheckStatus::Errors);
    assert_eq!(s.steps().unwrap().len(), 2, "no step for a broken file");

    // Finished edit: applied, one external step.
    let edited = text.replace("\"60 mm\"", "\"65 mm\"");
    std::fs::write(&path, &edited).unwrap();
    let SyncOutcome::Applied(Some(step)) = s.sync_from_disk(Origin::Watcher).unwrap() else {
        panic!()
    };
    assert_eq!(step.origin, Origin::Watcher);
    assert_eq!(step.title, "Edited rocket.rw.toml");
    assert_eq!(step.files.len(), 1);
    assert!(s.report().diagnostics.iter().all(|d| d.code != "RW-E001"));
    assert_ne!(s.model().model_hash, good_hash);
    // Replays change nothing.
    assert_eq!(
        s.sync_from_disk(Origin::Watcher).unwrap(),
        SyncOutcome::Unchanged
    );
    assert_eq!(s.steps().unwrap().len(), 3);
}

#[test]
fn a_file_changed_within_the_quiet_window_is_left_for_later() {
    let d = project("sess-quiet");
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let good = s.model().model_hash.clone();
    let quiet = Duration::from_secs(3600);
    // An in-place save caught between its truncate and its write: the empty
    // file parses, but it was modified just now, so it is not read yet.
    let path = d.path().join("rocket.rw.toml");
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, "").unwrap();
    let (o, wait) = s.sync_settled(Origin::Watcher, quiet).unwrap();
    assert_eq!(o, SyncOutcome::Unchanged);
    assert!(
        wait.is_some_and(|w| w > quiet - Duration::from_secs(60) && w <= quiet),
        "{wait:?}"
    );
    assert_eq!(s.model().model_hash, good);
    assert_eq!(s.steps().unwrap().len(), 1);
    // The save completes; once the file has been quiet for the window, the
    // next sync applies it as one step.
    let edited = text.replace("\"50 mm\"", "\"57 mm\"");
    std::fs::write(&path, &edited).unwrap();
    let past = std::time::SystemTime::now() - 2 * quiet;
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(past)
        .unwrap();
    let (o, wait) = s.sync_settled(Origin::Watcher, quiet).unwrap();
    assert!(matches!(o, SyncOutcome::Applied(Some(_))), "{o:?}");
    assert_eq!(wait, None);
    assert_ne!(s.model().model_hash, good);
    assert_eq!(s.steps().unwrap().len(), 2);
}

#[test]
fn validate_and_design_check() {
    let d = project("sess-validate");
    let mut s = Session::open(d.path(), SessionOptions::read_only()).unwrap();
    let c = ctx(Origin::Cli);
    let Response::ProjectValidate(v) = s
        .execute(&Command::ProjectValidate(ProjectValidateIn::default()), &c)
        .unwrap()
    else {
        panic!()
    };
    assert!(v.ok, "{:?}", v.diagnostics);
    assert_eq!(v.files.len(), 5);
    let Response::DesignCheck(r) = s
        .execute(&Command::DesignCheck(DesignCheckIn::default()), &c)
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(r.model_hash, s.model().model_hash);
    assert!(r.inputs.contains_key("rocket.rw.toml"));
    assert_eq!(r, s.report().clone());
    assert_eq!(
        s.read_resource(URI_CHECK).unwrap(),
        serde_json::to_value(s.report()).unwrap()
    );
    assert_eq!(
        s.execute(
            &Command::JobStatus(rw_api::JobRef { job_id: "j".into() }),
            &c
        )
        .unwrap_err()
        .code,
        ApiErrorCode::NotFound
    );
    assert_eq!(
        s.execute(
            &Command::ImportFile(rw_api::ImportFileIn {
                path: "x.ork".into(),
                kind: rw_api::ImportKind::Ork,
                dry_run: true
            }),
            &c
        )
        .unwrap_err()
        .code,
        ApiErrorCode::Io
    );
}

// ---- REV-core (final review) -------------------------------------------------

/// Item 1: an editor undo back to tool-written content is adopted, not
/// skipped as an own-write echo.
#[test]
fn editor_undo_back_to_a_tool_write_is_adopted() {
    let d = project("sess-undo");
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    s.patch(
        &[replace("/params/span/value", "60 mm")],
        false,
        &ctx(Origin::Mcp),
        "model_patch",
        "x".into(),
    )
    .unwrap();
    let path = d.path().join("rocket.rw.toml");
    let a = std::fs::read_to_string(&path).unwrap();
    let a_hash = s.model().model_hash.clone();
    // The echo of the tool write is a no-op.
    assert_eq!(
        s.sync_from_disk(Origin::Watcher).unwrap(),
        SyncOutcome::Unchanged
    );
    // Editor saves B.
    std::fs::write(&path, a.replace("\"60 mm\"", "\"65 mm\"")).unwrap();
    assert!(matches!(
        s.sync_from_disk(Origin::Watcher).unwrap(),
        SyncOutcome::Applied(_)
    ));
    assert_ne!(s.model().model_hash, a_hash);
    // Editor undoes back to A: adopted.
    std::fs::write(&path, &a).unwrap();
    assert!(
        matches!(
            s.sync_from_disk(Origin::Watcher).unwrap(),
            SyncOutcome::Applied(_)
        ),
        "the undo back to A is an external edit"
    );
    assert_eq!(s.model().model_hash, a_hash);
    // A later tool write starts from A, not B.
    s.patch(
        &[replace("/params/span/value", "70 mm")],
        false,
        &ctx(Origin::Mcp),
        "model_patch",
        "y".into(),
    )
    .unwrap();
    let after = read(&d, "rocket.rw.toml");
    assert!(after.contains("value = \"70 mm\""), "{after}");
    assert!(!after.contains("65 mm"), "B came back: {after}");
}

/// A crafted commit in `.rw/history.git` whose root tree holds `entries`
/// (`(name, Some(subtree name))` nests one blob under a tree), bypassing the
/// history API: a shared project's tampered store. Returns `commit:<sha>`.
fn craft_commit(root: &Path, entries: &[(&str, Option<&str>)]) -> String {
    use gix::objs::{Tree, tree};
    let repo = gix::open_opts(
        root.join(crate::history::HISTORY_GIT),
        gix::open::Options::isolated(),
    )
    .unwrap();
    let blob = repo.write_blob(b"# pwned\n").unwrap().detach();
    let mut top = Vec::new();
    for (name, sub) in entries {
        let (mode, oid) = match sub {
            None => (tree::EntryKind::Blob, blob),
            Some(leaf) => {
                let t = Tree {
                    entries: vec![tree::Entry {
                        mode: tree::EntryKind::Blob.into(),
                        filename: (*leaf).into(),
                        oid: blob,
                    }],
                };
                (
                    tree::EntryKind::Tree,
                    repo.write_object(&t).unwrap().detach(),
                )
            }
        };
        top.push(tree::Entry {
            mode: mode.into(),
            filename: (*name).into(),
            oid,
        });
    }
    let t = repo.write_object(&Tree { entries: top }).unwrap().detach();
    let sig = gix::actor::Signature {
        name: "x".into(),
        email: "x@localhost".into(),
        time: gix::date::Time::new(1, 0),
    };
    let mut buf = gix::date::parse::TimeBuf::default();
    let sref = sig.to_ref(&mut buf);
    let id = repo
        .commit_as(
            sref,
            sref,
            format!("refs/rw/crafted/{t}").as_str(),
            "crafted",
            t,
            None::<gix::ObjectId>,
        )
        .unwrap();
    format!("commit:{id}")
}

/// Item 2b: a snapshot entry that is absolute or climbs out of the project
/// is rejected by `history_restore`; nothing is written outside.
#[test]
fn history_restore_rejects_paths_outside_the_project() {
    let outer = TempDir::new("sess-restore-escape");
    let root = outer.path().join("p");
    std::fs::create_dir_all(&root).unwrap();
    fixture_project(&root);
    let mut s = Session::open(&root, SessionOptions::writer()).unwrap();
    let parent = outer.path().to_path_buf();
    let abs_dir = parent.join("rw-abs-escape");
    let abs_leaf = format!("{}/x.rw.toml", abs_dir.display());
    let cases: Vec<Vec<(&str, Option<&str>)>> = vec![
        vec![("..", Some("escape.rw.toml"))],
        vec![("../escape2.rw.toml", None)],
        vec![("", Some(abs_leaf.trim_start_matches('/')))],
    ];
    for entries in &cases {
        let v = craft_commit(&root, entries);
        let r = s.history_restore(&v, false, &ctx(Origin::Mcp));
        let e = r.expect_err(&format!("{entries:?}"));
        assert_eq!(e.code, ApiErrorCode::InvalidInput, "{e:?}");
    }
    assert!(!parent.join("escape.rw.toml").exists());
    assert!(!parent.join("escape2.rw.toml").exists());
    assert!(!abs_dir.exists());
    // The session-level guard holds even for a snapshot from elsewhere.
    let mut writes = vec![("../escape3.rw.toml".to_string(), Some("x".to_string()))];
    let e = s
        .commit(
            s.store.clone(),
            std::mem::take(&mut writes),
            false,
            &ctx(Origin::Mcp),
            None,
            "x".into(),
        )
        .unwrap_err();
    assert_eq!(e.code, ApiErrorCode::InvalidInput);
    assert!(!parent.join("escape3.rw.toml").exists());
}

/// Item 5: restoring the last good version repairs a corrupted file on
/// disk even though the session still knows its last good text.
#[test]
fn history_restore_repairs_a_corrupted_file() {
    let d = project("sess-restore-repair");
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let path = d.path().join("rocket.rw.toml");
    let good = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, &good[..good.len() / 2]).unwrap();
    assert!(matches!(
        s.sync_from_disk(Origin::Watcher).unwrap(),
        SyncOutcome::ParseError(_)
    ));
    let out = s
        .history_restore("step:1", false, &ctx(Origin::Mcp))
        .unwrap();
    assert!(!out.files.is_empty(), "{out:?}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), good);
    assert!(
        s.report()
            .diagnostics
            .iter()
            .all(|d| d.code != "RW-E001" && d.code != "RW-E002")
    );
}

#[test]
fn prune_outputs_keeps_the_newest_per_prefix() {
    let d = project("sess-prune");
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    // Nothing stored yet: nothing to prune.
    assert!(
        s.prune_outputs("renders/window", "plot_render.", 2)
            .unwrap()
            .is_empty()
    );
    let files: Vec<(String, Vec<u8>)> = (0..4)
        .map(|i| (format!("renders/window/plot_render.{i}.png"), vec![i]))
        .chain([("renders/window/viewport_render.0.png".to_string(), vec![9])])
        .collect();
    s.write_outputs(&files).unwrap();
    // Oldest first: plot_render.0 .. plot_render.3, an hour apart.
    let base = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_800_000_000);
    for i in 0..4u64 {
        let f = std::fs::File::options()
            .write(true)
            .open(d.path().join(format!("renders/window/plot_render.{i}.png")))
            .unwrap();
        f.set_modified(base + std::time::Duration::from_secs(3600 * i))
            .unwrap();
    }
    let removed = s
        .prune_outputs("renders/window", "plot_render.", 2)
        .unwrap();
    assert_eq!(
        removed,
        [
            "renders/window/plot_render.1.png",
            "renders/window/plot_render.0.png"
        ]
    );
    for (rel, kept) in [
        ("renders/window/plot_render.0.png", false),
        ("renders/window/plot_render.1.png", false),
        ("renders/window/plot_render.2.png", true),
        ("renders/window/plot_render.3.png", true),
        // Another op's renders are not this prefix's.
        ("renders/window/viewport_render.0.png", true),
    ] {
        assert_eq!(d.path().join(rel).is_file(), kept, "{rel}");
    }
    for (dir, prefix) in [
        ("runs", "x."),
        ("renders/../runs", "x."),
        ("renders/window", ""),
        ("renders/window", "../x"),
    ] {
        let e = s.prune_outputs(dir, prefix, 1).unwrap_err();
        assert_eq!(e.code, ApiErrorCode::InvalidInput, "{dir} {prefix}");
    }
    drop(s);
    let mut r = Session::open(d.path(), SessionOptions::read_only()).unwrap();
    let e = r
        .prune_outputs("renders/window", "plot_render.", 0)
        .unwrap_err();
    assert_eq!(e.code, ApiErrorCode::Locked);
}
