//! Imported CFD v1 (spec R6.15, plan M5.4): the documented CSV point format
//! and its run record.
//!
//! Format: a header row; required columns `x,y,z` (metres, body frame:
//! +X aft from the nose tip, +Z up); optional `vx,vy,vz` (m/s, all three or
//! none); any number of other named numeric columns (scalars). Lines whose
//! first non-blank text is `# rw-cfd:` carry metadata (`units=<col>:<unit>,...`
//! and `time=<seconds>`, separated by `;`); they are extracted before comment
//! handling, after which every other `#` line and blank line is skipped. One
//! file per time step, named `<prefix>_t<seconds>.csv`; the name and a
//! `time=` line must agree when both are present.
//!
//! `cfd_import` parses one file or a directory of steps and writes the
//! record `runs/cfd.<id>/<run_id>/cfd.json` (every column of every step,
//! `provenance = cfd`, I13) beside `dataset.json` (the [`CfdDataset`]
//! summary the app lists). The record is a display tier: it never feeds an
//! engineering number.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rw_api::{CfdDataset, Provenance, ScalarRange};
use serde::{Deserialize, Serialize};

/// The run record file.
pub const CFD_RECORD: &str = "cfd.json";
/// The dataset summary file beside it.
pub const CFD_DATASET: &str = "dataset.json";
/// The point columns, in this order.
pub const POSITION: [&str; 3] = ["x", "y", "z"];
/// The optional velocity columns.
pub const VELOCITY: [&str; 3] = ["vx", "vy", "vz"];

/// The run directory name of a dataset (`runs/cfd.<id>/`).
pub fn cfd_run_dir(id: &str) -> String {
    format!("cfd.{id}")
}

/// A parse or consistency failure, located in a source file (line 0: the
/// file as a whole).
#[derive(Debug, Clone, PartialEq)]
pub struct CfdError {
    pub file: String,
    pub line: usize,
    pub message: String,
    pub hint: Option<String>,
}

impl std::fmt::Display for CfdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.line > 0 {
            write!(f, "{}:{}: {}", self.file, self.line, self.message)
        } else {
            write!(f, "{}: {}", self.file, self.message)
        }
    }
}

fn fail(file: &str, line: usize, message: impl Into<String>) -> CfdError {
    CfdError {
        file: file.to_string(),
        line,
        message: message.into(),
        hint: None,
    }
}

fn hinted(mut e: CfdError, hint: impl Into<String>) -> CfdError {
    e.hint = Some(hint.into());
    e
}

const FORMAT_HINT: &str = "R6.15: header row with x,y,z (m, body frame), optional vx,vy,vz (m/s) and named scalar columns; `# rw-cfd: units=p:Pa,T:K; time=0.5` metadata lines";

/// Metadata from the `# rw-cfd:` lines of one file.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CfdMeta {
    /// Column → unit as written.
    pub units: BTreeMap<String, String>,
    /// `time=<seconds>`.
    pub time: Option<f64>,
}

/// The `# rw-cfd:` body of a line, if it is a metadata line.
fn meta_body(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix('#')?;
    rest.trim_start().strip_prefix("rw-cfd:")
}

/// Parses a metadata body (`units=p:Pa,T:K; time=0.5`) into `meta`.
pub fn parse_meta(body: &str, meta: &mut CfdMeta) -> Result<(), String> {
    for part in body.split(';').map(str::trim).filter(|p| !p.is_empty()) {
        let (k, v) = part
            .split_once('=')
            .ok_or_else(|| format!("`{part}`: expected key=value (units=..., time=...)"))?;
        let (k, v) = (k.trim(), v.trim());
        match k {
            "time" => {
                let num = v.strip_suffix('s').map_or(v, str::trim_end);
                let t: f64 = num
                    .parse()
                    .ok()
                    .filter(|t: &f64| t.is_finite())
                    .ok_or_else(|| format!("time=`{v}` is not a number of seconds"))?;
                if meta.time.is_some_and(|x| x != t) {
                    return Err(format!(
                        "time given twice ({} and {t})",
                        meta.time.unwrap_or(t)
                    ));
                }
                meta.time = Some(t);
            }
            "units" => {
                for u in v.split(',').map(str::trim).filter(|u| !u.is_empty()) {
                    if u.eq_ignore_ascii_case("si") {
                        continue;
                    }
                    let (col, unit) = u
                        .split_once(':')
                        .ok_or_else(|| format!("units entry `{u}`: expected <column>:<unit>"))?;
                    let (col, unit) = (col.trim(), unit.trim());
                    if col.is_empty() || unit.is_empty() {
                        return Err(format!("units entry `{u}`: expected <column>:<unit>"));
                    }
                    if let Some(prev) = meta.units.get(col)
                        && prev != unit
                    {
                        return Err(format!("unit of `{col}` given twice ({prev} and {unit})"));
                    }
                    meta.units.insert(col.to_string(), unit.to_string());
                }
            }
            other => return Err(format!("unknown rw-cfd key `{other}` (units, time)")),
        }
    }
    Ok(())
}

