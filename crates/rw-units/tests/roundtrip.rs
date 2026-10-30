//! Property tests: `parse(format(x)) == x`, and the parser never panics.

use proptest::prelude::*;
use rw_units::{
    DimKind, Dimension, Quantity, UNITS, format_in, format_si, format_sig, parse_for,
    parse_quantity, parse_unit,
};

fn finite() -> impl Strategy<Value = f64> {
    prop_oneof![
        Just(0.0),
        -1e6..1e6f64,
        (-300i32..300, -10.0..10.0f64).prop_map(|(e, m)| m * 10f64.powi(e)),
        any::<f64>().prop_filter("finite", |v| v.is_finite()),
    ]
}

fn kind() -> impl Strategy<Value = DimKind> {
    prop::sample::select(DimKind::ALL.to_vec())
}

fn close(a: f64, b: f64, rel: f64, abs: f64) -> bool {
    (a - b).abs() <= rel * a.abs().max(b.abs()) + abs
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    /// In the coherent SI unit the round trip is exact for every finite value.
    #[test]
    fn si_round_trip_is_exact(v in finite(), k in kind()) {
        let q = Quantity { value: v, dim: k.dimension() };
        let text = format_si(q);
        let back = parse_for(&text, k).unwrap();
        prop_assert_eq!(back.value, v, "{}", text);
        prop_assert_eq!(back.dim, q.dim);
    }

    /// In any table unit the round trip is exact when a decimal in that unit
    /// reaches the SI value, and within a few ulps otherwise.
    #[test]
    fn table_unit_round_trip(v in -1e12..1e12f64, i in 0..UNITS.len()) {
        let def = &UNITS[i];
        let q = Quantity { value: v, dim: def.dim };
        let text = format_in(q, def.symbol).unwrap();
        let back = parse_quantity(&text).unwrap();
        prop_assert_eq!(back.dim, def.dim);
        // Offset units lose absolute precision near the offset.
        let abs = if def.offset != 0.0 { 1e-9 } else { 0.0 };
        prop_assert!(close(back.value, v, 4.0 * f64::EPSILON, abs), "{} -> {} vs {}", text, back.value, v);
        // Aliases parse to the same unit as the symbol.
        for a in def.aliases {
            prop_assert_eq!(parse_unit(a).unwrap(), def.unit());
        }
    }

    /// Arbitrary dimension vectors print as SI base units and parse back.
    #[test]
    fn dimension_round_trip(e in prop::array::uniform8(-6i8..=6), v in finite()) {
        let dim = Dimension::from_exponents(e);
        let q = Quantity { value: v, dim };
        let text = q.dim.to_string();
        prop_assert_eq!(parse_unit(&text).unwrap().dim, dim, "{}", text);
        prop_assert_eq!(parse_unit(&text).unwrap().scale, 1.0);
        let back = parse_quantity(&format_si(q)).unwrap();
        prop_assert_eq!(back.value, v);
        prop_assert_eq!(back.dim, dim);
    }

    /// Fixed significant figures parse back within half a unit in the last place.
    #[test]
    fn sig_round_trip(v in finite(), sig in 1u8..=17, k in kind()) {
        let unit = k.si_unit();
        let q = Quantity { value: v, dim: k.dimension() };
        let text = format_sig(q, unit, sig).unwrap();
        let back = parse_for(&text, k).unwrap();
        let rel = 0.5 * 10f64.powi(1 - i32::from(sig)) + 4.0 * f64::EPSILON;
        prop_assert!(close(back.value, v, rel, 0.0), "{} vs {}", text, v);
    }

    /// The parser returns an error rather than panicking on any input.
    #[test]
    fn never_panics(s in "\\PC{0,24}", k in kind()) {
        let _ = parse_for(&s, k);
        let _ = parse_unit(&s);
    }

    /// Number-like noise around real units never panics either.
    #[test]
    fn never_panics_structured(s in "[-+ 0-9./eE^()*·²³]{0,6}(mm|in|kg|N|s|degC|°|%)?[-+ 0-9./^()*]{0,6}") {
        let _ = parse_quantity(&s);
    }

    /// Bare non-zero numbers are rejected on every dimensional field.
    #[test]
    fn bare_numbers_rejected(v in finite().prop_filter("non-zero", |v| *v != 0.0), k in kind()) {
        let r = parse_for(&rw_units::format_number(v), k);
        if k == DimKind::Dimensionless {
            prop_assert_eq!(r.unwrap().value, v);
        } else {
            prop_assert_eq!(r, Err(rw_units::UnitError::UnitMissing { expected: k }));
        }
    }
}
