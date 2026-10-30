//! `rw fmt`: canonical formatting of source files (R2.12, Acceptance 4).
//!
//! The canonical form, applied with `toml_edit` so comments survive:
//!
//! - **Key order from the schema.** In every table, discriminator keys
//!   (`type`) come first, then the fields in the order the JSON Schema of the
//!   Rust types lists them (struct order; for a component, the common fields
//!   then the kind's fields). Entries of id-keyed maps (`[c.*]`, `[params.*]`)
//!   keep their written order, and unknown keys go last in written order.
//!   Header tables are laid out in the same order.
//! - **Unit spelling.** On dimensional fields (`x-unit-dimension`) and param
//!   values, `"54mm"`, `"54  MM"`-style aliases, `"5 °"`, `"1 kg·m²"` become
//!   `"54 mm"`, `"5 deg"`, `"1 kg*m^2"`: the number as written, one space, the
//!   unit with canonical symbols. The parsed value never changes (checked).
//!   Expressions (`"= ..."`) are left alone.
//! - **Layout.** `key = value`, one blank line before each header, comment
//!   lines kept (runs of blank lines collapse to one), trailing comments as
//!   ` # ...`, one-line arrays and inline tables re-spaced, TOML 1.0 output.
//!
//! Formatting is idempotent (`tests/fmt_idempotent.rs`) and never changes the
//! model: the output is re-parsed and compared before it is returned.

use std::collections::HashMap;
use std::sync::OnceLock;

use rw_model::diag::{self, Diagnostic};
use rw_model::source::{DocKind, doc_kind, parse_source};
use rw_model::{ConfigDoc, EngineDoc, ProjectManifest, RocketDoc, SimDoc, SourceDoc};
use rw_units::{Parsed, lookup, parse_parts, parse_unit};
use serde_json::{Map, Value as Json};
use toml_edit::{Array, DocumentMut, Formatted, Item, KeyMut, Table, Value};

use crate::store::{head, head_prefix, set_head_prefix};
use crate::tomlpatch::to_toml10_string;

// ---- public API -------------------------------------------------------------------

/// Formats one source file (TOML or its JSON twin). Files that do not parse
/// are not formatted; their diagnostics are returned.
pub fn format_text(path: &str, text: &str) -> Result<String, Vec<Diagnostic>> {
    let before = parse_source(path, text)?;
    let Some(kind) = doc_kind(path) else {
        return Err(vec![internal(path, "not a source file")]);
    };
    let out = if path.ends_with(".json") {
        let mut v: Json = serde_json::from_str(text).map_err(|e| vec![internal(path, e)])?;
        format_json(kind, &mut v);
        let mut s = serde_json::to_string_pretty(&v).map_err(|e| vec![internal(path, e)])?;
        s.push('\n');
        s
    } else {
        let mut doc: DocumentMut = text.parse().map_err(|e| vec![internal(path, e)])?;
        format_document(kind, &mut doc);
        to_toml10_string(&doc)
    };
    let after = parse_source(path, &out).map_err(|_| {
        vec![internal(
            path,
            "rw fmt produced a file that does not parse (bug)",
        )]
    })?;
    if canonical_json(&before) != canonical_json(&after) {
        return Err(vec![internal(path, "rw fmt would change the model (bug)")]);
    }
    Ok(out)
}

/// True when `text` is already in canonical form.
pub fn is_formatted(path: &str, text: &str) -> Result<bool, Vec<Diagnostic>> {
    format_text(path, text).map(|out| out == text)
}

/// Formats a parsed TOML document of the given kind in place.
pub fn format_document(kind: DocKind, doc: &mut DocumentMut) {
    let f = Fmt { root: schema(kind) };
    // The file's leading comment stays at the top while keys move.
    let lead = match head(doc) {
        Some(h) => {
            let (file, own) = split_head(&head_prefix(doc, &h));
            set_head_prefix(doc, &h, own);
            file
        }
        None => String::new(),
    };
    f.table(doc.as_table_mut(), Some(f.root));
    layout(doc);
    if !lead.is_empty()
        && let Some(h) = head(doc)
    {
        let own = head_prefix(doc, &h);
        set_head_prefix(doc, &h, format!("{lead}\n{own}"));
    }
}

