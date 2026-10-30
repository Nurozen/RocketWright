//! Where the compiled CEA databases (`thermo.lib`, `trans.lib`) live at run
//! time (M4.1b).
//!
//! They are compiler-ABI specific (Fortran unformatted records), so they are
//! built by this crate's build script with the same gfortran as the linked
//! library and are never committed or linked into the binary. A shipped
//! binary finds them, in order:
//!
//! 1. `$RW_CEA_DATA` (an absolute directory). When set it is authoritative:
//!    an unusable value is an error, never a silent fallback.
//! 2. Beside the binary: `<exe dir>/../share/rocketwright/cea/` (the kit and
//!    `make cea-data` layout: `bin/rocketwright` + `share/rocketwright/cea/`).
//! 3. The app bundle: `<X>.app/Contents/Resources/cea/` when the executable
//!    lives anywhere inside `<X>.app/Contents/`.
//!
//! Never a build-tree path: [`crate::BUILD_DATA_DIR`] is for in-tree tests and
//! table generation only. The executable path is canonicalized first, so a
//! symlink such as `rw -> rocketwright` resolves to the real binary.
//!
//! This module is plain path logic and builds with or without the `cea`
//! feature.

use std::path::{Path, PathBuf};

use crate::problem::CeaError;

/// The environment variable that overrides the data location.
pub const DATA_ENV: &str = "RW_CEA_DATA";
/// The install layout relative to the binary's directory's parent
/// (`<prefix>/bin/<exe>` -> `<prefix>/share/rocketwright/cea`).
pub const SHARE_REL: &str = "share/rocketwright/cea";
/// The compiled database files, in load order.
pub const DATA_FILES: [&str; 2] = ["thermo.lib", "trans.lib"];

/// Whether `dir` holds both compiled databases.
pub fn has_data(dir: &Path) -> bool {
    DATA_FILES.iter().all(|f| dir.join(f).is_file())
}

/// The candidate directories for an executable at `exe` (already
/// canonicalized), after `$RW_CEA_DATA`: beside the binary, then the app
/// bundle's `Resources/cea`.
pub fn candidates_for_exe(exe: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    // Lexical parent: `exe` is canonical, so `<bin>/..` is its grandparent.
    if let Some(prefix) = exe.parent().and_then(Path::parent) {
        out.push(prefix.join(SHARE_REL));
    }
    // <X>.app/Contents/<anything>/exe -> <X>.app/Contents/Resources/cea
    for anc in exe.ancestors().skip(1) {
        if anc.file_name().is_some_and(|n| n == "Contents")
            && anc
                .parent()
                .and_then(|p| p.extension())
                .is_some_and(|e| e == "app")
        {
            out.push(anc.join("Resources/cea"));
            break;
        }
    }
    out
}

/// Resolves the data directory from an explicit environment value and
/// executable path (the testable core of [`locate_data_dir`]).
pub fn locate_with(env: Option<&Path>, exe: Option<&Path>) -> Result<PathBuf, CeaError> {
    if let Some(d) = env {
        if !d.is_absolute() {
            return Err(CeaError::DataDir {
                dir: d.to_path_buf(),
                reason: format!("${DATA_ENV} must be an absolute path"),
            });
        }
        if !has_data(d) {
            return Err(CeaError::DataDir {
                dir: d.to_path_buf(),
                reason: format!("${DATA_ENV} does not hold thermo.lib and trans.lib"),
            });
        }
        return Ok(d.to_path_buf());
    }
    let mut tried = Vec::new();
    if let Some(exe) = exe {
        for c in candidates_for_exe(exe) {
            if has_data(&c) {
                // Absolute and free of `..` (cea_init_thermo gets this path).
                return c.canonicalize().map_err(|e| CeaError::DataDir {
                    dir: c.clone(),
                    reason: e.to_string(),
                });
            }
            tried.push(c);
        }
    }
    Err(CeaError::DataNotFound { tried })
}