/// `<prefix>_t<seconds>.csv` → `(prefix, seconds)`.
pub fn step_name(file_name: &str) -> Option<(String, f64)> {
    let stem = file_name
        .strip_suffix(".csv")
        .or_else(|| file_name.strip_suffix(".CSV"))?;
    let i = stem.rfind("_t")?;
    let t: f64 = stem[i + 2..].parse().ok().filter(|t: &f64| t.is_finite())?;
    Some((stem[..i].to_string(), t))
}

/// A dataset id from a file prefix: lower case `[a-z0-9_-]`.
pub fn id_from(prefix: &str) -> String {
    let s: String = prefix
        .chars()
        .map(|c| {
            let c = c.to_ascii_lowercase();
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "cfd".into() } else { s }
}

/// True for a usable dataset id (`[a-z0-9][a-z0-9_-]*`, at most 64 chars).
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// One time step: every column, column-major.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CfdStep {
    /// Source file as reported (project-relative when inside the project).
    pub file: String,
    pub time: f64,
    /// Points in this step.
    pub points: u64,
    /// Values per column, in [`CfdData::columns`] order.
    pub values: Vec<Vec<f64>>,
}

/// One parsed file: header, metadata, and columns.
#[derive(Debug, Clone, PartialEq)]
pub struct CfdFile {
    pub columns: Vec<String>,
    pub meta: CfdMeta,
    /// `values[c][i]`: column `c` of point `i`.
    pub values: Vec<Vec<f64>>,
}

fn split_fields(line: &str) -> Vec<&str> {
    line.split(',')
        .map(|f| {
            let f = f.trim();
            f.strip_prefix('"')
                .and_then(|g| g.strip_suffix('"'))
                .unwrap_or(f)
                .trim()
        })
        .collect()
}

/// Parses one CSV file (`file` names it in errors).
pub fn parse_csv(file: &str, text: &str) -> Result<CfdFile, CfdError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut meta = CfdMeta::default();
    let mut columns: Option<(Vec<String>, usize)> = None;
    let mut values: Vec<Vec<f64>> = Vec::new();
    for (n, raw) in text.lines().enumerate() {
        let line_no = n + 1;
        // Metadata first: before comment handling drops `#` lines.
        if let Some(body) = meta_body(raw) {
            parse_meta(body, &mut meta).map_err(|m| hinted(fail(file, line_no, m), FORMAT_HINT))?;
            continue;
        }
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields = split_fields(line);
        let Some((cols, _)) = &columns else {
            if fields.iter().all(|f| f.parse::<f64>().is_ok()) {
                return Err(hinted(
                    fail(file, line_no, "the first row must be a header (x,y,z,...)"),
                    FORMAT_HINT,
                ));
            }
            let cols: Vec<String> = fields.iter().map(|f| f.to_string()).collect();
            check_header(file, line_no, &cols)?;
            values = vec![Vec::new(); cols.len()];
            columns = Some((cols, line_no));
            continue;
        };
        if fields.len() != cols.len() {
            return Err(fail(
                file,
                line_no,
                format!(
                    "{} fields, expected {} ({})",
                    fields.len(),
                    cols.len(),
                    cols.join(",")
                ),
            ));
        }
        for (c, f) in fields.iter().enumerate() {
            let v: f64 = f
                .parse()
                .ok()
                .filter(|v: &f64| v.is_finite())
                .ok_or_else(|| {
                    fail(
                        file,
                        line_no,
                        format!("`{}` = `{f}` is not a finite number", cols[c]),
                    )
                })?;
            values[c].push(v);
        }
    }
    let Some((columns, header_line)) = columns else {
        return Err(hinted(fail(file, 0, "no header row"), FORMAT_HINT));
    };
    if values.first().is_none_or(Vec::is_empty) {
        return Err(fail(file, header_line, "no data rows (no points)"));
    }
    for (col, unit) in &meta.units {
        if !columns.contains(col) {
            return Err(fail(
                file,
                0,
                format!("units name `{col}`, which is not a column"),
            ));
        }
        let want = if POSITION.contains(&col.as_str()) {
            Some("m")
        } else if VELOCITY.contains(&col.as_str()) {
            Some("m/s")
        } else {
            None
        };
        if let Some(w) = want
            && unit != w
        {
            return Err(hinted(
                fail(file, 0, format!("`{col}` is in {unit}; it must be {w}")),
                "positions are metres in the body frame, velocities m/s (R6.15); convert before importing",
            ));
        }
    }
    Ok(CfdFile {
        columns,
        meta,
        values,
    })
}

