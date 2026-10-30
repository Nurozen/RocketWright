//! The relay front of every `rocketwright mcp` instance (D4).
//!
//! A line pump between stdio and an upstream MCP server: either the owner's
//! `.rw/sidecar.sock`, or (when this process owns the project) an in-process
//! `tokio::io::duplex` into an [`RwServer`]. Owner, client and promotion
//! therefore share one path. Lines pass through unchanged, except that the
//! client's `initialize` names the relay (`clientInfo.name` =
//! [`RELAY_CLIENT`]) so the owner treats the connection as `Origin::Mcp`.
//!
//! The pump records the client's `initialize` params, `notifications/
//! initialized`, the subscribed URIs and the in-flight request ids.
//!
//! Election ([`elect`]): race `ProjectLock::acquire`. Promote only after a
//! successful acquire: bind the socket first; on bind failure drop the lock
//! and go back to connect-retry, so no process holds the lock without a
//! listener. Otherwise connect to the owner's socket (`LockInfo.socket`),
//! retrying with bounded backoff. Simultaneous contenders resolve through
//! the same flock race: exactly one binds, the rest connect.
//!
//! Upstream EOF (the owner exited), recovery (B1b):
//! - an in-flight mutation (or any call the relay cannot classify) gets a
//!   retryable `unavailable` error with `outcome: "unknown"`: mutations
//!   commit before they reply, so it may have landed, and the caller
//!   reconciles through `history_list`. The relay never retries one;
//! - an in-flight read-only call (a `tools/call` whose catalogue entry is
//!   `read_only`, or a read-only MCP method) is retried once on the new
//!   upstream; lost again, it gets `unavailable` without an outcome;
//! - the relay re-runs the election eagerly (so notifications resume
//!   without waiting for a call), and replays `initialize`,
//!   `notifications/initialized` and every `resources/subscribe` on the new
//!   upstream, swallowing their responses;
//! - it then tells the client: `notifications/resources/updated` for every
//!   subscribed URI and `notifications/rw/upstream-changed`, so mirrors
//!   built from the old owner are refreshed.
//!
//! Drain: when this process owns the project and its stdio client goes
//! away, it keeps the socket and the [`Hub`] alive while relays are
//! attached or jobs run, and exits once both are gone.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rmcp::ServiceExt;
use rw_api::Origin;
use rw_project::lock::{LockError, LockInfo};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::server::RELAY_CLIENT;
use super::{Hub, McpOptions, RwServer, meta, socket};

/// Prefix of the JSON-RPC ids of requests the relay itself sends upstream
/// (replayed handshakes and subscriptions); their responses are swallowed.
pub const RELAY_ID_PREFIX: &str = "rw-relay:";

/// Notification sent to the client after every reconnect or promotion.
pub const UPSTREAM_CHANGED: &str = "notifications/rw/upstream-changed";

/// MCP methods without side effects: retried once when lost (B1b).
const READ_ONLY_METHODS: &[&str] = &[
    "ping",
    "tools/list",
    "resources/list",
    "resources/templates/list",
    "resources/read",
    "resources/subscribe",
    "resources/unsubscribe",
    "prompts/list",
    "prompts/get",
    "completion/complete",
];

/// How long one election may take before giving up (`RW-E007`).
pub const ELECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Connect-retry backoff: first and largest delay.
const BACKOFF_MIN: Duration = Duration::from_millis(20);
const BACKOFF_MAX: Duration = Duration::from_millis(500);

/// How often a draining owner checks for relays and jobs.
const DRAIN_POLL: Duration = Duration::from_millis(50);

type Reader = Box<dyn AsyncRead + Unpin + Send>;
type Writer = Box<dyn AsyncWrite + Unpin + Send>;

/// Prints a role trace line when `RW_MCP_TRACE=1` (tests, diagnostics).
fn trace(msg: impl std::fmt::Display) {
    if std::env::var("RW_MCP_TRACE").as_deref() == Ok("1") {
        eprintln!("rocketwright mcp[{}]: {msg}", std::process::id());
    }
}

