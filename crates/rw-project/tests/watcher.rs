//! M1.29 watcher: `cargo test -p rw-project --test watcher -- --test-threads=1`.
//!
//! Real FSEvents/inotify through `notify` + the 200 ms debouncer: an atomic
//! save is one step, a half-write keeps the last good model with `RW-E001`,
//! the watched root's replayed events and the session's own writes add no
//! step, a write the session made (a forwarded CLI call) is one step, and a
//! directory moved in or out is read although only the directory reports.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rw_api::{CallCtx, Origin};
use rw_model::PatchOp;
use rw_project::testutil::{TempDir, fixture_project, wait_until};
use rw_project::{Session, SessionEvent, SessionOptions, SharedSession, SyncOutcome, Watcher};

struct Rig {
    dir: TempDir,
    session: SharedSession,
    outcomes: Arc<Mutex<Vec<SyncOutcome>>>,
    events: Arc<Mutex<Vec<SessionEvent>>>,
    _watcher: Watcher,
}

impl Rig {
    fn new(tag: &str) -> Rig {
        let dir = TempDir::new(tag);
        fixture_project(dir.path());
        let session = Session::open_shared(dir.path(), SessionOptions::writer()).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        session
            .lock()
            .unwrap()
            .on_event(move |e| ev.lock().unwrap().push(e.clone()));
        let outcomes = Arc::new(Mutex::new(Vec::new()));
        let oc = outcomes.clone();
        let watcher =
            Watcher::start(session.clone(), move |o| oc.lock().unwrap().push(o.clone())).unwrap();
        // Let FSEvents settle and replay the root's own creation.
        std::thread::sleep(Duration::from_millis(600));
        Rig {
            dir,
            session,
            outcomes,
            events,
            _watcher: watcher,
        }
    }

    fn steps(&self) -> Vec<rw_api::HistoryStep> {
        self.session.lock().unwrap().steps().unwrap()
    }

    fn model_hash(&self) -> String {
        self.session.lock().unwrap().model().model_hash.clone()
    }

    fn path(&self, rel: &str) -> std::path::PathBuf {
        self.dir.path().join(rel)
    }

    /// Waits past the debounce window and lets late events drain.
    fn settle(&self) {
        std::thread::sleep(Duration::from_millis(900));
    }
}

#[test]
fn startup_replay_adds_no_step() {
    let rig = Rig::new("w-replay");
    rig.settle();
    assert_eq!(rig.steps().len(), 1, "only the initial snapshot");
    assert!(
        rig.outcomes
            .lock()
            .unwrap()
            .iter()
            .all(|o| *o == SyncOutcome::Unchanged),
        "{:?}",
        rig.outcomes.lock().unwrap()
    );
    assert!(rig.events.lock().unwrap().is_empty());
}

#[test]
fn atomic_save_is_one_step() {
    let rig = Rig::new("w-atomic");
    let p = rig.path("rocket.rw.toml");
    let text = std::fs::read_to_string(&p)
        .unwrap()
        .replace("\"50 mm\"", "\"55 mm\"");
    // Editor-style save: temp file, then rename over the original.
    let tmp = rig.path(".rocket.rw.toml.swp");
    std::fs::write(&tmp, &text).unwrap();
    std::fs::rename(&tmp, &p).unwrap();
    assert!(
        wait_until(5000, || rig.steps().len() == 2),
        "{:?}",
        rig.outcomes.lock().unwrap()
    );
    rig.settle();
    let steps = rig.steps();
    assert_eq!(steps.len(), 2, "exactly one step");
    assert_eq!(steps[1].origin, Origin::Watcher);
    assert_eq!(steps[1].title, "Edited rocket.rw.toml");
    let ev = rig.events.lock().unwrap();
    assert_eq!(ev.iter().filter(|e| e.step.is_some()).count(), 1, "{ev:?}");
    assert!(ev.iter().any(|e| e.uris.contains(&"rw://project/model")));
    drop(ev);
    // Then the project is idle and wakes nothing: a sync reads the tree, and
    // those reads (inotify reports every open) must not trigger another.
    let syncs = rig.outcomes.lock().unwrap().len();
    rig.settle();
    let after = rig.outcomes.lock().unwrap().len();
    assert_eq!(after, syncs, "idle syncs");
}

#[test]
fn half_write_keeps_last_good_model() {
    let rig = Rig::new("w-half");
    let good = rig.model_hash();
    let p = rig.path("rocket.rw.toml");
    let text = std::fs::read_to_string(&p).unwrap();
    std::fs::write(&p, &text[..text.len() / 3]).unwrap();
    assert!(
        wait_until(5000, || rig
            .session
            .lock()
            .unwrap()
            .report()
            .diagnostics
            .iter()
            .any(|d| d.file.as_deref() == Some("rocket.rw.toml")
                && (d.code == "RW-E001" || d.code == "RW-E002"))),
        "{:?}",
        rig.outcomes.lock().unwrap()
    );
    assert_eq!(rig.model_hash(), good, "last good model kept");
    assert_eq!(rig.steps().len(), 1);
    // Finishing the write applies it as one step and clears the error.
    std::fs::write(&p, text.replace("\"50 mm\"", "\"52 mm\"")).unwrap();
    assert!(wait_until(5000, || rig.steps().len() == 2));
    rig.settle();
    let steps = rig.steps();
    assert_eq!(steps.len(), 2, "{steps:#?}");
    assert_ne!(rig.model_hash(), good);
    let s = rig.session.lock().unwrap();
    assert!(s.report().diagnostics.iter().all(|d| d.code != "RW-E001"));
}

