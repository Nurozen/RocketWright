//! Source parsing (M1.21): one file → a typed [`SourceDoc`], by path.
//!
//! | Path | Document |
//! |---|---|
//! | `rocketwright.toml` | [`ProjectManifest`] |
//! | `configs/<id>.rw.toml` | [`ConfigDoc`] |
//! | `sims/<id>.rw.toml` | [`SimDoc`] |
//! | `engines/<id>.rw.toml` | [`EngineDoc`] |
//! | any other `*.rw.toml` (`rocket.rw.toml`, `parts/*.rw.toml`) | [`RocketDoc`] |
//!
//! The JSON twin (`.rw.json`, `rocketwright.json`) parses to the same types.
//! Keys the schema does not know are kept out of the model and reported as
//! `RW-W001 unknown-field` warnings, so a misspelt field never passes silently.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::diag::{self, Diagnostic};
use crate::types::{ConfigDoc, EngineDoc, ProjectManifest, RocketDoc, SimDoc, SourceDoc};

/// The kind of document a path holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocKind {
    Project,
    Rocket,
    Config,
    Sim,
    Engine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Toml,
    Json,
}

fn classify(path: &str) -> Option<(DocKind, Format)> {
    let p = path.replace('\\', "/");
    let name = p.rsplit('/').next().unwrap_or(&p);
    match name {
        "rocketwright.toml" => return Some((DocKind::Project, Format::Toml)),
        "rocketwright.json" => return Some((DocKind::Project, Format::Json)),
        _ => {}
    }
    let fmt = if name.ends_with(".rw.toml") {
        Format::Toml
    } else if name.ends_with(".rw.json") {
        Format::Json
    } else {
        return None;
    };
    let dir = p.rsplit('/').nth(1).unwrap_or("");
    let kind = match dir {
        "configs" => DocKind::Config,
        "sims" => DocKind::Sim,
        "engines" => DocKind::Engine,
        _ => DocKind::Rocket,
    };
    Some((kind, fmt))
}

/// The document kind for a project-relative path, or `None` when the path is
/// not a RocketWright source file.
pub fn doc_kind(path: &str) -> Option<DocKind> {
    classify(path).map(|(k, _)| k)
}

/// 1-based line and column of a byte offset.
fn line_col(text: &str, offset: usize) -> (u32, u32) {
    let before = &text[..offset.min(text.len())];
    let line = before.matches('\n').count() + 1;
    let col = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
    (line as u32, col as u32)
}

fn located(
    code: &str,
    path: &str,
    text: &str,
    span: Option<std::ops::Range<usize>>,
    msg: String,
) -> Diagnostic {
    let mut d = Diagnostic::new(code, None, msg);
    d.file = Some(path.to_string());
    if let Some(s) = span {
        let (l, c) = line_col(text, s.start);
        d.line = Some(l);
        d.col = Some(c);
    }
    d
}

fn parse_as<T: DeserializeOwned + Serialize>(
    path: &str,
    text: &str,
    fmt: Format,
) -> Result<(T, Vec<Diagnostic>), Vec<Diagnostic>> {
    let (raw, typed): (Value, Result<T, Diagnostic>) = match fmt {
        Format::Toml => {
            let raw: Value = toml::from_str(text).map_err(|e| {
                vec![
                    located(diag::E_PARSE, path, text, e.span(), e.message().to_string())
                        .with_hint(
                            "fix the TOML syntax; `rw fmt` rewrites a valid file canonically",
                        ),
                ]
            })?;
            let typed = typed_toml::<T>(path, text, &raw);
            (raw, typed)
        }
        Format::Json => {
            let raw: Value = serde_json::from_str(text).map_err(|e| {
                let mut d = Diagnostic::new(diag::E_PARSE, None, e.to_string());
                d.file = Some(path.to_string());
                d.line = Some(e.line() as u32);
                d.col = Some(e.column() as u32);
                vec![d]
            })?;
            let typed = serde_json::from_value::<T>(raw.clone()).map_err(|e| {
                let mut d = Diagnostic::new(diag::E_SCHEMA, None, e.to_string())
                    .with_hint("see `rw schema` for the fields of this document");
                d.file = Some(path.to_string());
                d
            });
            (raw, typed)
        }
    };
    let doc = typed.map_err(|d| vec![d])?;
    let known = serde_json::to_value(&doc).unwrap_or(Value::Null);
    let mut warnings = Vec::new();
    unknown_keys(&raw, &known, String::new(), &mut |ptr| {
        let mut d = Diagnostic::new(
            diag::W_UNKNOWN_FIELD,
            ptr.clone(),
            format!("`{ptr}` is not a known field and is ignored"),
        )
        .with_hint("check the spelling against `rw schema`");
        d.file = Some(path.to_string());
        warnings.push(d);
    });
    Ok((doc, warnings))
}

