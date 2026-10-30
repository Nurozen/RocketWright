//! `rw sim <id>`, `rw run summary`, and `rw diff model|run`. Values print in
//! the project's display units with the unit attached.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{Value, json};

use super::{CmdResult, Opts, Outcome, cli_path, kv, usage};
use crate::display::{Class, Units, summary_class, unit_class};

/// How long `rw sim` waits for its job.
pub const SIM_TIMEOUT: Duration = Duration::from_secs(600);

/// Run summary fields: (short name, `summary.json` key, meaning).
pub const SUMMARY_FIELDS: &[(&str, &str, &str)] = &[
    ("apogee", "apogee_m", "highest altitude above the pad"),
    ("max_velocity", "max_velocity_ms", "highest speed"),
    ("max_accel", "max_accel_ms2", "highest acceleration"),
    ("max_mach", "max_mach", "highest Mach number"),
    (
        "time_to_apogee",
        "time_to_apogee_s",
        "time from ignition to apogee",
    ),
    (
        "rail_exit_velocity",
        "rail_exit_velocity_ms",
        "speed leaving the rail",
    ),
    ("burnout_time", "burnout_time_s", "time of motor burnout"),
    (
        "burnout_altitude",
        "burnout_altitude_m",
        "altitude at burnout",
    ),
    (
        "optimum_delay",
        "optimum_delay_s",
        "apogee time minus burnout time",
    ),
    (
        "deployment_velocity",
        "deployment_velocity_ms",
        "speed at the last recovery deployment",
    ),
    (
        "landing_velocity",
        "landing_velocity_ms",
        "speed at landing",
    ),
    (
        "flight_time",
        "flight_time_s",
        "time from ignition to landing",
    ),
    (
        "min_stability",
        "min_stability_cal",
        "lowest stability margin, rail exit to apogee",
    ),
    ("landing_x", "landing_x_m", "landing point east of the pad"),
    ("landing_y", "landing_y_m", "landing point north of the pad"),
    ("drift", "drift_m", "landing distance from the pad"),
    (
        "coast_time",
        "coast_time_s",
        "apogee time minus the last burnout time (coast to apogee)",
    ),
];

/// One derived timing field, printed once per deployment or motor ejection.
pub struct TimingField {
    /// `--fields` name.
    pub name: &'static str,
    /// The `summary.json` list (`deployments`, `ejections`).
    pub list: &'static str,
    /// The entry key in that list.
    pub key: &'static str,
    pub meaning: &'static str,
    /// Words for a negative and a positive value (signed fields).
    pub sign: Option<(&'static str, &'static str)>,
}

/// Derived timing fields. A row reads
/// `deploy_minus_apogee (chute)  -0.43 s (before apogee)`.
pub const TIMING_FIELDS: &[TimingField] = &[
    TimingField {
        name: "deploy_minus_apogee",
        list: "deployments",
        key: "deploy_minus_apogee_s",
        meaning: "deployment time minus apogee time (negative = before apogee)",
        sign: Some(("before apogee", "after apogee")),
    },
    TimingField {
        name: "deploy_altitude",
        list: "deployments",
        key: "deploy_altitude_m",
        meaning: "altitude above the pad at deployment",
        sign: None,
    },
    TimingField {
        name: "deploy_velocity",
        list: "deployments",
        key: "deploy_velocity_ms",
        meaning: "speed at deployment",
        sign: None,
    },
    TimingField {
        name: "ejection_delay",
        list: "ejections",
        key: "delay_s",
        meaning: "configured ejection delay of the motor",
        sign: None,
    },
    TimingField {
        name: "delay_minus_optimum",
        list: "ejections",
        key: "delay_minus_optimum_s",
        meaning: "configured delay minus optimum delay (negative = charge fires before apogee)",
        sign: Some(("charge before apogee", "charge after apogee")),
    },
];

/// The `--fields` long help: every field name (docs-check reads the list
/// after `Fields: ` up to the period).
pub fn fields_help() -> String {
    let names: Vec<&str> = SUMMARY_FIELDS
        .iter()
        .map(|(n, _, _)| *n)
        .chain(TIMING_FIELDS.iter().map(|t| t.name))
        .chain(["events"])
        .collect();
    format!(
        "Comma-separated fields to print (`apogee,max_velocity,events`). Fields: {}.",
        names.join(", ")
    )
}

