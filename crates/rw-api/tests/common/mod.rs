//! Shared helpers for the rw-api contract tests.
#![allow(dead_code, clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};

use serde_json::Value;

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

/// Validation errors of `instance` against `schema` (empty = valid).
pub fn errors(schema: &Value, instance: &Value) -> Vec<String> {
    let v = jsonschema::validator_for(schema).expect("schema compiles");
    v.iter_errors(instance)
        .map(|e| format!("{} at {}", e, e.instance_path()))
        .collect()
}

/// Every `*.json` file under `dir`, recursively, sorted.
pub fn json_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(json_files(&p));
            } else if p.extension().is_some_and(|x| x == "json") {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

pub fn read_json(p: &Path) -> Value {
    let text = std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}
