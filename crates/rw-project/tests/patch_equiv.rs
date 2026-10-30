//! Patch equivalence (invariant I4, plan R9): applying `PatchOp`s through the
//! comment-preserving `TomlStore` and re-parsing the written files gives the
//! same model as applying them to the `ModelValue` in `rw-model`:
//!
//! `eval(parse(toml_edit result)) == eval(apply(ModelValue))`
//!
//! The property also asserts the stronger per-file `parse(..) == apply(..)`,
//! that no file needed the rebuild fallback, and that comments on entries the
//! ops never remove survive.

use std::collections::BTreeMap;

use proptest::prelude::*;
use rw_model::{EvalOptions, PatchOp, SourceSet, eval, model_hash, parse_source};
use rw_project::TomlStore;
use serde_json::{Value, json};

const FILES: &[(&str, &str)] = &[
    (
        "rocketwright.toml",
        include_str!("fixtures/project/rocketwright.toml"),
    ),
    (
        "rocket.rw.toml",
        include_str!("fixtures/project/rocket.rw.toml"),
    ),
    (
        "parts/fin_can.rw.toml",
        include_str!("fixtures/project/parts/fin_can.rw.toml"),
    ),
    (
        "configs/baseline.rw.toml",
        include_str!("fixtures/project/configs/baseline.rw.toml"),
    ),
    (
        "sims/baseline.rw.toml",
        include_str!("fixtures/project/sims/baseline.rw.toml"),
    ),
];

/// Comments on entries no generated op removes, moves, or replaces whole.
const KEPT_COMMENTS: &[(&str, &str)] = &[
    (
        "rocket.rw.toml",
        "# Hand-written model: every comment here must survive programmatic edits.",
    ),
    ("rocket.rw.toml", "# display name"),
    (
        "rocket.rw.toml",
        "# The nose: printed PLA, keep this comment.",
    ),
    ("rocket.rw.toml", "# nose length note"),
    ("rocket.rw.toml", "# length follows the param"),
    ("rocket.rw.toml", "# inner diameter"),
    ("rocket.rw.toml", "# Materials used above."),
    ("rocket.rw.toml", "# PLA"),
    ("rocket.rw.toml", "# end of model"),
    ("rocketwright.toml", "# project name"),
];

fn files() -> BTreeMap<String, String> {
    FILES
        .iter()
        .map(|(p, t)| (p.to_string(), t.to_string()))
        .collect()
}

fn parse_all(files: &BTreeMap<String, String>) -> Result<SourceSet, String> {
    let mut set = SourceSet::default();
    for (p, t) in files {
        let doc = parse_source(p, t).map_err(|d| format!("{p}: {d:?}\n{t}"))?;
        set.docs.insert(p.clone(), doc);
    }
    Ok(set)
}

/// Runs `ops` both ways and compares. `Ok(false)` when both sides reject them.
fn check(ops: &[PatchOp]) -> Result<bool, String> {
    let disk = files();
    let mut store = TomlStore::load(&disk).map_err(|d| format!("{d:?}"))?;
    let base = store.sources().clone();
    let model = rw_model::apply(&base, ops);
    let changes = match (model.as_ref(), store.apply(ops)) {
        (Err(a), Err(b)) => {
            return if *a == b {
                Ok(false)
            } else {
                Err(format!("different errors: {a:?} vs {b:?}"))
            };
        }
        (Ok(_), Ok(changes)) => changes,
        (a, b) => return Err(format!("model {a:?} vs store {b:?}")),
    };
    let want = model.map_err(|e| format!("{e:?}"))?;

    let mut written = disk.clone();
    for c in &changes {
        if c.rewritten {
            return Err(format!("`{}` needed the rebuild fallback", c.path));
        }
        match &c.text {
            Some(t) => written.insert(c.path.clone(), t.clone()),
            None => written.remove(&c.path),
        };
    }
    // The store's own view agrees with what it wrote.
    if store.texts() != written {
        return Err("store texts differ from the written files".into());
    }
    let got = parse_all(&written)?;
    if got != want {
        let diff: Vec<_> = want
            .docs
            .iter()
            .filter(|(p, d)| got.docs.get(*p) != Some(d))
            .map(|(p, _)| p.clone())
            .chain(
                got.docs
                    .keys()
                    .filter(|p| !want.docs.contains_key(*p))
                    .cloned(),
            )
            .collect();
        let texts: Vec<_> = diff.iter().filter_map(|p| written.get(p)).collect();
        return Err(format!("files differ: {diff:?}\n{texts:#?}"));
    }
    let opts = EvalOptions::default();
    let (a, b) = (eval(&got, &opts), eval(&want, &opts));
    if model_hash(&a) != model_hash(&b)
        || serde_json::to_value(&a).ok() != serde_json::to_value(&b).ok()
    {
        return Err("evaluated models differ".into());
    }
    for (path, comment) in KEPT_COMMENTS {
        let text = written.get(*path).map(String::as_str).unwrap_or("");
        if !text.contains(comment) {
            return Err(format!("`{comment}` lost from {path}:\n{text}"));
        }
    }
    Ok(true)
}