/// Locates the compiled databases for this process (`$RW_CEA_DATA`, beside
/// the binary, app `Resources/`).
pub fn locate_data_dir() -> Result<PathBuf, CeaError> {
    let env = std::env::var_os(DATA_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    let exe = std::env::current_exe()
        .ok()
        .and_then(|e| e.canonicalize().ok());
    locate_with(env.as_deref(), exe.as_deref())
}

/// Installs the databases from `from` into `<prefix>/share/rocketwright/cea/`
/// (the layout [`locate_data_dir`] finds from `<prefix>/bin/<exe>`). Returns
/// the destination directory.
pub fn install_data(from: &Path, prefix: &Path) -> std::io::Result<PathBuf> {
    let dest = prefix.join(SHARE_REL);
    std::fs::create_dir_all(&dest)?;
    for f in DATA_FILES {
        let to = dest.join(f);
        if to.exists() {
            std::fs::remove_file(&to)?;
        }
        std::fs::copy(from.join(f), &to)?;
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rw-cea-data-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn fake_db(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        for f in DATA_FILES {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
    }

    #[test]
    fn candidates_beside_binary_then_app_resources() {
        let c = candidates_for_exe(Path::new("/opt/kit/bin/rocketwright"));
        assert_eq!(c, [PathBuf::from("/opt/kit/share/rocketwright/cea")]);
        let c = candidates_for_exe(Path::new(
            "/Applications/RocketWright.app/Contents/Resources/bin/rocketwright",
        ));
        assert_eq!(
            c,
            [
                PathBuf::from(
                    "/Applications/RocketWright.app/Contents/Resources/share/rocketwright/cea"
                ),
                PathBuf::from("/Applications/RocketWright.app/Contents/Resources/cea"),
            ]
        );
    }

    #[test]
    fn env_wins_and_is_authoritative() {
        let root = tmp("env");
        let env_db = root.join("env");
        fake_db(&env_db);
        let kit = root.join("kit");
        fake_db(&kit.join("share/rocketwright/cea"));
        let exe = kit.join("bin/rocketwright");
        assert_eq!(locate_with(Some(&env_db), Some(&exe)).unwrap(), env_db);
        // Set but unusable: an error, not a fallback to the kit.
        assert!(matches!(
            locate_with(Some(&root.join("missing")), Some(&exe)),
            Err(CeaError::DataDir { .. })
        ));
        assert!(matches!(
            locate_with(Some(Path::new("rel/dir")), Some(&exe)),
            Err(CeaError::DataDir { .. })
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn beside_binary_then_app_bundle_then_not_found() {
        let root = tmp("exe");
        let kit = root.join("kit");
        fake_db(&kit.join("share/rocketwright/cea"));
        assert_eq!(
            locate_with(None, Some(&kit.join("bin/rocketwright"))).unwrap(),
            kit.join("share/rocketwright/cea")
        );
        let app = root.join("RW.app/Contents");
        fake_db(&app.join("Resources/cea"));
        assert_eq!(
            locate_with(None, Some(&app.join("MacOS/rocketwright"))).unwrap(),
            app.join("Resources/cea")
        );
        match locate_with(None, Some(&root.join("elsewhere/bin/rocketwright"))) {
            Err(CeaError::DataNotFound { tried }) => assert_eq!(tried.len(), 1),
            other => panic!("expected DataNotFound, got {other:?}"),
        }
        assert!(matches!(
            locate_with(None, None),
            Err(CeaError::DataNotFound { .. })
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_creates_share_layout() {
        let root = tmp("install");
        let src = root.join("src");
        fake_db(&src);
        let dest = install_data(&src, &root.join("prefix")).unwrap();
        assert_eq!(dest, root.join("prefix/share/rocketwright/cea"));
        assert!(has_data(&dest));
        // Idempotent (overwrites).
        install_data(&src, &root.join("prefix")).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }
}
