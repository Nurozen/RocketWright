//! `run_series` (B3, D7): a stored run's samples for the MCP Apps run card.
//!
//! Run results carry scalar summaries only, so the card's chart reads the
//! run's `series.csv` (the same file the app server's
//! `GET /api/projects/:id/runs/:sim/:runId/series.csv` route serves):
//! `runs/<sim>/<run_id>/series.csv` for flight sims (`t`, `altitude`, ...)
//! and `runs/engine.<id>/<run_id>/series.csv` for engine runs (`t_s`,
//! `thrust_n`, `chamber_pressure_pa`, ...).
//!
//! The tool is app-only (`_meta.ui.visibility: ["app"]`): hosts hide it from
//! the model and let cards call it. It is not an `rw_api` command, so it has
//! no CLI subcommand and no published schema file.
//!
//! Downsampling keeps the first and last rows and every requested column's
//! minimum and maximum row, then fills the rest of `max_points` with evenly
//! spaced rows, so a chart's peak is the stored peak.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

use rmcp::model::{JsonObject, Tool, ToolAnnotations};
use rw_api::{ApiError, ApiErrorCode};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::meta;

/// The tool name.
pub const NAME: &str = "run_series";
/// The largest `max_points`.
pub const MAX_POINTS: usize = 400;
/// The smallest `max_points` (room for every kept extreme).
pub const MIN_POINTS: usize = 20;
/// The most `fields` one call may ask for.
pub const MAX_FIELDS: usize = 8;

fn err(code: ApiErrorCode, message: impl Into<String>, hint: Option<&str>) -> ApiError {
    ApiError {
        outcome: None,
        code,
        message: message.into(),
        hint: hint.map(str::to_owned),
        diagnostics: Vec::new(),
    }
}

fn object(v: Value) -> Arc<JsonObject> {
    Arc::new(v.as_object().cloned().unwrap_or_default())
}

/// The input JSON Schema.
pub fn input_schema() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "RunSeriesIn",
        "type": "object",
        "properties": {
            "sim": {
                "type": "string",
                "description": "The run's sim: a flight sim id, or `engine.<id>` for an engine run."
            },
            "run_id": { "type": "string", "description": "The run id (`simulate` / `engine_simulate` `run_id`)." },
            "fields": {
                "type": "array",
                "items": { "type": "string" },
                "minItems": 1,
                "maxItems": MAX_FIELDS,
                "description": "Series columns to return, e.g. [\"t\", \"altitude\"] or [\"t_s\", \"thrust_n\"]."
            },
            "max_points": {
                "type": "integer",
                "minimum": MIN_POINTS,
                "maximum": MAX_POINTS,
                "default": MAX_POINTS,
                "description": "Most rows returned; extremes of every field are kept."
            }
        },
        "required": ["sim", "run_id", "fields"],
        "additionalProperties": false
    })
}

/// The output JSON Schema.
pub fn output_schema() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "RunSeriesOut",
        "type": "object",
        "properties": {
            "sim": { "type": "string" },
            "run_id": { "type": "string" },
            "fields": { "type": "array", "items": { "type": "string" } },
            "columns": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Every column of the stored series."
            },
            "samples": { "type": "integer", "minimum": 0, "description": "Rows in the stored series." },
            "points": { "type": "integer", "minimum": 0, "description": "Rows returned." },
            "values": {
                "type": "object",
                "additionalProperties": {
                    "type": "array",
                    "items": { "type": ["number", "null"] }
                },
                "description": "Field → its values at the returned rows (SI; null for an empty cell)."
            }
        },
        "required": ["sim", "run_id", "fields", "columns", "samples", "points", "values"]
    })
}

