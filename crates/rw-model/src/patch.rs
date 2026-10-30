//! `PatchOp` application (R3.3, M1.23): RFC 6902 on the [`ModelValue`], the
//! id-keyed JSON form of a project's sources.
//!
//! The model value is one JSON object:
//!
//! - the merged `rocket.rw.toml` at the root (`/params/<name>`, `/variants`,
//!   `/stage/<id>`, `/c/<id>`, `/materials/<name>`, `/assert`, `/report`, ...),
//!   with the `params`, `variants`, `stage`, `c`, and `materials` tables of
//!   included `parts/*.rw.toml` merged in;
//! - `/configs/<id>`, `/sims/<id>`, `/engines/<id>`: one entry per
//!   `configs/<id>.rw.toml` (etc.);
//! - `/project`: the `rocketwright.toml` manifest.
//!
//! A path may also be an `rw:` ref (`rw:c/fins/span` is `/c/fins/span`;
//! `cfg` → `/configs`, `sim` → `/sims`, `eng` → `/engines`).
//!
//! [`apply_value`] is the raw RFC 6902 layer, shared with
//! `app/packages/contracts/src/patch.ts` through `schema/testdata/patches.json`.
//! [`apply_sources`] maps a [`SourceSet`] to a model value, applies the ops,
//! and splits the result back into files: an entry stays in the file that
//! defined it, and new entries go to the main model file (or
//! `configs/<id>.rw.toml`, ...).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::diag::{self, Diagnostic};
use crate::refs::parse_ref;
use crate::types::{
    ConfigDoc, EngineDoc, PatchError, PatchOp, ProjectManifest, RocketDoc, SimDoc, SourceDoc,
    SourceSet,
};

// ---- raw RFC 6902 ----------------------------------------------------------------

/// Why an op failed (the `err.kind` slugs of `schema/testdata/patches.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchErrorKind {
    InvalidPointer,
    NotFound,
    InvalidIndex,
    TestFailed,
    MoveIntoChild,
    /// The patched model does not match the source schema (sources layer only).
    SchemaError,
}

impl PatchErrorKind {
    pub const fn slug(self) -> &'static str {
        match self {
            PatchErrorKind::InvalidPointer => "invalid_pointer",
            PatchErrorKind::NotFound => "not_found",
            PatchErrorKind::InvalidIndex => "invalid_index",
            PatchErrorKind::TestFailed => "test_failed",
            PatchErrorKind::MoveIntoChild => "move_into_child",
            PatchErrorKind::SchemaError => "schema_error",
        }
    }
}

/// A failed op with its kind. Converts into the contract [`PatchError`]
/// (whose `message` starts with the kind slug).
#[derive(Debug, Clone, PartialEq)]
pub struct PatchFailure {
    pub op: u32,
    pub kind: PatchErrorKind,
    pub path: String,
    pub message: String,
}

impl From<PatchFailure> for PatchError {
    fn from(f: PatchFailure) -> Self {
        PatchError {
            op: f.op,
            path: f.path,
            message: format!("{}: {}", f.kind.slug(), f.message),
        }
    }
}

type Fail = (PatchErrorKind, String);

/// Parses a JSON pointer (or an `rw:` ref) into reference tokens.
pub fn parse_pointer(p: &str) -> Result<Vec<String>, Fail> {
    if p.starts_with("rw:") {
        let parts = parse_ref(p).map_err(|e| {
            (
                PatchErrorKind::InvalidPointer,
                format!("`{p}` is not a valid ref ({e})"),
            )
        })?;
        let ptr = parts.model_pointer().ok_or_else(|| {
            (
                PatchErrorKind::InvalidPointer,
                format!("`{p}` does not address an editable model field (use rw:c|cfg|sim|eng without #anchor or @version)"),
            )
        })?;
        return parse_pointer(&ptr);
    }
    if p.is_empty() {
        return Ok(Vec::new());
    }
    let Some(body) = p.strip_prefix('/') else {
        return Err((
            PatchErrorKind::InvalidPointer,
            format!("`{p}` must start with `/` (e.g. `/c/fins/span`)"),
        ));
    };
    body.split('/')
        .map(|t| {
            let mut out = String::new();
            let mut it = t.chars();
            while let Some(c) = it.next() {
                if c == '~' {
                    match it.next() {
                        Some('0') => out.push('~'),
                        Some('1') => out.push('/'),
                        _ => {
                            return Err((
                                PatchErrorKind::InvalidPointer,
                                format!("bad escape in `{p}` (use ~0 for ~ and ~1 for /)"),
                            ));
                        }
                    }
                } else {
                    out.push(c);
                }
            }
            Ok(out)
        })
        .collect()
}

