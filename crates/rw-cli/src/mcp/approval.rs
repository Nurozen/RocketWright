//! App-decided approval for Lecturn (D6; spec W1.3; Lecturn R4.5).
//!
//! Lecturn proxies every call with `_meta["lecturn/approval"] = {approved,
//! requestId?}` and registers no static `gatedTools`: the app decides. A call
//! that needs the user, sent with `approved != true`, is answered without
//! side effects: `isError: true`, `rw/error` code `approval_required`, and
//! `_meta["lecturn/approval-required"] = {reason}`. Lecturn asks the user and
//! re-sends the call with `approved: true`. Calls without any
//! `lecturn/approval` meta (plain MCP and CLI use) are never gated here.
//!
//! The rules (and their reason wording) were ported from the app's old
//! `policy.ts` (`requiresApproval`, `reason`, `largeJobOrNetworkReason`),
//! which B17 removed with the old chat engine; this is now the only copy.
//! They are keyed off [`CommandDef::approval`]:
//! - `always` tools ask (`import_file`, `export_file`, `cfd_import`);
//! - `conditional` tools ask for a network URL anywhere in the arguments
//!   (any `scheme://` string except `rw://`), or for an `engine_simulate`
//!   duration that is missing (the engine's default, `DesignOptions::
//!   default().t_max`), uncheckable or over 60 s;
//! - `simulate` with `mc > 100` never asks: Monte Carlo is not implemented,
//!   so it answers `not_implemented` before any gate, approved or not
//!   (decision 4).
//!
//! Durations use the core grammar (`rw_units::parse_for`). A bare number or
//! a unitless string counts as seconds, as in the old `policy.ts`, so it is
//! normalized to `"<n> s"` first (`parse_for` rejects nonzero unitless time).

use rw_api::{ApiError, ApiErrorCode, Approval, CommandDef};
use rw_units::{DimKind, parse_for, parse_parts};
use serde_json::Value;

/// `simulate` above this many Monte Carlo samples is a large job.
pub const LARGE_MC_SAMPLES: f64 = 100.0;
/// `engine_simulate` above this many seconds is a large job.
pub const LARGE_ENGINE_SECONDS: f64 = 60.0;

/// The engine's own default duration when `duration` is omitted (120 s).
pub fn default_engine_seconds() -> f64 {
    rw_liquid::DesignOptions::default().t_max
}

/// What the gate does with one call.
#[derive(Debug, Clone, PartialEq)]
pub enum Gate {
    /// Answer with this error and no approval request (nothing to approve).
    Refuse(ApiError),
    /// Answer without side effects and ask the user for this reason.
    Ask(String),
}

/// The gate for a call carrying `lecturn/approval` meta `approval`; `None`
/// runs it. Monte Carlo is refused even when approved.
pub fn gate(def: &CommandDef, args: &Value, approval: &Value) -> Option<Gate> {
    if let Some(e) = monte_carlo(def, args) {
        return Some(Gate::Refuse(e));
    }
    if approval.get("approved") == Some(&Value::Bool(true)) {
        return None;
    }
    reason(def, args).map(Gate::Ask)
}

/// `simulate` with `mc > 100`: `not_implemented`, as the session answers
/// any `mc > 1` (`runs_cmd.rs`), but before any approval is raised.
pub fn monte_carlo(def: &CommandDef, args: &Value) -> Option<ApiError> {
    let mc = args.get("mc").and_then(Value::as_f64)?;
    (def.name == "simulate" && mc > LARGE_MC_SAMPLES).then(|| ApiError {
        hint: Some("omit mc for a single deterministic flight".into()),
        ..ApiError::not_implemented("simulate with mc > 1 (Monte Carlo)")
    })
}

/// Why this call needs the user (`None`: it does not). The old `policy.ts`
/// `requiresApproval` plus `reason`, without the Monte Carlo rule
/// ([`monte_carlo`] answers that first).
pub fn reason(def: &CommandDef, args: &Value) -> Option<String> {
    match def.approval {
        Approval::Never => None,
        Approval::Conditional => conditional_reason(def.name, args),
        Approval::Always => Some(always_reason(def.name, args)),
    }
}

/// The ApiError carried in `rw/error` beside `lecturn/approval-required`.
pub fn approval_required(reason: &str) -> ApiError {
    ApiError {
        code: ApiErrorCode::ApprovalRequired,
        message: reason.to_owned(),
        hint: Some(
            "nothing ran; the call needs the user's approval (Lecturn re-sends it approved)".into(),
        ),
        diagnostics: Vec::new(),
        outcome: None,
    }
}

// Reasons are user-facing prose shown on Lecturn's approval card: no tool
// ids, no comparison operators, about 60 characters at most.

