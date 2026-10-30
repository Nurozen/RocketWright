//! M1.30: `cargo test -p rw-cli --test cli_e2e`. The `rw` commands end to
//! end through the binary (assert_cmd): output goldens for the
//! deterministic commands (`tests/golden/cli/`; `RW_BLESS=1` rewrites them),
//! the exit-code matrix (0 clean, 1 failure, 2 usage/I-O), `--imgsize`
//! renders, and the B2 comparison `rw diff run <run> --golden
//! tests/oracle/case1-generic.json` on `fixtures/case1`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::path::{Path, PathBuf};

use assert_cmd::Command;
use common::*;
use serde_json::Value;

/// A pinned clock: history steps and manifests are reproducible.
const CLOCK: &str = "2026-10-16T12:00:00Z";

fn rw(project: &Path) -> Command {
    let mut c = Command::cargo_bin("rocketwright").unwrap();
    c.env("RW_CLOCK", CLOCK)
        .env_remove("RW_TEST_HOOKS")
        // Hermetic 3D rows: no renderer beside target/<profile>/ (tests/render3d.rs covers it).
        .env_remove("RW_RENDER")
        .arg("--project")
        .arg(project)
        .current_dir(repo_root());
    c
}

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/cli")
}

/// Compares `actual` with `tests/golden/cli/<name>` (or writes it with RW_BLESS=1).
fn golden(name: &str, actual: &str) {
    let p = golden_dir().join(name);
    if std::env::var("RW_BLESS").ok().as_deref() == Some("1") {
        std::fs::create_dir_all(golden_dir()).unwrap();
        std::fs::write(&p, actual).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&p)
        .unwrap_or_else(|_| panic!("missing golden {name}; run with RW_BLESS=1"));
    assert_eq!(actual, want, "golden {name} differs (RW_BLESS=1 to update)");
}

fn stdout(o: &std::process::Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn json_out(o: &std::process::Output) -> Value {
    serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("not JSON ({e}): {}", stdout(o)))
}

/// Runs `args` in `project`; asserts the exit code; returns the output.
fn run(project: &Path, args: &[&str], code: i32) -> std::process::Output {
    let o = rw(project).args(args).output().unwrap();
    assert_eq!(
        o.status.code(),
        Some(code),
        "rw {}: stdout {} stderr {}",
        args.join(" "),
        stdout(&o),
        String::from_utf8_lossy(&o.stderr)
    );
    o
}

fn png_size(png: &[u8]) -> (u32, u32) {
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let w = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(png[20..24].try_into().unwrap());
    (w, h)
}

#[test]
fn goldens_on_fixtures_simple() {
    let p = TempProject::fixture("fixtures/simple");
    let o = run(&p.0, &["check", "--json"], 0);
    golden("check.simple.json", &stdout(&o));
    let o = run(&p.0, &["check"], 0);
    golden("check.simple.txt", &stdout(&o));
    let o = run(&p.0, &["validate", "--json"], 0);
    golden("validate.simple.json", &stdout(&o));
    let o = run(&p.0, &["eval", "/name", "--json"], 0);
    golden("eval.name.simple.json", &stdout(&o));
    let o = run(
        &p.0,
        &["set", "params.fin_span.value=60 mm", "--dry-run", "--json"],
        0,
    );
    golden("set.dry.simple.json", &stdout(&o));
    let o = run(&p.0, &["motor", "search", "--class", "C"], 0);
    golden("motor.search.c.txt", &stdout(&o));
    let o = run(&p.0, &["fmt", "--check", "--json"], 0);
    golden("fmt.check.simple.json", &stdout(&o));
    // Nothing above wrote a source file: the only step is the snapshot the
    // first writer session (the dry run) recorded.
    let o = run(&p.0, &["history", "log", "--json"], 0);
    let steps = json_out(&o)["steps"].clone();
    assert_eq!(steps.as_array().unwrap().len(), 1, "{steps}");
    assert_eq!(steps[0]["title"], "Initial snapshot");
}

#[test]
fn schema_needs_no_project() {
    let dir = TempProject::new();
    let o = run(&dir.0, &["schema"], 0);
    golden("schema.names.txt", &stdout(&o));
    let o = run(&dir.0, &["schema", "check-delta", "--json"], 0);
    assert_eq!(
        json_out(&o)["schema"]["$id"],
        "https://rocketwright.dev/schema/1/check-delta.json"
    );
}

