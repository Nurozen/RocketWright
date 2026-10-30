//! `Session`: the only writer of project files (invariant I1) and the single
//! executor of `rw_api::Command`s (I2). M1.26a.
//!
//! Mutation pipeline (every mutating command, every front end):
//!
//! 1. **ops → apply**: `TomlStore::preview` (decor-preserving, pure);
//! 2. **eval**: library materials merged in ([`crate::library`]);
//! 3. **check**: the session's [`Checker`] (`rw_check::check_static` by default);
//! 4. **dry run** returns here: the delta, nothing written (I6);
//! 5. **atomic write**: temp file + rename per changed file;
//! 6. **own-write set**: the hash of every file just written, so the watcher
//!    skips its own echo;
//! 7. **history**: a step when the snapshot tree changed (D3);
//! 8. **events**: listeners hear which resources changed;
//! 9. **`MutationOut { step, model_hash, delta }`**.
//!
//! External edits (the watcher, or edits made while no owner ran) go through
//! [`Session::sync_from_disk`]: a file that does not parse keeps the last
//! good model and reports `RW-E001` until it is fixed.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rw_api::{
    ApiError, ApiErrorCode, CallCtx, Command, CompareOut, ComponentAddIn, ComponentMoveIn,
    ComponentRemoveIn, DesignCheckIn, FileChange, FileStatus, HistoryListIn, HistoryListOut,
    HistoryShowOut, LibrarySearchOut, ModelDiff, ModelGetIn, ModelGetOut, MutationOut, Origin,
    ProjectFiles, ProjectValidateIn, Response, ValidateOut,
};
use rw_check::CheckReport;
use rw_model::diag::{self, Diagnostic};
use rw_model::source::parse_source_with_warnings;
use rw_model::{EvalOptions, EvaluatedModel, ModelValue, PatchError, PatchOp, SourceSet};
use serde_json::Value;

use crate::check::{Checker, StaticChecker, sort_diagnostics};
pub use crate::history::compare::model_diff;
use crate::history::compare::{breakdown_rows, component_marks, report_rows, summary_rows};
use crate::history::{History, HistoryError, Snapshot, StepMeta};
use crate::jobs::JobQueue;
use crate::layout::{self, sha256_hex};
use crate::library::{Library, manifest_lib};
use crate::lock::{LockError, ProjectLock};
use crate::runs::RunStore;
use crate::store::TomlStore;
use crate::{clock, fsutil};

/// Resources a recorded mutation changes (`rw://project/*`).
pub const URI_MODEL: &str = "rw://project/model";
pub const URI_CHECK: &str = "rw://project/check";
pub const URI_FILES: &str = "rw://project/files";
pub const URI_HISTORY: &str = "rw://project/history";
pub const MUTATION_URIS: [&str; 4] = [URI_MODEL, URI_CHECK, URI_FILES, URI_HISTORY];
/// `run_list` as a resource.
pub const URI_RUNS: &str = "rw://runs/index";

/// `rw://jobs/<id>`.
pub fn job_uri(id: &str) -> String {
    format!("rw://jobs/{id}")
}

/// A session shared between the MCP handlers and the watcher thread.
pub type SharedSession = Arc<Mutex<Session>>;

/// What changed, for subscribers (`notifications/resources/updated`).
#[derive(Debug, Clone, PartialEq)]
pub struct SessionEvent {
    pub uris: Vec<&'static str>,
    pub origin: Origin,
    pub step: Option<rw_api::HistoryStep>,
}

type Listener = Arc<dyn Fn(&SessionEvent) + Send + Sync>;

/// How the session takes `.rw/lock`.
#[derive(Debug, Default)]
pub enum LockMode {
    /// No lock: read-only (CLI reads, tests).
    #[default]
    None,
    /// Acquire `.rw/lock` (recording the socket path, if any).
    Acquire(Option<PathBuf>),
    /// Use a lock the caller already holds (the sidecar).
    Held(ProjectLock),
}

pub struct SessionOptions {
    pub lock: LockMode,
    /// Allow writes (project files and history).
    pub writable: bool,
    pub checker: Arc<dyn Checker>,
    /// The queue simulations run on (shared with the caller to wait on jobs).
    pub jobs: JobQueue,
    /// Title of the snapshot step recorded on open (default: `Initial
    /// snapshot` for a project without history, else `External edit`).
    pub snapshot_title: Option<String>,
    /// Origin of that snapshot step (default: `watcher`, an edit made while
    /// no owner ran; `rw init` / `project_create` pass their caller's).
    pub snapshot_origin: Origin,
}

impl SessionOptions {
    /// The single writer: takes `.rw/lock`, writes files and history.
    pub fn writer() -> Self {
        Self {
            lock: LockMode::Acquire(None),
            writable: true,
            checker: Arc::new(StaticChecker),
            jobs: JobQueue::default(),
            snapshot_title: None,
            snapshot_origin: Origin::Watcher,
        }
    }

    /// Reads only; takes no lock and writes nothing (not even history).
    pub fn read_only() -> Self {
        Self {
            lock: LockMode::None,
            writable: false,
            checker: Arc::new(StaticChecker),
            jobs: JobQueue::default(),
            snapshot_title: None,
            snapshot_origin: Origin::Watcher,
        }
    }

    pub fn with_lock(mut self, lock: LockMode) -> Self {
        self.lock = lock;
        self
    }

    pub fn with_checker(mut self, checker: Arc<dyn Checker>) -> Self {
        self.checker = checker;
        self
    }

    pub fn with_jobs(mut self, jobs: JobQueue) -> Self {
        self.jobs = jobs;
        self
    }

    /// Titles the snapshot step recorded on open (blank: the default title).
    pub fn with_snapshot_title(mut self, title: Option<String>) -> Self {
        self.snapshot_title = title
            .map(|t| t.lines().next().unwrap_or("").trim().to_string())
            .filter(|t| !t.is_empty());
        self
    }

    /// The origin recorded on the snapshot step taken on open.
    pub fn with_snapshot_origin(mut self, origin: Origin) -> Self {
        self.snapshot_origin = origin;
        self
    }
}

