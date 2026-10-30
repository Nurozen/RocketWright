//! `cargo xtask audit`: the clean-room and purity gate (plan M1.3, spec R8.3,
//! Acceptance 7). Procedure and roster: `docs/dev/clean-room.md`.
//!
//! The audit fails when any of these holds:
//! - **denylist**: a file under the repo names an OpenRocket package root or a
//!   class listed in `docs/dev/clean-room-denylist.txt` or
//!   `tests/oracle/denylist.or.txt` (both lists are themselves excluded);
//! - **citation**: a `pub fn` in a physics crate has no `cite:` line (whose
//!   lit-id must exist in `docs/dev/citations.toml`) and no `Ported from` note;
//! - **notice**: a `Ported from <Project> (` note names a project that has no
//!   row in the `NOTICE.md` "Ported source code" table;
//! - **layering**: a pure crate's normal dependency tree (any target) reaches a
//!   native crate or a crate that brings fs, clock, randomness, or an async
//!   runtime (invariant I5);
//! - **doubles**: the `doubles` feature is enabled in a non-test build of any
//!   workspace member, a release command line turns it on, or a shipped or
//!   dev-app `rocketwright` binary on disk (`<target>/release/`,
//!   `<target>/rw-plain/`, `dist/kit/bin/`) was built with it or carries no
//!   build-provenance marker (its file bytes are read, it is never run);
//! - **ork**: an `.ork` file is tracked (or untracked and not ignored);
//! - **motor-provenance**: a file under `lib/motors/` has a sha256 that its
//!   nearest `PROVENANCE.md` does not list.
//!
//! `--self-test` builds a good and a bad fixture repository in a temp dir and
//! checks that the good one passes and the bad one trips every check (and that
//! `xtask audit --root <bad>` exits 1).

mod selftest;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

/// Physics crates: every `pub fn` needs a citation.
pub const PHYSICS_CRATES: &[&str] = &[
    "rw-geom",
    "rw-mass",
    "rw-aero",
    "rw-atmos",
    "rw-motor",
    "rw-sim",
    "rw-thermo",
    "rw-liquid",
];

/// Crates with no physics `pub fn`s. Their `cite:` lines are still checked
/// (well-formed, known lit-id). Every crate under `crates/` must be listed
/// here or in [`PHYSICS_CRATES`], so a new crate cannot dodge the citation
/// check by being unclassified.
pub const NON_PHYSICS_CRATES: &[&str] = &[
    "rw-units",
    "rw-model",
    "rw-check",
    "rw-draw",
    "rw-ork",
    "rw-api",
    "rw-wasm",
    "rw-project",
    "rw-cli",
    "rw-cea-sys",
    "xtask",
];

/// Pure crates (I5): native + wasm32, no fs/time/rand/threads.
pub const PURE_CRATES: &[&str] = &[
    "rw-units",
    "rw-model",
    "rw-geom",
    "rw-mass",
    "rw-aero",
    "rw-atmos",
    "rw-motor",
    "rw-sim",
    "rw-check",
    "rw-draw",
    "rw-ork",
    "rw-thermo",
    "rw-liquid",
    "rw-api",
    "rw-wasm",
];

/// Packages a pure crate may never reach through normal dependencies.
pub const PURE_FORBIDDEN_DEPS: &[&str] = &[
    // native workspace crates
    "rw-project",
    "rw-cli",
    "rw-cea-sys",
    "xtask",
    // randomness, async runtimes, fs watchers, git
    "rand",
    "getrandom",
    "tokio",
    "mio",
    "notify",
    "gix",
    "rmcp",
];

/// Always-on denylist entries (package roots), built so this file does not
/// trip its own scan.
pub fn builtin_denylist() -> Vec<String> {
    let root = ["open", "rocket"].concat();
    vec![format!("info.{root}"), format!("net.sf.{root}")]
}

pub const DENYLIST_FILES: &[&str] = &["docs/dev/clean-room-denylist.txt", ORACLE_DENYLIST];
pub const ORACLE_DENYLIST: &str = "tests/oracle/denylist.or.txt";
pub const CITATIONS_FILE: &str = "docs/dev/citations.toml";
pub const NOTICE_FILE: &str = "NOTICE.md";
pub const MOTORS_DIR: &str = "lib/motors/";

/// File extensions treated as source when looking for `Ported from` notes.
const SOURCE_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "mjs", "cjs", "py", "sh", "wgsl", "glsl", "f90", "c", "h",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Check {
    Denylist,
    Citation,
    Notice,
    Layering,
    Doubles,
    Ork,
    MotorProvenance,
    Io,
}

impl Check {
    pub const ALL: [Check; 7] = [
        Check::Denylist,
        Check::Citation,
        Check::Notice,
        Check::Layering,
        Check::Doubles,
        Check::Ork,
        Check::MotorProvenance,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Check::Denylist => "denylist",
            Check::Citation => "citation",
            Check::Notice => "notice",
            Check::Layering => "layering",
            Check::Doubles => "doubles",
            Check::Ork => "ork",
            Check::MotorProvenance => "motor-provenance",
            Check::Io => "io",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Finding {
    pub check: Check,
    /// `path[:line]`, or a crate name for tree checks.
    pub location: String,
    pub message: String,
}

impl fmt::Display for Finding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}: {}: {}",
            self.check.name(),
            self.location,
            self.message
        )
    }
}

fn finding(check: Check, location: impl Into<String>, message: impl Into<String>) -> Finding {
    Finding {
        check,
        location: location.into(),
        message: message.into(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    All,
    CitationsOnly,
}

/// Runs the audit on the repository at `root` and returns sorted findings.
pub fn run(root: &Path, scope: Scope) -> Vec<Finding> {
    let mut out = Vec::new();
    let files = match list_files(root) {
        Ok(f) => f,
        Err(e) => {
            out.push(finding(Check::Io, root.display().to_string(), e));
            return out;
        }
    };
    let texts = read_texts(root, &files);
    out.extend(check_citations(root, &texts));
    if scope == Scope::All {
        out.extend(check_denylist(root, &files, &texts));
        out.extend(check_notice(root, &files, &texts));
        out.extend(check_cargo_tree(root));
        out.extend(check_release_commands(&texts));
        out.extend(check_binary_provenance(root, &audit_target_dir(root)));
        out.extend(check_ork(&files));
        out.extend(check_motor_provenance(root, &files));
    }
    out.sort();
    out.dedup();
    out
}

/// CLI entry: `cargo xtask audit [--self-test] [--citations-only] [--root <dir>]`.
pub fn main(args: &[String]) -> ExitCode {
    let mut root: Option<PathBuf> = None;
    let mut scope = Scope::All;
    let mut self_test = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--self-test" => self_test = true,
            "--citations-only" => scope = Scope::CitationsOnly,
            "--root" => match it.next() {
                Some(p) => root = Some(PathBuf::from(p)),
                None => return usage(),
            },
            _ => return usage(),
        }
    }
    if self_test {
        return selftest::run_self_test();
    }
    let root = root.unwrap_or_else(repo_root);
    let findings = run(&root, scope);
    for f in &findings {
        println!("audit: {f}");
    }
    if findings.is_empty() {
        let what = if scope == Scope::CitationsOnly {
            "citations"
        } else {
            "all checks"
        };
        println!("xtask audit: ok ({what}) on {}", root.display());
        ExitCode::SUCCESS
    } else {
        eprintln!(
            "xtask audit: {} finding(s); see docs/dev/clean-room.md",
            findings.len()
        );
        ExitCode::FAILURE
    }
}

