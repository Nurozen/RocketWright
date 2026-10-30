//! Project layout (M1.25b, R2.1, S:64): which files on disk are project
//! sources, which are library files, and what is ignored.
//!
//! ```text
//! rocketwright.toml        manifest; [lib] sha256 per library file
//! rocket.rw.toml           the model (or the manifest's `model`)
//! parts/*.rw.toml          reusable parts, merged by `include` (ids stay unique)
//! configs/ sims/ engines/  one document per id
//! lib/components/*.rw.toml component presets (`[c.<id>]`), searchable
//! lib/materials/*.rw.toml  `[materials.<id>]`, merged into evaluation
//! lib/motors/*.eng|*.rse   motor files, kept verbatim
//! renders/ runs/ .rw/      outputs and state (never sources)
//! ```
//!
//! Sources are the files the [`crate::TomlStore`] edits. Library files are
//! read-only inputs: their sha256 must match `rocketwright.toml [lib]`
//! ([`crate::library`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rw_model::source::doc_kind;
use sha2::Digest;

/// The manifest file name.
pub const MANIFEST: &str = "rocketwright.toml";
/// The JSON twin of the manifest.
pub const MANIFEST_JSON: &str = "rocketwright.json";
/// Library sub-directories, project-relative.
pub const LIB_COMPONENTS: &str = "lib/components";
pub const LIB_MATERIALS: &str = "lib/materials";
pub const LIB_MOTORS: &str = "lib/motors";

/// Top-level directories that never hold sources.
const OUTPUT_DIRS: [&str; 5] = ["runs", "renders", "node_modules", "target", "lib"];
/// How deep the source walk goes (`parts/sub/x.rw.toml` is depth 3).
const MAX_DEPTH: usize = 4;

/// Files read from a project directory.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DiskProject {
    /// Source path → text (UTF-8; a file that is not is reported by the
    /// store as a parse error).
    pub sources: BTreeMap<String, String>,
    /// Library path → bytes.
    pub lib: BTreeMap<String, Vec<u8>>,
}

/// True when `dir` holds a RocketWright manifest.
pub fn is_project(dir: &Path) -> bool {
    dir.join(MANIFEST).is_file() || dir.join(MANIFEST_JSON).is_file()
}

/// The nearest ancestor of `start` (inclusive) that is a project.
pub fn find_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|d| is_project(d))
        .map(Path::to_path_buf)
}

/// `abs` relative to `root`, with `/` separators.
pub fn rel_path(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// True when `p` is a plain project-relative path: not absolute, `/`
/// separators, and no empty, `.`, or `..` segment (it cannot leave the
/// project).
pub fn is_safe_rel(p: &str) -> bool {
    !p.is_empty()
        && !Path::new(p).is_absolute()
        && !p.contains('\\')
        && p.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}

/// Resolves `path` (absolute, or relative to `root`) to an absolute path
/// strictly inside `root` (canonical). `None` when it has a `..` segment or
/// lands outside `root` (symlinks in the existing part are resolved).
pub fn resolve_inside(root: &Path, path: &Path) -> Option<PathBuf> {
    use std::path::Component;
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    // Canonicalize the nearest existing ancestor; keep the rest verbatim.
    let mut existing = abs.as_path();
    let mut rest = Vec::new();
    while !existing.exists() {
        rest.push(existing.file_name()?.to_os_string());
        existing = existing.parent()?;
    }
    let mut real = existing.canonicalize().ok()?;
    for r in rest.iter().rev() {
        real.push(r);
    }
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    (real.starts_with(&root) && real != root).then_some(real)
}

fn hidden_or_temp(seg: &str) -> bool {
    seg.starts_with('.') || seg.ends_with('~') || crate::fsutil::is_temp_name(seg)
}

/// True when a project-relative path is a source file the store edits.
pub fn is_source(rel: &str) -> bool {
    let segs: Vec<&str> = rel.split('/').collect();
    if segs.is_empty()
        || segs.len() > MAX_DEPTH
        || segs.iter().any(|s| s.is_empty() || hidden_or_temp(s))
    {
        return false;
    }
    if segs.len() > 1 && OUTPUT_DIRS.contains(&segs[0]) {
        return false;
    }
    doc_kind(rel).is_some()
}

/// True when a project-relative path is a library file.
pub fn is_lib_file(rel: &str) -> bool {
    let segs: Vec<&str> = rel.split('/').collect();
    if segs.len() < 3 || segs[0] != "lib" || segs.iter().any(|s| s.is_empty() || hidden_or_temp(s))
    {
        return false;
    }
    let name = segs[segs.len() - 1].to_ascii_lowercase();
    match segs[1] {
        "components" | "materials" => name.ends_with(".rw.toml") || name.ends_with(".rw.json"),
        "motors" => name.ends_with(".eng") || name.ends_with(".rse"),
        _ => false,
    }
}

/// True when a change at this path can matter to the session (watcher filter).
pub fn is_relevant(rel: &str) -> bool {
    is_source(rel) || is_lib_file(rel)
}

/// Lower-case sha256 hex of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let d = sha2::Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) -> std::io::Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in rd {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if hidden_or_temp(&name) {
            continue;
        }
        let ft = entry.file_type()?;
        let path = entry.path();
        if ft.is_dir() {
            walk(root, &path, depth + 1, out)?;
        } else if ft.is_file()
            && let Some(rel) = rel_path(root, &path)
        {
            out.push(rel);
        }
    }
    Ok(())
}

