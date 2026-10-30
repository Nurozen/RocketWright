use super::*;
use crate::session::{Session, SessionOptions, SyncOutcome};
use crate::testutil::{TempDir, fixture_project};
use rw_api::{CallCtx, Command, HistoryListIn, Response};
use rw_model::PatchOp;
use std::io::BufRead;
use std::process::{Command as Proc, Stdio};

const HELPER_ENV: &str = "RW_HISTORY_HELPER_DIR";
const HELPER_STEPS: u32 = 12;

fn meta(title: &str) -> StepMeta {
    StepMeta {
        origin: Origin::Cli,
        thread: None,
        tool: Some("model_patch".into()),
        tool_call: None,
        title: title.into(),
        model_hash: "0".repeat(64),
        metrics: StepMetrics::default(),
        time: (1_791_900_240, "2026-10-14T13:24:00Z".into()),
    }
}

fn snap(files: &[(&str, &str)]) -> Snapshot {
    files
        .iter()
        .map(|(p, t)| (p.to_string(), t.to_string()))
        .collect()
}

fn ctx(origin: Origin) -> CallCtx {
    CallCtx {
        origin,
        thread: None,
        tool_call: None,
        label: None,
    }
}

fn set_span(s: &mut Session, v: &str, origin: Origin) -> rw_api::MutationOut {
    s.patch(
        &[PatchOp::Replace {
            path: "/params/span/value".into(),
            value: serde_json::Value::String(v.into()),
        }],
        false,
        &ctx(origin),
        "model_patch",
        format!("span {v}"),
    )
    .unwrap()
}

#[test]
fn records_dedupes_and_tracks_file_changes() {
    let d = TempDir::new("hist-basic");
    let h = History::open(d.path()).unwrap();
    assert!(h.steps().unwrap().is_empty());
    let a = snap(&[("rocket.rw.toml", "a"), ("parts/x.rw.toml", "x")]);
    let s1 = h.record(&a, &meta("one")).unwrap().unwrap();
    assert_eq!((s1.seq, s1.prev.as_deref()), (1, None));
    assert_eq!(s1.files.len(), 2);
    assert!(s1.files.iter().all(|f| f.status == FileStatus::A));
    assert_eq!(s1.ts, "2026-10-14T13:24:00Z");
    // Same tree: no step (D3).
    assert_eq!(h.record(&a, &meta("again")).unwrap(), None);
    let b = snap(&[("rocket.rw.toml", "b"), ("configs/c.rw.toml", "c")]);
    let s2 = h.record(&b, &meta("two")).unwrap().unwrap();
    assert_eq!(s2.seq, 2);
    assert_eq!(s2.prev.as_deref(), Some(s1.id.as_str()));
    let mut f: Vec<(String, FileStatus)> = s2
        .files
        .iter()
        .map(|f| (f.path.clone(), f.status))
        .collect();
    f.sort_by(|x, y| x.0.cmp(&y.0));
    assert_eq!(
        f,
        [
            ("configs/c.rw.toml".to_string(), FileStatus::A),
            ("parts/x.rw.toml".to_string(), FileStatus::D),
            ("rocket.rw.toml".to_string(), FileStatus::M),
        ]
    );
    assert_eq!(h.snapshot(h.resolve("step:1").unwrap()).unwrap(), a);
    assert_eq!(h.head_snapshot().unwrap(), b);
    assert_eq!(h.resolve("HEAD").unwrap().to_string(), s2.id);
    assert_eq!(
        h.resolve(&format!("commit:{}", &s1.id[..10]))
            .unwrap()
            .to_string(),
        s1.id
    );
    assert!(matches!(
        h.resolve("step:9"),
        Err(HistoryError::UnknownVersion(_))
    ));
    assert!(matches!(
        h.resolve("bogus"),
        Err(HistoryError::UnknownVersion(_))
    ));
}

