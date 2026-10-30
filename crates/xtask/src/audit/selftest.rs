//! `cargo xtask audit --self-test`: builds a good and a bad fixture repository
//! in a temp dir, then checks that the good one is clean, the bad one trips
//! every check, and the `audit --root <dir>` binary exits 0 and 1 on them.
//!
//! Fixture text that would trip the audit of this repository itself (package
//! roots, `Ported from` notes, denylisted names) is assembled at run time.

use super::{Check, Scope, builtin_denylist, run, sha256_hex};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

type Files = Vec<(String, String)>;

fn pf() -> String {
    ["Ported", "from"].join(" ")
}

const DENY_CLASS: &str = "FixtureAeroCalc";
const ORACLE_DENY_CLASS: &str = "FixtureOracleOnlyName";

fn common(files: &mut Files, aero_toml: &str, project_toml: &str, aero_lib: &str) {
    let mut add = |p: &str, c: &str| files.push((p.to_string(), c.to_string()));
    add(
        "Cargo.toml",
        "[workspace]\nresolver = \"3\"\nmembers = [\"crates/rw-aero\", \"crates/rw-project\"]\n",
    );
    add(".gitignore", "target/\nCargo.lock\ntests/oracle/cache/\n");
    add("crates/rw-aero/Cargo.toml", aero_toml);
    add("crates/rw-aero/src/lib.rs", aero_lib);
    add("crates/rw-project/Cargo.toml", project_toml);
    add(
        "crates/rw-project/src/lib.rs",
        "//! Native crate.\npub fn open() {}\n",
    );
    add(
        "docs/dev/citations.toml",
        "[niskanen2013]\ntitle = \"fixture\"\n\n[[source]]\nid = \"ussa1976\"\n",
    );
    add(
        "docs/dev/clean-room-denylist.txt",
        &format!("# fixture denylist\n{DENY_CLASS}\n"),
    );
    add(
        "NOTICE.md",
        "# NOTICE\n\n## Ported source code\n\n| Project | License | Upstream | Used in |\n|---|---|---|---|\n| RocketPy | MIT | x | `crates/rw-aero/` |\n\n## Vendored code and data\n\n| Bogus | GPL | x | x |\n",
    );
    // Ignored cache: an .ork here is allowed.
    add("tests/oracle/cache/cached.ork", "<ork/>\n");
}

fn motor(files: &mut Files, name: &str, body: &str, listed_hash: Option<&str>) {
    let hash = listed_hash
        .map(str::to_string)
        .unwrap_or_else(|| sha256_hex(body.as_bytes()));
    files.push((format!("lib/motors/generic/{name}"), body.to_string()));
    files.push((
        "lib/motors/generic/PROVENANCE.md".to_string(),
        format!("# Provenance\n\n| file | sha256 |\n|---|---|\n| {name} | {hash} |\n"),
    ));
}

fn good_fixture() -> Files {
    let mut f = Files::new();
    let aero_lib = format!(
        "//! Pure physics.\n\
         mod types;\n\
         /// Normal-force slope.\n\
         /// cite: niskanen2013 eq 3.19 p 34\n\
         #[must_use]\n\
         pub fn cn_alpha() -> f64 {{ 2.0 }}\n\n\
         /// cite: ussa1976 tab 4 p 3-4\n\
         pub const fn layers() -> usize {{ 7 }}\n\n\
         // {pf} RocketPy (MIT) rocketpy/x.py:f\n\
         pub fn ported() {{}}\n\n\
         /// cite: n/a constructor, no physics\n\
         pub fn new() {{}}\n\n\
         pub(crate) fn internal() {{}}\n\n\
         #[cfg(test)]\n\
         mod tests {{\n    pub fn helper() {{}}\n}}\n",
        pf = pf()
    );
    common(
        &mut f,
        "[package]\nname = \"rw-aero\"\nversion = \"0.1.0\"\nedition = \"2024\"\npublish = false\n\n[features]\ndoubles = []\n",
        "[package]\nname = \"rw-project\"\nversion = \"0.1.0\"\nedition = \"2024\"\npublish = false\n\n\
         [dependencies]\nrw-aero = { path = \"../rw-aero\" }\n\n\
         [dev-dependencies]\nrw-aero = { path = \"../rw-aero\", features = [\"doubles\"] }\n",
        &aero_lib,
    );
    f.push((
        "crates/rw-aero/src/types.rs".into(),
        "pub fn eval() { todo!() }\n".into(),
    ));
    f.push((
        "Makefile".into(),
        "release:\n\tcargo build --release\ntest:\n\tcargo test --features doubles\n".into(),
    ));
    f.push((
        "tests/oracle/denylist.or.txt".into(),
        format!("# oracle export\n{ORACLE_DENY_CLASS}\n"),
    ));
    motor(&mut f, "RW_T1G.rse", "<engine-database/>\n", None);
    // Shipped binaries with plain provenance (target/ is ignored, not listed).
    f.push((
        "target/release/rocketwright".into(),
        format!("\0{}cea;\0", prov()),
    ));
    f.push((
        "target/rw-plain/rocketwright".into(),
        format!("\0{};\0", prov()),
    ));
    f
}