/// A known `--fields` name: a summary field, a timing field, or `events`.
fn known_field(name: &str) -> bool {
    let n = name.trim();
    n == "events" || summary_field(n).is_some() || TIMING_FIELDS.iter().any(|t| t.name == n)
}

/// The derived timing rows of a summary (`rw sim`, `rw run summary`): every
/// [`TIMING_FIELDS`] row when `only` is `None`, else the named ones.
fn timing_rows(
    s: &Value,
    u: &Units,
    only: Option<&[String]>,
    explain: bool,
) -> (String, Vec<&'static str>) {
    let mut rows: Vec<(String, String, &str)> = Vec::new();
    let mut picked = Vec::new();
    for TimingField {
        name,
        list,
        key,
        meaning,
        sign: words,
    } in TIMING_FIELDS
    {
        if only.is_some_and(|o| !o.iter().any(|f| f.trim() == *name)) {
            continue;
        }
        let entries = s.get(*list).and_then(Value::as_array).into_iter().flatten();
        for e in entries {
            let Some(v) = e.get(*key).and_then(Value::as_f64) else {
                continue;
            };
            let id = e["source"]
                .as_str()
                .map(|r| r.strip_prefix("rw:c/").unwrap_or(r))
                .unwrap_or("?");
            let label = format!("{name} ({id})");
            let mut val = u.fmt(v, summary_class(key));
            if let Some((neg, pos)) = words {
                let shown = if v.abs() < 5e-5 { 0.0 } else { v };
                val = if shown < 0.0 {
                    format!("{val} ({neg})")
                } else if shown > 0.0 {
                    format!("+{val} ({pos})")
                } else {
                    format!("{val} (at apogee)")
                };
            }
            rows.push((label, val, meaning));
            if !picked.contains(name) {
                picked.push(*name);
            }
        }
    }
    // Labels and values are wider than the summary columns: align them.
    let lw = rows.iter().map(|r| r.0.len()).max().unwrap_or(0).max(22);
    let vw = rows.iter().map(|r| r.1.len()).max().unwrap_or(0).max(14);
    let mut out = String::new();
    for (label, val, meaning) in rows {
        if explain {
            out.push_str(&format!("\n  {label:<lw$} {val:<vw$} {meaning}"));
        } else {
            out.push_str(&format!("\n  {label:<lw$} {val}"));
        }
    }
    (out, picked)
}

/// The run-summary rows `rw sim` prints.
const SIM_FIELDS: &[&str] = &[
    "apogee",
    "max_velocity",
    "max_accel",
    "max_mach",
    "time_to_apogee",
    "rail_exit_velocity",
    "deployment_velocity",
    "landing_velocity",
    "flight_time",
    "min_stability",
    "burnout_time",
    "coast_time",
];

/// `apogee` or `apogee_m` → its `SUMMARY_FIELDS` row.
fn summary_field(name: &str) -> Option<&'static (&'static str, &'static str, &'static str)> {
    let n = name.trim();
    SUMMARY_FIELDS.iter().find(|(f, k, _)| *f == n || *k == n)
}

fn summary_rows(s: &Value, u: &Units, fields: &[&str]) -> String {
    let mut out = String::new();
    for f in fields {
        let Some((name, key, _)) = summary_field(f) else {
            continue;
        };
        if let Some(v) = s.get(*key).filter(|v| !v.is_null()) {
            out.push_str(&format!("\n  {name:<22} {}", u.num(v, summary_class(key))));
        }
    }
    out
}

