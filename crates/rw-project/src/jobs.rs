//! `JobQueue` (M1.28): long work (simulations) runs on a small worker pool,
//! never on the MCP stdio loop or under the session lock. `simulate` returns
//! a `job_id` at once; clients poll `job_status` or subscribe to
//! `rw://jobs/<id>` (listeners registered with [`JobQueue::on_update`] hear
//! every state change and progress in 10 % steps).
//!
//! Workers are started on demand (up to the pool size) and exit when the
//! queue is empty, so an idle queue holds no threads.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rw_api::{JobInfo, JobKind, JobState};
use rw_sim::RunSummary;

/// Default number of workers.
pub const DEFAULT_WORKERS: usize = 2;

/// Progress change that triggers an update notification.
const PROGRESS_STEP: f64 = 0.1;

/// What a finished job produced.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct JobOutcome {
    pub summary: Option<RunSummary>,
    pub run_id: Option<String>,
}

/// Why a job did not complete.
#[derive(Debug, Clone, PartialEq)]
pub enum JobFailure {
    Cancelled,
    Failed(String),
}

/// The body of a job.
pub type JobWork = Box<dyn FnOnce(&JobCtx) -> Result<JobOutcome, JobFailure> + Send + 'static>;

type Listener = Arc<dyn Fn(&JobInfo) + Send + Sync>;

/// What a new job is.
#[derive(Debug, Clone)]
pub struct JobSpec {
    pub kind: JobKind,
    pub sim: Option<String>,
    pub run_id: Option<String>,
}

struct Job {
    info: JobInfo,
    seq: u64,
    cancel: Arc<AtomicBool>,
    work: Option<JobWork>,
    notified_progress: f64,
}

#[derive(Default)]
struct State {
    jobs: BTreeMap<String, Job>,
    queue: VecDeque<String>,
    workers: usize,
    seq: u64,
}

struct Inner {
    state: Mutex<State>,
    changed: Condvar,
    max_workers: usize,
    listeners: Mutex<Vec<Listener>>,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn notify(&self, info: &JobInfo) {
        let ls: Vec<Listener> = self
            .listeners
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        for l in ls {
            l(info);
        }
    }
}

/// Handed to a running job: progress and cancellation.
pub struct JobCtx {
    id: String,
    cancel: Arc<AtomicBool>,
    inner: Arc<Inner>,
}

impl JobCtx {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// True once `job_cancel` was called.
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// Records progress (0..1). Returns `false` when the job should stop.
    pub fn progress(&self, fraction: f64) -> bool {
        let f = if fraction.is_finite() {
            fraction.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let notify = {
            let mut st = self.inner.lock();
            match st.jobs.get_mut(&self.id) {
                Some(j) if j.info.state == JobState::Running => {
                    if f > j.info.progress {
                        j.info.progress = f;
                    }
                    if j.info.progress - j.notified_progress >= PROGRESS_STEP {
                        j.notified_progress = j.info.progress;
                        Some(j.info.clone())
                    } else {
                        None
                    }
                }
                _ => None,
            }
        };
        if let Some(info) = notify {
            self.inner.notify(&info);
        }
        !self.cancelled()
    }
}

/// The job queue. Cheap to clone (shared state).
#[derive(Clone)]
pub struct JobQueue {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for JobQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobQueue")
            .field("max_workers", &self.inner.max_workers)
            .finish_non_exhaustive()
    }
}

impl Default for JobQueue {
    fn default() -> Self {
        JobQueue::new(DEFAULT_WORKERS)
    }
}

fn is_terminal(s: JobState) -> bool {
    matches!(
        s,
        JobState::Complete | JobState::Failed | JobState::Cancelled
    )
}

