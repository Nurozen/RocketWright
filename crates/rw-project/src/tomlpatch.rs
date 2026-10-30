//! Comment-preserving TOML patches (spike S1, kept; R2.12, Acceptance 4).
//!
//! Every programmatic edit of a `*.rw.toml` file goes through these helpers so
//! that hand-written comments, ordering, and whitespace survive. They exist to
//! avoid two `toml_edit` traps found in the spike:
//!
//! 1. Assigning a fresh value (`doc[..]["span"] = value(..)`) drops the old
//!    value's decor, so a trailing `# comment` on that line disappears.
//!    [`set_value_preserving`] copies the old decor onto the new value.
//! 2. Writing through `IndexMut` into a missing key creates an *inline* table
//!    and can surface a stray header for an implicit parent such as `[c]`.
//!    [`ensure_table`] inserts explicit [`Table`]s, marks created intermediates
//!    `set_implicit(true)`, and never flips an existing implicit table.
//!
//! `toml_edit` 0.25 parses TOML 1.1, while other tools may only know 1.0.
//! Values written by these helpers are always TOML 1.0, and
//! [`to_toml10_string`] rewrites 1.1-only syntax that came from the source.
//!
//! Patches are atomic: on error the document is left unchanged.

use std::fmt::{self, Write as _};

use toml_edit::visit_mut::{self, VisitMut};
use toml_edit::{
    Array, ArrayOfTables, DocumentMut, Formatted, InlineTable, Item, Table, TableLike, Value,
};

/// One step of a path into a TOML document: a table key or an array index.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Seg {
    /// A key in a table or inline table.
    Key(String),
    /// A position in an array of tables or an array value.
    Index(usize),
}

impl From<&str> for Seg {
    fn from(key: &str) -> Self {
        Seg::Key(key.to_owned())
    }
}

impl From<String> for Seg {
    fn from(key: String) -> Self {
        Seg::Key(key)
    }
}

impl From<usize> for Seg {
    fn from(index: usize) -> Self {
        Seg::Index(index)
    }
}

/// Errors from a patch. The document is unchanged when one is returned.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PatchError {
    /// `set_value_preserving` needs at least one segment.
    #[error("empty path")]
    EmptyPath,
    /// A textual path did not parse.
    #[error("invalid path `{path}`: {reason}")]
    BadPath { path: String, reason: &'static str },
    /// The path runs through an item of the wrong kind.
    #[error("`{path}` is {found}, expected {expected}")]
    TypeConflict {
        path: String,
        found: &'static str,
        expected: &'static str,
    },
    /// An index past the end of an array (only `index == len` appends).
    #[error("`{path}`: index {index} out of range (len {len})")]
    IndexOutOfRange {
        path: String,
        index: usize,
        len: usize,
    },
}

/// Parses `c.fin.span`, `stage[1].motor`, or `c."odd.key".x` into segments.
///
/// Keys are bare (`A-Za-z0-9_-`) or double-quoted with `\"` and `\\` escapes;
/// indices are `[n]` after a key or another index.
pub fn parse_path(path: &str) -> Result<Vec<Seg>, PatchError> {
    let bad = |reason| PatchError::BadPath {
        path: path.to_owned(),
        reason,
    };
    let mut segs = Vec::new();
    let mut chars = path.chars().peekable();
    let mut expect_key = true;
    while let Some(&c) = chars.peek() {
        if expect_key {
            let key = if c == '"' {
                chars.next();
                let mut key = String::new();
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(e @ ('"' | '\\')) => key.push(e),
                            _ => return Err(bad("unsupported escape in quoted key")),
                        },
                        Some(ch) => key.push(ch),
                        None => return Err(bad("unterminated quoted key")),
                    }
                }
                key
            } else {
                let mut key = String::new();
                while let Some(&ch) = chars.peek() {
                    if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                        key.push(ch);
                        chars.next();
                    } else {
                        break;
                    }
                }
                if key.is_empty() {
                    return Err(bad("expected a key"));
                }
                key
            };
            segs.push(Seg::Key(key));
            expect_key = false;
        } else {
            match chars.next() {
                Some('.') => expect_key = true,
                Some('[') => {
                    let mut digits = String::new();
                    loop {
                        match chars.next() {
                            Some(']') => break,
                            Some(d) if d.is_ascii_digit() => digits.push(d),
                            _ => return Err(bad("expected `[digits]`")),
                        }
                    }
                    let index = digits.parse().map_err(|_| bad("expected `[digits]`"))?;
                    segs.push(Seg::Index(index));
                }
                _ => return Err(bad("expected `.` or `[`")),
            }
        }
    }
    if expect_key {
        return Err(bad(if segs.is_empty() {
            "empty path"
        } else {
            "trailing `.`"
        }));
    }
    Ok(segs)
}

