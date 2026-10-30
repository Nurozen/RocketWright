//! How a tool reads in a host's chat (CPW1R4B): its MCP `title` (sentence
//! case, a short verb phrase, never the raw `name`) and, on every result, a
//! one-line `_meta["lecturn/summary"]` saying what that call found
//! ("Flight · Apogee 305 m", "3 candidates", "Needs approval"). Lecturn shows the row
//! as `Find motors · 3 candidates`; it drops a summary over
//! [`MAX_SUMMARY`] characters or with control characters, so
//! [`summary`] always returns one clipped plain line.

use rw_api::{ApiError, ApiErrorCode, ErrorOutcome};
use serde_json::Value;

/// Result `_meta` key Lecturn reads for a tool row's secondary text.
pub const SUMMARY: &str = "lecturn/summary";
/// Lecturn's caps (`MAX_APP_TOOL_TITLE_LENGTH`, `MAX_APP_TOOL_SUMMARY_LENGTH`).
pub const MAX_TITLE: usize = 80;
pub const MAX_SUMMARY: usize = 120;

/// Every MCP tool's display title, the app-only ones included.
pub const TITLES: &[(&str, &str)] = &[
    ("project_create", "Create project"),
    ("project_validate", "Validate project"),
    ("model_get", "Read model"),
    ("model_patch", "Edit model"),
    ("component_add", "Add component"),
    ("component_remove", "Remove component"),
    ("design_check", "Check design"),
    ("render", "Render view"),
    ("library_search", "Search library"),
    ("motor_search", "Find motors"),
    ("simulate", "Run simulation"),
    ("job_status", "Check run"),
    ("job_cancel", "Cancel run"),
    ("run_list", "List runs"),
    ("run_diff", "Compare runs"),
    ("model_diff", "Compare models"),
    ("history_list", "List history"),
    ("history_show", "Show history step"),
    ("history_compare", "Compare versions"),
    ("history_tag", "Tag revision"),
    ("history_restore", "Restore version"),
    ("import_file", "Import file"),
    ("export_file", "Export file"),
    ("schema_get", "Read schema"),
    ("engine_design", "Size engine"),
    ("engine_simulate", "Simulate engine"),
    ("cfd_import", "Import CFD data"),
    ("run_series", "Read run samples"),
    ("render_picture", "Load render"),
];

/// The display title of tool `name`.
pub fn title(name: &str) -> Option<&'static str> {
    TITLES.iter().find(|(n, _)| *n == name).map(|(_, t)| *t)
}

/// One line of plain text, at most [`MAX_SUMMARY`] characters.
pub fn clip(text: &str) -> String {
    let line = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if line.chars().count() <= MAX_SUMMARY {
        return line;
    }
    let mut cut: String = line.chars().take(MAX_SUMMARY - 1).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
}

/// The summary of one call of tool `name` with `args`: what it found, or a
/// short failure phrase.
pub fn summary(name: &str, args: &Value, outcome: Result<&Value, &ApiError>) -> String {
    clip(&match outcome {
        Ok(out) => success(name, args, out),
        Err(e) => failure(e),
    })
}

fn failure(e: &ApiError) -> String {
    match e.code {
        ApiErrorCode::ApprovalRequired => "Needs approval",
        ApiErrorCode::NotImplemented => "Not available yet",
        ApiErrorCode::InvalidInput => "Invalid input",
        ApiErrorCode::NotFound => "Not found",
        ApiErrorCode::Locked => "Project is locked",
        ApiErrorCode::Io => "File error",
        ApiErrorCode::Conflict => "Conflict",
        ApiErrorCode::Unavailable if e.outcome == Some(ErrorOutcome::Unknown) => "Outcome unknown",
        ApiErrorCode::Unavailable => "Project unavailable",
        ApiErrorCode::Internal => "Failed",
    }
    .to_string()
}