fn index(tok: &str, len: usize, allow_end: bool) -> Result<usize, Fail> {
    let bad = || {
        (
            PatchErrorKind::InvalidIndex,
            format!("`{tok}` is not a valid index for an array of {len}"),
        )
    };
    if tok == "-" {
        return if allow_end { Ok(len) } else { Err(bad()) };
    }
    if tok.is_empty()
        || !tok.bytes().all(|b| b.is_ascii_digit())
        || (tok.len() > 1 && tok.starts_with('0'))
    {
        return Err(bad());
    }
    let i: usize = tok.parse().map_err(|_| bad())?;
    if i > len || (i == len && !allow_end) {
        return Err(bad());
    }
    Ok(i)
}

fn not_found(toks: &[String]) -> Fail {
    (
        PatchErrorKind::NotFound,
        format!("`/{}` does not exist", toks.join("/")),
    )
}

fn get_mut<'v>(doc: &'v mut Value, toks: &[String]) -> Result<&'v mut Value, Fail> {
    let mut v = doc;
    for (k, t) in toks.iter().enumerate() {
        v = match v {
            Value::Object(m) => m.get_mut(t).ok_or_else(|| not_found(&toks[..=k]))?,
            Value::Array(a) => {
                let i = index(t, a.len(), false)?;
                &mut a[i]
            }
            _ => return Err(not_found(&toks[..=k])),
        };
    }
    Ok(v)
}

fn get<'v>(doc: &'v Value, toks: &[String]) -> Result<&'v Value, Fail> {
    let mut v = doc;
    for (k, t) in toks.iter().enumerate() {
        v = match v {
            Value::Object(m) => m.get(t).ok_or_else(|| not_found(&toks[..=k]))?,
            Value::Array(a) => &a[index(t, a.len(), false)?],
            _ => return Err(not_found(&toks[..=k])),
        };
    }
    Ok(v)
}

fn add(doc: &mut Value, toks: &[String], value: Value) -> Result<(), Fail> {
    let Some((last, parent)) = toks.split_last() else {
        *doc = value;
        return Ok(());
    };
    match get_mut(doc, parent)? {
        Value::Object(m) => {
            m.insert(last.clone(), value);
        }
        Value::Array(a) => {
            let i = index(last, a.len(), true)?;
            a.insert(i, value);
        }
        _ => return Err(not_found(toks)),
    }
    Ok(())
}

fn remove(doc: &mut Value, toks: &[String]) -> Result<Value, Fail> {
    let Some((last, parent)) = toks.split_last() else {
        return Err((
            PatchErrorKind::InvalidPointer,
            "cannot remove the whole document".into(),
        ));
    };
    match get_mut(doc, parent)? {
        Value::Object(m) => m.shift_remove(last).ok_or_else(|| not_found(toks)),
        Value::Array(a) => {
            let i = index(last, a.len(), false)?;
            Ok(a.remove(i))
        }
        _ => Err(not_found(toks)),
    }
}

/// JSON equality with numbers compared by value (`4 == 4.0`).
pub fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => a == b,
    }
}