/// Reads every source and library file under `root`.
pub fn read_project(root: &Path) -> std::io::Result<DiskProject> {
    let mut paths = Vec::new();
    walk(root, root, 1, &mut paths)?;
    paths.sort();
    let mut out = DiskProject::default();
    for rel in paths {
        if is_source(&rel) {
            let bytes = match std::fs::read(root.join(&rel)) {
                Ok(b) => b,
                // Deleted between the listing and the read.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            out.sources
                .insert(rel, String::from_utf8_lossy(&bytes).into_owned());
        } else if is_lib_file(&rel) {
            match std::fs::read(root.join(&rel)) {
                Ok(b) => {
                    out.lib.insert(rel, b);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{TempDir, fixture_project};

    #[test]
    fn classifies_paths() {
        for p in [
            "rocketwright.toml",
            "rocket.rw.toml",
            "parts/fin_can.rw.toml",
            "configs/baseline.rw.toml",
            "sims/baseline.rw.json",
            "engines/main.rw.toml",
        ] {
            assert!(is_source(p), "{p}");
            assert!(!is_lib_file(p), "{p}");
        }
        for p in [
            "lib/materials/woods.rw.toml",
            "lib/components/bt55.rw.toml",
            "lib/motors/RW_A8G.eng",
            "lib/motors/vendor/X.rse",
        ] {
            assert!(is_lib_file(p), "{p}");
            assert!(!is_source(p), "{p}");
        }
        for p in [
            ".rw/history/steps.jsonl",
            "runs/baseline/abc/summary.rw.json",
            "renders/manifest.json",
            "parts/.fin_can.rw.toml.swp",
            "parts/.fin_can.rw.toml.rw-tmp-12",
            "rocket.rw.toml~",
            "notes.md",
            "lib/motors/PROVENANCE.md",
            "lib/other/x.rw.toml",
        ] {
            assert!(!is_relevant(p), "{p}");
        }
    }

    #[test]
    fn reads_sources_and_lib_and_skips_outputs() {
        let dir = TempDir::new("layout");
        fixture_project(dir.path());
        std::fs::create_dir_all(dir.path().join("lib/motors")).unwrap();
        std::fs::write(
            dir.path().join("lib/motors/X1.eng"),
            b"X1 18 70 0 0.01 0.02 T\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("runs/baseline/r1")).unwrap();
        std::fs::write(dir.path().join("runs/baseline/r1/x.rw.toml"), b"junk").unwrap();
        std::fs::create_dir_all(dir.path().join(".rw")).unwrap();
        std::fs::write(dir.path().join(".rw/x.rw.toml"), b"junk").unwrap();
        let p = read_project(dir.path()).unwrap();
        assert_eq!(
            p.sources.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "configs/baseline.rw.toml",
                "parts/fin_can.rw.toml",
                "rocket.rw.toml",
                "rocketwright.toml",
                "sims/baseline.rw.toml"
            ]
        );
        assert_eq!(p.lib.keys().collect::<Vec<_>>(), ["lib/motors/X1.eng"]);
        assert!(is_project(dir.path()));
        assert_eq!(
            find_root(&dir.path().join("parts")).as_deref(),
            Some(dir.path())
        );
    }

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn tampered_lib_file_gives_lib_hash_diagnostic() {
        use rw_model::diag::{E_LIB_HASH, W_LIB_UNRECORDED};
        let dir = TempDir::new("layout-lib");
        fixture_project(dir.path());
        let mat = "[materials.birch]\ndensity = \"670 kg/m^3\"\n";
        std::fs::create_dir_all(dir.path().join("lib/materials")).unwrap();
        std::fs::write(dir.path().join("lib/materials/woods.rw.toml"), mat).unwrap();
        let ctx = rw_api::CallCtx {
            origin: rw_api::Origin::Cli,
            thread: None,
            tool_call: None,
            label: None,
        };
        let mut w = crate::Session::open(dir.path(), crate::SessionOptions::writer()).unwrap();
        let out = w.lib_record(&ctx, false).unwrap();
        assert_eq!(out.files.len(), 1, "rocketwright.toml gains [lib.sha256]");
        assert!(
            w.model()
                .diagnostics
                .iter()
                .all(|d| d.code != W_LIB_UNRECORDED)
        );
        drop(w);
        let manifest = std::fs::read_to_string(dir.path().join("rocketwright.toml")).unwrap();
        assert!(
            manifest.contains("lib/materials/woods.rw.toml"),
            "{manifest}"
        );
        assert!(
            manifest.contains("# project name"),
            "comments kept: {manifest}"
        );
        let s = crate::Session::open(dir.path(), crate::SessionOptions::read_only()).unwrap();
        assert!(
            s.model().diagnostics.iter().all(|d| d.code != E_LIB_HASH),
            "{:?}",
            s.model().diagnostics
        );
        assert!(
            s.model().materials.contains_key("birch"),
            "lib materials merge into eval"
        );
        drop(s);

        // Tamper with the file: the recorded hash no longer matches.
        std::fs::write(
            dir.path().join("lib/materials/woods.rw.toml"),
            mat.replace("670", "1670"),
        )
        .unwrap();
        // And add a file nobody recorded.
        std::fs::write(
            dir.path().join("lib/materials/extra.rw.toml"),
            "[materials.ash]\ndensity = \"700 kg/m^3\"\n",
        )
        .unwrap();
        let s = crate::Session::open(dir.path(), crate::SessionOptions::read_only()).unwrap();
        let d: Vec<_> = s
            .model()
            .diagnostics
            .iter()
            .filter(|d| d.code == E_LIB_HASH || d.code == W_LIB_UNRECORDED)
            .collect();
        assert_eq!(d.len(), 2, "{d:?}");
        let by_file: std::collections::BTreeMap<_, _> = d
            .iter()
            .map(|d| (d.file.as_deref().unwrap(), d.code.as_str()))
            .collect();
        assert_eq!(by_file["lib/materials/woods.rw.toml"], E_LIB_HASH);
        assert_eq!(by_file["lib/materials/extra.rw.toml"], W_LIB_UNRECORDED);
        assert!(
            !s.model().materials.contains_key("birch"),
            "a tampered file is not merged"
        );
        assert_eq!(
            s.model().model_hash,
            rw_model::model_hash(s.model()),
            "the hash covers the lib diagnostics"
        );
    }
}