/// Renders segments back to the textual form accepted by [`parse_path`].
pub fn path_string(path: &[Seg]) -> String {
    let mut out = String::new();
    for (n, seg) in path.iter().enumerate() {
        match seg {
            Seg::Key(key) => {
                if n > 0 {
                    out.push('.');
                }
                let bare = !key.is_empty()
                    && key
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
                if bare {
                    out.push_str(key);
                } else {
                    out.push('"');
                    for c in key.chars() {
                        if matches!(c, '"' | '\\') {
                            out.push('\\');
                        }
                        out.push(c);
                    }
                    out.push('"');
                }
            }
            Seg::Index(i) => {
                let _ = write!(out, "[{i}]");
            }
        }
    }
    out
}

/// Sets the value at `path`, keeping the old value's decor (its leading
/// whitespace and trailing `# comment`) and the key's own formatting.
///
/// Missing parent tables are created as by [`ensure_table`]. A final
/// [`Seg::Index`] replaces an array element, or appends when it equals the
/// array length. Returns the replaced value, if any. Replacing a table or an
/// array of tables with a value is a [`PatchError::TypeConflict`].
pub fn set_value_preserving(
    doc: &mut DocumentMut,
    path: &[Seg],
    value: impl Into<Value>,
) -> Result<Option<Value>, PatchError> {
    let (last, parent) = path.split_last().ok_or(PatchError::EmptyPath)?;
    let mut new = value.into();
    Toml10.visit_value_mut(&mut new);

    let mut work = doc.clone();
    let end = max_position(work.as_table()) + 1;
    let old = {
        let (mut cur, created) = walk(&mut work, parent, Some(last))?;
        match last {
            Seg::Key(key) => {
                if let Cur::Item(Item::Table(table)) = &mut cur {
                    if created {
                        // Has a value now; must not count as a pre-existing implicit table.
                        table.set_implicit(false);
                    } else {
                        surface_implicit(table, key, end);
                    }
                }
                let found = cur.kind();
                let (table, inline) = cur
                    .into_table_like()
                    .ok_or_else(|| conflict(parent, found, "a table"))?;
                match table.get_mut(key) {
                    Some(Item::Value(old)) => Some(replace_preserving(old, new)),
                    Some(Item::None) | None => {
                        insert_new(table, inline, key, Item::Value(new));
                        None
                    }
                    Some(other) => return Err(conflict(path, item_kind(other), "a value")),
                }
            }
            Seg::Index(index) => {
                let found = cur.kind();
                let array = cur
                    .into_array()
                    .ok_or_else(|| conflict(parent, found, "an array"))?;
                let len = array.len();
                if *index < len {
                    let old = array
                        .get_mut(*index)
                        .ok_or_else(|| out_of_range(path, *index, len))?;
                    Some(replace_preserving(old, new))
                } else if *index == len {
                    array.push_formatted(default_array_decor(array, new));
                    None
                } else {
                    return Err(out_of_range(path, *index, len));
                }
            }
        }
    };
    *doc = work;
    Ok(old)
}

