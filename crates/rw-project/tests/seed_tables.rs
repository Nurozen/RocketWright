//! Seeding the model's tables before a patch (`rw_model::apply_sources`)
//! must not move any project: for every project tracked in the repository,
//! a no-op patch keeps the parsed `model_hash` in every configuration and
//! variant and writes no file, and a real edit still reaches the hash. Then
//! every table can be emptied and refilled through the store.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rw_model::source::doc_kind;
use rw_model::{EvalOptions, ModelValue, PatchOp, SourceDoc, SourceSet, eval, model_hash};
use rw_project::TomlStore;
use serde_json::{Value, json};

/// Where the repository keeps projects, relative to its root.
const ROOTS: &[&str] = &[
    "fixtures",
    "templates",
    "tests/validation",
    "app/e2e/fixtures",
    "app/apps/server/test/fixtures",
    "crates/rw-model/tests/fixtures",
    "crates/rw-project/tests/fixtures",
];

const SKIPPED_DIRS: &[&str] = &[".rw", "node_modules", "target"];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn find_projects(dir: &Path, out: &mut Vec<PathBuf>) {
    if dir.join("rocketwright.toml").is_file() {
        out.push(dir.to_path_buf());
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let skipped = e
            .file_name()
            .to_str()
            .is_some_and(|n| SKIPPED_DIRS.contains(&n));
        if p.is_dir() && !skipped {
            find_projects(&p, out);
        }
    }
}

/// Every project under [`ROOTS`], as paths relative to the repository root.
fn projects() -> Vec<String> {
    let base = root();
    let mut dirs = Vec::new();
    for r in ROOTS {
        find_projects(&base.join(r), &mut dirs);
    }
    let mut v: Vec<String> = dirs
        .iter()
        .map(|d| {
            let rel = d.strip_prefix(&base).unwrap();
            rel.to_string_lossy().replace('\\', "/")
        })
        .collect();
    v.sort();
    assert!(v.len() >= 17, "only {} projects found: {v:?}", v.len());
    v
}

fn walk(d: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(d).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            if e.file_name() != ".rw" {
                walk(&p, out);
            }
        } else {
            out.push(p);
        }
    }
}

fn texts(rel: &str) -> BTreeMap<String, String> {
    let dir = root().join(rel);
    let mut files = Vec::new();
    walk(&dir, &mut files);
    let mut m = BTreeMap::new();
    for p in files {
        let path = p
            .strip_prefix(&dir)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if doc_kind(&path).is_some() {
            m.insert(path, std::fs::read_to_string(&p).unwrap());
        }
    }
    m
}

fn load(rel: &str) -> TomlStore {
    TomlStore::load(&texts(rel)).unwrap_or_else(|d| panic!("{rel}: {d:?}"))
}

