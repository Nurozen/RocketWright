//! `cargo test -p rw-project store::`: decor-preserving patches on the
//! fixture project (the property test is `tests/patch_equiv.rs`).

use super::*;
use serde_json::json;

const FILES: &[(&str, &str)] = &[
    (
        "rocketwright.toml",
        include_str!("../../tests/fixtures/project/rocketwright.toml"),
    ),
    (
        "rocket.rw.toml",
        include_str!("../../tests/fixtures/project/rocket.rw.toml"),
    ),
    (
        "parts/fin_can.rw.toml",
        include_str!("../../tests/fixtures/project/parts/fin_can.rw.toml"),
    ),
    (
        "configs/baseline.rw.toml",
        include_str!("../../tests/fixtures/project/configs/baseline.rw.toml"),
    ),
    (
        "sims/baseline.rw.toml",
        include_str!("../../tests/fixtures/project/sims/baseline.rw.toml"),
    ),
];

fn store() -> TomlStore {
    TomlStore::load(FILES.iter().copied()).expect("fixture loads")
}

fn original(path: &str) -> &'static str {
    FILES
        .iter()
        .find(|(p, _)| *p == path)
        .expect("fixture file")
        .1
}

fn ops(v: Json) -> Vec<PatchOp> {
    serde_json::from_value(v).expect("ops parse")
}

/// Applies `v` and returns the changes by path (`None` = deleted).
fn apply(s: &mut TomlStore, v: Json) -> BTreeMap<String, Option<String>> {
    let changes = s.apply(&ops(v)).expect("ops apply");
    assert!(changes.iter().all(|c| !c.rewritten), "{changes:?}");
    changes.into_iter().map(|c| (c.path, c.text)).collect()
}

fn text(changes: &BTreeMap<String, Option<String>>, path: &str) -> String {
    changes[path].clone().expect("file written")
}

#[test]
fn loads_and_renders_unchanged() {
    let s = store();
    for (path, text) in FILES {
        assert_eq!(s.text(path).as_deref(), Some(*text), "{path}");
    }
    assert_eq!(s.sources().docs.len(), 5);
    assert_eq!(s.paths().count(), 5);
}

#[test]
fn replace_changes_one_line_and_keeps_its_comment() {
    let mut s = store();
    let changes = apply(
        &mut s,
        json!([{"op": "replace", "path": "rw:c/nose/length", "value": "160 mm"}]),
    );
    assert_eq!(changes.len(), 1);
    let want = original("rocket.rw.toml").replace(
        "length = \"150 mm\"   # nose length note",
        "length = \"160 mm\"   # nose length note",
    );
    assert_eq!(text(&changes, "rocket.rw.toml"), want);
}

#[test]
fn rename_in_place_keeps_comments_and_position() {
    let mut s = store();
    let changes = apply(
        &mut s,
        json!([{"op": "move", "from": "/c/chute", "path": "/c/main_chute"}]),
    );
    let want = original("rocket.rw.toml").replace("[c.chute]", "[c.main_chute]");
    assert_eq!(text(&changes, "rocket.rw.toml"), want);
}

#[test]
fn move_across_files_carries_comments_and_keeps_the_file_head() {
    let mut s = store();
    let changes = apply(
        &mut s,
        json!([{"op": "move", "from": "/c/fins", "path": "/c/fin_set"}]),
    );
    let part = text(&changes, "parts/fin_can.rw.toml");
    assert!(part.starts_with(
        "# Fins and motor mount, included by rocket.rw.toml.\n\n# Motor mount tube.\n[c.mount]\n"
    ));
    assert!(!part.contains("[c.fins]"));
    let main = text(&changes, "rocket.rw.toml");
    let block = "\n[c.fin_set]\ntype = \"trapezoidal_fin_set\"\n";
    let at = main.find(block).expect("moved block");
    assert!(main[at..].contains("count = 3   # three fins"));
    // Renders after the last component, before the materials.
    assert!(at > main.find("[c.chute]").unwrap());
    assert!(at < main.find("# Materials used above.").unwrap());
    assert!(!main.contains("included by rocket.rw.toml"));
}

#[test]
fn add_appends_a_header_table_after_its_siblings() {
    let mut s = store();
    let changes = apply(
        &mut s,
        json!([{"op": "add", "path": "/c/lug", "value":
            {"attach": {"to": "body.outer"}, "type": "launch_lug", "length": "30 mm", "od": "8 mm"}}]),
    );
    let want = original("rocket.rw.toml").replace(
        "packed_diameter = \"35 mm\"\n",
        "packed_diameter = \"35 mm\"\n\n[c.lug]\ntype = \"launch_lug\"\nattach = { to = \"body.outer\" }\nlength = \"30 mm\"\nod = \"8 mm\"\n",
    );
    assert_eq!(text(&changes, "rocket.rw.toml"), want);
}

#[test]
fn remove_takes_only_its_own_block() {
    let mut s = store();
    let changes = apply(&mut s, json!([{"op": "remove", "path": "/c/ring"}]));
    let want = original("parts/fin_can.rw.toml");
    let cut = want.find("\n[c.ring]").unwrap();
    assert_eq!(text(&changes, "parts/fin_can.rw.toml"), want[..cut]);
}

#[test]
fn removing_the_first_token_keeps_the_file_comment() {
    let mut s = store();
    let changes = apply(&mut s, json!([{"op": "remove", "path": "/name"}]));
    let main = text(&changes, "rocket.rw.toml");
    assert!(main.starts_with(
        "# Hand-written model: every comment here must survive programmatic edits.\ninclude = "
    ));
}

