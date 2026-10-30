//! Formatting SI quantities back to source text.
//!
//! [`format_in`] writes the shortest number that parses back to the same SI
//! value (exactly, when such a number exists in the target unit), so
//! `parse(format(x)) == x` is the round-trip contract. [`format_sig`] writes
//! a fixed number of significant figures for deterministic reports (I8).

use std::fmt;

use crate::dim::DimKind;
use crate::parse::parse_unit;
use crate::qty::{Quantity, UnitError};
use crate::table::Unit;

/// Writes a finite number in the shortest form that parses back to exactly
/// `v`, in plain notation for moderate magnitudes and `1.5e-9` otherwise.
pub fn format_number(v: f64) -> String {
    let a = v.abs();
    if a == 0.0 || (1e-6..1e15).contains(&a) {
        format!("{v}")
    } else {
        format!("{v:e}")
    }
}

/// Resolves a target unit; the empty string is the pure number `1`.
fn target(unit: &str) -> Result<Unit, UnitError> {
    if unit.trim().is_empty() {
        Ok(Unit::ONE)
    } else {
        parse_unit(unit)
    }
}

fn join(num: &str, unit: &str) -> String {
    if unit.is_empty() {
        num.to_string()
    } else {
        format!("{num} {unit}")
    }
}

/// Writes `si` in `unit` with the fewest significant digits that convert back
/// to exactly `si`; when no decimal in `unit` does, the closest one.
fn shortest_in(u: Unit, si: f64) -> String {
    let v = u.from_si(si);
    if u.scale == 1.0 && u.offset == 0.0 {
        return format_number(v);
    }
    for digits in 1..=17usize {
        let s = format!("{v:.*e}", digits - 1);
        if let Ok(c) = s.parse::<f64>()
            && u.to_si(c) == si
        {
            return format_number(c);
        }
    }
    format_number(v)
}

/// Formats an SI quantity in `unit` (any unit expression of the same
/// dimension), e.g. `0.054 m` in `mm` → `"54 mm"`.
pub fn format_in(q: Quantity, unit: &str) -> Result<String, UnitError> {
    let u = target(unit)?;
    if u.dim != q.dim {
        return Err(UnitError::DimensionMismatch {
            expected: q.dim,
            found: u.dim,
        });
    }
    if !q.value.is_finite() {
        return Err(UnitError::Syntax {
            text: q.value.to_string(),
            at: 0,
        });
    }
    Ok(join(&shortest_in(u, q.value), unit.trim()))
}

/// Formats an SI quantity in its coherent SI unit: the named unit of its
/// [`DimKind`] (`N`, `kg/m^3`), else the base-unit product of its dimension.
/// A pure number is written bare.
pub fn format_si(q: Quantity) -> String {
    let unit = match DimKind::from_dimension(q.dim) {
        Some(k) => k.si_unit().to_string(),
        None => q.dim.to_string(),
    };
    join(&format_number(q.value), &unit)
}

/// Writes `v` with `sig` significant figures (1..=17), trailing zeros
/// trimmed: `format_sig_number(1234.5678, 3) == "1230"`.
pub fn format_sig_number(v: f64, sig: u8) -> String {
    let sig = usize::from(sig.clamp(1, 17));
    if v == 0.0 || !v.is_finite() {
        return format_number(if v == 0.0 { 0.0 } else { v });
    }
    let sci = format!("{:.*e}", sig - 1, v);
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let (neg, mant) = match mant.strip_prefix('-') {
        Some(m) => (true, m),
        None => (false, mant),
    };
    let digits: String = mant.chars().filter(char::is_ascii_digit).collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let body = if !(-7..21).contains(&exp) {
        let (h, t) = digits.split_at(1);
        if t.is_empty() {
            format!("{h}e{exp}")
        } else {
            format!("{h}.{t}e{exp}")
        }
    } else if exp < 0 {
        let zeros = usize::try_from(-exp - 1).unwrap_or(0);
        format!("0.{}{digits}", "0".repeat(zeros))
    } else {
        let point = usize::try_from(exp + 1).unwrap_or(0);
        if digits.len() <= point {
            format!("{digits}{}", "0".repeat(point - digits.len()))
        } else {
            let (i, f) = digits.split_at(point);
            format!("{i}.{f}")
        }
    };
    if neg { format!("-{body}") } else { body }
}

/// Formats an SI quantity in `unit` with `sig` significant figures.
pub fn format_sig(q: Quantity, unit: &str, sig: u8) -> Result<String, UnitError> {
    let u = target(unit)?;
    if u.dim != q.dim {
        return Err(UnitError::DimensionMismatch {
            expected: q.dim,
            found: u.dim,
        });
    }
    Ok(join(
        &format_sig_number(u.from_si(q.value), sig),
        unit.trim(),
    ))
}

/// Writes the quantity in its coherent SI unit ([`format_si`]).
impl fmt::Display for Quantity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&format_si(*self))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::{parse_for, parse_quantity};

    fn q(v: f64, k: DimKind) -> Quantity {
        Quantity {
            value: v,
            dim: k.dimension(),
        }
    }

    #[test]
    fn shortest_round_trip_in_unit() {
        assert_eq!(format_in(q(0.054, DimKind::Length), "mm").unwrap(), "54 mm");
        assert_eq!(
            format_in(q(0.00635, DimKind::Length), "in").unwrap(),
            "0.25 in"
        );
        assert_eq!(
            format_in(q(293.15, DimKind::Temperature), "degC").unwrap(),
            "20 degC"
        );
        assert_eq!(
            format_in(q(1250.0, DimKind::Density), "kg/m^3").unwrap(),
            "1250 kg/m^3"
        );
        assert_eq!(format_in(q(1e-9, DimKind::Length), "m").unwrap(), "1e-9 m");
        assert!(format_in(q(1.0, DimKind::Length), "kg").is_err());
    }

    #[test]
    fn si_names() {
        assert_eq!(q(9.81, DimKind::Acceleration).to_string(), "9.81 m/s^2");
        assert_eq!(q(120.0, DimKind::Impulse).to_string(), "120 N*s");
        assert_eq!(q(0.5, DimKind::Dimensionless).to_string(), "0.5");
        let odd = Quantity {
            value: 2.0,
            dim: crate::Dimension::new(1, 1, -3, -1, 0),
        };
        assert_eq!(odd.to_string(), "2 kg*m/(s^3*K)");
        assert_eq!(parse_quantity(&odd.to_string()).unwrap(), odd);
    }

    #[test]
    fn significant_figures() {
        assert_eq!(format_sig_number(1234.5678, 3), "1230");
        assert_eq!(format_sig_number(0.00012345, 2), "0.00012");
        assert_eq!(format_sig_number(-2.5, 6), "-2.5");
        assert_eq!(format_sig_number(1e-12, 3), "1e-12");
        assert_eq!(format_sig_number(1.25e30, 3), "1.25e30");
        assert_eq!(format_sig_number(0.0, 3), "0");
        assert_eq!(format_sig_number(9.999, 2), "10");
        assert_eq!(
            format_sig(q(0.0541234, DimKind::Length), "mm", 3).unwrap(),
            "54.1 mm"
        );
        let back = parse_for("54.1 mm", DimKind::Length).unwrap().value;
        assert!((back - 0.0541).abs() < 1e-15);
    }
}