#[test]
fn case1_sim_and_diff_run_against_the_golden() {
    let p = TempProject::fixture("fixtures/case1");
    let o = run(&p.0, &["sim", "simulation_5", "--json"], 0);
    let sim = json_out(&o);
    assert_eq!(sim["status"], "complete", "{sim}");
    let run_id = sim["run_id"].as_str().unwrap().to_string();
    let dir = p.0.join("runs/simulation_5").join(&run_id);
    for f in ["manifest.json", "summary.json", "events.json", "series.csv"] {
        assert!(dir.join(f).is_file(), "{f}");
    }
    let csv = std::fs::read_to_string(dir.join("series.csv")).unwrap();
    let rows: Vec<Vec<f64>> = csv
        .lines()
        .skip(1)
        .map(|l| {
            l.split(',')
                .map(|c| c.parse().unwrap_or(f64::NAN))
                .collect()
        })
        .collect();
    let on_grid = rows
        .iter()
        .filter(|r| ((r[0] * 100.0).round() - r[0] * 100.0).abs() < 1e-6)
        .count();
    assert!(
        on_grid * 10 > rows.len() * 9,
        "a 0.01 s grid plus event rows"
    );

    // The B2 comparison, golden path relative to the repo root.
    let o = run(
        &p.0,
        &[
            "diff",
            "run",
            &run_id,
            "--golden",
            "tests/oracle/case1-generic.json",
        ],
        0,
    );
    golden("diff_run.case1.txt", &stdout(&o));
    let o = run(
        &p.0,
        &[
            "diff",
            "run",
            &run_id,
            "--golden",
            "tests/oracle/case1-generic.json",
            "--json",
        ],
        0,
    );
    let d = json_out(&o);
    assert_eq!(d["pass"], true);
    assert!(d["mismatches"].as_array().unwrap().is_empty());
    // Phase rows (B3 round 11, T5): both sides of each flight phase, in
    // time order, never gated.
    let phases = d["phases"].as_array().expect("phase rows");
    let keys: Vec<&str> = phases.iter().map(|r| r["key"].as_str().unwrap()).collect();
    assert_eq!(
        keys,
        [
            "rail_exit.t_s",
            "rail_exit.altitude_m",
            "rail_exit.velocity_ms",
            "burnout.t_s",
            "burnout.altitude_m",
            "burnout.velocity_ms",
            "apogee.t_s",
            "apogee.altitude_m",
            "deployment.t_s",
            "deployment.altitude_m",
            "deployment.velocity_ms",
            "landing.t_s",
            "landing.velocity_ms",
        ]
    );
    let bo = phases
        .iter()
        .find(|r| r["key"] == "burnout.velocity_ms")
        .unwrap();
    assert!(
        bo["a"].is_number() && bo["b"].is_number() && bo["delta"].is_number(),
        "{bo}"
    );
    assert!(
        phases
            .iter()
            .all(|r| r.get("tol").is_none() && r.get("pass").is_none())
    );
    let scored: Vec<&Value> = d["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r.get("tol").is_some())
        .collect();
    let keys: Vec<&str> = scored.iter().map(|r| r["key"].as_str().unwrap()).collect();
    assert_eq!(
        keys,
        [
            "apogee_m",
            "max_velocity_ms",
            "time_to_apogee_s",
            "mass.cg",
            "aero.cp",
            "stability.liftoff"
        ]
    );
    assert!(scored.iter().all(|r| r["pass"] == true));

    // A golden copied on its own (the B3 kit's `data/`, no tolerances.json
    // beside it) is scored with the built-in table, and the text names the
    // keys compared without a tolerance (B3 round 8).
    let alone = p.0.join("kit-data");
    std::fs::create_dir_all(&alone).unwrap();
    std::fs::copy(
        repo_root().join("tests/oracle/case1-generic.json"),
        alone.join("case1-generic.json"),
    )
    .unwrap();
    let o = run(
        &p.0,
        &[
            "diff",
            "run",
            &run_id,
            "--golden",
            alone.join("case1-generic.json").to_str().unwrap(),
        ],
        0,
    );
    let text = stdout(&o);
    let row = |k: &str| {
        text.lines()
            .find(|l| l.trim_start().starts_with(&format!("{k} ")))
            .unwrap_or_else(|| panic!("no {k} row:\n{text}"))
            .to_string()
    };
    assert!(row("apogee_m").ends_with("3%  pass"), "{text}");
    assert!(row("mass.cg").ends_with("1 mm  pass"), "{text}");
    assert!(row("max_mach").ends_with("none  not gated"), "{text}");
    assert!(
        text.contains("gated: 6 key(s) with a tolerance, 6 pass, 0 FAIL")
            && text.contains("no tolerance (compared, not gated): max_accel_ms2, max_mach,"),
        "{text}"
    );

    // A second `rw sim` is a cache hit with byte-identical summary.json.
    let before = std::fs::read(dir.join("summary.json")).unwrap();
    let o = run(&p.0, &["sim", "simulation_5", "--json"], 0);
    assert_eq!(json_out(&o)["cached"], true);
    let o = run(&p.0, &["sim", "simulation_5", "--force", "--json"], 0);
    assert_eq!(json_out(&o)["run_id"], run_id.as_str());
    // The sim's display name resolves to the same sim (and the same cached run).
    let o = run(&p.0, &["sim", "Simulation 5", "--json"], 0);
    let by_name = json_out(&o);
    assert_eq!(by_name["sim"], "simulation_5", "{by_name}");
    assert_eq!(by_name["run_id"], run_id.as_str());
    assert_eq!(by_name["cached"], true);
    assert_eq!(std::fs::read(dir.join("summary.json")).unwrap(), before);

    // A tolerance tighter than the measured delta fails (exit 1).
    run(
        &p.0,
        &[
            "diff",
            "run",
            &run_id,
            "--golden",
            "tests/oracle/case1-generic.json",
            "--tol",
            "apogee_m=0.01%",
        ],
        1,
    );
    // Two runs of the same sim compare clean, phase rows included.
    let same = stdout(&run(&p.0, &["diff", "run", &run_id, &run_id], 0));
    assert!(
        same.contains("\n  phases (main-flight events in time order"),
        "{same}"
    );
    let bo = same
        .lines()
        .find(|l| l.trim_start().starts_with("burnout.altitude_m "))
        .unwrap_or_else(|| panic!("no burnout row:\n{same}"));
    assert!(bo.contains(" m ") && bo.contains("+0 m"), "{bo}");

    // An outdated run keeps its static rows: CG, CP, CNa, and stability come
    // from the run's own model (its history step), not the edited one, so no
    // agent subtracts CG or CP itself (B3 round 11).
    let static_rows = |text: &str| -> Vec<String> {
        let at = text
            .lines()
            .position(|l| l.trim_start().starts_with("static ("))
            .unwrap_or_else(|| panic!("no static heading:\n{text}"));
        text.lines()
            .skip(at + 1)
            .take(4)
            .map(|l| l.split_whitespace().next().unwrap_or("").to_string())
            .collect()
    };
    let before = stdout(&run(
        &p.0,
        &[
            "diff",
            "run",
            &run_id,
            "--golden",
            "tests/oracle/case1-generic.json",
        ],
        0,
    ));
    assert_eq!(
        static_rows(&before),
        ["mass.cg", "aero.cp", "aero.cna", "stability.liftoff"]
    );
    let cg = |text: &str| {
        text.lines()
            .find(|l| l.trim_start().starts_with("mass.cg "))
            .unwrap_or_else(|| panic!("no mass.cg row:\n{text}"))
            .to_string()
    };
    // Any edit outdates the run: a longer nose moves the current CG.
    let edit = run(&p.0, &["set", "c.nose.length=110 mm"], 0);
    assert!(
        stdout(&edit).contains("recorded step:"),
        "{}",
        stdout(&edit)
    );
    let now = stdout(&run(&p.0, &["check"], 0));
    assert!(!now.contains("CG 261.69 mm"), "the edit moves CG:\n{now}");
    let after = stdout(&run(
        &p.0,
        &[
            "diff",
            "run",
            &run_id,
            "--golden",
            "tests/oracle/case1-generic.json",
        ],
        0,
    ));
    assert_eq!(cg(&after), cg(&before), "{after}");
    assert!(cg(&after).ends_with("1 mm  pass"), "{after}");
    assert!(
        after.contains("  note: static rows: the run's model (step:"),
        "{after}"
    );
    let d = json_out(&run(
        &p.0,
        &[
            "diff",
            "run",
            &run_id,
            "--golden",
            "tests/oracle/case1-generic.json",
            "--json",
        ],
        0,
    ));
    assert_eq!(d["notes"].as_array().map(Vec::len), Some(1), "{d}");
}

#[test]
fn render_imgsize_and_manifest() {
    let p = TempProject::fixture("fixtures/simple");
    let o = run(
        &p.0,
        &[
            "render",
            "--view",
            "profile",
            "--imgsize",
            "800x600",
            "--json",
        ],
        0,
    );
    let r = json_out(&o);
    assert_eq!(
        (r["width"].clone(), r["height"].clone()),
        (800.into(), 600.into())
    );
    let path = r["path"].as_str().unwrap();
    assert_eq!(path, "renders/c6.profile.png");
    let png = std::fs::read(p.0.join(path)).unwrap();
    assert_eq!(png_size(&png), (800, 600));
    run(&p.0, &["render", "--view", "fin", "--config", "b4"], 0);
    let m: Value =
        serde_json::from_str(&std::fs::read_to_string(p.0.join("renders/manifest.json")).unwrap())
            .unwrap();
    let keys: Vec<&String> = m["renders"].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["renders/b4.fin.png", "renders/c6.profile.png"]);
    // Deterministic: the same render gives the same bytes.
    run(
        &p.0,
        &["render", "--view", "profile", "--imgsize", "800x600"],
        0,
    );
    assert_eq!(std::fs::read(p.0.join(path)).unwrap(), png);
}

