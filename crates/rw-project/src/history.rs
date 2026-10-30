//! Design history (M1.27, R2.10, D2/D3): a private bare repository at
//! `.rw/history.git` (gix) with one linear ref, `refs/rw/history`.
//!
//! - **Never the user's repo** (invariant I15): the store is opened isolated
//!   (no user, system, or environment config), and nothing here reads or
//!   writes the project's own `.git`.
//! - **A step per snapshot-tree change** (D3): [`History::record`] returns
//!   `None` when the tree equals the head's tree, so a no-op mutation, a
//!   forwarded CLI write and the watcher event it triggers, and a replayed
//!   FSEvents notification all collapse into at most one step.
//! - **CAS**: every step is a `commit_as` on `refs/rw/history` whose first
//!   parent must be the current head (`ExistingMustMatch`); a lost race
//!   re-reads the head and retries, so concurrent writers never lose or
//!   duplicate a step.
//! - **`steps.jsonl`** (`.rw/history/steps.jsonl`) is a cache: one
//!   [`HistoryStep`] per line. Each commit message carries the same record
//!   as an `Rw-Step:` trailer, and the cache is rebuilt from the commits when
//!   it does not end at the head.
//! - **Revisions** (`Rev NN`): `refs/rw/rev/<NN>` points at a commit whose
//!   parent is the tagged step and whose message carries an `Rw-Rev:`
//!   trailer with the number and name. Revisions are not on the linear ref.
//!
//! Versions: `live` (resolved by the session), `HEAD`, `step:<seq>`,
//! `rev:<NN>`, `commit:<sha>`.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use gix::ObjectId;
use gix::objs::{Tree, tree};
use gix::refs::transaction::PreviousValue;
use rw_api::{FileChange, FileStatus, HistoryStep, Origin, Revision, StepMetrics};
use serde::{Deserialize, Serialize};

/// The linear step ref.
pub const HISTORY_REF: &str = "refs/rw/history";
/// Prefix of revision refs (`refs/rw/rev/07`).
pub const REV_PREFIX: &str = "refs/rw/rev/";
/// History store, relative to the project.
pub const HISTORY_GIT: &str = ".rw/history.git";
/// Step log cache, relative to the project.
pub const STEPS_JSONL: &str = ".rw/history/steps.jsonl";

const STEP_TRAILER: &str = "Rw-Step: ";
const REV_TRAILER: &str = "Rw-Rev: ";
const CAS_ATTEMPTS: u32 = 50;

/// A snapshot: project-relative path → file text.
pub type Snapshot = BTreeMap<String, String>;

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("history store: {0}")]
    Git(String),
    #[error("history I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("unknown version `{0}`")]
    UnknownVersion(String),
    #[error("{0}")]
    Invalid(String),
}

fn git<E: std::fmt::Display>(e: E) -> HistoryError {
    HistoryError::Git(e.to_string())
}

/// Who and why: everything a step records except what the store computes.
#[derive(Debug, Clone, PartialEq)]
pub struct StepMeta {
    pub origin: Origin,
    pub thread: Option<String>,
    pub tool: Option<String>,
    pub tool_call: Option<String>,
    pub title: String,
    pub model_hash: String,
    pub metrics: StepMetrics,
    /// Unix seconds and the RFC 3339 form ([`crate::clock`]).
    pub time: (i64, String),
}

/// The `Rw-Rev:` trailer.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RevRecord {
    number: u32,
    name: String,
    step: u32,
}

/// The project's history store.
pub struct History {
    /// `gix::Repository` is not `Send`; each call takes a thread-local handle.
    ts: gix::ThreadSafeRepository,
    steps_path: PathBuf,
}

impl std::fmt::Debug for History {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("History")
            .field("steps_path", &self.steps_path)
            .finish_non_exhaustive()
    }
}

fn signature_time(secs: i64) -> gix::actor::Signature {
    gix::actor::Signature {
        name: "rocketwright".into(),
        email: "rocketwright@localhost".into(),
        time: gix::date::Time::new(secs, 0),
    }
}

impl History {
    fn repo(&self) -> gix::Repository {
        self.ts.to_thread_local()
    }