/// The typed TOML document. Native: the typed `toml` deserializer, whose
/// errors carry a span (line/col).
#[cfg(not(target_arch = "wasm32"))]
#[allow(clippy::result_large_err)] // the callers' existing error type
fn typed_toml<T: serde::de::DeserializeOwned>(
    path: &str,
    text: &str,
    _raw: &Value,
) -> Result<T, Diagnostic> {
    toml::from_str::<T>(text).map_err(|e| {
        located(
            diag::E_SCHEMA,
            path,
            text,
            e.span(),
            e.message().to_string(),
        )
        .with_hint("see `rw schema` for the fields of this document")
    })
}

/// The typed TOML document. wasm32 (M1.32 size budget): from the already
/// parsed value, as the JSON twin does, so the typed `toml` deserializers are
/// not monomorphized into the module. Successful parses are identical (the
/// node test compares against native); schema errors carry no line/col (the
/// sidecar serves only files that parsed).
#[cfg(target_arch = "wasm32")]
#[allow(clippy::result_large_err)] // the callers' existing error type
fn typed_toml<T: serde::de::DeserializeOwned>(
    path: &str,
    _text: &str,
    raw: &Value,
) -> Result<T, Diagnostic> {
    serde_json::from_value::<T>(raw.clone()).map_err(|e| {
        let mut d = Diagnostic::new(diag::E_SCHEMA, None, e.to_string())
            .with_hint("see `rw schema` for the fields of this document");
        d.file = Some(path.to_string());
        d
    })
}

fn escape(k: &str) -> String {
    k.replace('~', "~0").replace('/', "~1")
}

/// Reports keys of `raw` that do not survive a typed round trip. Keys whose
/// value is `false`, `[]`, or `{}` are skipped: those are defaults the
/// serializer omits.
fn unknown_keys(raw: &Value, known: &Value, at: String, report: &mut dyn FnMut(String)) {
    match (raw, known) {
        (Value::Object(r), Value::Object(k)) => {
            for (key, rv) in r {
                let ptr = format!("{at}/{}", escape(key));
                match k.get(key) {
                    Some(kv) => unknown_keys(rv, kv, ptr, report),
                    None => {
                        let default_like = matches!(rv, Value::Bool(false))
                            || rv.as_array().is_some_and(Vec::is_empty)
                            || rv.as_object().is_some_and(|o| o.is_empty());
                        if !default_like {
                            report(ptr);
                        }
                    }
                }
            }
        }
        (Value::Array(r), Value::Array(k)) if r.len() == k.len() => {
            for (i, (rv, kv)) in r.iter().zip(k).enumerate() {
                unknown_keys(rv, kv, format!("{at}/{i}"), report);
            }
        }
        _ => {}
    }
}

/// Parses one source file and also returns warnings (`RW-W001`).
pub fn parse_source_with_warnings(
    path: &str,
    text: &str,
) -> Result<(SourceDoc, Vec<Diagnostic>), Vec<Diagnostic>> {
    let Some((kind, fmt)) = classify(path) else {
        let mut d = Diagnostic::new(
            diag::E_DOC_KIND,
            None,
            format!("`{path}` is not a RocketWright source file"),
        )
        .with_hint("source files are rocketwright.toml and *.rw.toml (or their .json twins)");
        d.file = Some(path.to_string());
        return Err(vec![d]);
    };
    Ok(match kind {
        DocKind::Project => {
            let (d, w) = parse_as::<ProjectManifest>(path, text, fmt)?;
            (SourceDoc::Project(d), w)
        }
        DocKind::Rocket => {
            let (d, w) = parse_as::<RocketDoc>(path, text, fmt)?;
            (SourceDoc::Rocket(d), w)
        }
        DocKind::Config => {
            let (d, w) = parse_as::<ConfigDoc>(path, text, fmt)?;
            (SourceDoc::Config(d), w)
        }
        DocKind::Sim => {
            let (d, w) = parse_as::<SimDoc>(path, text, fmt)?;
            (SourceDoc::Sim(d), w)
        }
        DocKind::Engine => {
            let (d, w) = parse_as::<EngineDoc>(path, text, fmt)?;
            (SourceDoc::Engine(d), w)
        }
    })
}