fn check_header(file: &str, line: usize, cols: &[String]) -> Result<(), CfdError> {
    for (i, c) in cols.iter().enumerate() {
        if c.is_empty() {
            return Err(fail(file, line, format!("column {} has no name", i + 1)));
        }
        if cols[..i].contains(c) {
            return Err(fail(file, line, format!("column `{c}` appears twice")));
        }
    }
    let missing: Vec<&str> = POSITION
        .iter()
        .copied()
        .filter(|p| !cols.iter().any(|c| c == p))
        .collect();
    if !missing.is_empty() {
        return Err(hinted(
            fail(
                file,
                line,
                format!("missing required column(s) {}", missing.join(",")),
            ),
            "the header needs x,y,z (lower case, metres in the body frame)",
        ));
    }
    let vel = VELOCITY
        .iter()
        .filter(|v| cols.iter().any(|c| c == *v))
        .count();
    if vel != 0 && vel != 3 {
        return Err(fail(file, line, "velocity needs all of vx,vy,vz (or none)"));
    }
    Ok(())
}

/// Every step of a dataset, in time order, sharing one column order.
#[derive(Debug, Clone, PartialEq)]
pub struct CfdData {
    /// `x,y,z`, then `vx,vy,vz` when present, then the scalars in header order.
    pub columns: Vec<String>,
    pub units: BTreeMap<String, String>,
    pub steps: Vec<CfdStep>,
}

impl CfdData {
    pub fn has_velocity(&self) -> bool {
        self.columns.iter().any(|c| c == "vx")
    }

    /// The scalar columns (everything but positions and velocity).
    pub fn scalars(&self) -> Vec<&str> {
        self.columns
            .iter()
            .map(String::as_str)
            .filter(|c| !POSITION.contains(c) && !VELOCITY.contains(c))
            .collect()
    }

    /// Min and max of a column over every step.
    pub fn range(&self, column: &str) -> Option<(f64, f64)> {
        let c = self.columns.iter().position(|x| x == column)?;
        let mut it = self.steps.iter().flat_map(|s| s.values[c].iter().copied());
        let first = it.next()?;
        Some(it.fold((first, first), |(lo, hi), v| (lo.min(v), hi.max(v))))
    }

    pub fn point_count(&self) -> u64 {
        self.steps.iter().map(|s| s.points).sum()
    }
}

