//! `rw import ork`, `rw motor import`, and `rw export` (M2.5, M2.6).
//!
//! Inside a project, imports run `import_file` (forwarded to the live owner
//! when one runs; one history step that replaces the model). `rw import ork`
//! on a directory with no project creates one from the file instead.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{CmdResult, Opts, Outcome, cli_path, diag_lines, mutation_outcome, usage};

/// The lines `rw import` prints before the mutation summary.
fn import_head(v: &Value, created: Option<&Path>) -> String {
    let mut h = String::new();
    if let Some(d) = created {
        h.push_str(&format!("created a project in {}\n", d.display()));
    }
    let n = v["imported"].as_array().map_or(0, Vec::len);
    h.push_str(&format!("imported {n} item(s)\n"));
    for l in diag_lines(&v["diagnostics"]) {
        h.push_str(&format!("  {l}\n"));
    }
    h
}

/// `rw import ork <file> [dir] [--dry-run]`.
pub fn import_ork(opts: &Opts, file: &str, dir: Option<PathBuf>, dry_run: bool) -> CmdResult {
    let path = cli_path(file);
    let target = dir.or_else(|| opts.project.clone());
    // An explicit directory that is not a project, or a working directory
    // outside any project: create the project from the file.
    let create_in = match &target {
        Some(d) if !rw_project::layout::is_project(d) => Some(d.clone()),
        Some(_) => None,
        None => {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            rw_project::layout::find_root(&cwd).is_none().then_some(cwd)
        }
    };
    if let Some(d) = create_in {
        let ctx = crate::forward::cli_ctx(Some("rw import ork".into()));
        let out = rw_project::create::import_project(&d, &path, dry_run, &ctx)?;
        let v = serde_json::to_value(&out).map_err(|e| usage(e.to_string()))?;
        let head = import_head(&v, (!dry_run).then_some(d.as_path()));
        let created = Opts {
            project: Some(d.clone()),
            ..opts.clone()
        };
        return Ok(mutation_outcome(&created, v, &head, ""));
    }
    let opts = Opts {
        project: target.or_else(|| opts.project.clone()),
        ..opts.clone()
    };
    let v = opts.call(
        "import_file",
        json!({"path": path, "kind": "ork", "dry_run": dry_run}),
        None,
    )?;
    let head = import_head(&v, None);
    Ok(mutation_outcome(&opts, v, &head, ""))
}

/// `rw export <ork|rasp|glb|stl|csv> <path> [--config <id>] [--run <ref>]
/// [--allow-outside]`. A relative path is relative to the working directory;
/// it must land inside the project unless `--allow-outside` is given.
pub fn export(
    opts: &Opts,
    format: &str,
    path: &str,
    config: Option<String>,
    run: Option<String>,
    allow_outside: bool,
) -> CmdResult {
    let format = format.to_ascii_lowercase();
    if !["ork", "rasp", "glb", "stl", "csv"].contains(&format.as_str()) {
        return Err(usage(format!(
            "unknown export format `{format}` (ork, rasp, glb, stl, csv)"
        )));
    }
    let p = Path::new(path);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(p)
    };
    let mut args = json!({"format": format, "path": abs.display().to_string()});
    if let Some(c) = config {
        args["config"] = json!(c);
    }
    if let Some(r) = run {
        args["run"] = json!(r);
    }
    if allow_outside {
        args["allow_outside"] = json!(true);
    }
    let v = opts.call("export_file", args, None)?;
    let human = format!(
        "wrote {} ({} bytes, sha256 {})",
        v["path"].as_str().unwrap_or("?"),
        v["bytes"].as_u64().unwrap_or(0),
        v["sha256"].as_str().unwrap_or("?")
    );
    Ok(Outcome::ok(v, human))
}
