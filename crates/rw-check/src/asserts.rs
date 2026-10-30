//! `[[assert]]` rules and `[report]` values.
//!
//! Both use the rw-model expression language. Before parsing, every metric
//! path (`stability.liftoff`, `mass.liftoff`, `cg`, `apogee_m`, ...) is
//! rewritten into a private ref, so the expression parser (which knows only
//! `params.*` and `c.*` refs) evaluates it with its usual dimension rules.
//! The unit `cal` after a number means calibers (dimensionless) here, not
//! calories. An assertion is `<expr> <op> <expr>` with `op` one of
//! `>= <= > < == !=`; both sides are compared in SI at [`SIG_FIGS`].

use std::collections::BTreeMap;
use std::sync::OnceLock;

use rw_model::expr::{ExprError, ExprErrorKind, Resolve, Val, evaluate, parse};
use rw_model::{Diagnostic, EvaluatedModel};
use rw_units::{DimKind, Dimension};
use serde_json::Value;

use crate::canon::{SIG_FIGS, round_sig};
use crate::metrics::Metric;
use crate::{AssertionResult, ReportValue};

const METRIC_REF: &str = "params.__rw_metric_";

include!(concat!(env!("OUT_DIR"), "/field_dims.rs"));

/// Field name → dimension, from the `x-unit-dimension` annotations of the
/// IF2 schema (tabulated by `build.rs`, so new component kinds are covered
/// without a hand-written table and the runtime carries no schemars code).
fn field_dims() -> &'static BTreeMap<String, DimKind> {
    static DIMS: OnceLock<BTreeMap<String, DimKind>> = OnceLock::new();
    DIMS.get_or_init(|| {
        FIELD_DIMS
            .iter()
            .filter_map(|(k, d)| DimKind::from_name(d).map(|d| ((*k).to_string(), d)))
            .collect()
    })
}

/// The dimension of an evaluated-model field by name (`span` → length),
/// from the IF2 `x-unit-dimension` annotations; `None` for pure numbers and
/// unannotated fields.
/// cite: n/a schema lookup, no physics
pub fn field_dim(name: &str) -> Option<DimKind> {
    field_dims().get(name).copied()
}

fn err(kind: ExprErrorKind, message: String, hint: Option<String>) -> ExprError {
    ExprError {
        kind,
        message,
        hint,
    }
}

struct Scope<'a> {
    model: &'a EvaluatedModel,
    metrics: Vec<Metric>,
}

impl Scope<'_> {
    fn component(&self, path: &str) -> Result<Val, ExprError> {
        let unknown = || {
            err(
                ExprErrorKind::UnknownRef,
                format!("`{path}` does not exist"),
                Some("see `rw eval --json` for component ids and fields".into()),
            )
        };
        let mut parts = path.split('.').skip(1);
        let id = parts.next().ok_or_else(unknown)?;
        let c = self
            .model
            .components
            .iter()
            .find(|c| c.id == id)
            .ok_or_else(unknown)?;
        let fields: Vec<&str> = parts.collect();
        let Some(first) = fields.first().copied() else {
            return Err(unknown());
        };
        let v = serde_json::to_value(c).map_err(|_| unknown())?;
        // Shape fields first: `c.body.id` is the bore, not the component id.
        let mut cur = v
            .get("shape")
            .and_then(|s| s.get(first))
            .or_else(|| v.get(first).filter(|_| first != "shape"));
        if cur.is_none() && first == "length" && fields.len() == 1 {
            return Ok(Val::new(c.x_aft - c.x_fore, DimKind::Length.dimension()));
        }
        for f in &fields[1..] {
            cur = cur.and_then(|x| x.get(*f));
        }
        let x = cur.and_then(Value::as_f64).ok_or_else(unknown)?;
        let last = fields.last().copied().unwrap_or(first);
        let dim = field_dims()
            .get(last)
            .map_or(Dimension::NONE, |d| d.dimension());
        Ok(Val::new(x, dim))
    }
}

