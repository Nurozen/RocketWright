//! `TomlStore`: the project's source files as comment-preserving documents,
//! and the decor-preserving application of [`PatchOp`]s to them (M1.25,
//! R2.12, Acceptance 4).
//!
//! `rw-model` defines what a patch *means*: [`rw_model::apply`] maps the
//! sources to the id-keyed model value, applies RFC 6902, and splits the
//! result back into files. The store makes the files say exactly that while
//! touching as little text as possible:
//!
//! 1. compute the target [`SourceSet`] with [`rw_model::apply`] (the single
//!    definition of patch semantics, shared with WASM previews, invariant I4);
//! 2. replay `move` ops whose source and destination live in the same file
//!    as key moves in the `toml_edit` document, so a renamed component keeps
//!    its comments (a renamed config file keeps its document);
//! 3. diff the typed JSON of every file against its target and apply only the
//!    changed leaves through the `tomlpatch` helpers (old decor is kept, new
//!    tables are explicit headers, implicit parents stay implicit);
//! 4. re-parse every changed file and check it equals the target document. A
//!    file that does not is rebuilt from the target (flagged `rewritten`);
//!    the property test `tests/patch_equiv.rs` asserts that never happens.
//!
//! Keys the schema does not know (reported as `RW-W001`) are never in the
//! typed JSON, so the diff never touches them. Every write is TOML 1.0.

use std::collections::{BTreeMap, BTreeSet};

use rw_model::diag::{self, Diagnostic};
use rw_model::patch::{MERGED_TABLES, Origins, json_eq, merge, parse_pointer};
use rw_model::source::parse_source;
use rw_model::{PatchError, PatchOp, SourceDoc, SourceSet};
use serde_json::{Map, Value as Json};
use toml_edit::{
    Array, ArrayOfTables, Decor, DocumentMut, InlineTable, Item, Key, Table, TableLike, Value,
};

use crate::tomlpatch::{
    Seg, default_array_decor, insert_new, max_position, replace_preserving, surface_implicit,
    to_toml10_string,
};

/// Root keys of the model value that hold one file per entry.
const FILE_COLLECTIONS: [(&str, &str); 3] = [
    ("configs", "configs/"),
    ("sims", "sims/"),
    ("engines", "engines/"),
];

/// Objects this deep (path length from the file root) or shallower become
/// `[header]` tables; deeper ones are inline tables (`attach = { .. }`).
const HEADER_DEPTH: usize = 2;

/// One source file: a `toml_edit` document, or the raw JSON of a JSON twin.
#[derive(Debug, Clone)]
enum Doc {
    Toml(DocumentMut),
    Json(Json),
}

impl Doc {
    fn empty(path: &str) -> Doc {
        if is_json(path) {
            Doc::Json(Json::Object(Map::new()))
        } else {
            Doc::Toml(DocumentMut::new())
        }
    }

    fn render(&self) -> String {
        match self {
            Doc::Toml(d) => to_toml10_string(d),
            Doc::Json(j) => {
                let mut s = serde_json::to_string_pretty(j).unwrap_or_default();
                s.push('\n');
                s
            }
        }
    }
}

fn is_json(path: &str) -> bool {
    path.ends_with(".json")
}

/// A file the store changed: new text, or `None` when the file is deleted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    /// Project-relative path.
    pub path: String,
    /// The full new text; `None` deletes the file.
    pub text: Option<String>,
    /// The minimal edit did not reproduce the target, so the file was rebuilt
    /// from the model (comments lost). Never expected; tests assert `false`.
    pub rewritten: bool,
}

/// The project's source files, kept as editable documents in sync with their
/// parsed [`SourceSet`].
#[derive(Debug, Clone, Default)]
pub struct TomlStore {
    docs: BTreeMap<String, Doc>,
    sources: SourceSet,
}

impl TomlStore {
    /// An empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Loads `(project-relative path, text)` pairs. Every file must parse as
    /// a RocketWright source (`rocketwright.toml`, `*.rw.toml`, JSON twins).
    pub fn load<I, P, T>(files: I) -> Result<Self, Vec<Diagnostic>>
    where
        I: IntoIterator<Item = (P, T)>,
        P: Into<String>,
        T: AsRef<str>,
    {
        let mut store = Self::new();
        let mut diags = Vec::new();
        for (path, text) in files {
            if let Err(d) = store.insert(path, text.as_ref()) {
                diags.extend(d);
            }
        }
        if diags.is_empty() {
            Ok(store)
        } else {
            Err(diags)
        }
    }

    /// Adds or replaces one file (e.g. after an external edit). On error the
    /// store is unchanged.
    pub fn insert(&mut self, path: impl Into<String>, text: &str) -> Result<(), Vec<Diagnostic>> {
        let path = path.into();
        let parsed = parse_source(&path, text)?;
        let doc = if is_json(&path) {
            Doc::Json(serde_json::from_str(text).map_err(|e| vec![parse_diag(&path, e)])?)
        } else {
            Doc::Toml(
                text.parse::<DocumentMut>()
                    .map_err(|e| vec![parse_diag(&path, e)])?,
            )
        };
        self.docs.insert(path.clone(), doc);
        self.sources.docs.insert(path, parsed);
        Ok(())
    }