fn usage() -> ExitCode {
    eprintln!("usage: cargo xtask audit [--self-test] [--citations-only] [--root <dir>]");
    ExitCode::from(2)
}

/// The workspace root, two levels above this crate's manifest.
pub fn repo_root() -> PathBuf {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    here.parent()
        .and_then(Path::parent)
        .unwrap_or(here)
        .to_path_buf()
}

// ---- file inventory ------------------------------------------------------------

/// Tracked plus untracked-but-not-ignored files, relative, `/`-separated, sorted.
pub fn list_files(root: &Path) -> Result<Vec<String>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git ls-files failed (is this a git repository?): {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let mut files: Vec<String> = out
        .stdout
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        // Deleted-but-tracked files are still listed by --cached.
        .filter(|f| root.join(f).is_file())
        .collect();
    files.sort();
    files.dedup();
    Ok(files)
}

/// UTF-8 text contents of the listed files (binaries and large files skipped).
fn read_texts(root: &Path, files: &[String]) -> BTreeMap<String, String> {
    const MAX_BYTES: u64 = 8 * 1024 * 1024;
    let mut map = BTreeMap::new();
    for f in files {
        let p = root.join(f);
        if std::fs::metadata(&p)
            .map(|m| m.len() > MAX_BYTES)
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(bytes) = std::fs::read(&p) else {
            continue;
        };
        if bytes.contains(&0) {
            continue;
        }
        if let Ok(s) = String::from_utf8(bytes) {
            map.insert(f.clone(), s);
        }
    }
    map
}

// ---- denylist ------------------------------------------------------------------

/// One denylist needle. Entries with `.` or `/` match as substrings; plain
/// identifiers match only as whole identifiers (`[A-Za-z0-9_]` boundaries).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Needle {
    pub text: String,
    pub whole_word: bool,
}

pub fn parse_denylist(text: &str) -> Vec<Needle> {
    text.lines()
        .map(|l| l.split('#').next().unwrap_or("").trim())
        .filter(|l| !l.is_empty())
        .map(needle)
        .collect()
}

