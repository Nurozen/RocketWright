//! Shared helpers for the rw-sim replay tests: the case-1 oracle golden and
//! series (`tests/oracle/`), embedded with `include_str!` so the tests touch
//! no filesystem API (I5).
#![allow(dead_code)]

pub mod case1;

use serde_json::Value;

/// `case1-generic.json` (summary, events, static, conditions).
///
/// cite: n/a test fixture loader
pub fn golden() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/oracle/case1-generic.json"
    )))
    .expect("golden json")
}

/// The golden's launch conditions as our `Conditions`.
///
/// cite: n/a test fixture loader
pub fn conditions() -> rw_model::Conditions {
    serde_json::from_value(golden()["conditions"].clone()).expect("conditions")
}

/// A golden summary value by oracle key.
///
/// cite: n/a test fixture loader
pub fn summary(key: &str) -> f64 {
    golden()["summary"][key].as_f64().expect(key)
}

/// Time of the first golden event of `kind` (oracle event names).
///
/// cite: n/a test fixture loader
pub fn event(kind: &str) -> Value {
    golden()["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == kind)
        .cloned()
        .unwrap_or_else(|| panic!("no golden event {kind}"))
}

/// The oracle series, column-addressed.
pub struct Series {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<f64>>,
}

impl Series {
    /// `case1-generic.series.json`.
    ///
    /// cite: n/a test fixture loader
    pub fn case1() -> Self {
        let v: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/oracle/case1-generic.series.json"
        )))
        .expect("series json");
        let columns = v["columns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c.as_str().unwrap().to_string())
            .collect();
        let rows = v["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                r.as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_f64().unwrap_or(f64::NAN))
                    .collect()
            })
            .collect();
        Self { columns, rows }
    }

    /// One column by name.
    ///
    /// cite: n/a test fixture accessor
    pub fn col(&self, name: &str) -> Vec<f64> {
        let i = self
            .columns
            .iter()
            .position(|c| c == name)
            .unwrap_or_else(|| panic!("no series column {name}"));
        self.rows.iter().map(|r| r[i]).collect()
    }
}

/// Linear interpolation of `ys(xs)` at `x`, clamped at the ends.
///
/// cite: n/a linear interpolation of samples
pub fn lerp(xs: &[f64], ys: &[f64], x: f64) -> f64 {
    rw_sim::doubles::interp(xs, ys, x)
}

/// Percent difference `100 (ours / oracle − 1)`.
///
/// cite: n/a report arithmetic
pub fn pct(ours: f64, oracle: f64) -> f64 {
    100.0 * (ours / oracle - 1.0)
}