/// B3 round 12: `rw render` prints what it drew (station range and radial
/// extent per component, and part-to-parent relations), in display units,
/// and the same as numbers under `legend` in `--json`. Case 1's fins
/// overhang the body tube's aft end by 25.4 mm; the lug sits halfway along it.
#[test]
fn render_prints_a_legend_of_what_it_drew() {
    let p = TempProject::fixture("fixtures/case1");
    let o = run(&p.0, &["render", "--view", "profile"], 0);
    golden("render.legend.case1.txt", &stdout(&o));
    let text = stdout(&o);
    assert!(
        text.contains(
            "  fins (trapezoidal_fin_set, x3, on body): x 349.2-425.4 mm, r 12.5-42.5 mm"
        ),
        "{text}"
    );
    assert!(
        text.contains("  fins: aft end 25.4 mm past the body aft end (overhang)"),
        "{text}"
    );
    assert!(text.contains("  lug: at 250 mm, 50% along body"), "{text}");
    let r = json_out(&run(&p.0, &["render", "--view", "profile", "--json"], 0));
    let rel = r["legend"]["relations"].as_array().unwrap();
    let fins = rel.iter().find(|x| x["component"] == "fins").unwrap();
    assert_eq!(fins["kind"], "overhangs_aft");
    assert_eq!(fins["distance"], 0.0254);
    let lug = rel.iter().find(|x| x["component"] == "lug").unwrap();
    assert_eq!(
        (
            lug["kind"].clone(),
            lug["station"].clone(),
            lug["fraction"].clone()
        ),
        ("along".into(), 0.25.into(), 0.5.into())
    );
    let body = r["legend"]["components"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "body")
        .unwrap()
        .clone();
    assert_eq!(
        (
            body["x_fore"].clone(),
            body["x_aft"].clone(),
            body["r_outer"].clone()
        ),
        (0.1.into(), 0.4.into(), 0.0125.into())
    );
    // The fin view lists only the fin sets; flush fins say so.
    let fin = stdout(&run(&p.0, &["render", "--view", "fin"], 0));
    assert!(
        fin.contains("  fins (") && !fin.contains("  body ("),
        "{fin}"
    );
    let s = TempProject::fixture("fixtures/simple");
    let t = stdout(&run(&s.0, &["render", "--view", "profile"], 0));
    assert!(
        t.contains("aft end flush with the body aft end")
            || t.contains("past the body aft end")
            || t.contains("forward of the body aft end"),
        "{t}"
    );
}

