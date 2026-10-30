//! `[params.*]` and `[variants.*]` (R2.3, M1.21): the Customizer analogue.
//!
//! A param has a `value` (quantity, number, bool, choice string, or `=`
//! expression) and optional `min`, `max`, `step`, `choices`, `group`, `doc`.
//! A variant replaces param values by name (OpenSCAD `-P`); `--set` overrides
//! (`params.d=60 mm`, `c.fins.span=100 mm`, or a JSON pointer) apply after it.

use std::collections::BTreeMap;

use serde_json::Value;

use rw_units::DimKind;

use crate::diag::{self, Diagnostic};
use crate::expr::{ExprErrorKind, Scope, Val, dim_label};
use crate::patch::{apply_value, parse_pointer};
use crate::types::{EvalParam, PatchOp};

/// Parses a `--set` value: `true`/`false`, a bare number, or a string.
pub fn parse_set_value(raw: &str) -> Value {
    let t = raw.trim();
    match t {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        _ => {}
    }
    if let Ok(n) = t.parse::<f64>()
        && let Some(num) = serde_json::Number::from_f64(n)
    {
        return Value::Number(num);
    }
    Value::String(t.to_string())
}

/// The model-value pointer for a `--set` path: `params.<name>` (or
/// `params.<name>.value`, the `rw set` spelling) is the param's value,
/// `params.<name>.<field>` another param field, `c.<id>.<field>` a component
/// field; a JSON pointer passes through.
pub fn set_pointer(path: &str) -> String {
    let p = path.trim();
    if p.starts_with('/') || p.starts_with("rw:") {
        return p.to_string();
    }
    let mut parts = p.split('.');
    match parts.next() {
        Some("params") => {
            let name = parts.next().unwrap_or_default();
            let field: Vec<&str> = parts.collect();
            if field.is_empty() {
                format!("/params/{name}/value")
            } else {
                format!("/params/{name}/{}", field.join("/"))
            }
        }
        Some(first) => {
            let rest: Vec<&str> = parts.collect();
            let mut s = format!("/{first}");
            for r in rest {
                s.push('/');
                s.push_str(r);
            }
            s
        }
        None => String::new(),
    }
}

/// Applies the selected variant and the `--set` overrides to a model value.
pub fn apply_overrides(
    value: &mut Value,
    variant: Option<&str>,
    set: &BTreeMap<String, String>,
    diags: &mut Vec<Diagnostic>,
) {
    if let Some(v) = variant {
        match value.get("variants").and_then(|vs| vs.get(v)).cloned() {
            None => diags.push(
                Diagnostic::new(
                    diag::E_VARIANT,
                    format!("/variants/{v}"),
                    format!("variant `{v}` is not defined"),
                )
                .with_hint(
                    "define it under `[variants.<name>]` or pick one listed by `rw eval --json`",
                ),
            ),
            Some(Value::Object(entries)) => {
                for (name, pv) in entries {
                    let slot = value
                        .get_mut("params")
                        .and_then(|p| p.get_mut(&name))
                        .and_then(Value::as_object_mut);
                    match slot {
                        Some(obj) => {
                            obj.insert("value".into(), pv);
                        }
                        None => diags.push(
                            Diagnostic::new(
                                diag::E_SET,
                                format!("/variants/{v}/{name}"),
                                format!("variant `{v}` sets `{name}`, which is not a param"),
                            )
                            .with_hint(format!(
                                "add `[params.{name}]` or remove it from the variant"
                            )),
                        ),
                    }
                }
            }
            Some(_) => {}
        }
    }
    for (path, raw) in set {
        let ptr = set_pointer(path);
        let op = PatchOp::Add {
            path: ptr.clone(),
            value: parse_set_value(raw),
        };
        let ok = parse_pointer(&ptr).is_ok_and(|t| !t.is_empty());
        match apply_value(value, std::slice::from_ref(&op)) {
            Ok(v) if ok => *value = v,
            Ok(_) | Err(_) => diags.push(
                Diagnostic::new(
                    diag::E_SET,
                    ptr.clone(),
                    format!("cannot set `{path}`: no such param or field"),
                )
                .with_hint("use `params.<name>=<value>` or `c.<id>.<field>=<value>`"),
            ),
        }
    }
}

fn num_equal(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1e-300)
}