#[test]
fn steps_jsonl_is_rebuilt_from_trailers() {
    let d = TempDir::new("hist-rebuild");
    let h = History::open(d.path()).unwrap();
    for i in 0..3 {
        h.record(
            &snap(&[("rocket.rw.toml", &i.to_string())]),
            &meta(&format!("s{i}")),
        )
        .unwrap();
    }
    let want = h.steps().unwrap();
    assert_eq!(want.iter().map(|s| s.seq).collect::<Vec<_>>(), [1, 2, 3]);
    let jsonl = d.path().join(STEPS_JSONL);
    for broken in ["", "garbage\n", "{\"seq\":1}\n"] {
        std::fs::write(&jsonl, broken).unwrap();
        assert_eq!(h.steps().unwrap(), want);
        let lines = std::fs::read_to_string(&jsonl).unwrap();
        assert_eq!(lines.lines().count(), 3, "cache rewritten");
    }
    std::fs::remove_file(&jsonl).unwrap();
    assert_eq!(History::open(d.path()).unwrap().steps().unwrap(), want);
}

#[test]
fn tags_name_revisions() {
    let d = TempDir::new("hist-tag");
    let h = History::open(d.path()).unwrap();
    let t = (1_791_900_240, "2026-10-14T13:24:00Z".to_string());
    assert!(h.tag("too early", None, None, &t).is_err());
    let s1 = h
        .record(&snap(&[("a.rw.toml", "1")]), &meta("one"))
        .unwrap()
        .unwrap();
    let s2 = h
        .record(&snap(&[("a.rw.toml", "2")]), &meta("two"))
        .unwrap()
        .unwrap();
    let r1 = h.tag("Baseline", Some("step:1"), None, &t).unwrap();
    assert_eq!((r1.number, r1.step, r1.id.as_str()), (1, 1, s1.id.as_str()));
    let r2 = h.tag("Flight-ready fins\nignored", None, None, &t).unwrap();
    assert_eq!(
        (r2.number, r2.name.as_str(), r2.step),
        (2, "Flight-ready fins", 2)
    );
    assert_eq!(h.revisions().unwrap(), vec![r1.clone(), r2.clone()]);
    assert_eq!(h.resolve("rev:02").unwrap().to_string(), s2.id);
    assert_eq!(h.resolve("rev:1").unwrap().to_string(), s1.id);
    let steps = h.steps().unwrap();
    assert_eq!(steps[0].rev.as_deref(), Some("rev:01"));
    assert_eq!(steps[1].rev.as_deref(), Some("rev:02"));
    // Revisions are not on the linear ref.
    assert_eq!(h.head().unwrap().unwrap().to_string(), s2.id);
    assert!(h.tag("  ", None, None, &t).is_err());
    // An explicit number must exceed every existing one; the next default follows it.
    assert!(h.tag("again", None, Some(2), &t).is_err());
    assert!(h.tag("zero", None, Some(0), &t).is_err());
    let r7 = h.tag("Pre-flight", Some("step:2"), Some(7), &t).unwrap();
    assert_eq!((r7.number, r7.step), (7, 2));
    assert_eq!(h.resolve("rev:07").unwrap().to_string(), s2.id);
    assert_eq!(h.tag("Next", None, None, &t).unwrap().number, 8);
}

/// Child body for the two-process test: records `HELPER_STEPS` distinct steps.
#[test]
#[ignore = "helper: run by two_processes_lose_and_duplicate_no_step"]
fn history_writer_helper() {
    let Ok(dir) = std::env::var(HELPER_ENV) else {
        return;
    };
    let tag = std::env::var("RW_HISTORY_HELPER_TAG").unwrap();
    let h = History::open(Path::new(&dir)).unwrap();
    for i in 0..HELPER_STEPS {
        let s = snap(&[("rocket.rw.toml", &format!("{tag}-{i}"))]);
        h.record(&s, &meta(&format!("{tag} {i}"))).unwrap().unwrap();
    }
    println!("done {tag}");
}