/// The rw-cli provenance prefix, assembled at run time.
fn prov() -> String {
    String::from_utf8_lossy(super::PROVENANCE_PREFIX).into_owned()
}

fn bad_fixture() -> Files {
    let mut f = Files::new();
    let pkg = &builtin_denylist()[1];
    let aero_lib = format!(
        "//! Pure physics.\n\
         // after {pkg}.aerodynamics\n\
         pub fn uncited() {{}}\n\n\
         /// cite: nobody2099 eq 1 p 1\n\
         pub fn unknown_lit() {{}}\n\n\
         /// cite: niskanen2013 page 4\n\
         pub fn malformed() {{}}\n\n\
         // {pf} Bogus (GPL-3.0) Thing.java\n\
         pub fn from_gpl() {{}}\n",
        pf = pf()
    );
    common(
        &mut f,
        "[package]\nname = \"rw-aero\"\nversion = \"0.1.0\"\nedition = \"2024\"\npublish = false\n\n\
         [features]\ndefault = [\"doubles\"]\ndoubles = []\n\n\
         [dependencies]\nrw-project = { path = \"../rw-project\" }\n",
        "[package]\nname = \"rw-project\"\nversion = \"0.1.0\"\nedition = \"2024\"\npublish = false\n",
        &aero_lib,
    );
    f.push((
        "tests/oracle/denylist.or.txt".into(),
        format!("{ORACLE_DENY_CLASS}\n"),
    ));
    f.push((
        "app/src/model.ts".into(),
        format!("export class {DENY_CLASS} {{}}\nconst x = new {ORACLE_DENY_CLASS}();\n"),
    ));
    f.push(("fixtures/case1/rocket.ork".into(), "<ork/>\n".into()));
    // Denylist: a file named after a denylisted class.
    f.push((format!("app/src/{DENY_CLASS}.ts"), "export {};\n".into()));
    // Notice: a ported file the RocketPy row does not list, a note with no
    // license, and (NOTICE override below) a listed path that does not exist.
    f.push((
        "app/src/ported.ts".into(),
        format!(
            "// {pf} RocketPy (MIT) rocketpy/x.py:g\n// {pf} elsewhere\nexport {{}};\n",
            pf = pf()
        ),
    ));
    f.push((
        "NOTICE.md".into(),
        "# NOTICE\n\n## Ported source code\n\n| Project | License | Upstream | Used in |\n|---|---|---|---|\n| RocketPy | MIT | x | `crates/rw-aero/`, `crates/{gone,rw-aero/src/lib}.rs` |\n".into(),
    ));
    // Citation: an unclassified crate and a bad lit-id in a non-physics crate.
    f.push((
        "crates/rw-mystery/Cargo.toml".into(),
        "[package]\nname = \"rw-mystery\"\nversion = \"0.1.0\"\nedition = \"2024\"\n".into(),
    ));
    f.push((
        "crates/rw-project/src/lib.rs".into(),
        "//! Native crate.\n/// cite: nobody2099 eq 1 p 1\npub fn open() {}\n".into(),
    ));
    f.push((
        "Makefile".into(),
        "release:\n\tcargo build --release --features rw-aero/doubles\n".into(),
    ));
    motor(
        &mut f,
        "RW_T2G.rse",
        "<engine-database/>\n",
        Some(&"0".repeat(64)),
    );
    // A doubles release binary and a dev-app binary without provenance.
    f.push((
        "target/release/rocketwright".into(),
        format!("\0{}doubles;\0", prov()),
    ));
    f.push(("target/rw-plain/rocketwright".into(), "\0old\0".into()));
    f
}

