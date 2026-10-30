//! M2.14: `cargo test -p rw-cli --test motor_import`. `rw motor import
//! <file.eng|file.rse>` copies the file into the project's `lib/motors/`
//! with its sha256 in `rocketwright.toml [lib.sha256]`: `rw lib search`
//! lists it with that sha256, `rw motor show` resolves its ref, and a later edit
//! to the copy is `RW-E006 lib-hash`. A file in neither dialect is
//! `RW-E008 motor-dialect`. Over MCP, `import_file` is gated (`always_ask`,
//! I16) and `kind = "motor"` runs on the session.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::path::Path;

use assert_cmd::Command;
use common::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const ENG: &str = "; test curve\n\
IMP_D9 24 70 3-5-7 0.0098 0.0458 Test\n\
   0.02 10.0\n\
   0.20 22.0\n\
   0.80 10.0\n\
   1.60 9.0\n\
   1.80 0.0\n";

const RSE: &str = r#"<engine-database><engine-list>
<engine code="IMP_T1" mfg="Test" dia="24" len="100" initWt="30" propWt="10" delays="P">
<data>
  <eng-data t="0" f="0" m="30" cg="40"/>
  <eng-data t="1" f="10" m="25" cg="45"/>
  <eng-data t="2" f="0" m="20" cg="50"/>
</data>
</engine>
</engine-list></engine-database>
"#;

fn sha256(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

fn rw(project: &Path) -> Command {
    let mut c = Command::cargo_bin("rocketwright").unwrap();
    c.env("RW_CLOCK", "2026-10-16T12:00:00Z")
        .env_remove("RW_TEST_HOOKS")
        .arg("--project")
        .arg(project);
    c
}

fn run(project: &Path, args: &[&str], code: i32) -> std::process::Output {
    let o = rw(project).args(args).output().unwrap();
    assert_eq!(
        o.status.code(),
        Some(code),
        "rw {}: stdout {} stderr {}",
        args.join(" "),
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
    o
}

fn json_of(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes)
        .unwrap_or_else(|e| panic!("not JSON ({e}): {}", String::from_utf8_lossy(bytes)))
}

fn lib_motor<'a>(items: &'a Value, id: &str) -> Option<&'a Value> {
    items["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == id)
}