/// Parses one source file (`*.rw.toml`, or its JSON twin) by path suffix.
/// Warnings are dropped; use [`parse_source_with_warnings`] to keep them.
pub fn parse_source(path: &str, text: &str) -> Result<SourceDoc, Vec<Diagnostic>> {
    parse_source_with_warnings(path, text).map(|(d, _)| d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ComponentKind;

    #[test]
    fn classifies_paths() {
        assert_eq!(doc_kind("rocketwright.toml"), Some(DocKind::Project));
        assert_eq!(doc_kind("rocket.rw.toml"), Some(DocKind::Rocket));
        assert_eq!(doc_kind("parts/fin_can.rw.toml"), Some(DocKind::Rocket));
        assert_eq!(doc_kind("configs/baseline.rw.toml"), Some(DocKind::Config));
        assert_eq!(doc_kind("sims/baseline.rw.json"), Some(DocKind::Sim));
        assert_eq!(doc_kind("engines/main.rw.toml"), Some(DocKind::Engine));
        assert_eq!(doc_kind("notes.md"), None);
    }

    #[test]
    fn parses_toml_and_json_twins_alike() {
        let toml = r#"
name = "t"
[params.span]
value = "90 mm"
min = "60 mm"
group = "Fins"

[variants.long]
span = "110 mm"

[c.body]
type = "body_tube"
length = "300 mm"
od = "54 mm"
"#;
        let json = r#"{"name":"t","params":{"span":{"value":"90 mm","min":"60 mm","group":"Fins"}},
            "variants":{"long":{"span":"110 mm"}},
            "c":{"body":{"type":"body_tube","length":"300 mm","od":"54 mm"}}}"#;
        let a = parse_source("rocket.rw.toml", toml).unwrap();
        let b = parse_source("rocket.rw.json", json).unwrap();
        assert_eq!(a, b);
        let SourceDoc::Rocket(r) = a else { panic!() };
        assert!(matches!(r.c["body"].kind, ComponentKind::BodyTube(_)));
        assert_eq!(r.params["span"].group.as_deref(), Some("Fins"));
    }

    #[test]
    fn syntax_errors_carry_line_and_column() {
        let e = parse_source("rocket.rw.toml", "name = \"x\"\n[c.body\n").unwrap_err();
        assert_eq!(e[0].code, "RW-E001");
        assert_eq!(e[0].line, Some(2));
        assert_eq!(e[0].file.as_deref(), Some("rocket.rw.toml"));
    }

    #[test]
    fn schema_errors_are_e002() {
        let e = parse_source(
            "rocket.rw.toml",
            "[c.body]\ntype = \"body_tube\"\nod = \"54 mm\"\n",
        )
        .unwrap_err();
        assert_eq!(e[0].code, "RW-E002");
        assert!(e[0].message.contains("length"), "{}", e[0].message);
    }

    #[test]
    fn unknown_fields_warn() {
        let t = "[c.body]\ntype = \"body_tube\"\nlength = \"1 m\"\nod = \"54 mm\"\nspam = \"2 mm\"\ncut = false\n";
        let (_, w) = parse_source_with_warnings("rocket.rw.toml", t).unwrap();
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].code, "RW-W001");
        assert_eq!(w[0].path.as_deref(), Some("/c/body/spam"));
    }

    #[test]
    fn non_source_paths_fail() {
        assert_eq!(parse_source("x.txt", "").unwrap_err()[0].code, "RW-E005");
    }
}
