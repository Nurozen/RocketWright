//! Repository automation, run as `cargo xtask <task>`: `audit` (clean-room and
//! purity checks), `schema` (JSON Schema generation), `tables` (CEA tables),
//! `diag-docs` (generated agent-briefing tables), and `docs-check` (the agent
//! briefing's commands exist and its `rw` blocks run).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod audit;
mod diag_docs;
mod docs_check;
mod schema;
mod tables;

use std::process::ExitCode;

const USAGE: &str = "usage: cargo xtask <audit|schema|tables|diag-docs|docs-check>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("audit") => audit::main(&args[1..]),
        Some("schema") => schema::main(&args[1..]),
        Some("diag-docs") => diag_docs::main(&args[1..]),
        Some("docs-check") => docs_check::main(&args[1..]),
        Some("tables") => tables::main(&args[1..]),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