fn apply_one(doc: &mut Value, op: &PatchOp) -> Result<(), Fail> {
    match op {
        PatchOp::Add { path, value } => add(doc, &parse_pointer(path)?, value.clone()),
        PatchOp::Remove { path } => remove(doc, &parse_pointer(path)?).map(drop),
        PatchOp::Replace { path, value } => {
            let t = parse_pointer(path)?;
            *get_mut(doc, &t)? = value.clone();
            Ok(())
        }
        PatchOp::Move { from, path } => {
            let f = parse_pointer(from)?;
            let t = parse_pointer(path)?;
            if f == t {
                return get(doc, &f).map(drop);
            }
            if t.len() > f.len() && t[..f.len()] == f[..] {
                return Err((
                    PatchErrorKind::MoveIntoChild,
                    format!("cannot move `{from}` into its own child `{path}`"),
                ));
            }
            let v = remove(doc, &f)?;
            add(doc, &t, v)
        }
        PatchOp::Copy { from, path } => {
            let v = get(doc, &parse_pointer(from)?)?.clone();
            add(doc, &parse_pointer(path)?, v)
        }
        PatchOp::Test { path, value } => {
            let t = parse_pointer(path)?;
            let cur = get(doc, &t)?;
            if json_eq(cur, value) {
                Ok(())
            } else {
                Err((
                    PatchErrorKind::TestFailed,
                    format!("`{path}` is {cur}, not {value}"),
                ))
            }
        }
    }
}

fn op_path(op: &PatchOp) -> &str {
    match op {
        PatchOp::Add { path, .. }
        | PatchOp::Remove { path }
        | PatchOp::Replace { path, .. }
        | PatchOp::Move { path, .. }
        | PatchOp::Copy { path, .. }
        | PatchOp::Test { path, .. } => path,
    }
}

/// Applies `ops` atomically to a JSON document (RFC 6902).
pub fn apply_value(doc: &Value, ops: &[PatchOp]) -> Result<Value, PatchFailure> {
    let mut out = doc.clone();
    for (i, op) in ops.iter().enumerate() {
        apply_one(&mut out, op).map_err(|(kind, message)| PatchFailure {
            op: i as u32,
            kind,
            path: op_path(op).to_string(),
            message,
        })?;
    }
    Ok(out)
}

// ---- the model value ------------------------------------------------------------

/// Root keys that hold one entry per file under `configs/`, `sims/`, `engines/`.
const FILE_COLLECTIONS: [(&str, &str); 3] = [
    ("configs", "configs/"),
    ("sims", "sims/"),
    ("engines", "engines/"),
];

/// Rocket-document tables that included part files contribute to.
pub const MERGED_TABLES: [&str; 5] = ["params", "variants", "stage", "c", "materials"];

/// The id-keyed JSON form of a project's sources (see the module docs).
#[derive(Debug, Clone, PartialEq)]
pub struct ModelValue(pub Value);

/// Where each part of a [`ModelValue`] came from.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Origins {
    /// The main model file (`rocket.rw.toml`).
    pub main: Option<String>,
    /// `(table, key)` → file, for [`MERGED_TABLES`] entries.
    pub tables: BTreeMap<(String, String), String>,
    /// Included part files, in include order.
    pub parts: Vec<String>,
    /// `(collection, id)` → file for configs, sims, and engines.
    pub files: BTreeMap<(String, String), String>,
    pub project: Option<String>,
}

impl Origins {
    /// The file that defines a model-value path, if known.
    pub fn file_of(&self, pointer: &str) -> Option<&str> {
        let mut it = pointer.trim_start_matches('/').split('/');
        let (a, b) = (it.next()?, it.next());
        if a == "project" {
            return self.project.as_deref();
        }
        if let Some(b) = b {
            let key = (a.to_string(), b.to_string());
            if let Some(f) = self.tables.get(&key).or_else(|| self.files.get(&key)) {
                return Some(f);
            }
        }
        if FILE_COLLECTIONS.iter().any(|(c, _)| *c == a) {
            return None;
        }
        self.main.as_deref()
    }
}

/// The id of `configs/<id>.rw.toml` (or `.rw.json`, `.json`, `.toml`).
pub fn id_from_path(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    for suf in [".rw.toml", ".rw.json", ".toml", ".json"] {
        if let Some(s) = name.strip_suffix(suf) {
            return s.to_string();
        }
    }
    name.to_string()
}

