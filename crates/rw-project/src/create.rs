//! `project_create` / `rw init [--template <name>] [dir]` (R3.1): writes one
//! of the embedded `templates/` projects plus `.rw/` and `artifacts/` in
//! `.gitignore` (appended to an existing one), with `.rw/lock` taken before
//! anything is written, then opens the project's writer `Session`, which
//! records the initial history step. The output is a normal `MutationOut` whose delta runs from
//! the empty model to the new one. A folder may hold other files; creating
//! a project refuses rather than replace any of them (D3).

use std::collections::BTreeMap;
use std::path::Path;

use rw_api::{
    ApiError, ApiErrorCode, CallCtx, FileChange, FileStatus, ImportOut, MutationOut,
    ProjectCreateIn,
};

use rw_units::{DimKind, Unit, parse_unit};

use crate::lock::ProjectLock;
use crate::session::{LockMode, Session, SessionOptions, locked_error};
use crate::{fsutil, layout};

include!(concat!(env!("OUT_DIR"), "/templates_gen.rs"));

/// The template used when none is named.
pub const DEFAULT_TEMPLATE: &str = "minimum";

/// The `.gitignore` written into new projects: session state, and the folder
/// agents keep planning files in (R1.4).
pub const GITIGNORE: &str = ".rw/\nartifacts/\n";

/// A template's main model file, which `--name` renames with the manifest.
const ROCKET_FILE: &str = "rocket.rw.toml";

/// The longest project name, in bytes (R0.7).
pub const MAX_PROJECT_NAME_BYTES: usize = 255;

/// The `[display_units]` key of the flight-distance class.
pub const ALTITUDE: &str = "altitude";

/// The dimension a `[display_units]` key names.
pub fn display_kind(key: &str) -> Option<DimKind> {
    if key == ALTITUDE {
        Some(DimKind::Length)
    } else {
        DimKind::from_name(key)
    }
}

/// `sym` as the display unit of `key`, or `None` when the key is unknown,
/// the symbol does not parse, or its dimension is wrong.
pub fn display_unit(key: &str, sym: &str) -> Option<Unit> {
    let kind = display_kind(key)?;
    let unit = parse_unit(sym).ok()?;
    (unit.dim == kind.dimension()).then_some(unit)
}

/// `name` trimmed, or `invalid_input` when it is empty, over
/// [`MAX_PROJECT_NAME_BYTES`], or holds a control character.
pub fn checked_project_name(name: &str) -> Result<&str, ApiError> {
    let invalid = |message: String| err(ApiErrorCode::InvalidInput, message, None);
    let name = name.trim();
    if name.is_empty() {
        return Err(invalid("a project name cannot be empty".into()));
    }
    if name.len() > MAX_PROJECT_NAME_BYTES {
        return Err(invalid(format!(
            "a project name is at most {MAX_PROJECT_NAME_BYTES} bytes; this one is {}",
            name.len()
        )));
    }
    if name.chars().any(char::is_control) {
        return Err(invalid(
            "a project name cannot hold control characters".into(),
        ));
    }
    Ok(name)
}

fn err(code: ApiErrorCode, message: impl Into<String>, hint: Option<String>) -> ApiError {
    ApiError {
        outcome: None,
        code,
        message: message.into(),
        hint,
        diagnostics: Vec::new(),
    }
}

/// True when a `.gitignore` line names the directory `dir`, in any of the
/// forms `dir`, `dir/`, `/dir`, `/dir/`.
fn line_ignores(line: &str, dir: &str) -> bool {
    let line = line.trim();
    let line = line.strip_prefix('/').unwrap_or(line);
    line.strip_suffix('/').unwrap_or(line) == dir
}

/// The `.gitignore` text for a project being created: `None` when `existing`
/// already ignores every [`GITIGNORE`] directory, else `existing` with the
/// missing entries appended (or [`GITIGNORE`] when there is none). Only
/// creation calls this, so an existing project's `.gitignore` is never
/// rewritten (R1.4).
pub fn gitignore_with_rw(existing: Option<&str>) -> Option<String> {
    let Some(text) = existing else {
        return Some(GITIGNORE.to_string());
    };
    let missing: Vec<&str> = GITIGNORE
        .lines()
        .filter(|entry| {
            let dir = entry.trim_end_matches('/');
            !text.lines().any(|l| line_ignores(l, dir))
        })
        .collect();
    if missing.is_empty() {
        return None;
    }
    let mut out = text.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    for entry in missing {
        out.push_str(entry);
        out.push('\n');
    }
    Some(out)
}