    /// Opens `.rw/history.git` under `project`, creating it when absent.
    pub fn open(project: &Path) -> Result<History, HistoryError> {
        let dir = project.join(HISTORY_GIT);
        let repo = if dir.join("HEAD").is_file() {
            gix::open_opts(&dir, gix::open::Options::isolated()).map_err(git)?
        } else {
            std::fs::create_dir_all(&dir)?;
            match gix::init_bare(&dir) {
                Ok(_) => {}
                // Another process initialised it first.
                Err(_) if dir.join("HEAD").is_file() => {}
                Err(e) => return Err(git(e)),
            }
            gix::open_opts(&dir, gix::open::Options::isolated()).map_err(git)?
        };
        let steps_path = project.join(STEPS_JSONL);
        if let Some(p) = steps_path.parent() {
            std::fs::create_dir_all(p)?;
        }
        Ok(History {
            ts: repo.into_sync(),
            steps_path,
        })
    }

    /// The head commit of `refs/rw/history`, if any step exists.
    pub fn head(&self) -> Result<Option<ObjectId>, HistoryError> {
        let repo = self.repo();
        let r = repo.try_find_reference(HISTORY_REF).map_err(git)?;
        Ok(r.and_then(|r| r.target().try_id().map(|id| id.to_owned())))
    }

    fn commit_tree(&self, id: ObjectId) -> Result<ObjectId, HistoryError> {
        let repo = self.repo();
        let c = repo.find_commit(id).map_err(git)?;
        Ok(c.tree_id().map_err(git)?.detach())
    }

    fn commit_message(&self, id: ObjectId) -> Result<String, HistoryError> {
        let repo = self.repo();
        let c = repo.find_commit(id).map_err(git)?;
        Ok(c.message_raw().map_err(git)?.to_string())
    }

    fn commit_first_parent(&self, id: ObjectId) -> Result<Option<ObjectId>, HistoryError> {
        let repo = self.repo();
        let c = repo.find_commit(id).map_err(git)?;
        Ok(c.parent_ids().next().map(|p| p.detach()))
    }

    /// The step recorded by commit `id` (from its `Rw-Step:` trailer).
    fn step_of(&self, id: ObjectId) -> Result<HistoryStep, HistoryError> {
        let msg = self.commit_message(id)?;
        let line = msg
            .lines()
            .rev()
            .find_map(|l| l.strip_prefix(STEP_TRAILER))
            .ok_or_else(|| HistoryError::Invalid(format!("commit {id} has no Rw-Step trailer")))?;
        let mut step: HistoryStep = serde_json::from_str(line)
            .map_err(|e| HistoryError::Invalid(format!("commit {id}: bad Rw-Step: {e}")))?;
        step.id = id.to_string();
        step.rev = None;
        Ok(step)
    }

    // ---- trees ------------------------------------------------------------------

    fn write_tree(&self, files: &Snapshot) -> Result<ObjectId, HistoryError> {
        let repo = self.repo();
        // Group by first path segment; files at this level, subtrees below.
        let mut blobs: BTreeMap<String, ObjectId> = BTreeMap::new();
        let mut dirs: BTreeMap<String, Snapshot> = BTreeMap::new();
        for (path, text) in files {
            match path.split_once('/') {
                Some((dir, rest)) => {
                    dirs.entry(dir.to_string())
                        .or_default()
                        .insert(rest.to_string(), text.clone());
                }
                None => {
                    let id = repo.write_blob(text.as_bytes()).map_err(git)?.detach();
                    blobs.insert(path.clone(), id);
                }
            }
        }
        let mut entries = Vec::new();
        for (name, oid) in blobs {
            entries.push(tree::Entry {
                mode: tree::EntryKind::Blob.into(),
                filename: name.into(),
                oid,
            });
        }
        for (name, sub) in dirs {
            let oid = self.write_tree(&sub)?;
            entries.push(tree::Entry {
                mode: tree::EntryKind::Tree.into(),
                filename: name.into(),
                oid,
            });
        }
        // Git order: byte order with directories compared as `name/`.
        entries.sort_by(|a, b| {
            let key = |e: &tree::Entry| {
                let mut k: Vec<u8> = e.filename.to_vec();
                if e.mode.is_tree() {
                    k.push(b'/');
                }
                k
            };
            key(a).cmp(&key(b))
        });
        let id = repo.write_object(&Tree { entries }).map_err(git)?;
        Ok(id.detach())
    }

