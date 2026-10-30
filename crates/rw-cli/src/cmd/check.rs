//! `rw check [--strict] [--sim quick]` and `rw render --view ... [--imgsize WxH]`.

use serde_json::{Value, json};

use rw_units::DimKind;

use super::{CmdResult, Opts, Outcome, diag_lines, kv, num, usage};
use crate::display::{Class, Units};

/// `rw check`: exit 1 on errors, or on warnings with `--strict` (D18).
pub fn check(
    opts: &Opts,
    strict: bool,
    sim: Option<String>,
    config: Option<String>,
    variant: Option<String>,
    set: &[String],
) -> CmdResult {
    let mut args = json!({"strict": strict});
    if let Some(s) = sim {
        if s != "quick" {
            return Err(usage(format!("--sim takes `quick`, got `{s}`")));
        }
        args["sim"] = json!("quick");
    }
    if let Some(c) = config {
        args["config"] = json!(c);
    }
    if let Some(v) = variant {
        args["variant"] = json!(v);
    }
    if !set.is_empty() {
        let mut m = serde_json::Map::new();
        for a in set {
            let (k, v) = kv(a)?;
            m.insert(k, json!(v));
        }
        args["set"] = Value::Object(m);
    }
    let v = opts.call("design_check", args, None)?;
    let status = v["status"].as_str().unwrap_or("?").to_string();
    let ok = match status.as_str() {
        "clean" => true,
        "warnings" => !strict,
        _ => false,
    };
    Ok(Outcome {
        human: report_titled(&v, &opts.units(), "check"),
        value: v,
        ok,
    })
}

/// The human form of a check report in display units, headed
/// `<title>: <status> (<tier>)` (`check: clean (static) config c6`).
pub fn report_titled(v: &Value, u: &Units, title: &str) -> String {
    let len = Class::Dim(DimKind::Length);
    let cal = Class::Fixed("cal");
    let mut s = format!(
        "{title}: {} ({})",
        v["status"].as_str().unwrap_or("?"),
        v["tier"].as_str().unwrap_or("?")
    );
    if let Some(c) = v["config"].as_str() {
        s.push_str(&format!(" config {c}"));
    }
    // Length in calibers and the fineness ratio come from the report, so
    // nobody divides length by diameter by hand.
    let length_cal = if v["dims"]["length_cal"].is_null() {
        String::new()
    } else {
        format!(" ({})", u.num(&v["dims"]["length_cal"], cal))
    };
    s.push_str(&format!(
        "\n  length {}{length_cal}, diameter {}",
        u.num(&v["dims"]["length"], len),
        u.num(&v["dims"]["max_diameter"], len)
    ));
    if !v["dims"]["fineness"].is_null() {
        s.push_str(&format!(", fineness {}", num(&v["dims"]["fineness"])));
    }
    s.push_str(&format!(
        "\n  mass liftoff {}, CG {}, CP {}, CNa {}",
        u.num(&v["mass"]["liftoff"], Class::Dim(DimKind::Mass)),
        u.num(&v["mass"]["cg"], len),
        u.num(&v["aero"]["cp"], len),
        num(&v["aero"]["cna"])
    ));
    s.push_str(&format!(
        "\n  stability liftoff {}, burnout {}, min {}",
        u.num(&v["stability"]["liftoff"], cal),
        u.num(&v["stability"]["burnout"], cal),
        u.num(&v["stability"]["min"], cal)
    ));
    for m in v["motor"].as_array().into_iter().flatten() {
        s.push_str(&format!(
            "\n  motor {} in {}: fits {}, T/W {}",
            m["motor"].as_str().unwrap_or("?"),
            m["mount"].as_str().unwrap_or("?"),
            m["fits_mount"],
            num(&m["thrust_to_weight"])
        ));
    }
    if let Some(sim) = v.get("sim").filter(|x| !x.is_null()) {
        let vel = Class::Dim(DimKind::Velocity);
        s.push_str(&format!(
            "\n  quick sim: apogee {}, max velocity {}, rail exit {}",
            u.num(&sim["apogee_m"], Class::Altitude),
            u.num(&sim["max_velocity_ms"], vel),
            u.num(&sim["rail_exit_velocity_ms"], vel)
        ));
    }
    for a in v["assertions"].as_array().into_iter().flatten() {
        s.push_str(&format!(
            "\n  assert {} {}: {}{}",
            a["id"].as_str().unwrap_or("?"),
            a["expr"].as_str().unwrap_or("?"),
            if a["pass"] == true { "pass" } else { "FAIL" },
            a["message"]
                .as_str()
                .map(|m| format!(" ({m})"))
                .unwrap_or_default()
        ));
    }
    for l in diag_lines(&v["diagnostics"]) {
        s.push_str(&format!("\n  {l}"));
    }
    s
}

/// Parses `WxH`.
pub fn imgsize(s: &str) -> Result<(u32, u32), rw_api::ApiError> {
    let (w, h) = s
        .split_once(['x', 'X'])
        .ok_or_else(|| usage(format!("--imgsize takes WxH, got `{s}`")))?;
    let p = |x: &str| {
        x.trim()
            .parse::<u32>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| usage(format!("--imgsize takes WxH, got `{s}`")))
    };
    Ok((p(w)?, p(h)?))
}

/// The 3D-only `rw render` flags.
#[derive(Debug, Default)]
pub struct Render3d {
    pub explode: Option<f64>,
    pub scheme: Option<String>,
    /// `--compare <version>`: red/amber/green against that version.
    pub compare: Option<String>,
}

/// `rw render --view <view> [--config] [--imgsize WxH] [--explode s] [--scheme check|pbr]
/// [--compare <version>]`.
pub fn render(
    opts: &Opts,
    view: &str,
    config: Option<String>,
    size: Option<String>,
    d3: Render3d,
) -> CmdResult {
    let mut args = json!({"view": view});
    if let Some(c) = config {
        args["config"] = json!(c);
    }
    if let Some(e) = d3.explode {
        args["explode"] = json!(e);
    }
    if let Some(s) = d3.scheme {
        args["scheme"] = json!(s);
    }
    if let Some(v) = d3.compare {
        args["compare"] = json!(v);
    }
    if let Some(s) = size {
        let (w, h) = imgsize(&s)?;
        args["width"] = json!(w);
        args["height"] = json!(h);
    }
    let v = opts.call("render", args, None)?;
    let human = format!(
        "{} ({}x{}){}",
        v["path"].as_str().unwrap_or("?"),
        v["width"],
        v["height"],
        crate::legend::human(&v["legend"], &opts.units())
    );
    Ok(Outcome::ok(v, human))
}

#[cfg(test)]
mod tests {
    #[test]
    fn imgsize_parses() {
        assert_eq!(super::imgsize("800x600").unwrap(), (800, 600));
        assert!(super::imgsize("800").is_err());
        assert!(super::imgsize("0x5").is_err());
    }
}