/// Assembles parsed files into steps: `(reported name, file name, parsed)`.
/// Step times come from `_t<s>` names and `time=` lines (which must agree);
/// a lone file with neither is t = 0.
pub fn assemble(files: Vec<(String, String, CfdFile)>) -> Result<CfdData, CfdError> {
    let lone = files.len() == 1;
    let mut order: Option<Vec<String>> = None;
    let mut units: BTreeMap<String, String> = BTreeMap::new();
    let mut steps = Vec::new();
    for (shown, name, f) in files {
        let from_name = step_name(&name).map(|(_, t)| t);
        let time = match (from_name, f.meta.time) {
            (Some(a), Some(b)) if (a - b).abs() > 1e-9 * a.abs().max(1.0) => {
                return Err(fail(
                    &shown,
                    0,
                    format!("the name says t = {a} s but time={b}"),
                ));
            }
            (Some(a), _) => a,
            (None, Some(b)) => b,
            (None, None) if lone => 0.0,
            (None, None) => {
                return Err(hinted(
                    fail(&shown, 0, "no step time"),
                    "name each step <prefix>_t<seconds>.csv",
                ));
            }
        };
        let cols = order.get_or_insert_with(|| canonical_order(&f.columns));
        let mut same = f.columns.clone();
        same.sort();
        let mut want = cols.clone();
        want.sort();
        if same != want {
            return Err(fail(
                &shown,
                0,
                format!(
                    "columns {} differ from the first step's {}",
                    f.columns.join(","),
                    cols.join(",")
                ),
            ));
        }
        for (k, u) in &f.meta.units {
            match units.get(k) {
                Some(prev) if prev != u => {
                    return Err(fail(
                        &shown,
                        0,
                        format!("`{k}` is in {u} here but {prev} in an earlier step"),
                    ));
                }
                _ => {
                    units.insert(k.clone(), u.clone());
                }
            }
        }
        let values: Vec<Vec<f64>> = cols
            .iter()
            .map(|c| {
                let i = f.columns.iter().position(|x| x == c).unwrap_or(0);
                f.values[i].clone()
            })
            .collect();
        steps.push(CfdStep {
            file: shown,
            time,
            points: values.first().map_or(0, Vec::len) as u64,
            values,
        });
    }
    steps.sort_by(|a, b| a.time.total_cmp(&b.time));
    if let Some(w) = steps.windows(2).find(|w| w[0].time == w[1].time) {
        return Err(fail(
            &w[1].file,
            0,
            format!("two steps at t = {} s (also {})", w[1].time, w[0].file),
        ));
    }
    Ok(CfdData {
        columns: order.unwrap_or_default(),
        units,
        steps,
    })
}

/// `x,y,z`, then `vx,vy,vz`, then the scalars in header order.
fn canonical_order(cols: &[String]) -> Vec<String> {
    let mut out: Vec<String> = POSITION.iter().map(|s| s.to_string()).collect();
    if cols.iter().any(|c| c == "vx") {
        out.extend(VELOCITY.iter().map(|s| s.to_string()));
    }
    out.extend(
        cols.iter()
            .filter(|c| !POSITION.contains(&c.as_str()) && !VELOCITY.contains(&c.as_str()))
            .cloned(),
    );
    out
}

/// The source files of an import: the file itself, or every
/// `<prefix>_t<s>.csv` in a directory (one prefix only). Also returns the
/// default dataset id (the prefix, or the file stem).
pub fn source_files(path: &Path) -> Result<(Vec<PathBuf>, String), CfdError> {
    let shown = path.display().to_string();
    let meta = std::fs::metadata(path).map_err(|e| fail(&shown, 0, e.to_string()))?;
    if meta.is_file() {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let prefix = step_name(&name).map(|(p, _)| p).unwrap_or_else(|| {
            name.rsplit_once('.')
                .map_or(name.clone(), |(s, _)| s.to_string())
        });
        return Ok((vec![path.to_path_buf()], id_from(&prefix)));
    }
    let mut by_prefix: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    let rd = std::fs::read_dir(path).map_err(|e| fail(&shown, 0, e.to_string()))?;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some((prefix, _)) = step_name(&name)
            && e.path().is_file()
        {
            by_prefix.entry(prefix).or_default().push(e.path());
        }
    }
    match by_prefix.len() {
        0 => Err(hinted(
            fail(
                &shown,
                0,
                "no <prefix>_t<seconds>.csv steps in this directory",
            ),
            "name each step <prefix>_t<seconds>.csv, or import one file",
        )),
        1 => {
            let (prefix, mut files) = by_prefix.into_iter().next().unwrap_or_default();
            files.sort();
            Ok((files, id_from(&prefix)))
        }
        _ => Err(hinted(
            fail(
                &shown,
                0,
                format!(
                    "several step series here: {}",
                    by_prefix.keys().cloned().collect::<Vec<_>>().join(", ")
                ),
            ),
            "keep one series per directory, or import one file",
        )),
    }
}

