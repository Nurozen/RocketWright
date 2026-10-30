//! `simulate` on a visual flow study (plan M5.1, D10c): writes
//! `runs/<study>/<run-id>/{manifest.json,visual.json}` with
//! `provenance = "visual"` (I13). Building the timeline takes milliseconds
//! (the engine design is cached), so it answers `Complete` directly instead
//! of queueing a job.

use rw_api::{ApiError, ApiErrorCode, Provenance, RunManifest, RunStatus, SimulateOut};
use rw_model::{AttitudeSource, EvalSim, SchemaTag};
use serde_json::json;

use super::{Session, err, io_err, with_hint};
use crate::runs::{CORE_VERSION, SERIES_FILE};
use crate::visual::{ReplaySeries, parse_replay_csv, visual_run};

impl Session {
    /// The replayed flight's latest run, for a `run` attitude.
    fn replay_series(&self, sim: &EvalSim) -> Result<Option<ReplaySeries>, ApiError> {
        let Some(v) = &sim.visual_flow else {
            return Ok(None);
        };
        if v.attitude != AttitudeSource::Run {
            return Ok(None);
        }
        let id = v.replay.as_deref().unwrap_or_default();
        let m = self.runs.latest(id).ok_or_else(|| {
            with_hint(
                err(
                    ApiErrorCode::Conflict,
                    format!("study `{}` replays `{id}`, which has not flown yet", sim.id),
                ),
                format!("fly it first: `rw sim {id}`"),
            )
        })?;
        let path = self.runs.dir(&m.sim, &m.run_id).join(SERIES_FILE);
        let csv = std::fs::read_to_string(&path).map_err(|e| io_err("replay series", e))?;
        parse_replay_csv(
            &csv,
            &format!("{}/{}", m.sim, m.run_id),
            m.conditions.rod_angle_deg,
            m.conditions.rail_length_m,
        )
        .map(Some)
        .map_err(|e| {
            err(
                ApiErrorCode::Internal,
                format!("replay of {}/{}: {e}", m.sim, m.run_id),
            )
        })
    }