    /// Forgets a file (e.g. after an external delete).
    pub fn remove(&mut self, path: &str) -> bool {
        self.sources.docs.remove(path);
        self.docs.remove(path).is_some()
    }

    /// The parsed sources, always in sync with the documents.
    pub fn sources(&self) -> &SourceSet {
        &self.sources
    }

    /// Project-relative paths of every file, sorted.
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.docs.keys().map(String::as_str)
    }

    /// The current text of a file (TOML 1.0, comments and layout kept).
    pub fn text(&self, path: &str) -> Option<String> {
        self.docs.get(path).map(Doc::render)
    }

    /// Every file's text, keyed by path.
    pub fn texts(&self) -> BTreeMap<String, String> {
        self.docs
            .iter()
            .map(|(p, d)| (p.clone(), d.render()))
            .collect()
    }

    /// Applies `ops` atomically and returns the changed files. On error the
    /// store is unchanged.
    pub fn apply(&mut self, ops: &[PatchOp]) -> Result<Vec<FileChange>, PatchError> {
        let (next, changes) = self.preview(ops)?;
        *self = next;
        Ok(changes)
    }

    /// The store after `ops`, and the file changes, without modifying `self`
    /// (dry run).
    pub fn preview(&self, ops: &[PatchOp]) -> Result<(TomlStore, Vec<FileChange>), PatchError> {
        let target = rw_model::apply(&self.sources, ops)?;
        let (_, origins, _) = merge(&self.sources);
        let mut docs = self.docs.clone();
        let mut base: BTreeMap<String, Json> = self
            .sources
            .docs
            .iter()
            .map(|(p, d)| (p.clone(), doc_json(d)))
            .collect();
        let touched = replay_moves(&mut docs, &mut base, &origins, ops);
        self.materialize(target, docs, base, &touched, ops.len())
    }

    /// The store whose sources are exactly `target`, and the file changes,
    /// without modifying `self`: each file keeps its decor where its typed
    /// JSON is unchanged, new files are written fresh, and files not in
    /// `target` are deleted (`rw import` replacing a model).
    pub fn preview_target(
        &self,
        target: SourceSet,
    ) -> Result<(TomlStore, Vec<FileChange>), PatchError> {
        let base: BTreeMap<String, Json> = self
            .sources
            .docs
            .iter()
            .map(|(p, d)| (p.clone(), doc_json(d)))
            .collect();
        self.materialize(target, self.docs.clone(), base, &BTreeSet::new(), 1)
    }

    fn materialize(
        &self,
        target: SourceSet,
        mut docs: BTreeMap<String, Doc>,
        base: BTreeMap<String, Json>,
        touched: &BTreeSet<String>,
        nops: usize,
    ) -> Result<(TomlStore, Vec<FileChange>), PatchError> {
        let paths: BTreeSet<String> = (self.docs.keys())
            .chain(docs.keys())
            .chain(target.docs.keys())
            .cloned()
            .collect();
        let mut changes = Vec::new();
        for path in paths {
            let Some(want_doc) = target.docs.get(&path) else {
                docs.remove(&path);
                if self.docs.contains_key(&path) {
                    changes.push(FileChange {
                        path,
                        text: None,
                        rewritten: false,
                    });
                }
                continue;
            };
            let want = doc_json(want_doc);
            let existed = docs.contains_key(&path);
            let have = base
                .get(&path)
                .cloned()
                .unwrap_or_else(|| Json::Object(Map::new()));
            let mut edits = Vec::new();
            diff(&have, &want, &mut Vec::new(), &mut edits);
            if existed && edits.is_empty() && !touched.contains(&path) {
                continue;
            }
            let doc = docs
                .entry(path.clone())
                .or_insert_with(|| Doc::empty(&path));
            let mut rewritten = false;
            let ok = apply_edits(doc, &edits).is_ok() && reparses_to(&path, doc, want_doc);
            if !ok {
                let mut fresh = Doc::empty(&path);
                let mut all = Vec::new();
                diff(&Json::Object(Map::new()), &want, &mut Vec::new(), &mut all);
                let fresh_ok =
                    apply_edits(&mut fresh, &all).is_ok() && reparses_to(&path, &fresh, want_doc);
                if !fresh_ok {
                    return Err(PatchError {
                        op: nops.saturating_sub(1) as u32,
                        path: String::new(),
                        message: format!(
                            "schema_error: `{path}` cannot be written as TOML 1.0 (e.g. an integer above 2^63)"
                        ),
                    });
                }
                *doc = fresh;
                rewritten = true;
            }
            let text = doc.render();
            if existed && self.docs.get(&path).map(Doc::render).as_deref() == Some(text.as_str()) {
                continue;
            }
            changes.push(FileChange {
                path,
                text: Some(text),
                rewritten,
            });
        }
        Ok((
            TomlStore {
                docs,
                sources: target,
            },
            changes,
        ))
    }
}