/// `rw sim <sim> [--config] [--force]`: runs (or reuses) a run and waits for it.
pub fn sim(opts: &Opts, id: &str, config: Option<String>, force: bool) -> CmdResult {
    let (mut conn, ctx) = opts.conn("simulate")?;
    let mut args = json!({"sim": id, "force": force});
    if let Some(c) = config {
        args["config"] = json!(c);
    }
    let out = conn.call("simulate", args, &ctx)?;
    let mut value = out.clone();
    let mut ok = true;
    let mut human = String::new();
    if let Some(job) = out["job_id"].as_str().filter(|_| out["cached"] != true) {
        let info = conn.wait_job(job, SIM_TIMEOUT, &ctx)?;
        let state = serde_json::to_value(info.state).unwrap_or_default();
        value["job"] = serde_json::to_value(&info).unwrap_or_default();
        match info.state {
            rw_api::JobState::Complete => {
                value["status"] = json!("complete");
                value["summary"] = serde_json::to_value(&info.summary).unwrap_or_default();
            }
            _ => {
                ok = false;
                value["status"] = json!("failed");
                human.push_str(&format!(
                    "job {job} {}: {}\n",
                    state.as_str().unwrap_or("?"),
                    info.error.as_deref().unwrap_or("did not complete")
                ));
            }
        }
    }
    if ok {
        human.push_str(&format!(
            "run {}/{}{}{}",
            value["sim"].as_str().unwrap_or("?"),
            value["run_id"].as_str().unwrap_or("?"),
            if value["cached"] == true {
                " (cached)"
            } else {
                ""
            },
            summary_rows(&value["summary"], &opts.units(), SIM_FIELDS)
        ));
        human.push_str(&timing_rows(&value["summary"], &opts.units(), None, false).0);
    }
    Ok(Outcome { value, human, ok })
}

/// `rw diff model <a> <b>`.
pub fn diff_model(opts: &Opts, a: &str, b: &str) -> CmdResult {
    let v = opts.call("model_diff", json!({"a": a, "b": b}), None)?;
    let mut h = format!("{} -> {}", a, b);
    for x in v["added"].as_array().into_iter().flatten() {
        h.push_str(&format!("\n  + {}", x.as_str().unwrap_or("?")));
    }
    for x in v["removed"].as_array().into_iter().flatten() {
        h.push_str(&format!("\n  - {}", x.as_str().unwrap_or("?")));
    }
    for c in v["changed"].as_array().into_iter().flatten() {
        h.push_str(&format!(
            "\n  ~ {}: {} -> {}",
            c["path"].as_str().unwrap_or("?"),
            c.get("old").map_or("-".into(), Value::to_string),
            c.get("new").map_or("-".into(), Value::to_string)
        ));
    }
    Ok(Outcome::ok(v, h))
}

