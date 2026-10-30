//! `history_compare` bodies (R2.10, M2.7): the semantic model diff keyed by
//! component id (source fields, with SI values and units for quantity
//! literals), the visual-diff marks on the evaluated models (removed red,
//! changed amber, added green), and the metric diff with units.
//!
//! Everything here is a pure function of two models, reports, or run
//! summaries; `Session::history_compare` resolves the versions.

use std::collections::{BTreeMap, BTreeSet};

use rw_api::{ComponentMark, FieldChange, MarkStatus, MetricDiffRow, ModelDiff, QuantityChange};
use rw_check::CheckReport;
use rw_model::EvaluatedModel;
use rw_sim::RunSummary;
use rw_units::{DimKind, parse_parts};
use serde_json::{Map, Value};

use crate::check::DELTA_METRICS;

/// Relative tolerance under which two evaluated numbers are equal (the
/// evaluator is deterministic; this only absorbs re-association noise).
const REL_EQ: f64 = 1e-9;
/// Absolute floor of the equality tolerance (SI).
const ABS_EQ: f64 = 1e-12;

/// Evaluated-component keys that move with parts fore of the component
/// (stations, anchor stations) or list other components (children). A
/// component whose only differences are these did not change itself.
const PLACEMENT_KEYS: &[&str] = &["x_fore", "x_aft", "anchors", "children"];

/// Run-summary keys compared between two runs, with their units.
pub const SUMMARY_METRICS: &[(&str, Option<&str>)] = &[
    ("apogee_m", Some("m")),
    ("max_velocity_ms", Some("m/s")),
    ("max_accel_ms2", Some("m/s^2")),
    ("max_mach", None),
    ("time_to_apogee_s", Some("s")),
    ("flight_time_s", Some("s")),
    ("rail_exit_velocity_ms", Some("m/s")),
    ("deployment_velocity_ms", Some("m/s")),
    ("landing_velocity_ms", Some("m/s")),
    ("min_stability_cal", Some("cal")),
    ("burnout_time_s", Some("s")),
    ("burnout_altitude_m", Some("m")),
    ("optimum_delay_s", Some("s")),
    ("drift_m", Some("m")),
];

/// Unit of a check-report metric path (`docs/dev/metric-paths.md`), or of a
/// bare run-summary key; `None` for pure numbers and unknown keys.
pub fn metric_unit(key: &str) -> Option<&'static str> {
    if let Some((_, u)) = SUMMARY_METRICS.iter().find(|(k, _)| *k == key) {
        return *u;
    }
    // Per-component rows (`mass.components.<id>.cg`, `aero.terms.<id>.cna`)
    // take the unit of their last segment.
    if key.starts_with("mass.components.") || key.starts_with("aero.terms.") {
        return match key.rsplit('.').next() {
            Some("mass") => Some("kg"),
            Some("cg" | "cp") => Some("m"),
            _ => None,
        };
    }
    match key {
        "aero.cna" | "aero.cd" | "aero.mach" => None,
        "aero.alpha" => Some("rad"),
        "mass.ixx" | "mass.iyy" => Some("kg*m^2"),
        "stability.liftoff_pct_length" => Some("%"),
        "stability.ref_diameter" => Some("m"),
        k if k.starts_with("stability.") => Some("cal"),
        k if k.starts_with("dims.") || k == "mass.cg" || k == "mass.cg_burnout" => Some("m"),
        k if k.starts_with("aero.") => Some("m"),
        k if k.starts_with("mass.") => Some("kg"),
        _ => None,
    }
}

fn row(key: &str, a: Option<f64>, b: Option<f64>, unit: Option<&str>) -> MetricDiffRow {
    let delta = a.zip(b).map(|(x, y)| y - x);
    let delta_pct = a
        .zip(delta)
        .and_then(|(x, d)| if x != 0.0 { Some(100.0 * d / x) } else { None });
    MetricDiffRow {
        key: key.to_string(),
        a,
        b,
        delta,
        delta_pct,
        tol: None,
        pass: None,
        unit: unit.map(String::from),
    }
}

/// The value at a dotted path of a JSON value.
fn at_path(v: &Value, path: &str) -> Option<f64> {
    let mut cur = v;
    for s in path.split('.') {
        cur = cur.get(s)?;
    }
    cur.as_f64()
}

/// Check-report metric rows (`DELTA_METRICS`, in that order), skipping
/// metrics neither report has.
pub fn report_rows(a: &CheckReport, b: &CheckReport) -> Vec<MetricDiffRow> {
    let va = serde_json::to_value(a).unwrap_or(Value::Null);
    let vb = serde_json::to_value(b).unwrap_or(Value::Null);
    DELTA_METRICS
        .iter()
        .filter_map(|key| {
            let (x, y) = (at_path(&va, key), at_path(&vb, key));
            (x.is_some() || y.is_some()).then(|| row(key, x, y, metric_unit(key)))
        })
        .collect()
}

