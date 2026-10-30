//! The quantity and unit parser.
//!
//! Grammar (whitespace allowed between tokens, and optional between the number
//! and the unit, so `54mm` and `54 mm` are the same):
//!
//! ```text
//! quantity := number unit?
//! number   := sign? decimal ( '/' decimal | ws decimal '/' decimal )?   -- 1/4, 1 1/4
//! decimal  := digits ('.' digits?)? exp? | '.' digits exp?
//! unit     := factor (('*' | '·' | '/') factor)*                       -- left-assoc
//! factor   := primary ('^' int | '^(' int ')' | '²' | '³')?
//! primary  := symbol | '1' | '(' unit ')'
//! ```
//!
//! A bare number is a pure number; [`parse_for`] rejects it on a dimensional
//! field unless it is `0` (R2.2). Error offsets are byte offsets into the text.

use crate::dim::UnitDim;
use crate::dim::{DimKind, Dimension};
use crate::qty::{Qty, QtyRaw, Quantity, UnitError};
use crate::table::{Unit, lookup};

/// A parsed quantity before dimension checking: the number as written and
/// its unit (`None` for a bare number).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Parsed {
    pub value: f64,
    pub unit: Option<Unit>,
}

impl Parsed {
    /// The SI quantity (a bare number is dimensionless).
    pub fn to_quantity(self) -> Quantity {
        let u = self.unit.unwrap_or(Unit::ONE);
        Quantity {
            value: u.to_si(self.value),
            dim: u.dim,
        }
    }
}

/// Parses `"<number> <unit>"` or a bare number, without a dimension check.
pub fn parse_parts(text: &str) -> Result<Parsed, UnitError> {
    let mut p = Parser::new(text);
    p.ws();
    let value = p.number()?;
    p.ws();
    if p.at_end() {
        return Ok(Parsed { value, unit: None });
    }
    let unit = p.unit_top()?;
    p.ws();
    if !p.at_end() {
        return Err(p.syntax());
    }
    Ok(Parsed {
        value,
        unit: Some(unit),
    })
}

/// Parses a quantity to SI. A bare number yields a dimensionless quantity.
pub fn parse_quantity(text: &str) -> Result<Quantity, UnitError> {
    parse_parts(text).map(Parsed::to_quantity)
}

/// Parses a quantity for a field of dimension `expected` and returns it in SI.
///
/// A bare number is accepted on a dimensionless field, and as `0` on any
/// field; otherwise it is [`UnitError::UnitMissing`] (`RW-E021`). A unit of
/// another dimension is [`UnitError::DimensionMismatch`].
pub fn parse_for(text: &str, expected: DimKind) -> Result<Quantity, UnitError> {
    let parsed = parse_parts(text)?;
    check(parsed, expected)
}

/// Checks a bare JSON/TOML number for a field of dimension `expected`.
pub fn number_for(v: f64, expected: DimKind) -> Result<Quantity, UnitError> {
    if !v.is_finite() {
        return Err(UnitError::Syntax {
            text: v.to_string(),
            at: 0,
        });
    }
    check(
        Parsed {
            value: v,
            unit: None,
        },
        expected,
    )
}

fn check(parsed: Parsed, expected: DimKind) -> Result<Quantity, UnitError> {
    let want = expected.dimension();
    match parsed.unit {
        None if want.is_none() => Ok(Quantity {
            value: parsed.value,
            dim: want,
        }),
        // `0` (or `-0`) is valid on any field and means zero in SI.
        None if parsed.value == 0.0 => Ok(Quantity {
            value: 0.0,
            dim: want,
        }),
        None => Err(UnitError::UnitMissing { expected }),
        Some(u) if u.dim != want => Err(UnitError::DimensionMismatch {
            expected: want,
            found: u.dim,
        }),
        Some(u) => Ok(Quantity {
            value: u.to_si(parsed.value),
            dim: want,
        }),
    }
}

/// Parses a unit expression on its own (`mm`, `kg/m^3`, `J/(kg*K)`).
pub fn parse_unit(text: &str) -> Result<Unit, UnitError> {
    let mut p = Parser::new(text);
    p.ws();
    let u = p.unit_top()?;
    p.ws();
    if !p.at_end() {
        return Err(p.syntax());
    }
    Ok(u)
}