/// What [`Session::sync_from_disk`] did.
#[derive(Debug, Clone, PartialEq)]
pub enum SyncOutcome {
    /// Disk matches the session (own writes, replays, touch).
    Unchanged,
    /// External changes applied; a step when the tree changed.
    Applied(Option<Box<rw_api::HistoryStep>>),
    /// A changed file does not parse: the last good model is kept.
    ParseError(Vec<Diagnostic>),
}

pub struct Session {
    root: PathBuf,
    checker: Arc<dyn Checker>,
    _lock: Option<ProjectLock>,
    writable: bool,
    store: TomlStore,
    /// Last good text of every source file as it is on disk.
    known: BTreeMap<String, String>,
    /// Files on disk that do not parse (kept out of the store), by path.
    external: BTreeMap<String, Vec<Diagnostic>>,
    library: Library,
    lib_hashes: BTreeMap<String, String>,
    model: EvaluatedModel,
    report: CheckReport,
    /// blake3 of each file this session last wrote (`None`: deleted).
    own_writes: BTreeMap<String, Option<String>>,
    history: Option<History>,
    listeners: Vec<Listener>,
    runs: RunStore,
    jobs: JobQueue,
    /// Liquid engine designs by engine content (M4.6).
    liquid: crate::liquid::DesignCache,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("root", &self.root)
            .field("writable", &self.writable)
            .field("model_hash", &self.model.model_hash)
            .finish_non_exhaustive()
    }
}

// ---- errors -------------------------------------------------------------------

fn err(code: ApiErrorCode, message: impl Into<String>) -> ApiError {
    ApiError {
        outcome: None,
        code,
        message: message.into(),
        hint: None,
        diagnostics: Vec::new(),
    }
}

fn with_hint(mut e: ApiError, hint: impl Into<String>) -> ApiError {
    e.hint = Some(hint.into());
    e
}

fn io_err(what: &str, e: std::io::Error) -> ApiError {
    err(ApiErrorCode::Io, format!("{what}: {e}"))
}

fn history_err(e: HistoryError) -> ApiError {
    match e {
        HistoryError::UnknownVersion(v) => with_hint(
            err(ApiErrorCode::NotFound, format!("unknown version `{v}`")),
            "versions are live, HEAD, step:<n>, rev:<NN>, commit:<sha>; see history_list",
        ),
        HistoryError::Io(e) => io_err("history", e),
        HistoryError::Invalid(m) => err(ApiErrorCode::InvalidInput, m),
        e @ HistoryError::Git(_) => err(ApiErrorCode::Internal, e.to_string()),
    }
}

/// `RW-E007 locked-by <pid>` as an API error.
pub fn locked_error(e: &LockError) -> ApiError {
    match e {
        LockError::Io(io) => io_err(".rw/lock", std::io::Error::new(io.kind(), io.to_string())),
        _ => {
            let pid = e.pid();
            let msg = match pid {
                Some(p) => format!("locked-by {p}: another process owns this project"),
                None => "locked-by another process".to_string(),
            };
            let mut d = Diagnostic::new(diag::E_LOCKED, None, msg.clone());
            d.file = Some(crate::lock::LOCK_REL.into());
            let mut a = with_hint(
                err(ApiErrorCode::Locked, msg),
                "mutating rw commands forward to the live sidecar over .rw/sidecar.sock; close the other owner or use it",
            );
            a.diagnostics.push(d);
            a
        }
    }
}

fn patch_error(e: PatchError) -> ApiError {
    with_hint(
        err(
            ApiErrorCode::InvalidInput,
            format!("op {} at `{}`: {}", e.op, e.path, e.message),
        ),
        "paths address the id-keyed model (`/c/<id>/<field>`); read it with model_get or rw://schema/tools/model_patch.input",
    )
}

fn blake3_hex(s: &str) -> String {
    blake3::hash(s.as_bytes()).to_hex().to_string()
}

// ---- session ------------------------------------------------------------------

impl Session {
    /// Opens the project at `root` (the directory holding `rocketwright.toml`).
    pub fn open(root: &Path, opts: SessionOptions) -> Result<Session, ApiError> {
        let root = root
            .canonicalize()
            .map_err(|e| io_err(&format!("project {}", root.display()), e))?;
        if !layout::is_project(&root) {
            return Err(with_hint(
                err(
                    ApiErrorCode::NotFound,
                    format!("{} has no {}", root.display(), layout::MANIFEST),
                ),
                "create a project with `rw init` (project_create)",
            ));
        }
        let lock = match opts.lock {
            LockMode::None => None,
            LockMode::Held(l) => Some(l),
            LockMode::Acquire(sock) => {
                Some(ProjectLock::acquire(&root, sock.as_deref()).map_err(|e| locked_error(&e))?)
            }
        };
        let disk = layout::read_project(&root).map_err(|e| io_err("reading the project", e))?;
        let mut store = TomlStore::new();
        let mut known = BTreeMap::new();
        let mut external = BTreeMap::new();
        for (path, text) in &disk.sources {
            match store.insert(path.clone(), text) {
                Ok(()) => {
                    known.insert(path.clone(), text.clone());
                }
                Err(ds) => {
                    external.insert(path.clone(), annotate(path, ds));
                }
            }
        }
        let library = Library::load(&disk.lib, manifest_lib(store.sources()));
        let lib_hashes = lib_hash_map(&disk.lib);
        let history = if opts.writable {
            Some(History::open(&root).map_err(history_err)?)
        } else if root
            .join(crate::history::HISTORY_GIT)
            .join("HEAD")
            .is_file()
        {
            History::open(&root).ok()
        } else {
            None
        };
        let checker = opts.checker;
        let jobs = opts.jobs;
        let snapshot_title = opts.snapshot_title;
        let snapshot_origin = opts.snapshot_origin;
        let runs = RunStore::new(&root);
        let placeholder = rw_model::eval(&SourceSet::default(), &EvalOptions::default());
        let report = checker.check(&placeholder, &[], &BTreeMap::new(), &|_| None);
        let mut s = Session {
            root,
            checker,
            _lock: lock,
            writable: opts.writable,
            store,
            known,
            external,
            library,
            lib_hashes,
            model: placeholder,
            report,
            own_writes: BTreeMap::new(),
            history,
            listeners: Vec::new(),
            runs,
            jobs,
            liquid: crate::liquid::DesignCache::default(),
        };
        s.model = s.evaluate(&s.store, &EvalOptions::default());
        s.report = s.check(&s.model, &s.known);
        // Edits made while no owner was running become one step (D3 dedupes
        // a tree that is already the head).
        if s.writable && s.external.is_empty() {
            let first = s
                .history
                .as_ref()
                .is_some_and(|h| h.head().ok().flatten().is_none());
            let title = match snapshot_title {
                Some(t) => t,
                None if first => "Initial snapshot".to_string(),
                None => "External edit".to_string(),
            };
            let ctx = CallCtx {
                origin: snapshot_origin,
                thread: None,
                tool_call: None,
                label: None,
            };
            s.record_step(&ctx, None, title)?;
        }
        Ok(s)
    }