impl Resolve for Scope<'_> {
    fn resolve(&mut self, path: &str) -> Result<Val, ExprError> {
        if let Some(i) = path.strip_prefix(METRIC_REF) {
            let m = i
                .parse::<usize>()
                .ok()
                .and_then(|i| self.metrics.get(i))
                .ok_or_else(|| err(ExprErrorKind::UnknownRef, format!("`{path}`"), None))?;
            return Ok(Val::new(m.value, m.dim.dimension()));
        }
        if let Some(name) = path.strip_prefix("params.") {
            let p = self.model.params.get(name).ok_or_else(|| {
                err(
                    ExprErrorKind::UnknownRef,
                    format!("`{path}` does not exist"),
                    Some(format!("define `[params.{name}]`")),
                )
            })?;
            return Ok(Val::new(p.value, p.dim.dimension()));
        }
        if path.starts_with("c.") {
            return self.component(path);
        }
        Err(err(
            ExprErrorKind::UnknownRef,
            format!("`{path}` does not exist"),
            None,
        ))
    }
}

/// True when the previous non-space character ends a number, so an
/// identifier at this position is a unit.
fn after_number(s: &[char], at: usize) -> bool {
    s[..at]
        .iter()
        .rev()
        .find(|c| !c.is_whitespace())
        .is_some_and(|c| c.is_ascii_digit() || *c == '.')
}

/// Rewrites metric paths in `src` into private refs and drops `cal` units.
fn rewrite(
    src: &str,
    scope: &BTreeMap<String, Metric>,
    out: &mut Vec<Metric>,
) -> Result<String, ExprError> {
    const ROOTS: &[&str] = &[
        "dims",
        "mass",
        "aero",
        "stability",
        "motor",
        "clearance",
        "sim",
    ];
    let s: Vec<char> = src.chars().collect();
    let mut res = String::new();
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        let boundary = i == 0 || !(s[i - 1].is_ascii_alphanumeric() || s[i - 1] == '_');
        if (c.is_ascii_alphabetic() || c == '_') && boundary {
            let start = i;
            while i < s.len() && (s[i].is_ascii_alphanumeric() || s[i] == '_' || s[i] == '.') {
                i += 1;
            }
            let word: String = s[start..i].iter().collect();
            if after_number(&s, start) {
                if word != "cal" {
                    res.push_str(&word);
                }
                continue;
            }
            if let Some(m) = scope.get(&word) {
                res.push_str(&format!("{METRIC_REF}{}", out.len()));
                out.push(*m);
                continue;
            }
            let root = word.split('.').next().unwrap_or("");
            if word.contains('.') && ROOTS.contains(&root) {
                return Err(err(
                    ExprErrorKind::UnknownRef,
                    format!("`{word}` is not a check metric"),
                    Some("metric paths are listed in docs/dev/metric-paths.md".into()),
                ));
            }
            res.push_str(&word);
            continue;
        }
        res.push(c);
        i += 1;
    }
    Ok(res)
}

fn eval_side(
    src: &str,
    model: &EvaluatedModel,
    scope: &BTreeMap<String, Metric>,
) -> Result<Val, ExprError> {
    let mut metrics = Vec::new();
    let text = rewrite(src, scope, &mut metrics)?;
    let e = parse(&text)?;
    evaluate(&e, &mut Scope { model, metrics })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Ge,
    Le,
    Gt,
    Lt,
    Eq,
    Ne,
}

/// Splits `lhs op rhs` at the first comparison outside parentheses.
fn split_cmp(src: &str) -> Option<(&str, Op, &str)> {
    let b = src.as_bytes();
    let mut depth = 0i32;
    for i in 0..b.len() {
        match b[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b'>' | b'<' | b'=' | b'!' if depth == 0 => {
                let two = b.get(i + 1) == Some(&b'=');
                let op = match (b[i], two) {
                    (b'>', true) => Op::Ge,
                    (b'<', true) => Op::Le,
                    (b'>', false) => Op::Gt,
                    (b'<', false) => Op::Lt,
                    (b'=', true) => Op::Eq,
                    (b'!', true) => Op::Ne,
                    _ => continue,
                };
                let w = if two { 2 } else { 1 };
                return Some((&src[..i], op, &src[i + w..]));
            }
            _ => {}
        }
    }
    None
}