#[test]
fn array_edits_splice() {
    let mut s = store();
    let changes = apply(
        &mut s,
        json!([
            {"op": "add", "path": "/report/values/-", "value": "= c.body.length"},
            {"op": "add", "path": "/assert/-", "value": {"id": "high", "expr": "apogee >= 100 m"}},
        ]),
    );
    let main = text(&changes, "rocket.rw.toml");
    assert!(main.contains("values = [\"= c.fins.span\", \"= c.body.length\"]"));
    assert!(main.contains(
        "expr = \"stability.liftoff >= 1 cal\"   # one caliber\n\n[[assert]]\nid = \"high\"\nexpr = \"apogee >= 100 m\"\n"
    ));
    let changes = apply(&mut s, json!([{"op": "remove", "path": "/assert/0"}]));
    let main = text(&changes, "rocket.rw.toml");
    assert!(!main.contains("one caliber") && main.contains("id = \"high\""));
}

#[test]
fn config_files_are_created_renamed_and_deleted() {
    let mut s = store();
    let changes = apply(
        &mut s,
        json!([
            {"op": "move", "from": "/configs/baseline", "path": "/configs/flight"},
            {"op": "add", "path": "/configs/long", "value": {"name": "Long", "motors": {"mount": {"motor": "generic:RW_C6G"}}}},
            {"op": "remove", "path": "rw:sim/baseline"},
        ]),
    );
    assert_eq!(changes["configs/baseline.rw.toml"], None);
    assert_eq!(changes["sims/baseline.rw.toml"], None);
    assert_eq!(
        text(&changes, "configs/flight.rw.toml"),
        original("configs/baseline.rw.toml")
    );
    assert_eq!(
        text(&changes, "configs/long.rw.toml"),
        "name = \"Long\"\n\n[motors.mount]\nmotor = \"generic:RW_C6G\"\n"
    );
    assert!(s.text("configs/baseline.rw.toml").is_none());
}

#[test]
fn unknown_keys_survive_edits_of_their_table() {
    let mut s = store();
    let text_in = "[c.body]\ntype = \"body_tube\"\nlength = \"300 mm\"\nod = \"54 mm\"\nlabel = \"keep me\"   # unknown\n";
    s.insert("rocket.rw.toml", text_in).unwrap();
    let changes = apply(
        &mut s,
        json!([{"op": "replace", "path": "/c/body/od", "value": "41.6 mm"}]),
    );
    assert_eq!(
        text(&changes, "rocket.rw.toml"),
        text_in.replace("54 mm", "41.6 mm")
    );
}

#[test]
fn preview_and_errors_leave_the_store_unchanged() {
    let s = store();
    let before = s.texts();
    let (next, changes) = s
        .preview(&ops(
            json!([{"op": "replace", "path": "/c/fins/count", "value": 4}]),
        ))
        .unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(s.texts(), before);
    assert!(
        next.text("parts/fin_can.rw.toml")
            .unwrap()
            .contains("count = 4   # three fins")
    );

    let mut s = store();
    let err = s
        .apply(&ops(json!([
            {"op": "replace", "path": "/c/fins/count", "value": 4},
            {"op": "remove", "path": "/c/nope"},
        ])))
        .unwrap_err();
    assert_eq!(err.op, 1);
    assert!(err.message.starts_with("not_found"));
    assert_eq!(s.texts(), before);
}

#[test]
fn integers_beyond_toml_range_are_schema_errors() {
    let mut s = store();
    let err = s
        .apply(&ops(
            json!([{"op": "add", "path": "/sims/baseline/seed", "value": u64::MAX}]),
        ))
        .unwrap_err();
    assert!(err.message.starts_with("schema_error"), "{}", err.message);
}

#[test]
fn json_twins_are_patched_as_json() {
    let mut s = TomlStore::new();
    s.insert(
        "rocket.rw.json",
        r#"{"c": {"body": {"type": "body_tube", "length": "300 mm", "od": "54 mm", "note": "x"}}}"#,
    )
    .unwrap();
    let changes = apply(
        &mut s,
        json!([{"op": "replace", "path": "/c/body/od", "value": "41.6 mm"}]),
    );
    let out: Json = serde_json::from_str(&text(&changes, "rocket.rw.json")).unwrap();
    assert_eq!(out["c"]["body"]["od"], "41.6 mm");
    assert_eq!(out["c"]["body"]["note"], "x");
}

#[test]
fn diff_is_minimal() {
    let mut edits = Vec::new();
    diff(
        &json!({"a": [1, 2, 3], "b": {"x": 1, "y": 2}, "c": 1}),
        &json!({"a": [1, 9, 2, 3], "b": {"x": 1, "y": 3}, "d": 2}),
        &mut Vec::new(),
        &mut edits,
    );
    assert_eq!(
        edits,
        vec![
            Edit::Remove(vec![Seg::Key("c".into())]),
            Edit::Splice {
                path: vec![Seg::Key("a".into())],
                at: 1,
                remove: 0,
                insert: vec![json!(9)],
                whole: json!([1, 9, 2, 3]),
            },
            Edit::Set(vec![Seg::Key("b".into()), Seg::Key("y".into())], json!(3)),
            Edit::Set(vec![Seg::Key("d".into())], json!(2)),
        ]
    );
}
