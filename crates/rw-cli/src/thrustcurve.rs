//! The opt-in ThrustCurve client: RocketWright's only network access, and
//! only when the user asks (`rw motor thrustcurve search|fetch`, the
//! `thrustcurve_search` and `thrustcurve_fetch` tools, Configurations >
//! Motors > Search ThrustCurve). It speaks thrustcurve.org's public JSON API
//! (`POST /api/v1/search.json`, `POST /api/v1/download.json`).
//!
//! The session never touches the network: a fetch downloads here, outside the
//! session lock, then hands the bytes to `Session::import_motor_bytes`, the
//! same path as `rw motor import` (sha256 in `[lib.sha256]`, refs
//! `lib:motors/<file>#<designation>`), plus a `[lib.source]` record naming
//! ThrustCurve, the motor and data file ids, the page URL, and the time.
//! Downloaded files are the user's own; RocketWright never bundles them.
//!
//! `RW_THRUSTCURVE_URL` overrides the endpoint (tests point it at a local
//! mock server; the approval reason names whatever host it resolves to).

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use rw_api::{
    ApiError, ApiErrorCode, CallCtx, ThrustcurveFetchIn, ThrustcurveFetchOut, ThrustcurveFormat,
    ThrustcurveMotor, ThrustcurveSearchIn, ThrustcurveSearchOut,
};
use rw_model::{Diagnostic, LibSource, diag};
use rw_motor::MotorSource;
use serde_json::{Map, Value, json};

/// The public endpoint.
pub const DEFAULT_URL: &str = "https://www.thrustcurve.org";
/// Environment variable that overrides [`DEFAULT_URL`].
pub const URL_ENV: &str = "RW_THRUSTCURVE_URL";
/// Connecting may take this long.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A whole request (connect, send, read) may take this long.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Default and largest number of motors a search returns.
pub const DEFAULT_LIMIT: u32 = 20;
pub const MAX_LIMIT: u32 = 100;
/// The `[lib.source]` origin of a ThrustCurve download.
pub const ORIGIN: &str = "thrustcurve";
/// Largest answer read (a data file is a few kB, base64 in JSON).
const MAX_BODY: u64 = 8 * 1024 * 1024;

/// The endpoint base URL, without a trailing slash.
pub fn base_url() -> String {
    std::env::var(URL_ENV)
        .ok()
        .map(|u| u.trim().trim_end_matches('/').to_owned())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| DEFAULT_URL.to_owned())
}

/// The host a ThrustCurve call reaches (`www.thrustcurve.org`).
pub fn host() -> String {
    crate::mcp::approval::url_host(&base_url()).to_owned()
}

fn api_error(code: ApiErrorCode, message: String, hint: &str) -> ApiError {
    ApiError {
        outcome: None,
        code,
        message,
        hint: Some(hint.to_owned()),
        diagnostics: Vec::new(),
    }
}

/// An error carrying one of the `RW-E015..017` diagnostics.
fn tc_error(code: ApiErrorCode, diag_code: &str, message: String, hint: &str) -> ApiError {
    let d = Diagnostic::new(diag_code, None, message.clone()).with_hint(hint);
    ApiError {
        diagnostics: vec![d],
        ..api_error(code, message, hint)
    }
}

fn unreachable(message: String) -> ApiError {
    tc_error(
        ApiErrorCode::Unavailable,
        diag::E_TC_UNREACHABLE,
        message,
        "check the network connection and try again later; nothing was written, and the built-in \
         library (rw motor search) works offline",
    )
}

fn agent() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::Rustls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .unversioned_rustls_crypto_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .build();
    ureq::Agent::config_builder()
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_global(Some(REQUEST_TIMEOUT))
        .http_status_as_error(false)
        .user_agent(format!(
            "RocketWright/{} (+https://github.com/Nurozen/RocketWright)",
            env!("CARGO_PKG_VERSION")
        ))
        .tls_config(tls)
        .build()
        .into()
}

/// `RW_OFFLINE=1` (test harnesses, docs-check) turns the network off: only a
/// loopback endpoint (a local mock) is still reached.
fn offline_refusal(host: &str) -> Option<ApiError> {
    let offline = std::env::var("RW_OFFLINE").is_ok_and(|v| v == "1");
    let name = host.rsplit_once(':').map_or(host, |(h, _)| h);
    let loopback = matches!(name, "127.0.0.1" | "localhost" | "[::1]");
    (offline && !loopback).then(|| {
        unreachable(format!(
            "the network is off (RW_OFFLINE=1), so {host} was not contacted"
        ))
    })
}

