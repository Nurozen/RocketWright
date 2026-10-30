//! `RunStore` (M1.28, R2.9): `runs/<sim>/<run-id>/` with `manifest.json`,
//! `summary.json`, `events.json`, and `series.csv`.
//!
//! - `run_id` is the first 12 hex of blake3 over the JCS-canonical
//!   [`RunKey`] (model hash, config, sim, motor digests, engine hash,
//!   core version, seed, integrator), so the same inputs always land in the
//!   same directory and a second request is a cache hit (I7).
//! - A run directory appears atomically: the files are written into a
//!   hidden temp directory beside it, which is then renamed into place.
//! - `summary.json` and `events.json` are key-sorted with fixed significant
//!   figures and no timestamps (I8); `manifest.json` is the only file with
//!   wall-clock fields, and they are not part of the key.
//! - Status is computed from the manifest's `model_hash` against the current
//!   model ([`status_of`]), never stored.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rw_api::{RunManifest, RunStatus};
use rw_model::{EvalConfig, EvalSim, IntegratorKind};
use rw_sim::{FlightEvent, RunEvents, RunSummary, Series, SimResult};
use serde::Serialize;

/// Project-relative runs directory.
pub const RUNS_DIR: &str = "runs";
pub const MANIFEST_FILE: &str = "manifest.json";
pub const SUMMARY_FILE: &str = "summary.json";
pub const EVENTS_FILE: &str = "events.json";
pub const SERIES_FILE: &str = "series.csv";
/// Per-stage branches of a multi-stage run: `branches/<stage>/` with
/// `events.json` and `series.csv` (R4.5).
pub const BRANCHES_DIR: &str = "branches";

/// Significant figures of `series.csv` values.
pub const SERIES_SIG_FIGS: usize = 9;

/// Version recorded in manifests and hashed into `run_id`.
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The canonical inputs of one run (hashed into `run_id`).
#[derive(Debug, Clone, Serialize)]
pub struct RunKey<'a> {
    pub model_hash: &'a str,
    pub config: &'a EvalConfig,
    pub sim: &'a EvalSim,
    /// Motor digests (sha256 of each curve file), in mount order.
    pub motors: Vec<&'a str>,
    /// Liquid engine hash (M4); absent for solid motors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<&'a str>,
    pub core_version: &'a str,
    pub seed: u64,
    pub integrator: IntegratorKind,
}

impl RunKey<'_> {
    /// First 12 hex of blake3 over the JCS form of the key.
    pub fn run_id(&self) -> String {
        let v = serde_json::to_value(self).unwrap_or(serde_json::Value::Null);
        let canon = rw_api::oracle::canonical_json(&v);
        blake3::hash(canon.as_bytes()).to_hex()[..12].to_string()
    }
}

/// Run status from the manifest: `Complete` when it was computed from the
/// current model, otherwise `Outdated` (I7).
pub fn status_of(manifest: &RunManifest, current_model_hash: &str) -> RunStatus {
    if manifest.model_hash == current_model_hash {
        RunStatus::Complete
    } else {
        RunStatus::Outdated
    }
}

/// `summary.json`: key-sorted, fixed significant figures, trailing newline.
pub fn summary_json(s: &RunSummary) -> String {
    rw_check::canonical_json(s)
}

/// `events.json`.
pub fn events_json(events: &[FlightEvent]) -> String {
    rw_check::canonical_json(&RunEvents {
        schema: rw_model::SchemaTag,
        events: events.to_vec(),
    })
}