fn conditional_reason(tool: &str, args: &Value) -> Option<String> {
    if let Some(url) = network_target(args) {
        return Some(network_reason(url));
    }
    if tool != "engine_simulate" {
        return None;
    }
    match args.get("duration") {
        None | Some(Value::Null) => Some(format!(
            "Burn duration not set \u{b7} default {}",
            fmt_s(default_engine_seconds())
        )),
        Some(d) => match seconds(d) {
            None => Some(format!("Burn duration {d} can't be checked")),
            Some(s) if s > LARGE_ENGINE_SECONDS => Some(format!(
                "Engine burn of {} (over {})",
                fmt_s(s),
                fmt_s(LARGE_ENGINE_SECONDS)
            )),
            Some(_) => None,
        },
    }
}

/// What an `always` tool does, as the subject of its reason.
fn action(tool: &str) -> &'static str {
    match tool {
        "import_file" => "Import reads",
        "export_file" => "Export writes",
        "cfd_import" => "CFD import reads",
        _ => "Reads or writes",
    }
}

/// The old `policy.ts` `reason()` for an `always` tool: the network target, else
/// the path it touches.
fn always_reason(tool: &str, args: &Value) -> String {
    if let Some(url) = network_target(args) {
        return network_reason(url);
    }
    let what = action(tool);
    let path = args.get("path").and_then(Value::as_str);
    match path {
        Some(p) if args.get("allow_outside") == Some(&Value::Bool(true)) => {
            format!("{what} outside the project: {p}")
        }
        Some(p) => format!("{what} {}, outside the model", Value::from(p)),
        None => format!("{what} files outside the model"),
    }
}

fn network_reason(url: &str) -> String {
    format!("Network access to {}", url_host(url))
}

/// The URL's host (authority without user info); the URL itself when it
/// has none (`file:///x`).
fn url_host(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if host.is_empty() { url } else { host }
}

/// The first `scheme://` string anywhere in `v` (values, not keys), other
/// than `rw://`; trimmed.
pub fn network_target(v: &Value) -> Option<&str> {
    match v {
        Value::String(s) => {
            let t = s.trim();
            (is_url(t) && !t.starts_with("rw://")).then_some(t)
        }
        Value::Array(a) => a.iter().find_map(network_target),
        Value::Object(o) => o.values().find_map(network_target),
        _ => None,
    }
}

/// `^[a-z][a-z0-9+.-]*://` (case-insensitive).
fn is_url(t: &str) -> bool {
    let Some((scheme, _)) = t.split_once("://") else {
        return false;
    };
    let mut c = scheme.chars();
    c.next().is_some_and(|f| f.is_ascii_alphabetic())
        && c.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '.' | '-'))
}

/// A duration in seconds, or `None` when it cannot be checked (an `=`
/// expression, a unit of another dimension, compound or unknown units,
/// anything not a number or string). A bare number or a unitless string is
/// seconds.
pub fn seconds(v: &Value) -> Option<f64> {
    let text = match v {
        Value::Number(n) => format!("{n} s"),
        Value::String(s) => {
            let t = s.trim();
            if t.starts_with('=') {
                return None;
            }
            match parse_parts(t) {
                Ok(p) if p.unit.is_none() => format!("{t} s"),
                Ok(_) => t.to_owned(),
                Err(_) => return None,
            }
        }
        _ => return None,
    };
    parse_for(&text, DimKind::Time)
        .ok()
        .map(|q| q.value)
        .filter(|s| s.is_finite())
}

/// `120 s`, `90.5 s`.
fn fmt_s(s: f64) -> String {
    if s.fract() == 0.0 && s.abs() < 1e15 {
        format!("{} s", s as i64)
    } else {
        format!("{s} s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hosts() {
        assert_eq!(url_host("https://thrustcurve.org/x?y"), "thrustcurve.org");
        assert_eq!(url_host("http://u:p@h.example:8080/"), "h.example:8080");
        assert_eq!(url_host("file:///etc/passwd"), "file:///etc/passwd");
    }

    #[test]
    fn urls() {
        assert!(is_url("HTTPS://x"));
        assert!(is_url("s3+x.y-z://b"));
        assert!(!is_url("1http://x"));
        assert!(!is_url("motors/c6.eng"));
        assert_eq!(
            network_target(&json!(["a", {"b": " ftp://h/x "}])),
            Some("ftp://h/x")
        );
        assert_eq!(network_target(&json!({"https://key": "v"})), None);
    }

    #[test]
    fn formats() {
        assert_eq!(fmt_s(120.0), "120 s");
        assert_eq!(fmt_s(90.5), "90.5 s");
    }
}