    /// Opens and wraps for sharing with a watcher.
    pub fn open_shared(root: &Path, opts: SessionOptions) -> Result<SharedSession, ApiError> {
        Ok(Arc::new(Mutex::new(Session::open(root, opts)?)))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The last good evaluated model.
    pub fn model(&self) -> &EvaluatedModel {
        &self.model
    }

    /// The current check report (includes pending parse errors).
    pub fn report(&self) -> &CheckReport {
        &self.report
    }

    pub fn library(&self) -> &Library {
        &self.library
    }

    pub fn is_writable(&self) -> bool {
        self.writable
    }

    /// Forgets the own-write set (tests: prove the tree-hash dedupe alone).
    #[cfg(test)]
    pub(crate) fn clear_own_writes(&mut self) {
        self.own_writes.clear();
    }

    /// Registers a change listener (called with the session lock held: keep
    /// it short and do not call back into the session).
    pub fn on_event(&mut self, f: impl Fn(&SessionEvent) + Send + Sync + 'static) {
        self.listeners.push(Arc::new(f));
    }

    fn emit(&self, ev: SessionEvent) {
        for l in &self.listeners {
            l(&ev);
        }
    }

    /// `rw://project/files`: last good source texts.
    pub fn files(&self) -> ProjectFiles {
        ProjectFiles {
            model_hash: self.model.model_hash.clone(),
            files: self.known.clone(),
        }
    }

    /// History steps (empty when the project has none).
    pub fn steps(&self) -> Result<Vec<rw_api::HistoryStep>, ApiError> {
        match &self.history {
            Some(h) => h.steps().map_err(history_err),
            None => Ok(Vec::new()),
        }
    }

    // ---- evaluation ---------------------------------------------------------------

    fn evaluate(&self, store: &TomlStore, opts: &EvalOptions) -> EvaluatedModel {
        let sources = self.library.eval_sources(store.sources());
        let mut m = rw_model::eval(&sources, opts);
        if !self.library.diagnostics.is_empty() {
            m.diagnostics
                .extend(self.library.diagnostics.iter().cloned());
            m.model_hash = rw_model::model_hash(&m);
        }
        crate::liquid::add_rule_diagnostics(&mut m, &self.liquid);
        m
    }

    /// Motor refs → curves for `model`: generated liquid-engine curves
    /// (`engine:<id>`, placed in their mounts) first, then the library.
    pub(crate) fn motor_resolver<'a>(
        &'a self,
        model: &EvaluatedModel,
    ) -> impl Fn(&str) -> Option<rw_motor::ThrustCurve> + 'a {
        let curves = crate::liquid::engine_curves(model, &self.liquid);
        move |r: &str| curves.get(r).cloned().or_else(|| self.library.motor(r))
    }

    /// The design cache (engine_design, engine_simulate).
    pub(crate) fn liquid(&self) -> &crate::liquid::DesignCache {
        &self.liquid
    }

    fn inputs(&self, known: &BTreeMap<String, String>) -> BTreeMap<String, String> {
        let mut out: BTreeMap<String, String> = known
            .iter()
            .map(|(p, t)| (p.clone(), blake3_hex(t)))
            .collect();
        for f in &self.library.files {
            out.insert(f.path.clone(), f.sha256.clone());
        }
        out
    }

    fn external_diags(&self) -> Vec<Diagnostic> {
        let mut v: Vec<Diagnostic> = self.external.values().flatten().cloned().collect();
        sort_diagnostics(&mut v);
        v
    }

    fn check(&self, model: &EvaluatedModel, known: &BTreeMap<String, String>) -> CheckReport {
        let resolve = self.motor_resolver(model);
        self.checker
            .check(model, &self.external_diags(), &self.inputs(known), &resolve)
    }

    // ---- execute ------------------------------------------------------------------

    /// Runs one command (I2). Commands whose bodies land later answer
    /// `NotImplemented`.
    pub fn execute(&mut self, cmd: &Command, ctx: &CallCtx) -> Result<Response, ApiError> {
        Ok(match cmd {
            Command::ModelGet(i) => Response::ModelGet(self.model_get(i)?),
            Command::ModelPatch(i) => {
                let title = i
                    .label
                    .clone()
                    .or_else(|| ctx.label.clone())
                    .unwrap_or_else(|| ops_title(&i.ops));
                Response::ModelPatch(self.patch(&i.ops, i.dry_run, ctx, "model_patch", title)?)
            }
            Command::ComponentAdd(i) => Response::ComponentAdd(self.component_add(i, ctx)?),
            Command::ComponentRemove(i) => {
                Response::ComponentRemove(self.component_remove(i, ctx)?)
            }
            Command::ComponentMove(i) => Response::ComponentMove(self.component_move(i, ctx)?),
            Command::DesignCheck(i) => Response::DesignCheck(self.design_check(i)?),
            Command::ProjectValidate(i) => Response::ProjectValidate(self.validate(i)?),
            Command::ModelDiff(i) => Response::ModelDiff(self.model_diff(&i.a, &i.b)?),
            Command::HistoryList(i) => Response::HistoryList(self.history_list(i)?),
            Command::HistoryShow(i) => Response::HistoryShow(self.history_show(&i.version)?),
            Command::HistoryCompare(i) => {
                Response::HistoryCompare(self.history_compare(&i.a, &i.b, i.breakdown)?)
            }
            Command::HistoryTag(i) => Response::HistoryTag(self.history_tag(
                &i.name,
                i.version.as_deref(),
                i.number,
                ctx,
            )?),
            Command::HistoryRestore(i) => {
                Response::HistoryRestore(self.history_restore(&i.version, i.dry_run, ctx)?)
            }
            Command::LibrarySearch(i) => Response::LibrarySearch(LibrarySearchOut {
                items: self
                    .library
                    .search_with_presets(i.query.as_deref(), i.kind, i.limit),
            }),
            Command::LibraryShow(i) => {
                let item = if i.id.starts_with("preset:") {
                    crate::presets::show(&i.id)
                } else {
                    self.library.show(&i.id)
                };
                Response::LibraryShow(item.ok_or_else(|| {
                    with_hint(
                        err(
                            ApiErrorCode::NotFound,
                            format!("no library item `{}`", i.id),
                        ),
                        "list items with library_search",
                    )
                })?)
            }
            Command::Simulate(i) => Response::Simulate(self.simulate(i, ctx)?),
            Command::JobStatus(i) => Response::JobStatus(self.job(&i.job_id)?),
            Command::JobCancel(i) => Response::JobCancel(self.job_cancel(&i.job_id)?),
            Command::RunList(i) => Response::RunList(self.run_list(i.sim.as_deref())?),
            Command::RunDiff(i) => Response::RunDiff(self.run_diff(i)?),
            Command::MotorSearch(i) => Response::MotorSearch(self.motor_search(i)?),
            Command::MotorShow(i) => Response::MotorShow(self.motor_show(&i.id)?),
            Command::SchemaGet(i) => Response::SchemaGet(schema_get(i.name.as_deref())?),
            Command::Fmt(i) => Response::Fmt(self.fmt(i, ctx)?),
            Command::EngineDesign(i) => Response::EngineDesign(self.engine_design(&i.engine)?),
            Command::EngineSimulate(i) => Response::EngineSimulate(self.engine_simulate(i)?),
            Command::ImportFile(i) => Response::ImportFile(self.import_file(i, ctx)?),
            Command::CfdImport(i) => Response::CfdImport(self.cfd_import(i, ctx)?),
            Command::ExportFile(i) => Response::ExportFile(self.export_file(i)?),
            Command::ProjectCreate(_) => {
                return Err(with_hint(
                    err(
                        ApiErrorCode::Conflict,
                        format!("{} already holds a project", self.root.display()),
                    ),
                    "edit it with model_patch, or create the project in an empty directory",
                ));
            }
            other => return Err(ApiError::not_implemented(other.name())),
        })
    }

    /// Executes and returns the output JSON (`tools/<name>.output`).
    pub fn execute_json(&mut self, cmd: &Command, ctx: &CallCtx) -> Result<Value, ApiError> {
        let r = self.execute(cmd, ctx)?;
        let v = serde_json::to_value(&r).map_err(|e| err(ApiErrorCode::Internal, e.to_string()))?;
        Ok(v.get("output").cloned().unwrap_or(Value::Null))
    }

    /// Reads a `rw://project/*` resource.
    pub fn read_resource(&self, uri: &str) -> Result<Value, ApiError> {
        let to = |v: Result<Value, serde_json::Error>| {
            v.map_err(|e| err(ApiErrorCode::Internal, e.to_string()))
        };
        match uri {
            URI_MODEL => to(serde_json::to_value(&self.model)),
            URI_CHECK => to(serde_json::to_value(&self.report)),
            URI_FILES => to(serde_json::to_value(self.files())),
            URI_HISTORY => to(serde_json::to_value(
                self.history_list(&HistoryListIn::default())?,
            )),
            URI_RUNS => to(serde_json::to_value(self.run_list(None)?)),
            _ => {
                if let Some(id) = uri
                    .strip_prefix("rw://runs/")
                    .and_then(|r| r.strip_suffix("/summary"))
                {
                    return to(serde_json::to_value(self.run_summary(id)?));
                }
                if let Some(id) = uri.strip_prefix("rw://jobs/") {
                    return to(serde_json::to_value(self.job(id)?));
                }
                Err(ApiError::not_implemented(uri))
            }
        }
    }

    // ---- reads --------------------------------------------------------------------

    fn store_at(&self, version: &str) -> Result<(TomlStore, BTreeMap<String, String>), ApiError> {
        let v = version.trim();
        if v.starts_with("run:") || v.starts_with("rw:run/") {
            return self.store_at(&self.version_of_run(v)?);
        }
        if v.is_empty() || v.eq_ignore_ascii_case("live") {
            return Ok((self.store.clone(), self.known.clone()));
        }
        let h = self.history.as_ref().ok_or_else(|| {
            err(
                ApiErrorCode::NotFound,
                format!("unknown version `{v}`: the project has no history yet"),
            )
        })?;
        let id = h.resolve(v).map_err(history_err)?;
        let snap = h.snapshot(id).map_err(history_err)?;
        let store =
            TomlStore::load(snap.iter().map(|(p, t)| (p.clone(), t.as_str()))).map_err(|ds| {
                let mut e = err(
                    ApiErrorCode::Internal,
                    format!("version `{v}` does not parse"),
                );
                e.diagnostics = ds;
                e
            })?;
        Ok((store, snap))
    }

    fn model_get(&self, i: &ModelGetIn) -> Result<ModelGetOut, ApiError> {
        let opts = EvalOptions {
            config: i.config.clone(),
            variant: i.variant.clone(),
            set: BTreeMap::new(),
        };
        let live = i
            .version
            .as_deref()
            .is_none_or(|v| v.eq_ignore_ascii_case("live"));
        let model = if live && opts == EvalOptions::default() {
            self.model.clone()
        } else {
            let (store, _) = self.store_at(i.version.as_deref().unwrap_or("live"))?;
            self.evaluate(&store, &opts)
        };
        let path = i.path.clone().unwrap_or_default();
        if path.is_empty() || path == "/" {
            return Ok(ModelGetOut {
                model_hash: model.model_hash.clone(),
                path: String::new(),
                model: Some(model),
                value: None,
            });
        }
        let v =
            serde_json::to_value(&model).map_err(|e| err(ApiErrorCode::Internal, e.to_string()))?;
        let value = v.pointer(&path).cloned().ok_or_else(|| {
            with_hint(
                err(
                    ApiErrorCode::NotFound,
                    format!("no `{path}` in the evaluated model"),
                ),
                "paths are JSON pointers into the evaluated model, e.g. /components/0",
            )
        })?;
        Ok(ModelGetOut {
            model_hash: model.model_hash,
            path,
            model: None,
            value: Some(value),
        })
    }

    fn design_check(&self, i: &DesignCheckIn) -> Result<CheckReport, ApiError> {
        self.design_check_sim(i)
    }

    fn validate(&self, i: &ProjectValidateIn) -> Result<ValidateOut, ApiError> {
        let disk =
            layout::read_project(&self.root).map_err(|e| io_err("reading the project", e))?;
        let wanted: BTreeSet<&str> = i.files.iter().map(String::as_str).collect();
        let mut files = Vec::new();
        let mut diagnostics = Vec::new();
        for (path, text) in &disk.sources {
            if !wanted.is_empty() && !wanted.contains(path.as_str()) {
                continue;
            }
            files.push(path.clone());
            match parse_source_with_warnings(path, text) {
                Ok((_, w)) => diagnostics.extend(annotate(path, w)),
                Err(ds) => diagnostics.extend(annotate(path, ds)),
            }
        }
        for w in &wanted {
            if !disk.sources.contains_key(*w) {
                let mut d = Diagnostic::new(
                    diag::E_DOC_KIND,
                    None,
                    format!("`{w}` is not a source file in this project"),
                );
                d.file = Some((*w).to_string());
                diagnostics.push(d);
            }
        }
        if wanted.is_empty() {
            diagnostics.extend(self.library.diagnostics.iter().cloned());
        }
        sort_diagnostics(&mut diagnostics);
        let ok = diagnostics
            .iter()
            .all(|d| d.severity != rw_model::Severity::Error);
        Ok(ValidateOut {
            ok,
            files,
            diagnostics,
        })
    }

    // ---- mutations ----------------------------------------------------------------

    fn require_writable(&self) -> Result<&History, ApiError> {
        match (&self.history, self.writable) {
            (Some(h), true) => Ok(h),
            _ => Err(with_hint(
                err(ApiErrorCode::Locked, "this session is read-only"),
                "writes go through the project's owner (the sidecar, or an rw command when none runs)",
            )),
        }
    }

    /// Applies RFC 6902 ops through the full pipeline.
    pub fn patch(
        &mut self,
        ops: &[PatchOp],
        dry_run: bool,
        ctx: &CallCtx,
        tool: &str,
        title: String,
    ) -> Result<MutationOut, ApiError> {
        if ops.is_empty() {
            return Err(err(ApiErrorCode::InvalidInput, "no ops"));
        }
        let (next, changes) = self.store.preview(ops).map_err(patch_error)?;
        let writes: Vec<(String, Option<String>)> =
            changes.into_iter().map(|c| (c.path, c.text)).collect();
        self.commit(next, writes, dry_run, ctx, Some(tool), title)
    }

    fn component_add(
        &mut self,
        i: &ComponentAddIn,
        ctx: &CallCtx,
    ) -> Result<MutationOut, ApiError> {
        if self
            .model_value()
            .pointer(&format!("/c/{}", i.id))
            .is_some()
        {
            return Err(with_hint(
                err(
                    ApiErrorCode::Conflict,
                    format!("component `{}` already exists", i.id),
                ),
                "pick a new id, or edit it with model_patch",
            ));
        }
        let value = serde_json::to_value(&i.component)
            .map_err(|e| err(ApiErrorCode::InvalidInput, e.to_string()))?;
        let ops = [PatchOp::Add {
            path: format!("/c/{}", i.id),
            value,
        }];
        let title = ctx.label.clone().unwrap_or_else(|| format!("Add {}", i.id));
        self.patch(&ops, i.dry_run, ctx, "component_add", title)
    }

    fn model_value(&self) -> Value {
        ModelValue::from_sources(self.store.sources()).0
    }

    /// Components attached (directly or not) to `id`, deepest first.
    fn dependents(&self, id: &str) -> Vec<String> {
        let mv = self.model_value();
        let parents: BTreeMap<String, String> = mv
            .get("c")
            .and_then(Value::as_object)
            .map(|c| {
                c.iter()
                    .filter_map(|(k, v)| {
                        let to = v.pointer("/attach/to")?.as_str()?;
                        Some((k.clone(), to.split('.').next()?.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut out = Vec::new();
        let mut frontier = vec![id.to_string()];
        while let Some(p) = frontier.pop() {
            for (k, parent) in &parents {
                if *parent == p && k != id && !out.contains(k) {
                    out.push(k.clone());
                    frontier.push(k.clone());
                }
            }
        }
        out.reverse();
        out
    }

    fn component_remove(
        &mut self,
        i: &ComponentRemoveIn,
        ctx: &CallCtx,
    ) -> Result<MutationOut, ApiError> {
        if self
            .model_value()
            .pointer(&format!("/c/{}", i.id))
            .is_none()
        {
            return Err(err(
                ApiErrorCode::NotFound,
                format!("no component `{}`", i.id),
            ));
        }
        let deps = self.dependents(&i.id);
        if !deps.is_empty() && !i.recursive {
            return Err(with_hint(
                err(
                    ApiErrorCode::Conflict,
                    format!("`{}` has attached components: {}", i.id, deps.join(", ")),
                ),
                "pass recursive: true to remove them too, or re-attach them first",
            ));
        }
        let ops: Vec<PatchOp> = deps
            .iter()
            .chain(std::iter::once(&i.id))
            .map(|id| PatchOp::Remove {
                path: format!("/c/{id}"),
            })
            .collect();
        let title = ctx
            .label
            .clone()
            .unwrap_or_else(|| format!("Remove {}", i.id));
        self.patch(&ops, i.dry_run, ctx, "component_remove", title)
    }

    fn component_move(
        &mut self,
        i: &ComponentMoveIn,
        ctx: &CallCtx,
    ) -> Result<MutationOut, ApiError> {
        if self
            .model_value()
            .pointer(&format!("/c/{}", i.id))
            .is_none()
        {
            return Err(err(
                ApiErrorCode::NotFound,
                format!("no component `{}`", i.id),
            ));
        }
        let value = serde_json::to_value(&i.attach)
            .map_err(|e| err(ApiErrorCode::InvalidInput, e.to_string()))?;
        let ops = [PatchOp::Add {
            path: format!("/c/{}/attach", i.id),
            value,
        }];
        let title = ctx
            .label
            .clone()
            .unwrap_or_else(|| format!("Move {}", i.id));
        self.patch(&ops, i.dry_run, ctx, "component_move", title)
    }

    fn history_restore(
        &mut self,
        version: &str,
        dry_run: bool,
        ctx: &CallCtx,
    ) -> Result<MutationOut, ApiError> {
        let (next, snap) = self.store_at(version)?;
        if let Some(bad) = snap.keys().find(|p| !layout::is_safe_rel(p)) {
            return Err(err(
                ApiErrorCode::InvalidInput,
                format!(
                    "version `{version}` holds `{bad}`, a path outside the project; nothing restored"
                ),
            ));
        }
        // Compare with the disk, not the last good text: a corrupted file the
        // session still knows as good is repaired by the restore.
        let mut writes = Vec::new();
        for (p, t) in &snap {
            let on_disk = std::fs::read_to_string(self.root.join(p)).ok();
            if on_disk.as_ref() != Some(t) {
                writes.push((p.clone(), Some(t.clone())));
            }
        }
        for p in self.known.keys() {
            if !snap.contains_key(p) {
                writes.push((p.clone(), None));
            }
        }
        let title = ctx
            .label
            .clone()
            .unwrap_or_else(|| format!("Restore {version}"));
        self.commit(next, writes, dry_run, ctx, Some("history_restore"), title)
    }

    /// Steps 2-9 of the pipeline for a computed next state.
    fn commit(
        &mut self,
        next: TomlStore,
        writes: Vec<(String, Option<String>)>,
        dry_run: bool,
        ctx: &CallCtx,
        tool: Option<&str>,
        title: String,
    ) -> Result<MutationOut, ApiError> {
        let files: Vec<FileChange> = writes
            .iter()
            .map(|(p, t)| FileChange {
                path: p.clone(),
                status: match (t, self.known.contains_key(p)) {
                    (None, _) => FileStatus::D,
                    (Some(_), true) => FileStatus::M,
                    (Some(_), false) => FileStatus::A,
                },
            })
            .collect();
        let mut next_known = self.known.clone();
        for (p, t) in &writes {
            match t {
                Some(t) => next_known.insert(p.clone(), t.clone()),
                None => next_known.remove(p),
            };
        }
        let model = self.evaluate(&next, &EvalOptions::default());
        if dry_run || writes.is_empty() {
            let report = self.check(&model, &next_known);
            return Ok(MutationOut {
                step: None,
                model_hash: model.model_hash.clone(),
                dry_run,
                files: if dry_run { files } else { Vec::new() },
                delta: self.checker.delta(&self.report, &report, None),
            });
        }
        self.require_writable()?;
        if let Some((bad, _)) = writes.iter().find(|(p, _)| !layout::is_safe_rel(p)) {
            return Err(err(
                ApiErrorCode::InvalidInput,
                format!("`{bad}` is outside the project; nothing written"),
            ));
        }
        for (p, t) in &writes {
            let abs = self.root.join(p);
            match t {
                Some(t) => {
                    fsutil::write_atomic(&abs, t.as_bytes()).map_err(|e| io_err(p, e))?;
                    self.own_writes.insert(p.clone(), Some(blake3_hex(t)));
                }
                None => {
                    fsutil::remove_if_exists(&abs).map_err(|e| io_err(p, e))?;
                    self.own_writes.insert(p.clone(), None);
                }
            }
            // A file we wrote is good again.
            self.external.remove(p);
        }
        self.store = next;
        self.known = next_known;
        self.model = model;
        let report = self.check(&self.model, &self.known);
        let before = std::mem::replace(&mut self.report, report);
        let step = self.record_step(ctx, tool, title)?;
        let step_ref = step.as_ref().map(|s| format!("step:{}", s.seq));
        let delta = self.checker.delta(&before, &self.report, step_ref.clone());
        self.emit(SessionEvent {
            uris: if step.is_some() {
                MUTATION_URIS.to_vec()
            } else {
                vec![URI_MODEL, URI_CHECK, URI_FILES]
            },
            origin: ctx.origin,
            step,
        });
        Ok(MutationOut {
            step: step_ref,
            model_hash: self.model.model_hash.clone(),
            dry_run: false,
            files,
            delta,
        })
    }

    fn record_step(
        &mut self,
        ctx: &CallCtx,
        tool: Option<&str>,
        title: String,
    ) -> Result<Option<rw_api::HistoryStep>, ApiError> {
        let (Some(h), true) = (&self.history, self.writable) else {
            return Ok(None);
        };
        let meta = StepMeta {
            origin: ctx.origin,
            thread: ctx.thread.clone(),
            tool: tool.map(String::from),
            tool_call: ctx.tool_call.clone(),
            title,
            model_hash: self.model.model_hash.clone(),
            metrics: self.checker.metrics(&self.report),
            time: clock::now(),
        };
        let snapshot: Snapshot = self.known.clone();
        h.record(&snapshot, &meta).map_err(history_err)
    }

    // ---- external edits -----------------------------------------------------------

    /// Re-reads the project and applies external edits (the watcher's body).
    /// Unchanged content (own writes, replayed events, touches) is a no-op;
    /// a file that does not parse keeps the last good model (`RW-E001`).
    pub fn sync_from_disk(&mut self, origin: Origin) -> Result<SyncOutcome, ApiError> {
        let disk =
            layout::read_project(&self.root).map_err(|e| io_err("reading the project", e))?;
        let lib_hashes = lib_hash_map(&disk.lib);
        let lib_changed = lib_hashes != self.lib_hashes;

        // Own-write records are consumed by the first read of the disk after
        // the write: this read is the echo (or a later edit). Keeping them
        // would hide an editor undo back to tool-written content forever.
        let own_writes = std::mem::take(&mut self.own_writes);
        let mut changed: Vec<(String, Option<String>)> = Vec::new();
        for (p, t) in &disk.sources {
            if self.known.get(p) == Some(t) {
                continue;
            }
            if own_writes.get(p) == Some(&Some(blake3_hex(t))) {
                continue;
            }
            changed.push((p.clone(), Some(t.clone())));
        }
        for p in self.known.keys() {
            if !disk.sources.contains_key(p) && own_writes.get(p) != Some(&None) {
                changed.push((p.clone(), None));
            }
        }
        // A broken file restored to its last good text (or deleted) clears.
        let mut cleared = false;
        let broken: Vec<String> = self.external.keys().cloned().collect();
        for p in broken {
            let on_disk = disk.sources.get(&p);
            if on_disk == self.known.get(&p) || on_disk.is_none() {
                self.external.remove(&p);
                cleared = true;
            }
        }
        if changed.is_empty() && !lib_changed {
            if cleared {
                self.report = self.check(&self.model, &self.known);
                self.emit(SessionEvent {
                    uris: vec![URI_CHECK],
                    origin,
                    step: None,
                });
            }
            return Ok(SyncOutcome::Unchanged);
        }

        let mut next = self.store.clone();
        let mut next_known = self.known.clone();
        let mut failed: BTreeMap<String, Vec<Diagnostic>> = BTreeMap::new();
        for (p, t) in &changed {
            match t {
                Some(t) => match next.insert(p.clone(), t) {
                    Ok(()) => {
                        next_known.insert(p.clone(), t.clone());
                    }
                    Err(ds) => {
                        failed.insert(p.clone(), annotate(p, ds));
                    }
                },
                None => {
                    next.remove(p);
                    next_known.remove(p);
                }
            }
        }
        if !failed.is_empty() {
            let diags: Vec<Diagnostic> = failed.values().flatten().cloned().collect();
            let before = self.external.clone();
            self.external.extend(failed);
            if before != self.external || cleared {
                self.report = self.check(&self.model, &self.known);
                self.emit(SessionEvent {
                    uris: vec![URI_CHECK],
                    origin,
                    step: None,
                });
            }
            return Ok(SyncOutcome::ParseError(diags));
        }
        for (p, _) in &changed {
            self.external.remove(p);
        }
        if lib_changed {
            self.library = Library::load(&disk.lib, manifest_lib(next.sources()));
            self.lib_hashes = lib_hashes;
        } else if changed
            .iter()
            .any(|(p, _)| p == layout::MANIFEST || p == layout::MANIFEST_JSON)
        {
            // The recorded hashes may have changed.
            self.library = Library::load(&disk.lib, manifest_lib(next.sources()));
        }
        self.store = next;
        self.known = next_known;
        self.model = self.evaluate(&self.store, &EvalOptions::default());
        self.report = self.check(&self.model, &self.known);
        let names: Vec<&str> = changed.iter().map(|(p, _)| p.as_str()).collect();
        let title = if names.is_empty() {
            "Library change".to_string()
        } else {
            format!("Edited {}", names.join(", "))
        };
        let ctx = CallCtx {
            origin,
            thread: None,
            tool_call: None,
            label: None,
        };
        let step = self.record_step(&ctx, None, title)?;
        self.emit(SessionEvent {
            uris: if step.is_some() {
                MUTATION_URIS.to_vec()
            } else {
                vec![URI_MODEL, URI_CHECK, URI_FILES]
            },
            origin,
            step: step.clone(),
        });
        Ok(SyncOutcome::Applied(step.map(Box::new)))
    }

    /// Records the sha256 of every library file in `rocketwright.toml
    /// [lib.sha256]` (a normal mutation).
    pub fn lib_record(&mut self, ctx: &CallCtx, dry_run: bool) -> Result<MutationOut, ApiError> {
        let disk =
            layout::read_project(&self.root).map_err(|e| io_err("reading the project", e))?;
        let hashes = lib_hash_map(&disk.lib);
        let mut lib = manifest_lib(self.store.sources())
            .cloned()
            .unwrap_or_default();
        lib.sha256 = hashes;
        let value =
            serde_json::to_value(&lib).map_err(|e| err(ApiErrorCode::Internal, e.to_string()))?;
        let ops = [PatchOp::Add {
            path: "/project/lib".into(),
            value,
        }];
        let out = self.patch(
            &ops,
            dry_run,
            ctx,
            "lib_record",
            "Record library hashes".into(),
        )?;
        if !dry_run {
            self.library = Library::load(&disk.lib, manifest_lib(self.store.sources()));
            self.lib_hashes = lib_hash_map(&disk.lib);
            self.model = self.evaluate(&self.store, &EvalOptions::default());
            self.report = self.check(&self.model, &self.known);
        }
        Ok(out)
    }

    // ---- history ------------------------------------------------------------------

    fn history_list(&self, i: &HistoryListIn) -> Result<HistoryListOut, ApiError> {
        let Some(h) = &self.history else {
            return Ok(HistoryListOut {
                steps: Vec::new(),
                revisions: Vec::new(),
            });
        };
        let mut steps = h.steps().map_err(history_err)?;
        if let Some(t) = &i.thread {
            steps.retain(|s| {
                s.thread.as_deref() == Some(t.as_str())
                    || (s.thread.is_none()
                        && serde_json::to_value(s.origin)
                            .ok()
                            .and_then(|v| v.as_str().map(String::from))
                            .as_deref()
                            == Some(t.as_str()))
            });
        }
        if let Some(b) = i.before {
            steps.retain(|s| s.seq < b);
        }
        if let Some(n) = i.limit {
            let n = n as usize;
            if steps.len() > n {
                steps.drain(..steps.len() - n);
            }
        }
        Ok(HistoryListOut {
            steps,
            revisions: h.revisions().map_err(history_err)?,
        })
    }

    fn history_show(&self, version: &str) -> Result<HistoryShowOut, ApiError> {
        let h = self
            .history
            .as_ref()
            .ok_or_else(|| err(ApiErrorCode::NotFound, "the project has no history yet"))?;
        let id = h.resolve(version).map_err(history_err)?;
        let step = h.step(id).map_err(history_err)?;
        let b = h.snapshot(id).map_err(history_err)?;
        let (a, a_name) = match &step.prev {
            Some(p) => {
                let pid = gix::ObjectId::from_hex(p.as_bytes())
                    .map_err(|e| err(ApiErrorCode::Internal, e.to_string()))?;
                (
                    h.snapshot(pid).map_err(history_err)?,
                    format!("step:{}", step.seq.saturating_sub(1)),
                )
            }
            None => (Snapshot::new(), "empty".to_string()),
        };
        let diff = model_diff(
            &a_name,
            &value_of(&a),
            &format!("step:{}", step.seq),
            &value_of(&b),
        );
        Ok(HistoryShowOut { step, diff })
    }

    fn model_diff(&self, a: &str, b: &str) -> Result<ModelDiff, ApiError> {
        let (sa, _) = self.store_at(a)?;
        let (sb, _) = self.store_at(b)?;
        Ok(model_diff(
            a,
            &ModelValue::from_sources(sa.sources()).0,
            b,
            &ModelValue::from_sources(sb.sources()).0,
        ))
    }

    fn history_compare(&self, a: &str, b: &str, breakdown: bool) -> Result<CompareOut, ApiError> {
        let (sa, ka) = self.store_at(a)?;
        let (sb, kb) = self.store_at(b)?;
        let model = model_diff(
            a,
            &ModelValue::from_sources(sa.sources()).0,
            b,
            &ModelValue::from_sources(sb.sources()).0,
        );
        let (ea, eb) = (
            self.evaluate(&sa, &EvalOptions::default()),
            self.evaluate(&sb, &EvalOptions::default()),
        );
        let mut metrics = Vec::new();
        // Two runs: their flights first, then the static metrics of their models.
        if let (Some(ra), Some(rb)) = (self.run_of(a), self.run_of(b))
            && let (Ok(x), Ok(y)) = (
                self.runs().summary(&ra.sim, &ra.run_id),
                self.runs().summary(&rb.sim, &rb.run_id),
            )
        {
            metrics.extend(summary_rows(&x, &y));
        }
        let (ca, cb) = (self.check(&ea, &ka), self.check(&eb, &kb));
        metrics.extend(report_rows(&ca, &cb));
        Ok(CompareOut {
            a: a.to_string(),
            b: b.to_string(),
            model,
            metrics,
            marks: component_marks(&ea, &eb),
            breakdown: if breakdown {
                breakdown_rows(&ca, &cb)
            } else {
                Vec::new()
            },
            visual: None,
        })
    }

    /// The run a `run:<ref>` / `rw:run/<ref>` version names.
    fn run_of(&self, version: &str) -> Option<rw_api::RunManifest> {
        let v = version.trim();
        let r = v
            .strip_prefix("run:")
            .or_else(|| v.strip_prefix("rw:run/"))?;
        self.runs().find(r)
    }

    /// The history version a run's model was recorded at: the latest step
    /// with the run's model hash (up to the step current when it ran), else
    /// `live` when the current model is the run's.
    fn version_of_run(&self, version: &str) -> Result<String, ApiError> {
        let m = self.run_of(version).ok_or_else(|| {
            with_hint(
                err(ApiErrorCode::NotFound, format!("unknown run `{version}`")),
                "list runs with `rw sim --list` or `run_list`",
            )
        })?;
        let steps = match &self.history {
            Some(h) => h.steps().map_err(history_err)?,
            None => Vec::new(),
        };
        let upto = m.step.unwrap_or(u32::MAX);
        if let Some(s) = steps
            .iter()
            .rev()
            .find(|s| s.seq <= upto && s.model_hash == m.model_hash)
            .or_else(|| steps.iter().rev().find(|s| s.model_hash == m.model_hash))
        {
            return Ok(format!("step:{}", s.seq));
        }
        if m.model_hash == self.model.model_hash {
            return Ok("live".into());
        }
        Err(with_hint(
            err(
                ApiErrorCode::NotFound,
                format!("run `{}`'s model is not in the history", m.run_id),
            ),
            "compare the run's step instead (`rw history log`)",
        ))
    }

    /// The model at `version` evaluated in `config` (default: the project
    /// default) and its static check report (`rw render --compare`).
    pub fn evaluated_at(
        &self,
        version: &str,
        config: Option<&str>,
    ) -> Result<(EvaluatedModel, CheckReport), ApiError> {
        let (store, known) = self.store_at(version)?;
        let opts = EvalOptions {
            config: config.map(String::from),
            ..EvalOptions::default()
        };
        let m = self.evaluate(&store, &opts);
        let r = self.check(&m, &known);
        Ok((m, r))
    }

    fn history_tag(
        &mut self,
        name: &str,
        version: Option<&str>,
        number: Option<u32>,
        ctx: &CallCtx,
    ) -> Result<rw_api::Revision, ApiError> {
        let h = self.require_writable()?;
        let r = h
            .tag(name, version, number, &clock::now())
            .map_err(history_err)?;
        self.emit(SessionEvent {
            uris: vec![URI_HISTORY],
            origin: ctx.origin,
            step: None,
        });
        Ok(r)
    }
}

fn annotate(path: &str, ds: Vec<Diagnostic>) -> Vec<Diagnostic> {
    ds.into_iter()
        .map(|mut d| {
            d.file.get_or_insert_with(|| path.to_string());
            d
        })
        .collect()
}

fn lib_hash_map(lib: &BTreeMap<String, Vec<u8>>) -> BTreeMap<String, String> {
    lib.iter()
        .map(|(p, b)| (p.clone(), sha256_hex(b)))
        .collect()
}

fn ops_title(ops: &[PatchOp]) -> String {
    let path = |op: &PatchOp| match op {
        PatchOp::Add { path, .. }
        | PatchOp::Remove { path }
        | PatchOp::Replace { path, .. }
        | PatchOp::Move { path, .. }
        | PatchOp::Copy { path, .. }
        | PatchOp::Test { path, .. } => path.clone(),
    };
    let edits: Vec<&PatchOp> = ops
        .iter()
        .filter(|o| !matches!(o, PatchOp::Test { .. }))
        .collect();
    match edits.as_slice() {
        [] => "Check".into(),
        [one] => {
            let verb = match one {
                PatchOp::Add { .. } => "Set",
                PatchOp::Remove { .. } => "Remove",
                PatchOp::Replace { .. } => "Set",
                PatchOp::Move { .. } => "Move",
                PatchOp::Copy { .. } => "Copy",
                PatchOp::Test { .. } => "Check",
            };
            format!("{verb} {}", path(one))
        }
        many => format!("{} edits", many.len()),
    }
}

/// The id-keyed model value of a snapshot (unparseable files skipped).
fn value_of(snap: &Snapshot) -> Value {
    let mut store = TomlStore::new();
    for (p, t) in snap {
        let _ = store.insert(p.clone(), t);
    }
    ModelValue::from_sources(store.sources()).0
}

mod cfd_cmd;
mod engine_cmd;
mod import;
mod interop_cmd;
mod phases;
mod runs_cmd;
mod visual_cmd;
pub use runs_cmd::{OR_STATIC_KEYS, schema_get};

#[cfg(test)]
mod tests;