/// Checks a raw source token for a field of dimension `expected`. An `=`
/// expression is not a literal: it returns `Ok(None)` for `rw-model` to
/// evaluate.
pub fn raw_for(raw: &QtyRaw, expected: DimKind) -> Result<Option<Quantity>, UnitError> {
    match raw {
        QtyRaw::Number(v) => number_for(*v, expected).map(Some),
        QtyRaw::Text(s) if s.trim_start().starts_with('=') => Ok(None),
        QtyRaw::Text(s) => parse_for(s, expected).map(Some),
    }
}

impl<D: UnitDim> Qty<D> {
    /// The literal value in SI, or `Ok(None)` for an `=` expression.
    pub fn literal(&self) -> Result<Option<Quantity>, UnitError> {
        raw_for(&self.raw, D::KIND)
    }
}

impl UnitError {
    /// The stable diagnostic code (invariant I9, range E000-E049).
    pub const fn code(&self) -> &'static str {
        match self {
            UnitError::Syntax { .. } => "RW-E020",
            UnitError::UnitMissing { .. } => "RW-E021",
            UnitError::UnknownUnit { .. } => "RW-E022",
            UnitError::DimensionMismatch { .. } => "RW-E023",
        }
    }
}

impl std::fmt::Display for UnitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UnitError::UnitMissing { expected } => write!(
                f,
                "unit-missing: a {} needs a unit, e.g. \"1 {}\"",
                expected.name(),
                expected.si_unit()
            ),
            UnitError::UnknownUnit { unit } => write!(f, "unknown unit `{unit}`"),
            UnitError::DimensionMismatch { expected, found } => {
                write!(f, "expected a unit of {expected}, found {found}")
            }
            UnitError::Syntax { text, at } => {
                write!(f, "cannot parse quantity `{text}` at byte {at}")
            }
        }
    }
}

impl std::error::Error for UnitError {}

// ---- parser ------------------------------------------------------------------

struct Parser<'a> {
    text: &'a str,
    pos: usize,
}

/// Characters that may appear in a unit symbol.
fn is_symbol_char(c: char) -> bool {
    c.is_alphabetic() || matches!(c, '%' | '°' | 'µ' | 'μ' | '_')
}

impl<'a> Parser<'a> {
    fn new(text: &'a str) -> Self {
        Self { text, pos: 0 }
    }