/// Returns the table at `path`, creating whatever is missing.
///
/// Created intermediate tables are implicit (no header of their own), the
/// created final table is explicit, and existing tables keep their implicit
/// or dotted status, so an implicit `[c]` never gains a stray header. A
/// [`Seg::Index`] equal to the length of an array of tables appends a new
/// `[[entry]]`. Children of inline or dotted tables are created inline or
/// dotted to match.
pub fn ensure_table<'d>(
    doc: &'d mut DocumentMut,
    path: &[Seg],
) -> Result<&'d mut dyn TableLike, PatchError> {
    // Validate on a scratch copy first so a failing path leaves `doc` intact.
    walk(&mut doc.clone(), path, None)?;
    let (mut cur, created) = walk(doc, path, None)?;
    if created && let Cur::Item(Item::Table(table)) = &mut cur {
        table.set_implicit(false);
    }
    let found = cur.kind();
    cur.into_table_like()
        .map(|(table, _)| table)
        .ok_or_else(|| conflict(path, found, "a table"))
}

/// Renders `doc` as TOML 1.0: multi-line inline tables and trailing commas
/// are folded onto one line (comments inside them cannot be kept), `\e` and
/// `\xHH` escapes are re-encoded, and times without seconds gain `:00`.
/// Everything else is emitted exactly as parsed.
pub fn to_toml10_string(doc: &DocumentMut) -> String {
    let mut doc = doc.clone();
    Toml10.visit_document_mut(&mut doc);
    doc.to_string()
}

// ---- internals ------------------------------------------------------------------

/// A position in the document during a walk.
enum Cur<'a> {
    Item(&'a mut Item),
    Table(&'a mut Table),
    Value(&'a mut Value),
}

impl<'a> Cur<'a> {
    fn kind(&self) -> &'static str {
        match self {
            Cur::Item(item) => item_kind(item),
            Cur::Table(_) => "a table",
            Cur::Value(value) => value_kind(value),
        }
    }

    /// The table-like at this position and whether it is an inline table.
    fn into_table_like(self) -> Option<(&'a mut dyn TableLike, bool)> {
        match self {
            Cur::Item(Item::Table(t)) | Cur::Table(t) => Some((t as &mut dyn TableLike, false)),
            Cur::Item(Item::Value(Value::InlineTable(t))) | Cur::Value(Value::InlineTable(t)) => {
                Some((t as &mut dyn TableLike, true))
            }
            _ => None,
        }
    }

    fn into_array(self) -> Option<&'a mut Array> {
        match self {
            Cur::Item(Item::Value(Value::Array(a))) | Cur::Value(Value::Array(a)) => Some(a),
            _ => None,
        }
    }
}

fn item_kind(item: &Item) -> &'static str {
    match item {
        Item::None => "missing",
        Item::Table(_) => "a table",
        Item::ArrayOfTables(_) => "an array of tables",
        Item::Value(value) => value_kind(value),
    }
}

fn value_kind(value: &Value) -> &'static str {
    match value {
        Value::String(_) => "a string",
        Value::Integer(_) => "an integer",
        Value::Float(_) => "a float",
        Value::Boolean(_) => "a boolean",
        Value::Datetime(_) => "a datetime",
        Value::Array(_) => "an array",
        Value::InlineTable(_) => "an inline table",
    }
}

fn conflict(path: &[Seg], found: &'static str, expected: &'static str) -> PatchError {
    PatchError::TypeConflict {
        path: path_string(path),
        found,
        expected,
    }
}

fn out_of_range(path: &[Seg], index: usize, len: usize) -> PatchError {
    PatchError::IndexOutOfRange {
        path: path_string(path),
        index,
        len,
    }
}

/// Replaces `old` with `new`, moving `old`'s decor onto `new` (trap 1).
pub(crate) fn replace_preserving(old: &mut Value, mut new: Value) -> Value {
    *new.decor_mut() = old.decor().clone();
    std::mem::replace(old, new)
}