fn keys(v: &Value, t: &str) -> Vec<String> {
    v.get(t)
        .and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

fn variants(s: &SourceSet) -> Vec<String> {
    let mut v: Vec<String> = s
        .docs
        .values()
        .flat_map(|d| match d {
            SourceDoc::Rocket(r) => r.variants.keys().cloned().collect::<Vec<_>>(),
            _ => vec![],
        })
        .collect();
    v.sort();
    v.dedup();
    v
}

/// A real edit that reaches the evaluated model (a rocket `/name` edit does
/// not reach `model_hash`); `None` for a project with no parts.
fn name_op(base: &SourceSet) -> Option<PatchOp> {
    let id = keys(&ModelValue::from_sources(base).0, "c")
        .into_iter()
        .next()?;
    Some(PatchOp::Add {
        path: format!("/c/{id}/name"),
        value: json!("Seed test"),
    })
}

#[test]
fn seeding_keeps_every_projects_hash_and_files() {
    let mut rows = 0;
    for rel in projects() {
        let mut store = load(&rel);
        let base = store.sources().clone();
        let noop = rw_model::apply(&base, &[]).unwrap_or_else(|e| panic!("{rel}: {e:?}"));
        assert_eq!(noop, base, "{rel}: a no-op patch changed the sources");
        assert!(
            store.apply(&[]).unwrap().is_empty(),
            "{rel}: a no-op patch wrote a file"
        );
        let edited = name_op(&base).map(|op| rw_model::apply(&base, &[op]).unwrap());
        let cfgs = eval(&base, &EvalOptions::default());
        let mut cfg_keys: Vec<Option<String>> = vec![None];
        cfg_keys.extend(cfgs.configs.keys().cloned().map(Some));
        let mut var_keys: Vec<Option<String>> = vec![None];
        var_keys.extend(variants(&base).into_iter().map(Some));
        for c in &cfg_keys {
            for v in &var_keys {
                let opts = EvalOptions {
                    config: c.clone(),
                    variant: v.clone(),
                    ..EvalOptions::default()
                };
                let parsed = model_hash(&eval(&base, &opts));
                assert_eq!(parsed, model_hash(&eval(&noop, &opts)), "{rel} {c:?} {v:?}");
                if let Some(edited) = &edited {
                    assert_ne!(
                        parsed,
                        model_hash(&eval(edited, &opts)),
                        "{rel} {c:?} {v:?}: the edit must reach the hash"
                    );
                }
                rows += 1;
            }
        }
    }
    assert!(rows >= 52, "only {rows} rows");
}

fn parse_all(t: &BTreeMap<String, String>) -> SourceSet {
    let mut s = SourceSet::default();
    for (p, x) in t {
        s.docs
            .insert(p.clone(), rw_model::parse_source(p, x).unwrap());
    }
    s
}

/// Applies through the store and checks the written bytes re-parse to the model.
fn step(store: &mut TomlStore, rel: &str, ops: Vec<PatchOp>) {
    store
        .apply(&ops)
        .unwrap_or_else(|e| panic!("{rel} {ops:?}: {e:?}"));
    assert_eq!(
        &parse_all(&store.texts()),
        store.sources(),
        "{rel}: {ops:?}"
    );
}

fn add(path: &str, value: Value) -> PatchOp {
    PatchOp::Add {
        path: path.into(),
        value,
    }
}

/// Every entry of `/c`, `/materials`, `/sims`, `/engines` goes in one call,
/// then each table gets a first entry in its own call, in every project.
#[test]
fn every_table_can_be_emptied_and_refilled() {
    let rv = ModelValue::from_sources(load("fixtures/research-vehicle").sources()).0;
    let nose = rv["c"]["nose"].clone();
    let engine = rv["engines"]["demo"].clone();
    let material = json!({"density": "2700 kg/m^3"});
    let sim = json!({"config": "baseline"});
    for rel in projects() {
        let mut store = load(&rel);
        let v = ModelValue::from_sources(store.sources()).0;
        let mut removes = Vec::new();
        for t in ["c", "materials", "sims", "engines"] {
            for k in keys(&v, t) {
                removes.push(PatchOp::Remove {
                    path: format!("/{t}/{k}"),
                });
            }
        }
        step(&mut store, &rel, removes);
        let after = ModelValue::from_sources(store.sources()).0;
        for t in ["c", "materials", "sims", "engines"] {
            assert!(keys(&after, t).is_empty(), "{rel}: {t} not emptied");
        }
        step(&mut store, &rel, vec![add("/c/nose", nose.clone())]);
        step(
            &mut store,
            &rel,
            vec![add("/materials/alu", material.clone())],
        );
        step(&mut store, &rel, vec![add("/sims/first", sim.clone())]);
        step(
            &mut store,
            &rel,
            vec![add("/engines/first", engine.clone())],
        );
        let m = eval(store.sources(), &EvalOptions::default());
        let again = eval(&parse_all(&store.texts()), &EvalOptions::default());
        assert_eq!(model_hash(&m), model_hash(&again), "{rel}");
    }
}

/// The store path of the whole-table no-ops pinned in `rw-model`: they
/// succeed and write nothing (accepted in U10).
#[test]
fn whole_table_ops_on_an_absent_table_write_nothing() {
    let mut store = load("templates/minimum");
    let base = store.sources().clone();
    let cases = [
        PatchOp::Remove {
            path: "/engines".into(),
        },
        PatchOp::Test {
            path: "/engines".into(),
            value: json!({}),
        },
        PatchOp::Replace {
            path: "/engines".into(),
            value: json!({}),
        },
        PatchOp::Move {
            from: "/engines".into(),
            path: "/stage".into(),
        },
    ];
    for op in cases {
        let changes = store
            .apply(std::slice::from_ref(&op))
            .unwrap_or_else(|e| panic!("{op:?}: {e:?}"));
        assert!(changes.is_empty(), "{op:?}: {changes:?}");
        assert_eq!(store.sources(), &base, "{op:?}");
    }
}
