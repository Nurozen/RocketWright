//! Session commands over runs, jobs, motors, schemas, and formatting
//! (M1.28, M1.30, M1.31): `simulate`, `job_status`, `job_cancel`,
//! `run_list`, `run_diff`, `motor_search`, `motor_show`, `schema_get`,
//! `fmt`, and the quick-sim tier of `design_check`.
//!
//! `simulate` resolves everything a flight needs under the session lock
//! (the evaluated model in the sim's configuration, the mounted motors, the
//! canonical `run_id`), then either answers from the run store (a cache hit)
//! or queues a job. The flight itself runs on a [`JobQueue`] worker and
//! writes `runs/<sim>/<id>/` atomically; it never holds the session lock.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rw_aero::{AeroModel, AeroOptions};
use rw_api::{
    ApiError, ApiErrorCode, CallCtx, CheckSimMode, DesignCheckIn, FmtIn, FmtOut, JobInfo, JobKind,
    JobState, ManifestMotor, MetricDiffRow, MotorInfo, MotorSearchIn, MotorSearchOut, MotorShowOut,
    OracleFile, OracleGolden, Provenance, RunDiffIn, RunDiffOut, RunListEntry, RunListOut,
    RunManifest, RunStatus, SchemaGetOut, SimulateIn, SimulateOut,
};
use rw_check::{CheckDelta, CheckReport};
use rw_mass::MassModel;
use rw_model::{EvalOptions, EvalSim, EvaluatedModel, SchemaTag};
use rw_motor::{MotorSource, MountedMotor, ThrustCurve};
use rw_sim::{RunSummary, SimError, SimInput};

use super::phases::{golden_phases, phase_rows, run_phases};
use super::{Session, err, io_err, with_hint};
use crate::jobs::{JobFailure, JobOutcome, JobQueue, JobSpec};
use crate::runs::{CORE_VERSION, RunKey, RunStore, status_of, stored_summary};
use crate::{clock, fsutil};

/// Test hook (I12): with `RW_TEST_HOOKS=1`, a simulation job first waits
/// this many milliseconds (reporting progress and honouring cancellation).
pub const TEST_SIM_DELAY_MS: &str = "RW_TEST_SIM_DELAY_MS";

/// Summary keys compared by `run_diff` between two runs.
const RUN_KEYS: &[&str] = &[
    "apogee_m",
    "max_velocity_ms",
    "max_accel_ms2",
    "max_mach",
    "time_to_apogee_s",
    "flight_time_s",
    "landing_velocity_ms",
    "rail_exit_velocity_ms",
    "deployment_velocity_ms",
    "optimum_delay_s",
    "min_stability_cal",
    "burnout_time_s",
    "burnout_altitude_m",
    "drift_m",
];

/// Oracle static key → check metric path (spec B2, `tests/oracle/keymap.json`).
pub const OR_STATIC_KEYS: &[(&str, &str)] = &[
    ("cg_m", "mass.cg"),
    ("cp_m", "aero.cp"),
    ("cna", "aero.cna"),
    ("stability_cal", "stability.liftoff"),
];

/// Everything one flight needs, resolved under the session lock.
struct SimPlan {
    input: SimInput,
    manifest: RunManifest,
}

fn test_delay() -> Option<Duration> {
    if std::env::var("RW_TEST_HOOKS").ok().as_deref() != Some("1") {
        return None;
    }
    std::env::var(TEST_SIM_DELAY_MS)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
}

/// Runs a flight: aero and mass from the evaluated model, then
/// `rw_sim::simulate`. `progress` returning `false` cancels.
pub fn fly(
    input: &SimInput,
    progress: &mut dyn FnMut(f64) -> bool,
) -> Result<rw_sim::SimResult, SimError> {
    let geometry = rw_geom::build(&input.model);
    let aero = AeroModel::new(&input.model, &geometry, &AeroOptions::default());
    let mass = MassModel::new(&input.model, &geometry, &input.motors);
    rw_sim::simulate(input, &aero, &mass, progress)
}

fn sim_error(e: &SimError) -> String {
    match e {
        SimError::Cancelled => "cancelled".into(),
        SimError::NoMotor => "no motor ignites: configure a motor in a mount".into(),
        SimError::Integration { t, message } => {
            format!("integration failed at t = {t} s: {message}")
        }
        SimError::Input { message } => message.clone(),
    }
}

/// `schema_get`: the names of every published schema, and one schema.
pub fn schema_get(name: Option<&str>) -> Result<SchemaGetOut, ApiError> {
    let names: Vec<String> = rw_api::schema_registry()
        .iter()
        .map(|e| e.name.to_string())
        .collect();
    let schema = match name {
        None => None,
        Some(n) => Some(
            rw_api::schema_entry(n)
                .ok_or_else(|| {
                    with_hint(
                        err(ApiErrorCode::NotFound, format!("no schema named `{n}`")),
                        "call schema_get without a name to list them",
                    )
                })?
                .schema()
                .as_value()
                .clone(),
        ),
    };
    Ok(SchemaGetOut { names, schema })
}

/// A tolerance string: `3%` (relative) or `<value> [unit]` (absolute, SI).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Tol {
    Pct(f64),
    Abs(f64),
}

/// Parses `3%`, `0.3 s`, `1 mm`, `0.1 cal`, `2`.
pub fn parse_tol(s: &str) -> Option<Tol> {
    let t = s.trim();
    if let Some(p) = t.strip_suffix('%') {
        return p.trim().parse::<f64>().ok().map(Tol::Pct);
    }
    let split = t
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e'))
        .unwrap_or(t.len());
    let (num, unit) = t.split_at(split);
    let v: f64 = num.trim().parse().ok()?;
    let f = match unit.trim() {
        "" | "m" | "s" | "cal" | "m/s" | "kg" | "N" | "g0" => 1.0,
        "mm" => 1e-3,
        "cm" => 1e-2,
        "ms" => 1e-3,
        "g" => 1e-3,
        "km" => 1e3,
        _ => return None,
    };
    Some(Tol::Abs(v * f))
}