#[test]
fn init_then_edit_check_and_history() {
    let d = TempProject::new();
    let proj = d.0.join("alpha");
    let o = Command::cargo_bin("rocketwright")
        .unwrap()
        .env("RW_CLOCK", CLOCK)
        .args([
            "init",
            "--template",
            "simple-rocket",
            "--name",
            "Alpha",
            "--json",
        ])
        .arg(&proj)
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    assert_eq!(json_out(&o)["step"], "step:1");
    assert_eq!(
        std::fs::read_to_string(proj.join(".gitignore")).unwrap(),
        ".rw/\n"
    );
    run(&proj, &["check", "--strict"], 0);
    // init on an existing project: conflict (exit 1).
    let o = Command::cargo_bin("rocketwright")
        .unwrap()
        .arg("init")
        .arg(&proj)
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1));

    let o = run(&proj, &["set", "c.fins.span=40 mm", "--json"], 0);
    let v = json_out(&o);
    assert_eq!(v["step"], "step:2");
    assert!(v["delta"]["changed"]["stability.liftoff"].is_array());
    let o = run(&proj, &["history", "log", "--json"], 0);
    let steps = json_out(&o)["steps"].clone();
    assert_eq!(steps[1]["origin"], "cli");
    run(&proj, &["history", "tag", "wide fins"], 0);
    run(&proj, &["history", "show", "step:2"], 0);
    run(&proj, &["history", "compare", "step:1", "live"], 0);
    run(&proj, &["diff", "model", "step:1", "live"], 0);
    run(&proj, &["fmt"], 0);
    run(&proj, &["lib", "search"], 0);
    run(&proj, &["motor", "show", "generic:RW_C6G"], 0);
    let o = run(&proj, &["check", "--sim", "quick", "--json"], 0);
    assert_eq!(json_out(&o)["tier"], "quick_sim");
}

#[test]
fn exit_code_matrix() {
    let simple = TempProject::fixture("fixtures/simple");
    let rv = TempProject::fixture("fixtures/research-vehicle");
    let empty = TempProject::new();
    let s = simple.0.as_path();
    // (project, args, code)
    let matrix: &[(&Path, &[&str], i32)] = &[
        (s, &["check"], 0),
        (s, &["check", "--strict"], 0),
        (rv.0.as_path(), &["check", "--config", "baseline"], 0),
        (
            rv.0.as_path(),
            &["check", "--config", "baseline", "--strict"],
            1,
        ),
        (s, &["validate"], 0),
        (s, &["fmt", "--check"], 0),
        (s, &["sim", "nope"], 1),
        (s, &["rm", "nope"], 1),
        (s, &["motor", "show", "nope"], 1),
        (s, &["history", "show", "step:99"], 1),
        (s, &["render", "--view", "iso"], 2),
        (s, &["render", "--view", "profile", "--imgsize", "800"], 2),
        (s, &["render", "--view", "sideways"], 2),
        (s, &["check", "--sim", "slow"], 2),
        (s, &["set", "nonsense"], 2),
        (s, &["add", "x", "{not json"], 2),
        (s, &["frobnicate"], 2),
        (empty.0.as_path(), &["check"], 2),
        (empty.0.as_path(), &["sim", "x"], 2),
    ];
    for (p, args, code) in matrix {
        run(p, args, *code);
    }
    // An edit that leaves errors is written, and exits 1; so does `check`.
    run(s, &["set", "params.fin_span.value=1 mm"], 1);
    run(s, &["check"], 1);
    // A file that does not parse fails validation (exit 1) and fmt (exit 2).
    std::fs::write(s.join("sims/b4.rw.toml"), "name = [unclosed\n").unwrap();
    run(s, &["validate"], 1);
    run(s, &["fmt", "--check"], 2);
}

