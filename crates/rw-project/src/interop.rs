//! `import_file` and `export_file` bodies (M2.5, M2.6), shared by the
//! [`crate::Session`] commands and `rw import ork` into a new directory.
//!
//! Import computes a [`Plan`]: the complete target source set (an `.ork`
//! replaces the rocket, configurations, and simulations; a motor file adds
//! one library file) plus the library files to write. The session applies
//! it as one history step through the normal mutation pipeline.
//!
//! Motor curves for an `.ork` resolve in order: embedded in the file, the
//! local ThrustCurve cache ([`DirCache`]: `$RW_MOTOR_CACHE`, then
//! `.rw/cache/thrustcurve/`; filled only under `make parity` or an approved
//! call, never by the importer), else the nearest generic curve
//! (`RW-W103 motor-substituted`).
//!
//! Export writes `.ork` (zip; our own writer, [`rw_ork::export`]), RASP
//! `.eng`, GLB, binary STL (millimetres), or a run's series CSV.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rw_api::{ApiError, ApiErrorCode};
use rw_model::patch::main_rocket_path;
use rw_model::{
    Component, Diagnostic, EvaluatedModel, ModelValue, ProjectManifest, SourceDoc, SourceSet,
};
use rw_motor::{MotorSource, ThrustCurve};
use rw_ork::export::ExportMotor;
use rw_ork::{CachedMotor, ImportOptions, MotorCache, MotorKey};

use crate::container;
use crate::layout::sha256_hex;
use crate::library::Library;

fn err(code: ApiErrorCode, message: impl Into<String>) -> ApiError {
    ApiError {
        outcome: None,
        code,
        message: message.into(),
        hint: None,
        diagnostics: Vec::new(),
    }
}

fn hinted(mut e: ApiError, hint: &str) -> ApiError {
    e.hint = Some(hint.to_string());
    e
}

// ---- motor cache ------------------------------------------------------------------

/// Directories of downloaded `.eng`/`.rse` files, searched in order.
#[derive(Debug, Clone, Default)]
pub struct DirCache {
    pub dirs: Vec<PathBuf>,
}

/// The project-local cache directory.
pub const CACHE_DIR: &str = ".rw/cache/thrustcurve";

impl DirCache {
    /// `$RW_MOTOR_CACHE` (`:`-separated) then `<root>/.rw/cache/thrustcurve`.
    pub fn for_project(root: &Path) -> DirCache {
        let mut dirs: Vec<PathBuf> = std::env::var_os("RW_MOTOR_CACHE")
            .map(|v| std::env::split_paths(&v).collect())
            .unwrap_or_default();
        dirs.push(root.join(CACHE_DIR));
        DirCache { dirs }
    }

    fn files(&self) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        for d in &self.dirs {
            let Ok(rd) = std::fs::read_dir(d) else {
                continue;
            };
            let mut names: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let l = p.to_string_lossy().to_ascii_lowercase();
                    l.ends_with(".eng") || l.ends_with(".rse")
                })
                .collect();
            names.sort();
            for p in names {
                if let Ok(b) = std::fs::read(&p) {
                    let name = p
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    out.push((name, b));
                }
            }
        }
        out
    }
}

fn parse_motor(name: &str, bytes: &[u8], source: MotorSource) -> Vec<ThrustCurve> {
    let text = String::from_utf8_lossy(bytes);
    if name.to_ascii_lowercase().ends_with(".eng") {
        rw_motor::parse_eng(&text, source).unwrap_or_default()
    } else {
        rw_motor::parse_rse(&text, source).unwrap_or_default()
    }
}

impl MotorCache for DirCache {
    fn lookup(&self, key: &MotorKey) -> Option<CachedMotor> {
        let files = self.files();
        let curves = |name: &str, b: &[u8]| {
            parse_motor(
                name,
                b,
                MotorSource::Thrustcurve {
                    motor_id: name.to_string(),
                },
            )
        };
        // A file whose sha256 is the requested digest wins.
        let by_digest = key.digest.as_deref().and_then(|d| {
            files
                .iter()
                .find(|(_, b)| sha256_hex(b).eq_ignore_ascii_case(d))
        });
        let hit = by_digest.or_else(|| {
            files
                .iter()
                .find(|(n, b)| curves(n, b).iter().any(|c| rw_ork::motors::matches(c, key)))
        })?;
        Some(CachedMotor {
            file_name: hit.0.clone(),
            bytes: hit.1.clone(),
        })
    }
}