/// Per-component rows of two reports: for each component, its dry mass and
/// CG (`mass.components.<id>.mass`, `.cg`) and its aero term's CNa and CP
/// (`aero.terms.<id>.cna`, `.cp`). Components come in `b`'s order (mass
/// rows, then aero terms), followed by those only `a` has; a side without
/// the component has no value, so the delta is absent.
pub fn breakdown_rows(a: &CheckReport, b: &CheckReport) -> Vec<MetricDiffRow> {
    let mass = |r: &CheckReport| -> Vec<(String, [f64; 2])> {
        r.mass
            .components
            .iter()
            .map(|c| (c.component.clone(), [c.mass, c.cg]))
            .collect()
    };
    let aero = |r: &CheckReport| -> Vec<(String, [f64; 2])> {
        r.aero
            .terms
            .iter()
            .map(|t| (t.component.clone(), [t.cna, t.cp]))
            .collect()
    };
    let mut rows = per_component("mass.components", ["mass", "cg"], &mass(a), &mass(b));
    rows.extend(per_component(
        "aero.terms",
        ["cna", "cp"],
        &aero(a),
        &aero(b),
    ));
    rows
}

/// Rows `<prefix>.<id>.<field>` for every component of `b`, then those only
/// `a` has.
fn per_component(
    prefix: &str,
    fields: [&str; 2],
    a: &[(String, [f64; 2])],
    b: &[(String, [f64; 2])],
) -> Vec<MetricDiffRow> {
    let find =
        |side: &[(String, [f64; 2])], id: &str| side.iter().find(|(c, _)| c == id).map(|(_, v)| *v);
    let ids = b.iter().map(|(id, _)| id).chain(
        a.iter()
            .map(|(id, _)| id)
            .filter(|id| find(b, id).is_none()),
    );
    let mut rows = Vec::new();
    for id in ids {
        let (x, y) = (find(a, id), find(b, id));
        for (i, field) in fields.iter().enumerate() {
            let key = format!("{prefix}.{id}.{field}");
            rows.push(row(
                &key,
                x.map(|v| v[i]),
                y.map(|v| v[i]),
                metric_unit(&key),
            ));
        }
    }
    rows
}

/// Run-summary rows ([`SUMMARY_METRICS`], in that order).
pub fn summary_rows(a: &RunSummary, b: &RunSummary) -> Vec<MetricDiffRow> {
    let va = serde_json::to_value(a).unwrap_or(Value::Null);
    let vb = serde_json::to_value(b).unwrap_or(Value::Null);
    SUMMARY_METRICS
        .iter()
        .filter_map(|(key, unit)| {
            let (x, y) = (at_path(&va, key), at_path(&vb, key));
            (x.is_some() || y.is_some()).then(|| row(key, x, y, *unit))
        })
        .collect()
}

// ---- source model diff -------------------------------------------------------------

/// Semantic diff keyed by component id (`/c/<id>`); other tables report as
/// field changes under their table name. Quantity literals (`"70 mm"`)
/// carry their SI values and unit.
pub fn model_diff(a_name: &str, a: &Value, b_name: &str, b: &Value) -> ModelDiff {
    let empty = Map::new();
    let obj = |v: &'_ Value, k: &str| -> Map<String, Value> {
        v.get(k)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    };
    let (ac, bc) = (obj(a, "c"), obj(b, "c"));
    let added: Vec<String> = bc
        .keys()
        .filter(|k| !ac.contains_key(*k))
        .cloned()
        .collect();
    let removed: Vec<String> = ac
        .keys()
        .filter(|k| !bc.contains_key(*k))
        .cloned()
        .collect();
    let mut changed = Vec::new();
    for (id, av) in &ac {
        if let Some(bv) = bc.get(id) {
            leaf_diff(id, &format!("/c/{id}"), av, bv, &mut changed);
        }
    }
    let am = a.as_object().unwrap_or(&empty);
    let bm = b.as_object().unwrap_or(&empty);
    let keys: BTreeSet<&String> = am.keys().chain(bm.keys()).filter(|k| *k != "c").collect();
    for k in keys {
        let null = Value::Null;
        let (x, y) = (am.get(k).unwrap_or(&null), bm.get(k).unwrap_or(&null));
        leaf_diff(k, &format!("/{k}"), x, y, &mut changed);
    }
    ModelDiff {
        a: a_name.to_string(),
        b: b_name.to_string(),
        added,
        removed,
        changed,
    }
}

fn escape(k: &str) -> String {
    k.replace('~', "~0").replace('/', "~1")
}

/// A quantity literal (`"70 mm"`, not an expression or a bare number) in SI.
fn quantity_of(v: &Value) -> Option<(f64, DimKind)> {
    let s = v.as_str()?.trim();
    if s.starts_with('=') {
        return None;
    }
    let p = parse_parts(s).ok()?;
    p.unit?;
    let q = p.to_quantity();
    Some((q.value, DimKind::from_dimension(q.dim)?))
}