fn row(key: &str, a: Option<f64>, b: Option<f64>, tol: Option<&str>) -> MetricDiffRow {
    let delta = a.zip(b).map(|(a, b)| a - b);
    let delta_pct = b
        .zip(delta)
        .and_then(|(b, d)| (b != 0.0).then_some(100.0 * d / b));
    let pass = tol.and_then(|t| {
        let t = parse_tol(t)?;
        let ok = match t {
            Tol::Pct(p) => delta_pct.map(|d| d.abs() <= p + 1e-9),
            Tol::Abs(x) => delta.map(|d| d.abs() <= x * (1.0 + 1e-9)),
        };
        Some(ok.unwrap_or(false))
    });
    MetricDiffRow {
        key: key.to_string(),
        a,
        b,
        delta,
        delta_pct,
        tol: tol.map(String::from),
        pass,
        unit: None,
    }
}

/// `tests/oracle/tolerances.json` (BAR owns it), built in.
const BUILTIN_TOLERANCES: &str = include_str!("../../../../tests/oracle/tolerances.json");

/// The tolerance group for `case` in a `tolerances.json` beside the golden,
/// or in the built-in copy when there is none.
fn golden_tolerances(golden: &Path, case: u32) -> BTreeMap<String, String> {
    // Beside the golden when present (a repo checkout); otherwise the bar's
    // table built in, so a golden copied on its own (the B3 kit's `data/`)
    // is still scored (B3 round 8: every row printed `tol -`).
    let text = golden
        .parent()
        .and_then(|dir| std::fs::read_to_string(dir.join("tolerances.json")).ok())
        .unwrap_or_else(|| BUILTIN_TOLERANCES.to_string());
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return BTreeMap::new();
    };
    let mut out = BTreeMap::new();
    for g in v["groups"].as_array().into_iter().flatten() {
        let hit = g["cases"]
            .as_array()
            .is_some_and(|cs| cs.iter().any(|c| c.as_u64() == Some(u64::from(case))));
        if hit && let Some(t) = g["tol"].as_object() {
            for (k, v) in t {
                if let Some(s) = v.as_str() {
                    out.insert(k.clone(), s.to_string());
                }
            }
        }
    }
    out
}

/// The sha256 motor digest of a run (same rule as the golden's).
fn run_motor_digest(m: &RunManifest) -> String {
    let motors: Vec<rw_api::OracleMotor> = m
        .motors
        .iter()
        .map(|x| rw_api::OracleMotor {
            mount: x.mount.clone(),
            designation: x.designation.clone(),
            digest: x.sha256.clone(),
            delay_s: None,
        })
        .collect();
    rw_api::motor_digest(&motors)
}

fn motor_info(id: String, c: &ThrustCurve) -> MotorInfo {
    MotorInfo {
        id,
        designation: c.designation.clone(),
        manufacturer: c.manufacturer.clone(),
        class: c.class.clone(),
        diameter: c.diameter,
        length: c.length,
        total_impulse: c.total_impulse,
        burn_time: c.burn_time,
        average_thrust: c.average_thrust,
        delays: c.delays.clone(),
        total_mass: c.total_mass,
        source: c.source.clone(),
        sha256: c.sha256.clone(),
    }
}

fn quantity<D: rw_units::UnitDim>(
    q: &Option<rw_units::Qty<D>>,
    what: &str,
) -> Result<Option<f64>, ApiError> {
    match q {
        None => Ok(None),
        Some(q) => match q.literal() {
            Ok(Some(v)) => Ok(Some(v.value)),
            Ok(None) => Err(err(
                ApiErrorCode::InvalidInput,
                format!("`{what}` must be a literal quantity, not an expression"),
            )),
            Err(e) => Err(err(ApiErrorCode::InvalidInput, format!("`{what}`: {e}"))),
        },
    }
}

impl Session {
    /// The simulation job queue.
    pub fn jobs(&self) -> &JobQueue {
        &self.jobs
    }

    /// The project's run directories.
    pub fn runs(&self) -> &RunStore {
        &self.runs
    }

    /// The delta from an empty model to the current one (`project_create`).
    pub fn delta_from_empty(&self, step: Option<String>) -> CheckDelta {
        let empty = rw_model::eval(&rw_model::SourceSet::default(), &EvalOptions::default());
        let before = self.checker.check(&empty, &[], &BTreeMap::new(), &|_| None);
        self.checker.delta(&before, &self.report, step)
    }

    /// The model evaluated in `config` (default: the project default) and
    /// its static check report.
    pub fn evaluated(
        &self,
        config: Option<&str>,
    ) -> Result<(EvaluatedModel, CheckReport), ApiError> {
        let opts = EvalOptions {
            config: config.map(String::from),
            ..EvalOptions::default()
        };
        if opts == EvalOptions::default() {
            return Ok((self.model.clone(), self.report.clone()));
        }
        let m = self.evaluate(&self.store, &opts);
        if let Some(c) = config
            && !m.configs.contains_key(c)
        {
            return Err(with_hint(
                err(ApiErrorCode::NotFound, format!("no configuration `{c}`")),
                format!(
                    "configurations: {}",
                    self.model
                        .configs
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }
        let r = self.check(&m, &self.known);
        Ok((m, r))
    }

    /// Writes generated outputs (`renders/**`) atomically. Paths must be
    /// project-relative and under `renders/`; source files are never written
    /// this way.
    pub fn write_outputs(&mut self, files: &[(String, Vec<u8>)]) -> Result<(), ApiError> {
        if !self.writable {
            return Err(with_hint(
                err(ApiErrorCode::Locked, "this session is read-only"),
                "writes go through the project's owner",
            ));
        }
        for (rel, bytes) in files {
            let ok = rel.starts_with("renders/")
                && !rel
                    .split('/')
                    .any(|s| s.is_empty() || s == ".." || s == ".");
            if !ok {
                return Err(err(
                    ApiErrorCode::InvalidInput,
                    format!("`{rel}` is not under renders/"),
                ));
            }
            fsutil::write_atomic(&self.root.join(rel), bytes).map_err(|e| io_err(rel, e))?;
        }
        Ok(())
    }

    /// Removes all but the newest `keep` files directly under `dir` (a
    /// directory under `renders/`) whose names start with `prefix`; newest
    /// by modification time, then by name. Returns the removed
    /// project-relative paths (POL: window renders are pruned per op).
    pub fn prune_outputs(
        &mut self,
        dir: &str,
        prefix: &str,
        keep: usize,
    ) -> Result<Vec<String>, ApiError> {
        if !self.writable {
            return Err(with_hint(
                err(ApiErrorCode::Locked, "this session is read-only"),
                "writes go through the project's owner",
            ));
        }
        let ok = dir.starts_with("renders/")
            && !dir
                .split('/')
                .any(|s| s.is_empty() || s == ".." || s == ".");
        if !ok || prefix.is_empty() || prefix.contains(['/', '\\']) {
            return Err(err(
                ApiErrorCode::InvalidInput,
                format!("`{dir}/{prefix}*` is not a file pattern under renders/"),
            ));
        }
        let abs = self.root.join(dir);
        let entries = match std::fs::read_dir(&abs) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_err(dir, e)),
        };
        let mut files: Vec<(std::time::SystemTime, String)> = Vec::new();
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let Ok(meta) = entry.metadata() else { continue };
            if name.starts_with(prefix) && meta.is_file() {
                let at = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                files.push((at, name));
            }
        }
        files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        let mut removed = Vec::new();
        for (_, name) in files.into_iter().skip(keep) {
            let rel = format!("{dir}/{name}");
            std::fs::remove_file(abs.join(&name)).map_err(|e| io_err(&rel, e))?;
            removed.push(rel);
        }
        Ok(removed)
    }

