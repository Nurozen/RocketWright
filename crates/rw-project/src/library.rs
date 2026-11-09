//! The project library (M1.25b, R2.1): `lib/components`, `lib/materials`,
//! and `lib/motors`, each file pinned by a sha256 in `rocketwright.toml
//! [lib]`.
//!
//! - A recorded hash that does not match the file, or a recorded file that is
//!   missing, is `RW-E006 lib-hash` (error); the file is not used.
//! - A library file with no recorded hash is `RW-W003 lib-unrecorded`
//!   (warning); it is used.
//! - Materials from library files merge into evaluation as defaults: a
//!   `[materials.<id>]` in the project's own sources wins.
//! - Component presets and motors are searchable (`rw lib search|show`,
//!   `library_search`); they are not part of the tree until a component is
//!   added from one.
//!
//! (Named `library` because `lib.rs` is the crate root.)

use std::collections::BTreeMap;

use rw_api::{FacetCount, LibItem, LibKind, LibraryFacets, LibrarySearchIn, LibrarySearchOut};
use rw_model::diag::{self, Diagnostic};
use rw_model::patch::main_rocket_path;
use rw_model::source::parse_source;
use rw_model::{LibManifest, RocketDoc, SourceDoc, SourceSet};
use rw_motor::{MotorSource, ThrustCurve};
use serde_json::{Value, json};

use crate::layout::{LIB_MOTORS, sha256_hex};

/// Hash state of one library file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LibHash {
    /// Matches `[lib.sha256]`.
    Verified,
    /// Not in `[lib.sha256]` (`RW-W003`).
    Unrecorded,
    /// Differs from `[lib.sha256]` (`RW-E006`); not used.
    Mismatch,
}

/// One file under `lib/`.
#[derive(Debug, Clone, PartialEq)]
pub struct LibFile {
    pub path: String,
    pub kind: LibKind,
    pub sha256: String,
    pub hash: LibHash,
    /// Parsed `*.rw.toml` / `*.rw.json` (components and materials).
    pub doc: Option<RocketDoc>,
    /// Motor header fields (motors).
    pub motor: Option<Value>,
    /// Parsed thrust curves (motors).
    pub curves: Vec<ThrustCurve>,
}

impl LibFile {
    /// Used by evaluation and listed as trusted.
    pub fn usable(&self) -> bool {
        self.hash != LibHash::Mismatch
    }
}

/// The loaded library and its diagnostics.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Library {
    pub files: Vec<LibFile>,
    pub diagnostics: Vec<Diagnostic>,
}

fn kind_of(path: &str) -> LibKind {
    if path.starts_with("lib/components/") {
        LibKind::Component
    } else if path.starts_with("lib/materials/") {
        LibKind::Material
    } else {
        LibKind::Motor
    }
}

/// The manifest's `[lib]`, if any.
pub fn manifest_lib(sources: &SourceSet) -> Option<&LibManifest> {
    sources.docs.values().find_map(|d| match d {
        SourceDoc::Project(m) => m.lib.as_ref(),
        _ => None,
    })
}

fn lib_diag(code: &str, path: &str, message: String, hint: &str) -> Diagnostic {
    let mut d = Diagnostic::new(code, "/project/lib/sha256".to_string(), message).with_hint(hint);
    d.file = Some(path.to_string());
    d
}

/// Header fields of a RASP `.eng` file (first non-comment line):
/// `name diameter_mm length_mm delays propellant_kg total_kg manufacturer`.
fn eng_header(text: &str) -> Option<Value> {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with(';'))?;
    let f: Vec<&str> = line.split_whitespace().collect();
    if f.len() < 7 {
        return None;
    }
    let num = |s: &str| s.parse::<f64>().ok();
    Some(json!({
        "format": "eng",
        "designation": f[0],
        "diameter_mm": num(f[1]),
        "length_mm": num(f[2]),
        "delays": f[3],
        "propellant_kg": num(f[4]),
        "total_kg": num(f[5]),
        "manufacturer": f[6..].join(" "),
    }))
}

/// Presets a `library_search` without a `limit` lists (the catalogs hold
/// thousands of parts; narrow with a filter, or page with `limit` and
/// `offset`).
pub const DEFAULT_PRESET_LIMIT: usize = 100;