/// Splits the first token's prefix into the file's leading comment (the
/// comment lines up to the last blank line) and the token's own comment.
fn split_head(prefix: &str) -> (String, String) {
    let pieces: Vec<&str> = prefix.split('\n').collect();
    let last_line = pieces.len().saturating_sub(1);
    let gap = (0..last_line).rev().find(|&i| {
        pieces[i].trim().is_empty() && pieces[..i].iter().any(|p| p.trim().starts_with('#'))
    });
    match gap {
        Some(i) => (
            comment_block(&pieces[..i].join("\n"), true),
            pieces[i + 1..].join("\n"),
        ),
        None => (String::new(), prefix.to_owned()),
    }
}

/// Formats the JSON twin of a document in place (key order and units).
pub fn format_json(kind: DocKind, v: &mut Json) {
    let f = Fmt { root: schema(kind) };
    f.json(v, Some(f.root));
}

/// The canonical spelling of a quantity string (`"54mm"` → `"54 mm"`), or
/// `None` when it is already canonical, an expression, or not a quantity
/// with a unit. The result parses to exactly the same number and unit.
pub fn normalize_quantity(s: &str) -> Option<String> {
    let t = s.trim();
    if t.starts_with('=') {
        return None;
    }
    let parsed = parse_parts(t).ok()?;
    parsed.unit?;
    // The longest prefix that is a bare number, with a unit after it.
    let split = t
        .char_indices()
        .rev()
        .map(|(i, _)| i)
        .filter(|&i| i > 0)
        .find(|&i| {
            let (num, unit) = t.split_at(i);
            !unit.trim().is_empty()
                && parse_unit(unit).is_ok()
                && matches!(parse_parts(num), Ok(Parsed { unit: None, .. }))
        });
    let (num, unit) = t.split_at(split?);
    let num = num.split_whitespace().collect::<Vec<_>>().join(" ");
    let out = format!("{num} {}", canonical_unit(unit)?);
    (out != s && parse_parts(&out).ok()? == parsed).then_some(out)
}

// ---- units ----------------------------------------------------------------------

/// Characters of a unit symbol (as in the `rw-units` parser).
fn is_symbol_char(c: char) -> bool {
    c.is_alphabetic() || matches!(c, '%' | '°' | 'µ' | 'μ' | '_')
}

/// Rewrites a unit expression with canonical symbols and ASCII operators,
/// without spaces (`kg / m³` → `kg/m^3`).
fn canonical_unit(u: &str) -> Option<String> {
    fn flush(sym: &mut String, out: &mut String) -> Option<()> {
        if !sym.is_empty() {
            out.push_str(lookup(sym)?.symbol);
            sym.clear();
        }
        Some(())
    }
    let mut out = String::new();
    let mut sym = String::new();
    for c in u.chars() {
        if is_symbol_char(c) {
            sym.push(c);
            continue;
        }
        flush(&mut sym, &mut out)?;
        match c {
            '·' => out.push('*'),
            '²' => out.push_str("^2"),
            '³' => out.push_str("^3"),
            c if c.is_whitespace() => {}
            c => out.push(c),
        }
    }
    flush(&mut sym, &mut out)?;
    Some(out)
}

/// The typed JSON of a document with every quantity string in canonical
/// spelling: equal before and after formatting.
fn canonical_json(d: &SourceDoc) -> Json {
    fn walk(v: &mut Json) {
        match v {
            Json::String(s) => {
                if let Some(n) = normalize_quantity(s) {
                    *s = n;
                }
            }
            Json::Array(a) => a.iter_mut().for_each(walk),
            Json::Object(m) => m.values_mut().for_each(walk),
            _ => {}
        }
    }
    let mut v = serde_json::to_value(d).unwrap_or(Json::Null);
    walk(&mut v);
    v
}