/// M2.7: `rw render --view profile --compare <v>` and `rw history compare
/// --visual` draw the red/amber/green profile; units reach the JSON.
#[test]
fn compare_profile_and_history_compare_visual() {
    let p = TempProject::fixture("fixtures/simple");
    run(&p.0, &["set", "c.fins.span=60 mm"], 0);
    let o = run(
        &p.0,
        &[
            "render",
            "--view",
            "profile",
            "--compare",
            "step:1",
            "--json",
        ],
        0,
    );
    let r = json_out(&o);
    assert_eq!(r["path"], "renders/c6.profile.compare.png");
    let svg = std::fs::read_to_string(p.0.join("renders/c6.profile.compare.svg")).unwrap();
    assert!(svg.contains("Step 01 → Current"), "title");
    assert!(svg.contains(">Changed 1<"), "legend counts");
    assert!(svg.contains(">Removed 0<") && svg.contains(">Added 0<"));
    // The plain profile is untouched by the compare render.
    assert!(!p.0.join("renders/c6.profile.png").exists());
    // Compare draws the profile (2D) or a 3D view only.
    run(&p.0, &["render", "--view", "fin", "--compare", "step:1"], 2);
    run(
        &p.0,
        &["render", "--view", "profile", "--compare", "step:99"],
        1,
    );

    let o = run(
        &p.0,
        &[
            "history", "compare", "step:1", "step:2", "--visual", "--json",
        ],
        0,
    );
    let v = json_out(&o);
    assert_eq!(v["visual"]["path"], "renders/c6.profile.compare.png");
    assert_eq!(v["marks"][0]["id"], "fins");
    assert_eq!(v["marks"][0]["status"], "changed");
    let span = v["model"]["changed"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["path"] == "/c/fins/span")
        .unwrap();
    assert_eq!(span["unit"], "m");
    assert!((span["new_si"].as_f64().unwrap() - 0.06).abs() < 1e-12);
    let human = stdout(&run(&p.0, &["history", "compare", "step:1", "live"], 0));
    assert!(human.contains("~ fins (changed)"), "{human}");
    // Display units (mm) with the absolute change; `--units si` prints SI.
    assert!(
        human.contains("/shape/span: 50 mm -> 60 mm  (+10 mm)"),
        "{human}"
    );
    assert!(human.contains("stability.liftoff"), "{human}");
    // No breakdown unless asked for.
    assert!(!human.contains("breakdown"), "{human}");
    let v = json_out(&run(
        &p.0,
        &["history", "compare", "step:1", "live", "--json"],
        0,
    ));
    assert!(v.get("breakdown").is_none(), "{v}");
    // `--breakdown`: which component a change came from (B3 round 11, T4).
    let b = stdout(&run(
        &p.0,
        &["history", "compare", "step:1", "live", "--breakdown"],
        0,
    ));
    let line = |k: &str| {
        b.lines()
            .find(|l| l.trim_start().starts_with(&format!("{k} ")))
            .unwrap_or_else(|| panic!("no {k} row:\n{b}"))
            .to_string()
    };
    assert!(
        b.contains("\n  breakdown mass (per component: dry mass and CG)\n")
            && b.contains("\n  breakdown aero (per component: CNa and CP of its term)\n"),
        "{b}"
    );
    // Display units with the absolute and percent change.
    let fins = line("mass.components.fins.mass");
    assert!(fins.contains(" g -> ") && fins.contains(" g, +"), "{fins}");
    assert!(
        line("mass.components.nose.mass").ends_with("(+0 g, +0.0%)"),
        "{b}"
    );
    assert!(line("mass.components.fins.cg").contains(" mm -> "), "{b}");
    assert!(line("aero.terms.fins.cp").contains(" mm -> "), "{b}");
    assert!(line("aero.terms.fins.cna").contains("%)"), "{b}");
    let v = json_out(&run(
        &p.0,
        &[
            "history",
            "compare",
            "step:1",
            "live",
            "--breakdown",
            "--json",
        ],
        0,
    ));
    let rows = v["breakdown"].as_array().expect("breakdown rows");
    let fins = rows
        .iter()
        .find(|r| r["key"] == "mass.components.fins.mass")
        .unwrap();
    assert_eq!(fins["unit"], "kg");
    assert!(fins["delta"].as_f64().unwrap() > 0.0, "{fins}");
    assert!(fins["delta_pct"].as_f64().is_some(), "{fins}");
    let si = stdout(&run(
        &p.0,
        &["--units", "si", "history", "compare", "step:1", "live"],
        0,
    ));
    assert!(
        si.contains("/shape/span: 0.05 m -> 0.06 m  (+0.01 m)"),
        "{si}"
    );
}