// ---- import -----------------------------------------------------------------------

/// A computed import.
#[derive(Debug, Clone)]
pub struct Plan {
    /// The full source set after the import.
    pub target: SourceSet,
    /// Library files to write (project-relative path → bytes).
    pub lib_files: BTreeMap<String, Vec<u8>>,
    /// Imported component ids (`.ork`) or motor designations (motor file).
    pub imported: Vec<String>,
    /// Import findings (`RW-W010`, `RW-W103`).
    pub diagnostics: Vec<Diagnostic>,
    /// Step title.
    pub title: String,
}

/// Reads an import source file (`path` absolute, or relative to `root`).
pub fn read_input(root: &Path, path: &str) -> Result<(PathBuf, Vec<u8>), ApiError> {
    let p = Path::new(path);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    };
    let bytes = std::fs::read(&abs).map_err(|e| {
        hinted(
            err(
                ApiErrorCode::Io,
                format!("cannot read {}: {e}", abs.display()),
            ),
            "pass an absolute path, or one relative to the project root",
        )
    })?;
    Ok((abs, bytes))
}

fn manifest_of(sources: &SourceSet) -> Option<(String, ProjectManifest)> {
    sources.docs.iter().find_map(|(p, d)| match d {
        SourceDoc::Project(m) => Some((p.clone(), m.clone())),
        _ => None,
    })
}

/// Moves imported motor files whose path is taken on disk by different
/// bytes to a free name, rewriting the configurations' refs.
fn dodge_collisions(imp: &mut rw_ork::OrkImport, disk_lib: &BTreeMap<String, Vec<u8>>) {
    let mut renames: Vec<(String, String)> = Vec::new();
    let mut files = BTreeMap::new();
    for (p, b) in std::mem::take(&mut imp.lib_files) {
        let mut path = p.clone();
        let (stem, ext) = p.rsplit_once('.').unwrap_or((p.as_str(), ""));
        let mut n = 2;
        while disk_lib.get(&path).is_some_and(|d| *d != b) || files.contains_key(&path) {
            path = format!("{stem}_{n}.{ext}");
            n += 1;
        }
        if path != p {
            renames.push((p.clone(), path.clone()));
        }
        files.insert(path, b);
    }
    imp.lib_files = files;
    for (from, to) in renames {
        let (from, to) = (
            format!("lib:{}#", from.trim_start_matches("lib/")),
            format!("lib:{}#", to.trim_start_matches("lib/")),
        );
        for c in imp.configs.values_mut() {
            for m in c.motors.values_mut() {
                if let Some(r) = m.motor.as_mut()
                    && r.starts_with(&from)
                {
                    *r = r.replacen(&from, &to, 1);
                }
            }
        }
        for u in &mut imp.motors {
            if u.motor_ref.starts_with(&from) {
                u.motor_ref = u.motor_ref.replacen(&from, &to, 1);
            }
        }
    }
}

