//! M2.5 under `make parity` only: imports OpenRocket's example files 1-7
//! (read as data, never committed) with `rw import ork`, then `rw check`
//! must exit 0 (warnings allowed; they are listed in the report), or report
//! exactly the errors documented in `golden/import_parity.known.json`
//! (geometry conflicts inside the example models, a missing model). Each
//! imported project then flies the golden's simulation and is compared, in
//! report mode, with `rw diff run --golden tests/oracle/case<n>-original.json`.
//!
//! Without `RW_PARITY=1` the test only prints that it skipped (the default
//! `cargo test` never reads `.ork` files). Examples are found at
//! `$RW_ORK_EXAMPLES`, else `openrocket/core/src/main/resources/datafiles/examples`
//! in an ancestor of this crate. With `RW_PARITY_FETCH=1` (network), motors
//! with no embedded curve are fetched from ThrustCurve.org into
//! `tests/oracle/cache/thrustcurve/` (gitignored) and the case is imported
//! again with that cache (`RW_MOTOR_CACHE`).
//!
//! The report is written to `target/parity/import.json` (or
//! `$RW_PARITY_OURS/import.json`).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::path::{Path, PathBuf};

use assert_cmd::Command;
use base64::Engine;
use common::{TempProject, repo_root};
use serde_json::{Value, json};

const EXAMPLES_REL: &str = "openrocket/core/src/main/resources/datafiles/examples";

fn examples_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("RW_ORK_EXAMPLES") {
        return Some(PathBuf::from(d));
    }
    repo_root()
        .ancestors()
        .map(|a| a.join(EXAMPLES_REL))
        .find(|d| d.is_dir())
}

fn rw(project: &Path, cache: Option<&Path>) -> Command {
    let mut c = Command::cargo_bin("rocketwright").unwrap();
    c.env("RW_CLOCK", "2026-10-16T12:00:00Z")
        .env_remove("RW_TEST_HOOKS")
        .env(
            "RW_MOTOR_CACHE",
            cache.map(|p| p.as_os_str()).unwrap_or_default(),
        )
        .arg("--project")
        .arg(project)
        .current_dir(repo_root());
    c
}

fn run(project: &Path, cache: Option<&Path>, args: &[&str]) -> (i32, Value, String) {
    let o = rw(project, cache)
        .args(args)
        .arg("--json")
        .output()
        .unwrap();
    let v = serde_json::from_slice(&o.stdout).unwrap_or(Value::Null);
    (
        o.status.code().unwrap_or(-1),
        v,
        String::from_utf8_lossy(&o.stderr).into_owned(),
    )
}

fn curl_json(url: &str, body: &Value) -> Option<Value> {
    let o = std::process::Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "30",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
        ])
        .arg("--data")
        .arg(body.to_string())
        .arg(url)
        .output()
        .ok()?;
    o.status
        .success()
        .then(|| serde_json::from_slice(&o.stdout).ok())
        .flatten()
}

/// Fetches one motor's RASP file from ThrustCurve.org into `cache`
/// (network; `make parity` with `RW_PARITY_FETCH=1` only, invariant I10).
fn fetch(cache: &Path, maker: Option<&str>, designation: &str) -> Option<PathBuf> {
    let mut q = json!({"designation": designation, "maxResults": 5});
    if let Some(m) = maker {
        q["manufacturer"] = json!(m);
    }
    let found = curl_json("https://www.thrustcurve.org/api/v1/search.json", &q)?;
    let id = found["results"].as_array()?.first()?["motorId"]
        .as_str()?
        .to_string();
    let dl = curl_json(
        "https://www.thrustcurve.org/api/v1/download.json",
        &json!({"motorIds": [id], "format": "RASP", "data": "file"}),
    )?;
    let data = dl["results"].as_array()?.first()?["data"].as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    std::fs::create_dir_all(cache).ok()?;
    let stem: String = format!("{}_{designation}", maker.unwrap_or("motor"))
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let p = cache.join(format!("{stem}.eng"));
    std::fs::write(&p, bytes).ok()?;
    Some(p)
}

fn import(src: &Path, cache: Option<&Path>) -> (TempProject, Value) {
    let t = TempProject::new();
    let dir = t.0.join("p");
    let (code, v, err) = run(
        &t.0,
        cache,
        &[
            "import",
            "ork",
            src.to_str().unwrap(),
            dir.to_str().unwrap(),
        ],
    );
    // 1 = imported, but the check found errors (reported by `rw check`).
    assert!(
        code == 0 || code == 1,
        "import {}: exit {code}: {err}",
        src.display()
    );
    assert!(dir.join("rocketwright.toml").is_file(), "{}", src.display());
    (t, v)
}

fn substituted(model: &Value) -> Vec<(Option<String>, String)> {
    let mut out = Vec::new();
    for cfg in model["configs"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(_, c)| c)
    {
        for m in cfg["motors"].as_array().into_iter().flatten() {
            let i = &m["import"];
            if i["resolution"] == "substituted" {
                let k = (
                    i["manufacturer"].as_str().map(str::to_string),
                    i["designation"].as_str().unwrap_or("").to_string(),
                );
                if !out.contains(&k) {
                    out.push(k);
                }
            }
        }
    }
    out
}