/// The main model file of a source set.
pub fn main_rocket_path(sources: &SourceSet) -> Option<String> {
    let is_rocket = |p: &str| matches!(sources.docs.get(p), Some(SourceDoc::Rocket(_)));
    let manifest_model = sources.docs.values().find_map(|d| match d {
        SourceDoc::Project(m) => m.model.clone(),
        _ => None,
    });
    if let Some(m) = manifest_model.filter(|m| is_rocket(m)) {
        return Some(m);
    }
    if is_rocket("rocket.rw.toml") {
        return Some("rocket.rw.toml".into());
    }
    sources
        .docs
        .iter()
        .find(|(p, d)| matches!(d, SourceDoc::Rocket(_)) && !p.starts_with("parts/"))
        .map(|(p, _)| p.clone())
}

fn to_json<T: Serialize>(t: &T) -> Value {
    serde_json::to_value(t).unwrap_or(Value::Null)
}

/// Builds the model value of a source set, with duplicate-id and
/// missing-include diagnostics.
pub fn merge(sources: &SourceSet) -> (ModelValue, Origins, Vec<Diagnostic>) {
    let mut origins = Origins::default();
    let mut diags = Vec::new();
    let mut root = Map::new();
    if let Some(main) = main_rocket_path(sources)
        && let Some(SourceDoc::Rocket(doc)) = sources.docs.get(&main)
    {
        if let Value::Object(m) = to_json(doc) {
            root = m;
        }
        for t in MERGED_TABLES {
            if let Some(Value::Object(m)) = root.get(t) {
                for k in m.keys() {
                    origins.tables.insert((t.into(), k.clone()), main.clone());
                }
            }
        }
        let mut seen = BTreeSet::from([main.clone()]);
        let mut queue: Vec<(String, String)> = doc
            .include
            .iter()
            .map(|i| (main.clone(), i.clone()))
            .collect();
        queue.reverse();
        while let Some((from, inc)) = queue.pop() {
            if !seen.insert(inc.clone()) {
                continue;
            }
            let Some(SourceDoc::Rocket(part)) = sources.docs.get(&inc) else {
                let mut d = Diagnostic::new(
                    diag::E_INCLUDE,
                    "/include".to_string(),
                    format!("`{inc}` is not a part file in this project"),
                )
                .with_hint("create the file under parts/ or remove it from `include`");
                d.file = Some(from.clone());
                diags.push(d);
                continue;
            };
            origins.parts.push(inc.clone());
            let pv = to_json(part);
            for t in MERGED_TABLES {
                let Some(Value::Object(entries)) = pv.get(t) else {
                    continue;
                };
                let target = root
                    .entry(t.to_string())
                    .or_insert_with(|| Value::Object(Map::new()));
                let Value::Object(target) = target else {
                    continue;
                };
                for (k, v) in entries {
                    let key = (t.to_string(), k.clone());
                    if let Some(first) = origins.tables.get(&key) {
                        let mut d = Diagnostic::new(
                            diag::E_DUPLICATE_ID,
                            format!("/{t}/{k}"),
                            format!("`{t}.{k}` is also defined in `{first}`"),
                        )
                        .with_hint("rename one of them; ids are unique across part files");
                        d.file = Some(inc.clone());
                        diags.push(d);
                        continue;
                    }
                    target.insert(k.clone(), v.clone());
                    origins.tables.insert(key, inc.clone());
                }
            }
            for i in part.include.iter().rev() {
                queue.push((inc.clone(), i.clone()));
            }
        }
        origins.main = Some(main);
    }
    for (coll, _) in FILE_COLLECTIONS {
        let mut m = Map::new();
        for (path, d) in &sources.docs {
            let v = match (coll, d) {
                ("configs", SourceDoc::Config(c)) => to_json(c),
                ("sims", SourceDoc::Sim(s)) => to_json(s),
                ("engines", SourceDoc::Engine(e)) => to_json(e),
                _ => continue,
            };
            let id = id_from_path(path);
            origins
                .files
                .insert((coll.into(), id.clone()), path.clone());
            m.insert(id, v);
        }
        if !m.is_empty() {
            root.insert(coll.to_string(), Value::Object(m));
        }
    }
    if let Some((path, SourceDoc::Project(p))) = sources
        .docs
        .iter()
        .find(|(_, d)| matches!(d, SourceDoc::Project(_)))
    {
        origins.project = Some(path.clone());
        root.insert("project".into(), to_json(p));
    }
    (ModelValue(Value::Object(root)), origins, diags)
}