/// B3 round 5: every edit runs its own strict check (`check --strict:`
/// section, exit 1 unless clean), text output is in display units with the
/// unit attached (`--units si` for SI), `--json` stays SI with a `units` map,
/// and `rw run summary` prints a run's fields and events.
#[test]
fn edits_check_strict_and_print_display_units() {
    let p = TempProject::fixture("fixtures/simple");
    // A clean edit: the strict section, display units, the absolute change.
    let h = stdout(&run(&p.0, &["set", "c.fins.span=40 mm"], 0));
    assert!(h.contains("\ncheck --strict: clean (static)"), "{h}");
    assert!(h.contains("delta: clean (lenient)"), "{h}");
    assert!(h.contains(" mm -> ") && h.contains(" g -> "), "{h}");
    assert!(h.contains("dims.fin_span: "), "{h}");
    let v = json_out(&run(&p.0, &["set", "c.fins.span=41 mm", "--json"], 0));
    assert_eq!(v["check_strict_status"], "clean");
    assert_eq!(v["check_strict"]["status"], "clean");
    assert_eq!(v["units"]["length"], "m");
    // A dry run writes nothing and runs no strict check.
    let h = stdout(&run(&p.0, &["set", "c.fins.span=42 mm", "--dry-run"], 0));
    assert!(!h.contains("check --strict"), "{h}");
    // An edit that leaves an error is written, prints the failing strict
    // section with the diagnostic, and exits 1.
    let h = stdout(&run(&p.0, &["set", "params.fin_span.value=1 mm"], 1));
    assert!(h.contains("recorded step:"), "{h}");
    assert!(h.contains("check --strict: errors"), "{h}");
    assert!(h.contains("RW-E011") && h.contains("at least 30 mm"), "{h}");
    run(&p.0, &["set", "params.fin_span.value=45 mm"], 0);

    // A warning fails the strict section too (the research vehicle's T/W).
    let rv = TempProject::fixture("fixtures/research-vehicle");
    let h = stdout(&run(&rv.0, &["set", "params.fin_span.value=101 mm"], 1));
    assert!(h.contains("check --strict: warnings"), "{h}");
    assert!(h.contains("RW-W102"), "{h}");

    // `rw check`: display units by default, SI with `--units si`.
    let h = stdout(&run(&p.0, &["check", "--strict"], 0));
    assert!(
        h.contains("length 523 mm (18.035 cal), diameter 29 mm, fineness 18.035"),
        "{h}"
    );
    let h = stdout(&run(&p.0, &["--units", "si", "check", "--strict"], 0));
    assert!(
        h.contains("length 0.523 m (18.035 cal), diameter 0.029 m"),
        "{h}"
    );
    let v = json_out(&run(&p.0, &["check", "--json"], 0));
    assert!((v["dims"]["length"].as_f64().unwrap() - 0.523).abs() < 1e-9);
    // Length in calibers and fineness: length / diameter, never by hand.
    for k in ["length_cal", "fineness"] {
        assert!(
            (v["dims"][k].as_f64().unwrap() - 0.523 / 0.029).abs() < 1e-3,
            "{k}"
        );
    }
    // `[display_units]` overrides the defaults.
    let manifest = std::fs::read_to_string(p.0.join("rocketwright.toml")).unwrap();
    let cm = if manifest.contains("[display_units]") {
        manifest
            .replace("[display_units]", "[display_units]\nlength = \"cm\"")
            .replacen("length = \"mm\"\n", "", 1)
    } else {
        format!("{manifest}\n[display_units]\nlength = \"cm\"\n")
    };
    std::fs::write(p.0.join("rocketwright.toml"), cm).unwrap();
    let h = stdout(&run(&p.0, &["check"], 0));
    assert!(h.contains("length 52.3 cm"), "{h}");
    std::fs::write(p.0.join("rocketwright.toml"), manifest).unwrap();

    // `rw sim` and `rw run summary` in display units.
    let h = stdout(&run(&p.0, &["sim", "b4"], 0));
    assert!(h.contains("apogee ") && h.contains(" m\n"), "{h}");
    let h = stdout(&run(&p.0, &["run", "summary", "b4"], 0));
    for f in [
        "apogee",
        "max_velocity",
        "time_to_apogee",
        "burnout_altitude",
        "drift",
    ] {
        assert!(h.contains(&format!("\n  {f} ")), "{f}: {h}");
    }
    assert!(h.contains("\nevents\n") && h.contains("  apogee "), "{h}");
    assert!(h.contains(" m/s"), "{h}");
    let h = stdout(&run(
        &p.0,
        &["run", "summary", "b4", "--fields", "apogee,time_to_apogee"],
        0,
    ));
    assert_eq!(h.lines().count(), 3, "{h}");
    let h = stdout(&run(&p.0, &["run", "summary", "--fields", "b4"], 0));
    assert!(h.contains("highest altitude above the pad"), "{h}");
    run(&p.0, &["run", "summary", "b4", "--fields", "bogus"], 2);
    run(&p.0, &["run", "summary", "nope"], 1);
    let v = json_out(&run(&p.0, &["run", "summary", "b4", "--json"], 0));
    assert!(v["summary"]["apogee_m"].as_f64().unwrap() > 10.0, "{v}");
    assert_eq!(v["units"]["altitude"], "m");
}