fn length() -> impl Strategy<Value = String> {
    (1u32..900).prop_map(|n| format!("{n} mm"))
}

fn add(path: &str, value: Value) -> PatchOp {
    PatchOp::Add {
        path: path.into(),
        value,
    }
}

fn replace(path: &str, value: Value) -> PatchOp {
    PatchOp::Replace {
        path: path.into(),
        value,
    }
}

fn op() -> impl Strategy<Value = PatchOp> {
    let leaf = prop::sample::select(vec![
        "/c/nose/length",
        "/c/body/id",
        "/c/fins/root_chord",
        "/c/mount/length",
        "/params/span/value",
        "/c/chute/diameter",
        "rw:c/ring/length",
        "/variants/long_fins/span",
        "/c/nose/shoulder/length",
    ]);
    let removed = prop::sample::select(vec![
        "/c/ring",
        "/c/chute",
        "/c/mount",
        "/c/nose/shoulder",
        "/c/body/finish",
        "/c/fins/count",
        "/params/span/step",
        "/params/span",
        "/variants/long_fins",
        "/assert/0",
        "/report",
        "/report/values/0",
        "/include/0",
        "/c/chute/attach/offset",
        "/configs/baseline/motors/mount/delay",
        "rw:sim/baseline",
        "/sims/baseline/launch/rod_angle",
        "/project/default_config",
    ]);
    let moves = prop::sample::select(vec![
        ("/c/fins", "/c/fin_set"),
        ("/c/chute", "/c/main_chute"),
        ("/c/ring", "/c/ring2"),
        ("/c/lug", "/c/lug2"),
        ("/configs/baseline", "/configs/flight"),
        ("/params/span", "/params/fin_span"),
        ("/c/body/finish", "/c/chute/finish"),
        ("/assert/0", "/assert/1"),
        ("/c/fins/sweep", "/c/fins/tip_chord"),
    ]);
    let copies = prop::sample::select(vec![
        ("/c/ring", "/c/ring_fwd"),
        ("/configs/baseline", "/configs/copy"),
        ("/c/chute/attach", "/c/mount/attach"),
        ("/assert/0", "/assert/-"),
        ("/params/span", "/params/span2"),
    ]);
    prop_oneof![
        3 => (leaf, length()).prop_map(|(p, v)| replace(p, json!(v))),
        1 => (1u32..8).prop_map(|n| replace("/c/fins/count", json!(n))),
        1 => length().prop_map(|l| add(
            "/c/lug",
            json!({"type": "launch_lug", "attach": {"to": "body.outer"}, "length": l, "od": "8 mm"})
        )),
        1 => length().prop_map(|v| add("/params/extra", json!({"value": v, "group": "Misc"}))),
        1 => length().prop_map(|v| add("/c/chute/attach/offset", json!(v))),
        1 => length().prop_map(|v| add("/c/body/name", json!(format!("Body {v}")))),
        2 => removed.prop_map(|p| PatchOp::Remove { path: p.into() }),
        2 => moves.prop_map(|(f, t)| PatchOp::Move { from: f.into(), path: t.into() }),
        1 => copies.prop_map(|(f, t)| PatchOp::Copy { from: f.into(), path: t.into() }),
        1 => "[a-z]{1,6}".prop_map(|id| add(
            "/assert/0",
            json!({"id": id, "expr": "stability.liftoff >= 1.5 cal"})
        )),
        1 => Just(add("/assert/-", json!({"id": "apogee", "expr": "apogee >= 100 m", "severity": "warning"}))),
        1 => Just(add("/report/values/0", json!("= c.body.length"))),
        1 => Just(add("/include/-", json!("parts/fin_can.rw.toml"))),
        1 => length().prop_map(|l| replace(
            "/c/ring",
            json!({"type": "centering_ring", "attach": {"to": "mount.aft", "at": "aft"}, "length": l, "id": "19.7 mm"})
        )),
        1 => Just(replace("/configs/baseline/motors/mount/delay", json!("6 s"))),
        1 => Just(add(
            "/configs/long",
            json!({"name": "Long", "motors": {"mount": {"motor": "generic:RW_C6G", "delay": "7 s"}}})
        )),
        1 => Just(add("/sims/baseline/launch/rod_direction", json!("90 deg"))),
        1 => Just(add("/sims/hot", json!({"config": "baseline", "launch": {"rail_length": "2 m"}, "series_dt": "0.02 s"}))),
        1 => Just(replace("/project/name", json!("Renamed"))),
        1 => Just(add("/project/display_units", json!({"length": "mm", "mass": "g"}))),
        1 => Just(add("/materials/alu", json!({"density": "2700 kg/m^3"}))),
        1 => Just(add("/stage/sustainer", json!({"first": "nose"}))),
        1 => Just(PatchOp::Test { path: "/c/fins/count".into(), value: json!(3) }),
        1 => Just(replace("/c/fins/span", json!("= params.span * 1.1"))),
        1 => Just(replace("/c/body/attach", json!({"to": "nose.base", "offset": "0 mm"}))),
        1 => Just(add("/name", json!("Store II"))),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// I4: the `toml_edit` result and the model value agree after any op sequence.
    #[test]
    fn toml_edit_matches_model_value(ops in prop::collection::vec(op(), 1..7)) {
        if let Err(e) = check(&ops) {
            prop_assert!(false, "{}\nops: {}", e, serde_json::to_string(&ops).unwrap_or_default());
        }
    }
}

/// Every single op of the generator's vocabulary, deterministically.
#[test]
fn single_ops_agree() {
    let cases: Vec<Vec<PatchOp>> = vec![
        vec![replace("/c/nose/length", json!("160 mm"))],
        vec![PatchOp::Move {
            from: "/c/fins".into(),
            path: "/c/fin_set".into(),
        }],
        vec![PatchOp::Move {
            from: "/configs/baseline".into(),
            path: "/configs/flight".into(),
        }],
        vec![PatchOp::Remove {
            path: "/assert/0".into(),
        }],
        vec![add(
            "/assert/0",
            json!({"id": "first", "expr": "stability.liftoff >= 2 cal"}),
        )],
        vec![PatchOp::Remove {
            path: "/c/ring".into(),
        }],
        vec![PatchOp::Remove {
            path: "rw:sim/baseline".into(),
        }],
        vec![add("/sims/hot", json!({"config": "baseline"}))],
        vec![add("/project/display_units", json!({"length": "mm"}))],
    ];
    let mut applied = 0;
    for ops in cases {
        match check(&ops) {
            Ok(ok) => applied += usize::from(ok),
            Err(e) => panic!("{e}\nops: {ops:?}"),
        }
    }
    assert_eq!(applied, 9);
}
