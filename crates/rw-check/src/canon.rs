//! Deterministic report JSON (invariant I8): every float rounded to
//! [`SIG_FIGS`] significant figures, object keys sorted, no timestamps.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Number, Value};

/// Significant figures kept in check reports and deltas.
pub const SIG_FIGS: usize = 6;

/// `v` rounded to `sig` significant figures (`-0` and non-finite become `0`).
/// cite: n/a output formatting, no physics
pub fn round_sig(v: f64, sig: usize) -> f64 {
    if !v.is_finite() || v == 0.0 {
        return 0.0;
    }
    let s = format!("{:.*e}", sig.saturating_sub(1), v);
    let r: f64 = s.parse().unwrap_or(v);
    if r == 0.0 { 0.0 } else { r }
}

fn round_value(v: &mut Value) {
    match v {
        Value::Number(n) => {
            if n.is_f64()
                && let Some(x) = n.as_f64()
                && let Some(r) = Number::from_f64(round_sig(x, SIG_FIGS))
            {
                *n = r;
            }
        }
        Value::Array(a) => a.iter_mut().for_each(round_value),
        Value::Object(o) => o.values_mut().for_each(round_value),
        _ => {}
    }
}

fn sort_value(v: Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.into_iter().map(sort_value).collect()),
        Value::Object(o) => {
            let mut entries: Vec<(String, Value)> = o.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let mut m = Map::new();
            for (k, v) in entries {
                m.insert(k, sort_value(v));
            }
            Value::Object(m)
        }
        other => other,
    }
}

/// Rounds every float field of `t` to [`SIG_FIGS`] (a serde round trip).
/// cite: n/a output formatting, no physics
pub fn rounded<T: Serialize + DeserializeOwned>(t: T) -> T {
    let Ok(mut v) = serde_json::to_value(&t) else {
        return t;
    };
    round_value(&mut v);
    serde_json::from_value(v).unwrap_or(t)
}

/// Pretty, key-sorted JSON with rounded floats and a trailing newline.
/// cite: n/a output formatting, no physics
pub fn canonical_json<T: Serialize>(t: &T) -> String {
    let mut v = serde_json::to_value(t).unwrap_or(Value::Null);
    round_value(&mut v);
    let mut s = serde_json::to_string_pretty(&sort_value(v)).unwrap_or_default();
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_to_significant_figures() {
        assert_eq!(round_sig(0.123_456_789, 6), 0.123_457);
        assert_eq!(round_sig(123_456.789, 6), 123_457.0);
        assert_eq!(round_sig(-1.0e-9 * 1.234_567_8, 6), -1.234_57e-9);
        assert_eq!(round_sig(-0.0, 6), 0.0);
        assert_eq!(round_sig(f64::NAN, 6), 0.0);
        assert!(round_sig(-0.0, 6).is_sign_positive());
    }

    #[test]
    fn sorts_keys_recursively() {
        let v = serde_json::json!({"b": 1, "a": {"d": 0.333_333_333, "c": [2, {"z": 1, "y": 2}]}});
        let s = canonical_json(&v);
        let a = s.find("\"a\"").unwrap();
        let b = s.find("\"b\"").unwrap();
        assert!(a < b);
        assert!(s.find("\"c\"").unwrap() < s.find("\"d\"").unwrap());
        assert!(s.find("\"y\"").unwrap() < s.find("\"z\"").unwrap());
        assert!(s.contains("0.333333"));
        assert!(!s.contains("0.3333333"));
    }
}