/// What creating a project in `dir` writes: each file with its status. The
/// `.gitignore` merges with one already in `dir` (dropped when that one
/// already ignores every [`GITIGNORE`] directory).
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

/// The planned new files that something already in `dir` occupies, in
/// `planned`'s order. A `.gitignore` that merges is `M`, so it never counts;
/// one that cannot be read and merged is still `A`, so it does. A dangling
/// symlink counts, and so does a file where the plan needs a directory.
fn collisions(dir: &Path, planned: &[(String, Vec<u8>, FileStatus)]) -> Vec<String> {
    if !dir.is_dir() {
        return Vec::new();
    }
    planned
        .iter()
        .filter(|(p, _, status)| {
            *status == FileStatus::A
                && match std::fs::symlink_metadata(dir.join(p)) {
                    Ok(_) => true,
                    Err(e) => e.kind() == std::io::ErrorKind::NotADirectory,
                }
        })
        .map(|(p, _, _)| p.clone())
        .collect()
}

/// `conflict` naming every file a new project would replace (D3).
fn refuse_collisions(
    dir: &Path,
    planned: &[(String, Vec<u8>, FileStatus)],
) -> Result<(), ApiError> {
    let taken = collisions(dir, planned);
    if taken.is_empty() {
        return Ok(());
    }
    Err(err(
        ApiErrorCode::Conflict,
        format!(
            "{} already has files a new project would replace: {}",
            dir.display(),
            taken.join(", ")
        ),
        Some("move those files, or create the project in an empty directory".into()),
    ))
}

/// `conflict` when `dir` itself is a symbolic link, dangling or not: the
/// project would land wherever it points, which is not the folder the caller
/// named. A link higher up the path is the caller's own layout and is allowed.
pub fn refuse_symlink_target(dir: &Path) -> Result<(), ApiError> {
    // `components` drops a trailing slash, which would make `lstat` follow the link.
    let is_link = std::fs::symlink_metadata(dir.components().as_path())
        .is_ok_and(|m| m.file_type().is_symlink());
    if !is_link {
        return Ok(());
    }
    Err(err(
        ApiErrorCode::Conflict,
        format!(
            "{} is a symbolic link, so a project cannot be created there",
            dir.display()
        ),
        Some("create the project in a real folder".into()),
    ))
}

/// Makes `dir` and its missing parents without following a link at `dir`.
/// `create_dir_all` accepts a link to a folder as already done; `create_dir`
/// never follows one, so a link planted at any moment before this call is
/// seen here rather than written through.
fn make_project_dir(dir: &Path) -> Result<(), ApiError> {
    let dir = dir.components().as_path();
    let io = |e: std::io::Error| err(ApiErrorCode::Io, format!("{}: {e}", dir.display()), None);
    // Parents only on NotFound: making them first would turn a file in the
    // path from ENOTDIR into EEXIST, which callers read as a different error.
    let made = match std::fs::create_dir(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = dir.parent() {
                std::fs::create_dir_all(parent).map_err(io)?;
            }
            std::fs::create_dir(dir)
        }
        first => first,
    };
    match made {
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => Err(io(e)),
        Err(e) => {
            refuse_symlink_target(dir)?;
            if dir.is_dir() { Ok(()) } else { Err(io(e)) }
        }
        Ok(()) => Ok(()),
    }
}