fn internal(path: &str, msg: impl std::fmt::Display) -> Diagnostic {
    let mut d = Diagnostic::new(diag::E_PARSE, None, msg.to_string());
    d.file = Some(path.to_string());
    d
}

// ---- schema navigation ------------------------------------------------------------

/// The JSON Schema of each document kind, generated from the Rust types (the
/// same source as `schema/*.json`, so it never drifts from the model).
fn schema(kind: DocKind) -> &'static Json {
    static SCHEMAS: OnceLock<[Json; 5]> = OnceLock::new();
    let all = SCHEMAS.get_or_init(|| {
        let v = |s: schemars::Schema| serde_json::to_value(s).unwrap_or(Json::Null);
        [
            v(schemars::schema_for!(ProjectManifest)),
            v(schemars::schema_for!(RocketDoc)),
            v(schemars::schema_for!(ConfigDoc)),
            v(schemars::schema_for!(SimDoc)),
            v(schemars::schema_for!(EngineDoc)),
        ]
    });
    &all[match kind {
        DocKind::Project => 0,
        DocKind::Rocket => 1,
        DocKind::Config => 2,
        DocKind::Sim => 3,
        DocKind::Engine => 4,
    }]
}

const COMBINATORS: [&str; 3] = ["allOf", "anyOf", "oneOf"];
const MAX_DEPTH: u8 = 24;

fn deref<'a>(root: &'a Json, node: &Json) -> Option<&'a Json> {
    let name = node.get("$ref")?.as_str()?.strip_prefix("#/$defs/")?;
    root.get("$defs")?.get(name)
}

/// The keys an object schema allows, merged across `$ref` and combinators.
#[derive(Default)]
struct Shape<'a> {
    /// Keys with a `const` (tag) in some branch: written first.
    disc: Vec<&'a str>,
    /// Known keys and their schemas, in schema order.
    props: Vec<(&'a str, &'a Json)>,
    /// The schema of map entries (`additionalProperties`), if a map.
    additional: Option<&'a Json>,
}

impl<'a> Shape<'a> {
    /// Collects `node`. `tag(key)` reads a string value of the object being
    /// formatted, to pick the matching branch of a tagged `oneOf`.
    fn of(root: &'a Json, node: &'a Json, tag: &dyn Fn(&str) -> Option<String>) -> Self {
        let mut sh = Shape::default();
        sh.collect(root, node, tag, 0);
        sh
    }

    fn collect(
        &mut self,
        root: &'a Json,
        node: &'a Json,
        tag: &dyn Fn(&str) -> Option<String>,
        depth: u8,
    ) {
        if depth > MAX_DEPTH {
            return;
        }
        if let Some(target) = deref(root, node) {
            self.collect(root, target, tag, depth + 1);
        }
        if let Some(Json::Object(props)) = node.get("properties") {
            for (k, v) in props {
                if v.get("const").is_some() && !self.disc.contains(&k.as_str()) {
                    self.disc.push(k);
                }
                if !self.props.iter().any(|(n, _)| n == k) {
                    self.props.push((k, v));
                }
            }
        }
        if self.additional.is_none()
            && let Some(a @ Json::Object(_)) = node.get("additionalProperties")
        {
            self.additional = Some(a);
        }
        for comb in COMBINATORS {
            if let Some(Json::Array(branches)) = node.get(comb) {
                for b in branches {
                    if !tag_mismatch(b, tag) {
                        self.collect(root, b, tag, depth + 1);
                    }
                }
            }
        }
    }

    /// Sort key of `key` written at position `pos`.
    fn rank(&self, key: &str, pos: usize) -> (u8, usize) {
        if let Some(i) = self.disc.iter().position(|d| *d == key) {
            return (0, i);
        }
        if let Some(i) = self.props.iter().position(|(n, _)| *n == key) {
            return (1, i);
        }
        (if self.additional.is_some() { 2 } else { 3 }, pos)
    }