fn parse_diag(path: &str, e: impl std::fmt::Display) -> Diagnostic {
    let mut d = Diagnostic::new(diag::E_PARSE, None, e.to_string());
    d.file = Some(path.to_string());
    d
}

/// The typed JSON of one document (what the diff compares).
fn doc_json(d: &SourceDoc) -> Json {
    let v = match d {
        SourceDoc::Project(x) => serde_json::to_value(x),
        SourceDoc::Rocket(x) => serde_json::to_value(x),
        SourceDoc::Config(x) => serde_json::to_value(x),
        SourceDoc::Sim(x) => serde_json::to_value(x),
        SourceDoc::Engine(x) => serde_json::to_value(x),
    };
    v.unwrap_or(Json::Null)
}

fn reparses_to(path: &str, doc: &Doc, want: &SourceDoc) -> bool {
    parse_source(path, &doc.render()).is_ok_and(|got| &got == want)
}

// ---- move replay ------------------------------------------------------------------

/// The file that holds a model-value path (as `rw-model` assigns it) and the
/// path inside that file. New merged-table entries go to the main file.
fn locate(origins: &Origins, toks: &[String]) -> Option<(String, Vec<String>)> {
    let first = toks.first()?;
    if let Some((coll, dir)) = FILE_COLLECTIONS.iter().find(|(c, _)| c == first) {
        let id = toks.get(1)?;
        let file = origins
            .files
            .get(&(coll.to_string(), id.clone()))
            .cloned()
            .unwrap_or_else(|| format!("{dir}{id}.rw.toml"));
        return Some((file, toks[2..].to_vec()));
    }
    if first == "project" {
        let file = origins
            .project
            .clone()
            .unwrap_or_else(|| "rocketwright.toml".into());
        return Some((file, toks[1..].to_vec()));
    }
    if MERGED_TABLES.contains(&first.as_str())
        && let Some(id) = toks.get(1)
        && let Some(file) = origins.tables.get(&(first.clone(), id.clone()))
    {
        return Some((file.clone(), toks.to_vec()));
    }
    let main = origins
        .main
        .clone()
        .unwrap_or_else(|| "rocket.rw.toml".into());
    Some((main, toks.to_vec()))
}

/// Replays `move` ops as item moves in the documents, so a moved entry keeps
/// its comments (also across files, e.g. a part's component renamed into the
/// main file), and whole-file moves as document renames. Each move is mirrored
/// on the typed JSON in `base`. Best effort: anything it skips, the diff
/// does. Returns the files it touched.
fn replay_moves(
    docs: &mut BTreeMap<String, Doc>,
    base: &mut BTreeMap<String, Json>,
    origins: &Origins,
    ops: &[PatchOp],
) -> BTreeSet<String> {
    let mut touched = BTreeSet::new();
    for op in ops {
        let PatchOp::Move { from, path } = op else {
            continue;
        };
        let (Ok(f), Ok(t)) = (parse_pointer(from), parse_pointer(path)) else {
            continue;
        };
        let (Some((ff, ft)), Some((tf, tt))) = (locate(origins, &f), locate(origins, &t)) else {
            continue;
        };
        if (ff == tf && ft == tt) || is_json(&ff) != is_json(&tf) {
            continue;
        }
        if ft.is_empty() && tt.is_empty() {
            if !docs.contains_key(&tf)
                && let Some(doc) = docs.remove(&ff)
            {
                docs.insert(tf.clone(), doc);
                if let Some(b) = base.remove(&ff) {
                    base.insert(tf.clone(), b);
                }
                touched.insert(ff);
                touched.insert(tf);
            }
            continue;
        }
        if ft.is_empty() || tt.is_empty() || (ff == tf && tt.starts_with(&ft)) {
            continue;
        }
        if replay_one(docs, base, (&ff, &ft), (&tf, &tt)).is_some() {
            touched.insert(ff);
            touched.insert(tf);
        }
    }
    touched
}