/// Takes `.rw/lock` on `dir` (created if missing) before anything is
/// written there: a live owner fails with `RW-E007` and nothing changes.
fn lock_new_project(
    dir: &Path,
    hint: &str,
    planned: &[(String, Vec<u8>, FileStatus)],
) -> Result<ProjectLock, ApiError> {
    make_project_dir(dir)?;
    let lock = ProjectLock::acquire(dir, None).map_err(|e| locked_error(&e))?;
    // An existing folder may have been swapped for a link before the lock.
    refuse_symlink_target(dir)?;
    // A project, or a colliding file, may have appeared while the lock was free.
    if layout::is_project(dir) {
        return Err(conflict(dir, hint));
    }
    refuse_collisions(dir, planned)?;
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

/// Sets the top-level `name` of a TOML source, keeping its comments.
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

/// Overlays `units` on a manifest's `[display_units]`, keeping its comments.
/// The caller has checked the entries and that `text` parses.
fn with_display_units(text: &str, units: &BTreeMap<String, String>) -> String {
    let Ok(mut doc) = text.parse::<toml_edit::DocumentMut>() else {
        return text.to_string();
    };
    if let Some(table) = doc
        .entry("display_units")
        .or_insert_with(toml_edit::table)
        .as_table_mut()
    {
        for (key, sym) in units {
            table.insert(key, toml_edit::value(sym.trim()));
        }
    }
    doc.to_string()
}

/// `invalid_input` naming the first `[display_units]` entry that no reader
/// would honour; they would otherwise be silently ignored.
fn check_display_units(units: &BTreeMap<String, String>) -> Result<(), ApiError> {
    for (key, sym) in units {
        if display_kind(key).is_none() {
            return Err(err(
                ApiErrorCode::InvalidInput,
                format!("`{key}` is not a display unit key"),
                Some("keys are dimension names (length, mass, velocity, ...) or altitude".into()),
            ));
        }
        if display_unit(key, sym.trim()).is_none() {
            return Err(err(
                ApiErrorCode::InvalidInput,
                format!("`{sym}` is not a unit of `{key}`"),
                None,
            ));
        }
    }
    Ok(())
}

/// The files `project_create` writes (project-relative path, text).
pub fn project_files(i: &ProjectCreateIn) -> Result<Vec<(String, String)>, ApiError> {
    let name = i.name.as_deref().map(checked_project_name).transpose()?;
    check_display_units(&i.display_units)?;
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
            // The name lives in both files; a project must never read "Rocket"
            // in one place and its real name in the other.
            let text = match (name, p) {
                (Some(n), layout::MANIFEST | ROCKET_FILE) => renamed_manifest(s, n),
                _ => s.to_string(),
            };
            let text = if p == layout::MANIFEST && !i.display_units.is_empty() {
                with_display_units(&text, &i.display_units)
            } else {
                text
            };
            (p.to_string(), text)
        })
        .collect();
    out.push((".gitignore".into(), GITIGNORE.into()));
    out.sort();
    Ok(out)
}

