//! The built-in offline generic motor library: the RocketWright-authored
//! `.rse` curves in `lib/motors/generic/` (M1.36a A-C 18 mm; M2.4a D 24 mm
//! and I 38 mm; recipe and hashes in its `PROVENANCE.md`), embedded at compile time so `rw motor search` works with
//! no filesystem or network access.

use crate::types::{MotorSource, ThrustCurve};

/// Ids of the built-in generic motors, smallest impulse first.
pub const GENERIC_IDS: [&str; 7] = [
    "RW_A8G",
    "RW_B4G",
    "RW_C6G",
    "RW_D10G",
    "RW_I261G",
    "RW_I1294G",
    "RW_I60G",
];

macro_rules! embedded {
    ($f:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../lib/motors/generic/",
            $f
        ))
    };
}

/// `.rse` text of each generic motor, keyed like [`GENERIC_IDS`].
const GENERIC_RSE: [(&str, &str); 7] = [
    ("RW_A8G", embedded!("RW_A8G.rse")),
    ("RW_B4G", embedded!("RW_B4G.rse")),
    ("RW_C6G", embedded!("RW_C6G.rse")),
    ("RW_D10G", embedded!("RW_D10G.rse")),
    ("RW_I261G", embedded!("RW_I261G.rse")),
    ("RW_I1294G", embedded!("RW_I1294G.rse")),
    ("RW_I60G", embedded!("RW_I60G.rse")),
];

/// The embedded `.rse` source of a generic motor (for export and digests).
///
/// cite: n/a embedded data lookup, no physics
pub fn generic_source(id: &str) -> Option<&'static str> {
    GENERIC_RSE
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(id))
        .map(|(_, text)| *text)
}

/// Parses one generic motor by id (`RW_C6G`, case-insensitive; a
/// `generic:` prefix is accepted).
///
/// cite: n/a embedded data lookup, no physics
pub fn generic_motor(id: &str) -> Option<ThrustCurve> {
    let id = id.strip_prefix("generic:").unwrap_or(id);
    let (key, text) = GENERIC_RSE
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(id))?;
    let source = MotorSource::Generic {
        id: (*key).to_string(),
    };
    // The embedded files are verified by `tests/generic_files.rs`.
    crate::parse_rse(text, source).ok()?.into_iter().next()
}

/// Every generic motor, smallest impulse first.
///
/// cite: n/a embedded data lookup, no physics
pub fn generic_motors() -> Vec<ThrustCurve> {
    GENERIC_IDS
        .iter()
        .filter_map(|id| generic_motor(id))
        .collect()
}

/// Filters for [`search_generic`]. Unset fields match everything. SI units.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MotorQuery {
    /// Case-insensitive substring of the designation or manufacturer.
    pub query: Option<String>,
    /// Impulse class (`C`, `1/2A`), case-insensitive.
    pub class: Option<String>,
    /// Motor diameter (m), matched within 0.5 mm.
    pub diameter: Option<f64>,
    /// Inclusive total-impulse range (N s).
    pub min_impulse: Option<f64>,
    pub max_impulse: Option<f64>,
}

/// Diameter match tolerance (m).
const DIAMETER_TOL: f64 = 0.5e-3;

impl MotorQuery {
    /// Whether `m` satisfies every set filter.
    ///
    /// cite: n/a search filter, no physics
    pub fn matches(&self, m: &ThrustCurve) -> bool {
        let text_ok = self.query.as_deref().is_none_or(|q| {
            let q = q.trim().to_ascii_lowercase();
            m.designation.to_ascii_lowercase().contains(&q)
                || m.manufacturer
                    .as_deref()
                    .is_some_and(|mf| mf.to_ascii_lowercase().contains(&q))
        });
        let class_ok = self
            .class
            .as_deref()
            .is_none_or(|c| c.trim().eq_ignore_ascii_case(&m.class));
        let dia_ok = self
            .diameter
            .is_none_or(|d| (d - m.diameter).abs() <= DIAMETER_TOL);
        let lo_ok = self.min_impulse.is_none_or(|lo| m.total_impulse >= lo);
        let hi_ok = self.max_impulse.is_none_or(|hi| m.total_impulse <= hi);
        text_ok && class_ok && dia_ok && lo_ok && hi_ok
    }
}

/// Generic motors matching `q`, smallest impulse first (`rw motor search`
/// offline backend).
///
/// cite: n/a search filter, no physics
pub fn search_generic(q: &MotorQuery) -> Vec<ThrustCurve> {
    generic_motors()
        .into_iter()
        .filter(|m| q.matches(m))
        .collect()
}

/// The generic motor to substitute for an unresolved motor of `class` and
/// `diameter` (m): same class if one exists, otherwise the nearest class by
/// total impulse; ties go to the closer diameter (`RW-W1xx motor-substituted`).
///
/// cite: n/a nearest-neighbour lookup over class and diameter, no physics
pub fn nearest_generic(class: &str, diameter: f64) -> Option<ThrustCurve> {
    let (lo, hi) = crate::class::class_bounds(class)?;
    let target = (lo + hi) / 2.0;
    let key = |m: &ThrustCurve| {
        let same = m.class.eq_ignore_ascii_case(class.trim());
        let impulse_gap = (m.total_impulse / target).ln().abs();
        (!same, impulse_gap, (m.diameter - diameter).abs())
    };
    generic_motors().into_iter().min_by(|a, b| {
        key(a)
            .partial_cmp(&key(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    })
}