/// Gives an appended array element the same leading whitespace as the
/// existing last element (`[1, 2]` → `[1, 2, 3]`), or none for the first.
pub(crate) fn default_array_decor(array: &Array, mut value: Value) -> Value {
    // Keep only the indentation after a comment line (`1,  # one\n  2`).
    let prefix = array
        .iter()
        .last()
        .and_then(|v| v.decor().prefix())
        .and_then(|p| p.as_str())
        .and_then(|p| match p.rfind('\n') {
            Some(at) => Some(&p[at..]),
            None => (!p.contains('#')).then_some(p),
        })
        .map(str::to_owned);
    match prefix {
        Some(prefix) => value.decor_mut().set_prefix(prefix),
        None if array.is_empty() => value.decor_mut().set_prefix(""),
        None => value.decor_mut().set_prefix(" "),
    }
    value.decor_mut().set_suffix("");
    value
}

/// An implicit table such as `[c]` (only `[c.fin]`, `[c.body]` headers in the
/// file) has no position, so giving it a value would print its new header
/// first, above the file's leading comment (trap 2). Move it to the end of the
/// document instead; TOML allows a super-table after its sub-tables.
pub(crate) fn surface_implicit(table: &mut Table, key: &str, end: isize) {
    let gains_value = !matches!(table.get(key), Some(item) if !item.is_none());
    if gains_value && table.is_implicit() && !table.is_dotted() && table.position().is_none() {
        table.set_implicit(false);
        table.set_position(Some(end));
    }
}

/// Largest header position in the document (0 when there are none).
pub(crate) fn max_position(table: &Table) -> isize {
    let mut max = table.position().unwrap_or(0);
    for (_, item) in table.iter() {
        let child = match item {
            Item::Table(t) => max_position(t),
            Item::ArrayOfTables(a) => a.iter().map(max_position).max().unwrap_or(0),
            _ => 0,
        };
        max = max.max(child);
    }
    max
}

/// Inserts a new key (appended last). In an inline table the space before `}` is the last
/// value's suffix, so it moves to the new last value (`{ a = 1 }` →
/// `{ a = 1, b = 2 }`, not `{ a = 1 , b = 2 }`).
pub(crate) fn insert_new(table: &mut dyn TableLike, inline: bool, key: &str, mut item: Item) {
    if let Some(new) = item.as_value_mut().filter(|_| inline) {
        let tail = table
            .iter_mut()
            .filter_map(|(_, item)| item.as_value_mut())
            .last()
            .and_then(|last| {
                let suffix = last.decor().suffix()?.as_str()?.to_owned();
                last.decor_mut().set_suffix("");
                Some(suffix)
            });
        if let Some(suffix) = tail {
            new.decor_mut().set_suffix(suffix);
        }
    }
    table.insert(key, item);
}

/// What to create for a missing key, given what the walk needs next.
#[derive(Clone, Copy)]
enum Want {
    Table,
    TableArray,
    ValueArray,
}

/// Walks `path` from the root, creating missing tables and arrays. `leaf` is
/// the segment the caller will apply after the walk (for `set_value`), so a
/// missing array that only holds a leaf value becomes an array value rather
/// than an array of tables. Returns the position and whether the last step
/// created it.
fn walk<'d>(
    doc: &'d mut DocumentMut,
    path: &[Seg],
    leaf: Option<&Seg>,
) -> Result<(Cur<'d>, bool), PatchError> {
    let mut cur = Cur::Table(doc.as_table_mut());
    let mut created = false;
    for (n, seg) in path.iter().enumerate() {
        let here = &path[..=n];
        let want = match (path.get(n + 1), leaf) {
            (Some(Seg::Index(_)), _) => Want::TableArray,
            (None, Some(Seg::Index(_))) => Want::ValueArray,
            _ => Want::Table,
        };
        (cur, created) = step(cur, seg, want, here)?;
    }
    Ok((cur, created))
}