fn materialize(dir: &Path, files: &Files) -> Result<(), String> {
    for (rel, body) in files {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&p, body).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    for args in [&["init", "-q"][..], &["add", "-A"][..]] {
        let st = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .map_err(|e| format!("git: {e}"))?;
        if !st.success() {
            return Err(format!("git {args:?} failed in {}", dir.display()));
        }
    }
    Ok(())
}

fn exit_code_of_audit(dir: &Path) -> Result<i32, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let out = Command::new(exe)
        .env_remove("CARGO_TARGET_DIR")
        .args(["audit", "--root"])
        .arg(dir)
        .output()
        .map_err(|e| format!("spawn audit: {e}"))?;
    Ok(out.status.code().unwrap_or(-1))
}

fn self_test_in(base: &Path) -> Result<(), String> {
    let good = base.join("good");
    let bad = base.join("bad");
    materialize(&good, &good_fixture())?;
    materialize(&bad, &bad_fixture())?;

    let gf = run(&good, Scope::All);
    if !gf.is_empty() {
        let list: Vec<String> = gf.iter().map(ToString::to_string).collect();
        return Err(format!(
            "good fixture should pass but has findings:\n  {}",
            list.join("\n  ")
        ));
    }
    let bf = run(&bad, Scope::All);
    for f in &bf {
        println!("  bad fixture: {f}");
    }
    let seen: BTreeSet<Check> = bf.iter().map(|f| f.check).collect();
    let missing: Vec<&str> = Check::ALL
        .iter()
        .filter(|c| !seen.contains(c))
        .map(|c| c.name())
        .collect();
    if !missing.is_empty() {
        return Err(format!("bad fixture did not trip: {}", missing.join(", ")));
    }
    let expect = [
        (Check::Denylist, 4), // package root, denylist class, oracle class, file name
        (Check::Citation, 5), // uncited, unknown lit-id, malformed, unclassified crate, non-physics cite
        (Check::Notice, 4),   // Bogus project, unlisted file, no license, stale NOTICE path
        (Check::Layering, 1), // rw-aero -> rw-project
        (Check::Doubles, 4),  // default feature, release command, doubles binary, unmarked binary
        (Check::Ork, 1),      // tracked .ork (the ignored cache copy is fine)
        (Check::MotorProvenance, 1), // wrong sha256
    ];
    for (check, n) in expect {
        let got = bf.iter().filter(|f| f.check == check).count();
        if got != n {
            return Err(format!(
                "bad fixture: expected {n} {} finding(s), got {got}",
                check.name()
            ));
        }
    }
    let cit = run(&bad, Scope::CitationsOnly);
    if cit.iter().any(|f| f.check != Check::Citation) || cit.len() != 5 {
        return Err(format!(
            "--citations-only on bad fixture returned {} unexpected finding(s)",
            cit.len()
        ));
    }
    let (g, b) = (exit_code_of_audit(&good)?, exit_code_of_audit(&bad)?);
    if g != 0 || b != 1 {
        return Err(format!(
            "`xtask audit --root` exit codes: good={g} (want 0), bad={b} (want 1)"
        ));
    }
    println!(
        "  good fixture: 0 findings, exit 0; bad fixture: {} findings, exit 1",
        bf.len()
    );
    Ok(())
}

pub fn run_self_test() -> ExitCode {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let base: PathBuf =
        std::env::temp_dir().join(format!("rw-audit-selftest-{}-{nanos}", std::process::id()));
    let result = self_test_in(&base);
    match result {
        Ok(()) => {
            let _ = std::fs::remove_dir_all(&base);
            println!("xtask audit --self-test: ok");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!(
                "xtask audit --self-test: FAILED: {e}\n  fixtures kept at {}",
                base.display()
            );
            ExitCode::FAILURE
        }
    }
}
