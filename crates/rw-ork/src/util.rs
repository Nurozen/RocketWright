//! Ids, quantity strings, and small parsing helpers shared by import and export.

use std::collections::BTreeSet;

use rw_units::{Qty, Quantity, UnitDim, format_in};

/// A component id slug: `[a-z][a-z0-9_]*`, at most 40 characters.
pub fn slug(name: &str) -> String {
    let mut s = String::new();
    let mut gap = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            if gap && !s.is_empty() {
                s.push('_');
            }
            gap = false;
            s.push(c.to_ascii_lowercase());
        } else {
            gap = true;
        }
    }
    if s.len() > 40 {
        s.truncate(40);
        while s.ends_with('_') {
            s.pop();
        }
    }
    if !s.starts_with(|c: char| c.is_ascii_lowercase()) {
        s.insert_str(0, "c_");
    }
    s
}

/// True for a valid component id.
pub fn is_id(s: &str) -> bool {
    s.starts_with(|c: char| c.is_ascii_lowercase())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// `base`, or `base_2`, `base_3`, ... — the first not in `taken` (then taken).
pub fn unique(base: &str, taken: &mut BTreeSet<String>) -> String {
    let mut id = base.to_string();
    let mut n = 2;
    while taken.contains(&id) {
        id = format!("{base}_{n}");
        n += 1;
    }
    taken.insert(id.clone());
    id
}

/// A file-name-safe stem: `[A-Za-z0-9_.-]`.
pub fn file_stem(s: &str) -> String {
    let t: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let t = t.trim_matches(['_', '.']).to_string();
    if t.is_empty() { "motor".into() } else { t }
}

/// `si` as text in `unit`, rounded to 12 significant digits (so `0.1016 m`
/// reads `101.6 mm`, not `101.59999999999998 mm`; the change is below
/// 1e-12 relative).
pub fn qtext<D: UnitDim>(si: f64, unit: &str) -> String {
    let q = Quantity {
        value: si,
        dim: D::KIND.dimension(),
    };
    let Ok(text) = format_in(q, unit) else {
        return format!("{si} {}", D::KIND.si_unit());
    };
    let Some((num, rest)) = text.split_once(' ') else {
        return text;
    };
    match num.parse::<f64>() {
        Ok(v) if v.is_finite() => {
            let r: f64 = format!("{v:.11e}").parse().unwrap_or(v);
            format!("{} {rest}", rw_units::format_number(r))
        }
        _ => text,
    }
}

/// A quantity field from an SI value.
pub fn q<D: UnitDim>(si: f64, unit: &str) -> Qty<D> {
    Qty::text(qtext::<D>(si, unit))
}

/// An angle field from a value the format stores in degrees.
pub fn degrees(v: f64) -> Qty<rw_units::markers::Angle> {
    Qty::text(format!("{} deg", rw_units::format_number(v)))
}

/// An expression quantity (`= c.body.od`).
pub fn qe<D: UnitDim>(expr: impl AsRef<str>) -> Qty<D> {
    Qty::text(format!("= {}", expr.as_ref()))
}

/// Length unit text.
pub fn mm(si: f64) -> String {
    qtext::<rw_units::markers::Length>(si, "mm")
}

/// Sum of expression terms plus a constant length, as an `=` expression, or
/// a plain quantity when there are no terms.
pub fn len_expr(terms: &[(f64, String)], constant: f64) -> Qty<rw_units::markers::Length> {
    let live: Vec<&(f64, String)> = terms.iter().filter(|(k, _)| *k != 0.0).collect();
    if live.is_empty() {
        return q(constant, "mm");
    }
    let mut s = String::new();
    for (i, (k, r)) in live.iter().enumerate() {
        let neg = *k < 0.0;
        let a = k.abs();
        if i == 0 {
            if neg {
                s.push('-');
            }
        } else {
            s.push_str(if neg { " - " } else { " + " });
        }
        if a == 1.0 {
            s.push_str(r);
        } else if a == 0.5 {
            s.push_str(&format!("{r} / 2"));
        } else {
            s.push_str(&format!("{} * {r}", rw_units::format_number(a)));
        }
    }
    if constant != 0.0 {
        let neg = constant < 0.0;
        s.push_str(if neg { " - " } else { " + " });
        s.push_str(&mm(constant.abs()));
    }
    qe(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rw_units::QtyRaw;

    #[test]
    fn slugs_are_ids() {
        assert_eq!(slug("Nose cone"), "nose_cone");
        assert_eq!(slug("  Body tube #2 "), "body_tube_2");
        assert_eq!(slug("3D fins"), "c_3d_fins");
        assert_eq!(slug("!!!"), "c_");
        assert!(is_id(&slug("Ünïcode name")));
        let mut t = BTreeSet::new();
        assert_eq!(unique("a", &mut t), "a");
        assert_eq!(unique("a", &mut t), "a_2");
    }

    #[test]
    fn quantities_round_trip_exactly() {
        let t = qtext::<rw_units::markers::Length>(0.0254, "mm");
        assert_eq!(t, "25.4 mm");
        assert_eq!(qtext::<rw_units::markers::Length>(0.1016, "mm"), "101.6 mm");
        assert_eq!(
            qtext::<rw_units::markers::Length>(0.0047625, "mm"),
            "4.7625 mm"
        );
        let e = len_expr(
            &[(1.0, "c.a.length".into()), (-0.5, "c.b.length".into())],
            -0.002,
        );
        match e.raw {
            QtyRaw::Text(s) => assert_eq!(s, "= c.a.length - c.b.length / 2 - 2 mm"),
            QtyRaw::Number(_) => panic!(),
        }
    }
}
