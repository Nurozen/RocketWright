//! `rw motor import <file.eng|file.rse> [--dry-run]` (S:83, plan M2.14):
//! the `import_file` tool with `kind = "motor"`. The file is copied into the
//! project's `lib/motors/` and its sha256 recorded in `rocketwright.toml
//! [lib.sha256]`; a file in neither dialect fails with `RW-E008`.
//!
//! `rw motor thrustcurve search|fetch`: the opt-in ThrustCurve client
//! ([`crate::thrustcurve`]). A search runs here and needs no project; a
//! fetch is the `thrustcurve_fetch` tool (forwarded to a live owner like any
//! edit), which saves the file as `motor import` does.

use serde_json::{Value, json};

use super::{CmdResult, Opts, Outcome, cli_path, fmt_f, mutation_outcome, usage};

/// `rw motor import <file> [--dry-run]`.
pub fn import(opts: &Opts, file: &str, dry_run: bool) -> CmdResult {
    let args = json!({"path": cli_path(file), "kind": "motor", "dry_run": dry_run});
    let v = opts.call("import_file", args, None)?;
    let motors: String = v["imported"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| format!("motor {}\n", r.as_str().unwrap_or("?")))
        .collect();
    Ok(mutation_outcome(opts, v, "", &motors))
}

fn tc_line(m: &Value) -> String {
    let num = |k: &str, scale: f64| m[k].as_f64().map_or("-".into(), |v| fmt_f(v * scale));
    format!(
        "{:<24}  {:<10} {:<14} {:<4} {:>5} mm {:>8} Ns {:>6} s  {}",
        m["motor_id"].as_str().unwrap_or("?"),
        m["manufacturer"].as_str().unwrap_or("?"),
        m["designation"].as_str().unwrap_or("?"),
        m["impulse_class"].as_str().unwrap_or("-"),
        num("diameter", 1000.0),
        num("total_impulse", 1.0),
        num("burn_time", 1.0),
        m["availability"].as_str().unwrap_or(""),
    )
    .trim_end()
    .to_string()
}

/// `rw motor thrustcurve search [query] [--manufacturer] [--diameter]
/// [--impulse-class] [--limit]`.
pub fn thrustcurve_search(
    _opts: &Opts,
    query: Option<String>,
    manufacturer: Option<String>,
    diameter: Option<String>,
    impulse_class: Option<String>,
    limit: Option<u32>,
) -> CmdResult {
    let mut args = json!({});
    for (k, v) in [
        ("query", query),
        ("manufacturer", manufacturer),
        ("diameter", diameter),
        ("impulse_class", impulse_class),
    ] {
        if let Some(v) = v {
            args[k] = json!(v);
        }
    }
    if let Some(n) = limit {
        args["limit"] = json!(n);
    }
    let cmd = crate::mcp::dispatch::command("thrustcurve_search", args)?;
    let rw_api::Command::ThrustcurveSearch(i) = cmd else {
        unreachable!("thrustcurve_search builds ThrustcurveSearch")
    };
    let out = crate::thrustcurve::search(&i)?;
    let v = serde_json::to_value(&out).map_err(|e| usage(e.to_string()))?;
    let lines: Vec<String> = v["motors"]
        .as_array()
        .into_iter()
        .flatten()
        .map(tc_line)
        .collect();
    let human = if lines.is_empty() {
        format!("no motors match at {}", out.host)
    } else {
        format!(
            "{}\n{} of {} matches from {}; fetch one with `rw motor thrustcurve fetch <motor id>`",
            lines.join("\n"),
            lines.len(),
            out.matches.max(lines.len() as u32),
            out.host
        )
    };
    Ok(Outcome::ok(v, human))
}

/// `rw motor thrustcurve fetch <motor> [--manufacturer] [--format eng|rse] [--dry-run]`.
pub fn thrustcurve_fetch(
    opts: &Opts,
    motor: &str,
    manufacturer: Option<String>,
    format: &str,
    dry_run: bool,
) -> CmdResult {
    let format = match format.to_ascii_lowercase().as_str() {
        "eng" | "rasp" => "eng",
        "rse" | "rocksim" => "rse",
        other => {
            let mut e = usage(format!("unknown format `{other}`"));
            e.hint = Some("pass --format eng (RASP) or --format rse (RockSim)".into());
            return Err(e);
        }
    };
    let mut args = json!({"motor": motor, "format": format, "dry_run": dry_run});
    if let Some(m) = manufacturer {
        args["manufacturer"] = json!(m);
    }
    let v = opts.call("thrustcurve_fetch", args, None)?;
    let mut lines = format!(
        "downloaded {} {} from {}\n",
        v["motor"]["manufacturer"].as_str().unwrap_or("?"),
        v["motor"]["designation"].as_str().unwrap_or("?"),
        v["source"]["url"].as_str().unwrap_or("?"),
    );
    for r in v["imported"].as_array().into_iter().flatten() {
        lines.push_str(&format!("motor {}\n", r.as_str().unwrap_or("?")));
    }
    Ok(mutation_outcome(opts, v, "", &lines))
}
