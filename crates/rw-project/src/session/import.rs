//! `import_file` (S:83, plan M2.14): a motor file (`.eng`, `.rse`) is
//! copied byte for byte into `lib/motors/` and its sha256 recorded in
//! `rocketwright.toml [lib.sha256]` in one mutation, so a later edit to the
//! copy is `RW-E006 lib-hash`. A file that is neither dialect is
//! `RW-E008 motor-dialect`. The MCP tool is gated (`always_ask`, I16); the
//! session itself does not ask, the caller's front end does.
//!
//! `import_file` itself (both kinds) is in `interop_cmd.rs`; `kind = "ork"`
//! goes through the OpenRocket importer (M2.5).

use std::path::Path;

use rw_api::{ApiError, ApiErrorCode, CallCtx, FileChange, FileStatus, ImportOut};
use rw_model::PatchOp;

use super::{Session, err, io_err, lib_hash_map, with_hint};
use crate::fsutil;
use crate::layout::{self, sha256_hex};
use crate::library::{Library, manifest_lib, plan_motor_import};

impl Session {
    /// Imports one motor file; `src` is absolute or relative to the project.
    pub fn import_motor(
        &mut self,
        src: &Path,
        dry_run: bool,
        ctx: &CallCtx,
    ) -> Result<ImportOut, ApiError> {
        let src = if src.is_absolute() {
            src.to_path_buf()
        } else {
            self.root.join(src)
        };
        let bytes = std::fs::read(&src).map_err(|e| io_err(&src.display().to_string(), e))?;
        let file_name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let plan = plan_motor_import(&file_name, &bytes).map_err(|d| {
            let mut e = err(ApiErrorCode::InvalidInput, d.message.clone());
            e.hint = d.hint.clone();
            e.diagnostics = vec![*d];
            e
        })?;

        let dest = self.root.join(&plan.path);
        let existing = match std::fs::read(&dest) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(io_err(&plan.path, e)),
        };
        if let Some(b) = &existing
            && sha256_hex(b) != plan.sha256
        {
            return Err(with_hint(
                err(
                    ApiErrorCode::Conflict,
                    format!("`{}` already exists with different content", plan.path),
                ),
                "rename the file before importing it, or remove the existing one (and its [lib.sha256] entry) first",
            ));
        }

        // The manifest with this file's hash, and the library it pins.
        let mut lib = manifest_lib(self.store.sources())
            .cloned()
            .unwrap_or_default();
        lib.sha256.insert(plan.path.clone(), plan.sha256.clone());
        let value =
            serde_json::to_value(&lib).map_err(|e| err(ApiErrorCode::Internal, e.to_string()))?;
        let ops = [PatchOp::Add {
            path: "/project/lib".into(),
            value,
        }];
        let mut disk_lib = layout::read_project(&self.root)
            .map_err(|e| io_err("reading the project", e))?
            .lib;
        disk_lib.insert(plan.path.clone(), bytes.clone());
        let next_library = Library::load(&disk_lib, Some(&lib));
        let title = ctx.label.clone().unwrap_or_else(|| {
            format!(
                "Import motor {}",
                plan.path.rsplit('/').next().unwrap_or(&plan.path)
            )
        });
        let added = existing.is_none().then(|| FileChange {
            path: plan.path.clone(),
            status: FileStatus::A,
        });

        if !dry_run {
            self.require_writable()?;
            if existing.is_none() {
                fsutil::write_atomic(&dest, &bytes).map_err(|e| io_err(&plan.path, e))?;
            }
        }
        let before = std::mem::replace(&mut self.library, next_library);
        let result = self.patch(&ops, dry_run, ctx, "import_file", title);
        match &result {
            Ok(_) if !dry_run => self.lib_hashes = lib_hash_map(&disk_lib),
            _ => {
                self.library = before;
                if !dry_run && existing.is_none() {
                    let _ = fsutil::remove_if_exists(&dest);
                }
            }
        }
        let mut mutation = result?;
        if !dry_run && mutation.files.is_empty() {
            // The manifest already recorded this hash (a restored file): no
            // source write, so evaluate against the new library here.
            self.model = self.evaluate(&self.store, &rw_model::EvalOptions::default());
            self.report = self.check(&self.model, &self.known);
        }
        if let Some(f) = added {
            mutation.files.insert(0, f);
        }
        Ok(ImportOut {
            mutation,
            imported: plan.refs(),
            diagnostics: Vec::new(),
        })
    }
}