/// The tool definition (app-only).
pub fn tool() -> Tool {
    let annotations = ToolAnnotations::new()
        .read_only(true)
        .destructive(false)
        .idempotent(true)
        .open_world(false);
    let m = json!({
        meta::APPROVAL: "never",
        meta::MUTATING: false,
        "ui": { "visibility": ["app"] },
    });
    Tool::new(
        NAME,
        "Samples of a stored run's series (for MCP Apps cards; hidden from the model). \
         Flight sims: `t`, `altitude`, ...; engine runs (`engine.<id>`): `t_s`, `thrust_n`, \
         `chamber_pressure_pa`, ....",
        object(input_schema()),
    )
    .with_raw_output_schema(object(output_schema()))
    .with_annotations(annotations)
    .with_meta(rmcp::model::MetaObject(
        m.as_object().cloned().unwrap_or_default(),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunSeriesIn {
    sim: String,
    run_id: String,
    fields: Vec<String>,
    #[serde(default)]
    max_points: Option<usize>,
}

/// A path segment the run store could have written (no separators, no dots-only).
fn safe_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A parsed `series.csv`: header names and row-major cells.
struct Csv {
    columns: Vec<String>,
    rows: Vec<Vec<Option<f64>>>,
}

fn parse_csv(text: &str) -> Csv {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let columns = lines
        .next()
        .map(|h| h.split(',').map(|c| c.trim().to_string()).collect())
        .unwrap_or_default();
    let rows = lines
        .map(|l| {
            l.split(',')
                .map(|c| c.trim().parse::<f64>().ok().filter(|v| v.is_finite()))
                .collect()
        })
        .collect();
    Csv { columns, rows }
}

/// Row indices to keep: first, last, each column's min and max, then evenly
/// spaced rows up to `max` in all.
pub fn downsample(n: usize, columns: &[Vec<Option<f64>>], max: usize) -> Vec<usize> {
    if n <= max {
        return (0..n).collect();
    }
    let mut keep: BTreeSet<usize> = [0, n - 1].into_iter().collect();
    for col in columns {
        let mut lo: Option<(usize, f64)> = None;
        let mut hi: Option<(usize, f64)> = None;
        for (i, v) in col.iter().enumerate() {
            let Some(v) = *v else { continue };
            if lo.is_none_or(|(_, x)| v < x) {
                lo = Some((i, v));
            }
            if hi.is_none_or(|(_, x)| v > x) {
                hi = Some((i, v));
            }
        }
        keep.extend(lo.map(|(i, _)| i));
        keep.extend(hi.map(|(i, _)| i));
    }
    let budget = max.saturating_sub(keep.len());
    if budget >= 2 {
        for k in 0..budget {
            keep.insert(((k * (n - 1)) as f64 / (budget - 1) as f64).round() as usize);
        }
    }
    let mut out: Vec<usize> = keep.into_iter().collect();
    out.truncate(max);
    out
}

/// Runs `run_series` against the project at `root`.
pub fn call(root: &Path, args: Value) -> Result<Value, ApiError> {
    let i: RunSeriesIn = serde_json::from_value(args).map_err(|e| {
        err(
            ApiErrorCode::InvalidInput,
            format!("`run_series` input: {e}"),
            Some("{\"sim\": \"default\", \"run_id\": \"<id>\", \"fields\": [\"t\", \"altitude\"]}"),
        )
    })?;
    for (what, v) in [("sim", &i.sim), ("run_id", &i.run_id)] {
        if !safe_segment(v) {
            return Err(err(
                ApiErrorCode::InvalidInput,
                format!("`{what}` `{v}` is not a run path segment"),
                None,
            ));
        }
    }
    if i.fields.is_empty() || i.fields.len() > MAX_FIELDS {
        return Err(err(
            ApiErrorCode::InvalidInput,
            format!("`fields` takes 1 to {MAX_FIELDS} column names"),
            None,
        ));
    }
    let max = i.max_points.unwrap_or(MAX_POINTS);
    if !(MIN_POINTS..=MAX_POINTS).contains(&max) {
        return Err(err(
            ApiErrorCode::InvalidInput,
            format!("`max_points` must be {MIN_POINTS} to {MAX_POINTS}"),
            None,
        ));
    }
    let path = root
        .join(rw_project::runs::RUNS_DIR)
        .join(&i.sim)
        .join(&i.run_id)
        .join(rw_project::runs::SERIES_FILE);
    let text = std::fs::read_to_string(&path).map_err(|_| {
        err(
            ApiErrorCode::NotFound,
            format!("run `{}/{}` has no stored series", i.sim, i.run_id),
            Some("run_list lists the project's runs"),
        )
    })?;
    let csv = parse_csv(&text);
    let mut idx = Vec::with_capacity(i.fields.len());
    for f in &i.fields {
        match csv.columns.iter().position(|c| c == f) {
            Some(k) => idx.push(k),
            None => {
                return Err(err(
                    ApiErrorCode::InvalidInput,
                    format!(
                        "run `{}/{}` has no column `{f}`; its columns are: {}",
                        i.sim,
                        i.run_id,
                        csv.columns.join(", ")
                    ),
                    None,
                ));
            }
        }
    }
    let cols: Vec<Vec<Option<f64>>> = idx
        .iter()
        .map(|&k| {
            csv.rows
                .iter()
                .map(|r| r.get(k).copied().flatten())
                .collect()
        })
        .collect();
    let rows = downsample(csv.rows.len(), &cols, max);
    let mut values = Map::new();
    for (f, col) in i.fields.iter().zip(&cols) {
        let v: Vec<Value> = rows
            .iter()
            .map(|&r| col[r].map_or(Value::Null, |x| json!(x)))
            .collect();
        values.insert(f.clone(), Value::Array(v));
    }
    Ok(json!({
        "sim": i.sim,
        "run_id": i.run_id,
        "fields": i.fields,
        "columns": csv.columns,
        "samples": csv.rows.len(),
        "points": rows.len(),
        "values": values,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsample_keeps_ends_and_extremes() {
        let n = 1000;
        let col: Vec<Option<f64>> = (0..n)
            .map(|i| Some(-((i as f64 - 613.0).powi(2))))
            .collect();
        let rows = downsample(n, std::slice::from_ref(&col), 50);
        assert!(rows.len() <= 50);
        assert_eq!(rows.first(), Some(&0));
        assert_eq!(rows.last(), Some(&(n - 1)));
        assert!(rows.contains(&613));
        assert!(rows.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(downsample(10, &[], 50), (0..10).collect::<Vec<_>>());
    }

    #[test]
    fn segments_and_csv() {
        assert!(safe_segment("engine.demo"));
        assert!(!safe_segment(".."));
        assert!(!safe_segment("a/b"));
        let c = parse_csv("t,altitude\n0,0\n1,\n2,5\n");
        assert_eq!(c.columns, ["t", "altitude"]);
        assert_eq!(c.rows[1], [Some(1.0), None]);
    }
}