/// `series.csv`: a header of column names (`t` first), then one row per
/// sample (the fixed grid plus the exact event rows), values at
/// [`SERIES_SIG_FIGS`] significant figures, SI units.
pub fn series_csv(series: &Series) -> String {
    let mut out = String::new();
    let names: Vec<&str> = series.columns.iter().map(|c| c.name.as_str()).collect();
    out.push_str(&names.join(","));
    out.push('\n');
    for row in &series.rows {
        let cells: Vec<String> = row
            .iter()
            .map(|v| {
                if v.is_finite() {
                    let r = rw_check::canon::round_sig(*v, SERIES_SIG_FIGS);
                    if r == 0.0 { "0".into() } else { format!("{r}") }
                } else {
                    String::new()
                }
            })
            .collect();
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    out
}

/// The rounded summary as stored (what `summary.json` parses back to).
pub fn stored_summary(s: &RunSummary) -> RunSummary {
    rw_check::canon::rounded(s.clone())
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Run directories of one project.
#[derive(Debug, Clone)]
pub struct RunStore {
    root: PathBuf,
}

impl RunStore {
    pub fn new(root: &Path) -> RunStore {
        RunStore {
            root: root.to_path_buf(),
        }
    }

    /// Project-relative directory of a run (`runs/<sim>/<id>`).
    pub fn rel_dir(sim: &str, id: &str) -> String {
        format!("{RUNS_DIR}/{sim}/{id}")
    }

    pub fn dir(&self, sim: &str, id: &str) -> PathBuf {
        self.root.join(RUNS_DIR).join(sim).join(id)
    }

    /// True when the run is on disk (a cache hit).
    pub fn has(&self, sim: &str, id: &str) -> bool {
        let d = self.dir(sim, id);
        d.join(MANIFEST_FILE).is_file() && d.join(SUMMARY_FILE).is_file()
    }

    /// Writes a visual flow study's run (`manifest.json` + `visual.json`)
    /// atomically, like [`RunStore::write`].
    pub fn write_visual(
        &self,
        manifest: &RunManifest,
        visual: &rw_api::VisualRun,
    ) -> std::io::Result<()> {
        let mut v = serde_json::to_string_pretty(visual).map_err(std::io::Error::other)?;
        v.push('\n');
        self.write_files(manifest, &[(crate::visual::VISUAL_FILE, v)])
    }

    /// A visual flow study's run on disk: its manifest and `visual.json`.
    pub fn has_visual(&self, sim: &str, id: &str) -> bool {
        let d = self.dir(sim, id);
        d.join(MANIFEST_FILE).is_file() && d.join(crate::visual::VISUAL_FILE).is_file()
    }

    /// Writes a run atomically (replacing an earlier run with the same id).
    pub fn write(&self, manifest: &RunManifest, result: &SimResult) -> std::io::Result<()> {
        let mut files = vec![
            (SUMMARY_FILE, summary_json(&result.summary)),
            (EVENTS_FILE, events_json(&result.events)),
            (SERIES_FILE, series_csv(&result.series)),
        ];
        let branch_files: Vec<(String, String)> = result
            .branches
            .iter()
            .flat_map(|b| {
                let d = format!("{BRANCHES_DIR}/{}", b.stage);
                [
                    (format!("{d}/{EVENTS_FILE}"), events_json(&b.events)),
                    (format!("{d}/{SERIES_FILE}"), series_csv(&b.series)),
                ]
            })
            .collect();
        files.extend(branch_files.iter().map(|(p, t)| (p.as_str(), t.clone())));
        self.write_files(manifest, &files)
    }

    /// Writes `manifest.json` and `files` (paths relative to the run dir)
    /// into a temp dir, then swaps it in for the run.
    fn write_files(&self, manifest: &RunManifest, files: &[(&str, String)]) -> std::io::Result<()> {
        let sim_dir = self.root.join(RUNS_DIR).join(&manifest.sim);
        std::fs::create_dir_all(&sim_dir)?;
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = sim_dir.join(format!(
            ".{}.rw-tmp-{}-{seq}",
            manifest.run_id,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        let written = (|| {
            std::fs::create_dir_all(&tmp)?;
            let mut m = serde_json::to_string_pretty(manifest).map_err(std::io::Error::other)?;
            m.push('\n');
            std::fs::write(tmp.join(MANIFEST_FILE), m)?;
            for (rel, text) in files {
                let path = tmp.join(rel);
                if let Some(d) = path.parent() {
                    std::fs::create_dir_all(d)?;
                }
                std::fs::write(path, text)?;
            }
            let dest = sim_dir.join(&manifest.run_id);
            if dest.exists() {
                let old = sim_dir.join(format!(
                    ".{}.rw-old-{}-{seq}",
                    manifest.run_id,
                    std::process::id()
                ));
                std::fs::rename(&dest, &old)?;
                std::fs::rename(&tmp, &dest)?;
                let _ = std::fs::remove_dir_all(&old);
            } else {
                std::fs::rename(&tmp, &dest)?;
            }
            Ok(())
        })();
        if written.is_err() {
            let _ = std::fs::remove_dir_all(&tmp);
        }
        written
    }

    pub fn manifest(&self, sim: &str, id: &str) -> std::io::Result<RunManifest> {
        let text = std::fs::read_to_string(self.dir(sim, id).join(MANIFEST_FILE))?;
        serde_json::from_str(&text).map_err(std::io::Error::other)
    }

    pub fn summary(&self, sim: &str, id: &str) -> std::io::Result<RunSummary> {
        let text = std::fs::read_to_string(self.dir(sim, id).join(SUMMARY_FILE))?;
        serde_json::from_str(&text).map_err(std::io::Error::other)
    }

    /// The main flight's events of a run (`events.json`).
    pub fn events(&self, sim: &str, id: &str) -> std::io::Result<Vec<FlightEvent>> {
        let text = std::fs::read_to_string(self.dir(sim, id).join(EVENTS_FILE))?;
        let e: RunEvents = serde_json::from_str(&text).map_err(std::io::Error::other)?;
        Ok(e.events)
    }

    /// Every run on disk with its manifest's modification time, sorted by
    /// sim, then oldest first.
    fn entries(&self) -> Vec<(RunManifest, std::time::SystemTime)> {
        let mut out = Vec::new();
        let Ok(sims) = std::fs::read_dir(self.root.join(RUNS_DIR)) else {
            return out;
        };
        for s in sims.flatten() {
            let name = s.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !s.path().is_dir() {
                continue;
            }
            let Ok(runs) = std::fs::read_dir(s.path()) else {
                continue;
            };
            for r in runs.flatten() {
                let id = r.file_name().to_string_lossy().into_owned();
                if id.starts_with('.') || !(self.has(&name, &id) || self.has_visual(&name, &id)) {
                    continue;
                }
                let Ok(m) = self.manifest(&name, &id) else {
                    continue;
                };
                let mtime = std::fs::metadata(r.path().join(MANIFEST_FILE))
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                out.push((m, mtime));
            }
        }
        out.sort_by(|(a, ta), (b, tb)| {
            (&a.sim, &a.started, ta, &a.run_id).cmp(&(&b.sim, &b.started, tb, &b.run_id))
        });
        out
    }

    /// Every run's manifest (by sim, oldest first).
    pub fn manifests(&self) -> Vec<RunManifest> {
        self.entries().into_iter().map(|(m, _)| m).collect()
    }

    /// The newest run of `sim`.
    pub fn latest(&self, sim: &str) -> Option<RunManifest> {
        self.entries()
            .into_iter()
            .filter(|(m, _)| m.sim == sim)
            .map(|(m, _)| m)
            .next_back()
    }

    /// Resolves a run ref: `rw:run/<id>`, `<sim>/<id>`, `runs/<sim>/<id>`,
    /// a bare run id (or unique prefix of one), or a sim id (its latest run).
    pub fn find(&self, r: &str) -> Option<RunManifest> {
        let r = r.trim().trim_end_matches('/');
        let r = r.strip_prefix("rw:run/").unwrap_or(r);
        let r = r.strip_prefix("./").unwrap_or(r);
        let r = r.strip_prefix("runs/").unwrap_or(r);
        if r.is_empty() {
            return None;
        }
        if let Some((sim, id)) = r.split_once('/') {
            return self.manifest(sim, id).ok();
        }
        let all = self.manifests();
        let exact: Vec<&RunManifest> = all.iter().filter(|m| m.run_id == r).collect();
        if let Some(m) = exact.last() {
            return Some((*m).clone());
        }
        let prefixed: Vec<&RunManifest> = all.iter().filter(|m| m.run_id.starts_with(r)).collect();
        if prefixed.len() == 1 {
            return Some(prefixed[0].clone());
        }
        self.latest(r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn sim_json() -> EvalSim {
        serde_json::from_value(serde_json::json!({
            "id": "s1", "name": "S1", "kind": "flight", "config": "c1",
            "conditions": {
                "rail_length_m": 1.0, "rod_angle_deg": 0.0, "rod_direction_deg": 90.0,
                "site_altitude_m": 0.0, "latitude_deg": 45.0, "longitude_deg": 0.0,
                "base_temperature_k": 288.15, "base_pressure_pa": 101325.0,
                "atmosphere": "ussa1976", "geodetic": "flat", "wind_speed_ms": 0.0,
                "wind_direction_deg": 90.0, "wind_turbulence": 0.0, "time_step_s": 0.05,
                "integrator": "rk4"
            },
            "series_dt": 0.01, "max_time": 300.0, "rtol": 1e-6, "atol": 1e-9, "seed": 0
        }))
        .unwrap()
    }

    fn config_json() -> EvalConfig {
        serde_json::from_value(serde_json::json!({
            "id": "c1", "name": "C1",
            "motors": [{"mount": "mmt", "motor": "generic:RW_C6G", "delay": 7.0,
                "ignition": "launch", "ignition_delay": 0.0}],
            "stages": [], "deployments": []
        }))
        .unwrap()
    }

    #[test]
    fn run_id_is_a_stable_content_hash() {
        let (sim, cfg) = (sim_json(), config_json());
        let key = |hash: &'static str, seed: u64| RunKey {
            model_hash: hash,
            config: &cfg,
            sim: &sim,
            motors: vec!["ab"],
            engine: None,
            core_version: CORE_VERSION,
            seed,
            integrator: IntegratorKind::Rk4,
        };
        let a = key("h1", 0).run_id();
        assert_eq!(a.len(), 12);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a, key("h1", 0).run_id(), "deterministic");
        assert_ne!(a, key("h2", 0).run_id(), "model hash is an input");
        assert_ne!(a, key("h1", 1).run_id(), "seed is an input");
    }

    #[test]
    fn series_csv_has_t_first_and_fixed_figures() {
        let s = Series {
            dt: 0.01,
            columns: rw_sim::SERIES_COLUMNS
                .iter()
                .take(2)
                .map(|&(n, d)| rw_sim::SeriesColumn {
                    name: n.into(),
                    dim: d,
                })
                .collect(),
            rows: vec![vec![0.0, 0.0], vec![0.01, 1.0 / 3.0], vec![0.015, f64::NAN]],
        };
        assert_eq!(
            series_csv(&s),
            "t,altitude\n0,0\n0.01,0.333333333\n0.015,\n"
        );
    }

    #[test]
    fn find_resolves_refs() {
        let dir = TempDir::new("runs-find");
        let store = RunStore::new(dir.path());
        assert!(store.find("abc").is_none());
        let d = store.dir("s1", "0123456789ab");
        std::fs::create_dir_all(&d).unwrap();
        let m: RunManifest = serde_json::from_value(
            serde_json::from_str::<serde_json::Value>(include_str!(
                "../../../fixtures/contracts/run-manifest.json"
            ))
            .unwrap()["payload"]
                .clone(),
        )
        .unwrap();
        let mut m = m;
        m.sim = "s1".into();
        m.run_id = "0123456789ab".into();
        std::fs::write(d.join(MANIFEST_FILE), serde_json::to_string(&m).unwrap()).unwrap();
        std::fs::write(d.join(SUMMARY_FILE), "{}").unwrap();
        for r in [
            "0123456789ab",
            "0123",
            "rw:run/0123456789ab",
            "s1/0123456789ab",
            "runs/s1/0123456789ab",
            "s1",
        ] {
            assert_eq!(
                store.find(r).map(|m| m.run_id),
                Some("0123456789ab".into()),
                "{r}"
            );
        }
        assert_eq!(status_of(&m, &m.model_hash.clone()), RunStatus::Complete);
        assert_eq!(status_of(&m, "other"), RunStatus::Outdated);
    }

    #[test]
    fn write_puts_each_branch_under_branches_stage() {
        let dir = TempDir::new("runs-branches");
        let store = RunStore::new(dir.path());
        let mut m: RunManifest = serde_json::from_value(
            serde_json::from_str::<serde_json::Value>(include_str!(
                "../../../fixtures/contracts/run-manifest.json"
            ))
            .unwrap()["payload"]
                .clone(),
        )
        .unwrap();
        m.sim = "s1".into();
        m.run_id = "0123456789ab".into();
        let series = Series {
            dt: 0.01,
            columns: rw_sim::SERIES_COLUMNS
                .iter()
                .take(2)
                .map(|&(n, d)| rw_sim::SeriesColumn {
                    name: n.into(),
                    dim: d,
                })
                .collect(),
            rows: vec![vec![1.5, 40.0], vec![1.51, 40.2]],
        };
        let ev = |kind, branch: Option<&str>| FlightEvent {
            t: 1.5,
            kind,
            altitude: 40.0,
            velocity: 30.0,
            source: None,
            branch: branch.map(str::to_string),
        };
        let result: SimResult = SimResult {
            schema: rw_model::SchemaTag,
            summary: serde_json::from_value(
                serde_json::from_str::<serde_json::Value>(include_str!(
                    "../../../fixtures/contracts/run-summary.json"
                ))
                .unwrap()["payload"]
                    .clone(),
            )
            .unwrap(),
            events: vec![ev(rw_sim::EventKind::StageSeparation, None)],
            series: series.clone(),
            branches: vec![rw_sim::Branch {
                stage: "booster".into(),
                events: vec![ev(rw_sim::EventKind::StageSeparation, Some("booster"))],
                series,
            }],
            diagnostics: Vec::new(),
        };
        store.write(&m, &result).unwrap();
        let b = store
            .dir("s1", "0123456789ab")
            .join(BRANCHES_DIR)
            .join("booster");
        let events = std::fs::read_to_string(b.join(EVENTS_FILE)).unwrap();
        assert!(events.contains("\"branch\": \"booster\""), "{events}");
        assert_eq!(
            std::fs::read_to_string(b.join(SERIES_FILE)).unwrap(),
            "t,altitude\n1.5,40\n1.51,40.2\n"
        );
        let main =
            std::fs::read_to_string(store.dir("s1", "0123456789ab").join(EVENTS_FILE)).unwrap();
        assert!(!main.contains("branch"), "{main}");
    }

    // ---- through the Session (simulate → job → run store) -------------------

    use crate::session::{Session, SessionOptions};
    use rw_api::{CallCtx, Command, Origin, Response, SimulateIn};
    use rw_model::PatchOp;
    use std::path::PathBuf;
    use std::time::Duration;

    fn case1(dest: &Path) {
        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/case1");
        fn copy(from: &Path, to: &Path) {
            std::fs::create_dir_all(to).unwrap();
            for e in std::fs::read_dir(from).unwrap().flatten() {
                let d = to.join(e.file_name());
                if e.path().is_dir() {
                    copy(&e.path(), &d);
                } else {
                    std::fs::copy(e.path(), &d).unwrap();
                }
            }
        }
        copy(&src, dest);
    }

    fn ctx() -> CallCtx {
        CallCtx {
            origin: Origin::Cli,
            thread: None,
            tool_call: None,
            label: None,
        }
    }

    fn simulate(s: &mut Session, force: bool) -> rw_api::SimulateOut {
        let cmd = Command::Simulate(SimulateIn {
            sim: "simulation_5".into(),
            config: None,
            force,
            mc: None,
        });
        match s.execute(&cmd, &ctx()).unwrap() {
            Response::Simulate(o) => o,
            _ => unreachable!(),
        }
    }

    #[test]
    fn session_runs_cache_hit_outdated_and_byte_stable() {
        let d = TempDir::new("runs-session");
        case1(d.path());
        let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
        let first = simulate(&mut s, false);
        assert!(!first.cached);
        assert_eq!(first.status, RunStatus::Running);
        let job = s
            .jobs()
            .wait(first.job_id.as_deref().unwrap(), Duration::from_secs(120))
            .unwrap();
        assert_eq!(job.state, rw_api::JobState::Complete, "{:?}", job.error);
        let dir = s.runs().dir("simulation_5", &first.run_id);
        for f in [MANIFEST_FILE, SUMMARY_FILE, EVENTS_FILE, SERIES_FILE] {
            assert!(dir.join(f).is_file(), "{f}");
        }
        let csv = std::fs::read_to_string(dir.join(SERIES_FILE)).unwrap();
        assert!(csv.starts_with("t,altitude,"));
        // 0.01 s grid: the second and third rows are 0.01 s apart (or an event row).
        let summary1 = std::fs::read(dir.join(SUMMARY_FILE)).unwrap();
        let m = s.runs().manifest("simulation_5", &first.run_id).unwrap();
        assert_eq!(m.provenance, rw_api::Provenance::Engineering);
        assert_eq!(m.model_hash, s.model().model_hash);

        // Same inputs: a cache hit with the stored summary, no job.
        let hit = simulate(&mut s, false);
        assert!(hit.cached && hit.job_id.is_none());
        assert_eq!(hit.run_id, first.run_id);
        assert_eq!(hit.status, RunStatus::Complete);
        assert_eq!(hit.summary.as_ref(), job.summary.as_ref());

        // Forced: same run id, same bytes (summary.json is byte-stable).
        let forced = simulate(&mut s, true);
        let j2 = s
            .jobs()
            .wait(forced.job_id.as_deref().unwrap(), Duration::from_secs(120))
            .unwrap();
        assert_eq!(j2.state, rw_api::JobState::Complete);
        assert_eq!(forced.run_id, first.run_id);
        assert_eq!(std::fs::read(dir.join(SUMMARY_FILE)).unwrap(), summary1);

        let list = match s
            .execute(&Command::RunList(rw_api::RunListIn::default()), &ctx())
            .unwrap()
        {
            Response::RunList(l) => l,
            _ => unreachable!(),
        };
        assert_eq!(list.runs.len(), 1);
        assert_eq!(list.runs[0].status, RunStatus::Complete);

        // An edit changes the model hash: the run is Outdated, and the next
        // request gets a new run id.
        let op = PatchOp::Replace {
            path: "/c/fins/span".into(),
            value: serde_json::json!("31 mm"),
        };
        s.patch(&[op], false, &ctx(), "model_patch", "Span".into())
            .unwrap();
        let v = s.read_resource(crate::session::URI_RUNS).unwrap();
        assert_eq!(v["runs"][0]["status"], "outdated");
        let next = simulate(&mut s, false);
        assert_ne!(next.run_id, first.run_id);
        assert!(!next.cached);
        let j3 = s
            .jobs()
            .wait(next.job_id.as_deref().unwrap(), Duration::from_secs(120))
            .unwrap();
        assert_eq!(j3.state, rw_api::JobState::Complete);
        let v = s.read_resource(crate::session::URI_RUNS).unwrap();
        assert_eq!(v["runs"][0]["status"], "complete");
        assert_eq!(v["runs"][0]["run_id"], next.run_id.as_str());
        assert!(v["runs"][0].get("superseded_by").is_none());
        // The run it replaced stays listed beside it, Outdated, for before/after.
        assert_eq!(v["runs"].as_array().unwrap().len(), 2);
        assert_eq!(v["runs"][1]["sim"], "simulation_5");
        assert_eq!(v["runs"][1]["run_id"], first.run_id.as_str());
        assert_eq!(v["runs"][1]["status"], "outdated");
        assert_eq!(v["runs"][1]["superseded_by"], next.run_id.as_str());
        assert!(v["runs"][1]["summary"]["apogee_m"].is_number());
        // Both entries carry their manifest's conditions hash; the span edit
        // left the environment alone, so the hashes are equal.
        let h0 = v["runs"][0]["conditions_hash"].as_str().unwrap();
        assert!(h0.starts_with("sha256:"), "{h0}");
        assert_eq!(v["runs"][1]["conditions_hash"].as_str(), Some(h0));
        let sv = s
            .read_resource(&format!("rw://runs/{}/summary", first.run_id))
            .unwrap();
        assert!(sv["apogee_m"].as_f64().unwrap() > 300.0);
    }

    #[test]
    fn session_run_diff_against_the_case1_golden() {
        let d = TempDir::new("runs-golden");
        case1(d.path());
        let mut s = Session::open(d.path(), SessionOptions::writer()).unwrap();
        let out = simulate(&mut s, false);
        s.jobs()
            .wait(out.job_id.as_deref().unwrap(), Duration::from_secs(120))
            .unwrap();
        let golden = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/oracle/case1-generic.json")
            .canonicalize()
            .unwrap();
        let diff = match s
            .execute(
                &Command::RunDiff(rw_api::RunDiffIn {
                    a: out.run_id.clone(),
                    b: None,
                    golden: Some(golden.display().to_string()),
                    tol: Default::default(),
                }),
                &ctx(),
            )
            .unwrap()
        {
            Response::RunDiff(d) => d,
            _ => unreachable!(),
        };
        assert!(diff.mismatches.is_empty(), "{:?}", diff.mismatches);
        for r in &diff.rows {
            if r.tol.is_some() {
                assert_eq!(r.pass, Some(true), "{r:?}");
            }
        }
        let keys: Vec<&str> = diff.rows.iter().map(|r| r.key.as_str()).collect();
        for k in [
            "apogee_m",
            "max_velocity_ms",
            "time_to_apogee_s",
            "mass.cg",
            "aero.cp",
            "stability.liftoff",
        ] {
            assert!(keys.contains(&k), "{k}");
        }
        assert!(diff.pass);
    }
}