/// Moves one item between (or within) documents and their typed JSON. All
/// or nothing.
fn replay_one(
    docs: &mut BTreeMap<String, Doc>,
    base: &mut BTreeMap<String, Json>,
    (ff, ft): (&String, &[String]),
    (tf, tt): (&String, &[String]),
) -> Option<()> {
    // Typed JSON first, on copies.
    let mut bf = base.get(ff)?.clone();
    let item = json_take(&mut bf, ft)?;
    let mut bt = if ff == tf {
        None
    } else {
        Some(base.get(tf)?.clone())
    };
    if !json_put(bt.as_mut().unwrap_or(&mut bf), tt, item) {
        return None;
    }
    // Then the documents.
    let is_value = match docs.get_mut(ff)? {
        Doc::Toml(d) => toml_peek(d, ft)?,
        Doc::Json(j) => {
            json_at_keys(j, ft)?;
            true
        }
    };
    let can_put = match docs.get_mut(tf)? {
        Doc::Toml(d) => toml_can_put(d, tt, is_value),
        Doc::Json(j) => json_can_put(j, tt),
    };
    if !can_put {
        return None;
    }
    let taken = match docs.get_mut(ff)? {
        Doc::Toml(d) => Taken::Toml(toml_take(d, ft)?),
        Doc::Json(j) => Taken::Json(json_take(j, ft)?),
    };
    let ok = match (docs.get_mut(tf)?, taken) {
        (Doc::Toml(d), Taken::Toml((decor, mut item))) => {
            if ff != tf {
                clear_positions(&mut item);
                if let Item::Table(t) = &mut item {
                    let p = t
                        .decor()
                        .prefix()
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_owned();
                    if !p.starts_with('\n') {
                        t.decor_mut().set_prefix(format!("\n{p}"));
                    }
                }
            }
            toml_put(d, tt, decor, item)
        }
        (Doc::Json(j), Taken::Json(v)) => json_put(j, tt, v),
        _ => false,
    };
    if !ok {
        return None; // unreachable: `can_put` checked the destination
    }
    base.insert(ff.clone(), bf);
    if let Some(bt) = bt {
        base.insert(tf.clone(), bt);
    }
    Some(())
}

enum Taken {
    Toml((Decor, Item)),
    Json(Json),
}

fn json_at_keys<'a>(v: &'a mut Json, toks: &[String]) -> Option<&'a mut Json> {
    let mut cur = v;
    for t in toks {
        cur = cur.as_object_mut()?.get_mut(t)?;
    }
    Some(cur)
}

fn json_take(v: &mut Json, toks: &[String]) -> Option<Json> {
    let (k, parent) = toks.split_last()?;
    json_at_keys(v, parent)?.as_object_mut()?.shift_remove(k)
}

fn json_can_put(v: &mut Json, toks: &[String]) -> bool {
    toks.split_last()
        .is_some_and(|(_, parent)| json_at_keys(v, parent).is_some_and(|p| p.is_object()))
}

fn json_put(v: &mut Json, toks: &[String], item: Json) -> bool {
    let Some((k, parent)) = toks.split_last() else {
        return false;
    };
    match json_at_keys(v, parent).and_then(Json::as_object_mut) {
        Some(m) => {
            m.insert(k.clone(), item);
            true
        }
        None => false,
    }
}

/// The table-like at a path of keys, and whether it is an inline table.
fn table_at<'a>(
    doc: &'a mut DocumentMut,
    toks: &[String],
) -> Option<(&'a mut dyn TableLike, bool)> {
    let mut cur: &mut dyn TableLike = doc.as_table_mut();
    let mut inline = false;
    for t in toks {
        let item = cur.get_mut(t)?;
        inline = matches!(item, Item::Value(Value::InlineTable(_)));
        cur = item.as_table_like_mut()?;
    }
    Some((cur, inline))
}

/// Whether the item at `toks` exists, and whether it is a plain value.
fn toml_peek(doc: &mut DocumentMut, toks: &[String]) -> Option<bool> {
    let (k, parent) = toks.split_last()?;
    let (t, _) = table_at(doc, parent)?;
    t.get(k).filter(|i| !i.is_none()).map(Item::is_value)
}

/// Whether an item can be inserted at the absent key `toks`.
fn toml_can_put(doc: &mut DocumentMut, toks: &[String], is_value: bool) -> bool {
    let Some((k, parent)) = toks.split_last() else {
        return false;
    };
    matches!(table_at(doc, parent), Some((t, inline)) if !t.contains_key(k) && (is_value || !inline))
}

/// Removes the item at `toks` with its key's decor (leading comments). The
/// file's leading comment stays in the file (see [`keep_head`]).
fn toml_take(doc: &mut DocumentMut, toks: &[String]) -> Option<(Decor, Item)> {
    let (k, parent) = toks.split_last()?;
    let (taken, moved_head) = keep_head(doc, |doc| {
        let (t, _) = table_at(doc, parent)?;
        let decor = t
            .key(k)
            .map(|key| key.leaf_decor().clone())
            .unwrap_or_default();
        t.remove(k).map(|item| (decor, item))
    });
    let (mut decor, mut item) = taken?;
    if moved_head {
        decor.set_prefix("");
        if let Item::Table(t) = &mut item {
            t.decor_mut().set_prefix("\n");
        }
    }
    Some((decor, item))
}

fn toml_put(doc: &mut DocumentMut, toks: &[String], decor: Decor, item: Item) -> bool {
    let Some((k, parent)) = toks.split_last() else {
        return false;
    };
    let Some((t, _)) = table_at(doc, parent) else {
        return false;
    };
    let key = Key::new(k.as_str()).with_leaf_decor(decor);
    match t.entry_format(&key) {
        toml_edit::Entry::Vacant(v) => {
            v.insert(item);
            true
        }
        toml_edit::Entry::Occupied(_) => false,
    }
}