fn needle(s: &str) -> Needle {
    let whole_word = s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    Needle {
        text: s.to_string(),
        whole_word,
    }
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// Returns true when `needle` occurs in `line` under its matching rule.
pub fn line_matches(line: &str, n: &Needle) -> bool {
    let hay = line.as_bytes();
    let pat = n.text.as_bytes();
    let mut start = 0;
    while let Some(off) = line[start..].find(&n.text) {
        let i = start + off;
        if !n.whole_word {
            return true;
        }
        let before_ok = i == 0 || !is_ident(hay[i - 1]);
        let after = i + pat.len();
        let after_ok = after >= hay.len() || !is_ident(hay[after]);
        if before_ok && after_ok {
            return true;
        }
        start = i + 1;
        while !line.is_char_boundary(start) {
            start += 1;
        }
    }
    false
}

/// Loads every denylist needle: the built-in package roots plus both list
/// files. Both files are required (the oracle exports `denylist.or.txt` at
/// M1.43) and must hold at least one entry.
pub fn load_denylist(root: &Path) -> (Vec<Needle>, Vec<Finding>) {
    let mut needles: Vec<Needle> = builtin_denylist().iter().map(|s| needle(s)).collect();
    let mut out = Vec::new();
    for file in DENYLIST_FILES {
        match std::fs::read_to_string(root.join(file)) {
            Ok(t) => {
                let n = parse_denylist(&t);
                if n.is_empty() {
                    out.push(finding(
                        Check::Denylist,
                        *file,
                        "denylist file has no entries",
                    ));
                }
                needles.extend(n);
            }
            Err(_) => out.push(finding(
                Check::Denylist,
                *file,
                if *file == ORACLE_DENYLIST {
                    "oracle denylist is missing (the oracle exports it, plan M1.43)"
                } else {
                    "denylist file is missing"
                },
            )),
        }
    }
    (needles, out)
}

/// Denylist hits in file contents and in file paths (a file named after an
/// OpenRocket class is a hit too). Only the two list files are excluded.
pub fn check_denylist(
    root: &Path,
    files: &[String],
    texts: &BTreeMap<String, String>,
) -> Vec<Finding> {
    let (needles, mut out) = load_denylist(root);
    for path in files {
        if DENYLIST_FILES.contains(&path.as_str()) {
            continue;
        }
        for n in &needles {
            if line_matches(path, n) {
                out.push(finding(
                    Check::Denylist,
                    path.clone(),
                    format!("file path names denylisted identifier `{}`", n.text),
                ));
            }
        }
    }
    for (path, text) in texts {
        if DENYLIST_FILES.contains(&path.as_str()) {
            continue;
        }
        for (i, line) in text.lines().enumerate() {
            for n in &needles {
                if line_matches(line, n) {
                    out.push(finding(
                        Check::Denylist,
                        format!("{path}:{}", i + 1),
                        format!("names denylisted identifier `{}`", n.text),
                    ));
                }
            }
        }
    }
    out
}

// ---- citations -----------------------------------------------------------------

/// Lit-ids declared in `citations.toml`: top-level table keys, keys of tables
/// nested one level down (e.g. `[lit.<id>]`), and `id = "..."` fields of
/// arrays of tables (e.g. `[[lit]] id = "<id>"`).
pub fn parse_lit_ids(text: &str) -> Result<BTreeSet<String>, String> {
    let table: toml::Table = text.parse().map_err(|e| format!("invalid TOML: {e}"))?;
    let mut ids = BTreeSet::new();
    for (k, v) in &table {
        match v {
            toml::Value::Table(t) => {
                ids.insert(k.clone());
                for (k2, v2) in t {
                    if v2.is_table() {
                        ids.insert(k2.clone());
                    }
                }
            }
            toml::Value::Array(items) => {
                for item in items {
                    if let Some(id) = item.get("id").and_then(toml::Value::as_str) {
                        ids.insert(id.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    Ok(ids)
}

/// Why a `cite:` payload is malformed, or the lit-id it cites (`None` for `n/a`).
pub fn parse_cite(payload: &str) -> Result<Option<String>, String> {
    let toks: Vec<&str> = payload.split_whitespace().collect();
    match toks.as_slice() {
        ["n/a", reason @ ..] if !reason.is_empty() => Ok(None),
        ["n/a"] => Err("`cite: n/a` needs a reason".into()),
        [id, kind, _num, "p", page, ..] if matches!(*kind, "eq" | "tab" | "fig" | "sec") => {
            let page_ok = page
                .trim_end_matches([',', ';', '.'])
                .split(['-', '\u{2013}'])
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
            if page_ok {
                Ok(Some((*id).to_string()))
            } else {
                Err(format!("page `{page}` is not a number or range"))
            }
        }
        _ => Err("expected `cite: <lit-id> eq <n> p <page>` or `cite: n/a <reason>`".into()),
    }
}

/// Returns the function name if `line` declares a `pub fn` (not `pub(crate)`).
pub fn pub_fn_name(line: &str) -> Option<&str> {
    let mut rest = line.trim_start().strip_prefix("pub ")?.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("fn ") {
            let name = r.trim_start();
            let end = name
                .find(|c: char| !(c.is_alphanumeric() || c == '_'))
                .unwrap_or(name.len());
            return (end > 0).then(|| &name[..end]);
        }
        let mut advanced = false;
        for q in ["const ", "async ", "unsafe "] {
            if let Some(r) = rest.strip_prefix(q) {
                rest = r.trim_start();
                advanced = true;
            }
        }
        if let Some(r) = rest.strip_prefix("extern ") {
            rest = r.trim_start();
            if rest.starts_with('"') {
                let close = rest[1..].find('"')? + 2;
                rest = rest[close..].trim_start();
            }
            advanced = true;
        }
        if !advanced {
            return None;
        }
    }
}

fn is_exempt_physics_file(rel_in_src: &str) -> bool {
    let file = rel_in_src.rsplit('/').next().unwrap_or(rel_in_src);
    let first = rel_in_src.split('/').next().unwrap_or("");
    let stem = file.strip_suffix(".rs").unwrap_or(file);
    // IF type stubs (frozen contracts) and test doubles carry no physics.
    stem == "types"
        || stem.starts_with("types_")
        || first == "types"
        || stem == "doubles"
        || stem.starts_with("doubles_")
        || first == "doubles"
}

/// True when the `pub fn` starting at `lines[start]` is an unimplemented
/// frozen IF stub: its body holds only `let _ = ...;` bindings and a
/// `todo!(...)`/`unimplemented!(...)`. A stub carries no physics; once the body
/// lands, the citation is required.
fn is_todo_stub(lines: &[&str], start: usize) -> bool {
    let mut depth = 0i64;
    let mut opened = false;
    let mut body = String::new();
    for line in &lines[start..] {
        for c in line.chars() {
            if !opened {
                match c {
                    '{' => {
                        opened = true;
                        depth = 1;
                    }
                    ';' => return false, // declaration without a body
                    _ => {}
                }
                continue;
            }
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return stub_body(&body);
                    }
                }
                _ => {}
            }
            body.push(c);
        }
        if opened {
            body.push('\n');
        }
    }
    false
}

fn stub_body(body: &str) -> bool {
    let stmts: Vec<&str> = body
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let Some((last, init)) = stmts.split_last() else {
        return false;
    };
    let is_stub_macro = |s: &str| s.starts_with("todo!(") || s.starts_with("unimplemented!(");
    is_stub_macro(last)
        && init
            .iter()
            .all(|s| s.starts_with("let _ =") || is_stub_macro(s))
}

/// Citation findings for one physics source file.
pub fn check_citations_in_file(
    path: &str,
    text: &str,
    lit_ids: Option<&BTreeSet<String>>,
) -> Vec<Finding> {
    let mut out = Vec::new();
    // A `Ported from` note in the file's leading comment block covers the file.
    let header_ported = text
        .lines()
        .map(str::trim)
        .take_while(|l| l.is_empty() || l.starts_with("//") || l.starts_with("#!["))
        .any(|l| !ported_projects_in_line(l).is_empty());
    let mut block: Vec<&str> = Vec::new();
    let mut skip_depth: Option<i64> = None; // inside a #[cfg(test)] item
    let mut depth: i64 = 0;
    let mut pending_cfg_test = false;
    let all_lines: Vec<&str> = text.lines().collect();
    for (i, line) in text.lines().enumerate() {
        let t = line.trim();
        let opens = line.matches('{').count() as i64;
        let closes = line.matches('}').count() as i64;
        if let Some(d) = skip_depth {
            depth += opens - closes;
            if depth <= d {
                skip_depth = None;
            }
            continue;
        }
        if t.starts_with("#[cfg(test)]") {
            pending_cfg_test = true;
        }
        if pending_cfg_test && !t.starts_with("#[") && !t.is_empty() && !t.starts_with("//") {
            pending_cfg_test = false;
            let before = depth;
            depth += opens - closes;
            if opens > 0 && depth > before {
                skip_depth = Some(before);
            }
            block.clear();
            continue;
        }
        depth += opens - closes;
        if t.starts_with("//") || t.starts_with("#[") || t.starts_with("#![") {
            block.push(t);
            continue;
        }
        if let Some(name) = pub_fn_name(line) {
            let loc = format!("{path}:{}", i + 1);
            let ported =
                header_ported || block.iter().any(|l| !ported_projects_in_line(l).is_empty());
            let cites: Vec<&str> = block
                .iter()
                .filter_map(|l| l.find("cite:").map(|p| l[p + "cite:".len()..].trim()))
                .collect();
            if cites.is_empty() && !ported && !is_todo_stub(&all_lines, i) {
                out.push(finding(
                    Check::Citation,
                    loc.clone(),
                    format!("pub fn `{name}` has no `/// cite:` line or `Ported from` note"),
                ));
            }
            for c in cites {
                match parse_cite(c) {
                    Err(e) => out.push(finding(
                        Check::Citation,
                        loc.clone(),
                        format!("`{name}`: {e}"),
                    )),
                    Ok(Some(id)) => match lit_ids {
                        None => out.push(finding(
                            Check::Citation,
                            loc.clone(),
                            format!(
                                "`{name}` cites `{id}` but {CITATIONS_FILE} is missing or invalid"
                            ),
                        )),
                        Some(ids) if !ids.contains(&id) => out.push(finding(
                            Check::Citation,
                            loc.clone(),
                            format!(
                                "`{name}` cites unknown lit-id `{id}` (not in {CITATIONS_FILE})"
                            ),
                        )),
                        Some(_) => {}
                    },
                    Ok(None) => {}
                }
            }
        }
        block.clear();
    }
    out
}

/// The payload of a comment line that is a `cite:` line (`/// cite: ...`,
/// `//! cite: ...`, `// cite: ...`), or `None`.
pub fn cite_comment(line: &str) -> Option<&str> {
    let t = line.trim_start().strip_prefix("//")?;
    let t = t.trim_start_matches(['/', '!']).trim_start();
    t.strip_prefix("cite:").map(str::trim)
}

/// Malformed `cite:` lines and unknown lit-ids anywhere in a file (used for
/// the non-physics crates, which have no per-function requirement).
pub fn check_cite_lines(
    path: &str,
    text: &str,
    lit_ids: Option<&BTreeSet<String>>,
) -> Vec<Finding> {
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let Some(c) = cite_comment(line) else {
            continue;
        };
        let loc = format!("{path}:{}", i + 1);
        match parse_cite(c) {
            Err(e) => out.push(finding(Check::Citation, loc, e)),
            Ok(Some(id)) if !lit_ids.is_some_and(|ids| ids.contains(&id)) => out.push(finding(
                Check::Citation,
                loc,
                format!("cites unknown lit-id `{id}` (not in {CITATIONS_FILE})"),
            )),
            Ok(_) => {}
        }
    }
    out
}

pub fn check_citations(root: &Path, texts: &BTreeMap<String, String>) -> Vec<Finding> {
    let mut out = Vec::new();
    let lit_ids = match std::fs::read_to_string(root.join(CITATIONS_FILE)) {
        Ok(t) => match parse_lit_ids(&t) {
            Ok(ids) => Some(ids),
            Err(e) => {
                out.push(finding(Check::Citation, CITATIONS_FILE, e));
                None
            }
        },
        Err(_) => None,
    };
    for (path, text) in texts {
        let Some(rest) = path.strip_prefix("crates/") else {
            continue;
        };
        let Some((krate, in_crate)) = rest.split_once('/') else {
            continue;
        };
        let physics = PHYSICS_CRATES.contains(&krate);
        if in_crate == "Cargo.toml" && !physics && !NON_PHYSICS_CRATES.contains(&krate) {
            out.push(finding(
                Check::Citation,
                path.clone(),
                format!(
                    "crate `{krate}` is unclassified: add it to PHYSICS_CRATES or NON_PHYSICS_CRATES in crates/xtask/src/audit.rs"
                ),
            ));
            continue;
        }
        if !path.ends_with(".rs") || krate == "xtask" {
            continue;
        }
        let Some(in_src) = in_crate.strip_prefix("src/") else {
            continue;
        };
        if !physics {
            out.extend(check_cite_lines(path, text, lit_ids.as_ref()));
            continue;
        }
        if is_exempt_physics_file(in_src) {
            continue;
        }
        out.extend(check_citations_in_file(path, text, lit_ids.as_ref()));
    }
    out
}

// ---- NOTICE --------------------------------------------------------------------

/// Rows of the NOTICE.md "Ported source code" table: project name
/// (lowercased) → the backticked entries of the other cells, with `{a,b}`
/// brace groups expanded. Entries that contain `/` are paths ("Used in").
pub fn notice_ported_rows(notice: &str) -> BTreeMap<String, Vec<String>> {
    let mut in_section = false;
    let mut rows: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for line in notice.lines() {
        if let Some(h) = line.strip_prefix("## ") {
            in_section = h.trim().eq_ignore_ascii_case("Ported source code");
            continue;
        }
        if !in_section || !line.trim_start().starts_with('|') {
            continue;
        }
        let row = line.trim_start().trim_start_matches('|');
        let (first, rest) = row.split_once('|').unwrap_or((row, ""));
        let cell = first
            .trim()
            .trim_matches(|c| c == '*' || c == '`' || c == '_')
            .trim();
        if cell.is_empty()
            || cell.starts_with('-')
            || cell.eq_ignore_ascii_case("project")
            || cell == "none yet"
        {
            continue;
        }
        let entries = rows.entry(cell.to_ascii_lowercase()).or_default();
        for (i, span) in rest.split('`').enumerate() {
            if i % 2 == 1 && !span.trim().is_empty() {
                entries.extend(expand_braces(span.trim()));
            }
        }
    }
    rows
}

/// Expands `{a,b}` groups (any number, not nested): `x/{a,b}.ts` →
/// `x/a.ts`, `x/b.ts`.
pub fn expand_braces(s: &str) -> Vec<String> {
    let (Some(open), Some(close)) = (s.find('{'), s.find('}')) else {
        return vec![s.to_string()];
    };
    if close < open {
        return vec![s.to_string()];
    }
    let (head, tail) = (&s[..open], &s[close + 1..]);
    let mut out = Vec::new();
    for alt in s[open + 1..close].split(',') {
        for t in expand_braces(tail) {
            out.push(format!("{head}{}{t}", alt.trim()));
        }
    }
    out
}

/// True when a NOTICE "Used in" path entry covers `file`: the same path, or a
/// directory that contains it.
pub fn notice_entry_covers(entry: &str, file: &str) -> bool {
    let dir = entry.trim_end_matches('/');
    file == entry || file.strip_prefix(dir).is_some_and(|r| r.starts_with('/'))
}

/// Project names in `Ported from <Project> (` notes on one line.
pub fn ported_projects_in_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(p) = rest.find("Ported from ") {
        let after = &rest[p + "Ported from ".len()..];
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')))
            .unwrap_or(after.len());
        let name = &after[..end];
        if !name.is_empty() && after[end..].trim_start().starts_with('(') {
            out.push(name.to_string());
        }
        rest = after;
    }
    out
}

/// Names in `Ported from <Name>` notes on one line that lack the
/// `(<License>)` part. Text after `Ported from ` that does not start with a
/// letter (a backtick, `<`) is prose about notes, not a note.
pub fn malformed_ported_notes(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(p) = rest.find("Ported from ") {
        let after = &rest[p + "Ported from ".len()..];
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')))
            .unwrap_or(after.len());
        let name = &after[..end];
        let starts_alpha = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
        if starts_alpha && !after[end..].trim_start().starts_with('(') {
            out.push(name.to_string());
        }
        rest = after;
    }
    out
}

/// NOTICE coverage: every `Ported from <Project> (<License>)` note names a
/// project with a row in the "Ported source code" table, and the row's
/// backticked "Used in" paths cover the file; every listed path exists; no
/// note is missing its license.
pub fn check_notice(
    root: &Path,
    files: &[String],
    texts: &BTreeMap<String, String>,
) -> Vec<Finding> {
    let mut out = Vec::new();
    let rows = match std::fs::read_to_string(root.join(NOTICE_FILE)) {
        Ok(t) => notice_ported_rows(&t),
        Err(_) => {
            out.push(finding(Check::Notice, NOTICE_FILE, "NOTICE.md is missing"));
            BTreeMap::new()
        }
    };
    for (project, entries) in &rows {
        for e in entries.iter().filter(|e| e.contains('/')) {
            let dir = e.trim_end_matches('/');
            let exists = files.iter().any(|f| notice_entry_covers(e, f)) || root.join(dir).exists();
            if !exists {
                out.push(finding(
                    Check::Notice,
                    NOTICE_FILE,
                    format!("the `{project}` row lists `{e}`, which does not exist"),
                ));
            }
        }
    }
    for (path, text) in texts {
        let ext = path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
        if !SOURCE_EXTS.contains(&ext) {
            continue;
        }
        let mut reported: BTreeSet<String> = BTreeSet::new();
        for (i, line) in text.lines().enumerate() {
            let loc = format!("{path}:{}", i + 1);
            for name in malformed_ported_notes(line) {
                out.push(finding(
                    Check::Notice,
                    loc.clone(),
                    format!("`Ported from {name}` lacks `(<License>)`; write `Ported from <Project> (<License>) <path>`"),
                ));
            }
            for name in ported_projects_in_line(line) {
                let key = name.to_ascii_lowercase();
                let Some(entries) = rows.get(&key) else {
                    out.push(finding(
                        Check::Notice,
                        loc.clone(),
                        format!("`Ported from {name}` has no row in the {NOTICE_FILE} \"Ported source code\" table"),
                    ));
                    continue;
                };
                let covered = entries
                    .iter()
                    .filter(|e| e.contains('/'))
                    .any(|e| notice_entry_covers(e, path));
                if !covered && reported.insert(key) {
                    out.push(finding(
                        Check::Notice,
                        loc.clone(),
                        format!("file is not listed in the \"Used in\" column of the {NOTICE_FILE} row for {name}"),
                    ));
                }
            }
        }
    }
    out
}

// ---- cargo tree ----------------------------------------------------------------

fn cargo() -> String {
    std::env::var("CARGO").unwrap_or_else(|_| "cargo".into())
}

fn workspace_members(root: &Path) -> Result<Vec<String>, String> {
    let out = Command::new(cargo())
        .current_dir(root)
        .args(["metadata", "--no-deps", "--format-version", "1"])
        .output()
        .map_err(|e| format!("cannot run cargo metadata: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("cargo metadata output: {e}"))?;
    let mut names: Vec<String> = v["packages"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    Ok(names)
}

/// Runs `cargo tree` for `roots` (normal edges, every target).
fn cargo_tree(root: &Path, roots: &[&str], format: &str, prefix: &str) -> Result<String, String> {
    let mut cmd = Command::new(cargo());
    cmd.current_dir(root).args([
        "tree", "--quiet", "-e", "normal", "--target", "all", "--prefix", prefix, "--format",
        format,
    ]);
    for r in roots {
        cmd.args(["-p", r]);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("cannot run cargo tree: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "cargo tree failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Parses `cargo tree --prefix depth --format {p}` output for several roots
/// into root → set of reachable package names.
pub fn parse_tree_depth(text: &str) -> BTreeMap<String, BTreeSet<String>> {
    let mut map: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let digits = line.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 {
            continue;
        }
        let depth: usize = line[..digits].parse().unwrap_or(0);
        let name = line[digits..]
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        if depth == 0 {
            map.entry(name.clone()).or_default();
            current = Some(name);
        } else if let Some(c) = &current {
            map.entry(c.clone()).or_default().insert(name);
        }
    }
    map
}

/// Layering findings from a parsed tree.
pub fn layering_findings(trees: &BTreeMap<String, BTreeSet<String>>) -> Vec<Finding> {
    let mut out = Vec::new();
    for (krate, deps) in trees {
        if !PURE_CRATES.contains(&krate.as_str()) {
            continue;
        }
        for bad in PURE_FORBIDDEN_DEPS {
            if deps.contains(*bad) {
                out.push(finding(
                    Check::Layering,
                    krate.clone(),
                    format!("pure crate depends on `{bad}` (I5: no native crates, fs, clock, rand, or runtime)"),
                ));
            }
        }
    }
    out
}

/// Doubles findings from `cargo tree --prefix none --format "{p}|{f}"` output.
pub fn doubles_findings(text: &str) -> Vec<Finding> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Some((pkg, feats)) = line.split_once('|') else {
            continue;
        };
        if feats.split(',').any(|f| f.trim() == "doubles") {
            let name = pkg.split_whitespace().next().unwrap_or(pkg).to_string();
            out.push(finding(
                Check::Doubles,
                name,
                "`doubles` feature is on in a non-test build (enable it only from dev-dependencies or test commands)",
            ));
        }
    }
    out
}

pub fn check_cargo_tree(root: &Path) -> Vec<Finding> {
    if !root.join("Cargo.toml").is_file() {
        return vec![finding(
            Check::Layering,
            "Cargo.toml",
            "workspace manifest is missing",
        )];
    }
    let members = match workspace_members(root) {
        Ok(m) => m,
        Err(e) => return vec![finding(Check::Layering, "Cargo.toml", e)],
    };
    let mut out = Vec::new();
    let pure: Vec<&str> = members
        .iter()
        .map(String::as_str)
        .filter(|m| PURE_CRATES.contains(m))
        .collect();
    if !pure.is_empty() {
        match cargo_tree(root, &pure, "{p}", "depth") {
            Ok(t) => out.extend(layering_findings(&parse_tree_depth(&t))),
            Err(e) => out.push(finding(Check::Layering, "cargo tree", e)),
        }
    }
    // Release artifacts are built from members' normal dependency graphs, so no
    // member (xtask aside) may switch `doubles` on outside dev-dependencies.
    let shipped: Vec<&str> = members
        .iter()
        .map(String::as_str)
        .filter(|m| *m != "xtask")
        .collect();
    if !shipped.is_empty() {
        match cargo_tree(root, &shipped, "{p}|{f}", "none") {
            Ok(t) => out.extend(doubles_findings(&t)),
            Err(e) => out.push(finding(Check::Doubles, "cargo tree", e)),
        }
    }
    out
}

/// Release command lines (Makefile, cargo config, scripts, package.json) that
/// pass `--features ...doubles`.
pub fn check_release_commands(texts: &BTreeMap<String, String>) -> Vec<Finding> {
    let mut out = Vec::new();
    for (path, text) in texts {
        let file = path.rsplit('/').next().unwrap_or(path);
        let relevant = file == "Makefile"
            || file.ends_with(".mk")
            || path.starts_with(".cargo/")
            || path.starts_with("scripts/")
            || file == "package.json";
        if !relevant {
            continue;
        }
        for (i, line) in text.lines().enumerate() {
            if line.contains("--release") && line.contains("doubles") {
                out.push(finding(
                    Check::Doubles,
                    format!("{path}:{}", i + 1),
                    "release build command enables `doubles`",
                ));
            }
        }
    }
    out
}

/// The cargo target dir the audit inspects for `root`: `$CARGO_TARGET_DIR`
/// (relative to `root`) for this repository, `<root>/target` for any other
/// root (the self-test fixtures).
pub fn audit_target_dir(root: &Path) -> PathBuf {
    let same = |a: &Path, b: &Path| match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    };
    match std::env::var_os("CARGO_TARGET_DIR").filter(|v| !v.is_empty()) {
        Some(t) if same(root, &repo_root()) => root.join(t),
        _ => root.join("target"),
    }
}

/// Marker prefix written by `rw-cli` (`rw_cli::BUILD_PROVENANCE_PREFIX`).
pub const PROVENANCE_PREFIX: &[u8] = b"RW-BUILD-PROVENANCE:v1;features=";

/// The feature lists of every provenance marker in `bytes` (one per marker;
/// empty when the binary has none).
pub fn provenance_features(bytes: &[u8]) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(i) = bytes[at..]
        .windows(PROVENANCE_PREFIX.len())
        .position(|w| w == PROVENANCE_PREFIX)
    {
        let start = at + i + PROVENANCE_PREFIX.len();
        let end = bytes[start..]
            .iter()
            .take(64)
            .position(|&b| b == b';')
            .map(|n| start + n);
        if let Some(end) = end {
            let list = String::from_utf8_lossy(&bytes[start..end]);
            out.push(
                list.split(',')
                    .filter(|f| !f.is_empty())
                    .map(str::to_string)
                    .collect(),
            );
            at = end;
        } else {
            at = start;
        }
    }
    out
}

/// Release and dev-app binaries: `<target>/release/rocketwright` (the kit and
/// any release build), `<target>/rw-plain/rocketwright` (`make dev` and the
/// desktop default), `dist/kit/bin/rocketwright` (the B3 kit).
pub fn shipped_binaries(root: &Path, target: &Path) -> Vec<(PathBuf, &'static str)> {
    vec![
        (target.join("release/rocketwright"), "release binary"),
        (target.join("rw-plain/rocketwright"), "dev-app binary"),
        (root.join("dist/kit/bin/rocketwright"), "kit binary"),
    ]
}

/// Build provenance of the release and dev-app binaries on disk: each must
/// carry the marker and none may list `doubles`.
pub fn check_binary_provenance(root: &Path, target: &Path) -> Vec<Finding> {
    let mut out = Vec::new();
    for (path, what) in shipped_binaries(root, target) {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let loc = path.display().to_string();
        let markers = provenance_features(&bytes);
        if markers.is_empty() {
            out.push(finding(
                Check::Doubles,
                loc,
                format!("{what} has no build-provenance marker (rebuild it, or delete it)"),
            ));
        } else if markers.iter().any(|m| m.iter().any(|f| f == "doubles")) {
            out.push(finding(
                Check::Doubles,
                loc,
                format!("{what} was built with `doubles` (only test binaries may be)"),
            ));
        }
    }
    out
}

// ---- .ork and motors -----------------------------------------------------------

pub fn check_ork(files: &[String]) -> Vec<Finding> {
    files
        .iter()
        .filter(|f| f.to_ascii_lowercase().ends_with(".ork"))
        .map(|f| {
            finding(
                Check::Ork,
                f.clone(),
                "`.ork` files must never be committed (use tests/oracle/cache/)",
            )
        })
        .collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn check_motor_provenance(root: &Path, files: &[String]) -> Vec<Finding> {
    let mut out = Vec::new();
    let mut cache: BTreeMap<String, Option<String>> = BTreeMap::new();
    for f in files {
        if !f.starts_with(MOTORS_DIR) || f.to_ascii_lowercase().ends_with(".md") {
            continue;
        }
        // Nearest PROVENANCE.md from the file's directory up to lib/motors/.
        let mut dir = f
            .rsplit_once('/')
            .map(|(d, _)| d.to_string())
            .unwrap_or_default();
        let mut prov: Option<(String, String)> = None;
        loop {
            let candidate = format!("{dir}/PROVENANCE.md");
            let text = cache
                .entry(candidate.clone())
                .or_insert_with(|| {
                    std::fs::read_to_string(root.join(&candidate))
                        .ok()
                        .map(|t| t.to_ascii_lowercase())
                })
                .clone();
            if let Some(t) = text {
                prov = Some((candidate, t));
                break;
            }
            if format!("{dir}/") == MOTORS_DIR {
                break;
            }
            match dir.rsplit_once('/') {
                Some((d, _)) => dir = d.to_string(),
                None => break,
            }
        }
        let Some((prov_path, prov_text)) = prov else {
            out.push(finding(
                Check::MotorProvenance,
                f.clone(),
                "no PROVENANCE.md in this or any parent directory",
            ));
            continue;
        };
        match std::fs::read(root.join(f)) {
            Ok(bytes) => {
                let hex = sha256_hex(&bytes);
                if !prov_text.contains(&hex) {
                    out.push(finding(
                        Check::MotorProvenance,
                        f.clone(),
                        format!("sha256 {hex} is not listed in {prov_path}"),
                    ));
                }
            }
            Err(e) => out.push(finding(Check::Io, f.clone(), e.to_string())),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Split so this file does not trip its own NOTICE scan.
    const PF: &str = concat!("Ported", " from");

    #[test]
    fn denylist_parsing_and_matching() {
        let n = parse_denylist("# comment\nFooCalc  # trailing\n\nnet.example.pkg\n");
        assert_eq!(n.len(), 2);
        assert!(n[0].whole_word && !n[1].whole_word);
        assert!(line_matches("let x = FooCalc::new();", &n[0]));
        assert!(!line_matches("let x = FooCalculator::new();", &n[0]));
        assert!(!line_matches("MyFooCalc", &n[0]));
        assert!(line_matches("import net.example.pkg.Thing;", &n[1]));
        assert!(line_matches("é FooCalc", &n[0]));
    }

    #[test]
    fn builtin_denylist_has_both_package_roots() {
        let b = builtin_denylist();
        assert_eq!(b.len(), 2);
        assert!(b.iter().all(|s| s.ends_with("rocket")));
    }

    #[test]
    fn cite_parsing() {
        assert_eq!(
            parse_cite("niskanen2013 eq 3.12 p 47"),
            Ok(Some("niskanen2013".into()))
        );
        assert_eq!(
            parse_cite("ussa1976 tab 4 p 50-52 (layers)"),
            Ok(Some("ussa1976".into()))
        );
        assert_eq!(parse_cite("n/a constructor, no physics"), Ok(None));
        assert!(parse_cite("n/a").is_err());
        assert!(parse_cite("niskanen2013").is_err());
        assert!(parse_cite("niskanen2013 eq 3 p x").is_err());
    }

    #[test]
    fn pub_fn_detection() {
        assert_eq!(
            pub_fn_name("pub fn cn_alpha(x: f64) -> f64 {"),
            Some("cn_alpha")
        );
        assert_eq!(pub_fn_name("    pub const fn k() {}"), Some("k"));
        assert_eq!(
            pub_fn_name("pub unsafe extern \"C\" fn ffi() {}"),
            Some("ffi")
        );
        assert_eq!(pub_fn_name("pub(crate) fn hidden() {}"), None);
        assert_eq!(pub_fn_name("fn private() {}"), None);
        assert_eq!(pub_fn_name("pub struct S;"), None);
    }

    #[test]
    fn citations_in_file() {
        let ids: BTreeSet<String> = ["lit1".to_string()].into();
        let src = "\
/// Normal-force slope.
/// cite: lit1 eq 3.1 p 12
#[inline]
pub fn good() {}

/// cite: nope eq 1 p 2
pub fn unknown() {}

// PORTED RocketPy (MIT) rocketpy/x.py:f
pub fn ported() {}

pub fn bare() {}

#[cfg(test)]
mod tests {
    pub fn helper() {}
}
"
        .replace("PORTED", PF);
        let f = check_citations_in_file("a.rs", &src, Some(&ids));
        let locs: Vec<&str> = f.iter().map(|f| f.location.as_str()).collect();
        assert_eq!(locs, ["a.rs:7", "a.rs:12"], "{f:#?}");
        let missing =
            check_citations_in_file("a.rs", "/// cite: lit1 eq 1 p 1\npub fn g() {}\n", None);
        assert_eq!(missing.len(), 1);
    }

    #[test]
    fn todo_stubs_need_no_citation() {
        let src = "\
pub fn stub(a: f64) -> f64 {
    let _ = a;
    todo!(\"PHYS: stub\")
}

pub fn one_line() { todo!() }

pub fn multi(
    a: f64,
) -> Result<(), ()> {
    let _ = (a, 1);
    todo!(\"later\")
}

pub fn real(a: f64) -> f64 {
    let _ = a;
    todo!();
    2.0 * a
}

pub fn physics(a: f64) -> f64 {
    a * 9.81
}
";
        let f = check_citations_in_file("a.rs", src, None);
        let locs: Vec<&str> = f.iter().map(|f| f.location.as_str()).collect();
        assert_eq!(locs, ["a.rs:15", "a.rs:21"], "{f:#?}");
    }

    #[test]
    fn exempt_files() {
        assert!(is_exempt_physics_file("types.rs"));
        assert!(is_exempt_physics_file("types_sim.rs"));
        assert!(is_exempt_physics_file("types/mod.rs"));
        assert!(is_exempt_physics_file("doubles.rs"));
        assert!(!is_exempt_physics_file("barrowman.rs"));
    }

    #[test]
    fn lit_ids_from_toml_forms() {
        let ids =
            parse_lit_ids("[a]\ntitle='x'\n[lit.b]\ntitle='y'\n[[source]]\nid='c'\n").unwrap();
        assert!(ids.contains("a") && ids.contains("b") && ids.contains("c"));
    }

    #[test]
    fn notice_and_ported_notes() {
        let notice = "## Ported source code\n\n| Project | License |\n|---|---|\n| RocketPy | MIT |\n| _none yet_ | |\n## Other\n| Bogus | x |\n";
        let p = notice_ported_rows(notice);
        assert_eq!(p.into_keys().collect::<Vec<_>>(), ["rocketpy"]);
        assert_eq!(
            ported_projects_in_line(&format!("// {PF} RocketPy (MIT) a.py:f")),
            ["RocketPy"]
        );
        assert!(ported_projects_in_line(&format!("// `{PF} <project> (<license>)`")).is_empty());
    }

    #[test]
    fn notice_rows_and_coverage() {
        let notice = "## Ported source code\n\n| Project | License | Upstream | Used in |\n|---|---|---|---|\n| Lecturn | MIT | x | `app/mcp/{http,session-registry}.ts`, `app/chat/` (design) |\n| RocketPy | MIT | `Flight.u_dot` | `crates/rw-sim/src/sixdof.rs` |\n";
        let rows = notice_ported_rows(notice);
        assert_eq!(
            rows["lecturn"],
            [
                "app/mcp/http.ts",
                "app/mcp/session-registry.ts",
                "app/chat/"
            ]
        );
        assert_eq!(
            rows["rocketpy"],
            ["Flight.u_dot", "crates/rw-sim/src/sixdof.rs"]
        );
        assert_eq!(
            expand_braces("a/{b,c}/{d,e}.rs"),
            ["a/b/d.rs", "a/b/e.rs", "a/c/d.rs", "a/c/e.rs"]
        );
        assert!(notice_entry_covers("app/chat/", "app/chat/Timeline.tsx"));
        assert!(notice_entry_covers("app/chat", "app/chat/Timeline.tsx"));
        assert!(!notice_entry_covers("app/chat", "app/chatter.ts"));
        assert!(notice_entry_covers("app/mcp/http.ts", "app/mcp/http.ts"));
    }

    #[test]
    fn malformed_ported_note_detection() {
        assert_eq!(
            malformed_ported_notes(&format!("// {PF} RocketPy rocketpy/x.py")),
            ["RocketPy"]
        );
        assert!(malformed_ported_notes(&format!("// {PF} RocketPy (MIT) x.py")).is_empty());
        assert!(malformed_ported_notes(&format!("/// a `{PF}` note")).is_empty());
        assert!(malformed_ported_notes(&format!("// `{PF} <Project> (`")).is_empty());
    }

    #[test]
    fn cite_lines_outside_physics() {
        assert_eq!(cite_comment("    /// cite: a eq 1 p 2"), Some("a eq 1 p 2"));
        assert_eq!(cite_comment("//! cite: n/a x"), Some("n/a x"));
        assert_eq!(cite_comment("let s = \"cite: a\";"), None);
        let ids: BTreeSet<String> = ["lit1".to_string()].into();
        let src = "/// cite: lit1 eq 1 p 2\n/// cite: n/a getter\n/// cite: nope eq 1 p 2\n// cite: lit1 page 3\nfn f() {}\n";
        let f = check_cite_lines("m.rs", src, Some(&ids));
        let locs: Vec<&str> = f.iter().map(|f| f.location.as_str()).collect();
        assert_eq!(locs, ["m.rs:3", "m.rs:4"], "{f:#?}");
    }

    #[test]
    fn oracle_denylist_is_required() {
        let dir = std::env::temp_dir().join(format!("rw-audit-deny-{}", std::process::id()));
        let dev = dir.join("docs/dev");
        std::fs::create_dir_all(&dev).unwrap();
        std::fs::write(dev.join("clean-room-denylist.txt"), "FooCalc\n").unwrap();
        let (needles, f) = load_denylist(&dir);
        assert_eq!(needles.len(), 3);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].location, ORACLE_DENYLIST);
        std::fs::create_dir_all(dir.join("tests/oracle")).unwrap();
        std::fs::write(dir.join(ORACLE_DENYLIST), "# only a comment\n").unwrap();
        let (_, f) = load_denylist(&dir);
        assert_eq!(f.len(), 1);
        assert!(f[0].message.contains("no entries"));
        std::fs::write(dir.join(ORACLE_DENYLIST), "BarCalc\n").unwrap();
        let (needles, f) = load_denylist(&dir);
        assert!(f.is_empty());
        assert!(needles.iter().any(|n| n.text == "BarCalc"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repo_oracle_denylist_is_loaded() {
        let (needles, f) = load_denylist(&repo_root());
        assert!(f.is_empty(), "{f:#?}");
        let oracle = std::fs::read_to_string(repo_root().join(ORACLE_DENYLIST)).unwrap();
        let entries = parse_denylist(&oracle);
        assert!(
            entries.len() > 100,
            "oracle denylist has {} entries",
            entries.len()
        );
        assert!(entries.iter().all(|e| needles.contains(e)));
    }

    #[test]
    fn every_crate_is_classified() {
        let crates = std::fs::read_dir(repo_root().join("crates")).unwrap();
        for e in crates {
            let name = e.unwrap().file_name().to_string_lossy().into_owned();
            assert!(
                PHYSICS_CRATES.contains(&name.as_str())
                    || NON_PHYSICS_CRATES.contains(&name.as_str()),
                "crate {name} is unclassified"
            );
        }
    }

    #[test]
    fn tree_parsing_and_layering() {
        let t = "0rw-aero v0.1.0 (/x)\n1serde v1.0.0\n\n0rw-model v0.1.0 (/y)\n1rw-project v0.1.0 (/z)\n2getrandom v0.3.0\n0rw-project v0.1.0 (/z)\n1tokio v1\n";
        let trees = parse_tree_depth(t);
        assert_eq!(trees.len(), 3);
        let f = layering_findings(&trees);
        let msgs: Vec<String> = f
            .iter()
            .map(|f| format!("{}:{}", f.location, f.message))
            .collect();
        assert_eq!(f.len(), 2, "{msgs:?}");
        assert!(f.iter().all(|f| f.location == "rw-model"));
    }

    #[test]
    fn provenance_markers() {
        let bin = b"\0\x7fELF..RW-BUILD-PROVENANCE:v1;features=cea,doubles;..RW-BUILD-PROVENANCE:v1;features=;";
        assert_eq!(
            provenance_features(bin),
            vec![vec!["cea".to_string(), "doubles".to_string()], vec![]]
        );
        assert!(provenance_features(b"no marker").is_empty());
        let dir = std::env::temp_dir().join(format!("rw-audit-prov-{}", std::process::id()));
        let target = dir.join("target");
        std::fs::create_dir_all(target.join("release")).unwrap();
        std::fs::create_dir_all(target.join("rw-plain")).unwrap();
        std::fs::write(
            target.join("release/rocketwright"),
            b"xRW-BUILD-PROVENANCE:v1;features=cea;x",
        )
        .unwrap();
        std::fs::write(
            target.join("rw-plain/rocketwright"),
            b"xRW-BUILD-PROVENANCE:v1;features=doubles;x",
        )
        .unwrap();
        let f = check_binary_provenance(&dir, &target);
        assert_eq!(f.len(), 1, "{f:?}");
        assert!(f[0].location.ends_with("rw-plain/rocketwright"));
        std::fs::write(target.join("rw-plain/rocketwright"), b"old build").unwrap();
        let f = check_binary_provenance(&dir, &target);
        assert!(f[0].message.contains("no build-provenance marker"), "{f:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn doubles_parsing() {
        let f = doubles_findings(
            "rw-aero v0.1.0 (/x)|default,doubles\nrw-sim v0.1.0 (/y)|\nserde v1|derive,std\n",
        );
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].location, "rw-aero");
    }

    #[test]
    fn sha256_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
