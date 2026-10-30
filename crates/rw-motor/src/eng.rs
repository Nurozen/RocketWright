//! RASP `.eng` reader.
//!
//! Layout: `;` comment lines anywhere; per motor a header line
//! `name diameter_mm length_mm delays prop_kg total_kg manufacturer...`
//! followed by `t F` rows (s, N). A row whose first token is not a number
//! starts the next motor. Delays are `-`-separated seconds, or `P` (plugged).

use crate::curve::{Header, build, err, sha256_hex};
use crate::types::{MotorError, MotorSource, ThrustCurve, ThrustPoint};

pub(crate) fn parse(text: &str, source: MotorSource) -> Result<Vec<ThrustCurve>, MotorError> {
    let sha = sha256_hex(text.as_bytes());
    let mut out = Vec::new();
    let mut cur: Option<(Header, u32, Vec<ThrustPoint>)> = None;
    for (idx, raw) in text.lines().enumerate() {
        let line_no = u32::try_from(idx + 1).unwrap_or(u32::MAX);
        // A `;` starts a comment anywhere on the line.
        let body = raw.split(';').next().unwrap_or("").trim();
        if body.is_empty() {
            continue;
        }
        let toks: Vec<&str> = body.split_whitespace().collect();
        if toks[0].parse::<f64>().is_ok() {
            let Some((_, _, pts)) = cur.as_mut() else {
                return Err(err(line_no, "data row before any motor header"));
            };
            if !toks.len().is_multiple_of(2) {
                return Err(err(line_no, "expected `time thrust` pairs"));
            }
            for pair in toks.chunks_exact(2) {
                let t = num(pair[0], line_no, "time")?;
                let thrust = num(pair[1], line_no, "thrust")?;
                pts.push(ThrustPoint {
                    t,
                    thrust,
                    mass: None,
                    cg: None,
                });
            }
        } else {
            if let Some((h, l, pts)) = cur.take() {
                out.push(build(h, pts, l, &sha, &source)?);
            }
            cur = Some((header(&toks, line_no)?, line_no, Vec::new()));
        }
    }
    if let Some((h, l, pts)) = cur.take() {
        out.push(build(h, pts, l, &sha, &source)?);
    }
    if out.is_empty() {
        return Err(err(0, "no motor header found"));
    }
    Ok(out)
}

fn num(tok: &str, line: u32, what: &str) -> Result<f64, MotorError> {
    tok.parse::<f64>()
        .map_err(|_| err(line, format!("{what}: `{tok}` is not a number")))
}

fn header(toks: &[&str], line: u32) -> Result<Header, MotorError> {
    if toks.len() < 6 {
        return Err(err(
            line,
            "header needs `name diameter length delays prop_mass total_mass [manufacturer]`",
        ));
    }
    let manufacturer = (toks.len() > 6).then(|| toks[6..].join(" "));
    Ok(Header {
        designation: toks[0].to_string(),
        manufacturer,
        diameter: num(toks[1], line, "diameter")? / 1000.0,
        length: num(toks[2], line, "length")? / 1000.0,
        delays: parse_delays(toks[3], line)?,
        prop_mass: num(toks[4], line, "propellant mass")?,
        total_mass: num(toks[5], line, "total mass")?,
    })
}

/// `3-5-7` / `3,5,7` → seconds; `P` / `plugged` / `none` entries are dropped.
pub(crate) fn parse_delays(s: &str, line: u32) -> Result<Vec<f64>, MotorError> {
    let mut out = Vec::new();
    for tok in s.split(['-', ',']).map(str::trim).filter(|t| !t.is_empty()) {
        if ["p", "plugged", "none"].contains(&tok.to_ascii_lowercase().as_str()) {
            continue;
        }
        let d = num(tok, line, "delay")?;
        if !(d.is_finite() && d >= 0.0) {
            return Err(err(line, format!("delay `{tok}` is negative")));
        }
        out.push(d);
    }
    Ok(out)
}
