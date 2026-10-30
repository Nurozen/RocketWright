//! The `rw:` ref parser (R2.8, M1.23): `rw:<kind>/<id>[#anchor][@version][/pointer]`.
//!
//! Mirrors `app/packages/contracts/src/refs.ts`; both run the vectors in
//! `schema/testdata/refs.json`.

use std::fmt;

use crate::types::{RefKind, RefParts};

/// Why a ref did not parse (the `err` slugs of `schema/testdata/refs.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefError {
    MissingScheme,
    ResourceUri,
    UnknownKind,
    EmptyId,
    EmptyAnchor,
    EmptyVersion,
    Syntax,
}

impl RefError {
    pub const fn slug(self) -> &'static str {
        match self {
            RefError::MissingScheme => "missing_scheme",
            RefError::ResourceUri => "resource_uri",
            RefError::UnknownKind => "unknown_kind",
            RefError::EmptyId => "empty_id",
            RefError::EmptyAnchor => "empty_anchor",
            RefError::EmptyVersion => "empty_version",
            RefError::Syntax => "syntax",
        }
    }
}

impl fmt::Display for RefError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.slug())
    }
}

impl RefKind {
    /// The spelling after `rw:`.
    pub const fn as_str(self) -> &'static str {
        match self {
            RefKind::C => "c",
            RefKind::Cfg => "cfg",
            RefKind::Sim => "sim",
            RefKind::Run => "run",
            RefKind::Step => "step",
            RefKind::Rev => "rev",
            RefKind::Thread => "thread",
            RefKind::Eng => "eng",
        }
    }
    pub fn from_name(s: &str) -> Option<RefKind> {
        Some(match s {
            "c" => RefKind::C,
            "cfg" => RefKind::Cfg,
            "sim" => RefKind::Sim,
            "run" => RefKind::Run,
            "step" => RefKind::Step,
            "rev" => RefKind::Rev,
            "thread" => RefKind::Thread,
            "eng" => RefKind::Eng,
            _ => return None,
        })
    }
}

fn id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')
}
fn anchor_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '<' | '>')
}
fn version_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-')
}

/// Splits `s` at the first char that fails `ok`.
fn take(s: &str, ok: fn(char) -> bool) -> (&str, &str) {
    let n = s.find(|c: char| !ok(c)).unwrap_or(s.len());
    s.split_at(n)
}

/// Parses an `rw:` ref.
pub fn parse_ref(input: &str) -> Result<RefParts, RefError> {
    if input.starts_with("rw://") {
        return Err(RefError::ResourceUri);
    }
    let rest = input.strip_prefix("rw:").ok_or(RefError::MissingScheme)?;
    let (kind, rest) = rest.split_once('/').ok_or(RefError::Syntax)?;
    let kind = RefKind::from_name(kind).ok_or(RefError::UnknownKind)?;
    let (id, mut rest) = take(rest, id_char);
    if id.is_empty() {
        return Err(RefError::EmptyId);
    }
    let mut anchor = None;
    if let Some(r) = rest.strip_prefix('#') {
        let (a, r) = take(r, anchor_char);
        if a.is_empty() {
            return Err(RefError::EmptyAnchor);
        }
        anchor = Some(a.to_string());
        rest = r;
    }
    let mut version = None;
    if let Some(r) = rest.strip_prefix('@') {
        let (v, r) = take(r, version_char);
        if v.is_empty() {
            return Err(RefError::EmptyVersion);
        }
        version = Some(v.to_string());
        rest = r;
    }
    let pointer = if rest.is_empty() {
        String::new()
    } else if rest.starts_with('/') && !rest.contains(char::is_whitespace) {
        rest.to_string()
    } else {
        return Err(RefError::Syntax);
    };
    Ok(RefParts {
        kind,
        id: id.to_string(),
        anchor,
        version,
        pointer,
    })
}

impl fmt::Display for RefParts {
    /// The canonical ref text; `parse_ref(&parts.to_string()) == Ok(parts)`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "rw:{}/{}", self.kind.as_str(), self.id)?;
        if let Some(a) = &self.anchor {
            write!(f, "#{a}")?;
        }
        if let Some(v) = &self.version {
            write!(f, "@{v}")?;
        }
        f.write_str(&self.pointer)
    }
}

impl RefParts {
    /// The JSON pointer into the model value this ref addresses, for the
    /// patchable kinds (`c`, `cfg`, `sim`, `eng`) without anchor or version.
    pub fn model_pointer(&self) -> Option<String> {
        let coll = match self.kind {
            RefKind::C => "c",
            RefKind::Cfg => "configs",
            RefKind::Sim => "sims",
            RefKind::Eng => "engines",
            _ => return None,
        };
        if self.anchor.is_some() || self.version.is_some() {
            return None;
        }
        Some(format!("/{coll}/{}{}", self.id, self.pointer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::RwRef;
    use serde_json::Value;

    const VECTORS: &str = include_str!("../../../schema/testdata/refs.json");

    #[test]
    fn shared_vectors() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        let rows = v["vectors"].as_array().unwrap();
        assert!(rows.len() >= 20);
        for row in rows {
            let input = row["input"].as_str().unwrap();
            let got = RwRef(input.to_string()).parse();
            match (row.get("ok"), got) {
                (Some(ok), Ok(parts)) => {
                    assert_eq!(serde_json::to_value(&parts).unwrap(), *ok, "{input}");
                    assert_eq!(parts.to_string(), input, "round trip");
                }
                (Some(_), Err(e)) => panic!("{input}: {e}"),
                (None, Ok(p)) => panic!("{input}: parsed to {p:?}"),
                (None, Err(e)) => assert_eq!(e, row["err"].as_str().unwrap(), "{input}"),
            }
        }
    }

    #[test]
    fn model_pointers() {
        let p = |s: &str| parse_ref(s).unwrap().model_pointer();
        assert_eq!(p("rw:c/fins/span").as_deref(), Some("/c/fins/span"));
        assert_eq!(p("rw:cfg/baseline").as_deref(), Some("/configs/baseline"));
        assert_eq!(p("rw:c/fins#root_le"), None);
        assert_eq!(p("rw:c/fins@s3"), None);
        assert_eq!(p("rw:run/abc"), None);
    }
}
