//! CLI routing and the single-writer rule (M1.26c, D4).
//!
//! - `.rw/lock` held by a live owner → the CLI forwards its `Command` over
//!   `.rw/sidecar.sock` (MCP JSON-RPC, `_meta["rw/origin"] = "cli"`), so the
//!   owner's session writes and records the step.
//! - No live owner → an in-process `Session` (writer for mutating commands,
//!   which takes the lock for the call; read-only otherwise).
//! - Lock held but the socket unreachable → `RW-E007`, exit 2, nothing
//!   written. There is no lock fallback: the CLI never writes past an owner.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rw_api::{ApiError, ApiErrorCode, CallCtx, Origin, command_def};
use rw_project::lock::{self, LockState};
use rw_project::{Session, SessionOptions};
use serde_json::{Map, Value, json};

use crate::mcp::{PROTOCOL_VERSION, dispatch, meta, socket};

/// How long a forwarded call may take.
pub const FORWARD_TIMEOUT: Duration = Duration::from_secs(120);

/// Where a CLI command runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// The live owner's socket.
    Forward(PathBuf),
    /// In-process; `writer` takes the lock for the call.
    InProcess { writer: bool },
}

fn err(code: ApiErrorCode, message: impl Into<String>, hint: Option<&str>) -> ApiError {
    ApiError {
        outcome: None,
        code,
        message: message.into(),
        hint: hint.map(String::from),
        diagnostics: Vec::new(),
    }
}

/// True when a command may write project files or history.
pub fn writes(name: &str) -> bool {
    command_def(name).is_some_and(|d| !d.hints.read_only)
}

/// The command whose write hint picks the session mode for a call:
/// `history_compare` with `visual` writes its render to `renders/`, as
/// `render` does.
pub fn mode_name<'a>(name: &'a str, args: &Value) -> &'a str {
    if name == "history_compare" && args.get("visual").and_then(Value::as_bool) == Some(true) {
        "render"
    } else {
        name
    }
}

/// Decides where `name` runs for `project`.
pub fn route(project: &Path, name: &str) -> Result<Route, ApiError> {
    let state =
        lock::probe(project).map_err(|e| err(ApiErrorCode::Io, format!(".rw/lock: {e}"), None))?;
    match state {
        LockState::Free { .. } => Ok(Route::InProcess {
            writer: writes(name),
        }),
        LockState::Held(info) => {
            let sock = info
                .socket
                .clone()
                .unwrap_or_else(|| socket::socket_path(project));
            if UnixStream::connect(&sock).is_ok() {
                return Ok(Route::Forward(sock));
            }
            let mut e = err(
                ApiErrorCode::Locked,
                format!(
                    "locked-by {}: the project's owner is running but {} is unreachable; nothing was written",
                    info.pid,
                    sock.display()
                ),
                Some(
                    "the RocketWright app (or `rocketwright mcp`) owns this project; retry once it is ready, or close it to edit from the CLI",
                ),
            );
            let mut d = rw_model::Diagnostic::new(
                rw_model::diag::E_LOCKED,
                None,
                format!("locked-by {}", info.pid),
            );
            d.file = Some(lock::LOCK_REL.into());
            e.diagnostics.push(d);
            Err(e)
        }
    }
}

/// A minimal line-delimited JSON-RPC MCP client over the sidecar socket.
pub struct Client {
    w: UnixStream,
    r: BufReader<UnixStream>,
    next: u64,
}

impl Client {
    fn connect(sock: &Path) -> Result<Client, ApiError> {
        let s = UnixStream::connect(sock)
            .map_err(|e| err(ApiErrorCode::Io, format!("{}: {e}", sock.display()), None))?;
        s.set_read_timeout(Some(FORWARD_TIMEOUT)).ok();
        let r = BufReader::new(
            s.try_clone()
                .map_err(|e| err(ApiErrorCode::Io, e.to_string(), None))?,
        );
        Ok(Client { w: s, r, next: 1 })
    }

    fn send(&mut self, v: &Value) -> Result<(), ApiError> {
        let mut line = serde_json::to_string(v).unwrap_or_default();
        line.push('\n');
        self.w
            .write_all(line.as_bytes())
            .map_err(|e| err(ApiErrorCode::Io, format!("sidecar socket: {e}"), None))
    }

    /// Sends a request and waits for its response (notifications skipped).
    fn request(&mut self, method: &str, params: Value) -> Result<Value, ApiError> {
        let id = self.next;
        self.next += 1;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        let mut line = String::new();
        loop {
            line.clear();
            let n = self
                .r
                .read_line(&mut line)
                .map_err(|e| err(ApiErrorCode::Io, format!("sidecar socket: {e}"), None))?;
            if n == 0 {
                return Err(err(ApiErrorCode::Io, "the sidecar closed the socket", None));
            }
            let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            if v.get("id") != Some(&json!(id)) {
                continue;
            }
            if let Some(e) = v.get("error") {
                let data = e.get("data").cloned().unwrap_or(Value::Null);
                if let Ok(api) = serde_json::from_value::<ApiError>(data) {
                    return Err(api);
                }
                let msg = e.get("message").and_then(Value::as_str).unwrap_or("error");
                return Err(err(
                    ApiErrorCode::Internal,
                    format!("{method}: {msg}"),
                    None,
                ));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

fn cli_meta(ctx: &CallCtx) -> Value {
    let mut m = Map::new();
    m.insert(meta::ORIGIN.into(), json!("cli"));
    if let Some(t) = &ctx.thread {
        m.insert(meta::THREAD.into(), json!(t));
    }
    if let Some(t) = &ctx.tool_call {
        m.insert(meta::TOOL_CALL.into(), json!(t));
    }
    if let Some(l) = &ctx.label {
        m.insert(meta::LABEL.into(), json!(l));
    }
    Value::Object(m)
}

impl Client {
    /// Connects and completes the MCP handshake.
    fn open(sock: &Path) -> Result<Client, ApiError> {
        let mut c = Client::connect(sock)?;
        c.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION.to_string(),
                "capabilities": {},
                "clientInfo": {"name": "rocketwright-cli", "version": env!("CARGO_PKG_VERSION")},
            }),
        )?;
        c.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))?;
        Ok(c)
    }

    /// Calls a tool; returns its structured content or its `ApiError`.
    fn call_tool(&mut self, name: &str, args: Value, ctx: &CallCtx) -> Result<Value, ApiError> {
        let r = self.request(
            "tools/call",
            json!({"name": name, "arguments": args, "_meta": cli_meta(ctx)}),
        )?;
        if r.get("isError").and_then(Value::as_bool) == Some(true) {
            let e = r
                .pointer(&format!("/_meta/{}", meta::ERROR.replace('/', "~1")))
                .cloned()
                .and_then(|v| serde_json::from_value::<ApiError>(v).ok())
                .unwrap_or_else(|| err(ApiErrorCode::Internal, r.to_string(), None));
            return Err(e);
        }
        Ok(r.get("structuredContent").cloned().unwrap_or(Value::Null))
    }
}

