//! `rw` commands (R3.1, M1.30). Each command builds its tool arguments and
//! runs them through [`crate::forward`] (I2, D4): forwarded to the live
//! owner when one holds `.rw/lock`, otherwise on an in-process session.
//!
//! Output: a short human summary in the project's display units (or SI with
//! `--units si`), or the tool output JSON (SI, plus a `units` map) with
//! `--json`. Every edit command (`set`, `add`, `rm`, `mv`, `import`, `motor
//! import`) runs the strict design check after it writes and prints it as a
//! `check --strict: <status>` section; a failing strict check exits 1.
//! Exit codes: 0 clean; 1 failure (check errors, `--strict` warnings,
//! validation errors, `fmt --check` changes, a failed diff or sim, and
//! not-found/conflict errors); 2 usage or I/O (bad arguments, unreadable
//! files, a locked project with no reachable owner).

pub mod cfd;
pub mod check;
pub mod edit;
pub mod engine;
pub mod history;
pub mod interop;
pub mod library;
pub mod motor;
pub mod project;
pub mod sim;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use rw_api::{ApiError, ApiErrorCode, CallCtx};
use serde_json::Value;

use crate::display::{Units, metric_class, with_units};
use crate::forward::{Conn, cli_ctx};

/// Global CLI options.
#[derive(Debug, Clone, Default)]
pub struct Opts {
    /// Print the tool output JSON instead of the human summary.
    pub json: bool,
    /// `--project <dir>`; default: the nearest ancestor of the working
    /// directory holding `rocketwright.toml`.
    pub project: Option<PathBuf>,
    /// `--snapshot-label <title>`: titles the snapshot step an in-process
    /// writer session records on open (unrecorded changes).
    pub snapshot_label: Option<String>,
    /// `--units si|display`: the units of the text output (`--json` is SI).
    pub units: crate::display::UnitsMode,
}

/// What a command produced.
#[derive(Debug, Clone)]
pub struct Outcome {
    /// The tool output (printed with `--json`).
    pub value: Value,
    /// Human summary (printed without `--json`).
    pub human: String,
    /// False → exit 1.
    pub ok: bool,
}

impl Outcome {
    pub fn ok(value: Value, human: String) -> Outcome {
        Outcome {
            value,
            human,
            ok: true,
        }
    }
}

pub type CmdResult = Result<Outcome, ApiError>;

/// A usage error (exit 2).
pub fn usage(message: impl Into<String>) -> ApiError {
    ApiError {
        outcome: None,
        code: ApiErrorCode::InvalidInput,
        message: message.into(),
        hint: None,
        diagnostics: Vec::new(),
    }
}

impl Opts {
    /// The project root (exit 2 when there is none).
    pub fn root(&self) -> Result<PathBuf, ApiError> {
        let start = match &self.project {
            Some(p) => p.clone(),
            None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        };
        rw_project::layout::find_root(&start).ok_or_else(|| {
            let mut e = usage(format!(
                "{} is not inside a RocketWright project (no rocketwright.toml)",
                start.display()
            ));
            e.hint = Some("create one with `rw init`, or pass --project <dir>".into());
            e
        })
    }

    /// The display units of the text output: the project's
    /// `[display_units]` (defaults without a project), or SI with `--units si`.
    pub fn units(&self) -> Units {
        Units::for_project(self.units, self.root().ok().as_deref())
    }

    /// Runs one tool on the project.
    pub fn call(&self, name: &str, args: Value, label: Option<String>) -> Result<Value, ApiError> {
        let root = self.root()?;
        crate::forward::run_with(&root, name, args, label, self.snapshot_label.as_deref())
    }

    /// Opens a connection for several calls (`rw sim`).
    pub fn conn(&self, name: &str) -> Result<(Conn, CallCtx), ApiError> {
        let root = self.root()?;
        Ok((
            Conn::open_with(&root, name, self.snapshot_label.as_deref())?,
            cli_ctx(None),
        ))
    }
}

