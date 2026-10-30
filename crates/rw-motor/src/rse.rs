//! RockSim `.rse` reader: a small tolerant XML tag scanner (comments,
//! processing instructions, CDATA, and DOCTYPE are skipped) that collects
//! `<engine>` start tags and their `<eng-data>` rows.
//!
//! Attribute names match case-insensitively. Units: `dia`/`len` mm,
//! `initWt`/`propWt` g, `t` s, `f` N, `m` g (total motor mass), `cg` mm.

use crate::curve::{Header, build, err, sha256_hex};
use crate::eng::parse_delays;
use crate::types::{MotorError, MotorSource, ThrustCurve, ThrustPoint};

struct Tag {
    name: String,
    closing: bool,
    attrs: Vec<(String, String)>,
    line: u32,
}

impl Tag {
    fn get(&self, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
    }

    fn num(&self, key: &str) -> Result<Option<f64>, MotorError> {
        match self.get(key).map(str::trim) {
            None | Some("") => Ok(None),
            Some(v) => v.parse::<f64>().map(Some).map_err(|_| {
                err(
                    self.line,
                    format!("<{}> {key}=\"{v}\" is not a number", self.name),
                )
            }),
        }
    }

    fn req(&self, key: &str) -> Result<f64, MotorError> {
        self.num(key)?.ok_or_else(|| {
            err(
                self.line,
                format!("<{}> lacks attribute `{key}`", self.name),
            )
        })
    }
}

pub(crate) fn parse(text: &str, source: MotorSource) -> Result<Vec<ThrustCurve>, MotorError> {
    let sha = sha256_hex(text.as_bytes());
    let mut out = Vec::new();
    let mut cur: Option<(Tag, Vec<ThrustPoint>)> = None;
    for tag in scan(text)? {
        match (tag.name.to_ascii_lowercase().as_str(), tag.closing) {
            ("engine", false) => {
                if let Some((h, pts)) = cur.take() {
                    out.push(finish(&h, pts, &sha, &source)?);
                }
                cur = Some((tag, Vec::new()));
            }
            ("engine", true) => {
                if let Some((h, pts)) = cur.take() {
                    out.push(finish(&h, pts, &sha, &source)?);
                }
            }
            ("eng-data", false) => {
                let Some((_, pts)) = cur.as_mut() else {
                    return Err(err(tag.line, "<eng-data> outside <engine>"));
                };
                pts.push(ThrustPoint {
                    t: tag.req("t")?,
                    thrust: tag.req("f")?,
                    mass: tag.num("m")?.map(|g| g / 1000.0),
                    cg: tag.num("cg")?.map(|mm| mm / 1000.0),
                });
            }
            _ => {}
        }
    }
    if let Some((h, pts)) = cur.take() {
        out.push(finish(&h, pts, &sha, &source)?);
    }
    if out.is_empty() {
        return Err(err(0, "no <engine> element found"));
    }
    Ok(out)
}

fn finish(
    h: &Tag,
    pts: Vec<ThrustPoint>,
    sha: &str,
    source: &MotorSource,
) -> Result<ThrustCurve, MotorError> {
    let line = h.line;
    let designation = h
        .get("code")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| err(line, "<engine> lacks attribute `code`"))?
        .to_string();
    let manufacturer = h
        .get("mfg")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let masses: Option<Vec<f64>> = pts.iter().map(|p| p.mass).collect();
    let (m_first, m_last) = match masses.as_deref() {
        Some([first, .., last]) => (Some(*first), Some(*last)),
        Some([only]) => (Some(*only), Some(*only)),
        _ => (None, None),
    };
    // Header masses (g) win; otherwise fall back to the `m` column.
    let total_mass = match (h.num("initWt")?, m_first) {
        (Some(g), _) => g / 1000.0,
        (None, Some(m0)) => m0,
        (None, None) => {
            return Err(err(
                line,
                format!("{designation}: no initWt and no `m` column"),
            ));
        }
    };
    let prop_mass = match (h.num("propWt")?, m_first.zip(m_last)) {
        (Some(g), _) => g / 1000.0,
        (None, Some((m0, m1))) => m0 - m1,
        (None, None) => {
            return Err(err(
                line,
                format!("{designation}: no propWt and no `m` column"),
            ));
        }
    };
    let header = Header {
        designation,
        manufacturer,
        diameter: h.req("dia")? / 1000.0,
        length: h.num("len")?.unwrap_or(0.0) / 1000.0,
        delays: parse_delays(h.get("delays").unwrap_or(""), line)?,
        prop_mass,
        total_mass,
    };
    build(header, pts, line, sha, source)
}

