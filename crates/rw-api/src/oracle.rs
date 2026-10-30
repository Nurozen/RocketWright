//! IF8 oracle files (`tests/oracle/*.json`, R5.3). Every file the oracle
//! exports must validate against `schema/oracle-golden.json`: numbers plus
//! component names, unknown keys rejected, no string over 200 characters.
//! The kinds map to the allowlist (`tests/oracle/allowlist.txt`):
//!
//! | file | kind |
//! |---|---|
//! | `case<n>-generic.json`, `case<n>-original.json` | `golden` |
//! | `case<n>-generic.series.json` | `series` |
//! | `case<n>.aero_sweep.json` | `aero_sweep` |
//! | `case<n>.geometry.json` | `geometry` |
//! | `case<n>.provenance.json` | `provenance` |
//!
//! The M1.16 scorer rejects a golden before any tolerance scoring when its
//! `geometry_sha256`, `conditions_hash`, `config_id`, `sim_name`, or
//! `motor_digest` differ from our run's (D25).

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use rw_model::{ComponentType, Conditions, SchemaTag};

/// Longest string allowed anywhere in an oracle file.
pub const ORACLE_MAX_STRING: u64 = 200;

/// Pattern of a conditions hash: `sha256:<64 hex>`.
pub const CONDITIONS_HASH_PATTERN: &str = "^sha256:[0-9a-f]{64}$";

const SHA256_PATTERN: &str = "^[0-9a-f]{64}$";

/// Any file under `tests/oracle/` (tag `kind`).
#[allow(clippy::large_enum_variant)] // wire DTO
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OracleFile {
    Golden(OracleGolden),
    Series(OracleSeries),
    AeroSweep(OracleAeroSweep),
    Geometry(OracleGeometry),
    Provenance(OracleProvenance),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Matrix {
    /// Generic-curve variant (the B2 gate).
    Generic,
    /// The unmodified example; summary keys only, no series (import check).
    Original,
}

/// A golden: OpenRocket's numbers for one case, sim, and configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleGolden {
    pub schema: SchemaTag,
    pub case: u32,
    pub matrix: Matrix,
    /// The simulation's name, verbatim.
    pub sim_name: String,
    /// The flight configuration id, verbatim.
    pub config_id: String,
    /// sha256 hex of the `case<n>.geometry.json` bytes.
    #[schemars(extend("pattern" = SHA256_PATTERN))]
    pub geometry_sha256: String,
    pub conditions: Conditions,
    /// [`conditions_hash`] of `conditions`.
    #[schemars(extend("pattern" = CONDITIONS_HASH_PATTERN))]
    pub conditions_hash: String,
    /// [`motor_digest`] over `motors`.
    #[schemars(extend("pattern" = SHA256_PATTERN))]
    pub motor_digest: String,
    pub motors: Vec<OracleMotor>,
    /// Summary in the oracle's key names (S:177 left side).
    pub summary: OracleSummary,
    /// Static block at liftoff (absent in `original` goldens).
    #[serde(rename = "static", default, skip_serializing_if = "Option::is_none")]
    pub static_block: Option<OracleStatic>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<OracleEvent>,
    /// Per-component mass, CG, CNα, CP (D9).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<OracleComponent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleMotor {
    /// Mount component name.
    pub mount: String,
    pub designation: String,
    /// sha256 hex of the curve file used.
    #[schemars(extend("pattern" = SHA256_PATTERN))]
    pub digest: String,
    pub delay_s: Option<f64>,
}

/// Oracle summary keys. Map to `RunSummary` via `tests/oracle/keymap.json`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleSummary {
    pub max_altitude_m: Option<f64>,
    pub max_velocity_ms: Option<f64>,
    pub max_accel_ms2: Option<f64>,
    pub max_mach: Option<f64>,
    pub time_to_apogee_s: Option<f64>,
    pub flight_time_s: Option<f64>,
    pub ground_hit_velocity_ms: Option<f64>,
    pub rod_clear_velocity_ms: Option<f64>,
    pub deployment_velocity_ms: Option<f64>,
    pub optimum_delay_s: Option<f64>,
}

