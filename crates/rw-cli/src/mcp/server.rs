//! The rmcp handler. One [`RwServer`] per connection (stdio, or one socket
//! client); all share one [`Hub`] holding the resource subscriptions.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorCode,
    Implementation, ListResourceTemplatesResult, ListResourcesResult, ListToolsResult, MetaObject,
    PaginatedRequestParams, ProtocolVersion, ReadResourceRequestParams, ReadResourceResponse,
    ReadResourceResult, ResourceContents, ResourceUpdatedNotificationParam, ServerCapabilities,
    ServerConfig, SubscribeRequestParams, UnsubscribeRequestParams,
};
use rmcp::service::{Peer, RequestContext};
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use rw_api::{ApiError, ApiErrorCode, CallCtx, CommandDef, Origin};
use rw_project::SharedSession;
use serde_json::{Map, Value, json};

use super::{
    PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, approval, catalog, dispatch, meta, picture,
    presentation, resources, series, store,
};

/// Resources a successful mutation changes (contract-fixture mode; with a
/// session, its events say what changed).
pub const MUTATION_URIS: &[&str] = &rw_project::session::MUTATION_URIS;

struct Subscriber {
    peer: Peer<RoleServer>,
    uris: BTreeSet<String>,
}

/// State shared by every connection of one sidecar.
pub struct Hub {
    pub project: PathBuf,
    /// Started with `--app`.
    pub app: bool,
    /// The project's session; unset for a directory without
    /// `rocketwright.toml` (contract-fixture mode) until `project_create`.
    session: OnceLock<SharedSession>,
    next_conn: AtomicU64,
    subs: Mutex<BTreeMap<u64, Subscriber>>,
    /// Changed resource URIs, drained by the sidecar's notifier task.
    updates: Mutex<Option<tokio::sync::mpsc::UnboundedSender<Vec<String>>>>,
    watcher: Mutex<Option<rw_project::Watcher>>,
    /// `.rw/lock`, while no session holds it (an empty directory).
    lock: Mutex<Option<rw_project::ProjectLock>>,
    /// Relays (`clientInfo.name` [`RELAY_CLIENT`]) attached over the socket;
    /// the owner drains while any remain (D4).
    relays: AtomicUsize,
    /// The session's job queue (read without the session lock).
    jobs: OnceLock<rw_project::JobQueue>,
}

/// `clientInfo.name` a relay sends upstream; the owner treats such socket
/// connections as [`Origin::Mcp`] (D4).
pub const RELAY_CLIENT: &str = "rocketwright-relay";

impl Hub {
    pub fn new(project: PathBuf, app: bool) -> Self {
        Self {
            project,
            app,
            session: OnceLock::new(),
            next_conn: AtomicU64::new(1),
            subs: Mutex::new(BTreeMap::new()),
            updates: Mutex::new(None),
            watcher: Mutex::new(None),
            lock: Mutex::new(None),
            relays: AtomicUsize::new(0),
            jobs: OnceLock::new(),
        }
    }

    /// A relay connection finished its handshake.
    pub fn relay_attached(&self) {
        self.relays.fetch_add(1, Ordering::SeqCst);
    }

    /// A relay connection closed.
    pub fn relay_detached(&self) {
        self.relays.fetch_sub(1, Ordering::SeqCst);
    }

    /// Relays attached now.
    pub fn relay_count(&self) -> usize {
        self.relays.load(Ordering::SeqCst)
    }

    /// True while a job is queued or running on the session.
    pub fn jobs_active(&self) -> bool {
        let Some(jobs) = self.jobs.get() else {
            return false;
        };
        jobs.list().iter().any(|j| {
            !matches!(
                j.state,
                rw_api::JobState::Complete | rw_api::JobState::Failed | rw_api::JobState::Cancelled
            )
        })
    }

    /// Keeps `.rw/lock` until a session takes it over.
    pub fn hold_lock(&self, lock: rw_project::ProjectLock) {
        *self.lock.lock().unwrap_or_else(|e| e.into_inner()) = Some(lock);
    }

    /// Hands the held lock to a new session.
    pub fn take_lock(&self) -> Option<rw_project::ProjectLock> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// The project's session, once there is one.
    pub fn session(&self) -> Option<&SharedSession> {
        self.session.get()
    }