/// Forgets header positions (an item moved to another document renders after
/// its new siblings).
fn clear_positions(item: &mut Item) {
    fn table(t: &mut Table) {
        t.set_position(None);
        for (_, item) in t.iter_mut() {
            clear_positions(item);
        }
    }
    match item {
        Item::Table(t) => table(t),
        Item::ArrayOfTables(a) => a.iter_mut().for_each(table),
        _ => {}
    }
}

// ---- the document head ----------------------------------------------------------------

/// The first token of a document: a root key, or a header table by path.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Head {
    Key(String),
    Table(Vec<Seg>),
}

pub(crate) fn head(doc: &DocumentMut) -> Option<Head> {
    fn visible(t: &Table) -> bool {
        !(t.is_implicit() && t.get_values().is_empty())
    }
    fn consider(sub: &Table, path: &[Seg], best: &mut Option<(isize, Vec<Seg>)>) {
        if let Some(p) = sub.position()
            && visible(sub)
            && best.as_ref().is_none_or(|(b, _)| p < *b)
        {
            *best = Some((p, path.to_vec()));
        }
    }
    fn scan(t: &Table, path: &mut Vec<Seg>, best: &mut Option<(isize, Vec<Seg>)>) {
        for (k, item) in t.iter() {
            match item {
                Item::Table(sub) if !sub.is_dotted() => {
                    path.push(Seg::Key(k.to_owned()));
                    consider(sub, path, best);
                    scan(sub, path, best);
                    path.pop();
                }
                Item::ArrayOfTables(a) => {
                    for (i, sub) in a.iter().enumerate() {
                        path.push(Seg::Key(k.to_owned()));
                        path.push(Seg::Index(i));
                        consider(sub, path, best);
                        scan(sub, path, best);
                        path.pop();
                        path.pop();
                    }
                }
                _ => {}
            }
        }
    }
    let root = doc.as_table();
    if let Some((k, _)) = root
        .iter()
        .find(|(_, i)| i.is_value() || i.as_table().is_some_and(Table::is_dotted))
    {
        return Some(Head::Key(k.to_owned()));
    }
    let mut best = None;
    scan(root, &mut Vec::new(), &mut best);
    best.map(|(_, p)| Head::Table(p))
}

/// Runs a removal; when it removes the document's first token, the file's
/// leading comment moves to the new first token instead of disappearing.
/// Also returns whether the first token was removed.
fn keep_head<R>(doc: &mut DocumentMut, remove: impl FnOnce(&mut DocumentMut) -> R) -> (R, bool) {
    let before = head(doc);
    let lead = before
        .as_ref()
        .map(|h| head_prefix(doc, h))
        .unwrap_or_default();
    let out = remove(doc);
    let after = head(doc);
    let moved = after != before;
    if moved && let Some(after) = after {
        let mine = head_prefix(doc, &after);
        let mine = mine.trim_start_matches(['\n', '\r']);
        let lead = lead.trim_start_matches(['\n', '\r']);
        let joined = if lead.contains('#') {
            let gap = if mine.contains('#') { "\n" } else { "" };
            format!("{lead}{gap}{mine}")
        } else {
            mine.to_owned()
        };
        set_head_prefix(doc, &after, joined);
    }
    (out, moved)
}

pub(crate) fn head_prefix(doc: &mut DocumentMut, h: &Head) -> String {
    let raw = |d: &Decor| d.prefix().and_then(|p| p.as_str()).unwrap_or("").to_owned();
    match h {
        Head::Key(k) => doc
            .as_table()
            .key(k)
            .map(|key| raw(key.leaf_decor()))
            .unwrap_or_default(),
        Head::Table(p) => match walk(doc, p, false) {
            Some(Node::Table(t) | Node::Item(Item::Table(t))) => raw(t.decor()),
            _ => String::new(),
        },
    }
}

pub(crate) fn set_head_prefix(doc: &mut DocumentMut, h: &Head, prefix: String) {
    match h {
        Head::Key(k) => {
            if let Some(mut key) = doc.as_table_mut().key_mut(k) {
                key.leaf_decor_mut().set_prefix(prefix);
            }
        }
        Head::Table(p) => {
            if let Some(Node::Table(t) | Node::Item(Item::Table(t))) = walk(doc, p, false) {
                t.decor_mut().set_prefix(prefix);
            }
        }
    }
}

// ---- diff ----------------------------------------------------------------------

/// One minimal edit of a document, at a path of keys and indices.
#[derive(Debug, Clone, PartialEq)]
enum Edit {
    /// Sets (replaces or inserts) the value at a path.
    Set(Vec<Seg>, Json),
    /// Removes the key or element at a path (absent: no-op).
    Remove(Vec<Seg>),
    /// Replaces `remove` elements at `at` with `insert`; `whole` is the full
    /// target array, used when the array is not in the document.
    Splice {
        path: Vec<Seg>,
        at: usize,
        remove: usize,
        insert: Vec<Json>,
        whole: Json,
    },
}