/// `run_id`: first 12 hex of blake3 over the dataset id, every source
/// file's name and content hash, and the core version (I7).
pub fn run_id(id: &str, sources: &[CfdSource], core_version: &str) -> String {
    let key = serde_json::json!({
        "id": id,
        "sources": sources,
        "core_version": core_version,
    });
    let canon = rw_api::oracle::canonical_json(&key);
    blake3::hash(canon.as_bytes()).to_hex()[..12].to_string()
}

/// One source file and its blake3 hash.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CfdSource {
    pub name: String,
    pub blake3: String,
}

/// The dataset summary (`dataset.json`, `cfd_import` output).
pub fn dataset(id: &str, run_id: &str, data: &CfdData) -> CfdDataset {
    CfdDataset {
        id: id.to_string(),
        sim: cfd_run_dir(id),
        run_id: run_id.to_string(),
        files: data.steps.iter().map(|s| s.file.clone()).collect(),
        times: data.steps.iter().map(|s| s.time).collect(),
        scalars: data
            .scalars()
            .into_iter()
            .filter_map(|c| {
                data.range(c).map(|(min, max)| ScalarRange {
                    name: c.to_string(),
                    min,
                    max,
                    unit: data.units.get(c).cloned(),
                })
            })
            .collect(),
        has_velocity: data.has_velocity(),
        point_count: data.point_count(),
        provenance: Provenance::Cfd,
    }
}

/// `cfd.json`: the dataset, its units, and every step's columns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CfdRecord {
    pub id: String,
    pub run_id: String,
    /// Always `cfd` (I13).
    pub provenance: Provenance,
    pub core_version: String,
    /// Body frame: +X aft from the nose tip, +Z up; positions in metres.
    pub frame: String,
    pub columns: Vec<String>,
    /// Column → unit (`x,y,z` m, `vx,vy,vz` m/s, scalars as written).
    pub units: BTreeMap<String, String>,
    pub sources: Vec<CfdSource>,
    pub dataset: CfdDataset,
    pub steps: Vec<CfdStep>,
}

impl CfdRecord {
    pub fn new(
        dataset: CfdDataset,
        data: CfdData,
        sources: Vec<CfdSource>,
        core_version: &str,
    ) -> CfdRecord {
        let mut units = data.units.clone();
        for p in POSITION {
            units.insert(p.into(), "m".into());
        }
        if data.has_velocity() {
            for v in VELOCITY {
                units.insert(v.into(), "m/s".into());
            }
        }
        CfdRecord {
            id: dataset.id.clone(),
            run_id: dataset.run_id.clone(),
            provenance: Provenance::Cfd,
            core_version: core_version.to_string(),
            frame: "body".into(),
            columns: data.columns,
            units,
            sources,
            dataset,
            steps: data.steps,
        }
    }
}

// ---- the synthetic fixture (fixtures/cfd/) -------------------------------------

/// Times of the committed synthetic steps (`fixtures/cfd/tank_t<s>.csv`).
pub const SYNTHETIC_TIMES: [f64; 3] = [0.0, 0.5, 1.0];

/// Fixed decimals with no negative zero.
fn fixed(v: f64, d: usize) -> String {
    let s = format!("{v:.d$}");
    if s.trim_start_matches('-')
        .chars()
        .all(|c| c == '0' || c == '.')
    {
        s.trim_start_matches('-').to_string()
    } else {
        s
    }
}

