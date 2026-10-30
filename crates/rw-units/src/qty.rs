//! Quantity types: the source form ([`Qty`]) and the SI value ([`Quantity`]).

use std::borrow::Cow;
use std::fmt;
use std::marker::PhantomData;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::dim::{DimKind, Dimension, UnitDim, markers};

/// Pattern for a dimensional source string: an `=` expression, or a number
/// followed by a unit (`54 mm`, `54mm`, `1/4 in`, `-5 deg`). A bare number
/// string (`"54"`) does not match. The authoritative parser is M1.20's; this
/// pattern only lets editors and agents catch the common mistake on save.
pub const QTY_PATTERN: &str = r"^\s*(=.+|[-+]?[0-9.][0-9.eE+/ -]*\s*[^\s0-9.].*)$";

/// Pattern for an expression string (`= params.d * 2`).
pub const EXPR_PATTERN: &str = r"^\s*=.+$";

/// The raw source token of a quantity: a string (`"54 mm"`, `"= params.d"`)
/// or a bare number. Bare numbers are schema errors on dimensional fields
/// except `0` (R2.2); the parser reports them as `RW-E021 unit-missing`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum QtyRaw {
    Text(String),
    Number(f64),
}

/// A dimensional input field as written in a source file (IF1).
///
/// Serializes as the raw token. Its JSON Schema is inlined at every use and
/// carries `x-unit-dimension` (from `D`) and `x-expr: true`.
pub struct Qty<D: UnitDim> {
    pub raw: QtyRaw,
    _dim: PhantomData<D>,
}

impl<D: UnitDim> Qty<D> {
    /// A quantity from its source text (`"54 mm"` or `"= params.d"`).
    pub fn text(s: impl Into<String>) -> Self {
        Self {
            raw: QtyRaw::Text(s.into()),
            _dim: PhantomData,
        }
    }
    /// A bare number (valid only for `0` or dimensionless fields).
    pub fn number(v: f64) -> Self {
        Self {
            raw: QtyRaw::Number(v),
            _dim: PhantomData,
        }
    }
    /// The dimension this field must have.
    pub fn kind(&self) -> DimKind {
        D::KIND
    }
    /// True when the source is an `=` expression.
    pub fn is_expr(&self) -> bool {
        matches!(&self.raw, QtyRaw::Text(s) if s.trim_start().starts_with('='))
    }
}

impl<D: UnitDim> Clone for Qty<D> {
    fn clone(&self) -> Self {
        Self {
            raw: self.raw.clone(),
            _dim: PhantomData,
        }
    }
}
impl<D: UnitDim> PartialEq for Qty<D> {
    fn eq(&self, other: &Self) -> bool {
        self.raw == other.raw
    }
}
impl<D: UnitDim> fmt::Debug for Qty<D> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Qty<{}>({:?})", D::KIND.name(), self.raw)
    }
}
impl<D: UnitDim> Serialize for Qty<D> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.raw.serialize(s)
    }
}
impl<'de, D: UnitDim> Deserialize<'de> for Qty<D> {
    fn deserialize<De: Deserializer<'de>>(d: De) -> Result<Self, De::Error> {
        QtyRaw::deserialize(d).map(|raw| Self {
            raw,
            _dim: PhantomData,
        })
    }
}

impl<D: UnitDim> JsonSchema for Qty<D> {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        Cow::Owned(format!("Qty_{}", D::KIND.name()))
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        let dim = D::KIND.name();
        if D::KIND == DimKind::Dimensionless {
            json_schema!({
                "anyOf": [
                    { "type": "number" },
                    { "type": "string", "pattern": EXPR_PATTERN }
                ],
                "x-unit-dimension": dim,
                "x-expr": true
            })
        } else {
            json_schema!({
                "anyOf": [
                    { "type": "string", "pattern": QTY_PATTERN },
                    { "const": 0 }
                ],
                "x-unit-dimension": dim,
                "x-expr": true
            })
        }
    }
}

/// Source-form aliases, one per named dimension used by the model.
pub type QLength = Qty<markers::Length>;
pub type QMass = Qty<markers::Mass>;
pub type QTime = Qty<markers::Time>;
pub type QAngle = Qty<markers::Angle>;
pub type QArea = Qty<markers::Area>;
pub type QVolume = Qty<markers::Volume>;
pub type QVelocity = Qty<markers::Velocity>;
pub type QAcceleration = Qty<markers::Acceleration>;
pub type QForce = Qty<markers::Force>;
pub type QPressure = Qty<markers::Pressure>;
pub type QDensity = Qty<markers::Density>;
pub type QAreaDensity = Qty<markers::AreaDensity>;
pub type QLineDensity = Qty<markers::LineDensity>;
pub type QTemperature = Qty<markers::Temperature>;
pub type QMassFlow = Qty<markers::MassFlow>;
pub type QAngularVelocity = Qty<markers::AngularVelocity>;
pub type QInertia = Qty<markers::Inertia>;
pub type QImpulse = Qty<markers::Impulse>;
pub type QNumber = Qty<markers::Dimensionless>;

/// An evaluated value in SI with its dimension (core computes in SI, R2.2).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Quantity {
    pub value: f64,
    pub dim: Dimension,
}

/// A unit or quantity error (parse, unknown unit, dimension mismatch).
/// Reported as diagnostics in the `RW-E000`-`RW-E049` range.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UnitError {
    /// `RW-E021 unit-missing`: a bare number on a dimensional field.
    UnitMissing { expected: DimKind },
    /// An unknown unit symbol.
    UnknownUnit { unit: String },
    /// The unit's dimension differs from the field's.
    DimensionMismatch {
        expected: Dimension,
        found: Dimension,
    },
    /// Malformed quantity text.
    Syntax { text: String, at: u32 },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qty_round_trips_as_raw_token() {
        let q: QLength = serde_json::from_str("\"54 mm\"").unwrap();
        assert_eq!(q, QLength::text("54 mm"));
        assert_eq!(serde_json::to_string(&q).unwrap(), "\"54 mm\"");
        let z: QLength = serde_json::from_str("0").unwrap();
        assert_eq!(z.raw, QtyRaw::Number(0.0));
        assert!(QLength::text(" = params.d").is_expr());
    }

    #[test]
    fn qty_schema_carries_dimension_and_expr() {
        let s = schemars::schema_for!(QLength);
        let v = s.as_value();
        assert_eq!(v["x-unit-dimension"], "length");
        assert_eq!(v["x-expr"], true);
    }
}
