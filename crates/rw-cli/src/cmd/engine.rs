//! `rw engine design <id>` and `rw engine sim <id> [--duration <t>]` (S:83,
//! plan M4.6): the `engine_design` and `engine_simulate` tools. Text output
//! is SI with the usual engineering units (bar, mm, s); `--json` prints the
//! tool output.

use serde_json::{Value, json};

use super::{CmdResult, Opts, Outcome, diag_lines};

fn f(v: &Value, scale: f64, unit: &str, digits: usize) -> String {
    match v.as_f64() {
        Some(x) => format!("{:.*} {unit}", digits, x * scale),
        None => "-".into(),
    }
}

/// `rw engine design <id>`: performance, geometry, feed budget, tanks,
/// missing inputs, and diagnostics. Exit 1 with errors or missing inputs.
pub fn design(opts: &Opts, id: &str) -> CmdResult {
    let v = opts.call("engine_design", json!({ "engine": id }), None)?;
    let mut h = String::new();
    let d = &v["design"];
    h.push_str(&format!(
        "engine {id} ({})\n",
        d["thermo"].as_str().unwrap_or("no thermochemistry")
    ));
    let s = &d["sizing"];
    if s.is_object() {
        h.push_str(&format!(
            "  thrust {} (vac {}), Pc {}, O/F {}, eps {}\n",
            f(&s["thrust"], 1.0, "N", 0),
            f(&s["thrust_vac"], 1.0, "N", 0),
            f(&s["chamber_pressure"], 1e-5, "bar", 2),
            f(&s["mixture_ratio"], 1.0, "", 2).trim_end(),
            f(&s["expansion_ratio"], 1.0, "", 2).trim_end(),
        ));
        let g0 = 9.806_65;
        h.push_str(&format!(
            "  Isp {} sea level, {} vacuum; c* {}; Tc {}\n",
            f(&s["isp"], 1.0 / g0, "s", 1),
            f(&s["isp_vac"], 1.0 / g0, "s", 1),
            f(&s["c_star"], 1.0, "m/s", 0),
            f(&s["chamber_temperature"], 1.0, "K", 0),
        ));
        h.push_str(&format!(
            "  mdot {} (ox {}, fuel {}); Pe {}\n",
            f(&s["mdot"], 1.0, "kg/s", 3),
            f(&s["mdot_ox"], 1.0, "kg/s", 3),
            f(&s["mdot_fuel"], 1.0, "kg/s", 3),
            f(&s["exit_pressure"], 1e-5, "bar", 3),
        ));
        h.push_str(&format!(
            "  throat {} dia, exit {} dia, chamber {} dia x {} (+{} convergent, {} nozzle)\n",
            f(&s["throat_diameter"], 1e3, "mm", 2),
            f(&s["exit_diameter"], 1e3, "mm", 2),
            f(&s["chamber_diameter"], 1e3, "mm", 2),
            f(&s["chamber_length"], 1e3, "mm", 1),
            f(&s["convergent_length"], 1e3, "mm", 1),
            f(&s["nozzle_length"], 1e3, "mm", 1),
        ));
    }
    for b in d["feed"].as_array().into_iter().flatten() {
        h.push_str(&format!(
            "  feed {} ({}): tank {} = Pc {} + injector {} + lines {} + valves {}\n",
            b["tank"].as_str().unwrap_or("?"),
            b["fluid"].as_str().unwrap_or("?"),
            f(&b["tank_pressure"], 1e-5, "bar", 2),
            f(&b["chamber_pressure"], 1e-5, "bar", 2),
            f(&b["injector_pressure_drop"], 1e-5, "bar", 2),
            f(&b["line_pressure_drop"], 1e-5, "bar", 2),
            f(&b["valve_pressure_drop"], 1e-5, "bar", 2),
        ));
    }
    for t in d["tanks"].as_array().into_iter().flatten() {
        h.push_str(&format!(
            "  tank {}: {} of {} ({}), ullage {:.0}%, {} -> {}, hoop SF {}\n",
            t["node"].as_str().unwrap_or("?"),
            f(&t["liquid_volume"], 1e3, "L", 2),
            t["fluid"].as_str().unwrap_or("?"),
            f(&t["propellant_mass"], 1.0, "kg", 2),
            t["ullage_fraction"].as_f64().unwrap_or(0.0) * 100.0,
            f(&t["pressure"], 1e-5, "bar", 1),
            f(&t["final_pressure"], 1e-5, "bar", 1),
            t["hoop_safety_factor"]
                .as_f64()
                .map_or("-".to_string(), |x| format!("{x:.2}")),
        ));
    }
    let bd = &d["blowdown"];
    if bd.is_object() {
        h.push_str(&format!(
            "  blowdown: {} burn, {} impulse, avg {}, Pc {} -> {} ({})\n",
            f(&bd["burn_time"], 1.0, "s", 2),
            f(&bd["total_impulse"], 1.0, "N s", 0),
            f(&bd["average_thrust"], 1.0, "N", 0),
            f(&bd["initial_chamber_pressure"], 1e-5, "bar", 2),
            f(&bd["final_chamber_pressure"], 1e-5, "bar", 2),
            bd["end"].as_str().unwrap_or("?"),
        ));
    }
    let missing = v["missing_inputs"].as_array().map_or(0, Vec::len);
    if missing > 0 {
        h.push_str(&format!("missing inputs: {missing}\n"));
    }
    let lines = diag_lines(&v["diagnostics"]);
    for l in &lines {
        h.push_str(&format!("  {l}\n"));
    }
    let errors = v["diagnostics"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|d| d["severity"] == "error");
    Ok(Outcome {
        value: v,
        human: h,
        ok: !errors && missing == 0,
    })
}

/// `rw engine sim <id> [--duration <t>]`: writes the blowdown run.
pub fn sim(opts: &Opts, id: &str, duration: Option<String>) -> CmdResult {
    let mut args = json!({ "engine": id });
    if let Some(d) = duration {
        args["duration"] = json!(d);
    }
    let v = opts.call("engine_simulate", args, None)?;
    let dir = format!(
        "runs/{}/{}",
        v["sim"].as_str().unwrap_or("?"),
        v["run_id"].as_str().unwrap_or("?")
    );
    let cached = if v["cached"] == true { " (cached)" } else { "" };
    let human = format!("engine run {dir}{cached}: engine.json, series.csv\n");
    Ok(Outcome::ok(v, human))
}