/// Static block: maps to `mass.cg`, `aero.cp`, `aero.cna`, `stability.liftoff`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleStatic {
    pub cg_m: f64,
    pub cp_m: f64,
    pub cna: f64,
    pub stability_cal: f64,
    pub mass_kg: f64,
    pub ref_diameter_m: f64,
    pub mach: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OracleEventKind {
    Ignition,
    Liftoff,
    LaunchRodClearance,
    Burnout,
    EjectionCharge,
    Apogee,
    StageSeparation,
    RecoveryDeviceDeployment,
    GroundHit,
    SimulationEnd,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleEvent {
    pub kind: OracleEventKind,
    pub t_s: f64,
    pub altitude_m: Option<f64>,
    pub velocity_ms: Option<f64>,
    /// Name of the released stage whose branch the event belongs to (a
    /// booster after separation); absent on the main (sustainer) branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleComponent {
    pub name: String,
    pub mass_kg: f64,
    pub cg_m: f64,
    pub cna: Option<f64>,
    pub cp_m: Option<f64>,
}

/// `case<n>-generic.series.json`: 0.05 s series (generic-curve variants only).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleSeries {
    pub schema: SchemaTag,
    pub case: u32,
    pub sim_name: String,
    pub config_id: String,
    #[schemars(extend("pattern" = CONDITIONS_HASH_PATTERN))]
    pub conditions_hash: String,
    pub dt_s: f64,
    /// Column names with units in the name (`time_s`, `altitude_m`).
    pub columns: Vec<String>,
    /// One row per step, one cell per column. A cell is `null` where the
    /// oracle has no value at that step (CP, stability, angle of attack
    /// before liftoff or at zero airspeed).
    pub rows: Vec<Vec<Option<f64>>>,
    /// Series of the released stages (booster branches), same columns.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub branches: Vec<OracleSeriesBranch>,
}

/// One released stage's series in an [`OracleSeries`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleSeriesBranch {
    /// The released stage's name, verbatim.
    pub branch: String,
    /// Rows in the parent's `columns`, from the separation on.
    pub rows: Vec<Vec<Option<f64>>>,
}

/// `case<n>.aero_sweep.json`: CD breakdown, CNα, CP over Mach 0.05-0.9 (D9).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleAeroSweep {
    pub schema: SchemaTag,
    pub case: u32,
    pub config_id: String,
    pub alpha_deg: f64,
    pub points: Vec<AeroSweepPoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AeroSweepPoint {
    pub mach: f64,
    pub cd_total: f64,
    pub cd_friction: f64,
    pub cd_pressure: f64,
    pub cd_base: f64,
    pub cna: f64,
    pub cp_m: f64,
    /// Optional per-component breakdown at this Mach (D9). Absent or empty
    /// when the oracle exports only totals.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<AeroSweepComponent>,
}

/// One component's share of an [`AeroSweepPoint`]. A term is `null` where
/// the component has none (a body tube has no CNα of its own, so no CP).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AeroSweepComponent {
    /// Component name, as in `case<n>.geometry.json`.
    pub name: String,
    pub cd_total: Option<f64>,
    pub cd_friction: Option<f64>,
    pub cd_pressure: Option<f64>,
    pub cd_base: Option<f64>,
    pub cna: Option<f64>,
    pub cp_m: Option<f64>,
}