/// Runs a tool on the live owner over its socket, as `origin = cli`.
pub fn forward(sock: &Path, name: &str, args: Value, ctx: &CallCtx) -> Result<Value, ApiError> {
    Client::open(sock)?.call_tool(name, args, ctx)
}

/// A CLI connection to a project for one or more calls: the live owner's
/// socket, or an in-process session (D4). Multi-call commands (`rw sim`
/// waiting on its job) keep one connection so the job stays reachable.
pub enum Conn {
    Forward(Box<Client>),
    InProcess(Box<Session>),
}

impl std::fmt::Debug for Conn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Conn::Forward(_) => f.write_str("Conn::Forward"),
            Conn::InProcess(_) => f.write_str("Conn::InProcess"),
        }
    }
}

impl Conn {
    /// Opens a connection fit for running `name` (a writer when it writes).
    pub fn open(project: &Path, name: &str) -> Result<Conn, ApiError> {
        Conn::open_with(project, name, None)
    }

    /// [`Conn::open`]; `snapshot` titles the snapshot step an in-process
    /// writer records on open (ignored when forwarding: the owner already
    /// recorded it).
    pub fn open_with(project: &Path, name: &str, snapshot: Option<&str>) -> Result<Conn, ApiError> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            match route(project, name)? {
                Route::Forward(sock) => return Ok(Conn::Forward(Box::new(Client::open(&sock)?))),
                Route::InProcess { writer } => {
                    let opts = if writer {
                        SessionOptions::writer().with_snapshot_title(snapshot.map(String::from))
                    } else {
                        SessionOptions::read_only()
                    };
                    match Session::open(project, opts) {
                        Ok(s) => return Ok(Conn::InProcess(Box::new(s))),
                        // An owner started between the probe and the open: route again.
                        Err(e) if e.code == ApiErrorCode::Locked && attempt < 3 => {
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        Err(e) => return Err(e),
                    }
                }
            }
        }
    }

    /// Validates and runs one command.
    pub fn call(&mut self, name: &str, args: Value, ctx: &CallCtx) -> Result<Value, ApiError> {
        let cmd = dispatch::command(name, args.clone())?;
        match self {
            Conn::Forward(c) => c.call_tool(name, args, ctx),
            Conn::InProcess(s) => dispatch::execute_session(s, &cmd, ctx),
        }
    }

    /// Waits for a job to reach a terminal state (or `timeout`); returns
    /// its last `job_status`.
    pub fn wait_job(
        &mut self,
        job_id: &str,
        timeout: Duration,
        ctx: &CallCtx,
    ) -> Result<rw_api::JobInfo, ApiError> {
        let parse = |v: Value| {
            serde_json::from_value::<rw_api::JobInfo>(v)
                .map_err(|e| err(ApiErrorCode::Internal, e.to_string(), None))
        };
        match self {
            Conn::InProcess(s) => s
                .jobs()
                .wait(job_id, timeout)
                .ok_or_else(|| err(ApiErrorCode::NotFound, format!("no job `{job_id}`"), None)),
            Conn::Forward(_) => {
                let end = std::time::Instant::now() + timeout;
                loop {
                    let info = parse(self.call("job_status", json!({"job_id": job_id}), ctx)?)?;
                    let done = matches!(
                        info.state,
                        rw_api::JobState::Complete
                            | rw_api::JobState::Failed
                            | rw_api::JobState::Cancelled
                    );
                    if done || std::time::Instant::now() >= end {
                        return Ok(info);
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    }
}

/// The CLI call context (`origin = cli`).
pub fn cli_ctx(label: Option<String>) -> CallCtx {
    CallCtx {
        origin: Origin::Cli,
        thread: None,
        tool_call: None,
        label,
    }
}

/// Runs one CLI command on `project`: forwarded, or in-process (D4).
pub fn run(
    project: &Path,
    name: &str,
    args: Value,
    label: Option<String>,
) -> Result<Value, ApiError> {
    run_with(project, name, args, label, None)
}

/// [`run`] with the snapshot title of [`Conn::open_with`].
pub fn run_with(
    project: &Path,
    name: &str,
    args: Value,
    label: Option<String>,
    snapshot: Option<&str>,
) -> Result<Value, ApiError> {
    // Validate before routing: a bad call never reaches the owner.
    dispatch::command(name, args.clone())?;
    let ctx = cli_ctx(label);
    Conn::open_with(project, mode_name(name, &args), snapshot)?.call(name, args, &ctx)
}
