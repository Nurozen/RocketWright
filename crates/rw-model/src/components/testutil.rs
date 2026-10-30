//! Test helpers for the per-kind rules.

use crate::types::{EvalComponent, EvalOptions, EvaluatedModel, SourceSet};
use crate::{eval, parse_source_with_warnings};

/// Evaluates project files given as `(path, text)`; parse warnings fail.
pub fn project(files: &[(&str, &str)]) -> EvaluatedModel {
    let mut s = SourceSet::default();
    for (p, t) in files {
        let (d, w) = parse_source_with_warnings(p, t).unwrap_or_else(|e| panic!("{p}: {e:?}"));
        assert!(w.is_empty(), "{p}: {w:?}");
        s.docs.insert((*p).to_string(), d);
    }
    eval(&s, &EvalOptions::default())
}

/// Evaluates a single `rocket.rw.toml`.
pub fn model(rocket: &str) -> EvaluatedModel {
    project(&[("rocket.rw.toml", rocket)])
}

/// A tube body to attach parts to, plus `extra` tables.
pub fn on_body(extra: &str) -> EvaluatedModel {
    model(&format!(
        r#"
[c.body]
type = "body_tube"
length = "300 mm"
od = "25 mm"
thickness = "1 mm"

{extra}
"#
    ))
}

/// `(code, path)` of every diagnostic.
pub fn codes(m: &EvaluatedModel) -> Vec<(String, String)> {
    m.diagnostics
        .iter()
        .map(|d| (d.code.clone(), d.path.clone().unwrap_or_default()))
        .collect()
}

/// Asserts a diagnostic with `code` at `path`.
#[track_caller]
pub fn assert_diag(m: &EvaluatedModel, code: &str, path: &str) {
    let got = codes(m);
    assert!(
        got.iter().any(|(c, p)| c == code && p == path),
        "missing {code} at {path} in {got:?}"
    );
}

/// Asserts no diagnostics at all.
#[track_caller]
pub fn assert_clean(m: &EvaluatedModel) {
    assert!(m.diagnostics.is_empty(), "{:#?}", m.diagnostics);
}

pub fn comp<'a>(m: &'a EvaluatedModel, id: &str) -> &'a EvalComponent {
    m.components
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("no component `{id}`"))
}
