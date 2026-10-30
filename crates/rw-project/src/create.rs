//! `project_create` / `rw init [--template <name>] [dir]` (R3.1): writes one
//! of the embedded `templates/` projects plus `.rw/` in `.gitignore` (appended
//! to an existing one), with `.rw/lock` taken before anything is written,
//! then opens the project's writer `Session`, which records the initial
//! history step. The output is a normal `MutationOut` whose delta runs from
//! the empty model to the new one.

use std::path::Path;

use rw_api::{
    ApiError, ApiErrorCode, CallCtx, FileChange, FileStatus, ImportOut, MutationOut,
    ProjectCreateIn,
};

use crate::lock::ProjectLock;
use crate::session::{LockMode, Session, SessionOptions, locked_error};
use crate::{fsutil, layout};

include!(concat!(env!("OUT_DIR"), "/templates_gen.rs"));

/// The template used when none is named.
pub const DEFAULT_TEMPLATE: &str = "minimum";

/// The `.gitignore` written into new projects.
pub const GITIGNORE: &str = ".rw/\n";

fn err(code: ApiErrorCode, message: impl Into<String>, hint: Option<String>) -> ApiError {
    ApiError {
        outcome: None,
        code,
        message: message.into(),
        hint,
        diagnostics: Vec::new(),
    }
}

/// The `.gitignore` text with `.rw/` ignored: `None` when `existing`
/// already ignores it (`.rw`, `.rw/`, `/.rw`, `/.rw/`), else `existing` with
/// `.rw/` appended (or [`GITIGNORE`] when there is none).
pub fn gitignore_with_rw(existing: Option<&str>) -> Option<String> {
    let Some(text) = existing else {
        return Some(GITIGNORE.to_string());
    };
    let ignored = text
        .lines()
        .map(str::trim)
        .any(|l| matches!(l, ".rw" | ".rw/" | "/.rw" | "/.rw/"));
    if ignored {
        return None;
    }
    let mut out = text.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(GITIGNORE);
    Some(out)
}

/// What creating a project in `dir` writes: each file with its status. The
/// `.gitignore` merges with one already in `dir` (dropped when that one
/// already ignores `.rw/`).
pub fn planned_writes(
    dir: &Path,
    files: Vec<(String, Vec<u8>)>,
) -> Vec<(String, Vec<u8>, FileStatus)> {
    files
        .into_iter()
        .filter_map(|(p, b)| {
            if p != ".gitignore" {
                return Some((p, b, FileStatus::A));
            }
            let existing = std::fs::read_to_string(dir.join(&p)).ok();
            let status = if existing.is_some() {
                FileStatus::M
            } else {
                FileStatus::A
            };
            gitignore_with_rw(existing.as_deref()).map(|t| (p, t.into_bytes(), status))
        })
        .collect()
}

/// Writes [`planned_writes`] into `target`.
pub fn write_planned(
    target: &Path,
    planned: &[(String, Vec<u8>, FileStatus)],
) -> Result<(), ApiError> {
    for (p, b, _) in planned {
        fsutil::write_atomic(&target.join(p), b)
            .map_err(|e| err(ApiErrorCode::Io, format!("{p}: {e}"), None))?;
    }
    Ok(())
}

fn changes_of(planned: &[(String, Vec<u8>, FileStatus)]) -> Vec<FileChange> {
    planned
        .iter()
        .map(|(p, _, status)| FileChange {
            path: p.clone(),
            status: *status,
        })
        .collect()
}

fn conflict(dir: &Path, hint: &str) -> ApiError {
    err(
        ApiErrorCode::Conflict,
        format!("{} already holds a project", dir.display()),
        Some(hint.into()),
    )
}

/// Takes `.rw/lock` on `dir` (created if missing) before anything is
/// written there: a live owner fails with `RW-E007` and nothing changes.
fn lock_new_project(dir: &Path, hint: &str) -> Result<ProjectLock, ApiError> {
    std::fs::create_dir_all(dir)
        .map_err(|e| err(ApiErrorCode::Io, format!("{}: {e}", dir.display()), None))?;
    let lock = ProjectLock::acquire(dir, None).map_err(|e| locked_error(&e))?;
    // A project may have appeared while the lock was free.
    if layout::is_project(dir) {
        return Err(conflict(dir, hint));
    }
    Ok(lock)
}