/// POSTs `body` to `<base>/api/v1/<action>.json` and returns the JSON answer.
fn post(action: &str, body: &Value) -> Result<Value, ApiError> {
    let host = host();
    if let Some(e) = offline_refusal(&host) {
        return Err(e);
    }
    let url = format!("{}/api/v1/{action}.json", base_url());
    let mut resp = agent()
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .send(body.to_string())
        .map_err(|e| match e {
            ureq::Error::Timeout(_) => unreachable(format!(
                "{host} did not answer within {} s",
                REQUEST_TIMEOUT.as_secs()
            )),
            e => unreachable(format!("could not reach {host}: {e}")),
        })?;
    let status = resp.status().as_u16();
    let text = resp
        .body_mut()
        .with_config()
        .limit(MAX_BODY)
        .read_to_string()
        .map_err(|e| unreachable(format!("reading the answer from {host}: {e}")))?;
    if !(200..300).contains(&status) {
        return Err(unreachable(format!("{host} answered HTTP {status}")));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| unreachable(format!("{host} sent an answer that is not JSON: {e}")))?;
    // Criterion errors (`Invalid diameter value "abc"`) and request errors.
    let mut problems: Vec<String> = v["criteria"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["error"].as_str().map(str::to_owned))
        .collect();
    if let Some(e) = v["error"].as_str().filter(|e| !e.is_empty()) {
        problems.push(e.to_owned());
    }
    if !problems.is_empty() {
        return Err(api_error(
            ApiErrorCode::InvalidInput,
            format!("{host} rejected the request: {}", problems.join("; ")),
            "fix the search criteria (diameter in mm, a class letter such as C)",
        ));
    }
    Ok(v)
}

// ---- queries ------------------------------------------------------------------

/// `C6`, `1/2A3`: ThrustCurve's common-name pattern.
fn is_common_name(s: &str) -> bool {
    let s = s.to_ascii_uppercase();
    let rest = ["1/8A", "1/4A", "1/2A"]
        .iter()
        .find_map(|p| s.strip_prefix(p))
        .or_else(|| {
            s.chars()
                .next()
                .filter(|c| ('A'..='O').contains(c))
                .map(|_| &s[1..])
        });
    rest.is_some_and(|r| !r.is_empty() && r.chars().all(|c| c.is_ascii_digit()))
}

/// Drops a delay suffix: `C6-5` → `C6`, `H128W-14A` → `H128W`, `D12-P` →
/// `D12`; `SCR-C6` stays.
fn strip_delay(d: &str) -> &str {
    match d.rsplit_once('-') {
        Some((head, tail))
            if !head.is_empty()
                && (tail.eq_ignore_ascii_case("p")
                    || (tail.starts_with(|c: char| c.is_ascii_digit())
                        && tail
                            .trim_end_matches(|c: char| c.is_ascii_alphabetic())
                            .chars()
                            .all(|c| c.is_ascii_digit()))) =>
        {
            head
        }
        _ => d,
    }
}

/// `Estes C6-5` → (`Estes`, `C6`); `C6` → (none, `C6`). An explicit
/// manufacturer keeps the whole query as the designation.
fn split_query(query: &str, manufacturer: Option<&str>) -> (Option<String>, String) {
    let q = query.trim();
    let maker = manufacturer.map(str::trim).filter(|m| !m.is_empty());
    if let Some(m) = maker {
        return (Some(m.to_owned()), strip_delay(q).to_owned());
    }
    match q.split_once(char::is_whitespace) {
        Some((m, d)) if !d.trim().is_empty() => {
            (Some(m.to_owned()), strip_delay(d.trim()).to_owned())
        }
        _ => (None, strip_delay(q).to_owned()),
    }
}