fn child(path: &[Seg], seg: Seg) -> Vec<Seg> {
    let mut p = path.to_vec();
    p.push(seg);
    p
}

/// The edits that turn `have` into `want`: objects key by key, arrays by
/// common prefix and suffix, everything else by value.
fn diff(have: &Json, want: &Json, path: &mut Vec<Seg>, out: &mut Vec<Edit>) {
    match (have, want) {
        (Json::Object(h), Json::Object(w)) => {
            for k in h.keys() {
                if !w.contains_key(k) {
                    out.push(Edit::Remove(child(path, Seg::Key(k.clone()))));
                }
            }
            for (k, wv) in w {
                path.push(Seg::Key(k.clone()));
                match h.get(k) {
                    Some(hv) => diff(hv, wv, path, out),
                    None => out.push(Edit::Set(path.clone(), wv.clone())),
                }
                path.pop();
            }
        }
        (Json::Array(h), Json::Array(w)) => {
            let pre = h.iter().zip(w).take_while(|(a, b)| json_eq(a, b)).count();
            let max_suf = h.len().min(w.len()) - pre;
            let suf = h
                .iter()
                .rev()
                .zip(w.iter().rev())
                .take(max_suf)
                .take_while(|(a, b)| json_eq(a, b))
                .count();
            let (hm, wm) = (&h[pre..h.len() - suf], &w[pre..w.len() - suf]);
            if hm.len() == wm.len() {
                for (i, (a, b)) in hm.iter().zip(wm).enumerate() {
                    path.push(Seg::Index(pre + i));
                    diff(a, b, path, out);
                    path.pop();
                }
            } else {
                out.push(Edit::Splice {
                    path: path.clone(),
                    at: pre,
                    remove: hm.len(),
                    insert: wm.to_vec(),
                    whole: want.clone(),
                });
            }
        }
        _ if json_eq(have, want) => {}
        _ => out.push(Edit::Set(path.clone(), want.clone())),
    }
}

// ---- applying edits ------------------------------------------------------------------

fn apply_edits(doc: &mut Doc, edits: &[Edit]) -> Result<(), String> {
    match doc {
        Doc::Toml(d) => edits.iter().try_for_each(|e| toml_edit_one(d, e)),
        Doc::Json(j) => edits.iter().try_for_each(|e| json_edit_one(j, e)),
    }
}

/// A position in a `toml_edit` document.
enum Node<'a> {
    Table(&'a mut Table),
    Item(&'a mut Item),
    Value(&'a mut Value),
}

/// Steps into `seg`. With `create` (the depth of the child), a missing key
/// becomes an empty table: a header table at header depth under a header
/// table (implicit until it holds a value), else an inline table.
fn step<'a>(node: Node<'a>, seg: &Seg, create: Option<usize>) -> Option<Node<'a>> {
    match (node, seg) {
        (Node::Table(t) | Node::Item(Item::Table(t)), Seg::Key(k)) => {
            if t.get(k).is_none_or(Item::is_none) {
                let depth = create?;
                let item = if depth <= HEADER_DEPTH {
                    let mut sub = Table::new();
                    sub.set_implicit(true);
                    Item::Table(sub)
                } else {
                    Item::Value(Value::InlineTable(InlineTable::new()))
                };
                t.insert(k, item);
            }
            t.get_mut(k).map(Node::Item)
        }
        (
            Node::Item(Item::Value(Value::InlineTable(t))) | Node::Value(Value::InlineTable(t)),
            Seg::Key(k),
        ) => {
            if !t.contains_key(k) {
                create?;
                insert_new(t, true, k, Item::Value(InlineTable::new().into()));
            }
            t.get_mut(k).map(Node::Value)
        }
        (Node::Item(Item::ArrayOfTables(a)), Seg::Index(i)) => a.get_mut(*i).map(Node::Table),
        (
            Node::Item(Item::Value(Value::Array(a))) | Node::Value(Value::Array(a)),
            Seg::Index(i),
        ) => a.get_mut(*i).map(Node::Value),
        _ => None,
    }
}

fn walk<'a>(doc: &'a mut DocumentMut, path: &[Seg], create: bool) -> Option<Node<'a>> {
    let mut node = Node::Table(doc.as_table_mut());
    for (n, seg) in path.iter().enumerate() {
        node = step(node, seg, create.then_some(n + 1))?;
    }
    Some(node)
}