#[test]
fn examples_import_and_check_clean() {
    if std::env::var("RW_PARITY").as_deref() != Ok("1") {
        eprintln!("import_parity: skipped (runs under `make parity`, RW_PARITY=1)");
        return;
    }
    let Some(examples) = examples_dir() else {
        panic!("RW_PARITY=1 but no OpenRocket examples found (set RW_ORK_EXAMPLES)");
    };
    let root = repo_root();
    let fetch_on = std::env::var("RW_PARITY_FETCH").as_deref() == Ok("1");
    let cache = root.join("tests/oracle/cache/thrustcurve");
    let known: Value =
        serde_json::from_str(include_str!("golden/import_parity.known.json")).unwrap();
    let mut report = Vec::new();
    let mut failures = Vec::new();
    for n in 1..=7 {
        let prov: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join(format!("tests/oracle/case{n}.provenance.json")))
                .unwrap(),
        )
        .unwrap();
        let name = prov["source_example"].as_str().unwrap();
        let src = examples.join(name);
        assert!(src.is_file(), "missing example {}", src.display());
        let (mut t, mut imported) = import(&src, cache.is_dir().then_some(cache.as_path()));
        let mut dir = t.0.join("p");
        let (_, eval, _) = run(&dir, None, &["eval"]);
        let subs = substituted(&eval["model"]);
        if fetch_on && !subs.is_empty() {
            let fetched = subs
                .iter()
                .filter(|(m, d)| fetch(&cache, m.as_deref(), d).is_some())
                .count();
            if fetched > 0 {
                (t, imported) = import(&src, Some(&cache));
                dir = t.0.join("p");
            }
        }
        let (code, check, err) = run(&dir, None, &["check"]);
        let diags: Vec<String> = check["diagnostics"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|d| {
                format!(
                    "{} {}",
                    d["code"].as_str().unwrap_or("?"),
                    d["message"].as_str().unwrap_or("")
                )
            })
            .collect();
        let import_diags: Vec<String> = imported["diagnostics"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|d| {
                format!(
                    "{} {}",
                    d["code"].as_str().unwrap_or("?"),
                    d["message"].as_str().unwrap_or("")
                )
            })
            .collect();
        eprintln!("case {n} ({name}): rw check exit {code}");
        for d in import_diags.iter().chain(&diags) {
            eprintln!("  {d}");
        }
        // Errors must be exactly the documented ones (none for most cases).
        let mut errors: Vec<(String, Option<String>)> = check["diagnostics"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|d| d["severity"] == "error")
            .map(|d| {
                (
                    d["code"].as_str().unwrap_or("?").to_string(),
                    d["path"].as_str().map(str::to_string),
                )
            })
            .collect();
        let mut expected: Vec<(String, Option<String>)> = known["cases"][n.to_string()]
            .as_array()
            .into_iter()
            .flatten()
            .map(|d| {
                (
                    d["code"].as_str().unwrap_or("?").to_string(),
                    d["path"].as_str().map(str::to_string),
                )
            })
            .collect();
        errors.sort();
        expected.sort();
        if errors != expected {
            failures.push(format!(
                "case {n}: rw check exit {code}; errors {errors:?} differ from the documented {expected:?} (crates/rw-cli/tests/golden/import_parity.known.json) {err}"
            ));
        } else if errors.is_empty() && code != 0 {
            failures.push(format!("case {n}: rw check exit {code}: {err}"));
        }
        // Report mode: fly the golden's sim and diff against the original matrix.
        let mut golden = root.join(format!("tests/oracle/case{n}-original.json"));
        if !golden.is_file() {
            golden = root.join(format!("tests/oracle/case{n}-generic.json"));
        }
        let g: Value = serde_json::from_str(&std::fs::read_to_string(&golden).unwrap()).unwrap();
        let sim = g["sim_name"]
            .as_str()
            .unwrap_or("")
            .to_ascii_lowercase()
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("_");
        let (sc, sv, serr) = run(&dir, None, &["sim", &sim]);
        let mut diff = Value::Null;
        if sc == 0 {
            let run_ref = sv["run_id"]
                .as_str()
                .map(|r| format!("{sim}/{r}"))
                .unwrap_or(sim.clone());
            let (_, dv, _) = run(
                &dir,
                None,
                &[
                    "diff",
                    "run",
                    &run_ref,
                    "--golden",
                    golden.to_str().unwrap(),
                ],
            );
            diff = dv;
        } else {
            eprintln!(
                "  sim {sim}: exit {sc}: {}",
                serr.lines().next().unwrap_or("")
            );
        }
        let apogee = |v: &Value| {
            v["rows"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|r| r["key"] == "apogee_m")
                .cloned()
        };
        if let Some(r) = apogee(&diff) {
            eprintln!(
                "  apogee ours {} vs OpenRocket {} ({}%)",
                r["a"], r["b"], r["delta_pct"]
            );
        }
        report.push(json!({
            "case": n,
            "example": name,
            "check_exit": code,
            "check_status": check["status"],
            "import_diagnostics": import_diags,
            "check_diagnostics": diags,
            "substituted": subs.iter().map(|(m, d)| json!({"manufacturer": m, "designation": d})).collect::<Vec<_>>(),
            "golden": golden.file_name().map(|f| f.to_string_lossy().into_owned()),
            "sim": sim,
            "sim_exit": sc,
            "diff": diff,
        }));
    }
    let out_dir = std::env::var_os("RW_PARITY_OURS")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("target/parity"));
    std::fs::create_dir_all(&out_dir).unwrap();
    std::fs::write(
        out_dir.join("import.json"),
        serde_json::to_string_pretty(&json!({"kind": "import-parity", "cases": report})).unwrap(),
    )
    .unwrap();
    assert!(failures.is_empty(), "{failures:#?}");
}