/// The search criteria other than the name (`manufacturer`, `diameter` in
/// mm, `impulseClass`, `maxResults`).
fn criteria(
    i: &ThrustcurveSearchIn,
    maker: Option<String>,
) -> Result<Map<String, Value>, ApiError> {
    let mut c = Map::new();
    if let Some(m) = maker {
        c.insert("manufacturer".into(), json!(m));
    }
    if let Some(d) = &i.diameter {
        let m = match d.literal() {
            Ok(Some(v)) => v.value,
            Ok(None) => {
                return Err(api_error(
                    ApiErrorCode::InvalidInput,
                    "`diameter` must be a literal quantity, not an expression".into(),
                    "pass a diameter such as \"18 mm\"",
                ));
            }
            Err(e) => {
                return Err(api_error(
                    ApiErrorCode::InvalidInput,
                    format!("`diameter`: {e}"),
                    "pass a diameter such as \"18 mm\"",
                ));
            }
        };
        // ThrustCurve takes millimetres; 18 mm is 18, 24 mm is 24.
        c.insert("diameter".into(), json!((m * 1e4).round() / 10.0));
    }
    if let Some(k) = i
        .impulse_class
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        c.insert("impulseClass".into(), json!(k.to_ascii_uppercase()));
    }
    let limit = i.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    c.insert("maxResults".into(), json!(limit));
    Ok(c)
}

fn mm(v: &Value) -> Option<f64> {
    v.as_f64().map(|x| x / 1000.0)
}

fn motor_of(r: &Value) -> Option<ThrustcurveMotor> {
    let s = |k: &str| r[k].as_str().map(str::to_owned).filter(|x| !x.is_empty());
    Some(ThrustcurveMotor {
        motor_id: s("motorId")?,
        manufacturer: s("manufacturerAbbrev")
            .or_else(|| s("manufacturer"))
            .unwrap_or_else(|| "Unknown".into()),
        designation: s("designation").or_else(|| s("commonName"))?,
        common_name: s("commonName"),
        impulse_class: s("impulseClass"),
        diameter: mm(&r["diameter"]),
        length: mm(&r["length"]),
        total_impulse: r["totImpulseNs"].as_f64(),
        average_thrust: r["avgThrustN"].as_f64(),
        burn_time: r["burnTimeS"].as_f64(),
        motor_type: s("type"),
        delays: s("delays"),
        availability: s("availability"),
        data_files: r["dataFiles"].as_u64().unwrap_or(0) as u32,
    })
}

fn run_search(c: Map<String, Value>) -> Result<(Vec<ThrustcurveMotor>, u32), ApiError> {
    let v = post("search", &Value::Object(c))?;
    let motors: Vec<ThrustcurveMotor> = v["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(motor_of)
        .collect();
    let matches = v["matches"]
        .as_u64()
        .map_or(motors.len() as u32, |m| m as u32);
    Ok((motors, matches))
}

/// `thrustcurve_search`: a query names a designation (`H128W`) or a common
/// name (`C6`, every manufacturer's C6); an empty query searches by the other
/// criteria alone.
pub fn search(i: &ThrustcurveSearchIn) -> Result<ThrustcurveSearchOut, ApiError> {
    let (maker, name) = match i.query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        Some(q) => {
            let (m, n) = split_query(q, i.manufacturer.as_deref());
            (m, Some(n))
        }
        None => (
            i.manufacturer
                .as_deref()
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(str::to_owned),
            None,
        ),
    };
    let base = criteria(i, maker)?;
    if base.len() == 1 && name.is_none() {
        return Err(api_error(
            ApiErrorCode::InvalidInput,
            "a ThrustCurve search needs a query or at least one criterion".into(),
            "pass a designation (C6), a manufacturer, a diameter, or an impulse class",
        ));
    }
    let (motors, matches) = match name {
        None => run_search(base)?,
        Some(n) => {
            let key = if is_common_name(&n) {
                "commonName"
            } else {
                "designation"
            };
            let mut c = base.clone();
            c.insert(key.into(), json!(n));
            let first = run_search(c)?;
            // `H128W`: no designation match, so try its common name `H128`.
            let common = n.trim_end_matches(|c: char| c.is_ascii_alphabetic());
            if first.0.is_empty() && key == "designation" && is_common_name(common) {
                let mut c = base;
                c.insert("commonName".into(), json!(common));
                run_search(c)?
            } else {
                first
            }
        }
    };
    Ok(ThrustcurveSearchOut {
        motors,
        matches,
        host: host(),
    })
}