/// Evaluates every param: SI value plus dimension for numeric params, with
/// range, choice, and dimension checks. Bool and choice-string params are
/// checked but have no SI value, so they are not in the result.
pub fn eval_params(
    value: &Value,
    scope: &mut Scope,
    diags: &mut Vec<Diagnostic>,
) -> BTreeMap<String, EvalParam> {
    let mut out = BTreeMap::new();
    let Some(Value::Object(params)) = value.get("params") else {
        return out;
    };
    for (name, p) in params {
        let path = format!("/params/{name}");
        let raw = p.get("value").cloned().unwrap_or(Value::Null);
        let v = match scope.value_of(&format!("params.{name}")) {
            Ok(v) => Some(v),
            Err(e)
                if e.kind == ExprErrorKind::NotNumeric
                    && !raw.as_str().is_some_and(crate::expr::is_expr) =>
            {
                None
            }
            Err(e) => {
                let mut d = Diagnostic::new(e.kind.code(), format!("{path}/value"), e.message);
                d.hint = e.hint;
                diags.push(d);
                continue;
            }
        };
        let bound =
            |scope: &mut Scope, key: &str, x: &Value, diags: &mut Vec<Diagnostic>| -> Option<Val> {
                match scope.eval_value(x, &format!("params.{name}.{key}")) {
                    Ok(b) => {
                        if let Some(v) = v
                            && !b.any_dim
                            && !v.any_dim
                            && b.dim != v.dim
                        {
                            diags.push(
                                Diagnostic::new(
                                    diag::E_PARAM_DIM,
                                    format!("{path}/{key}"),
                                    format!(
                                        "`{key}` of `{name}` is {} but the value is {}",
                                        dim_label(b.dim),
                                        dim_label(v.dim)
                                    ),
                                )
                                .with_hint("give the bounds the same unit dimension as the value"),
                            );
                            return None;
                        }
                        Some(b)
                    }
                    Err(e) => {
                        let mut d =
                            Diagnostic::new(e.kind.code(), format!("{path}/{key}"), e.message);
                        d.hint = e.hint;
                        diags.push(d);
                        None
                    }
                }
            };
        // A bound in a hint as the file writes it (`30 mm`), so nobody
        // converts it back from SI; an expression bound prints its SI value.
        let as_written = |key: &str, si: f64| match p.get(key).and_then(Value::as_str) {
            Some(t) if !crate::expr::is_expr(t) => t.trim().to_string(),
            _ => format!("{si} (SI)"),
        };
        if let Some(v) = v {
            if let Some(min) = p.get("min").and_then(|m| bound(scope, "min", m, diags))
                && v.value < min.value
                && !num_equal(v.value, min.value)
            {
                diags.push(
                    Diagnostic::new(
                        diag::E_PARAM_RANGE,
                        format!("{path}/value"),
                        format!("`{name}` is below its min"),
                    )
                    .with_hint(format!(
                        "use a value of at least {}",
                        as_written("min", min.value)
                    )),
                );
            }
            if let Some(max) = p.get("max").and_then(|m| bound(scope, "max", m, diags))
                && v.value > max.value
                && !num_equal(v.value, max.value)
            {
                diags.push(
                    Diagnostic::new(
                        diag::E_PARAM_RANGE,
                        format!("{path}/value"),
                        format!("`{name}` is above its max"),
                    )
                    .with_hint(format!(
                        "use a value of at most {}",
                        as_written("max", max.value)
                    )),
                );
            }
            if let Some(step) = p.get("step") {
                bound(scope, "step", step, diags);
            }
        }
        if let Some(Value::Array(choices)) = p.get("choices")
            && !choices.is_empty()
        {
            let hit = choices.iter().enumerate().any(|(i, c)| match (v, c) {
                (_, Value::String(s)) if Some(s.as_str()) == raw.as_str() => true,
                (_, Value::Bool(b)) => raw.as_bool() == Some(*b),
                (Some(v), _) => bound(scope, &format!("choices/{i}"), c, diags)
                    .is_some_and(|c| num_equal(c.value, v.value)),
                _ => false,
            });
            if !hit {
                diags.push(
                    Diagnostic::new(
                        diag::E_PARAM_CHOICE,
                        format!("{path}/value"),
                        format!("`{name}` is not one of its choices"),
                    )
                    .with_hint("pick a value listed in `choices`"),
                );
            }
        }
        if let Some(v) = v {
            let kind = if v.any_dim {
                Some(DimKind::Dimensionless)
            } else {
                v.kind()
            };
            match kind {
                Some(dim) => {
                    out.insert(
                        name.clone(),
                        EvalParam {
                            value: v.value,
                            dim,
                        },
                    );
                }
                None => diags.push(Diagnostic::new(
                    diag::E_EXPR_DIM,
                    format!("{path}/value"),
                    format!("`{name}` has the unnamed dimension {}", dim_label(v.dim)),
                )),
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(model: Value) -> (BTreeMap<String, EvalParam>, Vec<Diagnostic>) {
        let mut d = Vec::new();
        let mut s = Scope::new(&model);
        let p = eval_params(&model, &mut s, &mut d);
        (p, d)
    }

    #[test]
    fn expr_params_resolve_with_dimensions() {
        let (p, d) = run(json!({"params": {
            "d": {"value": "54 mm", "min": "20 mm", "max": "100 mm", "step": "1 mm"},
            "len": {"value": "= params.d * 10"},
            "n": {"value": 4, "choices": [3, 4, 6]},
            "shape": {"value": "ogive", "choices": ["ogive", "conical"]},
            "flag": {"value": true},
        }}));
        assert!(d.is_empty(), "{d:?}");
        assert_eq!(
            p["d"],
            EvalParam {
                value: 0.054,
                dim: DimKind::Length
            }
        );
        assert!((p["len"].value - 0.54).abs() < 1e-12);
        assert_eq!(p["n"].dim, DimKind::Dimensionless);
        assert!(!p.contains_key("shape") && !p.contains_key("flag"));
    }

    #[test]
    fn range_choice_and_dimension_errors() {
        let (_, d) = run(json!({"params": {
            "a": {"value": "10 mm", "min": "20 mm"},
            "b": {"value": "200 mm", "max": "100 mm"},
            "c": {"value": 5, "choices": [3, 4]},
            "e": {"value": "conical", "choices": ["ogive"]},
            "f": {"value": "5 mm", "min": "1 kg"},
            "g": {"value": "= params.g"},
        }}));
        let codes: Vec<(&str, &str)> = d
            .iter()
            .map(|x| (x.code.as_str(), x.path.as_deref().unwrap()))
            .collect();
        assert_eq!(
            codes,
            vec![
                ("RW-E011", "/params/a/value"),
                ("RW-E011", "/params/b/value"),
                ("RW-E012", "/params/c/value"),
                ("RW-E012", "/params/e/value"),
                ("RW-E013", "/params/f/min"),
                ("RW-E042", "/params/g/value"),
            ]
        );
    }

    #[test]
    fn variants_and_set_override_values() {
        let mut v = json!({
            "params": {"span": {"value": "90 mm"}, "n": {"value": 3}},
            "variants": {"long": {"span": "110 mm", "zz": 1}},
            "c": {"fins": {"type": "trapezoidal_fin_set", "count": 3}},
        });
        let mut d = Vec::new();
        let set = BTreeMap::from([
            ("params.n".to_string(), "4".to_string()),
            ("c.fins.cant".to_string(), "2 deg".to_string()),
            ("params.nope".to_string(), "1".to_string()),
        ]);
        apply_overrides(&mut v, Some("long"), &set, &mut d);
        assert_eq!(v["params"]["span"]["value"], json!("110 mm"));
        assert_eq!(v["params"]["n"]["value"], json!(4.0));
        assert_eq!(v["c"]["fins"]["cant"], json!("2 deg"));
        let codes: Vec<&str> = d.iter().map(|x| x.code.as_str()).collect();
        assert_eq!(codes, vec!["RW-E010", "RW-E010"]);
        let mut d = Vec::new();
        apply_overrides(&mut v, Some("short"), &BTreeMap::new(), &mut d);
        assert_eq!(d[0].code, "RW-E014");
    }

    #[test]
    fn set_paths() {
        assert_eq!(set_pointer("params.d"), "/params/d/value");
        // The `rw set` spelling of the same param (B3 round 10).
        assert_eq!(set_pointer("params.d.value"), "/params/d/value");
        assert_eq!(set_pointer("params.d.max"), "/params/d/max");
        assert_eq!(set_pointer("c.fins.span"), "/c/fins/span");
        assert_eq!(set_pointer("/c/fins/span"), "/c/fins/span");
        assert_eq!(parse_set_value("110 mm"), json!("110 mm"));
        assert_eq!(parse_set_value("true"), json!(true));
    }
}
