//! CORE-owned oracle valve check (M1.5; ORC runs it before every export,
//! M1.44): `schema/oracle-golden.json` matches the Rust types, every file
//! under `tests/oracle/` matches an allowlist pattern, and every JSON there
//! validates, has no string over 200 chars, and carries consistent hashes.
//!
//! Regenerate the schema file with `RW_BLESS=1 cargo test -p rw-api --test oracle_golden_schema`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::path::Path;

use rw_api::{ORACLE_GOLDEN, ORACLE_MAX_STRING, OracleFile, conditions_hash, motor_digest};
use serde_json::Value;

fn schema_text() -> String {
    let mut s = serde_json::to_string_pretty(ORACLE_GOLDEN.schema().as_value()).unwrap();
    s.push('\n');
    s
}

#[test]
fn oracle_schema_file_is_current() {
    let path = common::repo_root().join("schema/oracle-golden.json");
    let want = schema_text();
    if std::env::var_os("RW_BLESS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &want).unwrap();
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        have == want,
        "schema/oracle-golden.json is stale; rerun with RW_BLESS=1"
    );
}

/// Allowlist patterns: `<n>` matches one or more digits, everything else is literal.
fn allowlist() -> Vec<String> {
    let text =
        std::fs::read_to_string(common::repo_root().join("tests/oracle/allowlist.txt")).unwrap();
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(String::from)
        .collect()
}

fn matches(pattern: &str, name: &str) -> bool {
    match pattern.split_once("<n>") {
        None => pattern == name,
        Some((pre, post)) => {
            name.len() > pre.len() + post.len()
                && name.starts_with(pre)
                && name.ends_with(post)
                && name[pre.len()..name.len() - post.len()]
                    .bytes()
                    .all(|b| b.is_ascii_digit())
        }
    }
}

#[test]
fn allowlist_patterns() {
    let pats = allowlist();
    for ok in [
        "case1-generic.json",
        "case12-generic.series.json",
        "case3.aero_sweep.json",
        "case1.geometry.json",
        "case7.provenance.json",
        "case2-original.json",
        "denylist.or.txt",
    ] {
        assert!(
            pats.iter().any(|p| matches(p, ok)),
            "{ok} should be allowed"
        );
    }
    for bad in [
        "case1.ork",
        "casex-generic.json",
        "case1-generic.json.bak",
        "notes.md",
        "case-generic.json",
        "README.md",
    ] {
        assert!(
            !pats.iter().any(|p| matches(p, bad)),
            "{bad} should be rejected"
        );
    }
}

fn check_strings(v: &Value, at: &str, out: &mut Vec<String>) {
    match v {
        Value::String(s) if s.chars().count() as u64 > ORACLE_MAX_STRING => {
            out.push(format!("{at}: string over {ORACLE_MAX_STRING} chars"))
        }
        Value::Array(a) => a
            .iter()
            .enumerate()
            .for_each(|(i, x)| check_strings(x, &format!("{at}/{i}"), out)),
        Value::Object(m) => {
            for (k, x) in m {
                if k.chars().count() as u64 > ORACLE_MAX_STRING {
                    out.push(format!("{at}: key over {ORACLE_MAX_STRING} chars"));
                }
                check_strings(x, &format!("{at}/{k}"), out);
            }
        }
        _ => {}
    }
}

/// Validates one oracle JSON value; returns the problems.
fn check_oracle(v: &Value) -> Vec<String> {
    let schema = ORACLE_GOLDEN.schema();
    let mut out = common::errors(schema.as_value(), v);
    check_strings(v, "", &mut out);
    match serde_json::from_value::<OracleFile>(v.clone()) {
        Err(e) => out.push(format!("serde: {e}")),
        Ok(OracleFile::Golden(g)) => {
            if g.conditions_hash != conditions_hash(&g.conditions) {
                out.push(format!(
                    "conditions_hash {} != {}",
                    g.conditions_hash,
                    conditions_hash(&g.conditions)
                ));
            }
            if g.motor_digest != motor_digest(&g.motors) {
                out.push("motor_digest does not match motors".into());
            }
        }
        Ok(OracleFile::Geometry(geo)) => {
            for s in &geo.sims {
                if s.conditions_hash != conditions_hash(&s.conditions) {
                    out.push(format!("sim {}: conditions_hash mismatch", s.name));
                }
            }
        }
        Ok(_) => {}
    }
    out
}