fn toml_edit_one(doc: &mut DocumentMut, edit: &Edit) -> Result<(), String> {
    let end = max_position(doc.as_table()) + 1;
    match edit {
        Edit::Set(path, v) => {
            let (last, parent) = path.split_last().ok_or("cannot replace a whole document")?;
            let node = walk(doc, parent, true).ok_or("parent path is not a table")?;
            set_at(node, last, v, path.len(), end)
        }
        Edit::Remove(path) => {
            let Some((last, parent)) = path.split_last() else {
                return Err("cannot remove a whole document".into());
            };
            let ((), _) = keep_head(doc, |doc| {
                if let Some(node) = walk(doc, parent, false) {
                    remove_at(node, last);
                }
            });
            Ok(())
        }
        Edit::Splice {
            path,
            at,
            remove,
            insert,
            whole,
        } => {
            let spliced = match walk(doc, path, false) {
                Some(node) => splice(node, *at, *remove, insert, path.len()).is_ok(),
                None => false,
            };
            if spliced {
                Ok(())
            } else {
                toml_edit_one(doc, &Edit::Set(path.clone(), whole.clone()))
            }
        }
    }
}

fn set_at(node: Node<'_>, seg: &Seg, v: &Json, depth: usize, end: isize) -> Result<(), String> {
    match (node, seg) {
        (Node::Table(t) | Node::Item(Item::Table(t)), Seg::Key(k)) => {
            if v.is_null() {
                t.remove(k);
                return Ok(());
            }
            let new = build_item(v, depth, true)?;
            match t.get_mut(k) {
                Some(Item::Value(old)) if new.is_value() => {
                    if let Item::Value(nv) = new {
                        replace_preserving(old, nv);
                    }
                }
                Some(Item::Table(old)) if new.is_table() => {
                    if let Item::Table(mut nt) = new {
                        *nt.decor_mut() = old.decor().clone();
                        nt.set_position(old.position());
                        *old = nt;
                    }
                }
                Some(old) if !old.is_none() => *old = new,
                _ => {
                    if new.is_value() {
                        surface_implicit(t, k, end);
                    }
                    t.insert(k, new);
                }
            }
            Ok(())
        }
        (
            Node::Item(Item::Value(Value::InlineTable(t))) | Node::Value(Value::InlineTable(t)),
            Seg::Key(k),
        ) => {
            if v.is_null() {
                t.remove(k);
                return Ok(());
            }
            let new = build_value(v)?;
            match t.get_mut(k) {
                Some(old) => {
                    replace_preserving(old, new);
                }
                None => insert_new(t, true, k, Item::Value(new)),
            }
            Ok(())
        }
        (Node::Item(Item::ArrayOfTables(a)), Seg::Index(i)) => {
            let old = a.get_mut(*i).ok_or("index out of range")?;
            let mut nt = build_table(v, depth)?;
            *nt.decor_mut() = old.decor().clone();
            nt.set_position(old.position());
            *old = nt;
            Ok(())
        }
        (
            Node::Item(Item::Value(Value::Array(a))) | Node::Value(Value::Array(a)),
            Seg::Index(i),
        ) => {
            let old = a.get_mut(*i).ok_or("index out of range")?;
            replace_preserving(old, build_value(v)?);
            Ok(())
        }
        _ => Err("path does not match the document".into()),
    }
}

fn remove_at(node: Node<'_>, seg: &Seg) {
    match (node, seg) {
        (Node::Table(t) | Node::Item(Item::Table(t)), Seg::Key(k)) => {
            t.remove(k);
        }
        (
            Node::Item(Item::Value(Value::InlineTable(t))) | Node::Value(Value::InlineTable(t)),
            Seg::Key(k),
        ) => {
            t.remove(k);
        }
        (Node::Item(Item::ArrayOfTables(a)), Seg::Index(i)) if *i < a.len() => {
            a.remove(*i);
        }
        (
            Node::Item(Item::Value(Value::Array(a))) | Node::Value(Value::Array(a)),
            Seg::Index(i),
        ) if *i < a.len() => {
            a.remove(*i);
            refmt_single_line(a);
        }
        _ => {}
    }
}

fn splice(
    node: Node<'_>,
    at: usize,
    remove: usize,
    insert: &[Json],
    depth: usize,
) -> Result<(), String> {
    match node {
        Node::Item(Item::ArrayOfTables(a)) if at + remove <= a.len() => {
            let tables = insert
                .iter()
                .map(|v| build_table(v, depth + 1))
                .collect::<Result<Vec<_>, _>>()?;
            for _ in 0..remove {
                a.remove(at);
            }
            for (j, t) in tables.into_iter().enumerate() {
                a.insert(at + j, t);
            }
            Ok(())
        }
        Node::Item(Item::Value(Value::Array(a))) | Node::Value(Value::Array(a))
            if at + remove <= a.len() =>
        {
            let values = insert
                .iter()
                .map(build_value)
                .collect::<Result<Vec<_>, _>>()?;
            for _ in 0..remove {
                a.remove(at);
            }
            for (j, v) in values.into_iter().enumerate() {
                let v = default_array_decor(a, v);
                a.insert_formatted(at + j, v);
            }
            refmt_single_line(a);
            Ok(())
        }
        _ => Err("not an array".into()),
    }
}