    fn child(&self, key: &str) -> Option<&'a Json> {
        self.props
            .iter()
            .find(|(n, _)| *n == key)
            .map(|(_, s)| *s)
            .or(self.additional)
    }
}

/// True for a tagged branch whose `const` does not match the object's value.
fn tag_mismatch(branch: &Json, tag: &dyn Fn(&str) -> Option<String>) -> bool {
    let Some(Json::Object(props)) = branch.get("properties") else {
        return false;
    };
    props.iter().any(|(k, v)| match v.get("const") {
        Some(Json::String(c)) => tag(k).as_deref() != Some(c.as_str()),
        _ => false,
    })
}

/// True when strings at this schema are quantities: a dimensional field
/// (`x-unit-dimension`) or a param value.
fn is_qty(root: &Json, node: &Json, depth: u8) -> bool {
    if depth > MAX_DEPTH {
        return false;
    }
    if node.get("x-unit-dimension").is_some() {
        return true;
    }
    if let Some(r) = node.get("$ref").and_then(Json::as_str) {
        if r.ends_with("/ParamValue") {
            return true;
        }
        if deref(root, node).is_some_and(|t| is_qty(root, t, depth + 1)) {
            return true;
        }
    }
    COMBINATORS.iter().any(|c| {
        node.get(*c)
            .and_then(Json::as_array)
            .is_some_and(|bs| bs.iter().any(|b| is_qty(root, b, depth + 1)))
    })
}

/// The schema of element `i` of an array schema.
fn item_schema<'a>(root: &'a Json, node: &'a Json, i: usize, depth: u8) -> Option<&'a Json> {
    if depth > MAX_DEPTH {
        return None;
    }
    if let Some(Json::Array(prefix)) = node.get("prefixItems")
        && let Some(s) = prefix.get(i)
    {
        return Some(s);
    }
    if let Some(s @ Json::Object(_)) = node.get("items") {
        return Some(s);
    }
    if let Some(s) = deref(root, node).and_then(|t| item_schema(root, t, i, depth + 1)) {
        return Some(s);
    }
    COMBINATORS.iter().find_map(|c| {
        node.get(*c)?
            .as_array()?
            .iter()
            .find_map(|b| item_schema(root, b, i, depth + 1))
    })
}

// ---- order and units ------------------------------------------------------------------

struct Fmt<'a> {
    root: &'a Json,
}