#[test]
fn oracle_files_valid() {
    let dir = common::repo_root().join("tests/oracle");
    let pats = allowlist();
    let owned_by_bar = [
        "README.md",
        "keymap.json",
        "tolerances.json",
        "allowlist.txt",
    ];
    let mut failures = Vec::new();
    for e in std::fs::read_dir(&dir).unwrap().flatten() {
        let p = e.path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if p.is_dir() || owned_by_bar.contains(&name.as_str()) {
            continue; // cache/ is gitignored; BAR files are not oracle exports
        }
        if !pats.iter().any(|pat| matches(pat, &name)) {
            failures.push(format!("{name}: not on tests/oracle/allowlist.txt"));
            continue;
        }
        if Path::new(&name).extension().is_some_and(|x| x == "json") {
            for err in check_oracle(&common::read_json(&p)) {
                failures.push(format!("{name}: {err}"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn oracle_contract_fixtures_valid() {
    let dir = common::repo_root().join("fixtures/contracts/oracle");
    let files = common::json_files(&dir);
    assert!(!files.is_empty(), "no oracle contract fixtures");
    for f in files {
        let fx = common::read_json(&f);
        assert_eq!(fx["type"], "oracle-golden", "{}", f.display());
        let errs = check_oracle(&fx["payload"]);
        assert!(errs.is_empty(), "{}: {errs:?}", f.display());
    }
}

#[test]
fn oversized_string_rejected() {
    let dir = common::repo_root().join("fixtures/contracts/oracle");
    let mut v = common::read_json(&dir.join("golden.json"))["payload"].clone();
    v["sim_name"] = Value::String("x".repeat(201));
    assert!(!check_oracle(&v).is_empty());
    let mut v2 = common::read_json(&dir.join("golden.json"))["payload"].clone();
    v2["notes"] = Value::String("free text".into());
    assert!(
        !check_oracle(&v2).is_empty(),
        "unknown keys must be rejected"
    );
}

fn fixture_payload(name: &str) -> Value {
    let dir = common::repo_root().join("fixtures/contracts/oracle");
    common::read_json(&dir.join(name))["payload"].clone()
}

/// Sets `conditions` on a golden and rehashes it, so only the schema and
/// serde decide validity.
fn golden_with_conditions(conditions: Value) -> Value {
    let mut g = fixture_payload("golden.json");
    g["conditions"] = conditions;
    if let Ok(c) = serde_json::from_value::<rw_model::Conditions>(g["conditions"].clone()) {
        g["conditions_hash"] = Value::String(conditions_hash(&c));
    }
    g
}

/// M1.44c: `gravity` and `launch_into_wind` are optional, so files written
/// before them keep validating and keep their `conditions_hash`.
#[test]
fn conditions_extensions_keep_old_hashes() {
    let golden = common::read_json(&common::repo_root().join("tests/oracle/case1-generic.json"));
    let raw = golden["conditions"].clone();
    assert!(raw.get("gravity").is_none() && raw.get("launch_into_wind").is_none());
    let c: rw_model::Conditions = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(c.gravity, None);
    assert_eq!(c.launch_into_wind, None);
    assert_eq!(
        serde_json::to_value(&c).unwrap(),
        raw,
        "round trip adds no keys"
    );
    assert_eq!(golden["conditions_hash"], conditions_hash(&c).as_str());

    let mut with = c.clone();
    with.launch_into_wind = Some(false);
    assert_ne!(
        conditions_hash(&with),
        conditions_hash(&c),
        "explicit false is hashed"
    );
    let mut g = c;
    g.gravity = Some(rw_model::GravityModel::Constant { g_ms2: 9.80665 });
    let v = serde_json::to_value(&g).unwrap();
    assert_eq!(
        v["gravity"],
        serde_json::json!({"model": "constant", "g_ms2": 9.80665})
    );
}

#[test]
fn gravity_model_shapes() {
    let base = fixture_payload("golden.json")["conditions"].clone();
    let with = |gravity: Value| {
        let mut c = base.clone();
        c["gravity"] = gravity;
        check_oracle(&golden_with_conditions(c))
    };
    use serde_json::json;
    for ok in [
        json!({"model": "wgs84"}),
        json!({"model": "constant", "g_ms2": 9.81}),
        Value::Null,
    ] {
        let errs = with(ok.clone());
        assert!(errs.is_empty(), "{ok}: {errs:?}");
    }
    for bad in [
        json!({"model": "constant"}),
        json!({"model": "moon"}),
        json!({"model": "wgs84", "g_ms2": 9.81}),
        json!("wgs84"),
        json!(9.81),
    ] {
        assert!(!with(bad.clone()).is_empty(), "{bad} should be rejected");
    }
    let mut c = base.clone();
    c["launch_into_wind"] = json!("yes");
    assert!(!check_oracle(&golden_with_conditions(c)).is_empty());
}

#[test]
fn series_cells_nullable() {
    let mut s = fixture_payload("series.json");
    assert!(
        s["rows"].as_array().unwrap().iter().any(|r| r
            .as_array()
            .unwrap()
            .iter()
            .any(Value::is_null)),
        "series fixture should exercise a null cell"
    );
    assert!(check_oracle(&s).is_empty());
    s["rows"][1][1] = Value::String("n/a".into());
    assert!(
        !check_oracle(&s).is_empty(),
        "string cells must be rejected"
    );
}

#[test]
fn aero_sweep_components_optional() {
    let a = fixture_payload("aero_sweep.json");
    assert!(
        a["points"][0]["components"]
            .as_array()
            .is_some_and(|c| !c.is_empty()),
        "aero_sweep fixture should exercise components"
    );
    let mut bare = a.clone();
    for p in bare["points"].as_array_mut().unwrap() {
        p.as_object_mut().unwrap().remove("components");
    }
    assert!(check_oracle(&bare).is_empty(), "components are optional");

    let mut extra = a.clone();
    extra["points"][0]["components"][0]["notes"] = Value::String("x".into());
    assert!(
        !check_oracle(&extra).is_empty(),
        "unknown component keys rejected"
    );
    let mut unnamed = a;
    unnamed["points"][0]["components"][0]
        .as_object_mut()
        .unwrap()
        .remove("name");
    assert!(
        !check_oracle(&unnamed).is_empty(),
        "component name required"
    );
}