    pub(super) fn visual_simulate(
        &mut self,
        sim: &EvalSim,
        force: bool,
        thread: Option<&str>,
    ) -> Result<SimulateOut, ApiError> {
        let v = sim.visual_flow.as_ref().ok_or_else(|| {
            with_hint(
                err(
                    ApiErrorCode::InvalidInput,
                    format!(
                        "visual flow study `{}` has no `[visual_flow]` table",
                        sim.id
                    ),
                ),
                "add `[visual_flow]` with `engine` and `attitude`; `rw check` lists RW-E068",
            )
        })?;
        let engine = self.model.engines.get(&v.engine).cloned().ok_or_else(|| {
            with_hint(
                err(ApiErrorCode::NotFound, format!("no engine `{}`", v.engine)),
                format!(
                    "engines: {}",
                    self.model
                        .engines
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            )
        })?;
        let replay = self.replay_series(sim)?;
        let key = json!({
            "kind": "visual_flow",
            "model_hash": self.model.model_hash,
            "sim": sim,
            "engine": crate::liquid::engine_hash(&engine),
            "replay": replay.as_ref().map(|r| r.run.clone()),
            "core_version": CORE_VERSION,
        });
        let canon = rw_api::oracle::canonical_json(&key);
        let run_id = blake3::hash(canon.as_bytes()).to_hex()[..12].to_string();
        let out = |cached: bool| SimulateOut {
            sim: sim.id.clone(),
            run_id: run_id.clone(),
            status: RunStatus::Complete,
            cached,
            job_id: None,
            summary: None,
        };
        if !force && self.runs.has_visual(&sim.id, &run_id) {
            return Ok(out(true));
        }
        if !self.writable {
            return Err(with_hint(
                err(ApiErrorCode::Locked, "this session is read-only"),
                "studies write runs/; run them through the project's owner",
            ));
        }
        let design = self.liquid().get(&engine);
        let visual = visual_run(sim, &engine, &design, &run_id, replay.as_ref()).map_err(|m| {
            let mut a = with_hint(
                err(ApiErrorCode::Conflict, format!("study `{}`: {m}", sim.id)),
                "fix the engine's missing inputs (`engine_design` lists them)",
            );
            a.diagnostics = design.diagnostics.clone();
            a
        })?;
        let step = self
            .history
            .as_ref()
            .and_then(|h| h.steps().ok())
            .and_then(|s| s.last().map(|s| s.seq));
        let manifest = RunManifest {
            schema: SchemaTag,
            run_id: run_id.clone(),
            sim: sim.id.clone(),
            sim_name: sim.name.clone(),
            kind: sim.kind,
            config: sim.config.clone(),
            model_hash: self.model.model_hash.clone(),
            provenance: Provenance::Visual,
            conditions: sim.conditions.clone(),
            conditions_hash: rw_api::conditions_hash(&sim.conditions),
            motors: Vec::new(),
            inputs: self.inputs(&self.known),
            core_version: CORE_VERSION.to_string(),
            seed: sim.seed,
            rtol: sim.rtol,
            atol: sim.atol,
            step,
            rev: None,
            thread: thread.map(String::from),
            started: Some(crate::clock::now().1),
            wall_time_s: None,
        };
        self.runs
            .write_visual(&manifest, &visual)
            .map_err(|e| io_err("visual run", e))?;
        Ok(out(false))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rw_api::{CallCtx, Command, Origin, Response, RunListIn, RunStatus, SimulateIn, VisualRun};

    use crate::session::{Session, SessionOptions};
    use crate::testutil::TempDir;

    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap().flatten() {
            let (src, dst) = (e.path(), to.join(e.file_name()));
            if src.is_dir() {
                copy(&src, &dst);
            } else {
                std::fs::copy(&src, &dst).unwrap();
            }
        }
    }

    fn research_vehicle(tag: &str) -> TempDir {
        let d = TempDir::new(tag);
        copy(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/research-vehicle"),
            d.path(),
        );
        d
    }

    fn ctx() -> CallCtx {
        CallCtx {
            origin: Origin::Cli,
            thread: None,
            tool_call: None,
            label: None,
        }
    }

    fn simulate(s: &mut Session, sim: &str) -> Result<rw_api::SimulateOut, rw_api::ApiError> {
        let cmd = Command::Simulate(SimulateIn {
            sim: sim.into(),
            config: None,
            force: false,
            mc: None,
        });
        s.execute(&cmd, &ctx()).map(|r| match r {
            Response::Simulate(o) => o,
            _ => unreachable!(),
        })
    }

    fn run_list(s: &mut Session, sim: Option<&str>) -> rw_api::RunListOut {
        let cmd = Command::RunList(RunListIn {
            sim: sim.map(String::from),
        });
        match s.execute(&cmd, &ctx()).unwrap() {
            Response::RunList(o) => o,
            _ => unreachable!(),
        }
    }

    #[test]
    fn a_study_writes_a_visual_run_that_drains_with_the_blowdown() {
        let d = research_vehicle("visual-study");
        let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
        let out = simulate(&mut s, "study_01").unwrap();
        assert_eq!(out.status, RunStatus::Complete);
        assert!(!out.cached && out.job_id.is_none() && out.summary.is_none());
        let dir = d.path().join("runs/study_01").join(&out.run_id);
        let m: rw_api::RunManifest =
            serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(m.provenance, rw_api::Provenance::Visual);
        assert_eq!(m.kind, rw_model::SimKind::VisualFlow);
        assert!(m.motors.is_empty());
        let v: VisualRun =
            serde_json::from_str(&std::fs::read_to_string(dir.join("visual.json")).unwrap())
                .unwrap();
        assert_eq!(v.provenance, rw_api::Provenance::Visual);
        assert_eq!(
            (v.engine.as_str(), v.tank.node.as_str()),
            ("demo", "tank_a")
        );
        assert_eq!(v.samples.len(), 201, "10 s at 0.05 s");
        let first = &v.samples[0];
        assert!((first.fill_fraction - 0.6).abs() < 1e-6, "{first:?}");
        assert_eq!((first.relative_fill, first.relative_flow), (1.0, 1.0));
        assert!((first.tilt_deg - 50.0).abs() < 1e-9);
        // The fill falls monotonically and the tank is empty after the burn.
        assert!(
            v.samples
                .windows(2)
                .all(|w| w[1].relative_fill <= w[0].relative_fill)
        );
        let last = v.samples.last().unwrap();
        assert!(v.burn_time > 5.0 && v.burn_time < 10.0, "{}", v.burn_time);
        assert_eq!((last.relative_fill, last.relative_flow), (0.0, 0.0));
        // Cached on a second call; a flight list leaves the study out.
        assert!(simulate(&mut s, "study_01").unwrap().cached);
        let all = run_list(&mut s, None);
        assert!(
            all.runs.iter().all(|r| r.kind == rw_model::SimKind::Flight),
            "{all:?}"
        );
        let one = run_list(&mut s, Some("study_01"));
        assert_eq!(one.runs.len(), 1);
        assert_eq!(one.runs[0].status, RunStatus::Complete);
        assert_eq!(one.runs[0].provenance, Some(rw_api::Provenance::Visual));
    }

    #[test]
    fn a_replay_needs_its_flight_and_follows_it() {
        let d = research_vehicle("visual-replay");
        let path = d.path().join("sims/flow_overview.rw.toml");
        std::fs::write(
            &path,
            "name = \"Flow overview\"\nkind = \"visual_flow\"\nconfig = \"baseline\"\n[visual_flow]\nengine = \"demo\"\nattitude = \"run\"\nreplay = \"baseline\"\nduration = \"2 s\"\n",
        )
        .unwrap();
        let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
        let e = simulate(&mut s, "flow_overview").unwrap_err();
        assert!(e.message.contains("has not flown yet"), "{e:?}");
        let fl = simulate(&mut s, "baseline").unwrap();
        assert!(
            crate::testutil::wait_until(60_000, || {
                run_list(&mut s, Some("baseline")).runs[0].status == RunStatus::Complete
            }),
            "{fl:?}"
        );
        let out = simulate(&mut s, "flow_overview").unwrap();
        let v: VisualRun = serde_json::from_str(
            &std::fs::read_to_string(
                d.path()
                    .join("runs/flow_overview")
                    .join(&out.run_id)
                    .join("visual.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(
            v.replay_run
                .as_deref()
                .is_some_and(|r| r.starts_with("baseline/"))
        );
        // On the pad: the rod angle, and thrust pushes the liquid aft (-X specific force above g).
        assert!(
            (v.samples[0].tilt_deg - 5.0).abs() < 1e-6,
            "{:?}",
            v.samples[0]
        );
        assert!(v.samples[0].specific_force[0] < -9.0, "{:?}", v.samples[0]);
    }
}