/// Template names, sorted.
pub fn template_names() -> Vec<&'static str> {
    let mut v: Vec<&str> = TEMPLATE_FILES.iter().map(|(t, _, _)| *t).collect();
    v.dedup();
    v
}

/// The files of a template (`minimal` is an alias of `minimum`).
pub fn template(name: &str) -> Option<Vec<(&'static str, &'static str)>> {
    let name = if name == "minimal" { "minimum" } else { name };
    let v: Vec<(&str, &str)> = TEMPLATE_FILES
        .iter()
        .filter(|(t, _, _)| *t == name)
        .map(|(_, p, s)| (*p, *s))
        .collect();
    (!v.is_empty()).then_some(v)
}

/// Sets the top-level `name` of `rocketwright.toml`, keeping its comments.
fn renamed_manifest(text: &str, name: &str) -> String {
    match text.parse::<toml_edit::DocumentMut>() {
        Ok(mut doc) => {
            let decor = doc
                .get("name")
                .and_then(|i| i.as_value())
                .map(|v| v.decor().clone());
            let mut v = toml_edit::Value::from(name);
            if let Some(d) = decor {
                *v.decor_mut() = d;
            }
            doc.insert("name", toml_edit::Item::Value(v));
            doc.to_string()
        }
        Err(_) => text.to_string(),
    }
}

/// The files `project_create` writes (project-relative path, text).
pub fn project_files(i: &ProjectCreateIn) -> Result<Vec<(String, String)>, ApiError> {
    let t = i.template.as_deref().unwrap_or(DEFAULT_TEMPLATE);
    let files = template(t).ok_or_else(|| {
        err(
            ApiErrorCode::NotFound,
            format!("no template `{t}`"),
            Some(format!("templates: {}", template_names().join(", "))),
        )
    })?;
    let mut out: Vec<(String, String)> = files
        .into_iter()
        .filter(|(p, _)| *p != "README.md")
        .map(|(p, s)| {
            let text = match (&i.name, p) {
                (Some(n), layout::MANIFEST) => renamed_manifest(s, n),
                _ => s.to_string(),
            };
            (p.to_string(), text)
        })
        .collect();
    out.push((".gitignore".into(), GITIGNORE.into()));
    out.sort();
    Ok(out)
}

