//! Wall-clock time for history steps. `RW_CLOCK` pins it (D10 seed scripts,
//! deterministic tests): an RFC 3339 UTC time (`2026-10-15T14:04:00Z`) or
//! Unix seconds. Without it, the system clock.

/// Environment variable that pins the clock.
pub const RW_CLOCK: &str = "RW_CLOCK";

/// `(unix seconds, RFC 3339 UTC)` now, or as pinned by `RW_CLOCK`.
pub fn now() -> (i64, String) {
    let secs = std::env::var(RW_CLOCK)
        .ok()
        .and_then(|v| parse(&v))
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        });
    (secs, rfc3339(secs))
}

/// Parses Unix seconds or `YYYY-MM-DDTHH:MM:SSZ`.
pub fn parse(v: &str) -> Option<i64> {
    let v = v.trim();
    if let Ok(n) = v.parse::<i64>() {
        return Some(n);
    }
    let b = v.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| v.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s)
}

/// RFC 3339 UTC with second precision.
pub fn rfc3339(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

// Howard Hinnant's days-from-civil algorithms (public domain).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        for s in [0, 1_700_000_000, 1_791_900_240, 951_782_400] {
            assert_eq!(parse(&rfc3339(s)), Some(s), "{}", rfc3339(s));
        }
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            parse("2026-10-15T14:04:00Z").map(rfc3339).unwrap(),
            "2026-10-15T14:04:00Z"
        );
        assert_eq!(parse("1700000000"), Some(1_700_000_000));
        assert_eq!(parse("yesterday"), None);
    }
}