impl JobQueue {
    pub fn new(max_workers: usize) -> JobQueue {
        JobQueue {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                changed: Condvar::new(),
                max_workers: max_workers.max(1),
                listeners: Mutex::new(Vec::new()),
            }),
        }
    }

    /// Registers a listener for every job change (called on worker threads,
    /// without any lock held).
    pub fn on_update(&self, f: impl Fn(&JobInfo) + Send + Sync + 'static) {
        self.inner
            .listeners
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(Arc::new(f));
    }

    /// Queues `work`; returns the new job (state `queued`).
    pub fn submit(&self, spec: JobSpec, work: JobWork) -> JobInfo {
        let (info, spawn) = {
            let mut st = self.inner.lock();
            st.seq += 1;
            let seq = st.seq;
            let id = format!("job-{seq}");
            let info = JobInfo {
                job_id: id.clone(),
                kind: spec.kind,
                state: JobState::Queued,
                progress: 0.0,
                sim: spec.sim,
                run_id: spec.run_id,
                summary: None,
                error: None,
            };
            st.jobs.insert(
                id.clone(),
                Job {
                    info: info.clone(),
                    seq,
                    cancel: Arc::new(AtomicBool::new(false)),
                    work: Some(work),
                    notified_progress: 0.0,
                },
            );
            st.queue.push_back(id);
            let spawn = st.workers < self.inner.max_workers;
            if spawn {
                st.workers += 1;
            }
            (info, spawn)
        };
        // Announce `Queued` before a worker exists, so subscribers never see
        // `Running` (or `Complete`) ahead of it.
        self.inner.notify(&info);
        if spawn {
            let inner = self.inner.clone();
            let started = std::thread::Builder::new()
                .name("rw-job".into())
                .spawn(move || worker(inner));
            if started.is_err() {
                self.inner.lock().workers -= 1;
            }
        }
        info
    }

    pub fn get(&self, id: &str) -> Option<JobInfo> {
        self.inner.lock().jobs.get(id).map(|j| j.info.clone())
    }

    /// Every job, oldest first.
    pub fn list(&self) -> Vec<JobInfo> {
        let st = self.inner.lock();
        let mut v: Vec<(&u64, &JobInfo)> = st.jobs.values().map(|j| (&j.seq, &j.info)).collect();
        v.sort_by_key(|(s, _)| **s);
        v.into_iter().map(|(_, i)| i.clone()).collect()
    }

    fn newest(&self, f: impl Fn(&JobInfo) -> bool) -> Option<JobInfo> {
        let st = self.inner.lock();
        st.jobs
            .values()
            .filter(|j| f(&j.info))
            .max_by_key(|j| j.seq)
            .map(|j| j.info.clone())
    }

    /// The queued or running job computing `run_id`, if any.
    pub fn active_for_run(&self, run_id: &str) -> Option<JobInfo> {
        self.newest(|i| !is_terminal(i.state) && i.run_id.as_deref() == Some(run_id))
    }

    /// The newest queued or running job of `sim`.
    pub fn active_for_sim(&self, sim: &str) -> Option<JobInfo> {
        self.newest(|i| !is_terminal(i.state) && i.sim.as_deref() == Some(sim))
    }

    /// The newest job of `sim`, in any state.
    pub fn last_for_sim(&self, sim: &str) -> Option<JobInfo> {
        self.newest(|i| i.sim.as_deref() == Some(sim))
    }

    /// Cancels a job: a queued job is cancelled at once; a running job stops
    /// at its next progress check. Terminal jobs are returned unchanged.
    pub fn cancel(&self, id: &str) -> Option<JobInfo> {
        let (info, notify) = {
            let mut st = self.inner.lock();
            let j = st.jobs.get_mut(id)?;
            j.cancel.store(true, Ordering::Relaxed);
            let notify = j.info.state == JobState::Queued;
            if notify {
                j.info.state = JobState::Cancelled;
                j.work = None;
            }
            let info = j.info.clone();
            if notify {
                st.queue.retain(|q| q != id);
            }
            (info, notify)
        };
        if notify {
            self.inner.changed.notify_all();
            self.inner.notify(&info);
        }
        Some(info)
    }

    /// Waits until the job is terminal or `timeout` elapses; returns its
    /// latest info (`None` for an unknown job).
    pub fn wait(&self, id: &str, timeout: Duration) -> Option<JobInfo> {
        let end = Instant::now() + timeout;
        let mut st = self.inner.lock();
        loop {
            let info = st.jobs.get(id)?.info.clone();
            let now = Instant::now();
            if is_terminal(info.state) || now >= end {
                return Some(info);
            }
            st = self
                .inner
                .changed
                .wait_timeout(st, end - now)
                .map(|(g, _)| g)
                .unwrap_or_else(|e| e.into_inner().0);
        }
    }
}