    // ---- design_check --sim quick ------------------------------------------------

    /// The sim a quick check flies for `model`: the first sim of the checked
    /// configuration, else the first sim.
    fn quick_sim_for(&self, model: &EvaluatedModel) -> Option<EvalSim> {
        let cfg = model.config.as_deref();
        let flights = || {
            model
                .sims
                .values()
                .filter(|s| s.kind == rw_model::SimKind::Flight)
        };
        flights()
            .find(|s| Some(s.config.as_str()) == cfg)
            .or_else(|| flights().next())
            .cloned()
    }

    pub(super) fn quick_check(
        &self,
        model: &EvaluatedModel,
        overrides: &EvalOptions,
        report: CheckReport,
    ) -> Result<CheckReport, ApiError> {
        let Some(mut sim) = self.quick_sim_for(model) else {
            return Err(with_hint(
                err(
                    ApiErrorCode::InvalidInput,
                    "the project has no simulation for --sim quick",
                ),
                "add sims/<id>.rw.toml (see `rw init --template minimum`)",
            ));
        };
        if let Some(c) = &model.config {
            sim.config = c.clone();
        }
        // Fly the checked model: the variant and `--set` overrides as well as
        // the configuration (B3 round 10: a what-if must not fly the file).
        let plan = self.plan(&sim, overrides, None)?;
        let result = fly(&plan.input, &mut |_| true).map_err(|e| {
            err(
                ApiErrorCode::Conflict,
                format!("quick sim `{}`: {}", sim.id, sim_error(&e)),
            )
        })?;
        Ok(rw_check::with_sim(
            &plan.input.model,
            report,
            result.summary,
        ))
    }

    pub(super) fn design_check_sim(&self, i: &DesignCheckIn) -> Result<CheckReport, ApiError> {
        let opts = EvalOptions {
            config: i.config.clone(),
            variant: i.variant.clone(),
            set: i.set.clone(),
        };
        let default = opts == EvalOptions::default();
        if i.sim.is_none() && default {
            return Ok(self.report.clone());
        }
        let model = if default {
            self.model.clone()
        } else {
            self.evaluate(&self.store, &opts)
        };
        let report = if default {
            self.report.clone()
        } else {
            self.check(&model, &self.known)
        };
        match i.sim {
            Some(CheckSimMode::Quick) => self.quick_check(&model, &opts, report),
            None => Ok(report),
        }
    }

    // ---- simulate -----------------------------------------------------------------