    /// Routes resource-change URIs to the notifier (set by the sidecar).
    pub fn set_updates(&self, tx: tokio::sync::mpsc::UnboundedSender<Vec<String>>) {
        *self.updates.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    }

    /// Queues `notifications/resources/updated` for `uris` (non-blocking).
    pub fn post_updated(&self, uris: Vec<String>) {
        if let Some(tx) = self
            .updates
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            let _ = tx.send(uris);
        }
    }

    /// Installs the session: its change events and job updates feed the
    /// notifier, and (with `watch`) the project watcher starts (M1.29).
    /// A second call is ignored.
    pub fn attach_session(self: &Arc<Self>, s: SharedSession, watch: bool) {
        if self.session.set(s.clone()).is_err() {
            return;
        }
        {
            let mut g = s.lock().unwrap_or_else(|e| e.into_inner());
            let hub = Arc::downgrade(self);
            g.on_event(move |e| {
                if let Some(h) = hub.upgrade() {
                    h.post_updated(e.uris.iter().map(|u| (*u).to_string()).collect());
                }
            });
            let _ = self.jobs.set(g.jobs().clone());
            let hub = Arc::downgrade(self);
            g.jobs().on_update(move |info| {
                if let Some(h) = hub.upgrade() {
                    h.post_updated(super::resources::job_update_uris(&info.job_id));
                }
            });
        }
        if watch {
            match rw_project::Watcher::start(s, |_| {}) {
                Ok(w) => *self.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(w),
                Err(e) => eprintln!("rocketwright mcp: not watching the project: {e}"),
            }
        }
    }

    /// Stops the watcher (shutdown).
    pub fn stop_watching(&self) {
        self.watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }

    fn next_conn(&self) -> u64 {
        self.next_conn.fetch_add(1, Ordering::Relaxed)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<u64, Subscriber>> {
        self.subs.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn subscribe(&self, conn: u64, peer: Peer<RoleServer>, uri: String) {
        self.lock()
            .entry(conn)
            .or_insert_with(|| Subscriber {
                peer,
                uris: BTreeSet::new(),
            })
            .uris
            .insert(uri);
    }

    pub fn unsubscribe(&self, conn: u64, uri: &str) {
        if let Some(s) = self.lock().get_mut(&conn) {
            s.uris.remove(uri);
        }
    }

    /// Forgets a closed connection's subscriptions.
    pub fn drop_conn(&self, conn: u64) {
        self.lock().remove(&conn);
    }

    /// Number of subscribed URIs across connections (diagnostics, tests).
    pub fn subscription_count(&self) -> usize {
        self.lock().values().map(|s| s.uris.len()).sum()
    }

    /// Sends `notifications/resources/updated` to every connection subscribed
    /// to one of `uris`. Delivery failures (closed peers) are ignored.
    pub async fn notify_updated<S: AsRef<str>>(&self, uris: &[S]) {
        let targets: Vec<(Peer<RoleServer>, String)> = self
            .lock()
            .values()
            .flat_map(|s| {
                uris.iter()
                    .filter(|u| s.uris.contains(u.as_ref()))
                    .map(|u| (s.peer.clone(), u.as_ref().to_string()))
            })
            .collect();
        for (peer, uri) in targets {
            let _ = peer
                .notify_resource_updated(ResourceUpdatedNotificationParam::new(uri))
                .await;
        }
    }
}

/// Test hook (B1b, `RW_TEST_HOOKS=1`): the owner process exits just before
/// running the named tool (a call lost mid-read).
pub const TEST_EXIT_BEFORE: &str = "RW_TEST_EXIT_BEFORE";
/// Test hook (B1b, `RW_TEST_HOOKS=1`): the owner process exits after the
/// named tool ran (committed) and before it replies.
pub const TEST_EXIT_AFTER: &str = "RW_TEST_EXIT_AFTER";

/// Exits the process when the `RW_TEST_HOOKS` hook `var` names `tool`.
fn exit_for_tests(var: &str, tool: &str) {
    if std::env::var("RW_TEST_HOOKS").as_deref() == Ok("1")
        && std::env::var(var).as_deref() == Ok(tool)
    {
        eprintln!("rocketwright mcp: {var}={tool}: exiting");
        std::process::exit(70);
    }
}

/// One connection's handler.
#[derive(Clone)]
pub struct RwServer {
    hub: Arc<Hub>,
    conn: u64,
    origin: Origin,
}

fn api_error_value(e: &ApiError) -> Value {
    serde_json::to_value(e).unwrap_or_else(|_| json!({"code": "internal", "message": e.message}))
}

fn mcp_error(e: &ApiError) -> McpError {
    let code = match e.code {
        ApiErrorCode::NotFound => ErrorCode::RESOURCE_NOT_FOUND,
        ApiErrorCode::InvalidInput => ErrorCode::INVALID_PARAMS,
        _ => ErrorCode::INTERNAL_ERROR,
    };
    McpError::new(code, e.message.clone(), Some(api_error_value(e)))
}

impl RwServer {
    pub fn new(hub: Arc<Hub>, origin: Origin) -> Self {
        let conn = hub.next_conn();
        Self { hub, conn, origin }
    }

    /// This connection's id in the [`Hub`].
    pub fn conn(&self) -> u64 {
        self.conn
    }

    /// The connection's origin: a relay over the socket speaks for an MCP
    /// client, never the CLI (D4).
    fn origin(&self, context: &RequestContext<RoleServer>) -> Origin {
        let relay = || {
            context
                .peer
                .peer_info()
                .is_some_and(|i| i.client_info.name == RELAY_CLIENT)
        };
        if self.origin == Origin::Socket && relay() {
            Origin::Mcp
        } else {
            self.origin
        }
    }

    /// The call context, plus the request `_meta` keys echoed in the result.
    fn ctx(
        &self,
        request: &CallToolRequestParams,
        context: &RequestContext<RoleServer>,
    ) -> (CallCtx, Map<String, Value>) {
        let mut m: Map<String, Value> = context.meta.0.0.clone();
        if let Some(rm) = &request.meta {
            for (k, v) in rm.0.0.iter() {
                m.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        let echo = meta::echoed(&m)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        (meta::call_ctx(&m, self.origin(context)), echo)
    }
}

/// `resources/read` of a `ui://rw/*` card (B3, D7): the HTML, with
/// `_meta.ui` saying it needs no network (an empty CSP allowance) and
/// prefers a host border.
fn ui_card(uri: &str) -> Result<ReadResourceResult, McpError> {
    let Some(card) = resources::ui_card(uri) else {
        return Err(McpError::new(
            ErrorCode::RESOURCE_NOT_FOUND,
            format!("unknown resource `{uri}`"),
            None,
        ));
    };
    let m = json!({
        "ui": {
            "csp": { "connectDomains": [], "resourceDomains": [] },
            "prefersBorder": true,
        }
    });
    Ok(ReadResourceResult::new(vec![
        ResourceContents::text(card.html, card.uri)
            .with_mime_type(resources::UI_MIME)
            .with_meta(MetaObject(m.as_object().cloned().unwrap_or_default())),
    ]))
}

/// Puts the call's one-line `lecturn/summary` in the result `_meta`
/// (CPW1R4B): what it found, or a short failure phrase.
fn summarize(
    m: &mut Map<String, Value>,
    name: &str,
    args: &Value,
    outcome: Result<&Value, &ApiError>,
) {
    m.insert(
        presentation::SUMMARY.into(),
        Value::String(presentation::summary(name, args, outcome)),
    );
}

impl RwServer {
    /// `run_series` (app-only, read-only; never gated).
    fn call_series(
        &self,
        request: &CallToolRequestParams,
        context: &RequestContext<RoleServer>,
    ) -> CallToolResult {
        let (ctx, mut m) = self.ctx(request, context);
        m.insert(
            meta::CTX.into(),
            serde_json::to_value(&ctx).unwrap_or(Value::Null),
        );
        let args = Value::Object(request.arguments.clone().unwrap_or_default());
        let project = self.hub.project.clone();
        let outcome = tokio::task::block_in_place(|| series::call(&project, args.clone()));
        summarize(&mut m, series::NAME, &args, outcome.as_ref());
        let mut result = match outcome {
            Ok(out) => {
                let mut r = CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string(&out).unwrap_or_default(),
                )]);
                r.structured_content = Some(out);
                r
            }
            Err(e) => {
                let v = api_error_value(&e);
                m.insert(meta::ERROR.into(), v.clone());
                CallToolResult::error(vec![ContentBlock::text(v.to_string())])
            }
        };
        result.meta = Some(MetaObject(m));
        result
    }

    /// `render_picture` (app-only, read-only; never gated).
    fn call_picture(
        &self,
        request: &CallToolRequestParams,
        context: &RequestContext<RoleServer>,
    ) -> CallToolResult {
        let (ctx, mut m) = self.ctx(request, context);
        m.insert(
            meta::CTX.into(),
            serde_json::to_value(&ctx).unwrap_or(Value::Null),
        );
        let args = Value::Object(request.arguments.clone().unwrap_or_default());
        let project = self.hub.project.clone();
        let outcome = tokio::task::block_in_place(|| picture::call(&project, args.clone()));
        summarize(
            &mut m,
            picture::NAME,
            &args,
            outcome.as_ref().map(|(out, _)| out),
        );
        let mut result = match outcome {
            Ok((out, png)) => {
                let mut r = CallToolResult::success(vec![
                    ContentBlock::text(serde_json::to_string(&out).unwrap_or_default()),
                    ContentBlock::image(png, "image/png"),
                ]);
                r.structured_content = Some(out);
                r
            }
            Err(e) => {
                let v = api_error_value(&e);
                m.insert(meta::ERROR.into(), v.clone());
                CallToolResult::error(vec![ContentBlock::text(v.to_string())])
            }
        };
        result.meta = Some(MetaObject(m));
        result
    }
}