fn step<'a>(
    cur: Cur<'a>,
    seg: &Seg,
    want: Want,
    here: &[Seg],
) -> Result<(Cur<'a>, bool), PatchError> {
    let parent = &here[..here.len() - 1];
    match seg {
        Seg::Key(key) => {
            let found = cur.kind();
            let (table, inline) = cur
                .into_table_like()
                .ok_or_else(|| conflict(parent, found, "a table"))?;
            let present = table.get(key).is_some_and(|item| !item.is_none());
            if !present {
                let child = new_child(want, inline, table.is_dotted());
                insert_new(table, inline, key, child);
            }
            let item = table
                .get_mut(key)
                .ok_or_else(|| conflict(here, "missing", "a table"))?;
            Ok((Cur::Item(item), !present))
        }
        Seg::Index(index) => {
            let index = *index;
            match cur {
                Cur::Item(Item::ArrayOfTables(tables)) => {
                    let len = tables.len();
                    if index == len {
                        tables.push(Table::new());
                    }
                    let table = tables
                        .get_mut(index)
                        .ok_or_else(|| out_of_range(here, index, len))?;
                    Ok((Cur::Table(table), index == len))
                }
                Cur::Item(Item::Value(Value::Array(array))) | Cur::Value(Value::Array(array)) => {
                    let len = array.len();
                    if index == len {
                        let entry =
                            default_array_decor(array, Value::InlineTable(InlineTable::new()));
                        array.push_formatted(entry);
                    }
                    let value = array
                        .get_mut(index)
                        .ok_or_else(|| out_of_range(here, index, len))?;
                    Ok((Cur::Value(value), index == len))
                }
                other => Err(conflict(parent, other.kind(), "an array")),
            }
        }
    }
}

fn new_child(want: Want, inline: bool, dotted: bool) -> Item {
    match (want, inline) {
        (Want::Table, true) => Item::Value(Value::InlineTable(InlineTable::new())),
        (Want::TableArray | Want::ValueArray, true) | (Want::ValueArray, false) => {
            Item::Value(Value::Array(Array::new()))
        }
        (Want::TableArray, false) => Item::ArrayOfTables(ArrayOfTables::new()),
        (Want::Table, false) => {
            let mut table = Table::new();
            if dotted {
                table.set_dotted(true);
            } else {
                table.set_implicit(true);
            }
            Item::Table(table)
        }
    }
}

/// Rewrites TOML 1.1-only syntax to TOML 1.0 in place.
struct Toml10;

impl VisitMut for Toml10 {
    fn visit_value_mut(&mut self, node: &mut Value) {
        match node {
            Value::String(s) if has_toml11_escape(s) => {
                let decor = s.decor().clone();
                let mut fresh = Formatted::new(s.value().clone());
                *fresh.decor_mut() = decor;
                *s = fresh;
            }
            Value::Datetime(dt) => {
                let mut value = *dt.value();
                if let Some(time) = value.time.as_mut().filter(|t| t.second.is_none()) {
                    time.second = Some(0);
                    let decor = dt.decor().clone();
                    let mut fresh = Formatted::new(value);
                    *fresh.decor_mut() = decor;
                    *dt = fresh;
                }
            }
            _ => {}
        }
        visit_mut::visit_value_mut(self, node);
    }

    fn visit_inline_table_mut(&mut self, node: &mut InlineTable) {
        let mut inner = node.clone();
        inner.decor_mut().clear();
        if node.trailing_comma() || inner.to_string().contains('\n') {
            node.set_trailing_comma(false);
            node.set_trailing("");
            node.fmt();
        }
        visit_mut::visit_inline_table_mut(self, node);
    }
}

/// True for a basic string whose source uses the TOML 1.1 `\e` or `\xHH`
/// escapes. Strings built in code have no source and are encoded as 1.0.
fn has_toml11_escape(s: &Formatted<String>) -> bool {
    let Some(raw) = s.as_repr().and_then(|r| r.as_raw().as_str()) else {
        return false;
    };
    if !raw.starts_with('"') {
        return false; // literal strings have no escapes
    }
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('e' | 'x') => return true,
                _ => continue,
            }
        }
    }
    false
}

impl fmt::Display for Seg {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&path_string(std::slice::from_ref(self)))
    }
}

#[cfg(test)]
mod tests;
