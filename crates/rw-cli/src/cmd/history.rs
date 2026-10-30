//! `rw history log|show|tag|compare`.

use serde_json::{Value, json};

use super::{CmdResult, Opts, Outcome};
use crate::display::{Class, Units, unit_class};

fn step_line(s: &Value) -> String {
    format!(
        "step:{:<4} {} {:<8} {}{}",
        s["seq"],
        s["ts"].as_str().unwrap_or("?"),
        s["origin"].as_str().unwrap_or("?"),
        s["title"].as_str().unwrap_or("?"),
        s["rev"]
            .as_str()
            .map(|r| format!(" [{r}]"))
            .unwrap_or_default()
    )
}

/// `rw history log [--thread] [--limit]`.
pub fn log(opts: &Opts, thread: Option<String>, limit: Option<u32>) -> CmdResult {
    let mut args = json!({});
    if let Some(t) = thread {
        args["thread"] = json!(t);
    }
    if let Some(n) = limit {
        args["limit"] = json!(n);
    }
    let v = opts.call("history_list", args, None)?;
    let mut h: Vec<String> = v["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .map(step_line)
        .collect();
    for r in v["revisions"].as_array().into_iter().flatten() {
        h.push(format!(
            "rev:{:02} {} (step:{})",
            r["number"].as_u64().unwrap_or(0),
            r["name"].as_str().unwrap_or("?"),
            r["step"]
        ));
    }
    Ok(Outcome::ok(v, h.join("\n")))
}

/// `rw history show <version>`.
pub fn show(opts: &Opts, version: &str) -> CmdResult {
    let v = opts.call("history_show", json!({"version": version}), None)?;
    let mut h = step_line(&v["step"]);
    for c in v["diff"]["changed"].as_array().into_iter().flatten() {
        h.push_str(&format!(
            "\n  ~ {}: {} -> {}",
            c["path"].as_str().unwrap_or("?"),
            c.get("old").map_or("-".into(), Value::to_string),
            c.get("new").map_or("-".into(), Value::to_string)
        ));
    }
    for x in v["diff"]["added"].as_array().into_iter().flatten() {
        h.push_str(&format!("\n  + {}", x.as_str().unwrap_or("?")));
    }
    for x in v["diff"]["removed"].as_array().into_iter().flatten() {
        h.push_str(&format!("\n  - {}", x.as_str().unwrap_or("?")));
    }
    Ok(Outcome::ok(v, h))
}

/// `rw history tag <name> [version] [--number N]`.
pub fn tag(opts: &Opts, name: &str, version: Option<String>, number: Option<u32>) -> CmdResult {
    let mut args = json!({"name": name});
    if let Some(v) = version {
        args["version"] = json!(v);
    }
    if let Some(n) = number {
        args["number"] = json!(n);
    }
    let v = opts.call("history_tag", args, None)?;
    let h = format!(
        "rev:{:02} {} at step:{}",
        v["number"].as_u64().unwrap_or(0),
        v["name"].as_str().unwrap_or("?"),
        v["step"]
    );
    Ok(Outcome::ok(v, h))
}

/// The change column of `history compare`: the absolute change in display
/// units and the percent change, `(+1.734 g, +3.0%)`. The tool prints both so
/// an agent never subtracts the two columns itself (B3 round 5, T4).
fn compare_delta(u: &Units, a: &Value, b: &Value, c: Class, pct: Option<f64>) -> String {
    let abs = u.delta_json(a, b, c);
    let pct = pct.map(|p| format!("{p:+.1}%"));
    match (abs, pct) {
        (Some(a), Some(p)) => format!("  ({a}, {p})"),
        (Some(x), None) | (None, Some(x)) => format!("  ({x})"),
        (None, None) => String::new(),
    }
}

/// One `history compare` metric row: `key  a -> b  (abs, pct)`, `-` for a
/// side without a value.
fn metric_line(u: &Units, r: &Value, width: usize) -> String {
    let key = r["key"].as_str().unwrap_or("?");
    let c = unit_class(key, r["unit"].as_str());
    let delta = compare_delta(u, &r["a"], &r["b"], c, r["delta_pct"].as_f64());
    format!(
        "\n  {key:<width$} {} -> {}{delta}",
        u.num(&r["a"], c),
        u.num(&r["b"], c)
    )
}

/// `rw history compare <a> <b> [--visual] [--breakdown]`: metrics with
/// units, the component marks (removed, changed, added), and the source
/// field changes; `--breakdown` adds each component's mass and CG and each
/// aero term's CNa and CP, so which component a change came from is read
/// from the tool (B3 round 11, T4).
pub fn compare(opts: &Opts, a: &str, b: &str, visual: bool, breakdown: bool) -> CmdResult {
    let v = opts.call(
        "history_compare",
        json!({"a": a, "b": b, "visual": visual, "breakdown": breakdown}),
        None,
    )?;
    let u = opts.units();
    let mut h = format!("{a} -> {b}");
    for r in v["metrics"].as_array().into_iter().flatten() {
        h.push_str(&metric_line(&u, r, 24));
    }
    let rows = v["breakdown"].as_array().cloned().unwrap_or_default();
    if !rows.is_empty() {
        let width = rows
            .iter()
            .filter_map(|r| r["key"].as_str().map(str::len))
            .max()
            .unwrap_or(24)
            .max(24);
        let mut section = "";
        for r in &rows {
            let key = r["key"].as_str().unwrap_or("");
            let this = if key.starts_with("aero.terms.") {
                "\n  breakdown aero (per component: CNa and CP of its term)"
            } else {
                "\n  breakdown mass (per component: dry mass and CG)"
            };
            if this != section {
                section = this;
                h.push_str(section);
            }
            h.push_str(&metric_line(&u, r, width));
        }
    }
    for m in v["marks"].as_array().into_iter().flatten() {
        let sign = match m["status"].as_str() {
            Some("removed") => "-",
            Some("added") => "+",
            _ => "~",
        };
        h.push_str(&format!(
            "\n  {sign} {} ({})",
            m["id"].as_str().unwrap_or("?"),
            m["status"].as_str().unwrap_or("?")
        ));
        for f in m["fields"].as_array().into_iter().flatten() {
            let path = f["path"].as_str().unwrap_or("?");
            let c = unit_class(path, f["unit"].as_str());
            let show = |x: &Value| {
                if x.is_number() {
                    u.num(x, c)
                } else {
                    x.as_str().map_or_else(|| x.to_string(), String::from)
                }
            };
            let delta = u
                .delta_json(&f["old"], &f["new"], c)
                .map(|d| format!("  ({d})"))
                .unwrap_or_default();
            h.push_str(&format!(
                "\n      {path}: {} -> {}{delta}",
                show(&f["old"]),
                show(&f["new"])
            ));
        }
    }
    let m = &v["model"];
    for c in m["changed"].as_array().into_iter().flatten() {
        h.push_str(&format!(
            "\n  field {}: {} -> {}",
            c["path"].as_str().unwrap_or("?"),
            c.get("old").map_or("-".into(), Value::to_string),
            c.get("new").map_or("-".into(), Value::to_string)
        ));
    }
    h.push_str(&format!(
        "\n  {} added, {} removed, {} changed fields",
        m["added"].as_array().map_or(0, Vec::len),
        m["removed"].as_array().map_or(0, Vec::len),
        m["changed"].as_array().map_or(0, Vec::len)
    ));
    if let Some(p) = v["visual"]["path"].as_str() {
        h.push_str(&format!("\n  visual: {p}"));
    }
    Ok(Outcome::ok(v, h))
}

#[cfg(test)]
mod compare_delta_tests {
    use super::compare_delta;
    use crate::display::{Class, Units};
    use rw_units::DimKind;
    use serde_json::json;

    #[test]
    fn prints_the_absolute_and_percent_change_in_display_units() {
        let u = Units::default();
        assert_eq!(
            compare_delta(
                &u,
                &json!(0.057405),
                &json!(0.059139),
                Class::Dim(DimKind::Mass),
                Some(3.02)
            ),
            "  (+1.734 g, +3.0%)"
        );
        assert_eq!(
            compare_delta(
                &u,
                &json!(5.2069),
                &json!(3.603),
                Class::Fixed("cal"),
                Some(-30.8)
            ),
            "  (-1.6039 cal, -30.8%)"
        );
        assert_eq!(
            compare_delta(&u, &json!(26.415), &json!(38.993), Class::Plain, None),
            "  (+12.578)"
        );
        assert_eq!(
            compare_delta(&u, &json!(null), &json!(1.0), Class::Altitude, None),
            ""
        );
    }
}