/// `rw diff run <a> [b] [--golden <oracle.json>] [--tol key=tol...]`: exit 1
/// when a toleranced key fails or the setup mismatches the golden. Each row
/// prints `a`, `b`, and `a - b` in display units next to `delta %`, the
/// tolerance it was scored with (`none`), and its result (`pass`, `FAIL`,
/// `not gated`, `not scored`); summary lines count the gated keys and name
/// the keys compared without a tolerance.
pub fn diff_run(
    opts: &Opts,
    a: &str,
    b: Option<String>,
    golden: Option<String>,
    tol: &[String],
) -> CmdResult {
    let mut tols = BTreeMap::new();
    for t in tol {
        let (k, v) = kv(t)?;
        let v = if v.chars().all(|c| c.is_ascii_digit() || c == '.') {
            format!("{v}%")
        } else {
            v
        };
        tols.insert(k, v);
    }
    let mut args = json!({"a": a, "tol": tols});
    if let Some(b) = b {
        args["b"] = json!(b);
    }
    if let Some(g) = &golden {
        args["golden"] = json!(cli_path(g));
    }
    let v = opts.call("run_diff", args, None)?;
    let u = opts.units();
    let ok = v["pass"].as_bool().unwrap_or(false);
    let mut h = format!(
        "{} vs {}: {}",
        v["a"].as_str().unwrap_or("?"),
        golden
            .as_deref()
            .unwrap_or_else(|| v["b"].as_str().unwrap_or("?")),
        if ok { "pass" } else { "FAIL" }
    );
    for m in v["mismatches"].as_array().into_iter().flatten() {
        h.push_str(&format!("\n  mismatch {}", m.as_str().unwrap_or("?")));
    }
    // Against a golden, `a` is ours and `b` the golden.
    let (ca, cb) = if golden.is_some() {
        ("a (ours)", "b (golden)")
    } else {
        ("a", "b")
    };
    h.push_str(&format!(
        "\n  {:<24} {:>14} {:>14} {:>14} {:>9} {:>8}  result",
        "key", ca, cb, "a - b", "delta %", "tol"
    ));
    let mismatched = v["mismatches"].as_array().is_some_and(|m| !m.is_empty());
    let (mut gated, mut failed, mut untoleranced) = (0usize, 0usize, Vec::new());
    let mut in_static = false;
    for r in v["rows"].as_array().into_iter().flatten() {
        let key = r["key"].as_str().unwrap_or("?");
        // A golden's static block (CG, CP, CNa, stability) follows the flight
        // rows under its own heading (B3 round 11).
        if !in_static
            && rw_project::session::OR_STATIC_KEYS
                .iter()
                .any(|(_, k)| *k == key)
        {
            in_static = true;
            h.push_str(
                "\n  static (rw check of the run's configuration vs the golden's static block)",
            );
        }
        let tol = r["tol"].as_str();
        let res = match (tol, r.get("pass").and_then(Value::as_bool)) {
            (None, _) => {
                untoleranced.push(key);
                "not gated"
            }
            (Some(_), _) if mismatched => "not scored",
            (Some(_), Some(true)) => {
                gated += 1;
                "pass"
            }
            (Some(_), Some(false)) => {
                gated += 1;
                failed += 1;
                "FAIL"
            }
            (Some(_), None) => "no value",
        };
        let c = unit_class(key, r["unit"].as_str());
        h.push_str(&format!(
            "\n  {:<24} {:>14} {:>14} {:>14} {:>9} {:>8}  {res}",
            key,
            u.num(&r["a"], c),
            u.num(&r["b"], c),
            // `a - b`, the same sign as `delta %` (a relative to b).
            u.delta_json(&r["b"], &r["a"], c)
                .unwrap_or_else(|| "-".into()),
            r["delta_pct"]
                .as_f64()
                .map_or("-".into(), |d| format!("{d:+.2}")),
            r["tol"].as_str().unwrap_or("none"),
        ));
    }
    // Flight phases in time order, both sides, never gated: where the
    // `a - b` gap opens (B3 round 11, T5).
    let phases = v["phases"].as_array().cloned().unwrap_or_default();
    if !phases.is_empty() {
        h.push_str(
            "\n  phases (main-flight events in time order: rail exit, burnout, apogee, deployment, landing; compared, not gated)",
        );
        for r in &phases {
            let key = r["key"].as_str().unwrap_or("?");
            let c = summary_class(key.rsplit('.').next().unwrap_or(key));
            h.push_str(&format!(
                "\n  {:<24} {:>14} {:>14} {:>14} {:>9}",
                key,
                u.num(&r["a"], c),
                u.num(&r["b"], c),
                u.delta_json(&r["b"], &r["a"], c)
                    .unwrap_or_else(|| "-".into()),
                r["delta_pct"]
                    .as_f64()
                    .map_or("-".into(), |d| format!("{d:+.2}")),
            ));
        }
    }
    for n in v["notes"].as_array().into_iter().flatten() {
        h.push_str(&format!("\n  note: {}", n.as_str().unwrap_or("?")));
    }
    // Which keys the verdict rests on, and which were only shown.
    if mismatched {
        h.push_str(
            "\n  not scored: the run's setup differs from the golden (mismatch lines above); fly a matching sim and diff again",
        );
    } else {
        h.push_str(&format!(
            "\n  gated: {gated} key(s) with a tolerance, {} pass, {failed} FAIL",
            gated - failed
        ));
    }
    if !untoleranced.is_empty() {
        h.push_str(&format!(
            "\n  no tolerance (compared, not gated): {}",
            untoleranced.join(", ")
        ));
        if golden.is_none() {
            h.push_str("; gate a key with --tol <key>=<tol>");
        }
    }
    Ok(Outcome {
        value: v,
        human: h,
        ok,
    })
}