impl<'a> Fmt<'a> {
    fn ranks<'k>(
        &self,
        schema: Option<&'a Json>,
        keys: impl Iterator<Item = &'k str>,
        tag: &dyn Fn(&str) -> Option<String>,
    ) -> (Shape<'a>, HashMap<String, (u8, usize)>) {
        let sh = schema
            .map(|s| Shape::of(self.root, s, tag))
            .unwrap_or_default();
        let ranks = keys
            .enumerate()
            .map(|(pos, k)| (k.to_owned(), sh.rank(k, pos)))
            .collect();
        (sh, ranks)
    }

    fn table(&self, t: &mut Table, schema: Option<&'a Json>) {
        let (sh, ranks) = {
            let tag = |k: &str| t.get(k).and_then(Item::as_str).map(str::to_owned);
            self.ranks(schema, t.iter().map(|(k, _)| k), &tag)
        };
        let rank = |k: &str| ranks.get(k).copied().unwrap_or((4, usize::MAX));
        t.sort_values_by(|k1, _, k2, _| rank(k1.get()).cmp(&rank(k2.get())));
        for (k, item) in t.iter_mut() {
            let cs = sh.child(k.get());
            match item {
                Item::Value(v) => self.value(v, cs),
                Item::Table(sub) => self.table(sub, cs),
                Item::ArrayOfTables(a) => {
                    for (i, sub) in a.iter_mut().enumerate() {
                        self.table(sub, cs.and_then(|s| item_schema(self.root, s, i, 0)));
                    }
                }
                Item::None => {}
            }
        }
    }

    fn value(&self, v: &mut Value, schema: Option<&'a Json>) {
        match v {
            Value::String(s) => {
                if schema.is_some_and(|n| is_qty(self.root, n, 0))
                    && let Some(n) = normalize_quantity(s.value())
                {
                    let mut fresh = Formatted::new(n);
                    *fresh.decor_mut() = s.decor().clone();
                    *s = fresh;
                }
            }
            Value::Array(a) => {
                for (i, e) in a.iter_mut().enumerate() {
                    self.value(e, schema.and_then(|s| item_schema(self.root, s, i, 0)));
                }
            }
            Value::InlineTable(t) => {
                let (sh, ranks) = {
                    let tag = |k: &str| t.get(k).and_then(Value::as_str).map(str::to_owned);
                    self.ranks(schema, t.iter().map(|(k, _)| k), &tag)
                };
                let rank = |k: &str| ranks.get(k).copied().unwrap_or((4, usize::MAX));
                t.sort_values_by(|k1, _, k2, _| rank(k1.get()).cmp(&rank(k2.get())));
                for (k, v) in t.iter_mut() {
                    let cs = sh.child(k.get());
                    self.value(v, cs);
                }
            }
            _ => {}
        }
    }

    fn json(&self, v: &mut Json, schema: Option<&'a Json>) {
        match v {
            Json::String(s) => {
                if schema.is_some_and(|n| is_qty(self.root, n, 0))
                    && let Some(n) = normalize_quantity(s)
                {
                    *s = n;
                }
            }
            Json::Array(a) => {
                for (i, e) in a.iter_mut().enumerate() {
                    self.json(e, schema.and_then(|s| item_schema(self.root, s, i, 0)));
                }
            }
            Json::Object(m) => {
                let (sh, ranks) = {
                    let tag = |k: &str| m.get(k).and_then(Json::as_str).map(str::to_owned);
                    self.ranks(schema, m.keys().map(String::as_str), &tag)
                };
                let mut entries: Vec<(String, Json)> = std::mem::take(m).into_iter().collect();
                entries.sort_by_key(|(k, _)| ranks.get(k).copied().unwrap_or((4, usize::MAX)));
                let mut out = Map::new();
                for (k, mut c) in entries {
                    self.json(&mut c, sh.child(&k));
                    out.insert(k, c);
                }
                *m = out;
            }
            _ => {}
        }
    }
}

// ---- layout ---------------------------------------------------------------------------

/// Comment lines of a decor prefix, trimmed, with leading blank lines dropped
/// and blank runs collapsed to one. `whole` keeps the last line (a trailing
/// block); otherwise it is the indentation before a token and is dropped.
fn comment_block(raw: &str, whole: bool) -> String {
    let mut pieces: Vec<&str> = raw.split('\n').collect();
    if !whole {
        pieces.pop();
    }
    let mut out = String::new();
    let (mut started, mut blank) = (false, false);
    for p in pieces {
        let line = p.trim();
        if line.is_empty() {
            blank |= started;
            continue;
        }
        if blank {
            out.push('\n');
            blank = false;
        }
        out.push_str(line);
        out.push('\n');
        started = true;
    }
    if blank && !whole {
        out.push('\n');
    }
    out
}

/// A trailing ` # comment`, or nothing.
fn trailing_comment(raw: &str) -> String {
    let t = raw.trim();
    if t.starts_with('#') {
        format!(" {t}")
    } else {
        String::new()
    }
}

fn raw(r: Option<&toml_edit::RawString>) -> String {
    r.and_then(|r| r.as_str()).unwrap_or("").to_owned()
}

struct Layout {
    pos: isize,
    first: bool,
}

fn layout(doc: &mut DocumentMut) {
    let root = doc.as_table_mut();
    let has_values = root
        .iter()
        .any(|(_, i)| i.is_value() || i.as_table().is_some_and(Table::is_dotted));
    // A comment before the first token may sit in the root decor.
    let lead = raw(root.decor().prefix());
    root.decor_mut().clear();
    let mut st = Layout {
        pos: 0,
        first: !has_values,
    };
    st.body(root);
    if !lead.trim().is_empty() {
        prepend_comment(root, &lead);
    }
    st.children(root);
    let trailing = comment_block(&raw(Some(doc.trailing())), true);
    doc.set_trailing(if trailing.is_empty() {
        String::new()
    } else {
        format!("\n{trailing}")
    });
}