/// The project this process owns: its [`Hub`] and socket listener.
pub struct Owner {
    project: PathBuf,
    hub: Arc<Hub>,
    accept: Option<JoinHandle<()>>,
}

impl Owner {
    /// Sets up ownership with `lock` held: bind (unless `--no-socket`),
    /// then the hub, the session and the watcher. `Err(Ok(lock-dropped))`
    /// is a bind failure (retry), `Err(Err(e))` is fatal.
    fn start(
        project: &Path,
        opts: &McpOptions,
        lock: rw_project::ProjectLock,
    ) -> Result<Owner, Result<std::io::Error, anyhow::Error>> {
        // Bind first: a bind failure drops the lock before anything else
        // runs, so no process holds the lock without a listener (D4).
        let listener = if opts.socket {
            match socket::bind(project) {
                Ok(l) => Some(l),
                Err(e) => {
                    drop(lock);
                    return Err(Ok(e));
                }
            }
        } else {
            None
        };
        let hub = Arc::new(Hub::new(project.to_path_buf(), opts.app));
        // Changed resources → notifications/resources/updated on every connection.
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<String>>();
        hub.set_updates(tx);
        {
            let h = hub.clone();
            tokio::spawn(async move {
                while let Some(uris) = rx.recv().await {
                    h.notify_updated(&uris).await;
                }
            });
        }
        if rw_project::layout::is_project(project) {
            let sopts =
                rw_project::SessionOptions::writer().with_lock(rw_project::LockMode::Held(lock));
            match rw_project::Session::open_shared(project, sopts) {
                Ok(s) => hub.attach_session(s, true),
                Err(e) => {
                    if listener.is_some() {
                        socket::remove(project);
                    }
                    return Err(Err(anyhow::anyhow!("opening the project: {}", e.message)));
                }
            }
        } else {
            hub.hold_lock(lock);
        }
        let accept = listener.map(|l| tokio::spawn(socket::accept_loop(l, hub.clone())));
        Ok(Owner {
            project: project.to_path_buf(),
            hub,
            accept,
        })
    }

    /// A fresh in-process connection to this owner's [`RwServer`].
    fn connect(&self) -> (Reader, Writer) {
        let (client, server) = tokio::io::duplex(1 << 16);
        let srv = RwServer::new(self.hub.clone(), Origin::Mcp);
        let conn = srv.conn();
        let hub = self.hub.clone();
        tokio::spawn(async move {
            let (r, w) = tokio::io::split(server);
            if let Ok(service) = srv.serve((r, w)).await {
                let _ = service.waiting().await;
            }
            hub.drop_conn(conn);
        });
        let (r, w) = tokio::io::split(client);
        (Box::new(r), Box::new(w))
    }

    /// Keeps serving while relays are attached or jobs run, then shuts the
    /// socket down. The lock goes with the process (or the dropped hub).
    async fn drain(self) {
        let mut said = false;
        while self.hub.relay_count() > 0 || self.hub.jobs_active() {
            if !said {
                trace(format_args!(
                    "draining ({} relays, jobs active: {})",
                    self.hub.relay_count(),
                    self.hub.jobs_active()
                ));
                said = true;
            }
            tokio::time::sleep(DRAIN_POLL).await;
        }
        trace("drained");
        self.shutdown();
    }

    /// Stops accepting and removes the socket file while the lock is still
    /// held, so a successor's socket is never removed.
    fn shutdown(self) {
        if let Some(task) = self.accept {
            task.abort();
            socket::remove(&self.project);
        }
        self.hub.stop_watching();
    }
}

/// What the election made of this process.
enum Role {
    Owner(Owner),
    Relay(PathBuf),
}

fn locked_by(info: Option<&LockInfo>, why: &str) -> anyhow::Error {
    match info {
        Some(i) => anyhow::anyhow!("RW-E007 locked-by {}: {why}", i.pid),
        None => anyhow::anyhow!("RW-E007 locked-by another process: {why}"),
    }
}

/// Connects to the owner's socket.
async fn connect_socket(path: &Path) -> std::io::Result<(Reader, Writer)> {
    let s = tokio::net::UnixStream::connect(path).await?;
    let (r, w) = s.into_split();
    Ok((Box::new(r), Box::new(w)))
}