/// A motor file's format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotorDialect {
    /// RASP `.eng`.
    Eng,
    /// RockSim `.rse` (XML).
    Rse,
}

impl MotorDialect {
    fn ext(self) -> &'static str {
        match self {
            MotorDialect::Eng => "eng",
            MotorDialect::Rse => "rse",
        }
    }
}

/// A motor file checked for import into `lib/motors/` (M2.14).
#[derive(Debug, Clone, PartialEq)]
pub struct MotorImport {
    /// Destination, `lib/motors/<file>.<eng|rse>`.
    pub path: String,
    pub dialect: MotorDialect,
    pub sha256: String,
    /// Designations of the curves in the file, in file order.
    pub designations: Vec<String>,
}

impl MotorImport {
    /// Motor refs (`lib:motors/<file>#<designation>`) for configurations,
    /// `motor_show`, and `motor_search`.
    pub fn refs(&self) -> Vec<String> {
        let path = self.path.strip_prefix("lib/").unwrap_or(&self.path);
        self.designations
            .iter()
            .map(|d| format!("lib:{path}#{d}"))
            .collect()
    }
}

/// A file name safe under `lib/motors/`: the last path component, with
/// characters other than ASCII letters, digits, `.`, `-`, and `_` replaced
/// by `_` and leading dots dropped.
fn safe_file_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let s: String = last
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let s = s.trim_start_matches('.').to_string();
    if s.is_empty() { "motor".into() } else { s }
}

fn dialect_diag(file: &str, message: String) -> Box<Diagnostic> {
    let mut d = Diagnostic::new(diag::E_MOTOR_DIALECT, String::new(), message).with_hint(
        "RocketWright imports RASP .eng and RockSim .rse motor files; export the curve in one of those formats",
    );
    d.file = Some(file.to_string());
    Box::new(d)
}

/// Checks a motor file for import: the dialect from the extension (`.eng`,
/// `.rse`), or from the content when the extension is neither (`<` opens a
/// RockSim XML file, otherwise RASP is tried). The file must parse as that
/// dialect and hold at least one curve; otherwise `RW-E008 motor-dialect`.
pub fn plan_motor_import(file_name: &str, bytes: &[u8]) -> Result<MotorImport, Box<Diagnostic>> {
    let name = safe_file_name(file_name);
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Err(dialect_diag(
            file_name,
            format!("`{file_name}` is not a text motor file (not UTF-8)"),
        ));
    };
    let ext = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => e.to_ascii_lowercase(),
        _ => String::new(),
    };
    let by_ext = match ext.as_str() {
        "eng" => Some(MotorDialect::Eng),
        "rse" => Some(MotorDialect::Rse),
        _ => None,
    };
    let dialect = by_ext.unwrap_or_else(|| {
        if text.trim_start().starts_with('<') {
            MotorDialect::Rse
        } else {
            MotorDialect::Eng
        }
    });
    let path = match by_ext {
        Some(_) => format!("{LIB_MOTORS}/{name}"),
        None => format!("{LIB_MOTORS}/{name}.{}", dialect.ext()),
    };
    let source = MotorSource::Library { path: path.clone() };
    let parsed = match dialect {
        MotorDialect::Eng => rw_motor::parse_eng(text, source),
        MotorDialect::Rse => rw_motor::parse_rse(text, source),
    };
    let what = match dialect {
        MotorDialect::Eng => "RASP .eng",
        MotorDialect::Rse => "RockSim .rse",
    };
    let curves = match parsed {
        Ok(c) if !c.is_empty() => c,
        Ok(_) => {
            return Err(dialect_diag(
                file_name,
                format!("`{file_name}` holds no {what} thrust curve"),
            ));
        }
        Err(e) if by_ext.is_none() => {
            return Err(dialect_diag(
                file_name,
                format!(
                    "unknown motor file dialect: `{file_name}` has extension `{ext}` and does not parse as {what} (line {}: {})",
                    e.line, e.message
                ),
            ));
        }
        Err(e) => {
            return Err(dialect_diag(
                file_name,
                format!(
                    "`{file_name}` does not parse as {what} (line {}: {})",
                    e.line, e.message
                ),
            ));
        }
    };
    Ok(MotorImport {
        path,
        dialect,
        sha256: sha256_hex(bytes),
        designations: curves.into_iter().map(|c| c.designation).collect(),
    })
}