/// `1 run`, `3 runs`.
fn count(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn len(v: &Value, key: &str) -> usize {
    v.get(key).and_then(Value::as_array).map_or(0, Vec::len)
}

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn dry_run(out: &Value) -> bool {
    out.get("dry_run").and_then(Value::as_bool) == Some(true)
}

/// `step:5` → `step 5`; other versions as they are.
fn version(v: &str) -> String {
    v.strip_prefix("step:")
        .map_or_else(|| v.to_string(), |n| format!("step {n}"))
}

/// `Iso view`, `Section view`.
fn view(v: &str) -> String {
    let mut c = v.chars();
    c.next().map_or_else(String::new, |f| {
        format!("{}{} view", f.to_uppercase(), c.as_str())
    })
}

/// `Apogee 305 m` from a `RunSummary`.
fn apogee(summary: Option<&Value>) -> Option<String> {
    let m = summary?.get("apogee_m")?.as_f64()?;
    Some(format!("Apogee {m:.0} m"))
}

/// ` · apogee +12%` from metric rows (`MetricDiffRow`).
fn apogee_change(rows: Option<&Value>) -> String {
    rows.and_then(Value::as_array)
        .and_then(|r| r.iter().find(|x| x["key"] == "apogee_m"))
        .and_then(|x| x["delta_pct"].as_f64())
        .map_or_else(String::new, |p| format!(" · apogee {p:+.0}%"))
}

/// The design check's summary, counting what the header's Check model
/// badge counts (`app/apps/web/src/state/status.ts` `ofCheck`): errors when
/// any, else missing inputs (`RW-W200`..`RW-W249`), else warnings.
fn check_summary(out: &Value) -> String {
    if out["status"] == "clean" {
        return "Clean".into();
    }
    let diags = out["diagnostics"].as_array().map_or(&[][..], Vec::as_slice);
    let warning = |d: &&Value| d["severity"] == "warning";
    let errors = diags.iter().filter(|d| d["severity"] == "error").count();
    let missing = diags
        .iter()
        .filter(warning)
        .filter(|d| d["code"].as_str().is_some_and(is_missing_input))
        .count();
    let warnings = diags.iter().filter(warning).count();
    if errors > 0 {
        count(errors, "error", "errors")
    } else if missing > 0 {
        count(missing, "missing input", "missing inputs")
    } else if warnings > 0 {
        count(warnings, "warning", "warnings")
    } else if out["status"] == "warnings" || out["status"] == "errors" {
        count(1, "issue", "issues")
    } else {
        "Clean".into()
    }
}

/// Liquid missing-input diagnostics: `RW-W200`..`RW-W249` (I9).
fn is_missing_input(code: &str) -> bool {
    code.strip_prefix("RW-W")
        .filter(|n| n.len() == 3)
        .and_then(|n| n.parse::<u16>().ok())
        .is_some_and(|n| (200..=249).contains(&n))
}

/// ` · 1 new issue` from a `CheckDelta`.
fn new_issues(out: &Value) -> String {
    match len(&out["delta"], "new_diagnostics") {
        0 => String::new(),
        n => format!(" · {}", count(n, "new issue", "new issues")),
    }
}

/// A mutation (`MutationOut`): what changed, or that nothing did.
fn mutation(out: &Value, done: String, planned: &str) -> String {
    if dry_run(out) {
        format!("Dry run · {planned}")
    } else if out.get("step").is_none_or(Value::is_null) {
        "No change".into()
    } else {
        format!("{done}{}", new_issues(out))
    }
}

/// A run's state: the apogee when it has one, else its status.
fn run_state(status: &str, summary: Option<&Value>, progress: Option<f64>) -> String {
    match status {
        "complete" => apogee(summary).unwrap_or_else(|| "Complete".into()),
        "running" => progress.filter(|p| *p > 0.0).map_or_else(
            || "Running".into(),
            |p| format!("Running · {:.0}%", p * 100.0),
        ),
        "queued" => "Queued".into(),
        "failed" => "Run failed".into(),
        "cancelled" => "Cancelled".into(),
        "outdated" => "Outdated".into(),
        "not_run" => "Not run".into(),
        other => other.to_string(),
    }
}

/// `study_01` → `Study 01`: a sim id as words.
fn sim_words(id: &str) -> String {
    let words: Vec<&str> = id
        .split(['_', '-', ' '])
        .filter(|w| !w.is_empty())
        .collect();
    let mut out = words.join(" ");
    if let Some(f) = out.chars().next() {
        out.replace_range(..f.len_utf8(), &f.to_uppercase().to_string());
    }
    out
}

/// `simulate` runs a flight or a visual flow (tank) study under one title
/// (POL): the kind leads the summary. A study's run is complete at once
/// with no summary (no flight to summarize); a flight's complete run always
/// carries one.
fn simulate_summary(args: &Value, out: &Value) -> String {
    let status = text(out, "status").unwrap_or("complete");
    let started = text(out, "job_id").is_some() && status != "complete";
    let summary = out.get("summary").filter(|s| !s.is_null());
    let sim = text(out, "sim").or_else(|| text(args, "sim"));
    match sim {
        Some(sim) if out["status"] == "complete" && summary.is_none() && !started => {
            format!("Tank study · {}", sim_words(sim))
        }
        _ if started => "Flight · Started".into(),
        _ => format!("Flight · {}", run_state(status, summary, None)),
    }
}

fn success(name: &str, args: &Value, out: &Value) -> String {
    match name {
        "project_create" => {
            let files = count(len(out, "files"), "file", "files");
            if dry_run(out) {
                format!("Dry run · {files}")
            } else {
                format!("Created · {files}")
            }
        }
        "project_validate" => {
            if out["ok"] == true {
                format!("Valid · {}", count(len(out, "files"), "file", "files"))
            } else {
                count(len(out, "diagnostics").max(1), "issue", "issues")
            }
        }
        "model_get" => text(out, "path").map_or_else(|| "Whole model".into(), str::to_string),
        "model_patch" => {
            let fields = count(len(args, "ops"), "field", "fields");
            mutation(out, format!("{fields} changed"), &fields)
        }
        "component_add" => {
            let id = text(args, "id").unwrap_or("component");
            mutation(out, format!("Added {id}"), &format!("add {id}"))
        }
        "component_remove" => {
            let id = text(args, "id").unwrap_or("component");
            mutation(out, format!("Removed {id}"), &format!("remove {id}"))
        }
        "history_restore" => {
            let v = text(args, "version").map_or_else(|| "version".into(), version);
            mutation(out, format!("Restored {v}"), &format!("restore {v}"))
        }
        "import_file" => {
            let items = count(len(out, "imported"), "item", "items");
            mutation(out, format!("{items} imported"), &items)
        }
        "cfd_import" => mutation(out, "Dataset imported".into(), "dataset"),
        "design_check" => check_summary(out),
        "render" => text(out, "view").map_or_else(|| "Rendered".into(), view),
        "library_search" => count(len(out, "items"), "item", "items"),
        "motor_search" => count(len(out, "motors"), "candidate", "candidates"),
        "simulate" => simulate_summary(args, out),
        "engine_simulate" => {
            let s = run_state(
                text(out, "status").unwrap_or("complete"),
                out.get("summary"),
                None,
            );
            match text(out, "job_id") {
                Some(_) if out["status"] != "complete" => "Started".into(),
                _ => s,
            }
        }
        "job_status" | "job_cancel" => match text(out, "state") {
            Some("failed") => text(out, "error")
                .map_or_else(|| "Run failed".into(), |e| format!("Run failed · {e}")),
            Some(state) => run_state(state, out.get("summary"), out["progress"].as_f64()),
            None => "Checked".into(),
        },
        "run_list" => count(len(out, "runs"), "run", "runs"),
        "run_diff" => format!("2 runs{}", apogee_change(out.get("rows"))),
        "history_compare" => format!("2 versions{}", apogee_change(out.get("metrics"))),
        "model_diff" => match len(out, "added") + len(out, "removed") + len(out, "changed") {
            0 => "No changes".into(),
            n => count(n, "change", "changes"),
        },
        "history_list" => count(len(out, "steps"), "step", "steps"),
        "history_show" => {
            let step = &out["step"];
            let seq = step["seq"].as_u64().map(|n| format!("Step {n}"));
            match (seq, text(step, "title")) {
                (Some(s), Some(t)) => format!("{s} · {t}"),
                (Some(s), None) => s,
                (None, Some(t)) => t.to_string(),
                (None, None) => "Step".into(),
            }
        }
        "history_tag" => text(out, "name").map_or_else(
            || {
                out["number"]
                    .as_u64()
                    .map_or_else(|| "Tagged".into(), |n| format!("Rev {n:02}"))
            },
            str::to_string,
        ),
        "export_file" => {
            let path = text(out, "path").unwrap_or("file");
            let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
            format!("Saved {file}")
        }
        "schema_get" => match (
            out.get("schema").filter(|s| !s.is_null()),
            text(args, "name"),
        ) {
            (Some(_), Some(n)) => n.to_string(),
            _ => count(len(out, "names"), "schema", "schemas"),
        },
        "engine_design" => {
            let missing = match len(out, "missing_inputs") {
                0 => None,
                n => Some(format!("{} missing", count(n, "input", "inputs"))),
            };
            match (out["performance"]["isp_vac"].as_f64(), missing) {
                (Some(isp), Some(m)) => format!("Isp {isp:.0} s vacuum · {m}"),
                (Some(isp), None) => format!("Isp {isp:.0} s vacuum"),
                (None, Some(m)) => m,
                (None, None) => "No performance".into(),
            }
        }
        "run_series" => count(
            out["points"].as_u64().unwrap_or(0) as usize,
            "sample",
            "samples",
        ),
        "render_picture" => "Picture loaded".into(),
        _ => "Done".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok(name: &str, args: Value, out: Value) -> String {
        summary(name, &args, Ok(&out))
    }

    fn err(code: ApiErrorCode, outcome: Option<ErrorOutcome>) -> String {
        let e = ApiError {
            outcome,
            code,
            message: "boom\nsecond line".into(),
            hint: None,
            diagnostics: Vec::new(),
        };
        summary("simulate", &json!({}), Err(&e))
    }

    fn mutation_out(step: Option<&str>, dry: bool, new: usize) -> Value {
        json!({
            "step": step, "model_hash": "h", "dry_run": dry, "files": ["rocketwright.toml"],
            "delta": {"status": "clean", "model_hash": "h", "changed": {},
                      "new_diagnostics": vec![json!({"code": "W", "severity": "warning", "message": "m"}); new],
                      "resolved_diagnostics": []},
        })
    }

    fn rows(pct: f64) -> Value {
        json!([{"key": "max_mach", "delta_pct": 3.0}, {"key": "apogee_m", "a": 1.0, "b": 2.0, "delta_pct": pct}])
    }

    /// One summary per tool, in its successful and its failed form.
    #[test]
    fn every_tool_says_what_it_found() {
        let none = json!({});
        let cases: Vec<(&str, Value, Value, &str)> = vec![
            (
                "project_create",
                json!({"template": "x"}),
                json!({"step": "step:1", "dry_run": false, "files": ["a", "b"]}),
                "Created · 2 files",
            ),
            (
                "project_create",
                none.clone(),
                json!({"dry_run": true, "files": ["a"]}),
                "Dry run · 1 file",
            ),
            (
                "project_validate",
                none.clone(),
                json!({"ok": true, "files": ["a", "b", "c"], "diagnostics": []}),
                "Valid · 3 files",
            ),
            (
                "project_validate",
                none.clone(),
                json!({"ok": false, "files": [], "diagnostics": [{}, {}]}),
                "2 issues",
            ),
            (
                "model_get",
                none.clone(),
                json!({"model_hash": "h", "path": ""}),
                "Whole model",
            ),
            (
                "model_get",
                json!({"path": "/c/fins"}),
                json!({"model_hash": "h", "path": "/c/fins"}),
                "/c/fins",
            ),
            (
                "model_patch",
                json!({"ops": [{}, {}]}),
                mutation_out(Some("step:3"), false, 0),
                "2 fields changed",
            ),
            (
                "model_patch",
                json!({"ops": [{}]}),
                mutation_out(Some("step:3"), false, 1),
                "1 field changed · 1 new issue",
            ),
            (
                "model_patch",
                json!({"ops": [{}, {}]}),
                mutation_out(None, true, 0),
                "Dry run · 2 fields",
            ),
            (
                "model_patch",
                json!({"ops": [{}]}),
                mutation_out(None, false, 0),
                "No change",
            ),
            (
                "component_add",
                json!({"id": "nose"}),
                mutation_out(Some("step:2"), false, 2),
                "Added nose · 2 new issues",
            ),
            (
                "component_remove",
                json!({"id": "fins"}),
                mutation_out(Some("step:2"), false, 0),
                "Removed fins",
            ),
            (
                "history_restore",
                json!({"version": "step:2"}),
                mutation_out(Some("step:6"), false, 0),
                "Restored step 2",
            ),
            (
                "import_file",
                none.clone(),
                json!({"step": "step:2", "dry_run": false, "imported": ["a", "b", "c"], "delta": {}}),
                "3 items imported",
            ),
            (
                "cfd_import",
                none.clone(),
                mutation_out(Some("step:2"), false, 0),
                "Dataset imported",
            ),
            (
                "design_check",
                none.clone(),
                json!({"status": "clean", "diagnostics": []}),
                "Clean",
            ),
            (
                "design_check",
                none.clone(),
                json!({"status": "warnings", "diagnostics": [{"severity": "warning"}, {"severity": "error"}, {"severity": "info"}]}),
                "1 error",
            ),
            (
                // The seeded research vehicle: two missing engine inputs and
                // a T/W warning; the header badge counts the missing inputs.
                "design_check",
                none.clone(),
                json!({"status": "warnings", "diagnostics": [
                    {"severity": "warning", "code": "RW-W210"},
                    {"severity": "warning", "code": "RW-W211"},
                    {"severity": "warning", "code": "RW-W102"},
                ]}),
                "2 missing inputs",
            ),
            (
                "design_check",
                none.clone(),
                json!({"status": "warnings", "diagnostics": [
                    {"severity": "warning", "code": "RW-W102"},
                    {"severity": "warning", "code": "RW-W250"},
                    {"severity": "info", "code": "RW-I001"},
                ]}),
                "2 warnings",
            ),
            (
                "design_check",
                none.clone(),
                json!({"status": "errors", "diagnostics": []}),
                "1 issue",
            ),
            (
                "render",
                none.clone(),
                json!({"view": "section", "path": "renders/x.png"}),
                "Section view",
            ),
            (
                "library_search",
                none.clone(),
                json!({"items": [{}]}),
                "1 item",
            ),
            (
                "motor_search",
                none.clone(),
                json!({"motors": [{}, {}, {}]}),
                "3 candidates",
            ),
            (
                "simulate",
                none.clone(),
                json!({"sim": "s", "run_id": "r", "status": "complete", "cached": true, "summary": {"apogee_m": 305.23}}),
                "Flight · Apogee 305 m",
            ),
            (
                "simulate",
                none.clone(),
                json!({"sim": "s", "run_id": "r", "status": "running", "cached": false, "job_id": "j1"}),
                "Flight · Started",
            ),
            (
                // A visual flow study: complete at once, no flight summary (POL).
                "simulate",
                json!({"sim": "study_01"}),
                json!({"sim": "study_01", "run_id": "r", "status": "complete", "cached": false, "job_id": null, "summary": null}),
                "Tank study · Study 01",
            ),
            (
                "simulate",
                none.clone(),
                json!({"sim": "s", "run_id": "r", "status": "outdated", "cached": true, "summary": {"apogee_m": 12.0}}),
                "Flight · Outdated",
            ),
            (
                "engine_simulate",
                none.clone(),
                json!({"sim": "engine.demo", "run_id": "r", "status": "complete", "cached": false, "job_id": null}),
                "Complete",
            ),
            (
                "job_status",
                none.clone(),
                json!({"job_id": "j", "state": "running", "progress": 0.4}),
                "Running · 40%",
            ),
            (
                "job_status",
                none.clone(),
                json!({"job_id": "j", "state": "complete", "progress": 1.0, "summary": {"apogee_m": 412.6}}),
                "Apogee 413 m",
            ),
            (
                "job_status",
                none.clone(),
                json!({"job_id": "j", "state": "failed", "error": "diverged"}),
                "Run failed · diverged",
            ),
            (
                "job_cancel",
                none.clone(),
                json!({"job_id": "j", "state": "cancelled", "progress": 0.2}),
                "Cancelled",
            ),
            (
                "run_list",
                none.clone(),
                json!({"model_hash": "h", "runs": [{}, {}]}),
                "2 runs",
            ),
            (
                "run_diff",
                none.clone(),
                json!({"a": "x", "b": "y", "rows": rows(12.3), "pass": true}),
                "2 runs · apogee +12%",
            ),
            (
                "run_diff",
                none.clone(),
                json!({"a": "x", "b": "y", "rows": [], "pass": true}),
                "2 runs",
            ),
            (
                "history_compare",
                none.clone(),
                json!({"a": "step:2", "b": "step:3", "metrics": rows(-4.2)}),
                "2 versions · apogee -4%",
            ),
            (
                "model_diff",
                none.clone(),
                json!({"added": ["a"], "removed": [], "changed": [{}, {}]}),
                "3 changes",
            ),
            (
                "model_diff",
                none.clone(),
                json!({"added": [], "removed": [], "changed": []}),
                "No changes",
            ),
            (
                "history_list",
                none.clone(),
                json!({"steps": [{}, {}, {}, {}], "revisions": []}),
                "4 steps",
            ),
            (
                "history_show",
                none.clone(),
                json!({"step": {"seq": 4, "title": "Flight runs"}, "diff": {}}),
                "Step 4 · Flight runs",
            ),
            (
                "history_tag",
                none.clone(),
                json!({"number": 3, "name": "Rev 03", "step": 5, "id": "r"}),
                "Rev 03",
            ),
            (
                "export_file",
                none.clone(),
                json!({"path": "exports/vehicle.ork", "bytes": 10, "sha256": "x"}),
                "Saved vehicle.ork",
            ),
            (
                "schema_get",
                none.clone(),
                json!({"names": ["a", "b"]}),
                "2 schemas",
            ),
            (
                "schema_get",
                json!({"name": "check-report"}),
                json!({"names": [], "schema": {}}),
                "check-report",
            ),
            (
                "engine_design",
                none.clone(),
                json!({"engine": "demo", "performance": {"isp_vac": 291.4}, "missing_inputs": [], "diagnostics": []}),
                "Isp 291 s vacuum",
            ),
            (
                "engine_design",
                none.clone(),
                json!({"engine": "demo", "missing_inputs": ["a", "b"], "diagnostics": []}),
                "2 inputs missing",
            ),
            (
                "engine_design",
                none.clone(),
                json!({"engine": "demo", "performance": {"isp_vac": 253.3}, "missing_inputs": ["a"], "diagnostics": []}),
                "Isp 253 s vacuum · 1 input missing",
            ),
            (
                "run_series",
                none.clone(),
                json!({"points": 400, "samples": 1200}),
                "400 samples",
            ),
            (
                "render_picture",
                none.clone(),
                json!({"path": "renders/x.png", "bytes": 3}),
                "Picture loaded",
            ),
        ];
        for (name, args, out, want) in cases {
            assert!(title(name).is_some(), "{name} has no title");
            assert_eq!(ok(name, args, out), want, "{name}");
        }
        assert_eq!(err(ApiErrorCode::ApprovalRequired, None), "Needs approval");
        assert_eq!(err(ApiErrorCode::NotImplemented, None), "Not available yet");
        assert_eq!(err(ApiErrorCode::InvalidInput, None), "Invalid input");
        assert_eq!(err(ApiErrorCode::NotFound, None), "Not found");
        assert_eq!(err(ApiErrorCode::Locked, None), "Project is locked");
        assert_eq!(err(ApiErrorCode::Io, None), "File error");
        assert_eq!(err(ApiErrorCode::Conflict, None), "Conflict");
        assert_eq!(
            err(ApiErrorCode::Unavailable, Some(ErrorOutcome::Unknown)),
            "Outcome unknown"
        );
        assert_eq!(err(ApiErrorCode::Unavailable, None), "Project unavailable");
        assert_eq!(err(ApiErrorCode::Internal, None), "Failed");
    }

    /// Every tool, on odd and empty results and on long free text, still
    /// answers one line within Lecturn's cap.
    #[test]
    fn summaries_are_one_short_line() {
        let long = "x".repeat(400);
        let nasty = format!("line one\nline two\t{long}\u{7}");
        let outs = [
            json!({}),
            json!(null),
            json!({"path": nasty, "view": nasty, "name": nasty, "error": nasty, "state": "failed",
                   "step": {"seq": 1, "title": nasty}, "status": nasty}),
        ];
        let args = json!({"id": nasty, "version": nasty, "name": nasty, "ops": []});
        for (name, _) in TITLES {
            for out in &outs {
                let s = ok(name, args.clone(), out.clone());
                assert!(!s.is_empty(), "{name}");
                assert!(s.chars().count() <= MAX_SUMMARY, "{name}: {s}");
                assert!(!s.chars().any(char::is_control), "{name}: {s:?}");
                assert_eq!(s, s.trim(), "{name}");
            }
        }
        assert_eq!(clip(&nasty).chars().count(), MAX_SUMMARY);
        assert!(clip(&nasty).ends_with('…'));
        assert_eq!(clip("  a \n b  "), "a b");
    }

    #[test]
    fn titles_are_short_sentence_case_phrases() {
        let mut seen = std::collections::BTreeSet::new();
        for (name, t) in TITLES {
            assert!(seen.insert(*name), "{name} listed twice");
            assert!(t.chars().count() <= MAX_TITLE, "{name}");
            assert_ne!(t, name, "{name}");
            assert!(!t.contains('_'), "{name}: {t}");
            let first = t.chars().next().unwrap();
            assert!(first.is_uppercase(), "{name}: {t}");
            // Sentence case: no capital after the first word, but for initialisms (CFD).
            for w in t.split(' ').skip(1) {
                let all_caps = w.chars().all(|c| c.is_uppercase());
                assert!(
                    all_caps || w.chars().next().unwrap().is_lowercase(),
                    "{name}: {t}"
                );
            }
        }
    }
}
