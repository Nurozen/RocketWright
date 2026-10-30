//! `rw motor import <file.eng|file.rse> [--dry-run]` (S:83, plan M2.14):
//! the `import_file` tool with `kind = "motor"`. The file is copied into the
//! project's `lib/motors/` and its sha256 recorded in `rocketwright.toml
//! [lib.sha256]`; a file in neither dialect fails with `RW-E008`.

use serde_json::json;

use super::{CmdResult, Opts, cli_path, mutation_outcome};

/// `rw motor import <file> [--dry-run]`.
pub fn import(opts: &Opts, file: &str, dry_run: bool) -> CmdResult {
    let args = json!({"path": cli_path(file), "kind": "motor", "dry_run": dry_run});
    let v = opts.call("import_file", args, None)?;
    let motors: String = v["imported"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| format!("motor {}\n", r.as_str().unwrap_or("?")))
        .collect();
    Ok(mutation_outcome(opts, v, "", &motors))
}
