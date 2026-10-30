//! `rocketwright mcp --project <dir> [--app]`: the sidecar (plan M1.8, D4).
//!
//! Serves MCP on stdio (the app's v2 client, Lecturn, or any MCP host). The
//! owner also serves `.rw/sidecar.sock` on the same [`Hub`], for CLI
//! forwarding and for relays. Every connection is one rmcp service; all of
//! them share subscriptions, so a write forwarded over the socket notifies
//! the stdio client (`notifications/resources/updated`).
//!
//! Protocol: pinned to MCP `2025-11-25` (the newest revision with an
//! `initialize` handshake), whatever the client asks for.
//!
//! Ownership (D4): every instance is a [`relay`] front. The first takes
//! `.rw/lock`, binds the socket, opens the project's `rw_project::Session`
//! and watches the project (M1.29); its stdio talks to an in-process
//! [`RwServer`]. A later instance finds a live owner and relays its stdio to
//! the owner's socket unchanged; when the owner goes away it races for the
//! lock and either promotes itself or reconnects to the winner. An owner
//! whose own stdio client disconnects drains: it keeps serving while relays
//! are attached or jobs run, then exits. A `--no-socket` owner cannot be
//! relayed to; later instances exit 2 with `RW-E007 locked-by <pid>`.
//! `--list-tools` prints the tool list and exits without taking the lock.
//!
//! Tool bodies: [`dispatch`] turns every call into an `rw_api::Command` (I2)
//! and runs it on the session. Commands whose rows have not landed answer
//! `NotImplemented`, or the contract-fixture double when built with the
//! `doubles` feature (tests only). A directory without `rocketwright.toml`
//! has no session: `project_create` creates one; other tools answer "no
//! project here" (or doubles in contract-fixture mode).

pub mod approval;
pub mod catalog;
pub mod descriptions;
pub mod dispatch;
#[cfg(feature = "doubles")]
pub mod doubles;
pub mod meta;
pub mod picture;
pub mod presentation;
pub mod relay;
pub mod resources;
pub mod series;
pub mod server;
pub mod socket;
pub mod store;
pub mod tools;

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use rmcp::model::{ListToolsResult, ProtocolVersion};

pub use server::{Hub, RwServer};

/// The pinned MCP revision.
pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::V_2025_11_25;

/// The only revision the sidecar negotiates.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[ProtocolVersion] = &[ProtocolVersion::V_2025_11_25];

/// True when contract-fixture doubles are compiled in (`doubles` feature).
pub const DOUBLES: bool = cfg!(feature = "doubles");

#[derive(Debug, Clone)]
pub struct McpOptions {
    pub project: PathBuf,
    /// Started by the app (`--app`).
    pub app: bool,
    /// Serve `.rw/sidecar.sock` when owning the project.
    pub socket: bool,
    /// Print the `tools/list` result and exit (no lock, no session).
    pub list_tools: bool,
}

/// Runs the sidecar until stdin closes (and, as owner, until it drained).
/// Exit codes: 0 clean, 2 usage/I-O/lock.
pub fn main(opts: McpOptions) -> ExitCode {
    if opts.list_tools {
        return list_tools();
    }
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("rocketwright mcp: cannot start runtime: {e}");
            return ExitCode::from(2);
        }
    };
    let r = rt.block_on(serve(opts));
    // Stdin's reader may still sit in a blocking read (error paths).
    rt.shutdown_timeout(Duration::from_millis(200));
    match r {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("rocketwright mcp: {e:#}");
            ExitCode::from(2)
        }
    }
}

/// `--list-tools`: the `tools/list` result as one JSON line on stdout.
fn list_tools() -> ExitCode {
    let r = ListToolsResult::with_all_items(catalog::tools().to_vec());
    match serde_json::to_string(&r) {
        Ok(s) => {
            println!("{s}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("rocketwright mcp --list-tools: {e}");
            ExitCode::from(2)
        }
    }
}

/// Serves stdio through the relay front until the stdio client disconnects.
pub async fn serve(opts: McpOptions) -> anyhow::Result<()> {
    let project = std::fs::canonicalize(&opts.project)
        .map_err(|e| anyhow::anyhow!("project {}: {e}", opts.project.display()))?;
    if !project.is_dir() {
        anyhow::bail!("project {} is not a directory", project.display());
    }
    relay::run(project, opts).await
}