    /// A simulation by id (`simulation_5`) or by its display name
    /// (`"Simulation 5"`; see [`find_sim`]).
    fn sim(&self, id: &str) -> Result<EvalSim, ApiError> {
        let listing = || {
            format!(
                "simulations: {}",
                self.model
                    .sims
                    .values()
                    .map(|s| format!("{} (\"{}\")", s.id, s.name))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        match find_sim(&self.model.sims, id) {
            SimLookup::Found(s) => Ok(s.clone()),
            SimLookup::Missing => Err(with_hint(
                err(ApiErrorCode::NotFound, format!("no simulation `{id}`")),
                listing(),
            )),
            SimLookup::Ambiguous(ids) => Err(with_hint(
                err(
                    ApiErrorCode::InvalidInput,
                    format!(
                        "simulation name `{id}` matches {}; use the id",
                        ids.join(", ")
                    ),
                ),
                listing(),
            )),
        }
    }

    /// Resolves a flight: the model in the sim's configuration (with the
    /// variant and `set` overrides of `overrides`; its `config` is ignored),
    /// its motors, the run key, and the manifest (without wall-clock fields).
    /// With overrides the run key hashes the overridden model, so a what-if
    /// never shares a run id with the model on disk.
    fn plan(
        &self,
        sim: &EvalSim,
        overrides: &EvalOptions,
        thread: Option<&str>,
    ) -> Result<SimPlan, ApiError> {
        let opts = EvalOptions {
            config: Some(sim.config.clone()),
            variant: overrides.variant.clone(),
            set: overrides.set.clone(),
        };
        let overridden = opts.variant.is_some() || !opts.set.is_empty();
        let model = self.evaluate(&self.store, &opts);
        let model_hash = if overridden {
            model.model_hash.clone()
        } else {
            self.model.model_hash.clone()
        };
        let config = model.configs.get(&sim.config).cloned().ok_or_else(|| {
            with_hint(
                err(
                    ApiErrorCode::NotFound,
                    format!(
                        "simulation `{}` names no configuration `{}`",
                        sim.id, sim.config
                    ),
                ),
                format!(
                    "configurations: {}",
                    model.configs.keys().cloned().collect::<Vec<_>>().join(", ")
                ),
            )
        })?;
        let resolve = self.motor_resolver(&model);
        let motors: Vec<MountedMotor> = rw_check::mounted_from_config(&model, &resolve);
        if motors.is_empty() {
            return Err(with_hint(
                err(
                    ApiErrorCode::Conflict,
                    format!("configuration `{}` has no resolved motor", sim.config),
                ),
                "set a motor in a mount (`motor_search` lists refs such as generic:RW_C6G)",
            ));
        }
        let shas: Vec<&str> = motors.iter().map(|m| m.curve.sha256.as_str()).collect();
        // Liquid engines the configuration mounts: their content hashes.
        let engine_hash: Option<String> = {
            let hs: Vec<String> = config
                .motors
                .iter()
                .filter_map(|mm| mm.engine.as_deref())
                .filter_map(|id| model.engines.get(id))
                .map(crate::liquid::engine_hash)
                .collect();
            (!hs.is_empty()).then(|| hs.join(","))
        };
        let key = RunKey {
            model_hash: &model_hash,
            config: &config,
            sim,
            motors: shas,
            engine: engine_hash.as_deref(),
            core_version: CORE_VERSION,
            seed: sim.seed,
            integrator: sim.conditions.integrator,
        };
        let run_id = key.run_id();
        let step = self
            .history
            .as_ref()
            .and_then(|h| h.steps().ok())
            .and_then(|s| s.last().map(|s| s.seq));
        let manifest = RunManifest {
            schema: SchemaTag,
            run_id,
            sim: sim.id.clone(),
            sim_name: sim.name.clone(),
            kind: sim.kind,
            config: sim.config.clone(),
            model_hash,
            provenance: Provenance::Engineering,
            conditions: sim.conditions.clone(),
            conditions_hash: rw_api::conditions_hash(&sim.conditions),
            motors: motors
                .iter()
                .map(|m| ManifestMotor {
                    mount: m.mount.clone(),
                    designation: m.curve.designation.clone(),
                    sha256: m.curve.sha256.clone(),
                    source: m.curve.source.clone(),
                })
                .collect(),
            inputs: self.inputs(&self.known),
            core_version: CORE_VERSION.to_string(),
            seed: sim.seed,
            rtol: sim.rtol,
            atol: sim.atol,
            step,
            rev: None,
            thread: thread.map(String::from),
            started: None,
            wall_time_s: None,
        };
        let input = SimInput {
            schema: SchemaTag,
            sim: sim.clone(),
            config,
            model,
            motors,
        };
        Ok(SimPlan { input, manifest })
    }

    pub(super) fn simulate(
        &mut self,
        i: &SimulateIn,
        ctx: &CallCtx,
    ) -> Result<SimulateOut, ApiError> {
        if i.mc.is_some_and(|n| n > 1) {
            return Err(with_hint(
                ApiError::not_implemented("simulate with mc > 1 (Monte Carlo)"),
                "omit mc for a single deterministic flight",
            ));
        }
        let mut sim = self.sim(&i.sim)?;
        if sim.kind == rw_model::SimKind::VisualFlow {
            return self.visual_simulate(&sim, i.force, ctx.thread.as_deref());
        }
        if let Some(c) = &i.config {
            sim.config = c.clone();
        }
        let plan = self.plan(&sim, &EvalOptions::default(), ctx.thread.as_deref())?;
        let run_id = plan.manifest.run_id.clone();
        if !i.force && self.runs.has(&sim.id, &run_id) {
            let summary = self
                .runs
                .summary(&sim.id, &run_id)
                .map_err(|e| io_err("run summary", e))?;
            return Ok(SimulateOut {
                sim: sim.id,
                run_id,
                status: RunStatus::Complete,
                cached: true,
                job_id: None,
                summary: Some(summary),
            });
        }
        if let Some(j) = self.jobs.active_for_run(&run_id) {
            return Ok(SimulateOut {
                sim: sim.id,
                run_id,
                status: RunStatus::Running,
                cached: false,
                job_id: Some(j.job_id),
                summary: None,
            });
        }
        if !self.writable {
            return Err(with_hint(
                err(ApiErrorCode::Locked, "this session is read-only"),
                "simulations write runs/; run them through the project's owner",
            ));
        }
        let store = self.runs.clone();
        let SimPlan {
            input,
            mut manifest,
        } = plan;
        let delay = test_delay();
        let work = Box::new(move |jc: &crate::jobs::JobCtx| {
            if let Some(d) = delay {
                let end = Instant::now() + d;
                while Instant::now() < end {
                    if !jc.progress(0.0) {
                        return Err(JobFailure::Cancelled);
                    }
                    std::thread::sleep(Duration::from_millis(20).min(d));
                }
            }
            let t0 = Instant::now();
            let started = clock::now().1;
            let result = fly(&input, &mut |p| jc.progress(p)).map_err(|e| match e {
                SimError::Cancelled => JobFailure::Cancelled,
                other => JobFailure::Failed(sim_error(&other)),
            })?;
            manifest.started = Some(started);
            manifest.wall_time_s = Some(rw_check::canon::round_sig(t0.elapsed().as_secs_f64(), 3));
            store
                .write(&manifest, &result)
                .map_err(|e| JobFailure::Failed(format!("writing the run: {e}")))?;
            Ok(JobOutcome {
                summary: Some(stored_summary(&result.summary)),
                run_id: Some(manifest.run_id.clone()),
            })
        });
        let job = self.jobs.submit(
            JobSpec {
                kind: JobKind::Simulate,
                sim: Some(sim.id.clone()),
                run_id: Some(run_id.clone()),
            },
            work,
        );
        Ok(SimulateOut {
            sim: sim.id,
            run_id,
            status: RunStatus::Running,
            cached: false,
            job_id: Some(job.job_id),
            summary: None,
        })
    }

    pub(super) fn job(&self, id: &str) -> Result<JobInfo, ApiError> {
        self.jobs.get(id).ok_or_else(|| {
            with_hint(
                err(ApiErrorCode::NotFound, format!("no job `{id}`")),
                "job ids come from simulate; jobs do not survive a sidecar restart (see run_list)",
            )
        })
    }

    pub(super) fn job_cancel(&self, id: &str) -> Result<JobInfo, ApiError> {
        self.jobs.cancel(id).ok_or_else(|| {
            with_hint(
                err(ApiErrorCode::NotFound, format!("no job `{id}`")),
                "job ids come from simulate",
            )
        })
    }

    // ---- runs ---------------------------------------------------------------------

    pub(super) fn run_list(&self, only: Option<&str>) -> Result<RunListOut, ApiError> {
        let current = self.model.model_hash.clone();
        let mut runs = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for (id, sim) in &self.model.sims {
            seen.insert(id.clone());
            // Visual flow studies are not flights: their runs (provenance
            // `visual`, I13) are listed only when asked for by id.
            if only.is_some_and(|o| o != id)
                || (only.is_none() && sim.kind == rw_model::SimKind::VisualFlow)
            {
                continue;
            }
            let latest = self.runs.latest(id);
            let active = self.jobs.active_for_sim(id);
            let last = self.jobs.last_for_sim(id);
            let status = if active.is_some() {
                RunStatus::Running
            } else if last.as_ref().is_some_and(|j| j.state == JobState::Failed) {
                RunStatus::Failed
            } else {
                match &latest {
                    Some(m) => status_of(m, &current),
                    None => RunStatus::NotRun,
                }
            };
            let summary = latest
                .as_ref()
                .and_then(|m| self.runs.summary(&m.sim, &m.run_id).ok());
            runs.push(RunListEntry {
                sim: id.clone(),
                sim_name: sim.name.clone(),
                config: latest
                    .as_ref()
                    .map_or_else(|| sim.config.clone(), |m| m.config.clone()),
                kind: sim.kind,
                status,
                run_id: active
                    .as_ref()
                    .and_then(|j| j.run_id.clone())
                    .or_else(|| latest.as_ref().map(|m| m.run_id.clone())),
                model_hash: latest.as_ref().map(|m| m.model_hash.clone()),
                provenance: latest.as_ref().map(|m| m.provenance),
                summary,
                job_id: active.as_ref().or(last.as_ref()).map(|j| j.job_id.clone()),
                superseded_by: None,
                conditions_hash: latest
                    .as_ref()
                    .filter(|m| {
                        active
                            .as_ref()
                            .and_then(|j| j.run_id.as_ref())
                            .is_none_or(|r| *r == m.run_id)
                    })
                    .map(|m| m.conditions_hash.clone()),
            });
            // The run the latest one replaced (newest earlier run on another
            // model) stays listed, so an edit's before and after compare.
            if let Some(l) = &latest {
                let previous = self.runs.manifests().into_iter().rfind(|m| {
                    m.sim == *id && m.run_id != l.run_id && m.model_hash != l.model_hash
                });
                if let Some(m) = previous {
                    runs.push(RunListEntry {
                        sim: id.clone(),
                        sim_name: m.sim_name.clone(),
                        config: m.config.clone(),
                        kind: m.kind,
                        status: status_of(&m, &current),
                        run_id: Some(m.run_id.clone()),
                        model_hash: Some(m.model_hash.clone()),
                        provenance: Some(m.provenance),
                        summary: self.runs.summary(&m.sim, &m.run_id).ok(),
                        job_id: None,
                        superseded_by: Some(l.run_id.clone()),
                        conditions_hash: Some(m.conditions_hash.clone()),
                    });
                }
            }
        }
        // Runs of sims that are no longer in the model are Outdated.
        let mut orphans: BTreeMap<String, RunManifest> = BTreeMap::new();
        for m in self.runs.manifests() {
            if !seen.contains(&m.sim)
                && only.is_none_or(|o| o == m.sim)
                && (only.is_some() || m.provenance != Provenance::Visual)
            {
                orphans.insert(m.sim.clone(), m);
            }
        }
        for (_, m) in orphans {
            runs.push(RunListEntry {
                sim: m.sim.clone(),
                sim_name: m.sim_name.clone(),
                config: m.config.clone(),
                kind: m.kind,
                status: RunStatus::Outdated,
                run_id: Some(m.run_id.clone()),
                model_hash: Some(m.model_hash.clone()),
                provenance: Some(m.provenance),
                summary: self.runs.summary(&m.sim, &m.run_id).ok(),
                job_id: None,
                superseded_by: None,
                conditions_hash: Some(m.conditions_hash.clone()),
            });
        }
        Ok(RunListOut {
            model_hash: current,
            runs,
        })
    }

    fn find_run(&self, r: &str) -> Result<RunManifest, ApiError> {
        self.runs.find(r).ok_or_else(|| {
            with_hint(
                err(ApiErrorCode::NotFound, format!("no run `{r}`")),
                "run refs are <run-id>, <sim>/<run-id>, rw:run/<id>, or a sim id (its latest run); see run_list",
            )
        })
    }

    pub(super) fn run_summary(&self, r: &str) -> Result<RunSummary, ApiError> {
        let m = self.find_run(r)?;
        self.runs
            .summary(&m.sim, &m.run_id)
            .map_err(|e| io_err("run summary", e))
    }

    fn golden_path(&self, p: &str) -> PathBuf {
        let path = Path::new(p);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.root.join(path)
        }
    }

    pub(super) fn run_diff(&self, i: &RunDiffIn) -> Result<RunDiffOut, ApiError> {
        let a = self.find_run(&i.a)?;
        let sa = self
            .runs
            .summary(&a.sim, &a.run_id)
            .map_err(|e| io_err("run summary", e))?;
        let a_name = format!("{}/{}", a.sim, a.run_id);
        let tol_for = |key: &str, extra: &BTreeMap<String, String>| -> Option<String> {
            i.tol.get(key).or_else(|| extra.get(key)).cloned()
        };
        if let Some(b) = &i.b {
            let bm = self.find_run(b)?;
            let sb = self
                .runs
                .summary(&bm.sim, &bm.run_id)
                .map_err(|e| io_err("run summary", e))?;
            let rows: Vec<MetricDiffRow> = RUN_KEYS
                .iter()
                .filter_map(|k| {
                    let (x, y) = (
                        rw_sim::outputs::summary_value(&sa, k),
                        rw_sim::outputs::summary_value(&sb, k),
                    );
                    (x.is_some() || y.is_some())
                        .then(|| row(k, x, y, tol_for(k, &BTreeMap::new()).as_deref()))
                })
                .collect();
            let pass = rows.iter().all(|r| r.pass != Some(false));
            let mut notes = Vec::new();
            let phases = match (
                self.runs.events(&a.sim, &a.run_id),
                self.runs.events(&bm.sim, &bm.run_id),
            ) {
                (Ok(x), Ok(y)) => phase_rows(&run_phases(&x), &run_phases(&y)),
                (Err(e), _) | (_, Err(e)) => {
                    notes.push(format!("phase rows not compared: events.json: {e}"));
                    Vec::new()
                }
            };
            return Ok(RunDiffOut {
                a: a_name,
                b: format!("{}/{}", bm.sim, bm.run_id),
                mismatches: Vec::new(),
                rows,
                phases,
                pass,
                notes,
            });
        }
        let Some(gp) = &i.golden else {
            return Err(with_hint(
                err(ApiErrorCode::InvalidInput, "run_diff needs `b` or `golden`"),
                "compare two runs (b) or a run and an oracle golden (golden: tests/oracle/case1-generic.json)",
            ));
        };
        let path = self.golden_path(gp);
        let text = std::fs::read_to_string(&path)
            .map_err(|e| io_err(&format!("golden {}", path.display()), e))?;
        let golden: OracleGolden = match serde_json::from_str::<OracleFile>(&text) {
            Ok(OracleFile::Golden(g)) => g,
            Ok(_) => {
                return Err(err(
                    ApiErrorCode::InvalidInput,
                    format!("{gp} is an oracle file but not a golden"),
                ));
            }
            Err(e) => {
                return Err(err(
                    ApiErrorCode::InvalidInput,
                    format!("{gp} is not an oracle golden: {e}"),
                ));
            }
        };
        let tols = golden_tolerances(&path, golden.case);
        let mut mismatches = Vec::new();
        if a.conditions_hash != golden.conditions_hash
            && rw_api::conditions_hash(&comparable(&a.conditions))
                != rw_api::conditions_hash(&comparable(&golden.conditions))
        {
            mismatches.push(format!(
                "conditions_hash: run {} vs golden {}",
                a.conditions_hash, golden.conditions_hash
            ));
            // Which conditions differ, so a matching sim can be written
            // from this output alone (B3 round 5, T5).
            mismatches.extend(conditions_diff(&a.conditions, &golden.conditions));
        }
        if a.config != golden.config_id {
            mismatches.push(format!(
                "config_id: run {} vs golden {}",
                a.config, golden.config_id
            ));
        }
        if a.sim_name != golden.sim_name {
            mismatches.push(format!(
                "sim_name: run {:?} vs golden {:?}",
                a.sim_name, golden.sim_name
            ));
        }
        let digest = run_motor_digest(&a);
        if digest != golden.motor_digest {
            mismatches.push(format!(
                "motor_digest: run {digest} vs golden {}",
                golden.motor_digest
            ));
        }
        let gs = serde_json::to_value(&golden.summary).unwrap_or_default();
        let mut rows = Vec::new();
        for (or, ours) in rw_sim::outputs::OR_SUMMARY_KEYS {
            let g = gs.get(*or).and_then(serde_json::Value::as_f64);
            let x = rw_sim::outputs::summary_value(&sa, ours);
            if g.is_none() && x.is_none() {
                continue;
            }
            rows.push(row(ours, x, g, tol_for(ours, &tols).as_deref()));
        }
        // Static rows (CG, CP, CNa, stability): the check report of the run's
        // configuration on the run's own model, the live model or the history
        // step it was recorded at, so an outdated run still gets them and no
        // agent subtracts CG or CP itself (B3 round 11).
        let mut notes = Vec::new();
        if let Some(st) = &golden.static_block {
            match self.run_static_report(&a) {
                Ok((report, at)) => {
                    let metrics = rw_check::metrics::metric_map(&report);
                    let gv = serde_json::to_value(st).unwrap_or_default();
                    for (or, ours) in OR_STATIC_KEYS {
                        let g = gv.get(*or).and_then(serde_json::Value::as_f64);
                        let x = metrics.get(*ours).map(|m| m.value);
                        if g.is_none() && x.is_none() {
                            continue;
                        }
                        rows.push(row(ours, x, g, tol_for(ours, &tols).as_deref()));
                    }
                    if let Some(at) = at {
                        notes.push(format!(
                            "static rows: the run's model ({at}), config {}; the current model has changed since the run",
                            a.config
                        ));
                    }
                }
                Err(why) => notes.push(format!(
                    "static rows not compared: {why}; fly the sim again (`rw sim {}`) and diff again",
                    a.sim
                )),
            }
        }
        if !mismatches.is_empty() {
            for r in &mut rows {
                r.pass = None;
            }
        }
        let phases = match self.runs.events(&a.sim, &a.run_id) {
            Ok(e) => phase_rows(&run_phases(&e), &golden_phases(&golden.events)),
            Err(e) => {
                notes.push(format!("phase rows not compared: events.json: {e}"));
                Vec::new()
            }
        };
        let pass = mismatches.is_empty() && rows.iter().all(|r| r.pass != Some(false));
        Ok(RunDiffOut {
            a: a_name,
            b: gp.clone(),
            mismatches,
            rows,
            phases,
            pass,
            notes,
        })
    }

    /// The static check report of a run's configuration on the run's own
    /// model: the live model when the run is current (`None`), else the
    /// history step its model was recorded at (`Some("step:<n>")`).
    fn run_static_report(&self, m: &RunManifest) -> Result<(CheckReport, Option<String>), String> {
        if m.model_hash == self.model.model_hash {
            let (_, report) = self.evaluated(Some(&m.config)).map_err(|e| e.message)?;
            return Ok((report, None));
        }
        let version = self
            .version_of_run(&format!("run:{}/{}", m.sim, m.run_id))
            .map_err(|_| "the run's model is not in the history".to_string())?;
        let (model, report) = self
            .evaluated_at(&version, Some(&m.config))
            .map_err(|e| e.message)?;
        if !model.configs.contains_key(&m.config) {
            return Err(format!("{version} has no configuration `{}`", m.config));
        }
        Ok((report, Some(version)))
    }

    // ---- motors -------------------------------------------------------------------

    fn motor_candidates(&self) -> Vec<(String, ThrustCurve)> {
        let mut out: Vec<(String, ThrustCurve)> = Vec::new();
        for c in rw_motor::generic::generic_motors() {
            let id = match &c.source {
                MotorSource::Generic { id } => format!("generic:{id}"),
                _ => c.designation.clone(),
            };
            out.push((id, c));
        }
        for f in self.library.files.iter().filter(|f| f.usable()) {
            for c in &f.curves {
                let path = f.path.strip_prefix("lib/").unwrap_or(&f.path);
                out.push((format!("lib:{path}#{}", c.designation), c.clone()));
            }
        }
        out
    }

    pub(super) fn motor_search(&self, i: &MotorSearchIn) -> Result<MotorSearchOut, ApiError> {
        let q = rw_motor::generic::MotorQuery {
            query: i.query.clone(),
            class: i.class.clone(),
            diameter: quantity(&i.diameter, "diameter")?,
            min_impulse: quantity(&i.min_impulse, "min_impulse")?,
            max_impulse: quantity(&i.max_impulse, "max_impulse")?,
        };
        let mut motors: Vec<MotorInfo> = self
            .motor_candidates()
            .into_iter()
            .filter(|(_, c)| q.matches(c))
            .map(|(id, c)| motor_info(id, &c))
            .collect();
        motors.sort_by(|a, b| {
            a.total_impulse
                .total_cmp(&b.total_impulse)
                .then_with(|| a.id.cmp(&b.id))
        });
        if let Some(n) = i.limit {
            motors.truncate(n as usize);
        }
        Ok(MotorSearchOut { motors })
    }

    pub(super) fn motor_show(&self, id: &str) -> Result<MotorShowOut, ApiError> {
        let curve = self.library.motor(id).ok_or_else(|| {
            with_hint(
                err(ApiErrorCode::NotFound, format!("no motor `{id}`")),
                "list motors with motor_search (refs: generic:<id>, lib:<path>#<designation>, a designation)",
            )
        })?;
        let ref_id = self
            .motor_candidates()
            .into_iter()
            .find(|(_, c)| c.sha256 == curve.sha256 && c.designation == curve.designation)
            .map_or_else(|| id.to_string(), |(i, _)| i);
        Ok(MotorShowOut {
            info: motor_info(ref_id, &curve),
            curve,
        })
    }

    // ---- fmt ----------------------------------------------------------------------

    pub(super) fn fmt(&mut self, i: &FmtIn, ctx: &CallCtx) -> Result<FmtOut, ApiError> {
        let wanted: std::collections::BTreeSet<&str> = i.files.iter().map(String::as_str).collect();
        for w in &wanted {
            if !self.known.contains_key(*w) && !self.external.contains_key(*w) {
                return Err(err(
                    ApiErrorCode::NotFound,
                    format!("`{w}` is not a source file of this project"),
                ));
            }
        }
        let broken: Vec<&String> = self
            .external
            .keys()
            .filter(|p| wanted.is_empty() || wanted.contains(p.as_str()))
            .collect();
        if !broken.is_empty() {
            let mut e = err(
                ApiErrorCode::InvalidInput,
                format!(
                    "cannot format files that do not parse: {}",
                    broken
                        .iter()
                        .map(|p| p.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            );
            e.diagnostics = broken
                .iter()
                .flat_map(|p| self.external[*p].iter().cloned())
                .collect();
            return Err(e);
        }
        let mut next = self.store.clone();
        let mut writes = Vec::new();
        let mut changed = Vec::new();
        for (p, text) in &self.known {
            if !wanted.is_empty() && !wanted.contains(p.as_str()) {
                continue;
            }
            let formatted = crate::fmt::format_text(p, text).map_err(|ds| {
                let mut e = err(ApiErrorCode::InvalidInput, format!("{p} does not parse"));
                e.diagnostics = ds;
                e
            })?;
            if formatted != *text {
                changed.push(p.clone());
                if !i.check {
                    next.insert(p.clone(), &formatted).map_err(|ds| {
                        let mut e = err(
                            ApiErrorCode::Internal,
                            format!("formatted {p} does not parse"),
                        );
                        e.diagnostics = ds;
                        e
                    })?;
                    writes.push((p.clone(), Some(formatted)));
                }
            }
        }
        if !i.check && !writes.is_empty() {
            let title = ctx.label.clone().unwrap_or_else(|| "Format".into());
            self.commit(next, writes, false, ctx, Some("fmt"), title)?;
        }
        Ok(FmtOut { changed })
    }
}

/// Conditions as compared with a golden: `launch_into_wind = false` is the
/// default, so it matches an absent flag (B3 round 13: a run that said
/// `false` against a golden without the key was a spurious mismatch).
fn comparable(c: &rw_model::Conditions) -> rw_model::Conditions {
    let mut c = c.clone();
    if c.launch_into_wind == Some(false) {
        c.launch_into_wind = None;
    }
    c
}

/// `conditions.<key>: run <a> vs golden <b>` for each differing key (JSON
/// values; a key missing on one side shows as `-`; `launch_into_wind`
/// false equals absent).
fn conditions_diff(run: &rw_model::Conditions, golden: &rw_model::Conditions) -> Vec<String> {
    let json = |c: &rw_model::Conditions| serde_json::to_value(c).unwrap_or_default();
    let (a, b) = (json(run), json(golden));
    let (na, nb) = (json(&comparable(run)), json(&comparable(golden)));
    let empty = serde_json::Map::new();
    let obj = |v: &serde_json::Value| v.as_object().unwrap_or(&empty).clone();
    let (ma, mb, xa, xb) = (obj(&a), obj(&b), obj(&na), obj(&nb));
    let mut keys: Vec<&String> = ma.keys().chain(mb.keys()).collect();
    keys.sort();
    keys.dedup();
    let show = |v: Option<&serde_json::Value>| match v {
        None | Some(serde_json::Value::Null) => "-".to_string(),
        Some(v) => v.to_string(),
    };
    keys.into_iter()
        .filter(|k| xa.get(*k).filter(|v| !v.is_null()) != xb.get(*k).filter(|v| !v.is_null()))
        .map(|k| {
            format!(
                "conditions.{k}: run {} vs golden {}",
                show(ma.get(k)),
                show(mb.get(k))
            )
        })
        .collect()
}

/// How a simulation reference resolved.
#[derive(Debug, PartialEq)]
pub(crate) enum SimLookup<'a> {
    Found(&'a EvalSim),
    Missing,
    /// The name matches more than one simulation (their ids).
    Ambiguous(Vec<&'a str>),
}

/// `"Simulation 5"`, `"simulation  5"`, `"simulation_5"` → `simulation 5`.
fn sim_name_key(s: &str) -> String {
    s.split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

/// A simulation by id first, then by display name: exact, then ignoring
/// case and separators (spaces, `_`, `-`). A name shared by several sims
/// is ambiguous (the caller asks for the id).
pub(crate) fn find_sim<'a>(sims: &'a BTreeMap<String, EvalSim>, key: &str) -> SimLookup<'a> {
    if let Some(s) = sims.get(key) {
        return SimLookup::Found(s);
    }
    let pick = |hits: Vec<&'a EvalSim>| match hits.as_slice() {
        [] => None,
        [one] => Some(SimLookup::Found(one)),
        many => Some(SimLookup::Ambiguous(
            many.iter().map(|s| s.id.as_str()).collect(),
        )),
    };
    if let Some(r) = pick(sims.values().filter(|s| s.name == key).collect()) {
        return r;
    }
    let k = sim_name_key(key);
    if k.is_empty() {
        return SimLookup::Missing;
    }
    let loose = sims
        .values()
        .filter(|s| sim_name_key(&s.name) == k || sim_name_key(&s.id) == k)
        .collect();
    pick(loose).unwrap_or(SimLookup::Missing)
}

#[cfg(test)]
mod find_sim_tests {
    use std::collections::BTreeMap;

    use super::{SimLookup, find_sim};
    use rw_model::EvalSim;

    fn sims(rows: &[(&str, &str)]) -> BTreeMap<String, EvalSim> {
        rows.iter()
            .map(|(id, name)| {
                let v = serde_json::json!({
                    "id": id, "name": name, "kind": "flight", "config": "c",
                    "conditions": {
                        "rail_length_m": 1.0, "rod_angle_deg": 0.0, "rod_direction_deg": 90.0,
                        "site_altitude_m": 0.0, "latitude_deg": 45.0, "longitude_deg": 0.0,
                        "base_temperature_k": 288.15, "base_pressure_pa": 101325.0,
                        "atmosphere": "ussa1976", "geodetic": "flat", "wind_speed_ms": 0.0,
                        "wind_direction_deg": 90.0, "wind_turbulence": 0.0, "time_step_s": 0.05,
                        "integrator": "rk4"
                    },
                    "series_dt": 0.05, "max_time": 600.0, "rtol": 1e-6, "atol": 1e-6, "seed": 0
                });
                let s: EvalSim = serde_json::from_value(v).expect("EvalSim fixture");
                ((*id).to_string(), s)
            })
            .collect()
    }

    fn id_of(r: SimLookup<'_>) -> Option<String> {
        match r {
            SimLookup::Found(s) => Some(s.id.clone()),
            _ => None,
        }
    }

    #[test]
    fn resolves_ids_and_display_names() {
        let m = sims(&[
            ("simulation_5", "Simulation 5"),
            ("baseline", "Baseline flight"),
        ]);
        assert_eq!(
            id_of(find_sim(&m, "simulation_5")).as_deref(),
            Some("simulation_5")
        );
        assert_eq!(
            id_of(find_sim(&m, "Simulation 5")).as_deref(),
            Some("simulation_5")
        );
        assert_eq!(
            id_of(find_sim(&m, "simulation  5")).as_deref(),
            Some("simulation_5")
        );
        assert_eq!(
            id_of(find_sim(&m, "Baseline flight")).as_deref(),
            Some("baseline")
        );
        assert_eq!(
            id_of(find_sim(&m, "baseline-flight")).as_deref(),
            Some("baseline")
        );
        assert_eq!(find_sim(&m, "nope"), SimLookup::Missing);
        assert_eq!(find_sim(&m, "  "), SimLookup::Missing);
    }

    #[test]
    fn an_id_wins_over_a_name_and_shared_names_are_ambiguous() {
        let m = sims(&[("a", "b"), ("b", "Other"), ("c", "Twin"), ("d", "twin")]);
        assert_eq!(id_of(find_sim(&m, "b")).as_deref(), Some("b"));
        assert_eq!(id_of(find_sim(&m, "Twin")).as_deref(), Some("c"));
        assert_eq!(find_sim(&m, "TWIN"), SimLookup::Ambiguous(vec!["c", "d"]));
    }
}

#[cfg(test)]
mod conditions_diff_tests {
    use super::conditions_diff;

    fn cond(wind: f64, into_wind: Option<bool>) -> rw_model::Conditions {
        let mut v = serde_json::json!({
            "rail_length_m": 1.0, "rod_angle_deg": 0.0, "rod_direction_deg": 90.0,
            "site_altitude_m": 0.0, "latitude_deg": 45.0, "longitude_deg": 0.0,
            "base_temperature_k": 288.15, "base_pressure_pa": 101325.0,
            "atmosphere": "ussa1976", "geodetic": "flat", "wind_speed_ms": wind,
            "wind_direction_deg": 90.0, "wind_turbulence": 0.0, "time_step_s": 0.05,
            "integrator": "rk4"
        });
        if let Some(b) = into_wind {
            v["launch_into_wind"] = serde_json::json!(b);
        }
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn launch_into_wind_false_equals_absent() {
        assert!(conditions_diff(&cond(0.0, Some(false)), &cond(0.0, None)).is_empty());
        assert!(conditions_diff(&cond(0.0, None), &cond(0.0, Some(false))).is_empty());
        let h = |c: &rw_model::Conditions| rw_api::conditions_hash(&super::comparable(c));
        assert_eq!(h(&cond(0.0, Some(false))), h(&cond(0.0, None)));
        assert_ne!(h(&cond(0.0, Some(true))), h(&cond(0.0, None)));
        assert_eq!(
            conditions_diff(&cond(0.0, Some(false)), &cond(0.0, Some(true))),
            vec!["conditions.launch_into_wind: run false vs golden true".to_string()]
        );
    }

    #[test]
    fn lists_each_differing_key() {
        assert!(conditions_diff(&cond(0.0, None), &cond(0.0, None)).is_empty());
        assert_eq!(
            conditions_diff(&cond(2.0, Some(true)), &cond(0.0, None)),
            vec![
                "conditions.launch_into_wind: run true vs golden -".to_string(),
                "conditions.wind_speed_ms: run 2.0 vs golden 0.0".to_string(),
            ]
        );
    }
}