/// B3 round 10: what-if quick sims fly the overridden model (`--set`), and
/// `rw sim` after a real `rw set` flies the edited model under a new run id.
#[test]
fn quick_sim_and_sim_fly_the_overridden_model() {
    let d = TempProject::new();
    let proj = d.0.join("whatif");
    let o = Command::cargo_bin("rocketwright")
        .unwrap()
        .env("RW_CLOCK", CLOCK)
        .args(["init", "--template", "simple-rocket"])
        .arg(&proj)
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let quick = |set: Option<&str>| {
        let mut args = vec!["check", "--strict", "--sim", "quick", "--json"];
        if let Some(s) = set {
            args.extend(["--set", s]);
        }
        let v = json_out(&run(&proj, &args, 0));
        assert_eq!(v["tier"], "quick_sim", "{v}");
        v
    };
    let base = quick(None);
    let narrow = quick(Some("params.fin_span.value=30 mm"));
    let same = quick(Some("params.fin_span.value=45 mm"));
    let a = |v: &Value| v["sim"]["apogee_m"].as_f64().unwrap();
    assert_eq!(a(&base), a(&same), "45 mm is the template value");
    assert_ne!(a(&base), a(&narrow), "--set must reach the quick sim");
    assert_ne!(base["model_hash"], narrow["model_hash"]);
    // The `--set` spelling without `.value` is the same override.
    let short = quick(Some("params.fin_span=30 mm"));
    assert_eq!(a(&short), a(&narrow));
    assert_eq!(short["model_hash"], narrow["model_hash"]);

    let sim = |force: bool| {
        let mut args = vec!["sim", "baseline", "--json"];
        if force {
            args.push("--force");
        }
        json_out(&run(&proj, &args, 0))
    };
    let s1 = sim(false);
    assert_eq!(s1["status"], "complete", "{s1}");
    assert_eq!(s1["summary"]["apogee_m"], base["sim"]["apogee_m"]);
    run(&proj, &["set", "params.fin_span.value=30 mm"], 0);
    let s2 = sim(false);
    assert_eq!(s2["status"], "complete", "{s2}");
    assert_eq!(s2["cached"], false, "an edit invalidates the cached run");
    assert_ne!(s2["run_id"], s1["run_id"]);
    assert_eq!(s2["summary"]["apogee_m"], narrow["sim"]["apogee_m"]);
    // Back on the template value: the original run is a cache hit again.
    run(&proj, &["set", "params.fin_span.value=45 mm"], 0);
    let s3 = sim(false);
    assert_eq!(s3["run_id"], s1["run_id"]);
    assert_eq!(s3["cached"], true);
}

/// B3 round 8: a substituted motor (`RW-W103`) can be accepted with
/// `accept_substitution = true`, after which the strict check is clean; a
/// parachute that no configuration deploys is `RW-W250`, and its hint's `rw
/// set` creates the missing `[deploy.<id>]` table.
#[test]
fn accepted_substitution_and_deploy_event_clear_the_strict_check() {
    let t = TempProject::new();
    let src = t.0.join("bird.ork");
    std::fs::write(&src, include_str!("../../rw-ork/tests/data/simple.ork.xml")).unwrap();
    let dir = t.0.join("p");
    let o = run(
        &t.0,
        &[
            "import",
            "ork",
            src.to_str().unwrap(),
            dir.to_str().unwrap(),
        ],
        1,
    );
    let out = stdout(&o);
    assert!(
        out.contains("RW-W103 warning /configs/cfg-a/motors/motor_mount_tube/motor")
            && out.contains("accept_substitution=true"),
        "{out}"
    );
    let o = run(&dir, &["check", "--strict"], 1);
    assert!(stdout(&o).contains("RW-W103"), "{}", stdout(&o));
    let o = run(
        &dir,
        &[
            "set",
            "configs.cfg-a.motors.motor_mount_tube.accept_substitution=true",
        ],
        0,
    );
    assert!(
        stdout(&o).contains("check --strict: clean"),
        "{}",
        stdout(&o)
    );
    let toml = std::fs::read_to_string(dir.join("configs/cfg-a.rw.toml")).unwrap();
    assert!(toml.contains("accept_substitution = true"), "{toml}");
    run(&dir, &["check", "--strict"], 0);

    // Plug the motor and drop the deploy table: the chute never deploys.
    let cfg = toml
        .replace("delay = \"5 s\"\n", "")
        .replace("[deploy.chute]\nevent = \"ejection\"\n", "");
    std::fs::write(dir.join("configs/cfg-a.rw.toml"), &cfg).unwrap();
    let b = std::fs::read_to_string(dir.join("configs/cfg-b.rw.toml")).unwrap();
    assert!(b.contains("event = \"altitude\""), "{b}");
    std::fs::write(
        dir.join("configs/cfg-b.rw.toml"),
        b.replace("event = \"altitude\"", "event = \"never\""),
    )
    .unwrap();
    let o = run(&dir, &["check", "--strict"], 1);
    let out = stdout(&o);
    assert!(
        out.contains("RW-W250 warning /configs/cfg-a/deploy/chute/event")
            && out.contains("rw set configs.cfg-a.deploy.chute.event=apogee"),
        "{out}"
    );
    let o = run(&dir, &["set", "configs.cfg-a.deploy.chute.event=apogee"], 0);
    assert!(
        stdout(&o).contains("check --strict: clean"),
        "{}",
        stdout(&o)
    );
}