/// Creates a project in `dir` (created if missing). Fails with `conflict`
/// when `dir` already holds a project. `dry_run` writes nothing and reports
/// the files and the delta the new project would have.
pub fn create_project(
    dir: &Path,
    i: &ProjectCreateIn,
    ctx: &CallCtx,
) -> Result<MutationOut, ApiError> {
    const HINT: &str = "edit it with model_patch, or create the project in an empty directory";
    if layout::is_project(dir) {
        return Err(conflict(dir, HINT));
    }
    let files = project_files(i)?
        .into_iter()
        .map(|(p, t)| (p, t.into_bytes()))
        .collect();
    let planned = planned_writes(dir, files);
    let changes = changes_of(&planned);
    let tmp = std::env::temp_dir().join(format!(
        "rw-create-{}-{}",
        std::process::id(),
        blake3::hash(dir.to_string_lossy().as_bytes()).to_hex()[..8].to_owned()
    ));
    let opened = if i.dry_run {
        let _ = std::fs::remove_dir_all(&tmp);
        write_planned(&tmp, &planned)
            .and_then(|()| Session::open(&tmp, SessionOptions::read_only()))
    } else {
        let lock = lock_new_project(dir, HINT)?;
        write_planned(dir, &planned)?;
        Session::open(
            dir,
            SessionOptions::writer()
                .with_lock(LockMode::Held(lock))
                .with_snapshot_origin(ctx.origin),
        )
    };
    let result = opened.map(|s| {
        let step = s
            .steps()
            .ok()
            .and_then(|v| v.last().map(|st| format!("step:{}", st.seq)));
        let mut delta = s.delta_from_empty(step.clone());
        delta.model_hash = s.model().model_hash.clone();
        MutationOut {
            step: if i.dry_run { None } else { step },
            model_hash: s.model().model_hash.clone(),
            dry_run: i.dry_run,
            files: changes,
            delta,
        }
    });
    if i.dry_run {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    result
}

/// `rw import ork <file> <dir>` when `dir` holds no project: creates the
/// project from the `.ork` (sources, motor files, `.gitignore`), then opens
/// its writer `Session`, whose initial history step is titled
/// `Import <file>`. `dry_run` writes nothing.
pub fn import_project(
    dir: &Path,
    path: &str,
    dry_run: bool,
    ctx: &CallCtx,
) -> Result<ImportOut, ApiError> {
    const HINT: &str = "run the import from inside it to replace its model (one history step)";
    if layout::is_project(dir) {
        return Err(conflict(dir, HINT));
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| dir.to_path_buf());
    let (abs, bytes) = crate::interop::read_input(&cwd, path)?;
    let name = abs
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let plan = crate::interop::plan_ork(
        &bytes,
        &name,
        &rw_model::SourceSet::default(),
        &std::collections::BTreeMap::new(),
        &crate::interop::DirCache::for_project(dir),
    )?;
    let (_, changes) = crate::TomlStore::new()
        .preview_target(plan.target.clone())
        .map_err(|e| err(ApiErrorCode::Internal, e.message, None))?;
    let mut files: Vec<(String, Vec<u8>)> = changes
        .into_iter()
        .filter_map(|c| Some((c.path, c.text?.into_bytes())))
        .collect();
    files.extend(plan.lib_files.iter().map(|(p, b)| (p.clone(), b.clone())));
    files.push((".gitignore".into(), GITIGNORE.as_bytes().to_vec()));
    files.sort();
    let planned = planned_writes(dir, files);
    let target = if dry_run {
        let tmp = std::env::temp_dir().join(format!(
            "rw-import-{}-{}",
            std::process::id(),
            blake3::hash(dir.to_string_lossy().as_bytes()).to_hex()[..8].to_owned()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        tmp
    } else {
        dir.to_path_buf()
    };
    let opts = if dry_run {
        SessionOptions::read_only()
    } else {
        let lock = lock_new_project(dir, HINT)?;
        SessionOptions::writer()
            .with_lock(LockMode::Held(lock))
            .with_snapshot_title(Some(plan.title.clone()))
            .with_snapshot_origin(ctx.origin)
    };
    write_planned(&target, &planned)?;
    let result = Session::open(&target, opts).map(|s| {
        let step = s
            .steps()
            .ok()
            .and_then(|v| v.last().map(|st| format!("step:{}", st.seq)));
        let delta = s.delta_from_empty(step.clone());
        ImportOut {
            mutation: MutationOut {
                step: if dry_run { None } else { step },
                model_hash: s.model().model_hash.clone(),
                dry_run,
                files: changes_of(&planned),
                delta,
            },
            imported: plan.imported.clone(),
            diagnostics: plan.diagnostics.clone(),
        }
    });
    if dry_run {
        let _ = std::fs::remove_dir_all(&target);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use rw_api::Origin;

    fn ctx() -> CallCtx {
        CallCtx {
            origin: Origin::Cli,
            thread: None,
            tool_call: None,
            label: None,
        }
    }

    #[test]
    fn templates_are_embedded() {
        assert_eq!(template_names(), ["minimum", "simple-rocket"]);
        assert!(template("minimal").is_some());
        assert!(template("nope").is_none());
    }

    #[test]
    fn creates_a_clean_project_with_history() {
        let d = TempDir::new("create");
        let dir = d.path().join("proj");
        let i = ProjectCreateIn {
            name: Some("Alpha".into()),
            template: Some("simple-rocket".into()),
            dry_run: true,
        };
        let dry = create_project(&dir, &i, &ctx()).unwrap();
        assert!(dry.dry_run && dry.step.is_none());
        assert!(!dir.exists(), "dry run writes nothing");
        let i = ProjectCreateIn {
            dry_run: false,
            ..i
        };
        let out = create_project(&dir, &i, &ctx()).unwrap();
        assert_eq!(out.step.as_deref(), Some("step:1"));
        assert_eq!(out.model_hash, dry.model_hash);
        assert!(out.files.iter().any(|f| f.path == "rocketwright.toml"));
        assert!(
            std::fs::read_to_string(dir.join("rocketwright.toml"))
                .unwrap()
                .contains("name = \"Alpha\"")
        );
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            ".rw/\n"
        );
        assert!(out.delta.changed.contains_key("mass.liftoff"));
        let again = create_project(&dir, &i, &ctx()).unwrap_err();
        assert_eq!(again.code, ApiErrorCode::Conflict);
        let bad = ProjectCreateIn {
            template: Some("nope".into()),
            ..ProjectCreateIn::default()
        };
        assert_eq!(
            create_project(&d.path().join("x"), &bad, &ctx())
                .unwrap_err()
                .code,
            ApiErrorCode::NotFound
        );
    }

    /// Item 7: `rw init`'s first step records the caller's origin.
    #[test]
    fn initial_step_records_the_callers_origin() {
        let d = TempDir::new("create-origin");
        let dir = d.path().join("p");
        create_project(&dir, &ProjectCreateIn::default(), &ctx()).unwrap();
        let s = Session::open(&dir, SessionOptions::read_only()).unwrap();
        let steps = s.steps().unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].origin, Origin::Cli);
    }

    /// Item 4: an existing `.gitignore` gains `.rw/` (once), keeping its lines.
    #[test]
    fn existing_gitignore_gains_rw() {
        let d = TempDir::new("create-gitignore");
        let dir = d.path().join("p");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "node_modules/\n*.log").unwrap();
        let out = create_project(&dir, &ProjectCreateIn::default(), &ctx()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "node_modules/\n*.log\n.rw/\n"
        );
        let g = out.files.iter().find(|f| f.path == ".gitignore").unwrap();
        assert_eq!(g.status, FileStatus::M);
        // Already ignored: left alone.
        let d2 = TempDir::new("create-gitignore2");
        let dir2 = d2.path().join("p");
        std::fs::create_dir_all(&dir2).unwrap();
        std::fs::write(dir2.join(".gitignore"), "/.rw\nx\n").unwrap();
        let out = create_project(&dir2, &ProjectCreateIn::default(), &ctx()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir2.join(".gitignore")).unwrap(),
            "/.rw\nx\n"
        );
        assert!(out.files.iter().all(|f| f.path != ".gitignore"));
    }

    /// Item 3: with a live owner holding `.rw/lock`, init writes nothing.
    #[test]
    fn init_under_a_live_owner_writes_nothing() {
        let d = TempDir::new("create-locked");
        let dir = d.path().join("p");
        std::fs::create_dir_all(&dir).unwrap();
        let _owner = crate::lock::ProjectLock::acquire(&dir, None).unwrap();
        let e = create_project(&dir, &ProjectCreateIn::default(), &ctx()).unwrap_err();
        assert_eq!(e.code, ApiErrorCode::Locked, "{e:?}");
        assert!(!dir.join(layout::MANIFEST).exists(), "nothing written");
        assert!(!dir.join(".gitignore").exists(), "nothing written");
    }

    #[test]
    fn every_template_checks_clean_in_every_configuration() {
        for t in template_names() {
            let d = TempDir::new("create-tpl");
            let dir = d.path().join("p");
            let i = ProjectCreateIn {
                template: Some(t.into()),
                ..ProjectCreateIn::default()
            };
            create_project(&dir, &i, &ctx()).unwrap();
            let s = Session::open(&dir, SessionOptions::read_only()).unwrap();
            assert!(!s.model().configs.is_empty(), "{t}");
            for c in s.model().configs.keys() {
                let (_, r) = s.evaluated(Some(c)).unwrap();
                assert_eq!(
                    r.status,
                    rw_check::CheckStatus::Clean,
                    "{t} {c}: {:?}",
                    r.diagnostics
                );
            }
        }
    }
}