/// Whether `item` is of `kind` (when given) and contains `query`
/// (case-insensitive, over id, name, and data; blank matches all).
fn matches(item: &LibItem, query: Option<&str>, kind: Option<LibKind>) -> bool {
    if kind.is_some_and(|k| item.kind != k) {
        return false;
    }
    let Some(q) = query
        .map(|q| q.trim().to_lowercase())
        .filter(|q| !q.is_empty())
    else {
        return true;
    };
    item.id.to_lowercase().contains(&q)
        || item.name.to_lowercase().contains(&q)
        || item.data.to_string().to_lowercase().contains(&q)
}

/// A preset's catalog manufacturer.
fn item_manufacturer(item: &LibItem) -> Option<&str> {
    item.data.get("preset")?.get("manufacturer")?.as_str()
}

/// A part's component type; materials and motors have none.
fn item_component_type(item: &LibItem) -> Option<&str> {
    item.data.get("type")?.as_str()
}

/// A filter value, with blank meaning no filter (as for `query`).
fn wanted(filter: Option<&str>) -> Option<&str> {
    filter.map(str::trim).filter(|f| !f.is_empty())
}

fn same(value: &str, filter: &str) -> bool {
    value.eq_ignore_ascii_case(filter)
}

fn facet(counts: BTreeMap<&str, u32>) -> Vec<FacetCount> {
    counts
        .into_iter()
        .map(|(value, count)| FacetCount {
            value: value.to_string(),
            count,
        })
        .collect()
}