/// One step of RocketWright's synthetic tank field (no solver: closed-form
/// expressions, documented in `fixtures/cfd/PROVENANCE.md`). A horizontal
/// cylinder in the body frame (axis along +X, x 0.62..1.02 m, radius
/// 48 mm) under a 30 m/s² aft specific force: liquid settles aft below a
/// free surface that drains forward-to-aft and sloshes in pitch.
/// Columns: `x,y,z` (m), `vx,vy,vz` (m/s), `p` (Pa), `T` (K), `alpha`
/// (liquid volume fraction, 1).
pub fn synthetic_step(t: f64) -> String {
    use std::f64::consts::PI;
    let (x0, x1, r_max) = (0.62_f64, 1.02_f64, 0.048_f64);
    let (rho, accel) = (790.0_f64, 30.0_f64);
    let surface = x0 + (x1 - x0) * (0.35 + 0.2 * t);
    let tilt = 0.25 * (2.0 * PI * t / 1.2).cos();
    let p_ullage = 4.5e6 - 0.6e6 * t;
    let width = 0.006;
    let mut out = String::new();
    out.push_str(
        "# RocketWright synthetic tank field (closed form, no CFD solver); see PROVENANCE.md\n",
    );
    out.push_str(&format!(
        "# rw-cfd: units=p:Pa,T:K,alpha:1; time={}\n",
        fixed(t, 1)
    ));
    out.push_str("x,y,z,vx,vy,vz,p,T,alpha\n");
    let nx = 21;
    let rings: [(f64, usize); 4] = [(0.0, 1), (1.0 / 3.0, 8), (2.0 / 3.0, 16), (1.0, 24)];
    for i in 0..nx {
        let x = x0 + (x1 - x0) * i as f64 / (nx - 1) as f64;
        for (rf, n) in rings {
            for k in 0..n {
                let th = 2.0 * PI * k as f64 / n as f64;
                let r = rf * r_max;
                let (y, z) = (r * th.cos(), r * th.sin());
                // Free surface x = surface + tan(tilt)·z; liquid aft of it.
                let local = surface + tilt.tan() * z;
                let depth = x - local;
                let alpha = 0.5 * (1.0 + (depth / width).tanh());
                let p = p_ullage + rho * accel * depth.max(0.0);
                let temp = 278.0 + 6.0 * (1.0 - alpha) + 1.5 * t + 0.8 * (z / r_max);
                // Drain toward the aft outlet (parabolic profile) plus slosh.
                let drain = 0.35 * alpha * (1.0 - rf * rf);
                let slosh = 0.06 * (2.0 * PI * t / 1.2).sin() * alpha;
                let vx = drain - slosh * (z / r_max);
                let vz = slosh * (1.0 - (2.0 * (x - x0) / (x1 - x0) - 1.0).powi(2));
                let vy = -0.02 * alpha * (y / r_max);
                out.push_str(&format!(
                    "{},{},{},{},{},{},{},{},{}\n",
                    fixed(x, 5),
                    fixed(y, 5),
                    fixed(z, 5),
                    fixed(vx, 5),
                    fixed(vy, 5),
                    fixed(vz, 5),
                    fixed(p, 1),
                    fixed(temp, 3),
                    fixed(alpha, 5),
                ));
            }
        }
    }
    out
}