/// Prints an outcome and maps it to the exit code.
pub fn finish(opts: &Opts, r: CmdResult) -> ExitCode {
    match r {
        Ok(o) => {
            if opts.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&with_units(o.value)).unwrap_or_default()
                );
            } else if !o.human.is_empty() {
                println!("{}", o.human.trim_end());
            }
            if o.ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            }
        }
        Err(e) => fail(opts, &e),
    }
}

/// Prints an error to stderr (JSON with `--json`) and returns its exit code.
pub fn fail(opts: &Opts, e: &ApiError) -> ExitCode {
    if opts.json {
        eprintln!(
            "{}",
            serde_json::to_string(&serde_json::json!({ "error": e })).unwrap_or_default()
        );
    } else {
        eprintln!("error: {}", e.message);
        for d in &e.diagnostics {
            eprintln!("  {}", diag_line(d));
        }
        if let Some(h) = &e.hint {
            eprintln!("hint: {h}");
        }
    }
    ExitCode::from(e.code.exit_code())
}

/// `RW-E021 error rocket.rw.toml /c/fins/span: message (hint)`.
pub fn diag_line(d: &rw_model::Diagnostic) -> String {
    let sev = serde_json::to_value(d.severity)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();
    let mut s = format!("{} {sev}", d.code);
    if let Some(f) = &d.file {
        s.push(' ');
        s.push_str(f);
        if let Some(l) = d.line {
            s.push_str(&format!(":{l}"));
        }
    }
    if let Some(p) = &d.path {
        s.push(' ');
        s.push_str(p);
    }
    s.push_str(": ");
    s.push_str(&d.message);
    if let Some(h) = &d.hint {
        s.push_str(&format!(" (hint: {h})"));
    }
    s
}

/// Diagnostics as lines (from a JSON array).
pub fn diag_lines(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| serde_json::from_value::<rw_model::Diagnostic>(d.clone()).ok())
        .map(|d| diag_line(&d))
        .collect()
}

/// A number with up to `sig` significant figures for humans.
pub fn num(v: &Value) -> String {
    match v.as_f64() {
        Some(x) => fmt_f(x),
        None => "-".into(),
    }
}

pub fn fmt_f(x: f64) -> String {
    let r = rw_check::canon::round_sig(x, 5);
    format!("{r}")
}

/// Splits `key=value`.
pub fn kv(s: &str) -> Result<(String, String), ApiError> {
    let (k, v) = s
        .split_once('=')
        .ok_or_else(|| usage(format!("expected key=value, got `{s}`")))?;
    Ok((k.trim().to_string(), v.trim().to_string()))
}

/// The human summary of a `MutationOut`: the step, the files, and the
/// lenient check delta with every changed metric in display units and its
/// absolute change (`mass.liftoff: 57.405 g -> 59.139 g (+1.734 g)`).
/// `clearance` resolves the dimension of clearance rows (from a check report).
pub fn mutation_human(
    v: &Value,
    units: &Units,
    clearance: Option<&std::collections::BTreeMap<String, rw_check::metrics::Metric>>,
) -> String {
    let mut out = String::new();
    let dry = v["dry_run"].as_bool().unwrap_or(false);
    match (v["step"].as_str(), dry) {
        (_, true) => out.push_str("dry run: nothing written\n"),
        (Some(s), _) => out.push_str(&format!("recorded {s}\n")),
        (None, _) => out.push_str("no change\n"),
    }
    for f in v["files"].as_array().into_iter().flatten() {
        out.push_str(&format!(
            "  {} {}\n",
            f["status"].as_str().unwrap_or("?"),
            f["path"].as_str().unwrap_or("?")
        ));
    }
    let d = &v["delta"];
    // `delta:`, not `check:`: this is the lenient post-edit delta; the strict
    // gate is the `check --strict:` section that follows a written edit.
    out.push_str(&format!(
        "delta: {} (lenient)\n",
        d["status"].as_str().unwrap_or("?")
    ));
    if let Some(ch) = d["changed"].as_object() {
        for (k, pair) in ch {
            let c = metric_class(k, clearance);
            let change = units
                .delta_json(&pair[0], &pair[1], c)
                .map(|x| format!(" ({x})"))
                .unwrap_or_default();
            out.push_str(&format!(
                "  {k}: {} -> {}{change}\n",
                units.num(&pair[0], c),
                units.num(&pair[1], c)
            ));
        }
    }
    for l in diag_lines(&d["new_diagnostics"]) {
        out.push_str(&format!("  new {l}\n"));
    }
    for r in d["resolved_diagnostics"].as_array().into_iter().flatten() {
        out.push_str(&format!("  resolved {}\n", r.as_str().unwrap_or("?")));
    }
    out
}