impl ModelValue {
    /// The model value of a source set (diagnostics dropped; see [`merge`]).
    pub fn from_sources(sources: &SourceSet) -> ModelValue {
        merge(sources).0
    }

    /// Splits the value back into source files, keeping each entry in the
    /// file that defined it in `base`.
    pub fn to_sources(&self, base: &SourceSet) -> Result<SourceSet, (String, String)> {
        let (_, origins, _) = merge(base);
        let Value::Object(root) = &self.0 else {
            return Err(("".into(), "the model value must be an object".into()));
        };
        let mut out = SourceSet::default();
        // Docs that are not part of the model value pass through unchanged.
        let merged: BTreeSet<&str> = origins
            .main
            .iter()
            .chain(origins.parts.iter())
            .chain(origins.files.values())
            .chain(origins.project.iter())
            .map(String::as_str)
            .collect();
        for (p, d) in &base.docs {
            if !merged.contains(p.as_str()) {
                out.docs.insert(p.clone(), d.clone());
            }
        }
        if let Some(Value::Object(c)) = root.get("c") {
            for id in c.keys() {
                if !valid_id(id) {
                    return Err((
                        format!("/c/{id}"),
                        format!(
                            "`{id}` is not a valid id (lowercase letters, digits, `_`; starts with a letter)"
                        ),
                    ));
                }
            }
        }
        // Rocket documents.
        let main = origins
            .main
            .clone()
            .unwrap_or_else(|| "rocket.rw.toml".into());
        let mut docs: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
        let mut main_obj = Map::new();
        for (k, v) in root {
            if FILE_COLLECTIONS.iter().any(|(c, _)| c == k)
                || k == "project"
                || MERGED_TABLES.contains(&k.as_str())
            {
                continue;
            }
            main_obj.insert(k.clone(), v.clone());
        }
        docs.insert(main.clone(), main_obj);
        for part in &origins.parts {
            let mut obj = match base.docs.get(part) {
                Some(SourceDoc::Rocket(r)) => match to_json(r) {
                    Value::Object(m) => m,
                    _ => Map::new(),
                },
                _ => Map::new(),
            };
            for t in MERGED_TABLES {
                obj.shift_remove(t);
            }
            docs.insert(part.clone(), obj);
        }
        for t in MERGED_TABLES {
            let Some(Value::Object(entries)) = root.get(t) else {
                continue;
            };
            for (k, v) in entries {
                let owner = origins
                    .tables
                    .get(&(t.to_string(), k.clone()))
                    .filter(|o| docs.contains_key(*o))
                    .cloned()
                    .unwrap_or_else(|| main.clone());
                let doc = docs.entry(owner).or_default();
                let tab = doc
                    .entry(t.to_string())
                    .or_insert_with(|| Value::Object(Map::new()));
                if let Value::Object(tab) = tab {
                    tab.insert(k.clone(), v.clone());
                }
            }
        }
        let skip_empty_main = origins.main.is_none() && docs.get(&main).is_some_and(Map::is_empty);
        for (path, obj) in docs {
            if skip_empty_main && path == main {
                continue;
            }
            let doc: RocketDoc = typed(Value::Object(obj), &path, "")?;
            out.docs.insert(path, SourceDoc::Rocket(doc));
        }
        for (coll, dir) in FILE_COLLECTIONS {
            let Some(entries) = root.get(coll) else {
                continue;
            };
            let Value::Object(entries) = entries else {
                return Err((
                    format!("/{coll}"),
                    format!("`{coll}` must be a table keyed by id"),
                ));
            };
            for (id, v) in entries {
                let path = origins
                    .files
                    .get(&(coll.to_string(), id.clone()))
                    .cloned()
                    .unwrap_or_else(|| format!("{dir}{id}.rw.toml"));
                let ptr = format!("/{coll}/{id}");
                let doc = match coll {
                    "configs" => SourceDoc::Config(typed::<ConfigDoc>(v.clone(), &path, &ptr)?),
                    "sims" => SourceDoc::Sim(typed::<SimDoc>(v.clone(), &path, &ptr)?),
                    _ => SourceDoc::Engine(typed::<EngineDoc>(v.clone(), &path, &ptr)?),
                };
                out.docs.insert(path, doc);
            }
        }
        if let Some(p) = root.get("project") {
            let path = origins
                .project
                .clone()
                .unwrap_or_else(|| "rocketwright.toml".into());
            out.docs.insert(
                path.clone(),
                SourceDoc::Project(typed::<ProjectManifest>(p.clone(), &path, "/project")?),
            );
        }
        Ok(out)
    }
}

