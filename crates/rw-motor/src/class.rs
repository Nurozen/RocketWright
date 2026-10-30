//! NAR/TRA impulse classes and motor designations.
//!
//! Class `A` covers total impulse in (1.25, 2.5] N s, and every following
//! letter doubles both bounds up to `O` (20480, 40960]. Below `A` come the
//! fractional classes `1/2A` (0.625, 1.25], `1/4A` (0.3125, 0.625], and
//! `1/8A` (0, 0.3125]. A designation is the class plus the rounded average
//! thrust in newtons (`C6`), optionally followed by propellant letters and a
//! `-`-separated delay list (`C6-5`, `G80T-7`, `B4-P`).

/// Class letters from `A` upward.
const LETTERS: &str = "ABCDEFGHIJKLMNO";
/// Upper bound of class `A` (N s).
const A_MAX: f64 = 2.5;

/// `(lower, upper]` total-impulse bounds of `class` in N s, e.g.
/// `C` → (5, 10]. `None` for an unknown class.
///
/// cite: n/a NAR impulse-class table (each class doubles the previous)
pub fn class_bounds(class: &str) -> Option<(f64, f64)> {
    let c = class.trim().to_ascii_uppercase();
    let upper = match c.as_str() {
        "1/8A" => A_MAX / 8.0,
        "1/4A" => A_MAX / 4.0,
        "1/2A" => A_MAX / 2.0,
        _ if c.len() == 1 => {
            let k = LETTERS.find(c.as_str())?;
            A_MAX * f64::from(1u32 << k)
        }
        _ => return None,
    };
    let lower = if c == "1/8A" { 0.0 } else { upper / 2.0 };
    Some((lower, upper))
}

/// Impulse class of a total impulse in N s (`9.6` → `C`). `None` for a
/// non-positive or non-finite impulse, or one above class `O`.
///
/// cite: n/a NAR impulse-class table (each class doubles the previous)
pub fn impulse_class(total_impulse: f64) -> Option<String> {
    if !(total_impulse.is_finite() && total_impulse > 0.0) {
        return None;
    }
    for frac in ["1/8A", "1/4A", "1/2A"] {
        let (_, hi) = class_bounds(frac)?;
        if total_impulse <= hi {
            return Some(frac.to_string());
        }
    }
    LETTERS
        .chars()
        .enumerate()
        .find(|(k, _)| total_impulse <= A_MAX * f64::from(1u32 << k))
        .map(|(_, c)| c.to_string())
}

/// Standard designation from total impulse (N s) and average thrust (N),
/// e.g. `(9.6, 6.0)` → `C6`. `None` when the impulse has no class.
///
/// cite: n/a NAR designation convention (class letter + average thrust)
pub fn designation(total_impulse: f64, average_thrust: f64) -> Option<String> {
    let class = impulse_class(total_impulse)?;
    let avg = average_thrust.round().max(1.0);
    Some(format!("{class}{avg:.0}"))
}

/// A parsed designation such as `C6-5`, `1/2A3-2T`, `G80T-7`, or `RW_C6G`.
#[derive(Debug, Clone, PartialEq)]
pub struct Designation {
    /// Impulse class (`C`, `1/2A`).
    pub class: String,
    /// Average thrust in N, when the designation carries one.
    pub average_thrust: Option<f64>,
    /// Ejection delays in s (`P` = plugged is omitted).
    pub delays: Vec<f64>,
}