/// Creates a project in `dir` (created if missing). Fails with `conflict`
/// when `dir` is a symbolic link, or already holds a project or a file the
/// project would replace.
/// `dry_run` writes nothing, refuses the same way, and reports the files and
/// the delta the new project would have.
pub fn create_project(
    dir: &Path,
    i: &ProjectCreateIn,
    ctx: &CallCtx,
) -> Result<MutationOut, ApiError> {
    const HINT: &str = "edit it with model_patch, or create the project in an empty directory";
    refuse_symlink_target(dir)?;
    if layout::is_project(dir) {
        return Err(conflict(dir, HINT));
    }
    let files = project_files(i)?
        .into_iter()
        .map(|(p, t)| (p, t.into_bytes()))
        .collect();
    let planned = planned_writes(dir, files);
    refuse_collisions(dir, &planned)?;
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
        let lock = lock_new_project(dir, HINT, &planned)?;
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
/// `Import <file>`. Refuses a file it would replace, as [`create_project`]
/// does. `dry_run` writes nothing.
pub fn import_project(
    dir: &Path,
    path: &str,
    dry_run: bool,
    ctx: &CallCtx,
) -> Result<ImportOut, ApiError> {
    const HINT: &str = "run the import from inside it to replace its model (one history step)";
    refuse_symlink_target(dir)?;
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
    refuse_collisions(dir, &planned)?;
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
        let lock = lock_new_project(dir, HINT, &planned)?;
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
        assert_eq!(
            template_names(),
            ["empty", "minimum", "sample", "simple-rocket"]
        );
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
            ..ProjectCreateIn::default()
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
            ".rw/\nartifacts/\n"
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

    /// R3.4: creation writes `[display_units]` in the one step.
    #[test]
    fn creation_writes_display_units() {
        let d = TempDir::new("create-units");
        let dir = d.path().join("p");
        let units = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect()
        };
        let i = ProjectCreateIn {
            display_units: units(&[("length", " cm "), ("mass", "kg")]),
            ..ProjectCreateIn::default()
        };
        let out = create_project(&dir, &i, &ctx()).unwrap();
        assert_eq!(out.step.as_deref(), Some("step:1"), "no follow-up edit");
        let manifest = std::fs::read_to_string(dir.join("rocketwright.toml")).unwrap();
        assert!(manifest.contains("[display_units]"), "{manifest}");
        assert!(manifest.contains("length = \"cm\""), "{manifest}");
        assert!(manifest.contains("mass = \"kg\""), "{manifest}");
        // The written manifest is already canonical.
        let mut s = Session::open(&dir, SessionOptions::read_only()).unwrap();
        let rw_api::Response::Fmt(fmt) = s
            .execute(
                &rw_api::Command::Fmt(rw_api::FmtIn {
                    check: true,
                    files: Vec::new(),
                }),
                &ctx(),
            )
            .unwrap()
        else {
            panic!()
        };
        assert!(fmt.changed.is_empty(), "{:?}", fmt.changed);

        // A template's own entries survive unless overlaid.
        let dir = d.path().join("q");
        let i = ProjectCreateIn {
            template: Some("simple-rocket".into()),
            display_units: units(&[("mass", "kg")]),
            ..ProjectCreateIn::default()
        };
        create_project(&dir, &i, &ctx()).unwrap();
        let manifest = std::fs::read_to_string(dir.join("rocketwright.toml")).unwrap();
        assert_eq!(manifest.matches("[display_units]").count(), 1, "{manifest}");
        assert!(manifest.contains("mass = \"kg\""), "{manifest}");
        assert!(manifest.contains("length ="), "{manifest}");

        for bad in [
            units(&[("colour", "mm")]),
            units(&[("length", "furlongs")]),
            units(&[("length", "kg")]),
        ] {
            let target = d.path().join("bad");
            let i = ProjectCreateIn {
                display_units: bad,
                ..ProjectCreateIn::default()
            };
            let e = create_project(&target, &i, &ctx()).unwrap_err();
            assert_eq!(e.code, ApiErrorCode::InvalidInput);
            assert!(!target.exists(), "refused before writing");
        }
    }

    /// R0.7: a created name obeys the rename limits.
    #[test]
    fn creation_refuses_bad_names() {
        let d = TempDir::new("create-name");
        for bad in ["", " ", "a\u{7}b", &"n".repeat(256)] {
            let target = d.path().join("p");
            let i = ProjectCreateIn {
                name: Some(bad.to_string()),
                ..ProjectCreateIn::default()
            };
            let e = create_project(&target, &i, &ctx()).unwrap_err();
            assert_eq!(e.code, ApiErrorCode::InvalidInput, "{bad:?}");
            assert!(!target.exists());
        }
        let i = ProjectCreateIn {
            name: Some(" Alpha ".into()),
            ..ProjectCreateIn::default()
        };
        let dir = d.path().join("trimmed");
        create_project(&dir, &i, &ctx()).unwrap();
        assert!(
            std::fs::read_to_string(dir.join("rocketwright.toml"))
                .unwrap()
                .contains("name = \"Alpha\"")
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

    /// Item 4: an existing `.gitignore` gains the entries it lacks (once),
    /// keeping its lines.
    #[test]
    fn existing_gitignore_gains_rw() {
        let d = TempDir::new("create-gitignore");
        let dir = d.path().join("p");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "node_modules/\n*.log").unwrap();
        let out = create_project(&dir, &ProjectCreateIn::default(), &ctx()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "node_modules/\n*.log\n.rw/\nartifacts/\n"
        );
        let g = out.files.iter().find(|f| f.path == ".gitignore").unwrap();
        assert_eq!(g.status, FileStatus::M);
        // Everything already ignored: left alone.
        let d2 = TempDir::new("create-gitignore2");
        let dir2 = d2.path().join("p");
        std::fs::create_dir_all(&dir2).unwrap();
        std::fs::write(dir2.join(".gitignore"), "/.rw\nx\nartifacts\n").unwrap();
        let out = create_project(&dir2, &ProjectCreateIn::default(), &ctx()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir2.join(".gitignore")).unwrap(),
            "/.rw\nx\nartifacts\n"
        );
        assert!(out.files.iter().all(|f| f.path != ".gitignore"));
    }

    /// R1.4: `artifacts/` is added even when `.rw` is already ignored, and
    /// each spelling of an entry counts as present.
    #[test]
    fn gitignore_merge_adds_only_missing_entries() {
        assert_eq!(
            gitignore_with_rw(None).as_deref(),
            Some(".rw/\nartifacts/\n")
        );
        for (existing, merged) in [
            (".rw/\n", Some(".rw/\nartifacts/\n")),
            ("/.rw", Some("/.rw\nartifacts/\n")),
            ("artifacts/\n", Some("artifacts/\n.rw/\n")),
            ("", Some(".rw/\nartifacts/\n")),
            // A nested or longer name is a different directory.
            (
                ".rw/\nsub/artifacts/\nartifacts2\n",
                Some(".rw/\nsub/artifacts/\nartifacts2\nartifacts/\n"),
            ),
            (".rw\n/artifacts/\n", None),
            ("  .rw/  \r\n/artifacts\r\n", None),
        ] {
            assert_eq!(
                gitignore_with_rw(Some(existing)).as_deref(),
                merged,
                "{existing:?}"
            );
        }
    }

    /// R1.4: only creation merges. An existing project keeps its `.gitignore`
    /// when it is opened and when a create is refused.
    #[test]
    fn an_existing_projects_gitignore_is_left_alone() {
        let d = TempDir::new("create-gitignore-existing");
        let dir = d.path().join("p");
        create_project(&dir, &ProjectCreateIn::default(), &ctx()).unwrap();
        std::fs::write(dir.join(".gitignore"), ".rw/\n").unwrap();
        drop(Session::open(&dir, SessionOptions::writer()).unwrap());
        let e = create_project(&dir, &ProjectCreateIn::default(), &ctx()).unwrap_err();
        assert_eq!(e.code, ApiErrorCode::Conflict, "{e:?}");
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            ".rw/\n"
        );
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

    fn snapshot(dir: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
        fn walk(root: &Path, d: &Path, out: &mut std::collections::BTreeMap<String, Vec<u8>>) {
            for e in std::fs::read_dir(d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(root, &p, out);
                } else {
                    let rel = p.strip_prefix(root).unwrap().display().to_string();
                    out.insert(rel, std::fs::read(&p).unwrap());
                }
            }
        }
        let mut out = std::collections::BTreeMap::new();
        walk(dir, dir, &mut out);
        out
    }

    /// D3: every file a template would land on is listed, and neither a dry
    /// run nor a real create touches the folder.
    #[test]
    fn a_colliding_file_is_refused_and_listed() {
        let d = TempDir::new("create-collision");
        let dir = d.path().join("p");
        std::fs::create_dir_all(dir.join("configs")).unwrap();
        std::fs::write(dir.join("rocket.rw.toml"), "# my notes, not a model\n").unwrap();
        std::fs::write(dir.join("configs/default.rw.toml"), "name = \"Mine\"\n").unwrap();
        std::fs::write(dir.join("notes.txt"), "keep\n").unwrap();
        let before = snapshot(&dir);
        for dry_run in [true, false] {
            let i = ProjectCreateIn {
                dry_run,
                ..ProjectCreateIn::default()
            };
            let e = create_project(&dir, &i, &ctx()).unwrap_err();
            assert_eq!(e.code, ApiErrorCode::Conflict, "{e:?}");
            assert!(
                e.message.contains("rocket.rw.toml")
                    && e.message.contains("configs/default.rw.toml")
                    && !e.message.contains("notes.txt"),
                "{}",
                e.message
            );
            assert_eq!(snapshot(&dir), before, "dry_run {dry_run}");
            assert!(!dir.join(".rw").exists(), "no lock left behind");
        }
    }

    /// D3: unrelated files stay, and the project is created around them.
    #[test]
    fn a_folder_without_a_collision_is_used() {
        let d = TempDir::new("create-nocollision");
        let dir = d.path().join("p");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.txt"), "keep\n").unwrap();
        create_project(&dir, &ProjectCreateIn::default(), &ctx()).unwrap();
        assert_eq!(std::fs::read(dir.join("notes.txt")).unwrap(), b"keep\n");
        assert!(layout::is_project(&dir));
    }

    /// A file where the plan needs a directory, a dangling symlink, and a
    /// `.gitignore` that cannot be merged are collisions too: each would
    /// otherwise fail midway or lose the thing it replaced.
    #[test]
    fn occupied_paths_count_as_collisions() {
        let d = TempDir::new("create-occupied");
        let dir = d.path().join("p");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("configs"), "a file\n").unwrap();
        let e = create_project(&dir, &ProjectCreateIn::default(), &ctx()).unwrap_err();
        assert!(e.message.contains("configs/default.rw.toml"), "{e:?}");

        let d = TempDir::new("create-binary-gitignore");
        let dir = d.path().join("p");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), [0xff, 0xfe, 0x00]).unwrap();
        let e = create_project(&dir, &ProjectCreateIn::default(), &ctx()).unwrap_err();
        assert!(e.message.contains(".gitignore"), "{e:?}");

        #[cfg(unix)]
        {
            let d = TempDir::new("create-dangling");
            let dir = d.path().join("p");
            std::fs::create_dir_all(&dir).unwrap();
            std::os::unix::fs::symlink(d.path().join("gone"), dir.join("rocket.rw.toml")).unwrap();
            let e = create_project(&dir, &ProjectCreateIn::default(), &ctx()).unwrap_err();
            assert!(e.message.contains("rocket.rw.toml"), "{e:?}");
        }
    }

    /// A link at the target would put the project wherever it points, so it
    /// is refused, live or dangling, with or without a trailing slash, and the
    /// place it points to stays untouched.
    #[cfg(unix)]
    #[test]
    fn a_symlink_target_is_refused() {
        let d = TempDir::new("create-symlink");
        let real = d.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let live = d.path().join("live");
        std::os::unix::fs::symlink(&real, &live).unwrap();
        let gone = d.path().join("gone");
        let dangling = d.path().join("dangling");
        std::os::unix::fs::symlink(&gone, &dangling).unwrap();
        for link in [&live, &dangling, &live.join(""), &dangling.join("")] {
            for dry_run in [true, false] {
                let i = ProjectCreateIn {
                    dry_run,
                    ..ProjectCreateIn::default()
                };
                let e = create_project(link, &i, &ctx()).unwrap_err();
                assert_eq!(e.code, ApiErrorCode::Conflict, "{e:?}");
                assert!(e.message.contains("symbolic link"), "{}", e.message);
            }
        }
        assert!(
            snapshot(&real).is_empty(),
            "nothing written through the link"
        );
        assert!(!gone.exists(), "a dangling link's target is not created");
    }

    /// The last check, in the step that makes the folder: a link that arrives
    /// after the earlier checks still stops the project landing behind it.
    #[cfg(unix)]
    #[test]
    fn the_step_that_makes_the_folder_refuses_a_symlink() {
        let d = TempDir::new("create-symlink-lock");
        let real = d.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = d.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let e = lock_new_project(&link, "hint", &[])
            .map(|_| ())
            .unwrap_err();
        assert_eq!(e.code, ApiErrorCode::Conflict, "{e:?}");
        assert!(!real.join(".rw").exists(), "no lock through the link");
    }

    /// The app maps ENOTDIR to a bad location, so a file in the path must
    /// report that and not the EEXIST of making its parent.
    #[cfg(unix)]
    #[test]
    fn a_file_in_the_path_reports_not_a_directory() {
        let d = TempDir::new("create-file-in-path");
        let file = d.path().join("plain-file");
        std::fs::write(&file, "x").unwrap();
        for dir in [file.join("Under"), file.join("deeper").join("Under")] {
            let e = create_project(&dir, &ProjectCreateIn::default(), &ctx()).unwrap_err();
            assert_eq!(e.code, ApiErrorCode::Io, "{e:?}");
            assert!(e.message.contains("os error 20"), "{}", e.message);
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "x");
    }

    #[cfg(unix)]
    #[test]
    fn an_import_refuses_a_symlink_target() {
        let d = TempDir::new("create-import-symlink");
        let src = d.path().join("bird.ork");
        std::fs::write(&src, include_str!("../../rw-ork/tests/data/simple.ork.xml")).unwrap();
        let real = d.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = d.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        for dry_run in [true, false] {
            let e = import_project(&link, src.to_str().unwrap(), dry_run, &ctx()).unwrap_err();
            assert_eq!(e.code, ApiErrorCode::Conflict, "{e:?}");
            assert!(e.message.contains("symbolic link"), "{}", e.message);
        }
        assert!(
            snapshot(&real).is_empty(),
            "nothing written through the link"
        );
    }

    /// Missing parents are still made, and a link higher up the path is the
    /// caller's own layout (macOS's `/tmp` is one).
    #[cfg(unix)]
    #[test]
    fn missing_parents_are_made_and_a_linked_parent_is_allowed() {
        let d = TempDir::new("create-parents");
        let deep = d.path().join("a/b/p");
        create_project(&deep, &ProjectCreateIn::default(), &ctx()).unwrap();
        assert!(layout::is_project(&deep));

        let real = d.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = d.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        create_project(&link.join("p"), &ProjectCreateIn::default(), &ctx()).unwrap();
        assert!(layout::is_project(&real.join("p")));
    }

    /// D3 for project-creating imports, including the dry run.
    #[test]
    fn an_import_refuses_a_colliding_file() {
        let d = TempDir::new("create-import-collision");
        let src = d.path().join("bird.ork");
        std::fs::write(&src, include_str!("../../rw-ork/tests/data/simple.ork.xml")).unwrap();
        let dir = d.path().join("p");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("rocket.rw.toml"), "# mine\n").unwrap();
        let before = snapshot(&dir);
        for dry_run in [true, false] {
            let e = import_project(&dir, src.to_str().unwrap(), dry_run, &ctx()).unwrap_err();
            assert_eq!(e.code, ApiErrorCode::Conflict, "{e:?}");
            assert!(e.message.contains("rocket.rw.toml"), "{}", e.message);
            assert_eq!(snapshot(&dir), before, "dry_run {dry_run}");
        }
    }

    /// `--name` reaches the manifest and the model, keeping their comments.
    #[test]
    fn name_is_written_to_both_files() {
        let d = TempDir::new("create-name");
        let dir = d.path().join("p");
        let i = ProjectCreateIn {
            name: Some("Solstice".into()),
            template: Some("minimum".into()),
            dry_run: false,
            ..ProjectCreateIn::default()
        };
        create_project(&dir, &i, &ctx()).unwrap();
        let manifest = std::fs::read_to_string(dir.join(layout::MANIFEST)).unwrap();
        assert!(manifest.contains("name = \"Solstice\""), "{manifest}");
        assert!(manifest.starts_with("# The smallest"), "{manifest}");
        let rocket = std::fs::read_to_string(dir.join(ROCKET_FILE)).unwrap();
        assert!(rocket.contains("name = \"Solstice\""), "{rocket}");
        assert!(!rocket.contains("\"Rocket\""), "{rocket}");
    }

    /// `empty` opens with no parts, one configuration and no simulation, and
    /// the check still says there is nothing to fly yet (RW-E100).
    #[test]
    fn the_empty_template_opens_with_nothing_to_fly() {
        let d = TempDir::new("create-empty");
        let dir = d.path().join("p");
        let i = ProjectCreateIn {
            template: Some("empty".into()),
            ..ProjectCreateIn::default()
        };
        create_project(&dir, &i, &ctx()).unwrap();
        let s = Session::open(&dir, SessionOptions::read_only()).unwrap();
        assert!(s.model().components.is_empty());
        assert!(s.model().sims.is_empty());
        assert_eq!(s.model().configs.len(), 1);
        let (_, r) = s.evaluated(Some("default")).unwrap();
        assert!(
            r.diagnostics.iter().any(|d| d.code == "RW-E100"),
            "{:?}",
            r.diagnostics
        );
    }

    #[test]
    fn every_template_checks_clean_in_every_configuration() {
        // `empty` has no rocket to check yet; its own test pins what it reports.
        for t in template_names().into_iter().filter(|t| *t != "empty") {
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