impl RwServer {
    /// `render_store` (internal, unlisted): the app server stores a window
    /// render under `renders/` through the session.
    fn call_store(
        &self,
        request: &CallToolRequestParams,
        context: &RequestContext<RoleServer>,
    ) -> CallToolResult {
        let (_, mut m) = self.ctx(request, context);
        let args = Value::Object(request.arguments.clone().unwrap_or_default());
        let session = self.hub.session().cloned();
        let outcome = tokio::task::block_in_place(|| store::call(session.as_ref(), args));
        let mut result = match outcome {
            Ok(out) => {
                let mut r = CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string(&out).unwrap_or_default(),
                )]);
                r.structured_content = Some(out);
                r
            }
            Err(e) => {
                let v = api_error_value(&e);
                m.insert(meta::ERROR.into(), v.clone());
                CallToolResult::error(vec![ContentBlock::text(v.to_string())])
            }
        };
        result.meta = Some(MetaObject(m));
        result
    }
}

/// The server's MCP `instructions` (agent-facing: rw: refs in plain text, CPW2A).
pub const INSTRUCTIONS: &str = "RocketWright project sidecar. Write rw: references as plain \
     text (rw:c/fins), never inside backticks or code blocks, so they render as links. Tool, \
     file and field names need no code formatting either. Example reply: The fins rw:c/fins now \
     span 50 mm, and design_check passes with no errors. Edit through tools; every mutating tool \
     returns a check delta. Run the design_check tool after every edit. Tool names in these texts \
     are bare; a host may list them with a prefix (rw_design_check): call the listed name. \
     Resources: rw://project/model, rw://project/check, rw://runs/<id>/summary, \
     rw://schema/<type>.";

