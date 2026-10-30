//! Units and dimensions: dimension exponent vectors, the unit table, and the quantity parser/formatter (hand-rolled, not uom).
//!
//! M1.5 froze the *types*: [`Dimension`] (exponent vector), [`DimKind`]
//! (the named dimensions used by `x-unit-dimension`), the source-form
//! [`Qty`] (`"54 mm"`, `"= params.d"`, or `0`), and the SI [`Quantity`].
//! M1.20 adds the unit table ([`table`]), the parser ([`parse`]: `54 mm`,
//! `54mm`, `1/4 in`, `kg/m^3`, `N*s`; bare numbers rejected on dimensional
//! fields except `0`), and the formatter ([`fmt`], `parse(format(x)) == x`).
//! Shared vectors: `tests/vectors/units.json`.
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Enforced by the root `clippy.toml`.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod dim;
pub mod fmt;
pub mod parse;
pub mod qty;
pub mod table;

pub use dim::{DimKind, Dimension, UnitDim, markers};
pub use fmt::{format_in, format_number, format_si, format_sig, format_sig_number};
pub use parse::{
    Parsed, number_for, parse_for, parse_parts, parse_quantity, parse_unit, raw_for, unit_dimension,
};
pub use qty::*;
pub use table::{UNITS, Unit, UnitDef, lookup, units_for};

/// JSON Schema extension keyword naming a field's physical dimension (R2.11).
pub const X_UNIT_DIMENSION: &str = "x-unit-dimension";
/// JSON Schema extension keyword: the field accepts `=` expressions (R2.3).
pub const X_EXPR: &str = "x-expr";
/// JSON Schema extension keyword: the named anchors of a component type (R2.4).
pub const X_ANCHORS: &str = "x-anchors";
/// JSON Schema extension keyword: the inspector/editor group of a field.
pub const X_UI_GROUP: &str = "x-ui-group";