/// Every element tag in document order (start, empty, and end tags).
fn scan(text: &str) -> Result<Vec<Tag>, MotorError> {
    let mut tags = Vec::new();
    let mut line: u32 = 1;
    let mut rest = text;
    while let Some(lt) = rest.find('<') {
        line += count_lines(&rest[..lt]);
        rest = &rest[lt..];
        let skip = [
            ("<!--", "-->"),
            ("<![CDATA[", "]]>"),
            ("<?", "?>"),
            ("<!", ">"),
        ]
        .into_iter()
        .find(|(open, _)| rest.starts_with(open));
        if let Some((open, close)) = skip {
            let end = rest[open.len()..]
                .find(close)
                .ok_or_else(|| err(line, format!("unterminated `{open}`")))?
                + open.len()
                + close.len();
            line += count_lines(&rest[..end]);
            rest = &rest[end..];
            continue;
        }
        let end = tag_end(rest).ok_or_else(|| err(line, "unterminated tag"))?;
        let inner = &rest[1..end];
        tags.push(parse_tag(inner, line)?);
        line += count_lines(&rest[..=end]);
        rest = &rest[end + 1..];
    }
    Ok(tags)
}

fn count_lines(s: &str) -> u32 {
    u32::try_from(s.bytes().filter(|&b| b == b'\n').count()).unwrap_or(u32::MAX)
}

/// Byte index of the `>` closing the tag that starts `s`, honoring quotes.
fn tag_end(s: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    for (i, c) in s.char_indices().skip(1) {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '>') => return Some(i),
            (None, '<') => return None,
            _ => {}
        }
    }
    None
}

fn parse_tag(inner: &str, line: u32) -> Result<Tag, MotorError> {
    let (closing, body) = match inner.strip_prefix('/') {
        Some(b) => (true, b),
        None => (false, inner.strip_suffix('/').unwrap_or(inner)),
    };
    let body = body.trim();
    let name_end = body.find(|c: char| c.is_whitespace()).unwrap_or(body.len());
    let name = body[..name_end].to_string();
    if name.is_empty() {
        return Err(err(line, "empty tag name"));
    }
    let mut attrs = Vec::new();
    let mut rest = body[name_end..].trim_start();
    while !rest.is_empty() {
        let eq = rest
            .find('=')
            .ok_or_else(|| err(line, format!("<{name}>: attribute without `=`")))?;
        let key = rest[..eq].trim().to_string();
        let after = rest[eq + 1..].trim_start();
        let q = after
            .chars()
            .next()
            .filter(|c| *c == '"' || *c == '\'')
            .ok_or_else(|| err(line, format!("<{name}> {key}: unquoted value")))?;
        let close = after[1..]
            .find(q)
            .ok_or_else(|| err(line, format!("<{name}> {key}: unterminated value")))?;
        attrs.push((key, unescape(&after[1..1 + close])));
        rest = after[close + 2..].trim_start();
    }
    Ok(Tag {
        name,
        closing,
        attrs,
        line,
    })
}

/// Decodes the five predefined XML entities and numeric character references.
fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let Some(semi) = rest.find(';') else { break };
        let ent = &rest[1..semi];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => ent
                .strip_prefix("#x")
                .or_else(|| ent.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| ent.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}
