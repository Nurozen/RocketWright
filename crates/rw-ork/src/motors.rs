//! Motor resolution for imported configurations: a curve embedded in the
//! file, else a local cache entry, else the nearest built-in generic curve.

use std::collections::BTreeMap;

use rw_model::MotorResolution;
use rw_motor::{MotorSource, ThrustCurve};

use crate::util::file_stem;
use crate::{MotorCache, MotorKey, OrkFiles};

fn parse(path: &str, bytes: &[u8], source: MotorSource) -> Vec<ThrustCurve> {
    let text = String::from_utf8_lossy(bytes);
    let lower = path.to_ascii_lowercase();
    let r = if lower.ends_with(".eng") {
        rw_motor::parse_eng(&text, source)
    } else {
        rw_motor::parse_rse(&text, source)
    };
    r.unwrap_or_default()
}

fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Designation equality, ignoring case, spaces, and a delay suffix.
fn same_designation(a: &str, b: &str) -> bool {
    let strip = |s: &str| {
        let n = norm(s);
        match n.rsplit_once('-') {
            Some((h, t))
                if !t.is_empty()
                    && t.len() <= 3
                    && t.chars().all(|c| c.is_ascii_alphanumeric()) =>
            {
                h.to_string()
            }
            _ => n,
        }
    };
    norm(a) == norm(b) || strip(a) == strip(b)
}

fn same_maker(a: Option<&str>, b: Option<&str>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => {
            let (a, b) = (norm(a), norm(b));
            a.is_empty() || b.is_empty() || a.contains(&b) || b.contains(&a)
        }
        _ => true,
    }
}

/// True when `c` is the motor `key` names (designation ignoring case,
/// spaces, and a delay suffix; manufacturer when both name one).
pub fn matches(c: &ThrustCurve, key: &MotorKey) -> bool {
    same_designation(&c.designation, &key.designation)
        && same_maker(c.manufacturer.as_deref(), key.manufacturer.as_deref())
}

/// Resolves motors, writing each used curve once under `lib/motors/`.
pub(crate) struct Resolver<'a> {
    embedded: Vec<(String, Vec<u8>, Vec<ThrustCurve>)>,
    cache: &'a dyn MotorCache,
    pub files: BTreeMap<String, Vec<u8>>,
    memo: BTreeMap<String, (Option<String>, MotorResolution)>,
}

impl<'a> Resolver<'a> {
    pub fn new(files: &OrkFiles, cache: &'a dyn MotorCache) -> Self {
        let embedded = files
            .files
            .iter()
            .filter(|(p, _)| {
                let l = p.to_ascii_lowercase();
                l.ends_with(".rse") || l.ends_with(".eng")
            })
            .map(|(p, b)| {
                let curves = parse(p, b, MotorSource::Embedded { origin: p.clone() });
                (p.clone(), b.clone(), curves)
            })
            .collect();
        Resolver {
            embedded,
            cache,
            files: BTreeMap::new(),
            memo: BTreeMap::new(),
        }
    }

    /// Writes `bytes` under `lib/motors/` (reusing an identical file) and
    /// returns the motor ref for `curve`; a byte-identical generic curve is
    /// referenced as `generic:<id>`.
    fn store(&mut self, key: &MotorKey, ext: &str, bytes: &[u8], curve: &ThrustCurve) -> String {
        if let Some(g) = rw_motor::generic::generic_motors()
            .into_iter()
            .find(|g| g.sha256 == curve.sha256)
            && let MotorSource::Generic { id } = g.source
        {
            return format!("generic:{id}");
        }
        let stem = file_stem(&match &key.manufacturer {
            Some(m) => format!(
                "{}_{}",
                m.split_whitespace().next().unwrap_or(m),
                curve.designation
            ),
            None => curve.designation.clone(),
        });
        let mut n = 1;
        let path = loop {
            let p = if n == 1 {
                format!("lib/motors/{stem}.{ext}")
            } else {
                format!("lib/motors/{stem}_{n}.{ext}")
            };
            match self.files.get(&p) {
                Some(b) if b != bytes => n += 1,
                _ => break p,
            }
        };
        self.files.insert(path.clone(), bytes.to_vec());
        let rel = path.strip_prefix("lib/").unwrap_or(&path);
        format!("lib:{rel}#{}", curve.designation)
    }

    fn ext(path: &str) -> &'static str {
        if path.to_ascii_lowercase().ends_with(".eng") {
            "eng"
        } else {
            "rse"
        }
    }

    /// The motor ref for `key` and how it was resolved (`None` when not even
    /// a generic curve fits).
    pub fn resolve(&mut self, key: &MotorKey) -> (Option<String>, MotorResolution) {
        let memo_key = format!(
            "{}|{}|{}",
            key.manufacturer.as_deref().unwrap_or(""),
            key.designation,
            key.digest.as_deref().unwrap_or("")
        );
        if let Some(r) = self.memo.get(&memo_key) {
            return r.clone();
        }
        let r = self.resolve_uncached(key);
        self.memo.insert(memo_key, r.clone());
        r
    }

    fn resolve_uncached(&mut self, key: &MotorKey) -> (Option<String>, MotorResolution) {
        // 1. Embedded: by digest file name, then by designation.
        let by_digest = key.digest.as_deref().and_then(|d| {
            self.embedded.iter().find(|(p, _, c)| {
                !c.is_empty()
                    && p.rsplit('/')
                        .next()
                        .and_then(|f| f.rsplit_once('.'))
                        .is_some_and(|(stem, _)| stem.eq_ignore_ascii_case(d))
            })
        });
        let hit = by_digest
            .map(|(p, b, c)| {
                let curve = c.iter().find(|x| matches(x, key)).unwrap_or(&c[0]);
                (p.clone(), b.clone(), curve.clone())
            })
            .or_else(|| {
                self.embedded.iter().find_map(|(p, b, c)| {
                    c.iter()
                        .find(|x| matches(x, key))
                        .map(|x| (p.clone(), b.clone(), x.clone()))
                })
            });
        if let Some((p, b, curve)) = hit {
            let r = self.store(key, Self::ext(&p), &b, &curve);
            return (Some(r), MotorResolution::Embedded);
        }
        // 2. The local cache.
        if let Some(m) = self.cache.lookup(key) {
            let curves = parse(
                &m.file_name,
                &m.bytes,
                MotorSource::Thrustcurve {
                    motor_id: m.file_name.clone(),
                },
            );
            if let Some(curve) = curves
                .iter()
                .find(|x| matches(x, key))
                .or(curves.first())
                .cloned()
            {
                let r = self.store(key, Self::ext(&m.file_name), &m.bytes, &curve);
                return (Some(r), MotorResolution::Cache);
            }
        }
        // 3. The nearest generic curve.
        let class = rw_motor::class::parse_designation(&key.designation)
            .map(|d| d.class)
            .unwrap_or_else(|| "C".to_string());
        let g = rw_motor::generic::nearest_generic(&class, key.diameter.unwrap_or(0.018));
        let r = g.and_then(|g| match g.source {
            MotorSource::Generic { id } => Some(format!("generic:{id}")),
            _ => None,
        });
        (r, MotorResolution::Substituted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn designations_match_loosely() {
        assert!(same_designation("C6-3", "c6"));
        assert!(same_designation("H128W", "H128W-M"));
        assert!(!same_designation("C6", "C11"));
        assert!(same_maker(Some("Estes Industries"), Some("Estes")));
        assert!(!same_maker(Some("Aerotech"), Some("Estes")));
    }
}