/// File name of a synthetic step.
pub fn synthetic_name(t: f64) -> String {
    format!("tank_t{}.csv", fixed(t, 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<CfdFile, CfdError> {
        parse_csv("f.csv", text)
    }

    #[test]
    fn metadata_is_extracted_before_comments() {
        let f = parse(
            "# a comment\n#rw-cfd: units=p:Pa; time=0.25\n  # rw-cfd: units=T:K\nx,y,z,p,T\n# mid comment\n\n0,0,0,1,2\n1,0.5,-1,3,4\n",
        )
        .unwrap();
        assert_eq!(f.columns, ["x", "y", "z", "p", "T"]);
        assert_eq!(f.meta.time, Some(0.25));
        assert_eq!(f.meta.units["p"], "Pa");
        assert_eq!(f.meta.units["T"], "K");
        assert_eq!(f.values[3], [1.0, 3.0]);
        assert_eq!(f.values[1], [0.0, 0.5]);
    }

    #[test]
    fn header_rules() {
        let e = parse("x,y,p\n0,0,1\n").unwrap_err();
        assert!(e.message.contains("missing required column(s) z"), "{e}");
        let e = parse("x,y,z,vx\n0,0,0,1\n").unwrap_err();
        assert!(e.message.contains("vx,vy,vz"), "{e}");
        let e = parse("x,y,z,p,p\n0,0,0,1,1\n").unwrap_err();
        assert!(e.message.contains("twice"), "{e}");
        let e = parse("0,0,0\n").unwrap_err();
        assert!(e.message.contains("header"), "{e}");
        let e = parse("x,y,z\n").unwrap_err();
        assert!(e.message.contains("no data rows"), "{e}");
        let f = parse("\"x\", \"y\" ,z,vx,vy,vz,k\r\n1,2,3,4,5,6,7\r\n").unwrap();
        assert_eq!(f.columns, ["x", "y", "z", "vx", "vy", "vz", "k"]);
    }

    #[test]
    fn row_errors_name_the_line() {
        let e = parse("x,y,z\n0,0,0\n1,2\n").unwrap_err();
        assert_eq!(
            (e.line, e.message.as_str()),
            (3, "2 fields, expected 3 (x,y,z)")
        );
        let e = parse("x,y,z,p\n0,0,0,nan\n").unwrap_err();
        assert_eq!(e.line, 2);
        assert!(e.message.contains("`p` = `nan`"), "{e}");
        assert_eq!(e.to_string(), "f.csv:2: `p` = `nan` is not a finite number");
    }

    #[test]
    fn metadata_rules() {
        let e = parse("# rw-cfd: units=x:mm\nx,y,z\n0,0,0\n").unwrap_err();
        assert!(e.message.contains("must be m"), "{e}");
        let e = parse("# rw-cfd: units=q:Pa\nx,y,z\n0,0,0\n").unwrap_err();
        assert!(e.message.contains("not a column"), "{e}");
        let e = parse("# rw-cfd: frame=body\nx,y,z\n0,0,0\n").unwrap_err();
        assert!(e.message.contains("unknown rw-cfd key"), "{e}");
        let e = parse("# rw-cfd: time=soon\nx,y,z\n0,0,0\n").unwrap_err();
        assert_eq!(e.line, 1);
        let f = parse("# rw-cfd: units=si,x:m,vx:m/s; time=2 s\nx,y,z,vx,vy,vz\n0,0,0,1,1,1\n")
            .unwrap();
        assert_eq!(f.meta.time, Some(2.0));
    }

    #[test]
    fn step_names_and_ids() {
        assert_eq!(step_name("tank_t0.5.csv"), Some(("tank".into(), 0.5)));
        assert_eq!(step_name("a_b_t12.csv"), Some(("a_b".into(), 12.0)));
        assert_eq!(step_name("tank_t1e-3.csv"), Some(("tank".into(), 0.001)));
        assert_eq!(step_name("tank.csv"), None);
        assert_eq!(step_name("tank_tx.csv"), None);
        assert_eq!(id_from("Tank Flow"), "tank-flow");
        assert_eq!(id_from("..."), "cfd");
        assert!(valid_id("tank_flow-2"));
        assert!(!valid_id("Tank") && !valid_id("-a") && !valid_id(""));
    }

    fn file(cols: &str, rows: &[&str], time: Option<f64>) -> CfdFile {
        let mut text = String::new();
        if let Some(t) = time {
            text.push_str(&format!("# rw-cfd: time={t}\n"));
        }
        text.push_str(cols);
        text.push('\n');
        for r in rows {
            text.push_str(r);
            text.push('\n');
        }
        parse(&text).unwrap()
    }

    #[test]
    fn assembles_steps_in_time_order_with_one_column_order() {
        let d = assemble(vec![
            (
                "s_t1.csv".into(),
                "s_t1.csv".into(),
                file("p,z,y,x", &["5,0,0,0", "-1,1,1,1"], None),
            ),
            (
                "s_t0.csv".into(),
                "s_t0.csv".into(),
                file("x,y,z,p", &["0,0,0,2"], Some(0.0)),
            ),
        ])
        .unwrap();
        assert_eq!(d.columns, ["x", "y", "z", "p"]);
        assert_eq!(d.steps[0].time, 0.0);
        assert_eq!(d.steps[1].values[3], [5.0, -1.0]);
        assert_eq!(d.steps[1].values[0], [0.0, 1.0]);
        assert_eq!(d.range("p"), Some((-1.0, 5.0)));
        assert_eq!(d.point_count(), 3);
        assert_eq!(d.scalars(), ["p"]);
        let ds = dataset("s", "0123456789ab", &d);
        assert_eq!(ds.scalars[0].min, -1.0);
        assert_eq!(ds.times, [0.0, 1.0]);
        assert_eq!(ds.sim, "cfd.s");
    }

    #[test]
    fn assemble_rejects_inconsistent_steps() {
        let e = assemble(vec![(
            "s_t1.csv".into(),
            "s_t1.csv".into(),
            file("x,y,z", &["0,0,0"], Some(2.0)),
        )])
        .unwrap_err();
        assert!(e.message.contains("t = 1 s but time=2"), "{e}");
        let e = assemble(vec![
            (
                "a_t0.csv".into(),
                "a_t0.csv".into(),
                file("x,y,z,p", &["0,0,0,1"], None),
            ),
            (
                "a_t1.csv".into(),
                "a_t1.csv".into(),
                file("x,y,z,q", &["0,0,0,1"], None),
            ),
        ])
        .unwrap_err();
        assert!(e.message.contains("differ"), "{e}");
        let e = assemble(vec![
            (
                "a.csv".into(),
                "a.csv".into(),
                file("x,y,z", &["0,0,0"], None),
            ),
            (
                "b.csv".into(),
                "b.csv".into(),
                file("x,y,z", &["0,0,0"], None),
            ),
        ])
        .unwrap_err();
        assert!(e.message.contains("no step time"), "{e}");
        let lone = assemble(vec![(
            "a.csv".into(),
            "a.csv".into(),
            file("x,y,z", &["0,0,0"], None),
        )])
        .unwrap();
        assert_eq!(lone.steps[0].time, 0.0);
    }

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/cfd")
    }

    /// The committed synthetic field equals its generator (`RW_REGEN_CFD=1`
    /// rewrites it) and parses with velocity and three scalars.
    #[test]
    fn synthetic_fixture_is_current() {
        let dir = fixtures();
        for t in SYNTHETIC_TIMES {
            let path = dir.join(synthetic_name(t));
            let want = synthetic_step(t);
            if std::env::var("RW_REGEN_CFD").as_deref() == Ok("1") {
                std::fs::write(&path, &want).unwrap();
            }
            let have = std::fs::read_to_string(&path).unwrap_or_default();
            assert!(
                have == want,
                "{} is stale: RW_REGEN_CFD=1 cargo test -p rw-project synthetic_fixture",
                path.display()
            );
            let f = parse_csv(&synthetic_name(t), &have).unwrap();
            assert_eq!(f.meta.time, Some(t));
            assert_eq!(f.values[0].len(), 21 * 49);
        }
        let (files, id) = source_files(&dir).unwrap();
        assert_eq!(id, "tank");
        assert_eq!(files.len(), 3);
        let parsed = files
            .iter()
            .map(|p| {
                let n = p.file_name().unwrap().to_string_lossy().into_owned();
                let f = parse_csv(&n, &std::fs::read_to_string(p).unwrap()).unwrap();
                (n.clone(), n, f)
            })
            .collect();
        let d = assemble(parsed).unwrap();
        assert!(d.has_velocity());
        assert_eq!(d.scalars(), ["p", "T", "alpha"]);
        let (lo, hi) = d.range("alpha").unwrap();
        assert!(lo < 0.01 && hi > 0.99, "{lo} {hi}");
        assert_eq!(d.units["p"], "Pa");
    }

    #[test]
    fn run_ids_hash_names_and_contents() {
        let a = vec![CfdSource {
            name: "t_t0.csv".into(),
            blake3: "aa".into(),
        }];
        let mut b = a.clone();
        b[0].blake3 = "bb".into();
        assert_eq!(run_id("t", &a, "1").len(), 12);
        assert_eq!(run_id("t", &a, "1"), run_id("t", &a, "1"));
        assert_ne!(run_id("t", &a, "1"), run_id("t", &b, "1"));
        assert_ne!(run_id("t", &a, "1"), run_id("u", &a, "1"));
    }

    #[test]
    fn fixed_has_no_negative_zero() {
        assert_eq!(fixed(-0.0, 3), "0.000");
        assert_eq!(fixed(-0.0000001, 5), "0.00000");
        assert_eq!(fixed(-0.5, 1), "-0.5");
    }
}