/// `rw run summary [<run>] [--fields [list]]`: a finished run's summary
/// fields and flight events in display units, read from `runs/<sim>/<id>/`.
/// `--fields a,b` prints only those (`events` for the event table);
/// `--fields` alone also prints each field's meaning.
pub fn run_summary(opts: &Opts, run: Option<String>, fields: Option<Option<String>>) -> CmdResult {
    let root = opts.root()?;
    let store = rw_project::RunStore::new(&root);
    let (mut run, mut list) = (run, fields);
    // `rw run summary --fields baseline`: a lone non-field value is the run.
    if let (None, Some(Some(l))) = (&run, &list)
        && !l
            .split(',')
            .all(|f| f.trim() == "events" || summary_field(f).is_some())
        && store.find(l).is_some()
    {
        run = Some(l.clone());
        list = Some(None);
    }
    let Some(r) = run else {
        let mut e = usage("rw run summary needs a run: <sim>/<run-id>, <run-id>, or a sim id");
        e.hint = Some("list runs with `rw call run_list`; fly one with `rw sim <sim>`".into());
        return Err(e);
    };
    let m = store.find(&r).ok_or_else(|| {
        let mut e = usage(format!("no run `{r}`"));
        e.code = rw_api::ApiErrorCode::NotFound;
        e.hint = Some(
            "run refs are <run-id>, <sim>/<run-id>, rw:run/<id>, or a sim id (its latest run); fly one with `rw sim <sim>`"
                .into(),
        );
        e
    })?;
    let io = |what: &str, e: std::io::Error| {
        let mut x = usage(format!("{what} of run {}/{}: {e}", m.sim, m.run_id));
        x.code = rw_api::ApiErrorCode::Io;
        x
    };
    let summary = store
        .summary(&m.sim, &m.run_id)
        .map_err(|e| io("summary", e))?;
    let events: Vec<rw_sim::FlightEvent> = std::fs::read_to_string(
        store
            .dir(&m.sim, &m.run_id)
            .join(rw_project::runs::EVENTS_FILE),
    )
    .ok()
    .and_then(|t| serde_json::from_str::<rw_sim::RunEvents>(&t).ok())
    .map(|e| e.events)
    .unwrap_or_default();
    let selected: Vec<String> = match &list {
        Some(Some(l)) => l
            .split(',')
            .map(|f| f.trim().to_string())
            .filter(|f| !f.is_empty())
            .collect(),
        _ => Vec::new(),
    };
    for f in &selected {
        if !known_field(f) {
            let names: Vec<&str> = SUMMARY_FIELDS
                .iter()
                .map(|(n, _, _)| *n)
                .chain(TIMING_FIELDS.iter().map(|t| t.name))
                .collect();
            let mut e = usage(format!("unknown summary field `{f}`"));
            e.hint = Some(format!("fields: {}, events", names.join(", ")));
            return Err(e);
        }
    }
    let explain = matches!(list, Some(None));
    let all = selected.is_empty();
    let u = opts.units();
    let sv = serde_json::to_value(&summary).unwrap_or_default();
    let mut h = format!(
        "run {}/{} (sim {}, config {})",
        m.sim, m.run_id, m.sim_name, m.config
    );
    let mut picked = Vec::new();
    for (name, key, meaning) in SUMMARY_FIELDS {
        if !all
            && !selected
                .iter()
                .any(|f| summary_field(f).is_some_and(|x| x.0 == *name))
        {
            continue;
        }
        let Some(v) = sv.get(*key).filter(|v| !v.is_null()) else {
            continue;
        };
        picked.push(*name);
        let val = u.num(v, summary_class(key));
        if explain {
            h.push_str(&format!("\n  {name:<22} {val:<14} {meaning}"));
        } else {
            h.push_str(&format!("\n  {name:<22} {val}"));
        }
    }
    let (rows, timing) = timing_rows(&sv, &u, (!all).then_some(selected.as_slice()), explain);
    h.push_str(&rows);
    picked.extend(timing);
    let show_events = all || selected.iter().any(|f| f == "events");
    if show_events && !events.is_empty() {
        h.push_str("\nevents");
        let (t, alt, vel) = (
            Class::Dim(rw_units::DimKind::Time),
            Class::Altitude,
            Class::Dim(rw_units::DimKind::Velocity),
        );
        for e in &events {
            let kind = serde_json::to_value(e.kind)
                .ok()
                .and_then(|k| k.as_str().map(String::from))
                .unwrap_or_default();
            let kind = match &e.branch {
                Some(b) => format!("{kind} ({b})"),
                None => kind,
            };
            h.push_str(&format!(
                "\n  {kind:<22} t {}, altitude {}, velocity {}",
                u.fmt(e.t, t),
                u.fmt(e.altitude, alt),
                u.fmt(e.velocity, vel)
            ));
        }
    }
    let value = json!({
        "run": format!("{}/{}", m.sim, m.run_id),
        "sim": m.sim,
        "sim_name": m.sim_name,
        "config": m.config,
        "model_hash": m.model_hash,
        "fields": picked,
        "summary": sv,
        "events": serde_json::to_value(&events).unwrap_or_default(),
    });
    Ok(Outcome::ok(value, h))
}
