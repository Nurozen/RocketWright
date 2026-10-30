//! `engine_design` and `engine_simulate` (plan M4.6, `rw engine design|sim`).
//!
//! `engine_design` is a read: the cached design of `engines/<id>.rw.toml`
//! (sizing, injector, feed budget, tanks, blowdown totals) with its missing
//! inputs and diagnostics. `engine_simulate` writes the blowdown of one
//! engine to `runs/engine.<id>/<run-id>/` (`engine.json` with the design and
//! every sample, `series.csv`); it is fast (well under a second), so it
//! answers `Complete` directly instead of queueing a job.

use rw_api::{ApiError, ApiErrorCode, EngineDesignOut, EngineSimulateIn, RunStatus, SimulateOut};
use rw_liquid::DesignOptions;
use serde_json::json;

use super::{Session, err, io_err, with_hint};
use crate::runs::CORE_VERSION;

/// The run directory name of an engine (`runs/engine.<id>/`).
pub fn engine_run_dir(id: &str) -> String {
    format!("engine.{id}")
}

impl Session {
    fn engine_not_found(&self, id: &str) -> ApiError {
        with_hint(
            err(ApiErrorCode::NotFound, format!("no engine `{id}`")),
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
    }

    pub(super) fn engine_design(&self, id: &str) -> Result<EngineDesignOut, ApiError> {
        crate::liquid::design_out(&self.model, id, self.liquid())
            .ok_or_else(|| self.engine_not_found(id))
    }

    pub(super) fn engine_simulate(
        &mut self,
        i: &EngineSimulateIn,
    ) -> Result<SimulateOut, ApiError> {
        let e = self
            .model
            .engines
            .get(&i.engine)
            .cloned()
            .ok_or_else(|| self.engine_not_found(&i.engine))?;
        let t_max = match &i.duration {
            Some(q) => match q.literal() {
                Ok(Some(v)) if v.value > 0.0 => v.value,
                _ => {
                    return Err(with_hint(
                        err(
                            ApiErrorCode::InvalidInput,
                            "`duration` must be a positive time",
                        ),
                        "e.g. \"10 s\"",
                    ));
                }
            },
            None => DesignOptions::default().t_max,
        };
        let opts = DesignOptions {
            t_max,
            ..DesignOptions::default()
        };
        let r = crate::liquid::design_one(&e, &opts);
        let Some(b) = &r.blowdown else {
            let mut a = with_hint(
                err(
                    ApiErrorCode::Conflict,
                    format!("engine `{}` cannot be simulated yet", e.id),
                ),
                "fix the missing inputs and design errors that `engine_design` lists",
            );
            a.diagnostics = r.diagnostics.clone();
            return Err(a);
        };
        let key = json!({
            "engine": crate::liquid::engine_hash(&e),
            "t_max": t_max,
            "core_version": CORE_VERSION,
        });
        let canon = rw_api::oracle::canonical_json(&key);
        let run_id = blake3::hash(canon.as_bytes()).to_hex()[..12].to_string();
        let sim = engine_run_dir(&e.id);
        let dir = self
            .root
            .join(crate::runs::RUNS_DIR)
            .join(&sim)
            .join(&run_id);
        let cached = dir.join("engine.json").is_file();
        if !cached {
            if !self.writable {
                return Err(with_hint(
                    err(ApiErrorCode::Locked, "this session is read-only"),
                    "engine simulations write runs/; run them through the project's owner",
                ));
            }
            let doc = json!({
                "engine": e.id,
                "run_id": run_id,
                "provenance": "engineering",
                "core_version": CORE_VERSION,
                "design": r.design,
                "blowdown": b,
            });
            let mut text = serde_json::to_string_pretty(&doc)
                .map_err(|x| err(ApiErrorCode::Internal, x.to_string()))?;
            text.push('\n');
            std::fs::create_dir_all(&dir).map_err(|x| io_err("engine run", x))?;
            std::fs::write(dir.join("engine.json"), text).map_err(|x| io_err("engine run", x))?;
            std::fs::write(dir.join("series.csv"), crate::liquid::series_csv(b))
                .map_err(|x| io_err("engine run", x))?;
        }
        Ok(SimulateOut {
            sim,
            run_id,
            status: RunStatus::Complete,
            cached,
            job_id: None,
            summary: None,
        })
    }
}