fn worker(inner: Arc<Inner>) {
    loop {
        let next = {
            let mut st = inner.lock();
            let mut picked = None;
            while let Some(id) = st.queue.pop_front() {
                if let Some(j) = st.jobs.get_mut(&id)
                    && let Some(work) = j.work.take()
                {
                    j.info.state = JobState::Running;
                    picked = Some((id, work, j.cancel.clone(), j.info.clone()));
                    break;
                }
            }
            if picked.is_none() {
                st.workers -= 1;
            }
            picked
        };
        let Some((id, work, cancel, info)) = next else {
            return;
        };
        inner.notify(&info);
        let ctx = JobCtx {
            id: id.clone(),
            cancel,
            inner: inner.clone(),
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(&ctx)))
            .unwrap_or_else(|p| {
                let msg = p
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "job panicked".into());
                Err(JobFailure::Failed(msg))
            });
        let info = {
            let mut st = inner.lock();
            let Some(j) = st.jobs.get_mut(&id) else {
                continue;
            };
            match result {
                Ok(out) => {
                    j.info.state = JobState::Complete;
                    j.info.progress = 1.0;
                    j.info.summary = out.summary;
                    if out.run_id.is_some() {
                        j.info.run_id = out.run_id;
                    }
                }
                Err(JobFailure::Cancelled) => j.info.state = JobState::Cancelled,
                Err(JobFailure::Failed(m)) => {
                    j.info.state = JobState::Failed;
                    j.info.error = Some(m);
                }
            }
            j.info.clone()
        };
        inner.changed.notify_all();
        inner.notify(&info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    fn spec() -> JobSpec {
        JobSpec {
            kind: JobKind::Simulate,
            sim: Some("s1".into()),
            run_id: Some("r1".into()),
        }
    }

    #[test]
    fn runs_off_thread_and_completes() {
        let q = JobQueue::new(2);
        let (tx, rx) = channel();
        q.on_update(move |i| {
            let _ = tx.send(i.state);
        });
        let caller = std::thread::current().id();
        let info = q.submit(
            spec(),
            Box::new(move |c| {
                assert_ne!(std::thread::current().id(), caller);
                for i in 0..=10 {
                    assert!(c.progress(f64::from(i) / 10.0));
                }
                Ok(JobOutcome::default())
            }),
        );
        assert_eq!(info.state, JobState::Queued);
        let done = q.wait(&info.job_id, Duration::from_secs(10)).unwrap();
        assert_eq!(done.state, JobState::Complete);
        assert_eq!(done.progress, 1.0);
        // `wait` wakes on the condvar before listeners hear the terminal
        // update, so drain until Complete rather than `try_iter` (race).
        let mut states: Vec<JobState> = Vec::new();
        while let Ok(s) = rx.recv_timeout(Duration::from_secs(10)) {
            let terminal = s == JobState::Complete;
            states.push(s);
            if terminal {
                break;
            }
        }
        assert_eq!(states.first(), Some(&JobState::Queued));
        assert_eq!(states.last(), Some(&JobState::Complete));
        assert!(states.contains(&JobState::Running));
        assert!(q.active_for_run("r1").is_none());
        assert_eq!(q.last_for_sim("s1").unwrap().job_id, info.job_id);
    }

    #[test]
    fn cancel_stops_a_running_job_and_drops_a_queued_one() {
        let q = JobQueue::new(1);
        let (started_tx, started_rx) = channel();
        let running = q.submit(
            spec(),
            Box::new(move |c| {
                let _ = started_tx.send(());
                while c.progress(0.5) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(JobFailure::Cancelled)
            }),
        );
        let queued = q.submit(spec(), Box::new(|_| Ok(JobOutcome::default())));
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(q.active_for_sim("s1").unwrap().job_id, queued.job_id);
        let c = q.cancel(&queued.job_id).unwrap();
        assert_eq!(c.state, JobState::Cancelled);
        q.cancel(&running.job_id).unwrap();
        let done = q.wait(&running.job_id, Duration::from_secs(5)).unwrap();
        assert_eq!(done.state, JobState::Cancelled);
        assert!(q.cancel("nope").is_none());
        assert_eq!(q.list().len(), 2);
    }

    #[test]
    fn failures_and_panics_are_reported() {
        let q = JobQueue::new(2);
        let a = q.submit(
            spec(),
            Box::new(|_| Err(JobFailure::Failed("no motor".into()))),
        );
        let b = q.submit(spec(), Box::new(|_| panic!("boom")));
        let a = q.wait(&a.job_id, Duration::from_secs(5)).unwrap();
        assert_eq!(a.state, JobState::Failed);
        assert_eq!(a.error.as_deref(), Some("no motor"));
        let b = q.wait(&b.job_id, Duration::from_secs(5)).unwrap();
        assert_eq!(b.state, JobState::Failed);
        assert_eq!(b.error.as_deref(), Some("boom"));
    }
}