/// Ok unless the delta has errors.
pub fn mutation_ok(v: &Value) -> bool {
    v["delta"]["status"].as_str() != Some("errors")
}

/// The strict design check an edit command runs after it writes.
#[derive(Debug, Clone)]
pub struct StrictCheck {
    /// The `design_check` report (`strict: true`), or the error that stopped it.
    pub report: Result<Value, ApiError>,
}

impl StrictCheck {
    /// Runs `design_check` with `strict: true` on the project at `opts`.
    pub fn run(opts: &Opts) -> StrictCheck {
        StrictCheck {
            report: opts.call("design_check", serde_json::json!({"strict": true}), None),
        }
    }

    /// `clean`, `warnings`, `errors`, or `not run`.
    pub fn status(&self) -> &str {
        match &self.report {
            Ok(r) => r["status"].as_str().unwrap_or("?"),
            Err(_) => "not run",
        }
    }

    /// True when the strict gate passes (status `clean`).
    pub fn ok(&self) -> bool {
        self.status() == "clean"
    }

    /// The report's metric map (dimensions of clearance rows).
    pub fn metrics(&self) -> Option<std::collections::BTreeMap<String, rw_check::metrics::Metric>> {
        let r = self.report.as_ref().ok()?;
        let report: rw_check::CheckReport = serde_json::from_value(r.clone()).ok()?;
        Some(rw_check::metrics::metric_map(&report))
    }

    /// The `check --strict: <status>` section.
    pub fn human(&self, units: &Units) -> String {
        match &self.report {
            Ok(r) => {
                let mut s = check::report_titled(r, units, "check --strict");
                if !self.ok() {
                    s.push_str("\n  exit 1: the strict check fails (the edit is written; fix it or undo with history_restore)");
                }
                s
            }
            Err(e) => format!("check --strict: not run ({})", e.message),
        }
    }
}

/// The outcome of an edit command: the mutation summary and, when it wrote
/// (not `--dry-run`, not rejected), its own strict check. `--json` output
/// adds `check_strict` (the report) and `check_strict_status`. Exit 1 when
/// the delta has errors or the strict check is not clean.
pub fn mutation_outcome(opts: &Opts, mut v: Value, prefix: &str, suffix: &str) -> Outcome {
    let units = opts.units();
    let dry = v["dry_run"].as_bool().unwrap_or(false);
    let strict = (!dry).then(|| StrictCheck::run(opts));
    let metrics = strict.as_ref().and_then(StrictCheck::metrics);
    let mut human = format!(
        "{prefix}{}{suffix}",
        mutation_human(&v, &units, metrics.as_ref())
    );
    let mut ok = mutation_ok(&v);
    if let Some(sc) = &strict {
        human.push_str(&sc.human(&units));
        human.push('\n');
        ok &= sc.ok();
        if let Value::Object(m) = &mut v {
            m.insert(
                "check_strict_status".into(),
                Value::String(sc.status().into()),
            );
            if let Ok(r) = &sc.report {
                m.insert("check_strict".into(), r.clone());
            }
        }
    }
    Outcome {
        value: v,
        human,
        ok,
    }
}

/// Resolves a path given on the command line against the working directory
/// (absolute when it exists there), else returns it unchanged.
pub fn cli_path(p: &str) -> String {
    let path = Path::new(p);
    if path.is_absolute() {
        return p.to_string();
    }
    match std::env::current_dir() {
        Ok(cwd) if cwd.join(path).exists() => cwd
            .join(path)
            .canonicalize()
            .map(|c| c.display().to_string())
            .unwrap_or_else(|_| p.to_string()),
        _ => p.to_string(),
    }
}