    fn rest(&self) -> &'a str {
        &self.text[self.pos..]
    }

    fn peek(&self) -> Option<char> {
        self.rest().chars().next()
    }

    fn at_end(&self) -> bool {
        self.pos >= self.text.len()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += c.len_utf8();
        Some(c)
    }

    fn eat(&mut self, c: char) -> bool {
        if self.peek() == Some(c) {
            self.pos += c.len_utf8();
            true
        } else {
            false
        }
    }

    fn ws(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.bump();
        }
    }

    fn syntax_at(&self, at: usize) -> UnitError {
        UnitError::Syntax {
            text: self.text.to_string(),
            at: u32::try_from(at).unwrap_or(u32::MAX),
        }
    }

    fn syntax(&self) -> UnitError {
        self.syntax_at(self.pos)
    }

    fn digits(&mut self) -> usize {
        let start = self.pos;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.pos += 1;
        }
        self.pos - start
    }

    /// An unsigned decimal literal; returns its text span. With `exp`, an
    /// exponent (`e-3`) is accepted when a digit follows the `e`.
    fn decimal(&mut self, exp: bool) -> Option<(usize, usize, bool)> {
        let start = self.pos;
        let int = self.digits();
        let mut is_int = true;
        if self.peek() == Some('.') {
            let save = self.pos;
            self.pos += 1;
            let frac = self.digits();
            if int == 0 && frac == 0 {
                self.pos = save;
                return None;
            }
            is_int = false;
        } else if int == 0 {
            return None;
        }
        if exp && matches!(self.peek(), Some('e' | 'E')) {
            let save = self.pos;
            self.pos += 1;
            if matches!(self.peek(), Some('+' | '-')) {
                self.pos += 1;
            }
            if self.digits() == 0 {
                self.pos = save;
            } else {
                is_int = false;
            }
        }
        Some((start, self.pos, is_int))
    }

    fn value_of(&self, span: (usize, usize)) -> Result<f64, UnitError> {
        self.text[span.0..span.1]
            .parse::<f64>()
            .map_err(|_| self.syntax_at(span.0))
    }

    /// `n/d` after a numerator; restores the position when no fraction follows.
    fn fraction_tail(&mut self) -> Result<Option<f64>, UnitError> {
        let save = self.pos;
        self.ws();
        if !self.eat('/') {
            self.pos = save;
            return Ok(None);
        }
        self.ws();
        match self.decimal(false) {
            Some((s, e, _)) => {
                let den = self.value_of((s, e))?;
                if den == 0.0 {
                    return Err(self.syntax_at(s));
                }
                Ok(Some(den))
            }
            None => {
                // `10 /s`-style text is not a fraction; let the unit parser see it.
                self.pos = save;
                Ok(None)
            }
        }
    }

    fn number(&mut self) -> Result<f64, UnitError> {
        let start = self.pos;
        let neg = match self.peek() {
            Some('-' | '−') => {
                self.bump();
                true
            }
            Some('+') => {
                self.bump();
                false
            }
            _ => false,
        };
        let Some((s, e, is_int)) = self.decimal(true) else {
            return Err(self.syntax_at(start));
        };
        let mut v = self.value_of((s, e))?;
        if let Some(den) = self.fraction_tail()? {
            v /= den;
        } else if is_int {
            // Mixed number `1 1/4`: whole part, space, proper fraction.
            let save = self.pos;
            self.ws();
            if self.pos > save
                && let Some((ns, ne, true)) = self.decimal(false)
                && let Some(den) = self.fraction_tail()?
            {
                v += self.value_of((ns, ne))? / den;
            } else {
                self.pos = save;
            }
        }
        if neg {
            v = -v;
        }
        if !v.is_finite() {
            return Err(self.syntax_at(start));
        }
        Ok(v)
    }

    /// A whole unit expression; keeps the offset only for a lone symbol.
    fn unit_top(&mut self) -> Result<Unit, UnitError> {
        let start = self.pos;
        let mut u = self.unit_expr()?;
        let lone = self.text[start..self.pos].trim();
        if u.offset != 0.0 && lookup(lone).is_none() {
            u.offset = 0.0;
        }
        Ok(u)
    }

    fn unit_expr(&mut self) -> Result<Unit, UnitError> {
        let mut acc = self.factor()?;
        loop {
            let save = self.pos;
            self.ws();
            let div = match self.peek() {
                Some('*' | '·') => false,
                Some('/') => true,
                _ => {
                    self.pos = save;
                    return Ok(acc);
                }
            };
            self.bump();
            self.ws();
            let at = self.pos;
            let rhs = self.factor()?;
            let dim = if div {
                acc.dim.checked_div(rhs.dim)
            } else {
                acc.dim.checked_mul(rhs.dim)
            }
            .ok_or_else(|| self.syntax_at(at))?;
            acc = Unit {
                scale: if div {
                    acc.scale / rhs.scale
                } else {
                    acc.scale * rhs.scale
                },
                offset: 0.0,
                dim,
            };
        }
    }

    fn factor(&mut self) -> Result<Unit, UnitError> {
        let base = self.primary()?;
        let at = self.pos;
        let p: i8 = if self.eat('²') {
            2
        } else if self.eat('³') {
            3
        } else if self.eat('^') {
            self.ws();
            let paren = self.eat('(');
            self.ws();
            let p = self.int()?;
            self.ws();
            if paren && !self.eat(')') {
                return Err(self.syntax());
            }
            p
        } else {
            return Ok(base);
        };
        if p == 1 {
            return Ok(base);
        }
        let dim = base.dim.checked_pow(p).ok_or_else(|| self.syntax_at(at))?;
        Ok(Unit {
            scale: base.scale.powi(i32::from(p)),
            offset: 0.0,
            dim,
        })
    }

    fn int(&mut self) -> Result<i8, UnitError> {
        let start = self.pos;
        let neg = match self.peek() {
            Some('-' | '−') => {
                self.bump();
                true
            }
            Some('+') => {
                self.bump();
                false
            }
            _ => false,
        };
        let ds = self.pos;
        if self.digits() == 0 {
            return Err(self.syntax_at(start));
        }
        let mag: i16 = self.text[ds..self.pos]
            .parse()
            .map_err(|_| self.syntax_at(ds))?;
        let v = if neg { -mag } else { mag };
        i8::try_from(v).map_err(|_| self.syntax_at(start))
    }

    fn primary(&mut self) -> Result<Unit, UnitError> {
        let start = self.pos;
        match self.peek() {
            Some('(') => {
                self.bump();
                self.ws();
                let u = self.unit_expr()?;
                self.ws();
                if !self.eat(')') {
                    return Err(self.syntax());
                }
                Ok(Unit { offset: 0.0, ..u })
            }
            Some('1') => {
                self.bump();
                if self.peek().is_some_and(|c| c.is_ascii_digit()) {
                    return Err(self.syntax_at(start));
                }
                Ok(Unit::ONE)
            }
            Some(c) if is_symbol_char(c) => {
                while self.peek().is_some_and(is_symbol_char) {
                    self.bump();
                }
                let sym = &self.text[start..self.pos];
                lookup(sym)
                    .map(|d| d.unit())
                    .ok_or_else(|| UnitError::UnknownUnit {
                        unit: sym.to_string(),
                    })
            }
            _ => Err(self.syntax_at(start)),
        }
    }
}