fn field_change(component: &str, path: &str, a: &Value, b: &Value) -> FieldChange {
    let (qa, qb) = (quantity_of(a), quantity_of(b));
    let kinds: BTreeSet<&str> = [qa, qb].iter().flatten().map(|(_, k)| k.name()).collect();
    let kind = qa.or(qb).map(|(_, k)| k);
    let unit = match kind {
        Some(k) if kinds.len() == 1 && k != DimKind::Dimensionless => Some(k.si_unit().to_string()),
        _ => None,
    };
    let si = |q: Option<(f64, DimKind)>| unit.as_ref().and(q.map(|(v, _)| v));
    FieldChange {
        component: component.to_string(),
        path: path.to_string(),
        old: (!a.is_null()).then(|| a.clone()),
        new: (!b.is_null()).then(|| b.clone()),
        old_si: si(qa),
        new_si: si(qb),
        unit,
    }
}

fn leaf_diff(component: &str, path: &str, a: &Value, b: &Value, out: &mut Vec<FieldChange>) {
    if a == b {
        return;
    }
    if let (Value::Object(x), Value::Object(y)) = (a, b) {
        let keys: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
        let null = Value::Null;
        for k in keys {
            leaf_diff(
                component,
                &format!("{path}/{}", escape(k)),
                x.get(k).unwrap_or(&null),
                y.get(k).unwrap_or(&null),
                out,
            );
        }
        return;
    }
    out.push(field_change(component, path, a, b));
}

// ---- evaluated marks ---------------------------------------------------------------

fn num_eq(x: f64, y: f64) -> bool {
    x == y || (x - y).abs() <= ABS_EQ.max(REL_EQ * x.abs().max(y.abs()))
}

/// Unit of an evaluated field from the last named segment of its pointer.
fn unit_at(path: &str) -> Option<String> {
    let name = path
        .rsplit('/')
        .find(|s| !s.is_empty() && s.parse::<usize>().is_err())?;
    let k = rw_check::field_dim(name)?;
    (k != DimKind::Dimensionless).then(|| k.si_unit().to_string())
}

fn eval_diff(path: &str, a: &Value, b: &Value, out: &mut Vec<QuantityChange>) {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (
                x.as_f64().unwrap_or(f64::NAN),
                y.as_f64().unwrap_or(f64::NAN),
            );
            if !num_eq(x, y) {
                out.push(QuantityChange {
                    path: path.to_string(),
                    old: Some(x),
                    new: Some(y),
                    unit: unit_at(path),
                });
            }
        }
        (Value::Object(x), Value::Object(y)) => {
            let keys: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
            let null = Value::Null;
            for k in keys {
                eval_diff(
                    &format!("{path}/{}", escape(k)),
                    x.get(k).unwrap_or(&null),
                    y.get(k).unwrap_or(&null),
                    out,
                );
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                eval_diff(&format!("{path}/{i}"), p, q, out);
            }
        }
        _ if a == b => {}
        _ => out.push(QuantityChange {
            path: path.to_string(),
            old: a.as_f64(),
            new: b.as_f64(),
            unit: unit_at(path),
        }),
    }
}

/// The evaluated quantities of one component that differ, ignoring where
/// parts fore of it put it (stations shift when a nose grows); its own
/// length is compared.
fn component_changes(
    a: &rw_model::EvalComponent,
    b: &rw_model::EvalComponent,
) -> Vec<QuantityChange> {
    let mut out = Vec::new();
    let (la, lb) = (a.x_aft - a.x_fore, b.x_aft - b.x_fore);
    if !num_eq(la, lb) {
        out.push(QuantityChange {
            path: "/length".into(),
            old: Some(la),
            new: Some(lb),
            unit: Some(DimKind::Length.si_unit().into()),
        });
    }
    let strip = |c: &rw_model::EvalComponent| -> Value {
        let mut v = serde_json::to_value(c).unwrap_or(Value::Null);
        if let Some(o) = v.as_object_mut() {
            for k in PLACEMENT_KEYS {
                o.remove(*k);
            }
        }
        v
    };
    eval_diff("", &strip(a), &strip(b), &mut out);
    out
}

/// Marks of `b` against `a`: `b`'s components in model order (added or
/// changed), then the components only `a` has (removed), in `a`'s order.
/// Unchanged components get no mark.
pub fn component_marks(a: &EvaluatedModel, b: &EvaluatedModel) -> Vec<ComponentMark> {
    let old: BTreeMap<&str, &rw_model::EvalComponent> =
        a.components.iter().map(|c| (c.id.as_str(), c)).collect();
    let new: BTreeSet<&str> = b.components.iter().map(|c| c.id.as_str()).collect();
    let mut out = Vec::new();
    for c in &b.components {
        match old.get(c.id.as_str()) {
            None => out.push(ComponentMark {
                id: c.id.clone(),
                name: c.name.clone(),
                status: MarkStatus::Added,
                fields: Vec::new(),
            }),
            Some(o) => {
                let fields = component_changes(o, c);
                if !fields.is_empty() {
                    out.push(ComponentMark {
                        id: c.id.clone(),
                        name: c.name.clone(),
                        status: MarkStatus::Changed,
                        fields,
                    });
                }
            }
        }
    }
    for c in &a.components {
        if !new.contains(c.id.as_str()) {
            out.push(ComponentMark {
                id: c.id.clone(),
                name: c.name.clone(),
                status: MarkStatus::Removed,
                fields: Vec::new(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests;