#[test]
fn half_written_toml_reports_rw_e001() {
    let rig = Rig::new("w-e001");
    let p = rig.path("parts/fin_can.rw.toml");
    std::fs::write(&p, "[c.fins\ntype = ").unwrap();
    // `on_sync` hears the outcome after the session is unlocked, so wait for
    // the outcome itself, not just the report it updated.
    assert!(
        wait_until(5000, || rig
            .outcomes
            .lock()
            .unwrap()
            .iter()
            .any(|o| matches!(o, SyncOutcome::ParseError(_)))),
        "{:?}",
        rig.outcomes.lock().unwrap()
    );
    assert!(
        rig.session
            .lock()
            .unwrap()
            .report()
            .diagnostics
            .iter()
            .any(|d| d.code == "RW-E001" && d.file.as_deref() == Some("parts/fin_can.rw.toml"))
    );
}

#[test]
fn session_write_and_its_echo_are_one_step() {
    let rig = Rig::new("w-own");
    let ctx = CallCtx {
        origin: Origin::Cli,
        thread: None,
        tool_call: None,
        label: Some("rw set".into()),
    };
    let out = rig
        .session
        .lock()
        .unwrap()
        .patch(
            &[PatchOp::Replace {
                path: "/params/span/value".into(),
                value: serde_json::json!("58 mm"),
            }],
            false,
            &ctx,
            "model_patch",
            "rw set".into(),
        )
        .unwrap();
    assert_eq!(out.step.as_deref(), Some("step:2"));
    rig.settle();
    let steps = rig.steps();
    assert_eq!(
        steps.len(),
        2,
        "the watcher echo of an own write adds nothing"
    );
    assert_eq!(steps[1].origin, Origin::Cli);
    // Touching a file (metadata only) adds nothing either.
    let p = rig.path("rocket.rw.toml");
    let t = std::fs::read(&p).unwrap();
    std::fs::write(&p, t).unwrap();
    rig.settle();
    assert_eq!(rig.steps().len(), 2);
}

#[test]
fn lib_and_ignored_paths() {
    let rig = Rig::new("w-lib");
    // Outputs and state are ignored.
    std::fs::create_dir_all(rig.path("runs/baseline/r1")).unwrap();
    std::fs::write(rig.path("runs/baseline/r1/summary.json"), "{}").unwrap();
    std::fs::write(rig.path("notes.md"), "hi").unwrap();
    rig.settle();
    assert_eq!(rig.steps().len(), 1);
    // A new library file is read (unrecorded warning), with no step: the
    // snapshot tree holds sources only.
    std::fs::create_dir_all(rig.path("lib/materials")).unwrap();
    std::fs::write(
        rig.path("lib/materials/woods.rw.toml"),
        "[materials.birch]\ndensity = \"670 kg/m^3\"\n",
    )
    .unwrap();
    assert!(wait_until(5000, || rig
        .session
        .lock()
        .unwrap()
        .model()
        .materials
        .contains_key("birch")));
    assert!(
        rig.session
            .lock()
            .unwrap()
            .model()
            .diagnostics
            .iter()
            .any(|d| d.code == "RW-W003")
    );
    assert_eq!(rig.steps().len(), 1);
}

fn has_birch(rig: &Rig) -> bool {
    rig.session
        .lock()
        .unwrap()
        .model()
        .materials
        .contains_key("birch")
}

#[test]
fn a_directory_moved_in_or_out_is_read() {
    let rig = Rig::new("w-mvdir");
    // Only the directory reports the move, never the file inside it.
    let staging = TempDir::new("w-mvdir-src");
    std::fs::create_dir_all(staging.path().join("lib/materials")).unwrap();
    std::fs::write(
        staging.path().join("lib/materials/woods.rw.toml"),
        "[materials.birch]\ndensity = \"670 kg/m^3\"\n",
    )
    .unwrap();
    std::fs::rename(staging.path().join("lib"), rig.path("lib")).unwrap();
    assert!(
        wait_until(5000, || has_birch(&rig)),
        "{:?}",
        rig.outcomes.lock().unwrap()
    );
    std::fs::rename(rig.path("lib"), staging.path().join("lib")).unwrap();
    assert!(
        wait_until(5000, || !has_birch(&rig)),
        "{:?}",
        rig.outcomes.lock().unwrap()
    );
    assert_eq!(rig.steps().len(), 1, "library changes are not steps");
}