/// The dimension of a unit expression, for callers that only need it.
pub fn unit_dimension(text: &str) -> Result<Dimension, UnitError> {
    parse_unit(text).map(|u| u.dim)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn si(text: &str, k: DimKind) -> f64 {
        parse_for(text, k).unwrap().value
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-12 * a.abs().max(b.abs()).max(1e-300)
    }

    #[test]
    fn spellings_from_the_row() {
        assert_eq!(si("54 mm", DimKind::Length), 0.054);
        assert_eq!(si("54mm", DimKind::Length), 0.054);
        assert_eq!(si("1/4 in", DimKind::Length), 0.00635);
        assert_eq!(si("1 1/4 in", DimKind::Length), 0.03175);
        assert_eq!(si("1250 kg/m^3", DimKind::Density), 1250.0);
        assert_eq!(si("120 N*s", DimKind::Impulse), 120.0);
        assert_eq!(si("120 N·s", DimKind::Impulse), 120.0);
        assert_eq!(si("120 Ns", DimKind::Impulse), 120.0);
    }

    #[test]
    fn temperatures_offset_only_alone() {
        assert!(close(si("20 degC", DimKind::Temperature), 293.15));
        assert!(close(si("20 °C", DimKind::Temperature), 293.15));
        assert!(close(si("32 degF", DimKind::Temperature), 273.15));
        assert!(close(
            si("-40 degF", DimKind::Temperature),
            si("-40 degC", DimKind::Temperature)
        ));
        // In a compound the offset is dropped: an interval.
        assert_eq!(si("1000 J/(kg*degC)", DimKind::SpecificHeat), 1000.0);
        assert!(close(si("1 J/(kg*degF)", DimKind::SpecificHeat), 1.8));
        // Parenthesised alone is still a compound expression.
        assert_eq!(si("1 (degC)", DimKind::Temperature), 1.0);
    }

    #[test]
    fn bare_numbers() {
        assert_eq!(
            parse_for("54", DimKind::Length),
            Err(UnitError::UnitMissing {
                expected: DimKind::Length
            })
        );
        assert_eq!(parse_for("0", DimKind::Length).unwrap().value, 0.0);
        assert_eq!(parse_for(" -0 ", DimKind::Length).unwrap().value, 0.0);
        assert_eq!(si("0.5", DimKind::Dimensionless), 0.5);
        assert_eq!(si("50 %", DimKind::Dimensionless), 0.5);
        assert!(number_for(3.0, DimKind::Mass).is_err());
        assert!(number_for(0.0, DimKind::Mass).is_ok());
        assert_eq!(number_for(3.0, DimKind::Dimensionless).unwrap().value, 3.0);
    }

    #[test]
    fn numbers() {
        assert_eq!(si("1e-3 m", DimKind::Length), 1e-3);
        assert_eq!(si("1.5E3m", DimKind::Length), 1500.0);
        assert_eq!(si(".5 m", DimKind::Length), 0.5);
        assert_eq!(si("5. m", DimKind::Length), 5.0);
        assert_eq!(si("-5 m", DimKind::Length), -5.0);
        assert_eq!(si("−5 m", DimKind::Length), -5.0);
        assert_eq!(si("+5 m", DimKind::Length), 5.0);
        assert_eq!(si("3/2", DimKind::Dimensionless), 1.5);
        assert_eq!(si("-1/4 in", DimKind::Length), -0.00635);
        // `e` without digits is not an exponent.
        assert!(matches!(
            parse_for("2 e", DimKind::Length),
            Err(UnitError::UnknownUnit { .. })
        ));
    }

    #[test]
    fn compound_units() {
        assert_eq!(si("10 1/s", DimKind::Frequency), 10.0);
        assert_eq!(si("10 Hz", DimKind::Frequency), 10.0);
        assert_eq!(si("9.81 m/s^2", DimKind::Acceleration), 9.81);
        assert_eq!(si("9.81 m/s²", DimKind::Acceleration), 9.81);
        assert_eq!(si("9.81 m*s^-2", DimKind::Acceleration), 9.81);
        assert_eq!(si("9.81 m*s^(-2)", DimKind::Acceleration), 9.81);
        assert_eq!(si("2 kg/m/s", DimKind::DynamicViscosity), 2.0);
        assert_eq!(si("2 kg / (m * s)", DimKind::DynamicViscosity), 2.0);
        assert_eq!(si("1 kg*m^2", DimKind::Inertia), 1.0);
        assert!(close(si("1 g/cm^3", DimKind::Density), 1000.0));
        assert!(close(si("1 lbf*s", DimKind::Impulse), 4.448_221_615_260_5));
        assert!(close(si("1 psi", DimKind::Pressure), 6_894.757_293_168_361));
        assert!(close(
            si("60 rpm", DimKind::AngularVelocity),
            2.0 * std::f64::consts::PI
        ));
        assert!(close(si("180 deg", DimKind::Angle), std::f64::consts::PI));
        assert!(close(si("180°", DimKind::Angle), std::f64::consts::PI));
        assert!(close(si("5 µm", DimKind::Length), 5e-6));
    }

    #[test]
    fn errors() {
        assert!(matches!(
            parse_for("54 furlong", DimKind::Length),
            Err(UnitError::UnknownUnit { unit }) if unit == "furlong"
        ));
        assert_eq!(
            parse_for("54 kg", DimKind::Length),
            Err(UnitError::DimensionMismatch {
                expected: DimKind::Length.dimension(),
                found: DimKind::Mass.dimension(),
            })
        );
        // Angle is a dimension: radians are not a pure number.
        assert!(parse_for("1 rad", DimKind::Dimensionless).is_err());
        for bad in [
            "", " ", "mm", "54 mm mm", "54 mm)", "54 (mm", "1/0 in", "54 m^", "54 m^x", "54 m^200",
            "54 m**2", "54 *mm", "1e400 m", "= 5", "54 11", "54 m^(2",
        ] {
            assert!(parse_for(bad, DimKind::Length).is_err(), "{bad:?}");
        }
        assert!(matches!(
            parse_for("54 mm junk", DimKind::Length),
            Err(UnitError::Syntax { at: 6, .. })
        ));
        assert_eq!(
            UnitError::UnitMissing {
                expected: DimKind::Length
            }
            .code(),
            "RW-E021"
        );
    }

    #[test]
    fn raw_tokens() {
        use crate::QLength;
        assert_eq!(
            QLength::text("54 mm").literal().unwrap().unwrap().value,
            0.054
        );
        assert_eq!(QLength::text("= params.d").literal().unwrap(), None);
        assert_eq!(QLength::number(0.0).literal().unwrap().unwrap().value, 0.0);
        assert!(QLength::number(54.0).literal().is_err());
    }
}