fn is_motor_id(s: &str) -> bool {
    s.len() == 24 && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn not_found(message: String, hint: &str) -> ApiError {
    tc_error(ApiErrorCode::NotFound, diag::E_TC_NOT_FOUND, message, hint)
}

/// The one motor `i.motor` names: an id, or a designation with an optional
/// manufacturer that matches exactly one motor.
fn resolve(i: &ThrustcurveFetchIn) -> Result<ThrustcurveMotor, ApiError> {
    let m = i.motor.trim();
    if is_motor_id(m) {
        let (motors, _) = run_search(Map::from_iter([("id".to_owned(), json!(m))]))?;
        return motors.into_iter().next().ok_or_else(|| {
            not_found(
                format!("ThrustCurve has no motor with id {m}"),
                "find the id with rw motor thrustcurve search",
            )
        });
    }
    let found = search(&ThrustcurveSearchIn {
        query: Some(m.to_owned()),
        manufacturer: i.manufacturer.clone(),
        limit: Some(MAX_LIMIT),
        ..Default::default()
    })?;
    let (_, name) = split_query(m, i.manufacturer.as_deref());
    let mut motors = found.motors;
    // `C6` matches Estes C6 and SCR-C6 by common name; an exact designation wins.
    if motors.len() > 1 {
        let exact: Vec<ThrustcurveMotor> = motors
            .iter()
            .filter(|x| x.designation.eq_ignore_ascii_case(&name))
            .cloned()
            .collect();
        if !exact.is_empty() {
            motors = exact;
        }
    }
    match motors.len() {
        0 => Err(not_found(
            format!("ThrustCurve has no motor matching `{m}`"),
            "search with rw motor thrustcurve search, then fetch by motor id",
        )),
        1 => Ok(motors.remove(0)),
        n => {
            let list: Vec<String> = motors
                .iter()
                .take(8)
                .map(|x| format!("{} {} ({})", x.manufacturer, x.designation, x.motor_id))
                .collect();
            Err(tc_error(
                ApiErrorCode::Conflict,
                diag::E_TC_AMBIGUOUS,
                format!(
                    "`{m}` matches {n} ThrustCurve motors: {}{}",
                    list.join(", "),
                    if n > list.len() { ", ..." } else { "" }
                ),
                "pass the motor id, or a manufacturer (--manufacturer Estes, or `Estes C6`)",
            ))
        }
    }
}

/// A data file downloaded for one motor.
#[derive(Debug, Clone)]
pub struct Download {
    pub motor: ThrustcurveMotor,
    /// `Estes_C6.eng` (sanitized again by the importer).
    pub file_name: String,
    pub bytes: Vec<u8>,
    pub source: LibSource,
}

/// Preference among a motor's data files: certification data, then the
/// manufacturer's, then user-contributed; ThrustCurve's order otherwise.
fn source_rank(r: &Value) -> u8 {
    match r["source"].as_str() {
        Some("cert") => 0,
        Some("mfr") => 1,
        _ => 2,
    }
}

/// Resolves the motor and downloads its data file in `i.format`. Writes
/// nothing.
pub fn download(i: &ThrustcurveFetchIn) -> Result<Download, ApiError> {
    let motor = resolve(i)?;
    let (format, ext, label) = match i.format {
        ThrustcurveFormat::Eng => ("RASP", "eng", "RASP .eng"),
        ThrustcurveFormat::Rse => ("RockSim", "rse", "RockSim .rse"),
    };
    let v = post(
        "download",
        &json!({"motorIds": [motor.motor_id], "format": format, "data": "file"}),
    )?;
    let mut files: Vec<&Value> = v["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["data"].as_str().is_some_and(|d| !d.is_empty()))
        .collect();
    files.sort_by_key(|r| source_rank(r));
    let other = match i.format {
        ThrustcurveFormat::Eng => "rse",
        ThrustcurveFormat::Rse => "eng",
    };
    let Some(file) = files.first() else {
        return Err(not_found(
            format!(
                "ThrustCurve has no {label} data file for {} {}",
                motor.manufacturer, motor.designation
            ),
            &format!("try --format {other}, or another motor"),
        ));
    };
    let data: String = file["data"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| {
            unreachable(format!(
                "{} sent a data file that is not base64: {e}",
                host()
            ))
        })?;
    let simfile_id = file["simfileId"].as_str().map(str::to_owned);
    let base = base_url();
    let url = match (file["infoUrl"].as_str(), &simfile_id) {
        (Some(u), _) if u.contains("://") => u.to_owned(),
        (Some(u), _) if u.starts_with('/') => format!("{base}{u}"),
        (_, Some(id)) => format!("{base}/simfiles/{id}/"),
        _ => format!(
            "{base}/motors/{}/{}/",
            motor.manufacturer, motor.designation
        ),
    };
    let source = LibSource {
        origin: ORIGIN.into(),
        motor_id: Some(motor.motor_id.clone()),
        simfile_id,
        url,
        downloaded: rw_project::clock::now().1,
    };
    let file_name = format!("{}_{}.{ext}", motor.manufacturer, motor.designation);
    Ok(Download {
        motor,
        file_name,
        bytes,
        source,
    })
}

/// Saves a download into the project through the session (one history
/// step, the import's own strict check).
pub fn save(
    s: &mut rw_project::Session,
    i: &ThrustcurveFetchIn,
    dl: Download,
    ctx: &CallCtx,
) -> Result<ThrustcurveFetchOut, ApiError> {
    let mut ctx = ctx.clone();
    if ctx.label.is_none() {
        ctx.label = Some(format!(
            "Download motor {} {} (ThrustCurve)",
            dl.motor.manufacturer, dl.motor.designation
        ));
    }
    let text = String::from_utf8_lossy(&dl.bytes).into_owned();
    let (out, path) = s.import_motor_bytes(
        &dl.file_name,
        dl.bytes,
        Some(dl.source.clone()),
        i.dry_run,
        &ctx,
    )?;
    let src = MotorSource::Library { path: path.clone() };
    let curves = if path.to_ascii_lowercase().ends_with(".rse") {
        rw_motor::parse_rse(&text, src)
    } else {
        rw_motor::parse_eng(&text, src)
    }
    .unwrap_or_default();
    Ok(ThrustcurveFetchOut {
        mutation: out.mutation,
        imported: out.imported,
        path,
        motor: dl.motor,
        source: dl.source,
        curves,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_names() {
        assert!(is_common_name("C6"));
        assert!(is_common_name("c6"));
        assert!(is_common_name("1/2A3"));
        assert!(is_common_name("O5000"));
        assert!(!is_common_name("H128W"));
        assert!(!is_common_name("P100"));
        assert!(!is_common_name("C"));
        assert!(!is_common_name("SCR-C6"));
    }

    #[test]
    fn delays() {
        assert_eq!(strip_delay("C6-5"), "C6");
        assert_eq!(strip_delay("H128W-14A"), "H128W");
        assert_eq!(strip_delay("D12-P"), "D12");
        assert_eq!(strip_delay("SCR-C6"), "SCR-C6");
        assert_eq!(strip_delay("C6"), "C6");
        assert_eq!(strip_delay("-5"), "-5");
    }

    #[test]
    fn queries() {
        assert_eq!(split_query("C6", None), (None, "C6".into()));
        assert_eq!(
            split_query(" Estes  C6-5 ", None),
            (Some("Estes".into()), "C6".into())
        );
        assert_eq!(
            split_query("C6-5", Some("Estes")),
            (Some("Estes".into()), "C6".into())
        );
    }

    #[test]
    fn offline_spares_only_loopback() {
        // Pure on its inputs except RW_OFFLINE, read once per call.
        let off = std::env::var("RW_OFFLINE").is_ok_and(|v| v == "1");
        assert_eq!(offline_refusal("www.thrustcurve.org").is_some(), off);
        assert!(offline_refusal("127.0.0.1:8080").is_none());
        assert!(offline_refusal("localhost").is_none());
    }

    #[test]
    fn motor_ids() {
        assert!(is_motor_id("5f4294d20002310000000015"));
        assert!(!is_motor_id("C6"));
        assert!(!is_motor_id("5f4294d2000231000000001g"));
    }

    #[test]
    fn parses_a_search_result() {
        let m = motor_of(&json!({
            "motorId": "5f4294d20002310000000015", "manufacturer": "Estes Industries",
            "manufacturerAbbrev": "Estes", "designation": "C6", "commonName": "C6",
            "impulseClass": "C", "diameter": 18, "length": 70, "type": "SU",
            "avgThrustN": 4.74, "totImpulseNs": 8.82, "burnTimeS": 1.86, "dataFiles": 4,
            "delays": "0,3,5,7", "availability": "regular"
        }))
        .unwrap();
        assert_eq!(m.manufacturer, "Estes");
        assert_eq!(m.diameter, Some(0.018));
        assert_eq!(m.length, Some(0.07));
        assert_eq!(m.data_files, 4);
        assert!(motor_of(&json!({"designation": "C6"})).is_none());
    }
}