/// Moves a root-decor comment onto the first rendered token.
fn prepend_comment(root: &mut Table, lead: &str) {
    let block = comment_block(lead, true);
    if let Some((mut k, _)) = root.iter_mut().find(|(_, i)| i.is_value()) {
        let p = raw(k.leaf_decor().prefix());
        k.leaf_decor_mut().set_prefix(format!("{block}\n{p}"));
        return;
    }
    // No root values: the first header (by position) gets it.
    fn first(t: &mut Table) -> Option<&mut Table> {
        let mut best: Option<&mut Table> = None;
        for (_, item) in t.iter_mut() {
            let cand = match item {
                Item::Table(sub) if !sub.is_dotted() => {
                    if !sub.is_implicit() || !sub.get_values().is_empty() {
                        Some(sub)
                    } else {
                        first(sub)
                    }
                }
                Item::ArrayOfTables(a) => a.iter_mut().next(),
                _ => None,
            };
            if let Some(c) = cand
                && best.as_ref().is_none_or(|b| c.position() < b.position())
            {
                best = Some(c);
            }
        }
        best
    }
    if let Some(t) = first(root) {
        let p = raw(t.decor().prefix());
        t.decor_mut().set_prefix(format!("{block}\n{p}"));
    }
}

impl Layout {
    /// Key/value lines of a table.
    fn body(&mut self, t: &mut Table) {
        for (mut k, item) in t.iter_mut() {
            if let Item::Value(v) = item {
                let prefix = comment_block(&raw(k.leaf_decor().prefix()), false);
                k.leaf_decor_mut().set_prefix(prefix);
                k.leaf_decor_mut().set_suffix(" ");
                let suffix = trailing_comment(&raw(v.decor().suffix()));
                v.decor_mut().set_prefix(" ");
                v.decor_mut().set_suffix(suffix);
                respace(v);
            }
        }
    }

    /// Header tables under `t`, in item order, with sequential positions.
    fn children(&mut self, t: &mut Table) {
        for (mut k, item) in t.iter_mut() {
            match item {
                Item::Table(sub) if !sub.is_dotted() => {
                    self.header(&mut k, sub);
                    self.body(sub);
                    self.children(sub);
                }
                Item::ArrayOfTables(a) => {
                    for sub in a.iter_mut() {
                        self.header(&mut k, sub);
                        self.body(sub);
                        self.children(sub);
                    }
                }
                _ => {}
            }
        }
    }

    fn header(&mut self, k: &mut KeyMut<'_>, t: &mut Table) {
        t.set_position(Some(self.pos));
        self.pos += 1;
        let key_prefix = raw(k.leaf_decor().prefix());
        let mut lead = if key_prefix.contains('\n') {
            key_prefix
        } else {
            String::new()
        };
        lead.push_str(&raw(t.decor().prefix()));
        k.leaf_decor_mut().clear();
        if t.is_implicit() && t.get_values().is_empty() {
            return; // not rendered
        }
        let gap = if self.first { "" } else { "\n" };
        self.first = false;
        let suffix = trailing_comment(&raw(t.decor().suffix()));
        t.decor_mut()
            .set_prefix(format!("{gap}{}", comment_block(&lead, false)));
        t.decor_mut().set_suffix(suffix);
    }
}

/// Re-spaces one-line arrays and inline tables (recursively); multi-line
/// arrays keep their layout and comments.
fn respace(v: &mut Value) {
    match v {
        Value::Array(a) => {
            let mut bare: Array = a.clone();
            bare.decor_mut().clear();
            if !bare.to_string().contains('\n') {
                a.fmt();
            }
            a.iter_mut().for_each(respace);
        }
        Value::InlineTable(t) => {
            t.fmt();
            for (_, v) in t.iter_mut() {
                respace(v);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests;