/// Re-spaces a one-line array (`[1, 2]`) after an element was added or removed;
/// multi-line arrays keep their layout and comments.
fn refmt_single_line(a: &mut Array) {
    let mut bare = a.clone();
    bare.decor_mut().clear();
    if !bare.to_string().contains('\n') {
        a.fmt();
    }
}

/// A new item for `v` at `depth` under a table (`in_table`) or inline.
fn build_item(v: &Json, depth: usize, in_table: bool) -> Result<Item, String> {
    if in_table && depth <= HEADER_DEPTH {
        match v {
            Json::Object(_) => return build_table(v, depth).map(Item::Table),
            Json::Array(a) if !a.is_empty() && a.iter().all(Json::is_object) => {
                let mut aot = ArrayOfTables::new();
                for e in a {
                    aot.push(build_table(e, depth + 1)?);
                }
                return Ok(Item::ArrayOfTables(aot));
            }
            _ => {}
        }
    }
    build_value(v).map(Item::Value)
}

/// A header table for an object; implicit when it only holds sub-tables.
fn build_table(v: &Json, depth: usize) -> Result<Table, String> {
    let Json::Object(m) = v else {
        return Err("expected an object".into());
    };
    let mut t = Table::new();
    let mut has_value = false;
    for (k, c) in tag_first(m) {
        if c.is_null() {
            continue;
        }
        let item = build_item(c, depth + 1, true)?;
        has_value |= item.is_value();
        t.insert(k, item);
    }
    if !has_value && !t.is_empty() {
        t.set_implicit(true);
    }
    Ok(t)
}

/// Object entries with the `type` tag first, as `rw fmt` orders them (the
/// typed JSON puts a flattened kind's tag after the common fields).
fn tag_first(m: &Map<String, Json>) -> impl Iterator<Item = (&String, &Json)> {
    let tag = m.get_key_value("type");
    tag.into_iter()
        .chain(m.iter().filter(|(k, _)| k.as_str() != "type"))
}

/// A TOML 1.0 value for a JSON value (objects become inline tables).
fn build_value(v: &Json) -> Result<Value, String> {
    Ok(match v {
        Json::Null => return Err("null has no TOML form".into()),
        Json::Bool(b) => Value::from(*b),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else if n.is_u64() {
                return Err(format!("{n} does not fit a TOML integer"));
            } else {
                Value::from(n.as_f64().ok_or("not a number")?)
            }
        }
        Json::String(s) => Value::from(s.as_str()),
        Json::Array(a) => {
            let mut arr = Array::new();
            for e in a {
                arr.push(build_value(e)?);
            }
            arr.fmt();
            Value::Array(arr)
        }
        Json::Object(m) => {
            let mut t = InlineTable::new();
            for (k, c) in tag_first(m) {
                if !c.is_null() {
                    t.insert(k, build_value(c)?);
                }
            }
            t.fmt();
            Value::InlineTable(t)
        }
    })
}

// ---- JSON twins ----------------------------------------------------------------------

fn json_at<'a>(v: &'a mut Json, path: &[Seg], create: bool) -> Option<&'a mut Json> {
    let mut cur = v;
    for seg in path {
        cur = match (cur, seg) {
            (Json::Object(m), Seg::Key(k)) => {
                if create && !m.contains_key(k) {
                    m.insert(k.clone(), Json::Object(Map::new()));
                }
                m.get_mut(k)?
            }
            (Json::Array(a), Seg::Index(i)) => a.get_mut(*i)?,
            _ => return None,
        };
    }
    Some(cur)
}

fn json_edit_one(doc: &mut Json, edit: &Edit) -> Result<(), String> {
    match edit {
        Edit::Set(path, v) => {
            let (last, parent) = path.split_last().ok_or("cannot replace a whole document")?;
            match (json_at(doc, parent, true), last) {
                (Some(Json::Object(m)), Seg::Key(k)) => {
                    if v.is_null() {
                        m.shift_remove(k);
                    } else {
                        m.insert(k.clone(), v.clone());
                    }
                    Ok(())
                }
                (Some(Json::Array(a)), Seg::Index(i)) if *i < a.len() => {
                    a[*i] = v.clone();
                    Ok(())
                }
                _ => Err("path does not match the document".into()),
            }
        }
        Edit::Remove(path) => {
            if let Some((last, parent)) = path.split_last() {
                match (json_at(doc, parent, false), last) {
                    (Some(Json::Object(m)), Seg::Key(k)) => {
                        m.shift_remove(k);
                    }
                    (Some(Json::Array(a)), Seg::Index(i)) if *i < a.len() => {
                        a.remove(*i);
                    }
                    _ => {}
                }
            }
            Ok(())
        }
        Edit::Splice {
            path,
            at,
            remove,
            insert,
            whole,
        } => match json_at(doc, path, false) {
            Some(Json::Array(a)) if at + remove <= a.len() => {
                a.splice(*at..at + remove, insert.iter().cloned());
                Ok(())
            }
            _ => json_edit_one(doc, &Edit::Set(path.clone(), whole.clone())),
        },
    }
}

#[cfg(test)]
mod tests;