/// `case<n>.geometry.json`: component tree in SI so builders can author
/// fixtures without the GUI (R5.3). Kinds use RocketWright's vocabulary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleGeometry {
    pub schema: SchemaTag,
    pub case: u32,
    pub name: String,
    pub components: Vec<OracleGeomComponent>,
    pub configurations: Vec<OracleConfiguration>,
    pub sims: Vec<OracleSimRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleGeomComponent {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: ComponentType,
    pub parent: Option<String>,
    /// Fore station from the nose tip.
    pub x_fore_m: f64,
    pub length_m: f64,
    /// Numeric fields in SI with the unit in the key (`od_m`, `thickness_m`,
    /// `sweep_m`, `count`, `cd`, `mass_kg`, `density_kgm3`, `roughness_m`).
    pub fields: BTreeMap<String, f64>,
    pub material: Option<String>,
    /// Shape keyword where the kind has one (`ogive`, `conical`, ...).
    pub shape: Option<String>,
    pub mass_override_kg: Option<f64>,
    pub cg_override_m: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleConfiguration {
    pub id: String,
    pub name: String,
    pub motors: Vec<OracleMotor>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleSimRef {
    pub name: String,
    pub config_id: String,
    pub conditions: Conditions,
    #[schemars(extend("pattern" = CONDITIONS_HASH_PATTERN))]
    pub conditions_hash: String,
}

/// `case<n>.provenance.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OracleProvenance {
    pub schema: SchemaTag,
    pub case: u32,
    /// Example file name the case came from.
    pub source_example: String,
    pub openrocket_version: String,
    /// Oracle harness commit (its own repo, D17).
    pub harness_commit: String,
    /// Generic curve substituted in the variant, e.g. `RW_C6G`.
    pub generic_motor: Option<String>,
    /// Exported file name → sha256 hex.
    pub files: BTreeMap<String, String>,
}

/// `sha256:<hex>` of the RFC 8785 (JCS) canonical JSON of `conditions`:
/// keys sorted by UTF-16 code units (ASCII here), no whitespace, numbers in
/// ECMAScript shortest form (`0.05`, `101325`, `1e-7`, `1e+21`).
pub fn conditions_hash(conditions: &Conditions) -> String {
    let v = serde_json::to_value(conditions).expect("conditions serialize");
    let mut out = String::new();
    jcs(&v, &mut out);
    let digest = Sha256::digest(out.as_bytes());
    format!("sha256:{}", hex(&digest))
}

/// sha256 hex over the sorted motor digests joined by `\n` (one motor: the
/// sha256 of that single digest string).
pub fn motor_digest(motors: &[OracleMotor]) -> String {
    let mut ds: Vec<&str> = motors.iter().map(|m| m.digest.as_str()).collect();
    ds.sort_unstable();
    hex(&Sha256::digest(ds.join("\n").as_bytes()))
}

/// The JCS canonical form of a JSON value (exposed for tests and tools).
pub fn canonical_json(v: &serde_json::Value) -> String {
    let mut out = String::new();
    jcs(v, &mut out);
    out
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

fn jcs(v: &serde_json::Value, out: &mut String) {
    use serde_json::Value;
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&jcs_number(n)),
        Value::String(s) => out.push_str(&serde_json::to_string(s).expect("string")),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                jcs(x, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).expect("key"));
                out.push(':');
                jcs(&m[k], out);
            }
            out.push('}');
        }
    }
}

/// ECMAScript `Number.prototype.toString` for finite doubles.
fn jcs_number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let x = n.as_f64().unwrap_or(0.0);
    if x == 0.0 {
        return "0".into();
    }
    let a = x.abs();
    if (1e-6..1e21).contains(&a) {
        // Rust's Display is shortest round-trip without an exponent.
        return format!("{x}");
    }
    // Shortest digits in exponent form; ES writes `e+` for positive exponents.
    let s = format!("{x:e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jcs_numbers_match_ecmascript() {
        let cases = [
            (json!(0.05), "0.05"),
            (json!(101325.0), "101325"),
            (json!(-0.0), "0"),
            (json!(1e-7), "1e-7"),
            (json!(1e21), "1e+21"),
            (json!(288.15), "288.15"),
            (json!(3), "3"),
        ];
        for (v, want) in cases {
            assert_eq!(canonical_json(&v), want, "{v}");
        }
    }

    #[test]
    fn jcs_sorts_keys_without_whitespace() {
        let v = json!({"b": 1, "a": [true, null, "x"], "c": {"z": 0.5, "y": 2}});
        assert_eq!(
            canonical_json(&v),
            r#"{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":0.5}}"#
        );
    }
}