impl Library {
    /// Loads `lib` (path → bytes) against the manifest's recorded hashes.
    pub fn load(lib: &BTreeMap<String, Vec<u8>>, manifest: Option<&LibManifest>) -> Library {
        let recorded: BTreeMap<&str, &str> = manifest
            .map(|m| {
                m.sha256
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.as_str()))
                    .collect()
            })
            .unwrap_or_default();
        let mut out = Library::default();
        for (path, bytes) in lib {
            let sha = sha256_hex(bytes);
            let hash = match recorded.get(path.as_str()) {
                Some(r) if r.eq_ignore_ascii_case(&sha) => LibHash::Verified,
                Some(r) => {
                    out.diagnostics.push(lib_diag(
                        diag::E_LIB_HASH,
                        path,
                        format!("`{path}` has sha256 {sha}, but rocketwright.toml [lib] records {r}; the file is not used"),
                        "restore the original file, or record the new sha256 in rocketwright.toml [lib.sha256] if the change is intended",
                    ));
                    LibHash::Mismatch
                }
                None => {
                    out.diagnostics.push(lib_diag(
                        diag::W_LIB_UNRECORDED,
                        path,
                        format!("`{path}` has no sha256 in rocketwright.toml [lib]"),
                        "record its sha256 under rocketwright.toml [lib.sha256] so later changes are detected",
                    ));
                    LibHash::Unrecorded
                }
            };
            let kind = kind_of(path);
            let text = String::from_utf8_lossy(bytes);
            let mut curves = Vec::new();
            let (doc, motor) = if path.starts_with(LIB_MOTORS) {
                let lower = path.to_ascii_lowercase();
                let source = MotorSource::Library { path: path.clone() };
                let (m, parsed) = if lower.ends_with(".eng") {
                    (eng_header(&text), rw_motor::parse_eng(&text, source))
                } else {
                    (
                        Some(json!({"format": "rse"})),
                        rw_motor::parse_rse(&text, source),
                    )
                };
                curves = parsed.unwrap_or_default();
                (None, m)
            } else {
                match parse_source(path, &text) {
                    Ok(SourceDoc::Rocket(d)) => (Some(d), None),
                    Ok(_) => (None, None),
                    Err(ds) => {
                        out.diagnostics.extend(ds.into_iter().map(|mut d| {
                            d.file.get_or_insert_with(|| path.clone());
                            d
                        }));
                        (None, None)
                    }
                }
            };
            out.files.push(LibFile {
                path: path.clone(),
                kind,
                sha256: sha,
                hash,
                doc,
                motor,
                curves,
            });
        }
        for (path, r) in recorded {
            if !lib.contains_key(path) {
                out.diagnostics.push(lib_diag(
                    diag::E_LIB_HASH,
                    path,
                    format!("rocketwright.toml [lib] records `{path}` (sha256 {r}), but the file is missing"),
                    "restore the file, or remove its entry from rocketwright.toml [lib.sha256]",
                ));
            }
        }
        out
    }

    /// The hashes of every library file, for `[lib.sha256]`.
    pub fn hashes(&self) -> BTreeMap<String, String> {
        self.files
            .iter()
            .map(|f| (f.path.clone(), f.sha256.clone()))
            .collect()
    }

    /// Resolves a motor ref to a thrust curve: `generic:<id>`,
    /// `lib:<path>[#<designation>]` (a usable `lib/motors` file; the first
    /// curve unless a designation is given), or a bare designation (`C6`)
    /// matched against library then generic curves.
    pub fn motor(&self, r: &str) -> Option<ThrustCurve> {
        if let Some(id) = r.strip_prefix("generic:") {
            return rw_motor::generic::generic_motor(id);
        }
        let usable = || self.files.iter().filter(|f| f.usable());
        if let Some(rest) = r.strip_prefix("lib:") {
            let (path, name) = match rest.split_once('#') {
                Some((p, n)) => (p, Some(n)),
                None => (rest, None),
            };
            let f = usable().find(|f| f.path == path || f.path == format!("lib/{path}"))?;
            return match name {
                Some(n) => f
                    .curves
                    .iter()
                    .find(|c| c.designation.eq_ignore_ascii_case(n))
                    .cloned(),
                None => f.curves.first().cloned(),
            };
        }
        usable()
            .flat_map(|f| f.curves.iter())
            .find(|c| c.designation.eq_ignore_ascii_case(r))
            .cloned()
            .or_else(|| {
                rw_motor::generic::generic_motors()
                    .into_iter()
                    .find(|c| c.designation.eq_ignore_ascii_case(r))
            })
            .or_else(|| rw_motor::generic::generic_motor(r))
    }

    /// `sources` with library materials merged into the main model document
    /// as defaults (the project's own definitions win).
    pub fn eval_sources(&self, sources: &SourceSet) -> SourceSet {
        let mut out = sources.clone();
        let Some(main) = main_rocket_path(&out) else {
            return out;
        };
        let Some(SourceDoc::Rocket(doc)) = out.docs.get_mut(&main) else {
            return out;
        };
        for f in self.files.iter().filter(|f| f.usable()) {
            if let Some(lib) = &f.doc {
                for (k, m) in &lib.materials {
                    doc.materials.entry(k.clone()).or_insert_with(|| m.clone());
                }
            }
        }
        out
    }

    fn source_label(f: &LibFile) -> String {
        match f.hash {
            LibHash::Verified => "project lib (sha256 verified)".into(),
            LibHash::Unrecorded => "project lib (sha256 not recorded)".into(),
            LibHash::Mismatch => "project lib (sha256 mismatch; not used)".into(),
        }
    }

    /// Every item, in path then id order.
    pub fn items(&self) -> Vec<LibItem> {
        let mut out = Vec::new();
        for f in &self.files {
            let source = Self::source_label(f);
            if let Some(doc) = &f.doc {
                for (id, c) in &doc.c {
                    let data = serde_json::to_value(c).unwrap_or(Value::Null);
                    let name = data
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .to_string();
                    out.push(LibItem {
                        id: format!("lib:{}#{id}", f.path),
                        kind: LibKind::Component,
                        name,
                        source: source.clone(),
                        sha256: Some(f.sha256.clone()),
                        data,
                    });
                }
                for (id, m) in &doc.materials {
                    out.push(LibItem {
                        id: format!("lib:{}#{id}", f.path),
                        kind: LibKind::Material,
                        name: id.clone(),
                        source: source.clone(),
                        sha256: Some(f.sha256.clone()),
                        data: serde_json::to_value(m).unwrap_or(Value::Null),
                    });
                }
            } else if f.kind == LibKind::Motor {
                let data = f.motor.clone().unwrap_or(Value::Null);
                let stem = f
                    .path
                    .rsplit('/')
                    .next()
                    .and_then(|n| n.rsplit_once('.').map(|(s, _)| s))
                    .unwrap_or(&f.path)
                    .to_string();
                let name = data
                    .get("designation")
                    .and_then(Value::as_str)
                    .map(String::from)
                    .unwrap_or(stem);
                out.push(LibItem {
                    id: format!("lib:{}", f.path),
                    kind: LibKind::Motor,
                    name,
                    source,
                    sha256: Some(f.sha256.clone()),
                    data,
                });
            }
        }
        out
    }

    /// Items matching `query` (case-insensitive, over id, name, and data) and
    /// `kind`, at most `limit`.
    pub fn search(
        &self,
        query: Option<&str>,
        kind: Option<LibKind>,
        limit: Option<u32>,
    ) -> Vec<LibItem> {
        let mut out: Vec<LibItem> = self
            .items()
            .into_iter()
            .filter(|i| matches(i, query, kind))
            .collect();
        if let Some(n) = limit {
            out.truncate(n as usize);
        }
        out
    }

    /// `library_search`: the project library, then the built-in presets
    /// ([`crate::presets`]). `offset` and `limit` window the combined list.
    /// Without a `limit`, the window holds every remaining project item and
    /// at most [`DEFAULT_PRESET_LIMIT`] presets. `total` and the facets count
    /// the whole search, not the window.
    pub fn search_with_presets(&self, input: &LibrarySearchIn) -> LibrarySearchOut {
        let query = input.query.as_deref();
        let wanted_maker = wanted(input.manufacturer.as_deref());
        let wanted_type = wanted(input.component_type.as_deref());
        let offset = input.offset.unwrap_or(0);
        let limit = input.limit.map(|n| n as usize);

        let project = self.items();
        let mut items = Vec::new();
        let mut total = 0u32;
        let mut presets_listed = 0;
        let mut manufacturers = BTreeMap::<&str, u32>::new();
        let mut component_types = BTreeMap::<&str, u32>::new();
        for item in project
            .iter()
            .chain(crate::presets::items())
            .filter(|item| matches(item, query, input.kind))
        {
            let maker = item_manufacturer(item);
            let ty = item_component_type(item);
            let maker_ok = wanted_maker.is_none_or(|w| maker.is_some_and(|m| same(m, w)));
            let type_ok = wanted_type.is_none_or(|w| ty.is_some_and(|t| same(t, w)));
            if let Some(m) = maker.filter(|_| type_ok) {
                *manufacturers.entry(m).or_default() += 1;
            }
            if let Some(t) = ty.filter(|_| maker_ok) {
                *component_types.entry(t).or_default() += 1;
            }
            if !(maker_ok && type_ok) {
                continue;
            }
            let position = total;
            total += 1;
            if position < offset {
                continue;
            }
            let is_preset = item.id.starts_with("preset:");
            let has_room = match limit {
                Some(n) => items.len() < n,
                None => !is_preset || presets_listed < DEFAULT_PRESET_LIMIT,
            };
            if has_room {
                presets_listed += usize::from(is_preset);
                items.push(item.clone());
            }
        }
        LibrarySearchOut {
            items,
            total,
            facets: LibraryFacets {
                manufacturers: facet(manufacturers),
                component_types: facet(component_types),
            },
        }
    }

    /// One item by id (`lib:<path>#<id>`, or `lib:<path>` for its first item).
    pub fn show(&self, id: &str) -> Option<LibItem> {
        let items = self.items();
        if let Some(i) = items.iter().find(|i| i.id == id) {
            return Some(i.clone());
        }
        let prefix = format!("{id}#");
        items.into_iter().find(|i| i.id.starts_with(&prefix))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib(files: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
        files
            .iter()
            .map(|(p, t)| (p.to_string(), t.as_bytes().to_vec()))
            .collect()
    }

    #[test]
    fn hashes_classify_and_items_list() {
        let files = lib(&[
            (
                "lib/materials/woods.rw.toml",
                "[materials.birch]\ndensity = \"670 kg/m^3\"\n",
            ),
            (
                "lib/components/tubes.rw.toml",
                "[c.bt55]\nname = \"BT-55\"\ntype = \"body_tube\"\nlength = \"300 mm\"\nod = \"33.7 mm\"\nid = \"32.6 mm\"\n",
            ),
            (
                "lib/motors/RW_A8G.eng",
                "; c\nRW_A8G 18 70 3-5 0.003 0.015 RocketWright\n 0.1 5\n",
            ),
        ]);
        let mut m = LibManifest::default();
        m.sha256.insert(
            "lib/materials/woods.rw.toml".into(),
            sha256_hex(&files["lib/materials/woods.rw.toml"]),
        );
        m.sha256
            .insert("lib/components/tubes.rw.toml".into(), "00".repeat(32));
        let l = Library::load(&files, Some(&m));
        let by_path: BTreeMap<_, _> = l.files.iter().map(|f| (f.path.as_str(), f.hash)).collect();
        assert_eq!(by_path["lib/materials/woods.rw.toml"], LibHash::Verified);
        assert_eq!(by_path["lib/components/tubes.rw.toml"], LibHash::Mismatch);
        assert_eq!(by_path["lib/motors/RW_A8G.eng"], LibHash::Unrecorded);
        let codes: Vec<_> = l.diagnostics.iter().map(|d| d.code.as_str()).collect();
        assert_eq!(codes, ["RW-E006", "RW-W003"]);

        let motors = l.search(None, Some(LibKind::Motor), None);
        assert_eq!(motors.len(), 1);
        assert_eq!(motors[0].name, "RW_A8G");
        assert_eq!(motors[0].data["diameter_mm"], 18.0);
        let tubes = l.search(Some("bt-55"), None, None);
        assert_eq!(tubes.len(), 1);
        assert_eq!(tubes[0].kind, LibKind::Component);
        assert!(tubes[0].source.contains("mismatch"));
        assert_eq!(l.search(None, None, Some(2)).len(), 2);
        assert_eq!(
            l.show("lib:lib/materials/woods.rw.toml").unwrap().id,
            "lib:lib/materials/woods.rw.toml#birch"
        );
        assert!(l.show("lib:nope").is_none());
    }

    fn search(l: &Library, v: Value) -> LibrarySearchOut {
        l.search_with_presets(&serde_json::from_value(v).unwrap())
    }

    fn counted<'a>(facets: &'a [FacetCount], value: &str) -> Option<&'a FacetCount> {
        facets.iter().find(|f| f.value == value)
    }

    fn catalog_preset_count() -> u32 {
        crate::presets::items()
            .iter()
            .filter(|i| i.kind == LibKind::Preset)
            .count() as u32
    }

    #[test]
    fn filters_presets_by_manufacturer_and_component_type() {
        let l = Library::default();
        let estes_tubes = search(
            &l,
            json!({"kind": "preset", "manufacturer": "estes", "component_type": "BODY_TUBE", "limit": 500}),
        );
        assert!(estes_tubes.total > 0);
        assert_eq!(estes_tubes.items.len() as u32, estes_tubes.total);
        for i in &estes_tubes.items {
            assert_eq!(i.data["preset"]["manufacturer"], "Estes");
            assert_eq!(i.data["type"], "body_tube");
        }
        // A partial name is not a manufacturer, and a blank filter is none.
        assert_eq!(
            search(&l, json!({"kind": "preset", "manufacturer": "Est"})).total,
            0
        );
        assert_eq!(
            search(&l, json!({"kind": "preset", "manufacturer": "  "})).total,
            catalog_preset_count()
        );
        // Filters combine with the text query.
        let all_estes = search(&l, json!({"kind": "preset", "manufacturer": "Estes"})).total;
        let queried = search(
            &l,
            json!({"kind": "preset", "manufacturer": "Estes", "query": "bt-55"}),
        );
        assert!(queried.total > 0 && queried.total < all_estes);
    }

    #[test]
    fn each_facet_ignores_its_own_filter_and_counts_the_rest() {
        let l = Library::default();
        let everything = search(&l, json!({"kind": "preset"}));
        let f = &everything.facets;
        assert_eq!(
            f.manufacturers.iter().map(|c| c.count).sum::<u32>(),
            everything.total
        );
        assert_eq!(
            f.component_types.iter().map(|c| c.count).sum::<u32>(),
            everything.total
        );
        assert!(f.manufacturers.windows(2).all(|w| w[0].value < w[1].value));

        let estes = search(&l, json!({"kind": "preset", "manufacturer": "Estes"}));
        // The manufacturer list is unchanged by choosing one of them.
        assert_eq!(estes.facets.manufacturers, f.manufacturers);
        let estes_count = counted(&f.manufacturers, "Estes").unwrap().count;
        assert_eq!(estes.total, estes_count);
        // The type list narrows to that manufacturer.
        assert_eq!(
            estes
                .facets
                .component_types
                .iter()
                .map(|c| c.count)
                .sum::<u32>(),
            estes_count
        );

        let tubes = search(&l, json!({"kind": "preset", "component_type": "body_tube"}));
        assert_eq!(tubes.facets.component_types, f.component_types);
        assert_eq!(
            tubes.total,
            counted(&f.component_types, "body_tube").unwrap().count
        );
        assert_eq!(
            counted(&tubes.facets.manufacturers, "Estes").unwrap().count,
            search(
                &l,
                json!({"kind": "preset", "component_type": "body_tube", "manufacturer": "Estes"})
            )
            .total
        );
    }

    #[test]
    fn project_parts_filter_by_type_but_have_no_manufacturer() {
        let files = lib(&[(
            "lib/components/tubes.rw.toml",
            "[c.bt55]\nname = \"BT-55\"\ntype = \"body_tube\"\nlength = \"300 mm\"\nod = \"33.7 mm\"\nid = \"32.6 mm\"\n",
        )]);
        let l = Library::load(&files, None);
        let tubes = search(
            &l,
            json!({"component_type": "body_tube", "kind": "component"}),
        );
        assert_eq!(tubes.total, 1);
        assert_eq!(tubes.items[0].name, "BT-55");
        assert_eq!(
            search(&l, json!({"manufacturer": "Estes", "kind": "component"})).total,
            0
        );
    }

    #[test]
    fn paging_reaches_every_item_once_in_order() {
        let files = lib(&[(
            "lib/motors/RW_A8G.eng",
            "; c\nRW_A8G 18 70 3-5 0.003 0.015 RocketWright\n 0.1 5\n",
        )]);
        let l = Library::load(&files, None);
        let whole = catalog_preset_count();
        let mut ids = Vec::new();
        loop {
            let page = search(
                &l,
                json!({"kind": "preset", "limit": 500, "offset": ids.len()}),
            );
            assert_eq!(page.total, whole);
            if page.items.is_empty() {
                break;
            }
            ids.extend(page.items.into_iter().map(|i| i.id));
        }
        assert_eq!(ids.len() as u32, whole);
        let unique: std::collections::BTreeSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len());
        let catalog: Vec<_> = crate::presets::items()
            .iter()
            .filter(|i| i.kind == LibKind::Preset)
            .map(|i| i.id.clone())
            .collect();
        assert_eq!(ids, catalog);

        // Project items come first and share the window with presets.
        let first = search(&l, json!({"limit": 2}));
        assert_eq!(first.items[0].kind, LibKind::Motor);
        assert!(first.items[1].id.starts_with("preset:"));
        let next = search(&l, json!({"limit": 2, "offset": 1}));
        assert_eq!(next.items[0].id, first.items[1].id);

        // Past the end: nothing, with the count still reported.
        let past = search(&l, json!({"kind": "preset", "offset": whole}));
        assert!(past.items.is_empty());
        assert_eq!(past.total, whole);
    }

    #[test]
    fn without_a_limit_each_window_lists_at_most_the_default_presets() {
        let files = lib(&[(
            "lib/motors/RW_A8G.eng",
            "; c\nRW_A8G 18 70 3-5 0.003 0.015 RocketWright\n 0.1 5\n",
        )]);
        let l = Library::load(&files, None);
        let first = search(&l, json!({}));
        assert_eq!(first.items.len(), 1 + DEFAULT_PRESET_LIMIT);
        assert!(first.total as usize > first.items.len());
        let next = search(&l, json!({"offset": first.items.len()}));
        assert_eq!(next.items.len(), DEFAULT_PRESET_LIMIT);
        assert_ne!(next.items[0].id, first.items.last().unwrap().id);
    }

    #[test]
    fn plans_motor_imports_by_dialect() {
        let eng = "; c\nLIB_A8 18 70 3-5 0.003 0.015 RocketWright\n 0.0 0\n 0.1 10\n 0.6 0\n";
        let p = plan_motor_import("/tmp/x/My A8!.eng", eng.as_bytes()).unwrap();
        assert_eq!(p.path, "lib/motors/My_A8_.eng");
        assert_eq!(p.dialect, MotorDialect::Eng);
        assert_eq!(p.sha256, sha256_hex(eng.as_bytes()));
        assert_eq!(p.refs(), ["lib:motors/My_A8_.eng#LIB_A8"]);
        // No known extension: sniffed, extension added.
        let p = plan_motor_import("a8.txt", eng.as_bytes()).unwrap();
        assert_eq!(p.path, "lib/motors/a8.txt.eng");
        // Unknown dialect, a known extension that does not parse, binary.
        for (name, body) in [
            ("curve.csv", "time,thrust\n0,0\n"),
            ("bad.rse", "not xml"),
            ("empty.eng", "; only a comment\n"),
        ] {
            let d = plan_motor_import(name, body.as_bytes()).unwrap_err();
            assert_eq!(d.code, "RW-E008", "{name}");
            assert_eq!(d.file.as_deref(), Some(name));
        }
        let d = plan_motor_import("curve.csv", b"time,thrust\n").unwrap_err();
        assert!(
            d.message.contains("unknown motor file dialect"),
            "{}",
            d.message
        );
        assert_eq!(
            plan_motor_import("b.eng", &[0xff, 0xfe]).unwrap_err().code,
            "RW-E008"
        );
        assert_eq!(safe_file_name("..\\..\\.hidden"), "hidden");
        assert_eq!(safe_file_name(""), "motor");
    }

    #[test]
    fn missing_recorded_file_is_an_error() {
        let mut m = LibManifest::default();
        m.sha256
            .insert("lib/motors/gone.eng".into(), "ab".repeat(32));
        let l = Library::load(&BTreeMap::new(), Some(&m));
        assert_eq!(l.diagnostics.len(), 1);
        assert_eq!(l.diagnostics[0].code, "RW-E006");
        assert!(l.diagnostics[0].message.contains("missing"));
    }

    #[test]
    fn resolves_generic_library_and_designation_motor_refs() {
        let files = lib(&[(
            "lib/motors/LIB_A8.eng",
            "; c\nLIB_A8 18 70 3-5 0.003 0.015 RocketWright\n 0.0 0\n 0.1 10\n 0.5 5\n 0.6 0\n",
        )]);
        let l = Library::load(&files, None);
        assert_eq!(l.files[0].curves.len(), 1);
        let c6 = l.motor("generic:RW_C6G").expect("generic");
        assert!(matches!(c6.source, MotorSource::Generic { .. }));
        let a8 = l.motor("lib:lib/motors/LIB_A8.eng").expect("lib path");
        assert_eq!(a8.designation, "LIB_A8");
        assert_eq!(l.motor("lib:motors/LIB_A8.eng#lib_a8"), Some(a8.clone()));
        assert_eq!(l.motor("LIB_A8"), Some(a8));
        assert!(l.motor("lib:motors/LIB_A8.eng#nope").is_none());
        assert!(l.motor("lib:nope.eng").is_none());
        // A file whose recorded hash mismatches is not used.
        let mut m = LibManifest::default();
        m.sha256
            .insert("lib/motors/LIB_A8.eng".into(), "00".repeat(32));
        assert!(Library::load(&files, Some(&m)).motor("LIB_A8").is_none());
    }
}
