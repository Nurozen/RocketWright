//! `cfd_import` (spec R6.15, plan M5.4): parses one CSV step or a directory
//! of `<prefix>_t<s>.csv` steps ([`crate::cfd`]) and writes the run record
//! `runs/cfd.<id>/<run_id>/{cfd.json,dataset.json}` with `provenance = cfd`.
//! It never touches the model, so the check delta is empty; `dry_run`
//! parses and reports the dataset without writing (I6). The MCP tool is
//! gated (`always_ask`, I16); the session itself does not ask.

use rw_api::{
    ApiError, ApiErrorCode, CallCtx, CfdImportIn, CfdImportOut, FileChange, FileStatus, MutationOut,
};
use rw_check::CheckDelta;

use super::{Session, err, io_err, with_hint};
use crate::cfd::{self, CfdError, CfdRecord, CfdSource};
use crate::runs::{CORE_VERSION, RUNS_DIR};

fn cfd_err(e: CfdError) -> ApiError {
    let mut a = err(ApiErrorCode::InvalidInput, e.to_string());
    a.hint = e.hint;
    a
}

impl Session {
    pub(super) fn cfd_import(
        &mut self,
        i: &CfdImportIn,
        _ctx: &CallCtx,
    ) -> Result<CfdImportOut, ApiError> {
        let given = std::path::Path::new(&i.path);
        let src = if given.is_absolute() {
            given.to_path_buf()
        } else {
            self.root.join(given)
        };
        let (paths, default_id) = cfd::source_files(&src).map_err(|e| {
            let mut a = cfd_err(e);
            if !src.exists() {
                a.code = ApiErrorCode::NotFound;
                a.hint = Some("paths are absolute or relative to the project root".into());
            }
            a
        })?;
        let id = match &i.study {
            Some(s) if cfd::valid_id(s) => s.clone(),
            Some(s) => {
                return Err(with_hint(
                    err(
                        ApiErrorCode::InvalidInput,
                        format!("study `{s}` is not a valid id"),
                    ),
                    "lower case letters, digits, `_` and `-`, e.g. tank_flow",
                ));
            }
            None => default_id,
        };
        let root = self
            .root
            .canonicalize()
            .unwrap_or_else(|_| self.root.clone());
        let mut parsed = Vec::new();
        let mut sources = Vec::new();
        for p in &paths {
            let bytes = std::fs::read(p).map_err(|e| io_err(&p.display().to_string(), e))?;
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let abs = p.canonicalize().unwrap_or_else(|_| p.clone());
            let shown = abs
                .strip_prefix(&root)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| abs.display().to_string());
            let text = String::from_utf8(bytes.clone()).map_err(|_| {
                err(
                    ApiErrorCode::InvalidInput,
                    format!("{shown}: not UTF-8 text"),
                )
            })?;
            let file = cfd::parse_csv(&shown, &text).map_err(cfd_err)?;
            sources.push(CfdSource {
                name: name.clone(),
                blake3: blake3::hash(&bytes).to_hex().to_string(),
            });
            parsed.push((shown, name, file));
        }
        let data = cfd::assemble(parsed).map_err(cfd_err)?;
        // Hash sources in step order (stable for a re-import of the same files).
        let order: Vec<String> = data
            .steps
            .iter()
            .map(|s| s.file.rsplit('/').next().unwrap_or(&s.file).to_string())
            .collect();
        sources.sort_by_key(|s| order.iter().position(|n| *n == s.name));
        let run_id = cfd::run_id(&id, &sources, CORE_VERSION);
        let dataset = cfd::dataset(&id, &run_id, &data);
        let sim = cfd::cfd_run_dir(&id);
        let rel = format!("{RUNS_DIR}/{sim}/{run_id}");
        let dir = self.root.join(&rel);
        let cached = dir.join(cfd::CFD_RECORD).is_file() && dir.join(cfd::CFD_DATASET).is_file();
        let mut files = Vec::new();
        if !cached {
            files.push(FileChange {
                path: format!("{rel}/{}", cfd::CFD_RECORD),
                status: FileStatus::A,
            });
            files.push(FileChange {
                path: format!("{rel}/{}", cfd::CFD_DATASET),
                status: FileStatus::A,
            });
        }
        if !i.dry_run && !cached {
            if !self.writable {
                return Err(with_hint(
                    err(ApiErrorCode::Locked, "this session is read-only"),
                    "CFD imports write runs/; run them through the project's owner",
                ));
            }
            let record = CfdRecord::new(dataset.clone(), data, sources, CORE_VERSION);
            // Compact: every point of every step (pretty JSON would triple it).
            let mut rec = serde_json::to_string(&record)
                .map_err(|x| err(ApiErrorCode::Internal, x.to_string()))?;
            rec.push('\n');
            let sum = pretty(&dataset)?;
            crate::fsutil::write_atomic(&dir.join(cfd::CFD_RECORD), rec.as_bytes())
                .map_err(|e| io_err("cfd run", e))?;
            crate::fsutil::write_atomic(&dir.join(cfd::CFD_DATASET), sum.as_bytes())
                .map_err(|e| io_err("cfd run", e))?;
        }
        Ok(CfdImportOut {
            mutation: MutationOut {
                step: None,
                model_hash: self.model.model_hash.clone(),
                dry_run: i.dry_run,
                files,
                delta: CheckDelta::between(&self.report, &self.report, None),
            },
            dataset,
        })
    }
}

/// Pretty JSON with a trailing newline.
fn pretty<T: serde::Serialize>(v: &T) -> Result<String, ApiError> {
    let mut t =
        serde_json::to_string_pretty(v).map_err(|x| err(ApiErrorCode::Internal, x.to_string()))?;
    t.push('\n');
    Ok(t)
}