/// Parses a motor designation. A leading `RW_` (RocketWright generic) is
/// ignored. `None` when no impulse class can be read.
///
/// cite: n/a NAR designation convention (class letter + average thrust + delay)
pub fn parse_designation(s: &str) -> Option<Designation> {
    let s = s.trim();
    let s = s.strip_prefix("RW_").unwrap_or(s);
    let (head, delay_part) = match s.split_once('-') {
        Some((h, d)) => (h, Some(d)),
        None => (s, None),
    };
    let upper = head.to_ascii_uppercase();
    let (class, rest) = ["1/8A", "1/4A", "1/2A"]
        .into_iter()
        .find_map(|f| upper.strip_prefix(f).map(|r| (f.to_string(), r)))
        .or_else(|| {
            let c = upper.chars().next()?;
            LETTERS
                .contains(c)
                .then(|| (c.to_string(), &upper[c.len_utf8()..]))
        })?;
    let digits_end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(rest.len());
    let average_thrust = rest[..digits_end].parse::<f64>().ok();
    let delays = delay_part
        .map(|d| {
            d.split(['-', ','])
                .filter_map(|tok| {
                    let digits: String = tok
                        .trim()
                        .chars()
                        .take_while(|c| c.is_ascii_digit() || *c == '.')
                        .collect();
                    digits.parse::<f64>().ok()
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Designation {
        class,
        average_thrust,
        delays,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn class_edges() {
        assert_eq!(impulse_class(0.3).as_deref(), Some("1/8A"));
        assert_eq!(impulse_class(0.3125).as_deref(), Some("1/8A"));
        assert_eq!(impulse_class(0.5).as_deref(), Some("1/4A"));
        assert_eq!(impulse_class(1.25).as_deref(), Some("1/2A"));
        assert_eq!(impulse_class(1.2501).as_deref(), Some("A"));
        assert_eq!(impulse_class(2.5).as_deref(), Some("A"));
        assert_eq!(impulse_class(2.51).as_deref(), Some("B"));
        assert_eq!(impulse_class(9.6).as_deref(), Some("C"));
        assert_eq!(impulse_class(10.0).as_deref(), Some("C"));
        assert_eq!(impulse_class(10.01).as_deref(), Some("D"));
        assert_eq!(impulse_class(40960.0).as_deref(), Some("O"));
        assert_eq!(impulse_class(40960.1), None);
        assert_eq!(impulse_class(0.0), None);
        assert_eq!(impulse_class(f64::NAN), None);
    }

    #[test]
    fn bounds_round_trip() {
        for c in ["1/8A", "1/4A", "1/2A", "A", "B", "C", "G", "O"] {
            let (lo, hi) = class_bounds(c).expect(c);
            assert_eq!(impulse_class(hi).as_deref(), Some(c));
            assert_eq!(impulse_class((lo + hi) / 2.0).as_deref(), Some(c));
        }
        assert_eq!(class_bounds("c"), Some((5.0, 10.0)));
        assert_eq!(class_bounds("P"), None);
        assert_eq!(class_bounds("AB"), None);
    }

    #[test]
    fn designations() {
        assert_eq!(designation(9.6, 6.0).as_deref(), Some("C6"));
        assert_eq!(designation(2.4, 8.0).as_deref(), Some("A8"));
        assert_eq!(designation(0.9, 2.6).as_deref(), Some("1/2A3"));
        assert_eq!(designation(0.0, 1.0), None);
        let d = parse_designation("C6-5").expect("C6-5");
        assert_eq!(
            d,
            Designation {
                class: "C".into(),
                average_thrust: Some(6.0),
                delays: vec![5.0]
            }
        );
        let d = parse_designation("RW_C6G").expect("RW_C6G");
        assert_eq!((d.class.as_str(), d.average_thrust), ("C", Some(6.0)));
        assert!(d.delays.is_empty());
        let d = parse_designation("1/2A3-2T").expect("1/2A3");
        assert_eq!((d.class.as_str(), d.average_thrust), ("1/2A", Some(3.0)));
        assert_eq!(d.delays, vec![2.0]);
        let d = parse_designation("G80T-7").expect("G80T");
        assert_eq!((d.class.as_str(), d.average_thrust), ("G", Some(80.0)));
        assert_eq!(
            parse_designation("B4-P").expect("B4").delays,
            Vec::<f64>::new()
        );
        assert_eq!(parse_designation("Z9"), None);
        assert_eq!(parse_designation(""), None);
    }
}
