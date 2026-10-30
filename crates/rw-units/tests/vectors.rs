//! The shared vectors in `tests/vectors/units.json` (the TS side reads the same file).

use rw_units::{DimKind, Quantity, UnitError, format_in, parse_for};
use serde_json::Value;

const VECTORS: &str = include_str!("../../../tests/vectors/units.json");

fn kind(v: &Value) -> DimKind {
    let name = v["dim"].as_str().expect("dim");
    DimKind::from_name(name).unwrap_or_else(|| panic!("unknown dim {name}"))
}

fn error_kind(e: &UnitError) -> &'static str {
    match e {
        UnitError::UnitMissing { .. } => "unit_missing",
        UnitError::UnknownUnit { .. } => "unknown_unit",
        UnitError::DimensionMismatch { .. } => "dimension_mismatch",
        UnitError::Syntax { .. } => "syntax",
    }
}

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("units.json parses")
}

#[test]
fn accept() {
    let v = vectors();
    let rows = v["accept"].as_array().unwrap();
    assert!(rows.len() >= 50);
    for row in rows {
        let text = row["text"].as_str().unwrap();
        let want = row["si"].as_f64().unwrap();
        let got = parse_for(text, kind(row)).unwrap_or_else(|e| panic!("{text:?}: {e}"));
        let tol = 1e-12 * want.abs().max(1e-300);
        assert!(
            (got.value - want).abs() <= tol,
            "{text:?}: {} != {want}",
            got.value
        );
        assert_eq!(got.dim, kind(row).dimension(), "{text:?}");
    }
}

#[test]
fn reject() {
    let v = vectors();
    for row in v["reject"].as_array().unwrap() {
        let text = row["text"].as_str().unwrap();
        let want = row["error"].as_str().unwrap();
        match parse_for(text, kind(row)) {
            Ok(q) => panic!("{text:?} parsed to {q:?}"),
            Err(e) => assert_eq!(error_kind(&e), want, "{text:?}: {e}"),
        }
        // The serde tag is the same spelling the vectors use.
        let e = parse_for(text, kind(row)).unwrap_err();
        assert_eq!(serde_json::to_value(&e).unwrap()["kind"], want);
    }
}

#[test]
fn format() {
    let v = vectors();
    for row in v["format"].as_array().unwrap() {
        let q = Quantity {
            value: row["si"].as_f64().unwrap(),
            dim: kind(row).dimension(),
        };
        let unit = row["unit"].as_str().unwrap();
        assert_eq!(format_in(q, unit).unwrap(), row["text"].as_str().unwrap());
    }
}
