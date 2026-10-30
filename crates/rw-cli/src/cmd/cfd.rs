//! `rw cfd import <file|dir> [--study <id>] [--dry-run]` (spec R6.15, plan
//! M5.4): the `cfd_import` tool. It parses the CSV step(s) and writes the
//! run record `runs/cfd.<id>/<run>/cfd.json` (`provenance = cfd`); the
//! model is untouched, so there is no strict check to run.

use serde_json::json;

use super::{CmdResult, Opts, Outcome, cli_path};

/// `rw cfd import`.
pub fn import(opts: &Opts, path: &str, study: Option<String>, dry_run: bool) -> CmdResult {
    let mut args = json!({ "path": cli_path(path), "dry_run": dry_run });
    if let Some(s) = study {
        args["study"] = json!(s);
    }
    let v = opts.call("cfd_import", args, None)?;
    Ok(Outcome::ok(v.clone(), human(&v)))
}

/// The human summary: where the record went, the steps, and each scalar's
/// range over the dataset (as stored, SI or the file's units).
fn human(v: &serde_json::Value) -> String {
    let d = &v["dataset"];
    let dir = format!(
        "runs/{}/{}",
        d["sim"].as_str().unwrap_or("?"),
        d["run_id"].as_str().unwrap_or("?")
    );
    let mut h = String::new();
    let wrote = v["files"].as_array().is_some_and(|f| !f.is_empty());
    if v["dry_run"] == true {
        h.push_str(&format!(
            "dry run: nothing written (would write {dir}/cfd.json)\n"
        ));
    } else if wrote {
        h.push_str(&format!(
            "imported CFD dataset `{}` -> {dir}/cfd.json\n",
            d["id"].as_str().unwrap_or("?")
        ));
    } else {
        h.push_str(&format!("already imported: {dir}/cfd.json (same files)\n"));
    }
    let times: Vec<String> = d["times"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| format!("{} s", t))
        .collect();
    h.push_str(&format!(
        "  steps: {} (t = {})\n  points: {}{}\n  provenance: {} (display only; never an engineering result)\n",
        times.len(),
        times.join(", "),
        d["point_count"],
        if d["has_velocity"] == true { ", with velocity vx,vy,vz (m/s)" } else { "" },
        d["provenance"].as_str().unwrap_or("?"),
    ));
    for s in d["scalars"].as_array().into_iter().flatten() {
        let unit = match s["unit"].as_str() {
            Some("1") => " (dimensionless)".to_string(),
            Some(u) => format!(" {u}"),
            None => String::new(),
        };
        h.push_str(&format!(
            "  scalar {}: {} .. {}{unit}\n",
            s["name"].as_str().unwrap_or("?"),
            s["min"],
            s["max"]
        ));
    }
    for f in d["files"].as_array().into_iter().flatten() {
        h.push_str(&format!("  file {}\n", f.as_str().unwrap_or("?")));
    }
    h.push_str("model: unchanged (no history step)\n");
    h
}