/// Becomes the owner or a relay of `project` (module docs).
async fn elect(project: &Path, opts: &McpOptions) -> anyhow::Result<(Role, Reader, Writer)> {
    let start = Instant::now();
    let mut delay = BACKOFF_MIN;
    let record = opts.socket.then(|| socket::socket_path(project));
    let mut last: Option<LockInfo> = None;
    let mut bind_failed = false;
    loop {
        let why = match rw_project::ProjectLock::acquire(project, record.as_deref()) {
            Ok(lock) => match Owner::start(project, opts, lock) {
                Ok(owner) => {
                    trace("owner");
                    let (r, w) = owner.connect();
                    return Ok((Role::Owner(owner), r, w));
                }
                Err(Ok(e)) => {
                    if !bind_failed {
                        eprintln!(
                            "rocketwright mcp: cannot bind {}: {e}; released the lock, retrying",
                            socket::socket_path(project).display()
                        );
                        bind_failed = true;
                    }
                    format!(
                        "cannot bind {}: {e}",
                        socket::socket_path(project).display()
                    )
                }
                Err(Err(e)) => return Err(e),
            },
            Err(LockError::Locked(info)) => {
                let Some(sock) = info.socket.clone() else {
                    return Err(locked_by(
                        Some(&info),
                        "the owner serves no socket (started with --no-socket), so this instance cannot relay to it",
                    ));
                };
                match connect_socket(&sock).await {
                    Ok((r, w)) => {
                        trace(format_args!(
                            "relay to pid {} at {}",
                            info.pid,
                            sock.display()
                        ));
                        return Ok((Role::Relay(sock), r, w));
                    }
                    Err(e) => {
                        let why =
                            format!("the owner's socket {} is unreachable: {e}", sock.display());
                        last = Some(info);
                        why
                    }
                }
            }
            // The record is being written: try the default socket.
            Err(LockError::LockedUnknown) => {
                let sock = socket::socket_path(project);
                match connect_socket(&sock).await {
                    Ok((r, w)) => {
                        trace(format_args!("relay at {}", sock.display()));
                        return Ok((Role::Relay(sock), r, w));
                    }
                    Err(e) => format!("the owner's socket {} is unreachable: {e}", sock.display()),
                }
            }
            Err(LockError::Io(e)) => anyhow::bail!(".rw/lock: {e}"),
        };
        if start.elapsed() >= ELECT_TIMEOUT {
            return Err(locked_by(last.as_ref(), &why));
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(BACKOFF_MAX);
    }
}

/// A client request awaiting its response.
#[derive(Debug, Clone)]
struct Inflight {
    id: Value,
    method: String,
    /// The line as sent upstream (resent on a retry).
    line: String,
    /// What the request is called in errors: the tool name or the method.
    what: String,
    /// Safe to resend: no side effects (B1b).
    read_only: bool,
    /// Already resent once.
    retried: bool,
    /// Lost with an upstream and waiting to be resent on the next one.
    resend: bool,
    /// Arrival order (resends keep the client's order).
    order: u64,
}

/// The relay's view of the client session (what a new upstream needs).
#[derive(Debug, Default)]
pub struct State {
    /// The client's `initialize` params (with the relay's `clientInfo.name`).
    init: Option<Value>,
    initialized: bool,
    subs: BTreeSet<String>,
    /// Client requests awaiting a response, by id key.
    inflight: BTreeMap<String, Inflight>,
    seq: u64,
    arrivals: u64,
}

fn id_key(id: &Value) -> String {
    id.to_string()
}

/// `(what, read_only)` for a client request: tools by their catalogue
/// hints (unknown tools count as mutations), other methods by
/// [`READ_ONLY_METHODS`].
fn classify(method: &str, v: &Value) -> (String, bool) {
    if method == "tools/call" {
        let name = v
            .pointer("/params/name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let ro = name == super::series::NAME
            || name == super::picture::NAME
            || rw_api::command_def(name).is_some_and(|d| d.hints.read_only);
        (name.to_owned(), ro)
    } else {
        (method.to_owned(), READ_ONLY_METHODS.contains(&method))
    }
}

/// The JSON-RPC response for a request lost with the upstream.
fn lost_response(req: &Inflight, mutating: bool) -> String {
    let err = rw_api::ApiError::unavailable(&req.what, mutating);
    let data = serde_json::to_value(&err).unwrap_or(Value::Null);
    if req.method == "tools/call" {
        // A tool error result, like the owner's own (`rw/error` in `_meta`),
        // echoing the request's Lecturn keys.
        let mut m = serde_json::Map::new();
        if let Ok(v) = serde_json::from_str::<Value>(&req.line)
            && let Some(rm) = v.pointer("/params/_meta").and_then(Value::as_object)
        {
            for k in meta::ECHOED {
                if let Some(x) = rm.get(*k) {
                    m.insert((*k).to_owned(), x.clone());
                }
            }
        }
        m.insert(meta::ERROR.into(), data.clone());
        // The row summary, as the owner would have said it (CPW1R4B).
        m.insert(
            super::presentation::SUMMARY.into(),
            Value::String(super::presentation::summary(
                &req.what,
                &Value::Null,
                Err(&err),
            )),
        );
        json!({"jsonrpc": "2.0", "id": req.id, "result": {
            "content": [{"type": "text", "text": data.to_string()}],
            "isError": true,
            "_meta": m,
        }})
        .to_string()
    } else {
        json!({"jsonrpc": "2.0", "id": req.id, "error": {"code": -32603, "message": err.message, "data": data}})
            .to_string()
    }
}

impl State {
    /// Records a client line; returns the line to send upstream.
    pub fn from_client(&mut self, line: String) -> String {
        let Ok(mut v) = serde_json::from_str::<Value>(&line) else {
            return line;
        };
        let Some(method) = v.get("method").and_then(Value::as_str).map(str::to_owned) else {
            return line;
        };
        let id = v.get("id").cloned();
        let mut changed = false;
        match method.as_str() {
            "initialize" => {
                if let Some(p) = v.get_mut("params").and_then(Value::as_object_mut) {
                    let info = p
                        .entry("clientInfo")
                        .or_insert_with(|| json!({"version": "0"}));
                    if let Some(o) = info.as_object_mut() {
                        o.insert("name".into(), json!(RELAY_CLIENT));
                    }
                    changed = true;
                }
                self.init = v.get("params").cloned();
            }
            "notifications/initialized" => self.initialized = true,
            "resources/subscribe" | "resources/unsubscribe" => {
                if let Some(uri) = v.pointer("/params/uri").and_then(Value::as_str) {
                    if method == "resources/subscribe" {
                        self.subs.insert(uri.to_owned());
                    } else {
                        self.subs.remove(uri);
                    }
                }
            }
            _ => {}
        }
        let line = if changed {
            serde_json::to_string(&v).unwrap_or(line)
        } else {
            line
        };
        if let Some(id) = id {
            let (what, read_only) = classify(&method, &v);
            self.arrivals += 1;
            self.inflight.insert(
                id_key(&id),
                Inflight {
                    id,
                    method,
                    line: line.clone(),
                    what,
                    read_only,
                    retried: false,
                    resend: false,
                    order: self.arrivals,
                },
            );
        }
        line
    }

    /// Records an upstream line; returns it unless it answers the relay.
    pub fn from_upstream(&mut self, line: String) -> Option<String> {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            return Some(line);
        };
        if v.get("method").is_none()
            && let Some(id) = v.get("id")
        {
            if id.as_str().is_some_and(|s| s.starts_with(RELAY_ID_PREFIX)) {
                return None;
            }
            self.inflight.remove(&id_key(id));
        }
        Some(line)
    }

    /// The upstream is gone: error responses for the in-flight requests
    /// that cannot be resent (mutations, and reads already retried once).
    /// Reads not yet retried are kept and resent by [`State::replay`]; an
    /// in-flight `initialize` is replayed with its own id.
    pub fn fail_inflight(&mut self) -> Vec<String> {
        let mut lost = Vec::new();
        for (k, mut req) in std::mem::take(&mut self.inflight) {
            if req.method == "initialize" {
                self.inflight.insert(k, req);
            } else if req.read_only && !req.retried {
                req.retried = true;
                req.resend = true;
                self.inflight.insert(k, req);
            } else {
                lost.push(req);
            }
        }
        lost.sort_by_key(|r| r.order);
        lost.iter()
            .map(|r| lost_response(r, !r.read_only))
            .collect()
    }

    fn next_id(&mut self) -> Value {
        self.seq += 1;
        json!(format!("{RELAY_ID_PREFIX}{}", self.seq))
    }

    /// Lines that bring a new upstream to the client's session state: the
    /// handshake, the subscriptions, then the reads being retried.
    pub fn replay(&mut self) -> Vec<String> {
        let mut out = self.handshake();
        let mut resend: Vec<&mut Inflight> =
            self.inflight.values_mut().filter(|r| r.resend).collect();
        resend.sort_by_key(|r| r.order);
        for req in resend {
            req.resend = false;
            out.push(req.line.clone());
        }
        out
    }

    /// Notifications for the client after a new upstream took over: every
    /// subscribed URI may have changed, then `rw/upstream-changed`.
    pub fn resync_notes(&self, role: &str) -> Vec<String> {
        let mut out: Vec<String> = self
            .subs
            .iter()
            .map(|uri| {
                json!({"jsonrpc": "2.0", "method": "notifications/resources/updated", "params": {"uri": uri}})
                    .to_string()
            })
            .collect();
        out.push(
            json!({"jsonrpc": "2.0", "method": UPSTREAM_CHANGED, "params": {"role": role}})
                .to_string(),
        );
        out
    }

    fn handshake(&mut self) -> Vec<String> {
        let mut out: Vec<Value> = Vec::new();
        let Some(params) = self.init.clone() else {
            return Vec::new();
        };
        // An `initialize` still waiting keeps the client's own id.
        let pending = self
            .inflight
            .values()
            .find(|r| r.method == "initialize")
            .map(|r| r.id.clone());
        let id = pending.unwrap_or_else(|| self.next_id());
        out.push(json!({"jsonrpc": "2.0", "id": id, "method": "initialize", "params": params}));
        if self.initialized {
            out.push(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        }
        for uri in self.subs.clone() {
            let id = self.next_id();
            out.push(json!({"jsonrpc": "2.0", "id": id, "method": "resources/subscribe", "params": {"uri": uri}}));
        }
        out.into_iter().map(|v| v.to_string()).collect()
    }
}

/// Reads upstream lines into `tx`, tagged with the upstream's generation;
/// `None` marks EOF.
fn spawn_reader(r: Reader, generation: u64, tx: mpsc::UnboundedSender<(u64, Option<String>)>) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(r).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send((generation, Some(line))).is_err() {
                return;
            }
        }
        let _ = tx.send((generation, None));
    });
}