    /// Path → blob id of every file in a tree.
    fn tree_blobs(&self, tree: ObjectId) -> Result<BTreeMap<String, ObjectId>, HistoryError> {
        let mut out = BTreeMap::new();
        self.walk_tree(tree, "", &mut out)?;
        Ok(out)
    }

    fn walk_tree(
        &self,
        tree: ObjectId,
        prefix: &str,
        out: &mut BTreeMap<String, ObjectId>,
    ) -> Result<(), HistoryError> {
        let t = self.repo();
        let t = t.find_tree(tree).map_err(git)?;
        let decoded = t.decode().map_err(git)?;
        let entries: Vec<(String, bool, ObjectId)> = decoded
            .entries
            .iter()
            .map(|e| (e.filename.to_string(), e.mode.is_tree(), e.oid.to_owned()))
            .collect();
        for (name, is_tree, oid) in entries {
            if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
                return Err(HistoryError::Invalid(format!(
                    "history tree entry `{prefix}{name}` is not a project path"
                )));
            }
            let path = format!("{prefix}{name}");
            if is_tree {
                self.walk_tree(oid, &format!("{path}/"), out)?;
            } else {
                out.insert(path, oid);
            }
        }
        Ok(())
    }

    fn read_tree(&self, tree: ObjectId) -> Result<Snapshot, HistoryError> {
        let repo = self.repo();
        let mut out = Snapshot::new();
        for (path, oid) in self.tree_blobs(tree)? {
            let blob = repo.find_blob(oid).map_err(git)?;
            out.insert(path, String::from_utf8_lossy(&blob.data).into_owned());
        }
        Ok(out)
    }

    /// The files of a commit.
    pub fn snapshot(&self, commit: ObjectId) -> Result<Snapshot, HistoryError> {
        let tree = self.commit_tree(commit)?;
        self.read_tree(tree)
    }

    /// The files at the head step (empty when there is none).
    pub fn head_snapshot(&self) -> Result<Snapshot, HistoryError> {
        match self.head()? {
            Some(h) => self.snapshot(h),
            None => Ok(Snapshot::new()),
        }
    }

    // ---- recording --------------------------------------------------------------

    /// Records `files` as a new step unless the tree equals the head's (D3).
    pub fn record(
        &self,
        files: &Snapshot,
        meta: &StepMeta,
    ) -> Result<Option<HistoryStep>, HistoryError> {
        let tree = self.write_tree(files)?;
        let mut attempt = 0;
        loop {
            attempt += 1;
            let head = self.head()?;
            let (seq, prev_blobs) = match head {
                Some(h) => {
                    if self.commit_tree(h)? == tree {
                        return Ok(None);
                    }
                    let prev = self.step_of(h)?;
                    (prev.seq + 1, self.tree_blobs(self.commit_tree(h)?)?)
                }
                None => (1, BTreeMap::new()),
            };
            let new_blobs = self.tree_blobs(tree)?;
            let mut changes = Vec::new();
            for (p, oid) in &new_blobs {
                match prev_blobs.get(p) {
                    None => changes.push(FileChange {
                        path: p.clone(),
                        status: FileStatus::A,
                    }),
                    Some(o) if o != oid => changes.push(FileChange {
                        path: p.clone(),
                        status: FileStatus::M,
                    }),
                    _ => {}
                }
            }
            for p in prev_blobs.keys() {
                if !new_blobs.contains_key(p) {
                    changes.push(FileChange {
                        path: p.clone(),
                        status: FileStatus::D,
                    });
                }
            }
            let mut step = HistoryStep {
                seq,
                id: String::new(),
                prev: head.map(|h| h.to_string()),
                ts: meta.time.1.clone(),
                origin: meta.origin,
                thread: meta.thread.clone(),
                tool: meta.tool.clone(),
                tool_call: meta.tool_call.clone(),
                title: meta.title.clone(),
                files: changes,
                model_hash: meta.model_hash.clone(),
                metrics: meta.metrics.clone(),
                rev: None,
            };
            let record =
                serde_json::to_string(&step).map_err(|e| HistoryError::Invalid(e.to_string()))?;
            let message = format!("{}\n\n{STEP_TRAILER}{record}\n", one_line(&meta.title));
            let sig = signature_time(meta.time.0);
            let mut buf = gix::date::parse::TimeBuf::default();
            let sref = sig.to_ref(&mut buf);
            let repo = self.repo();
            match repo.commit_as(sref, sref, HISTORY_REF, &message, tree, head) {
                Ok(id) => {
                    step.id = id.to_string();
                    self.append_step(&step)?;
                    return Ok(Some(step));
                }
                Err(e) if attempt < CAS_ATTEMPTS => {
                    // Lost a CAS race or the ref lock: re-read the head and retry.
                    let _ = e;
                    std::thread::sleep(std::time::Duration::from_millis(
                        5 + u64::from(attempt) * 3,
                    ));
                }
                Err(e) => return Err(git(e)),
            }
        }
    }

    fn append_step(&self, step: &HistoryStep) -> Result<(), HistoryError> {
        let mut line =
            serde_json::to_string(step).map_err(|e| HistoryError::Invalid(e.to_string()))?;
        line.push('\n');
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.steps_path)?;
        f.write_all(line.as_bytes())?;
        Ok(())
    }

    // ---- reading ----------------------------------------------------------------

    /// Every step, oldest first (`seq` 1..). Uses `steps.jsonl` when it ends at
    /// the head; otherwise rebuilds it from the `Rw-Step:` trailers.
    pub fn steps(&self) -> Result<Vec<HistoryStep>, HistoryError> {
        let Some(head) = self.head()? else {
            return Ok(Vec::new());
        };
        let head_s = head.to_string();
        let mut cached: BTreeMap<u32, HistoryStep> = BTreeMap::new();
        if let Ok(text) = std::fs::read_to_string(&self.steps_path) {
            for line in text.lines() {
                if let Ok(s) = serde_json::from_str::<HistoryStep>(line) {
                    cached.insert(s.seq, s);
                }
            }
        }
        let consistent = cached.values().next_back().is_some_and(|s| s.id == head_s)
            && cached.keys().copied().eq(1..=cached.len() as u32);
        let mut steps: Vec<HistoryStep> = if consistent {
            cached.into_values().collect()
        } else {
            let rebuilt = self.rebuild()?;
            let mut text = String::new();
            for s in &rebuilt {
                text.push_str(
                    &serde_json::to_string(s).map_err(|e| HistoryError::Invalid(e.to_string()))?,
                );
                text.push('\n');
            }
            crate::fsutil::write_atomic(&self.steps_path, text.as_bytes())?;
            rebuilt
        };
        let revs = self.revisions()?;
        for s in &mut steps {
            s.rev = revs
                .iter()
                .filter(|r| r.step == s.seq)
                .map(|r| format!("rev:{:02}", r.number))
                .next_back();
        }
        Ok(steps)
    }

    /// Walks the first-parent chain from the head.
    fn rebuild(&self) -> Result<Vec<HistoryStep>, HistoryError> {
        let mut out = Vec::new();
        let mut cur = self.head()?;
        while let Some(id) = cur {
            out.push(self.step_of(id)?);
            cur = self.commit_first_parent(id)?;
        }
        out.reverse();
        Ok(out)
    }

    /// Every revision, by number.
    pub fn revisions(&self) -> Result<Vec<Revision>, HistoryError> {
        let repo = self.repo();
        let platform = repo.references().map_err(git)?;
        let iter = platform.prefixed(REV_PREFIX).map_err(git)?;
        let mut out = Vec::new();
        for r in iter {
            let r = r.map_err(git)?;
            let Some(id) = r.target().try_id().map(|i| i.to_owned()) else {
                continue;
            };
            let msg = self.commit_message(id)?;
            let Some(rec) = msg
                .lines()
                .rev()
                .find_map(|l| l.strip_prefix(REV_TRAILER))
                .and_then(|l| serde_json::from_str::<RevRecord>(l).ok())
            else {
                continue;
            };
            let step_id = self
                .commit_first_parent(id)?
                .map(|p| p.to_string())
                .unwrap_or_default();
            out.push(Revision {
                number: rec.number,
                name: rec.name,
                step: rec.step,
                id: step_id,
            });
        }
        out.sort_by_key(|r| r.number);
        Ok(out)
    }

    /// Resolves a version to a step commit. `live` is not a commit; callers
    /// handle it before calling this.
    pub fn resolve(&self, version: &str) -> Result<ObjectId, HistoryError> {
        let repo = self.repo();
        let unknown = || HistoryError::UnknownVersion(version.to_string());
        let v = version.trim();
        if v.eq_ignore_ascii_case("head") {
            return self.head()?.ok_or_else(unknown);
        }
        if let Some(n) = v.strip_prefix("step:") {
            let n: u32 = n.trim().parse().map_err(|_| unknown())?;
            return self
                .steps()?
                .into_iter()
                .find(|s| s.seq == n)
                .and_then(|s| ObjectId::from_hex(s.id.as_bytes()).ok())
                .ok_or_else(unknown);
        }
        if let Some(n) = v.strip_prefix("rev:") {
            let n: u32 = n.trim().parse().map_err(|_| unknown())?;
            return self
                .revisions()?
                .into_iter()
                .find(|r| r.number == n)
                .and_then(|r| ObjectId::from_hex(r.id.as_bytes()).ok())
                .ok_or_else(unknown);
        }
        if let Some(sha) = v.strip_prefix("commit:") {
            let sha = sha.trim();
            if let Ok(id) = ObjectId::from_hex(sha.as_bytes()) {
                return repo.find_commit(id).map(|_| id).map_err(|_| unknown());
            }
            // Unique prefix of a step id.
            let hits: Vec<_> = self
                .steps()?
                .into_iter()
                .filter(|s| sha.len() >= 4 && s.id.starts_with(sha))
                .collect();
            if hits.len() == 1 {
                return ObjectId::from_hex(hits[0].id.as_bytes()).map_err(|_| unknown());
            }
        }
        Err(unknown())
    }

    /// The step recorded at a resolved commit.
    pub fn step(&self, id: ObjectId) -> Result<HistoryStep, HistoryError> {
        let s = id.to_string();
        self.steps()?
            .into_iter()
            .find(|st| st.id == s)
            .ok_or_else(|| HistoryError::UnknownVersion(format!("commit:{s}")))
    }

    /// Names the step at `version` (default: head) as `Rev NN`: `number`
    /// when given (it must exceed every existing revision number), else the
    /// next one.
    pub fn tag(
        &self,
        name: &str,
        version: Option<&str>,
        number: Option<u32>,
        time: &(i64, String),
    ) -> Result<Revision, HistoryError> {
        let name = one_line(name);
        if name.is_empty() {
            return Err(HistoryError::Invalid("a revision needs a name".into()));
        }
        let target = self.resolve(version.unwrap_or("HEAD"))?;
        let step = self.step(target)?;
        let tree = self.commit_tree(target)?;
        let sig = signature_time(time.0);
        for _ in 0..CAS_ATTEMPTS {
            let highest = self
                .revisions()?
                .iter()
                .map(|r| r.number)
                .max()
                .unwrap_or(0);
            let number = match number {
                Some(0) => return Err(HistoryError::Invalid("revision numbers start at 1".into())),
                Some(n) if n <= highest => {
                    return Err(HistoryError::Invalid(format!(
                        "revision number {n} is not above the highest existing one ({highest:02})"
                    )));
                }
                Some(n) => n,
                None => highest + 1,
            };
            let rec = RevRecord {
                number,
                name: name.clone(),
                step: step.seq,
            };
            let msg = format!(
                "Rev {number:02}: {name}\n\n{REV_TRAILER}{}\n",
                serde_json::to_string(&rec).map_err(|e| HistoryError::Invalid(e.to_string()))?
            );
            let commit = gix::objs::Commit {
                tree,
                parents: [target].into_iter().collect(),
                author: sig.clone(),
                committer: sig.clone(),
                encoding: None,
                message: msg.into(),
                extra_headers: Vec::new(),
            };
            let repo = self.repo();
            let cid = repo.write_object(&commit).map_err(git)?.detach();
            let refname = format!("{REV_PREFIX}{number:02}");
            match repo.reference(
                refname.as_str(),
                cid,
                PreviousValue::MustNotExist,
                format!("rw tag: Rev {number:02}"),
            ) {
                Ok(_) => {
                    return Ok(Revision {
                        number,
                        name,
                        step: step.seq,
                        id: target.to_string(),
                    });
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(5)),
            }
        }
        Err(HistoryError::Git(
            "could not allocate a revision number".into(),
        ))
    }
}

pub mod compare;

fn one_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

#[cfg(test)]
mod tests;