/// Plans an `.ork` import over `current` (empty for a new project).
pub fn plan_ork(
    bytes: &[u8],
    source_name: &str,
    current: &SourceSet,
    disk_lib: &BTreeMap<String, Vec<u8>>,
    cache: &dyn MotorCache,
) -> Result<Plan, ApiError> {
    let files = container::read_container(bytes).map_err(|m| {
        hinted(
            err(ApiErrorCode::InvalidInput, format!("{source_name}: {m}")),
            "pass an OpenRocket .ork file (zip, gzip, or XML)",
        )
    })?;
    let mut imp = rw_ork::import(&files, &ImportOptions { cache }).map_err(|e| {
        hinted(
            err(ApiErrorCode::InvalidInput, format!("{source_name}: {e}")),
            "pass an OpenRocket .ork file",
        )
    })?;
    dodge_collisions(&mut imp, disk_lib);
    let fresh = imp.source_set(None);
    let mut target = SourceSet::default();
    // The manifest: the project's own (name, units, comments kept), else new.
    let (mpath, mut manifest) = manifest_of(current)
        .unwrap_or_else(|| manifest_of(&fresh).expect("the import has a manifest"));
    manifest.default_config = imp.default_config.clone();
    if !imp.lib_files.is_empty() {
        let lib = manifest.lib.get_or_insert_with(Default::default);
        for (p, b) in &imp.lib_files {
            lib.sha256.insert(p.clone(), sha256_hex(b));
        }
    }
    let rocket_path = main_rocket_path(current).unwrap_or_else(|| "rocket.rw.toml".into());
    if manifest.model.as_deref().is_some_and(|m| m != rocket_path) {
        manifest.model = Some(rocket_path.clone());
    }
    target.docs.insert(mpath, SourceDoc::Project(manifest));
    // Engines are not part of an .ork: keep them.
    for (p, d) in &current.docs {
        if matches!(d, SourceDoc::Engine(_)) {
            target.docs.insert(p.clone(), d.clone());
        }
    }
    for (p, d) in fresh.docs {
        match d {
            SourceDoc::Project(_) => {}
            SourceDoc::Rocket(r) => {
                target
                    .docs
                    .insert(rocket_path.clone(), SourceDoc::Rocket(r));
            }
            other => {
                target.docs.insert(p, other);
            }
        }
    }
    Ok(Plan {
        target,
        lib_files: imp.lib_files.clone(),
        imported: imp.rocket.c.keys().cloned().collect(),
        diagnostics: imp.diagnostics.clone(),
        title: format!("Import {source_name}"),
    })
}

// ---- export -----------------------------------------------------------------------

/// RASP `.eng` text for `curves` (one block each).
pub fn rasp(curves: &[ThrustCurve]) -> String {
    let mut s = String::from("; Exported by RocketWright\n");
    for c in curves {
        let delays = if c.delays.is_empty() {
            "P".to_string()
        } else {
            c.delays
                .iter()
                .map(|d| rw_units::format_number(*d))
                .collect::<Vec<_>>()
                .join("-")
        };
        let maker = c
            .manufacturer
            .as_deref()
            .map(|m| m.split_whitespace().collect::<Vec<_>>().join("_"))
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "RocketWright".into());
        let name: String = c.designation.split_whitespace().collect();
        s.push_str(&format!(
            "{name} {} {} {delays} {} {} {maker}\n",
            rw_units::format_number(c.diameter * 1000.0),
            rw_units::format_number(c.length * 1000.0),
            rw_units::format_number(c.prop_mass),
            rw_units::format_number(c.total_mass),
        ));
        for p in c.points.iter().filter(|p| p.t > 0.0 || p.thrust > 0.0) {
            s.push_str(&format!(
                "   {} {}\n",
                rw_units::format_number(p.t),
                rw_units::format_number(p.thrust)
            ));
        }
        s.push_str(";\n");
    }
    s
}

/// Binary STL of every non-cut component instance, in millimetres, body
/// frame (+X aft from the nose tip, +Z up).
pub fn stl(geometry: &rw_geom::Geometry, segments: u32) -> Vec<u8> {
    let mut tris: Vec<[[f32; 3]; 3]> = Vec::new();
    for c in geometry.components.iter().filter(|c| !c.cut) {
        let m = rw_geom::glb::component_mesh(c, segments);
        let identity = [rw_geom::InstanceGeometry {
            offset: [0.0; 3],
            roll: 0.0,
        }];
        let insts: &[rw_geom::InstanceGeometry] = if c.instances.is_empty() {
            &identity
        } else {
            &c.instances
        };
        for inst in insts {
            let (s, co) = inst.roll.sin_cos();
            let place = |p: [f32; 3]| -> [f32; 3] {
                let (x, y, z) = (f64::from(p[0]), f64::from(p[1]), f64::from(p[2]));
                [
                    ((x + inst.offset[0]) * 1000.0) as f32,
                    ((co * y - s * z + inst.offset[1]) * 1000.0) as f32,
                    ((s * y + co * z + inst.offset[2]) * 1000.0) as f32,
                ]
            };
            for t in m.indices.chunks_exact(3) {
                tris.push([
                    place(m.positions[t[0] as usize]),
                    place(m.positions[t[1] as usize]),
                    place(m.positions[t[2] as usize]),
                ]);
            }
        }
    }
    let mut out = Vec::with_capacity(84 + tris.len() * 50);
    let mut header = [0u8; 80];
    let h = b"RocketWright STL (mm, body frame +X aft)";
    header[..h.len()].copy_from_slice(h);
    out.extend_from_slice(&header);
    out.extend_from_slice(&(tris.len() as u32).to_le_bytes());
    for t in &tris {
        let u = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
        let v = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        let n = if l > 0.0 { n.map(|x| x / l) } else { [0.0; 3] };
        for f in n.iter().chain(t.iter().flatten()) {
            out.extend_from_slice(&f.to_le_bytes());
        }
        out.extend_from_slice(&0u16.to_le_bytes());
    }
    out
}