async fn write_line<W: AsyncWrite + Unpin + ?Sized>(w: &mut W, line: &str) -> std::io::Result<()> {
    w.write_all(line.as_bytes()).await?;
    w.write_all(b"\n").await?;
    w.flush().await
}

/// Runs the relay front on stdio until the client disconnects.
pub async fn run(project: PathBuf, opts: McpOptions) -> anyhow::Result<()> {
    run_on(project, opts, tokio::io::stdin(), tokio::io::stdout()).await
}

/// [`run`] on any client transport.
pub async fn run_on<R, W>(
    project: PathBuf,
    opts: McpOptions,
    input: R,
    mut out: W,
) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin,
{
    let (mut role, r, mut up) = elect(&project, &opts).await?;
    let (ctx, mut client) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(input).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if ctx.send(line).is_err() {
                return;
            }
        }
    });
    let (utx, mut upstream) = mpsc::unbounded_channel::<(u64, Option<String>)>();
    let mut generation = 0u64;
    spawn_reader(r, generation, utx.clone());
    let mut state = State::default();

    loop {
        tokio::select! {
            line = client.recv() => {
                let Some(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let line = state.from_client(line);
                // A write to a dead upstream is noticed by its reader (EOF);
                // the request is in flight and gets its error then.
                let _ = write_line(&mut up, &line).await;
            }
            msg = upstream.recv() => {
                let Some((g, line)) = msg else { break };
                if g != generation {
                    continue;
                }
                match line {
                    Some(line) => {
                        if let Some(line) = state.from_upstream(line)
                            && write_line(&mut out, &line).await.is_err()
                        {
                            break;
                        }
                    }
                    None => {
                        trace("upstream closed");
                        for e in state.fail_inflight() {
                            let _ = write_line(&mut out, &e).await;
                        }
                        let (r, w) = match &role {
                            Role::Owner(o) => o.connect(),
                            Role::Relay(_) => {
                                let (new_role, r, w) = elect(&project, &opts).await?;
                                role = new_role;
                                (r, w)
                            }
                        };
                        up = w;
                        generation += 1;
                        spawn_reader(r, generation, utx.clone());
                        for line in state.replay() {
                            let _ = write_line(&mut up, &line).await;
                        }
                        let role_name = match &role {
                            Role::Owner(_) => "owner",
                            Role::Relay(_) => "relay",
                        };
                        trace(format_args!("resynced as {role_name}"));
                        for line in state.resync_notes(role_name) {
                            if write_line(&mut out, &line).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    // The client went away: detach from the upstream, then drain if owner.
    let _ = up.shutdown().await;
    drop(up);
    match role {
        Role::Owner(o) => o.drain().await,
        Role::Relay(sock) => trace(format_args!("detached from {}", sock.display())),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn initialize_names_the_relay_and_is_recorded() {
        let mut st = State::default();
        let out = st.from_client(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"lecturn","version":"1"}}}"#.into(),
        );
        assert_eq!(v(&out)["params"]["clientInfo"]["name"], RELAY_CLIENT);
        assert_eq!(v(&out)["params"]["clientInfo"]["version"], "1");
        assert_eq!(v(&out)["id"], 1);
        st.from_client(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.into());
        let line = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#.to_string();
        assert_eq!(st.from_upstream(line.clone()), Some(line));
        assert!(st.inflight.is_empty());
        assert!(st.initialized);
    }

    #[test]
    fn other_lines_pass_through_byte_for_byte() {
        let mut st = State::default();
        let line = r#"{"jsonrpc":"2.0","id":"a","method":"tools/call","params":{"name":"x","_meta":{"lecturn/approval":{"approved":true}}}}"#;
        assert_eq!(st.from_client(line.into()), line);
        assert_eq!(st.from_client("not json".into()), "not json");
        let note = r#"{"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"rw://project/model"}}"#;
        assert_eq!(st.from_upstream(note.into()).as_deref(), Some(note));
    }

    #[test]
    fn upstream_loss_fails_inflight_and_replays_the_session() {
        let mut st = State::default();
        st.from_client(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"clientInfo":{"name":"c","version":"0"}}}"#.into());
        st.from_upstream(r#"{"jsonrpc":"2.0","id":0,"result":{}}"#.into());
        st.from_client(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.into());
        st.from_client(r#"{"jsonrpc":"2.0","id":1,"method":"resources/subscribe","params":{"uri":"rw://project/model"}}"#.into());
        st.from_client(r#"{"jsonrpc":"2.0","id":2,"method":"resources/subscribe","params":{"uri":"rw://project/check"}}"#.into());
        st.from_client(r#"{"jsonrpc":"2.0","id":3,"method":"resources/unsubscribe","params":{"uri":"rw://project/check"}}"#.into());
        st.from_client(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"model_patch","_meta":{"lecturn/context":{"threadId":"t"}}}}"#
                .into(),
        );
        st.from_client(r#"{"jsonrpc":"2.0","id":5,"method":"weird/method"}"#.into());
        for id in 1..=3 {
            st.from_upstream(format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{{}}}}"#));
        }
        let errs: Vec<Value> = st.fail_inflight().iter().map(|l| v(l)).collect();
        assert_eq!(errs.len(), 2);
        // A lost mutation: a tool error result, outcome unknown.
        let e = &errs[0];
        assert_eq!(e["id"], 4);
        assert_eq!(e["result"]["isError"], true);
        let err = &e["result"]["_meta"]["rw/error"];
        assert_eq!(err["code"], "unavailable");
        assert_eq!(err["outcome"], "unknown");
        assert!(err["message"].as_str().unwrap().contains("model_patch"));
        assert_eq!(e["result"]["_meta"]["lecturn/context"]["threadId"], "t");
        assert_eq!(e["result"]["_meta"]["lecturn/summary"], "Outcome unknown");
        // An unclassifiable method counts as a mutation.
        assert_eq!(errs[1]["id"], 5);
        assert_eq!(errs[1]["error"]["data"]["code"], "unavailable");
        assert_eq!(errs[1]["error"]["data"]["outcome"], "unknown");
        let replay: Vec<Value> = st.replay().iter().map(|l| v(l)).collect();
        assert_eq!(replay.len(), 3);
        assert_eq!(replay[0]["method"], "initialize");
        assert_eq!(replay[0]["params"]["clientInfo"]["name"], RELAY_CLIENT);
        assert_eq!(replay[1]["method"], "notifications/initialized");
        assert_eq!(replay[2]["params"]["uri"], "rw://project/model");
        // The relay's own responses never reach the client.
        for r in [&replay[0], &replay[2]] {
            let line = json!({"jsonrpc": "2.0", "id": r["id"], "result": {}}).to_string();
            assert_eq!(st.from_upstream(line), None);
        }
    }

    #[test]
    fn lost_reads_are_retried_once() {
        let mut st = State::default();
        st.from_client(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"clientInfo":{"name":"c","version":"0"}}}"#.into());
        st.from_upstream(r#"{"jsonrpc":"2.0","id":0,"result":{}}"#.into());
        st.from_client(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.into());
        let read = st.from_client(
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"model_get","arguments":{}}}"#
                .into(),
        );
        let res = st.from_client(
            r#"{"jsonrpc":"2.0","id":10,"method":"resources/read","params":{"uri":"rw://project/model"}}"#
                .into(),
        );
        assert!(st.fail_inflight().is_empty(), "reads are not failed");
        let replay = st.replay();
        assert_eq!(replay.len(), 4, "{replay:?}");
        assert_eq!(replay[2], read, "resent after the handshake");
        assert_eq!(replay[3], res);
        assert_eq!(st.replay().len(), 2, "resent once per loss");
        // Lost again: unavailable, no outcome (nothing could have changed).
        let errs: Vec<Value> = st.fail_inflight().iter().map(|l| v(l)).collect();
        assert_eq!(errs.len(), 2);
        let e = &errs[0]["result"]["_meta"]["rw/error"];
        assert_eq!(e["code"], "unavailable");
        assert!(e.get("outcome").is_none());
        assert_eq!(errs[1]["id"], 10);
        assert!(errs[1]["error"]["data"].get("outcome").is_none());
    }

    #[test]
    fn resync_notes_name_every_subscription_then_upstream_changed() {
        let mut st = State::default();
        st.from_client(r#"{"jsonrpc":"2.0","id":1,"method":"resources/subscribe","params":{"uri":"rw://project/model"}}"#.into());
        st.from_client(r#"{"jsonrpc":"2.0","id":2,"method":"resources/subscribe","params":{"uri":"rw://jobs/j1"}}"#.into());
        let notes: Vec<Value> = st.resync_notes("owner").iter().map(|l| v(l)).collect();
        assert_eq!(notes.len(), 3);
        assert_eq!(notes[0]["method"], "notifications/resources/updated");
        assert_eq!(notes[0]["params"]["uri"], "rw://jobs/j1");
        assert_eq!(notes[1]["params"]["uri"], "rw://project/model");
        assert_eq!(notes[2]["method"], UPSTREAM_CHANGED);
        assert_eq!(notes[2]["params"]["role"], "owner");
    }

    #[test]
    fn a_pending_initialize_is_replayed_with_its_own_id() {
        let mut st = State::default();
        st.from_client(r#"{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"clientInfo":{"name":"c","version":"0"}}}"#.into());
        assert!(st.fail_inflight().is_empty());
        let replay = st.replay();
        assert_eq!(replay.len(), 1);
        assert_eq!(v(&replay[0])["id"], 7);
    }
}
