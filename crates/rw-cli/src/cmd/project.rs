//! `rw init`, `rw fmt`, `rw validate`, `rw eval`, `rw schema`.

use std::path::PathBuf;

use rw_api::ProjectCreateIn;
use serde_json::{Value, json};

use super::{CmdResult, Opts, Outcome, diag_lines, mutation_outcome, usage};
use crate::display::{Class, display_tree, field_class};

/// `rw init [dir] [--template <name>] [--name <name>] [--dry-run]`.
pub fn init(
    opts: &Opts,
    dir: Option<PathBuf>,
    template: Option<String>,
    name: Option<String>,
    dry_run: bool,
) -> CmdResult {
    let dir = dir
        .or_else(|| opts.project.clone())
        .unwrap_or_else(|| PathBuf::from("."));
    let i = ProjectCreateIn {
        name,
        template,
        dry_run,
    };
    let ctx = crate::forward::cli_ctx(Some("rw init".into()));
    // A live owner of `dir` (a sidecar started on an empty directory) creates
    // the project itself; otherwise create in-process, lock first (D4).
    let v = match crate::forward::route(&dir, "project_create")? {
        crate::forward::Route::Forward(sock) => {
            let args = serde_json::to_value(&i).map_err(|e| usage(e.to_string()))?;
            crate::forward::forward(&sock, "project_create", args, &ctx)?
        }
        crate::forward::Route::InProcess { .. } => {
            let out = rw_project::create::create_project(&dir, &i, &ctx)?;
            serde_json::to_value(&out).map_err(|e| usage(e.to_string()))?
        }
    };
    let head = format!(
        "{} project in {}\n",
        if dry_run {
            "would create a"
        } else {
            "created a"
        },
        dir.display(),
    );
    let created = Opts {
        project: Some(dir.clone()),
        ..opts.clone()
    };
    Ok(mutation_outcome(&created, v, &head, ""))
}

/// `rw fmt [--check] [files...]`: exit 1 with `--check` when a file would change.
pub fn fmt(opts: &Opts, check: bool, files: Vec<String>) -> CmdResult {
    let v = opts.call("fmt", json!({"check": check, "files": files}), None)?;
    let changed: Vec<&str> = v["changed"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let human = if changed.is_empty() {
        "all files formatted".to_string()
    } else {
        let verb = if check {
            "would reformat"
        } else {
            "reformatted"
        };
        changed
            .iter()
            .map(|c| format!("{verb} {c}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let ok = !check || changed.is_empty();
    Ok(Outcome {
        value: v,
        human,
        ok,
    })
}

/// `rw validate [files...]`.
pub fn validate(opts: &Opts, files: Vec<String>) -> CmdResult {
    let v = opts.call("project_validate", json!({"files": files}), None)?;
    let ok = v["ok"].as_bool().unwrap_or(false);
    let mut human = format!(
        "{} ({} files)",
        if ok { "valid" } else { "invalid" },
        v["files"].as_array().map_or(0, Vec::len)
    );
    for l in diag_lines(&v["diagnostics"]) {
        human.push_str(&format!("\n  {l}"));
    }
    Ok(Outcome {
        value: v,
        human,
        ok,
    })
}

/// `rw eval [path] [--config] [--variant] [--version]`.
pub fn eval(
    opts: &Opts,
    path: Option<String>,
    config: Option<String>,
    variant: Option<String>,
    version: Option<String>,
) -> CmdResult {
    let mut args = serde_json::Map::new();
    if let Some(p) = path {
        let p = if p.starts_with('/') {
            p
        } else {
            format!("/{}", p.replace('.', "/"))
        };
        args.insert("path".into(), json!(p));
    }
    for (k, v) in [
        ("config", config),
        ("variant", variant),
        ("version", version),
    ] {
        if let Some(v) = v {
            args.insert(k.into(), json!(v));
        }
    }
    let field = args
        .get("path")
        .and_then(Value::as_str)
        .and_then(|p| {
            p.rsplit('/')
                .find(|s| !s.is_empty() && s.parse::<usize>().is_err())
        })
        .map(String::from);
    let v = opts.call("model_get", Value::Object(args), None)?;
    let units = opts.units();
    let human = match v.get("value") {
        // One value: dimensioned numbers as display strings (`"45 mm"`).
        Some(x) => match (x.as_f64(), field.as_deref().map(field_class)) {
            (Some(n), Some(c @ Class::Dim(_))) => units.fmt(n, c),
            _ => serde_json::to_string_pretty(&display_tree(&units, x, field.as_deref()))
                .unwrap_or_default(),
        },
        None => {
            let m = &v["model"];
            let h = v["model_hash"].as_str().unwrap_or("");
            let mut s = format!(
                "{} (model {})",
                m["name"].as_str().unwrap_or("?"),
                &h[..h.len().min(12)]
            );
            if let Some(c) = m["config"].as_str() {
                s.push_str(&format!("\nconfig {c}"));
            }
            let len = Class::Dim(rw_units::DimKind::Length);
            for c in m["components"].as_array().into_iter().flatten() {
                s.push_str(&format!(
                    "\n  {:<16} {:<20} x {} .. {}",
                    c["id"].as_str().unwrap_or("?"),
                    c["shape"]["type"].as_str().unwrap_or("?"),
                    units.num(&c["x_fore"], len),
                    units.num(&c["x_aft"], len),
                ));
            }
            for l in diag_lines(&m["diagnostics"]) {
                s.push_str(&format!("\n  {l}"));
            }
            s
        }
    };
    Ok(Outcome::ok(v, human))
}

/// `rw schema [name]` (no project needed).
pub fn schema(_opts: &Opts, name: Option<String>) -> CmdResult {
    let out = rw_project::session::schema_get(name.as_deref())?;
    let v = serde_json::to_value(&out).map_err(|e| usage(e.to_string()))?;
    let human = match &out.schema {
        Some(s) => serde_json::to_string_pretty(s).unwrap_or_default(),
        None => out.names.join("\n"),
    };
    Ok(Outcome::ok(v, human))
}