/// The motor file behind a curve, for embedding in an `.ork`.
fn motor_file(c: &ThrustCurve, disk_lib: &BTreeMap<String, Vec<u8>>) -> Option<(String, Vec<u8>)> {
    match &c.source {
        MotorSource::Generic { id } => rw_motor::generic::generic_source(id)
            .map(|t| (format!("{id}.rse"), t.as_bytes().to_vec())),
        MotorSource::Library { path } => disk_lib.get(path).map(|b| (path.clone(), b.clone())),
        _ => None,
    }
}

/// The `.ork` container bytes for `model`.
pub fn ork(
    model: &EvaluatedModel,
    sources: &SourceSet,
    library: &Library,
    disk_lib: &BTreeMap<String, Vec<u8>>,
) -> (Vec<u8>, Vec<String>) {
    let mv = ModelValue::from_sources(sources).0;
    let source: BTreeMap<String, Component> = mv
        .get("c")
        .cloned()
        .and_then(|c| serde_json::from_value(c).ok())
        .unwrap_or_default();
    let motors = |r: &str| {
        library.motor(r).map(|curve| ExportMotor {
            file: motor_file(&curve, disk_lib),
            curve,
        })
    };
    let creator = format!("RocketWright {}", env!("CARGO_PKG_VERSION"));
    let out = rw_ork::export::write_ork(model, &source, &motors, &creator);
    (
        container::write_container(out.xml.as_bytes(), &out.files),
        out.skipped,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dir_cache_finds_a_motor_by_designation_and_maker() {
        let d = crate::testutil::TempDir::new("motor-cache");
        let eng = "; test\nD12 24 70 0-3-5 0.021 0.043 Nobody\n0.1 20\n0.5 10\n1.6 0\n;\n";
        std::fs::write(d.path().join("Nobody_D12.eng"), eng).unwrap();
        std::fs::write(d.path().join("notes.txt"), "x").unwrap();
        let cache = DirCache {
            dirs: vec![d.path().join("missing"), d.path().to_path_buf()],
        };
        let key = |m: Option<&str>, des: &str| MotorKey {
            manufacturer: m.map(str::to_string),
            designation: des.into(),
            digest: None,
            diameter: None,
            length: None,
        };
        let hit = cache.lookup(&key(Some("Nobody"), "D12-5")).unwrap();
        assert_eq!(hit.file_name, "Nobody_D12.eng");
        assert_eq!(hit.bytes, eng.as_bytes());
        assert!(cache.lookup(&key(Some("Estes"), "D12")).is_none());
        assert!(cache.lookup(&key(None, "C6")).is_none());
        let by_digest = MotorKey {
            digest: Some(sha256_hex(eng.as_bytes())),
            ..key(None, "other")
        };
        assert!(cache.lookup(&by_digest).is_some());
    }

    #[test]
    fn rasp_round_trips_through_the_parser() {
        let c = rw_motor::generic::generic_motor("RW_C6G").unwrap();
        let text = rasp(std::slice::from_ref(&c));
        let back = rw_motor::parse_eng(
            &text,
            MotorSource::Library {
                path: "x.eng".into(),
            },
        )
        .unwrap();
        assert_eq!(back.len(), 1);
        let b = &back[0];
        assert_eq!(b.designation, c.designation);
        assert!((b.total_impulse - c.total_impulse).abs() / c.total_impulse < 1e-3);
        assert!((b.diameter - c.diameter).abs() < 1e-9);
    }
}
