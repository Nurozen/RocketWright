//! `rw motor search|show` and `rw lib search|show`.

use serde_json::{Value, json};

use super::{CmdResult, Opts, Outcome, fmt_f};

fn motor_line(m: &Value) -> String {
    format!(
        "{:<32} {:<4} {:>5} mm {:>8} Ns {:>6} s  {}",
        m["id"].as_str().unwrap_or("?"),
        m["class"].as_str().unwrap_or("?"),
        m["diameter"]
            .as_f64()
            .map_or("-".into(), |d| fmt_f(d * 1000.0)),
        m["total_impulse"].as_f64().map_or("-".into(), fmt_f),
        m["burn_time"].as_f64().map_or("-".into(), fmt_f),
        m["designation"].as_str().unwrap_or("?"),
    )
}

/// `rw motor search [query] [--class] [--diameter] [--min-impulse] [--max-impulse] [--limit]`.
#[allow(clippy::too_many_arguments)]
pub fn motor_search(
    opts: &Opts,
    query: Option<String>,
    class: Option<String>,
    diameter: Option<String>,
    min_impulse: Option<String>,
    max_impulse: Option<String>,
    limit: Option<u32>,
) -> CmdResult {
    let mut args = json!({});
    for (k, v) in [
        ("query", query),
        ("class", class),
        ("diameter", diameter),
        ("min_impulse", min_impulse),
        ("max_impulse", max_impulse),
    ] {
        if let Some(v) = v {
            args[k] = json!(v);
        }
    }
    if let Some(n) = limit {
        args["limit"] = json!(n);
    }
    let v = opts.call("motor_search", args, None)?;
    let h: Vec<String> = v["motors"]
        .as_array()
        .into_iter()
        .flatten()
        .map(motor_line)
        .collect();
    let h = if h.is_empty() {
        "no motors match".to_string()
    } else {
        h.join("\n")
    };
    Ok(Outcome::ok(v, h))
}

/// `rw motor show <id>`.
pub fn motor_show(opts: &Opts, id: &str) -> CmdResult {
    let v = opts.call("motor_show", json!({"id": id}), None)?;
    let mut h = motor_line(&v["info"]);
    h.push_str(&format!(
        "\n  sha256 {}\n  {} thrust points",
        v["info"]["sha256"].as_str().unwrap_or("?"),
        v["curve"]["points"].as_array().map_or(0, Vec::len)
    ));
    Ok(Outcome::ok(v, h))
}

fn item_line(i: &Value) -> String {
    format!(
        "{:<40} {:<10} {}  ({})",
        i["id"].as_str().unwrap_or("?"),
        i["kind"].as_str().unwrap_or("?"),
        i["name"].as_str().unwrap_or("?"),
        i["source"].as_str().unwrap_or("?")
    )
}

/// `rw lib search [query] [--kind] [--limit]`.
pub fn lib_search(
    opts: &Opts,
    query: Option<String>,
    kind: Option<String>,
    limit: Option<u32>,
) -> CmdResult {
    let mut args = json!({});
    if let Some(q) = query {
        args["query"] = json!(q);
    }
    if let Some(k) = kind {
        args["kind"] = json!(k);
    }
    if let Some(n) = limit {
        args["limit"] = json!(n);
    }
    let v = opts.call("library_search", args, None)?;
    let h: Vec<String> = v["items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(item_line)
        .collect();
    let h = if h.is_empty() {
        "no items match".to_string()
    } else {
        h.join("\n")
    };
    Ok(Outcome::ok(v, h))
}

/// `rw lib show <id>`.
pub fn lib_show(opts: &Opts, id: &str) -> CmdResult {
    let v = opts.call("library_show", json!({"id": id}), None)?;
    let h = format!(
        "{}\n{}",
        item_line(&v),
        serde_json::to_string_pretty(&v["data"]).unwrap_or_default()
    );
    Ok(Outcome::ok(v, h))
}