#[test]
fn two_processes_lose_and_duplicate_no_step() {
    let d = TempDir::new("hist-2proc");
    History::open(d.path()).unwrap();
    let spawn = |tag: &str| {
        Proc::new(std::env::current_exe().unwrap())
            .args([
                "history::tests::history_writer_helper",
                "--exact",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(HELPER_ENV, d.path())
            .env("RW_HISTORY_HELPER_TAG", tag)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap()
    };
    let children = [spawn("a"), spawn("b")];
    for mut c in children {
        let out = std::io::BufReader::new(c.stdout.take().unwrap());
        let text: Vec<String> = out.lines().map(Result::unwrap).collect();
        assert!(c.wait().unwrap().success(), "{text:?}");
        assert!(text.iter().any(|l| l.contains("done ")), "{text:?}");
    }
    let h = History::open(d.path()).unwrap();
    let steps = h.steps().unwrap();
    let n = 2 * HELPER_STEPS as usize;
    assert_eq!(steps.len(), n, "no lost step");
    assert_eq!(
        steps.iter().map(|s| s.seq).collect::<Vec<_>>(),
        (1..=n as u32).collect::<Vec<_>>(),
        "no duplicate or skipped seq"
    );
    for w in steps.windows(2) {
        assert_eq!(w[1].prev.as_deref(), Some(w[0].id.as_str()), "linear chain");
    }
    let titles: std::collections::BTreeSet<&str> = steps.iter().map(|s| s.title.as_str()).collect();
    assert_eq!(titles.len(), n, "every write recorded once");
    // The cache, rebuilt or appended out of order, agrees with the commits.
    assert_eq!(
        h.rebuild()
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect::<Vec<_>>(),
        steps.iter().map(|s| s.id.clone()).collect::<Vec<_>>()
    );
}

#[test]
fn watcher_replay_of_a_cli_write_is_one_step() {
    let d = TempDir::new("hist-replay");
    fixture_project(d.path());
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let out = set_span(&mut s, "60 mm", Origin::Cli);
    assert_eq!(out.step.as_deref(), Some("step:2"));
    // The FS events of that write, replayed (twice), change nothing.
    assert_eq!(
        s.sync_from_disk(Origin::Watcher).unwrap(),
        SyncOutcome::Unchanged
    );
    assert_eq!(
        s.sync_from_disk(Origin::Watcher).unwrap(),
        SyncOutcome::Unchanged
    );
    // Even without the own-write set, the tree hash dedupes.
    s.clear_own_writes();
    assert_eq!(
        s.sync_from_disk(Origin::Watcher).unwrap(),
        SyncOutcome::Unchanged
    );
    let steps = s.steps().unwrap();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[1].origin, Origin::Cli);
    drop(s);
    // An in-process CLI session wrote while no sidecar ran; the next owner
    // sees the same tree and adds nothing.
    let s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    assert_eq!(s.steps().unwrap().len(), 2);
    drop(s);
    // An edit made with no owner running becomes one external step.
    let p = d.path().join("rocket.rw.toml");
    let t = std::fs::read_to_string(&p)
        .unwrap()
        .replace("\"60 mm\"", "\"61 mm\"");
    std::fs::write(&p, t).unwrap();
    let s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let steps = s.steps().unwrap();
    assert_eq!(steps.len(), 3);
    assert_eq!(
        (steps[2].origin, steps[2].title.as_str()),
        (Origin::Watcher, "External edit")
    );
}

#[test]
fn log_show_compare_tag_restore_through_execute() {
    let d = TempDir::new("hist-exec");
    fixture_project(d.path());
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    let original = std::fs::read_to_string(d.path().join("rocket.rw.toml")).unwrap();
    set_span(&mut s, "60 mm", Origin::Mcp);
    set_span(&mut s, "70 mm", Origin::Cli);
    let c = ctx(Origin::Mcp);

    let Response::HistoryList(l) = s
        .execute(&Command::HistoryList(HistoryListIn::default()), &c)
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(l.steps.len(), 3);
    let Response::HistoryList(only_cli) = s
        .execute(
            &Command::HistoryList(HistoryListIn {
                thread: Some("cli".into()),
                ..Default::default()
            }),
            &c,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(
        only_cli.steps.iter().map(|s| s.seq).collect::<Vec<_>>(),
        [3]
    );
    let Response::HistoryList(last) = s
        .execute(
            &Command::HistoryList(HistoryListIn {
                limit: Some(1),
                ..Default::default()
            }),
            &c,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(last.steps[0].seq, 3);

    let Response::HistoryShow(show) = s
        .execute(
            &Command::HistoryShow(rw_api::HistoryShowIn {
                version: "step:2".into(),
            }),
            &c,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(show.step.seq, 2);
    assert_eq!(show.diff.a, "step:1");
    assert_eq!(show.diff.changed.len(), 1, "{:?}", show.diff);
    assert_eq!(show.diff.changed[0].path, "/params/span/value");
    assert_eq!(show.diff.changed[0].new, Some(serde_json::json!("60 mm")));

    let Response::HistoryTag(rev) = s
        .execute(
            &Command::HistoryTag(rw_api::HistoryTagIn {
                name: "Baseline".into(),
                version: Some("step:1".into()),
                number: None,
            }),
            &c,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!((rev.number, rev.step), (1, 1));

    let Response::HistoryCompare(cmp) = s
        .execute(
            &Command::HistoryCompare(rw_api::HistoryCompareIn {
                a: "rev:01".into(),
                b: "live".into(),
                visual: false,
                breakdown: false,
            }),
            &c,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(cmp.model.changed.len(), 1);
    assert_eq!(cmp.model.changed[0].old, Some(serde_json::json!("50 mm")));
    assert_eq!(cmp.model.changed[0].new, Some(serde_json::json!("70 mm")));
    assert!(!cmp.metrics.is_empty());

    // Restore is a new step whose files equal the restored version.
    let Response::HistoryRestore(r) = s
        .execute(
            &Command::HistoryRestore(rw_api::HistoryRestoreIn {
                version: "rev:01".into(),
                dry_run: false,
            }),
            &c,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(r.step.as_deref(), Some("step:4"));
    assert_eq!(
        std::fs::read_to_string(d.path().join("rocket.rw.toml")).unwrap(),
        original
    );
    let steps = s.steps().unwrap();
    assert_eq!(steps[3].title, "Restore rev:01");
    assert_eq!(steps[3].model_hash, steps[0].model_hash);

    let Response::ModelDiff(md) = s
        .execute(
            &Command::ModelDiff(rw_api::ModelDiffIn {
                a: "step:3".into(),
                b: "live".into(),
            }),
            &c,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(md.changed.len(), 1);
}

/// Invariant I15: a user repo with a dirty index is unchanged after 10 steps.
#[test]
fn dirty_user_repo_is_untouched() {
    let d = TempDir::new("hist-i15");
    fixture_project(d.path());
    let git = |args: &[&str]| -> String {
        let o = Proc::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(d.path())
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git is installed");
        assert!(
            o.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        String::from_utf8_lossy(&o.stdout).into_owned()
    };
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(d.path().join(".gitignore"), ".rw/\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "user commit"]);
    git(&["remote", "add", "origin", "https://example.invalid/r.git"]);
    // Dirty index: a staged edit, plus an unstaged one.
    let cfg = d.path().join("configs/baseline.rw.toml");
    std::fs::write(&cfg, std::fs::read_to_string(&cfg).unwrap() + "# staged\n").unwrap();
    git(&["add", "configs/baseline.rw.toml"]);
    std::fs::write(d.path().join("notes.txt"), "untracked\n").unwrap();

    let index = || std::fs::read(d.path().join(".git/index")).unwrap();
    let state = || {
        (
            git(&["rev-parse", "HEAD"]),
            git(&["symbolic-ref", "HEAD"]),
            git(&["for-each-ref"]),
            git(&["diff", "--cached"]),
            git(&["config", "--local", "--list"]),
            git(&["remote", "-v"]),
            git(&["stash", "list"]),
            index(),
        )
    };
    let before = state();
    let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
    for i in 0..10 {
        let out = set_span(&mut s, &format!("{} mm", 51 + i), Origin::Mcp);
        assert!(out.step.is_some());
    }
    assert_eq!(s.steps().unwrap().len(), 11);
    s.execute(
        &Command::HistoryTag(rw_api::HistoryTagIn {
            name: "x".into(),
            version: None,
            number: None,
        }),
        &ctx(Origin::Cli),
    )
    .unwrap();
    drop(s);
    assert!(
        state() == before,
        "HEAD, refs, index, config, remotes, and stash unchanged"
    );
    assert!(
        !git(&["for-each-ref"]).contains("refs/rw"),
        "no rw refs in the user repo"
    );
    assert!(d.path().join(".rw/history.git/HEAD").is_file());
}
