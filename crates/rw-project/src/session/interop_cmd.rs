//! `import_file` and `export_file` on a session (M2.5, M2.6). The bodies
//! live in [`crate::interop`]; this applies them through the mutation
//! pipeline (one history step per import) and writes exports.

use std::collections::BTreeMap;
use std::path::Path;

use rw_api::{
    ApiError, ApiErrorCode, CallCtx, ExportFileIn, ExportFormat, ExportOut, ImportFileIn,
    ImportKind, ImportOut,
};

use super::{Session, err, io_err, lib_hash_map, patch_error, with_hint};
use crate::interop::{self, DirCache, Plan};
use crate::layout::{self, sha256_hex};
use crate::library::{Library, manifest_lib};
use crate::{fsutil, runs};

impl Session {
    fn disk_lib(&self) -> Result<BTreeMap<String, Vec<u8>>, ApiError> {
        Ok(layout::read_project(&self.root)
            .map_err(|e| io_err("reading the project", e))?
            .lib)
    }

    pub(super) fn import_file(
        &mut self,
        i: &ImportFileIn,
        ctx: &CallCtx,
    ) -> Result<ImportOut, ApiError> {
        if i.kind == ImportKind::Motor {
            return self.import_motor(Path::new(&i.path), i.dry_run, ctx);
        }
        let (abs, bytes) = interop::read_input(&self.root, &i.path)?;
        let name = abs
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| i.path.clone());
        let disk = self.disk_lib()?;
        let plan = interop::plan_ork(
            &bytes,
            &name,
            self.store.sources(),
            &disk,
            &DirCache::for_project(&self.root),
        )?;
        self.apply_plan(plan, disk, i.dry_run, ctx)
    }

    /// Applies an import plan as one mutation: library files first (not on
    /// a dry run), then the sources.
    pub(crate) fn apply_plan(
        &mut self,
        plan: Plan,
        disk: BTreeMap<String, Vec<u8>>,
        dry_run: bool,
        ctx: &CallCtx,
    ) -> Result<ImportOut, ApiError> {
        let Plan {
            target,
            lib_files,
            imported,
            diagnostics,
            title,
        } = plan;
        let (next, changes) = self.store.preview_target(target).map_err(patch_error)?;
        let writes: Vec<(String, Option<String>)> =
            changes.into_iter().map(|c| (c.path, c.text)).collect();
        let mut lib = disk;
        lib.extend(lib_files.iter().map(|(p, b)| (p.clone(), b.clone())));
        let new_library = Library::load(&lib, manifest_lib(next.sources()));
        if !dry_run {
            self.require_writable()?;
            for (p, b) in &lib_files {
                fsutil::write_atomic(&self.root.join(p), b).map_err(|e| io_err(p, e))?;
            }
        }
        let old_library = std::mem::replace(&mut self.library, new_library);
        let old_hashes = std::mem::replace(&mut self.lib_hashes, lib_hash_map(&lib));
        let tool = Some("import_file");
        let out = self.commit(next, writes, dry_run, ctx, tool, title);
        if dry_run || out.is_err() {
            self.library = old_library;
            self.lib_hashes = old_hashes;
        }
        Ok(ImportOut {
            mutation: out?,
            imported,
            diagnostics,
        })
    }

    pub(super) fn export_file(&mut self, i: &ExportFileIn) -> Result<ExportOut, ApiError> {
        let (model, _) = self.evaluated(i.config.as_deref())?;
        let bytes = match i.format {
            ExportFormat::Ork => {
                let disk = self.disk_lib()?;
                interop::ork(&model, self.store.sources(), &self.library, &disk).0
            }
            ExportFormat::Rasp => {
                let cfg = model
                    .config
                    .as_deref()
                    .and_then(|c| model.configs.get(c))
                    .ok_or_else(|| {
                        with_hint(
                            err(ApiErrorCode::InvalidInput, "the model has no configuration"),
                            "add a configuration with motors, or pass config",
                        )
                    })?;
                let mut curves = Vec::new();
                for m in &cfg.motors {
                    if let Some(c) = m.motor.as_deref().and_then(|r| self.library.motor(r))
                        && !curves
                            .iter()
                            .any(|x: &rw_motor::ThrustCurve| x.sha256 == c.sha256)
                    {
                        curves.push(c);
                    }
                }
                if curves.is_empty() {
                    return Err(with_hint(
                        err(
                            ApiErrorCode::InvalidInput,
                            format!("configuration `{}` has no resolved motors", cfg.id),
                        ),
                        "assign a motor (motor_search), or pass another config",
                    ));
                }
                interop::rasp(&curves).into_bytes()
            }
            ExportFormat::Glb => {
                rw_geom::mesh_glb(&rw_geom::build(&model), &rw_geom::MeshOptions::default())
            }
            ExportFormat::Stl => interop::stl(&rw_geom::build(&model), 64),
            ExportFormat::Csv => {
                let r = i.run.as_deref().ok_or_else(|| {
                    with_hint(
                        err(ApiErrorCode::InvalidInput, "csv export needs a run"),
                        "pass run: <run-id> or a sim id (its latest run); see run_list",
                    )
                })?;
                let m = self.runs.find(r).ok_or_else(|| {
                    with_hint(
                        err(ApiErrorCode::NotFound, format!("no run `{r}`")),
                        "see run_list",
                    )
                })?;
                let p = self.runs.dir(&m.sim, &m.run_id).join(runs::SERIES_FILE);
                std::fs::read(&p).map_err(|e| io_err(runs::SERIES_FILE, e))?
            }
        };
        let path = Path::new(&i.path);
        let abs = match layout::resolve_inside(&self.root, path) {
            Some(abs) => abs,
            None if i.allow_outside => {
                if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    self.root.join(path)
                }
            }
            None => {
                return Err(with_hint(
                    err(
                        ApiErrorCode::InvalidInput,
                        format!("`{}` is outside the project; nothing written", i.path),
                    ),
                    "export inside the project (e.g. exports/rocket.glb), or pass allow_outside: true (rw export --allow-outside), which needs the user's approval",
                ));
            }
        };
        fsutil::write_atomic(&abs, &bytes).map_err(|e| io_err(&i.path, e))?;
        let shown = layout::rel_path(&self.root, &abs).unwrap_or_else(|| abs.display().to_string());
        Ok(ExportOut {
            path: shown,
            bytes: bytes.len() as u64,
            sha256: sha256_hex(&bytes),
        })
    }
}