/// True for an id matching [`crate::ID_PATTERN`].
pub fn valid_id(id: &str) -> bool {
    let mut b = id.bytes();
    b.next().is_some_and(|c| c.is_ascii_lowercase())
        && b.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

fn typed<T: serde::de::DeserializeOwned>(
    v: Value,
    file: &str,
    ptr: &str,
) -> Result<T, (String, String)> {
    // Locate a bad component precisely before reporting the whole document.
    if ptr.is_empty()
        && let Some(Value::Object(c)) = v.get("c")
    {
        for (id, comp) in c {
            if let Err(e) = serde_json::from_value::<crate::types::Component>(comp.clone()) {
                return Err((format!("/c/{id}"), format!("{file}: {e}")));
            }
        }
    }
    serde_json::from_value(v).map_err(|e| (ptr.to_string(), format!("{file}: {e}")))
}

/// Applies `ops` to a source set: model value → RFC 6902 → split back.
pub fn apply_sources(sources: &SourceSet, ops: &[PatchOp]) -> Result<SourceSet, PatchError> {
    let value = ModelValue::from_sources(sources);
    let patched = apply_value(&value.0, ops).map_err(PatchError::from)?;
    ModelValue(patched)
        .to_sources(sources)
        .map_err(|(path, message)| {
            PatchFailure {
                op: ops.len().saturating_sub(1) as u32,
                kind: PatchErrorKind::SchemaError,
                path,
                message,
            }
            .into()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Component, ComponentKind};
    use serde_json::json;

    const VECTORS: &str = include_str!("../../../schema/testdata/patches.json");

    #[test]
    fn shared_vectors() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        let rows = v["vectors"].as_array().unwrap();
        assert!(rows.len() >= 30);
        for row in rows {
            let name = row["name"].as_str().unwrap();
            let ops: Vec<PatchOp> = serde_json::from_value(row["patch"].clone()).unwrap();
            match (row.get("ok"), apply_value(&row["doc"], &ops)) {
                (Some(ok), Ok(got)) => assert!(json_eq(&got, ok), "{name}: {got}"),
                (Some(_), Err(e)) => panic!("{name}: {e:?}"),
                (None, Ok(got)) => panic!("{name}: expected an error, got {got}"),
                (None, Err(e)) => {
                    assert_eq!(e.op, row["err"]["op"].as_u64().unwrap() as u32, "{name}");
                    assert_eq!(e.kind.slug(), row["err"]["kind"], "{name}: {e:?}");
                }
            }
        }
    }

    fn project() -> SourceSet {
        let rocket: RocketDoc = serde_json::from_value(json!({
            "include": ["parts/fin_can.rw.toml"],
            "params": {"span": {"value": "90 mm"}},
            "c": {"body": {"type": "body_tube", "length": "300 mm", "od": "54 mm"}},
        }))
        .unwrap();
        let part: RocketDoc = serde_json::from_value(json!({
            "c": {"fins": {"type": "trapezoidal_fin_set", "attach": {"to": "body.aft", "at": "root_te"},
                "count": 3, "root_chord": "100 mm", "tip_chord": "50 mm", "span": "= params.span",
                "sweep": "40 mm", "thickness": "3 mm"}},
        }))
        .unwrap();
        let cfg: ConfigDoc = serde_json::from_value(json!({"name": "Baseline"})).unwrap();
        let mut s = SourceSet::default();
        s.docs
            .insert("rocket.rw.toml".into(), SourceDoc::Rocket(rocket));
        s.docs
            .insert("parts/fin_can.rw.toml".into(), SourceDoc::Rocket(part));
        s.docs
            .insert("configs/baseline.rw.toml".into(), SourceDoc::Config(cfg));
        s
    }

    #[test]
    fn model_value_round_trips() {
        let s = project();
        let mv = ModelValue::from_sources(&s);
        assert_eq!(mv.0["c"]["fins"]["count"], json!(3));
        assert_eq!(mv.0["configs"]["baseline"]["name"], json!("Baseline"));
        assert_eq!(mv.to_sources(&s).unwrap(), s);
    }

    #[test]
    fn patch_keeps_entries_in_their_files() {
        let s = project();
        let out = crate::types::apply(
            &s,
            &[
                PatchOp::Replace {
                    path: "rw:c/fins/count".into(),
                    value: json!(4),
                },
                PatchOp::Add {
                    path: "/c/lug".into(),
                    value: json!({"type": "launch_lug", "attach": {"to": "body.outer"}, "length": "50 mm", "od": "8 mm"}),
                },
                PatchOp::Add {
                    path: "/configs/long".into(),
                    value: json!({"name": "Long"}),
                },
            ],
        )
        .unwrap();
        let SourceDoc::Rocket(part) = &out.docs["parts/fin_can.rw.toml"] else {
            panic!()
        };
        let fins: &Component = &part.c["fins"];
        let ComponentKind::TrapezoidalFinSet(f) = &fins.kind else {
            panic!()
        };
        assert_eq!(f.count, 4);
        let SourceDoc::Rocket(main) = &out.docs["rocket.rw.toml"] else {
            panic!()
        };
        assert!(main.c.contains_key("lug") && !main.c.contains_key("fins"));
        assert!(matches!(
            out.docs["configs/long.rw.toml"],
            SourceDoc::Config(_)
        ));
    }

    #[test]
    fn rename_moves_within_its_file_and_removal_deletes_files() {
        let s = project();
        let out = crate::types::apply(
            &s,
            &[
                PatchOp::Move {
                    from: "/c/fins".into(),
                    path: "/c/fin_set".into(),
                },
                PatchOp::Remove {
                    path: "rw:cfg/baseline".into(),
                },
            ],
        )
        .unwrap();
        let SourceDoc::Rocket(part) = &out.docs["parts/fin_can.rw.toml"] else {
            panic!()
        };
        // A renamed id is a new entry: it lands in the main file.
        assert!(part.c.is_empty());
        let SourceDoc::Rocket(main) = &out.docs["rocket.rw.toml"] else {
            panic!()
        };
        assert!(main.c.contains_key("fin_set"));
        assert!(!out.docs.contains_key("configs/baseline.rw.toml"));
    }

    #[test]
    fn schema_errors_name_the_component() {
        let s = project();
        let err = crate::types::apply(
            &s,
            &[PatchOp::Replace {
                path: "/c/fins/count".into(),
                value: json!("four"),
            }],
        )
        .unwrap_err();
        assert_eq!(err.op, 0);
        assert_eq!(err.path, "/c/fins");
        assert!(err.message.starts_with("schema_error"), "{}", err.message);
        let err = crate::types::apply(
            &s,
            &[PatchOp::Copy {
                from: "/c/body".into(),
                path: "/c/Body".into(),
            }],
        )
        .unwrap_err();
        assert_eq!(err.path, "/c/Body");
        let err = crate::types::apply(
            &s,
            &[PatchOp::Remove {
                path: "/c/nope".into(),
            }],
        )
        .unwrap_err();
        assert!(err.message.starts_with("not_found"));
    }
}