#[allow(deprecated)] // resources/subscribe is the 2025-11-25 mechanism (pinned).
impl ServerHandler for RwServer {
    fn get_info(&self) -> ServerConfig {
        let caps = ServerCapabilities::builder()
            .enable_tools()
            .enable_resources()
            .enable_resources_subscribe()
            .build();
        ServerConfig::new(caps)
            .with_protocol_version(PROTOCOL_VERSION)
            .with_server_info(Implementation::new(
                "rocketwright",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(INSTRUCTIONS)
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(SUPPORTED_PROTOCOL_VERSIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(catalog::tools().to_vec()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        if request.name == series::NAME {
            return Ok(self.call_series(&request, &context).into());
        }
        if request.name == picture::NAME {
            return Ok(self.call_picture(&request, &context).into());
        }
        // Internal: never for a call Lecturn proxied (it answers as unknown).
        if request.name == store::NAME
            && !self
                .ctx(&request, &context)
                .1
                .contains_key(meta::LECTURN_CONTEXT)
        {
            return Ok(self.call_store(&request, &context).into());
        }
        // Socket clients (CLI forwarding, D4) may also run CLI-only commands.
        let def: Option<&'static CommandDef> = catalog::mcp_command(&request.name).or_else(|| {
            (self.origin(&context) == Origin::Socket)
                .then(|| rw_api::command_def(&request.name))
                .flatten()
        });
        let Some(def) = def else {
            return Err(McpError::new(
                ErrorCode::INVALID_PARAMS,
                format!("unknown tool `{}`", request.name),
                None,
            ));
        };
        let (ctx, mut m) = self.ctx(&request, &context);
        let args = Value::Object(request.arguments.clone().unwrap_or_default());
        m.insert(
            meta::CTX.into(),
            serde_json::to_value(&ctx).unwrap_or(Value::Null),
        );
        // App-decided approval (D6): only calls Lecturn proxied are gated.
        let gate = m
            .get(meta::LECTURN_APPROVAL)
            .and_then(|a| approval::gate(def, &args, a));
        let outcome = match gate {
            Some(approval::Gate::Refuse(e)) => Err(e),
            Some(approval::Gate::Ask(reason)) => {
                m.insert(
                    meta::LECTURN_APPROVAL_REQUIRED.into(),
                    json!({ "reason": reason }),
                );
                Err(approval::approval_required(&reason))
            }
            None => {
                let hub = self.hub.clone();
                exit_for_tests(TEST_EXIT_BEFORE, def.name);
                let outcome = tokio::task::block_in_place(|| {
                    super::tools::call(&hub, def, args.clone(), &ctx)
                });
                exit_for_tests(TEST_EXIT_AFTER, def.name);
                outcome
            }
        };
        summarize(
            &mut m,
            def.name,
            &args,
            outcome.as_ref().map(|(out, _)| out),
        );
        let session = self.hub.session();
        let result = match outcome {
            Ok((out, content)) => {
                let mut r = CallToolResult::success(content);
                r.structured_content = Some(out);
                // With a session, its events announce changes (watcher
                // edits included); doubles announce every wet mutation.
                if session.is_none() && def.hints.mutating && !dispatch::is_dry_run(&args) {
                    self.hub.notify_updated(MUTATION_URIS).await;
                }
                r
            }
            Err(e) => {
                let v = api_error_value(&e);
                m.insert(meta::ERROR.into(), v.clone());
                CallToolResult::error(vec![ContentBlock::text(v.to_string())])
            }
        };
        let mut result = result;
        result.meta = Some(MetaObject(m));
        Ok(result.into())
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        Ok(ListResourcesResult::with_all_items(catalog::resources()))
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, McpError> {
        Ok(ListResourceTemplatesResult::with_all_items(
            catalog::resource_templates(),
        ))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        if request.uri.starts_with("ui://rw/") {
            return ui_card(&request.uri).map(Into::into);
        }
        let session = self.hub.session();
        let v = tokio::task::block_in_place(|| dispatch::read_resource(session, &request.uri))
            .map_err(|e| mcp_error(&e))?;
        let text = serde_json::to_string(&v).unwrap_or_default();
        Ok(ReadResourceResult::new(vec![
            ResourceContents::text(text, request.uri).with_mime_type("application/json"),
        ])
        .into())
    }

    async fn subscribe(
        &self,
        request: SubscribeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<(), McpError> {
        match catalog::resource_for(&request.uri) {
            Some((def, _)) if def.subscribable => {
                self.hub
                    .subscribe(self.conn, context.peer.clone(), request.uri);
                Ok(())
            }
            Some(_) => Err(McpError::new(
                ErrorCode::INVALID_PARAMS,
                format!("`{}` does not support subscriptions", request.uri),
                None,
            )),
            None => Err(McpError::new(
                ErrorCode::RESOURCE_NOT_FOUND,
                format!("unknown resource `{}`", request.uri),
                None,
            )),
        }
    }

    async fn unsubscribe(
        &self,
        request: UnsubscribeRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<(), McpError> {
        self.hub.unsubscribe(self.conn, &request.uri);
        Ok(())
    }
}