/// Evaluates one `[[assert]]` rule against the metric scope.
pub(crate) fn assertion(
    a: &rw_model::EvalAssert,
    model: &EvaluatedModel,
    scope: &BTreeMap<String, Metric>,
    have_sim: bool,
) -> AssertionResult {
    let mut res = AssertionResult {
        id: a.id.clone(),
        expr: a.expr.clone(),
        value: None,
        pass: true,
        severity: a.severity,
        needs_sim: a.needs_sim,
        message: None,
    };
    if a.needs_sim && !have_sim {
        res.message = Some("needs --sim quick".into());
        return res;
    }
    let fail = |mut r: AssertionResult, msg: String| {
        r.pass = false;
        r.message = Some(msg);
        r
    };
    let Some((l, op, r)) = split_cmp(&a.expr) else {
        return fail(
            res,
            "expected `<metric> <op> <value>` with op one of >= <= > < == !=".into(),
        );
    };
    let (lv, rv) = match (eval_side(l, model, scope), eval_side(r, model, scope)) {
        (Ok(lv), Ok(rv)) => (lv, rv),
        (Err(e), _) | (_, Err(e)) => return fail(res, e.message),
    };
    let lenient = lv.dim.is_none() || rv.dim.is_none() || lv.any_dim || rv.any_dim;
    if lv.dim != rv.dim && !lenient {
        return fail(
            res,
            format!(
                "cannot compare {} with {}",
                rw_model::expr::dim_label(lv.dim),
                rw_model::expr::dim_label(rv.dim)
            ),
        );
    }
    let (x, y) = (round_sig(lv.value, SIG_FIGS), round_sig(rv.value, SIG_FIGS));
    res.value = Some(lv.value);
    res.pass = match op {
        Op::Ge => x >= y,
        Op::Le => x <= y,
        Op::Gt => x > y,
        Op::Lt => x < y,
        Op::Eq => x == y,
        Op::Ne => x != y,
    };
    if !res.pass {
        res.message =
            Some(a.message.clone().unwrap_or_else(|| {
                format!("{} is {}, which fails `{}`", l.trim(), lv.value, a.expr)
            }));
    }
    res
}

/// Evaluates the `[report]` expressions; failures become diagnostics.
pub(crate) fn report_values(
    model: &EvaluatedModel,
    scope: &BTreeMap<String, Metric>,
    diags: &mut Vec<Diagnostic>,
) -> BTreeMap<String, ReportValue> {
    let mut out = BTreeMap::new();
    for (i, src) in model.report.iter().enumerate() {
        let body = src.trim_start();
        let body = body.strip_prefix('=').unwrap_or(body);
        match eval_side(body, model, scope) {
            Ok(v) => {
                out.insert(
                    src.clone(),
                    ReportValue {
                        value: v.value,
                        dim: v.kind().unwrap_or(DimKind::Dimensionless),
                    },
                );
            }
            Err(e) => {
                let mut d = Diagnostic::new(
                    e.kind.code(),
                    Some(format!("/report/values/{i}")),
                    format!("[report] `{src}`: {}", e.message),
                );
                d.hint = e.hint;
                diags.push(d);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_comparisons_outside_parentheses() {
        let (l, op, r) = split_cmp("max(a, b) >= 1 cal").unwrap();
        assert_eq!((l.trim(), op, r.trim()), ("max(a, b)", Op::Ge, "1 cal"));
        assert_eq!(split_cmp("x < 2").unwrap().1, Op::Lt);
        assert_eq!(split_cmp("x != 2").unwrap().1, Op::Ne);
        assert!(split_cmp("x + 2").is_none());
    }

    #[test]
    fn rewrites_metrics_and_calibers() {
        let mut scope = BTreeMap::new();
        scope.insert(
            "stability.liftoff".to_string(),
            Metric {
                value: 1.5,
                dim: DimKind::Dimensionless,
            },
        );
        let mut out = Vec::new();
        let s = rewrite("stability.liftoff - 1 cal", &scope, &mut out).unwrap();
        assert_eq!(s, format!("{METRIC_REF}0 - 1 "));
        assert_eq!(out.len(), 1);
        let s = rewrite("15 m/s", &scope, &mut out).unwrap();
        assert_eq!(s, "15 m/s");
        assert!(rewrite("stability.nope", &scope, &mut out).is_err());
    }

    #[test]
    fn schema_dims_cover_shape_fields() {
        let d = field_dims();
        assert_eq!(d.get("span"), Some(&DimKind::Length));
        assert_eq!(d.get("mass"), Some(&DimKind::Mass));
        assert_eq!(d.get("cant"), Some(&DimKind::Angle));
        assert!(!d.contains_key("cd"));
    }
}