/// B3 round 13 polish: a field goes back to its default with `rw set <path>
/// --unset` or `rw rm <path>` (the normal strict-check output, no raw `rw
/// call`), and a run with an explicit `launch_into_wind = false` matches the
/// case-1 golden, which has no such key (absent = false).
#[test]
fn unset_and_rm_fields_and_into_wind_false_matches_the_golden() {
    let p = TempProject::fixture("fixtures/case1");
    let sim_file = p.0.join("sims/simulation_5.rw.toml");
    let text = || std::fs::read_to_string(&sim_file).unwrap();
    run(&p.0, &["set", "sims.simulation_5.launch_into_wind=true"], 0);
    assert!(text().contains("launch_into_wind = true"));
    let h = stdout(&run(
        &p.0,
        &["set", "sims.simulation_5.launch_into_wind", "--unset"],
        0,
    ));
    assert!(h.contains("recorded step:"), "{h}");
    assert!(h.contains("\ncheck --strict: clean"), "{h}");
    assert!(!text().contains("launch_into_wind"));
    run(&p.0, &["set", "sims.simulation_5.launch_into_wind=true"], 0);
    let h = stdout(&run(&p.0, &["rm", "sims.simulation_5.launch_into_wind"], 0));
    assert!(h.contains("\ncheck --strict: clean"), "{h}");
    assert!(!text().contains("launch_into_wind"));
    // --unset takes paths only.
    run(
        &p.0,
        &["set", "sims.simulation_5.launch_into_wind=false", "--unset"],
        2,
    );

    run(
        &p.0,
        &["set", "sims.simulation_5.launch_into_wind=false"],
        0,
    );
    assert!(text().contains("launch_into_wind = false"));
    let sim = json_out(&run(&p.0, &["sim", "simulation_5", "--json"], 0));
    let run_id = sim["run_id"].as_str().unwrap().to_string();
    let d = json_out(&run(
        &p.0,
        &[
            "diff",
            "run",
            &run_id,
            "--golden",
            "tests/oracle/case1-generic.json",
            "--json",
        ],
        0,
    ));
    assert!(
        d["mismatches"].as_array().unwrap().is_empty(),
        "false equals absent: {}",
        d["mismatches"]
    );
}

/// M5.4: `rw cfd import` on the synthetic fixture: a dry run writes nothing,
/// the import writes the `provenance = cfd` record, a re-import is a cache
/// hit, and a malformed file is a usage error naming the line.
#[test]
fn cfd_import_writes_a_cfd_run() {
    let p = TempProject::fixture("fixtures/simple");
    let h = stdout(&run(
        &p.0,
        &["cfd", "import", "fixtures/cfd", "--dry-run"],
        0,
    ));
    assert!(h.starts_with("dry run: nothing written"), "{h}");
    assert!(h.contains("steps: 3 (t = 0.0 s, 0.5 s, 1.0 s)"), "{h}");
    assert!(
        h.contains("scalar alpha: 0.0 .. 1.0 (dimensionless)"),
        "{h}"
    );
    assert!(!p.0.join("runs").join("cfd.tank").exists());
    let v = json_out(&run(&p.0, &["cfd", "import", "fixtures/cfd", "--json"], 0));
    assert_eq!(v["dataset"]["provenance"], "cfd");
    assert_eq!(v["dataset"]["point_count"], 3087);
    assert_eq!(v["dataset"]["files"].as_array().unwrap().len(), 3);
    let dir =
        p.0.join("runs/cfd.tank")
            .join(v["dataset"]["run_id"].as_str().unwrap());
    let rec: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("cfd.json")).unwrap()).unwrap();
    assert_eq!(rec["provenance"], "cfd");
    assert_eq!(rec["columns"][8], "alpha");
    assert_eq!(rec["units"]["p"], "Pa");
    let ds: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("dataset.json")).unwrap()).unwrap();
    assert_eq!(ds, v["dataset"]);
    let h = stdout(&run(&p.0, &["cfd", "import", "fixtures/cfd"], 0));
    assert!(h.starts_with("already imported:"), "{h}");
    let bad = p.0.join("bad_t0.csv");
    std::fs::write(&bad, "x,y,z,p\n0,0,0,1\n0,0\n").unwrap();
    let o = run(&p.0, &["cfd", "import", bad.to_str().unwrap()], 2);
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(err.contains("bad_t0.csv:3: 2 fields, expected 4"), "{err}");
}