#[test]
fn import_lists_shows_and_detects_tampering() {
    let p = TempProject::fixture("fixtures/simple");
    let src = TempProject::new();
    let eng = src.0.join("Imp D9.eng");
    std::fs::write(&eng, ENG).unwrap();
    let eng_arg = eng.to_str().unwrap();

    // Dry run: nothing written, the plan listed.
    let o = run(
        &p.0,
        &["--json", "motor", "import", eng_arg, "--dry-run"],
        0,
    );
    let v = json_of(&o.stdout);
    assert_eq!(v["dry_run"], true);
    assert_eq!(v["imported"], json!(["lib:motors/Imp_D9.eng#IMP_D9"]));
    assert_eq!(
        v["files"][0],
        json!({"path": "lib/motors/Imp_D9.eng", "status": "A"})
    );
    assert!(!p.0.join("lib/motors/Imp_D9.eng").exists());

    // Import: byte-identical copy, hash recorded, a history step.
    let o = run(&p.0, &["--json", "motor", "import", eng_arg], 0);
    let v = json_of(&o.stdout);
    assert!(
        v["step"].as_str().is_some_and(|s| s.starts_with("step:")),
        "{v}"
    );
    let copied = std::fs::read(p.0.join("lib/motors/Imp_D9.eng")).unwrap();
    assert_eq!(copied, ENG.as_bytes());
    let sha = sha256(ENG.as_bytes());
    let manifest = std::fs::read_to_string(p.0.join("rocketwright.toml")).unwrap();
    assert!(
        manifest.contains(&format!("\"lib/motors/Imp_D9.eng\" = \"{sha}\"")),
        "{manifest}"
    );

    // lib search lists it, verified, with the file's sha256.
    let o = run(&p.0, &["--json", "lib", "search", "--kind", "motor"], 0);
    let items = json_of(&o.stdout);
    let m = lib_motor(&items, "lib:lib/motors/Imp_D9.eng").expect("listed");
    assert_eq!(m["sha256"], sha);
    assert_eq!(m["name"], "IMP_D9");
    assert!(m["source"].as_str().unwrap().contains("verified"), "{m}");

    // The ref resolves for motor_show.
    let o = run(
        &p.0,
        &["--json", "motor", "show", "lib:motors/Imp_D9.eng#IMP_D9"],
        0,
    );
    assert_eq!(json_of(&o.stdout)["info"]["designation"], "IMP_D9");

    // Re-importing the same bytes is a no-op; different bytes under the
    // same name conflict.
    let o = run(&p.0, &["--json", "motor", "import", eng_arg], 0);
    assert_eq!(json_of(&o.stdout)["step"], Value::Null);
    std::fs::write(&eng, ENG.replace("22.0", "23.0")).unwrap();
    let o = run(&p.0, &["--json", "motor", "import", eng_arg], 1);
    assert_eq!(json_of(&o.stderr)["error"]["code"], "conflict");

    // Tamper with the copy: RW-E006 lib-hash, and the file is not used.
    std::fs::write(
        p.0.join("lib/motors/Imp_D9.eng"),
        ENG.replace("10.0", "11.0"),
    )
    .unwrap();
    let o = run(&p.0, &["--json", "check"], 1);
    let report = json_of(&o.stdout);
    let codes: Vec<&str> = report["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["code"].as_str().unwrap())
        .collect();
    assert!(codes.contains(&"RW-E006"), "{codes:?}");
    let o = run(&p.0, &["--json", "lib", "search", "--kind", "motor"], 0);
    let m = lib_motor(&json_of(&o.stdout), "lib:lib/motors/Imp_D9.eng")
        .unwrap()
        .clone();
    assert_ne!(m["sha256"], sha);
    assert!(m["source"].as_str().unwrap().contains("mismatch"), "{m}");
}

#[test]
fn rse_imports_and_unknown_dialects_fail() {
    let p = TempProject::fixture("fixtures/simple");
    let src = TempProject::new();
    let rse = src.0.join("imp_t1.rse");
    std::fs::write(&rse, RSE).unwrap();
    let o = run(
        &p.0,
        &["--json", "motor", "import", rse.to_str().unwrap()],
        0,
    );
    assert_eq!(
        json_of(&o.stdout)["imported"],
        json!(["lib:motors/imp_t1.rse#IMP_T1"])
    );
    let o = run(&p.0, &["--json", "lib", "search", "IMP_T1"], 0);
    let m = lib_motor(&json_of(&o.stdout), "lib:lib/motors/imp_t1.rse")
        .expect("listed")
        .clone();
    assert_eq!(m["sha256"], sha256(RSE.as_bytes()));

    // Neither dialect: RW-E008, exit 2, nothing written.
    let csv = src.0.join("curve.csv");
    std::fs::write(&csv, "time,thrust\n0,0\n1,10\n").unwrap();
    let o = run(
        &p.0,
        &["--json", "motor", "import", csv.to_str().unwrap()],
        2,
    );
    let e = json_of(&o.stderr);
    assert_eq!(e["error"]["diagnostics"][0]["code"], "RW-E008", "{e}");
    assert!(
        e["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unknown motor file dialect")
    );
    // A known extension that does not parse is the same code.
    let bad = src.0.join("bad.eng");
    std::fs::write(&bad, "not a motor\n").unwrap();
    let o = run(
        &p.0,
        &["--json", "motor", "import", bad.to_str().unwrap()],
        2,
    );
    assert_eq!(
        json_of(&o.stderr)["error"]["diagnostics"][0]["code"],
        "RW-E008"
    );
    let names: Vec<String> = std::fs::read_dir(p.0.join("lib/motors"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["imp_t1.rse"]);

    // A missing file is an I/O error (exit 2).
    run(&p.0, &["motor", "import", "/nonexistent/x.eng"], 2);
}

#[test]
fn mcp_import_file_is_gated_and_imports_motors() {
    let p = TempProject::fixture("fixtures/simple");
    let src = TempProject::new();
    let eng = src.0.join("imp.eng");
    std::fs::write(&eng, ENG).unwrap();
    let mut s = Sidecar::started(&p.0);

    let tools = s.rpc.result("tools/list", json!({}))["tools"].clone();
    let t = tools
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "import_file")
        .unwrap()
        .clone();
    assert_eq!(t["_meta"]["rw/permission_policy"], "always_ask", "{t}");

    let v = s.rpc.ok(
        "import_file",
        json!({"path": eng.to_str().unwrap(), "kind": "motor"}),
    );
    assert_eq!(v["imported"], json!(["lib:motors/imp.eng#IMP_D9"]));
    let errs = validate("tools/import_file.output", &v);
    assert!(errs.is_empty(), "{errs:?}");
    let items = s.rpc.ok("library_search", json!({"kind": "motor"}));
    assert_eq!(
        lib_motor(&items, "lib:lib/motors/imp.eng").unwrap()["sha256"],
        sha256(ENG.as_bytes())
    );
    // A motor file is not an .ork (kind = "ork" is the M2.5 importer).
    let r = s.rpc.tool(
        "import_file",
        json!({"path": eng.to_str().unwrap(), "kind": "ork"}),
    );
    assert_eq!(r["isError"], true, "{r}");
    assert_ne!(r["_meta"]["rw/error"]["code"], "not_implemented", "{r}");
    assert!(s.stop().success());
}
