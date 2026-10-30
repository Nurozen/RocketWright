//! RL3: `cargo test -p rw-cli --test render3d`. `rw render --view
//! iso|top|side|front|rear` through `rocketwright-render`:
//!
//! - hermetic: stand-in renderers (shell scripts behind `RW_RENDER`) check
//!   the stdin `RenderRequest` (valid against `schema/render-request.json`),
//!   the session's `renders/` + manifest writes, and the reply checks
//!   (WebGL2 or a fallback adapter rejected with exit 2, I11);
//! - absent renderer → exit 2 with a hint;
//! - `RW_GPU_TESTS=1` (a logged-in GUI session, `make wasm`, and the web
//!   bundle built): the real `bin/rocketwright-render` renders a tube in < 5 s
//!   on WebGPU, and (M2.8, D14) every check view (`iso|side|top|front|rear`)
//!   matches the silhouette of the `rw export glb` mesh projected in Rust
//!   through the reported camera (mask IoU >= 0.95). The colour agreement test (export vs on-screen, ΔE ≤ 2) is
//!   `app/apps/desktop/src/render3d.gpu.test.ts` (`make test-gpu`).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use assert_cmd::Command;
use base64::Engine;
use common::*;
use serde_json::{Value, json};

/// A 1x1 RGBA PNG.
const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

fn rw(project: &Path) -> Command {
    let mut c = Command::cargo_bin("rocketwright").unwrap();
    c.env_remove("RW_RENDER")
        .env_remove("RW_RENDER_ALLOW_SOFTWARE")
        .env_remove("RW_TEST_HOOKS")
        .arg("--project")
        .arg(project);
    c
}

/// The `--json` output: the result on stdout, or the error on stderr.
fn out_json(o: &std::process::Output) -> Value {
    let text = if o.stdout.is_empty() {
        &o.stderr
    } else {
        &o.stdout
    };
    serde_json::from_slice(text).unwrap_or_else(|e| {
        panic!(
            "not JSON ({e}): {} / {}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        )
    })
}

fn reply(backend: &str, fallback: bool, png: &str) -> Value {
    json!({
        "status": "ready",
        "backend": backend,
        "adapter": {"vendor": "apple", "architecture": "metal-3", "description": "", "is_fallback_adapter": fallback},
        "png_base64": png,
        "width": 1,
        "height": 1,
        "camera": {"position": [1.0, -1.0, 0.5], "target": [0.3, 0.0, 0.0], "up": [0.0, 0.0, 1.0], "orthographic": true, "ortho_height": 0.4},
        "timings_ms": {"total": 12}
    })
}

/// A stand-in renderer: saves stdin and its args beside itself, logs a line,
/// prints `stdout`, exits `code`.
fn fake_renderer(dir: &Path, stdout: &str, code: i32) -> PathBuf {
    let p = dir.join("rocketwright-render");
    let body = format!(
        "#!/bin/sh\ncat > \"$(dirname \"$0\")/request.json\"\necho \"$@\" > \"$(dirname \"$0\")/args.txt\"\necho 'renderer log line'\ncat <<'RW_EOF'\n{stdout}\nRW_EOF\nexit {code}\n"
    );
    std::fs::write(&p, body).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

fn render_schema() -> Value {
    let p = repo_root().join("schema/render-request.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn renders_through_the_renderer_and_records_the_manifest() {
    let proj = TempProject::fixture("fixtures/simple");
    let bin = TempProject::new();
    let r = fake_renderer(&bin.0, &reply("webgpu", false, PNG_1X1).to_string(), 0);
    let o = rw(&proj.0)
        .env("RW_RENDER", &r)
        .args(["render", "--view", "iso", "--imgsize", "1x1", "--json"])
        .output()
        .unwrap();
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stdout)
    );
    let v = out_json(&o);
    assert_eq!(v["path"], "renders/c6.iso.png");
    assert_eq!(v["backend"], "webgpu");
    assert_eq!(v["adapter"], "apple metal-3");
    assert_eq!(v["camera"]["orthographic"], true);
    assert!(v.get("svg_path").is_none());

    // The stdin request is a valid IF8 RenderRequest for this model.
    let req: Value =
        serde_json::from_str(&std::fs::read_to_string(bin.0.join("request.json")).unwrap())
            .unwrap();
    let schema = render_schema();
    let validator = jsonschema::validator_for(&schema).unwrap();
    let errors: Vec<String> = validator.iter_errors(&req).map(|e| e.to_string()).collect();
    assert!(errors.is_empty(), "request invalid: {errors:?}");
    assert_eq!(req["view"], "iso");
    assert_eq!(req["scheme"], "check");
    assert_eq!(
        (req["width"].as_u64(), req["height"].as_u64()),
        (Some(1), Some(1))
    );
    assert_eq!(req["out_path"], "renders/c6.iso.png");
    assert_eq!(req["evaluated"]["model_hash"], v["model_hash"]);
    assert!(req["check"]["diagnostics"].is_array());
    assert_eq!(
        std::fs::read_to_string(bin.0.join("args.txt"))
            .unwrap()
            .trim(),
        ""
    );

    // The session wrote the PNG and the manifest entry.
    let png = std::fs::read(proj.0.join("renders/c6.iso.png")).unwrap();
    assert_eq!(
        png,
        base64::engine::general_purpose::STANDARD
            .decode(PNG_1X1)
            .unwrap()
    );
    assert_eq!(
        v["png_sha256"].as_str().unwrap(),
        rw_project::layout::sha256_hex(&png)
    );
    let m: Value = serde_json::from_str(
        &std::fs::read_to_string(proj.0.join("renders/manifest.json")).unwrap(),
    )
    .unwrap();
    let e = &m["renders"]["renders/c6.iso.png"];
    assert_eq!(e["view"], "iso");
    assert_eq!(e["png_sha256"], v["png_sha256"]);
    assert_eq!(
        (e["width"].as_u64(), e["height"].as_u64()),
        (Some(1), Some(1))
    );

    // --explode and --scheme reach the request.
    rw(&proj.0)
        .env("RW_RENDER", &r)
        .args([
            "render",
            "--view",
            "rear",
            "--imgsize",
            "1x1",
            "--explode",
            "0.5",
            "--scheme",
            "pbr",
        ])
        .assert()
        .code(0);
    let req: Value =
        serde_json::from_str(&std::fs::read_to_string(bin.0.join("request.json")).unwrap())
            .unwrap();
    assert_eq!(req["view"], "rear");
    assert_eq!(req["scheme"], "pbr");
    assert_eq!(req["explode"], 0.5);
    assert_eq!(req["internals"], true);
}

/// M3.5: `--view exploded|section` reach the renderer as their own views:
/// exploded defaults to a full explode, section shows the internals, both
/// land at `renders/<config>.<view>.png`, and `--explode` still wins.
#[test]
fn exploded_and_section_views_reach_the_renderer() {
    let proj = TempProject::fixture("fixtures/simple");
    let bin = TempProject::new();
    let r = fake_renderer(&bin.0, &reply("webgpu", false, PNG_1X1).to_string(), 0);
    let validator = jsonschema::validator_for(&render_schema()).unwrap();
    for (view, extra, explode, internals) in [
        ("exploded", None, 1.0, true),
        ("exploded", Some("0.4"), 0.4, true),
        ("section", None, 0.0, true),
        ("section", Some("0.5"), 0.5, true),
    ] {
        let mut c = rw(&proj.0);
        c.env("RW_RENDER", &r)
            .args(["render", "--view", view, "--imgsize", "1x1", "--json"]);
        if let Some(e) = extra {
            c.args(["--explode", e]);
        }
        let o = c.output().unwrap();
        assert_eq!(
            o.status.code(),
            Some(0),
            "{view}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        let v = out_json(&o);
        assert_eq!(v["path"], format!("renders/c6.{view}.png"));
        assert_eq!(v["view"], view);
        let req: Value =
            serde_json::from_str(&std::fs::read_to_string(bin.0.join("request.json")).unwrap())
                .unwrap();
        let errors: Vec<String> = validator.iter_errors(&req).map(|e| e.to_string()).collect();
        assert!(errors.is_empty(), "{view}: request invalid: {errors:?}");
        assert_eq!(req["view"], view);
        assert_eq!(req["explode"].as_f64(), Some(explode), "{view} {extra:?}");
        assert_eq!(req["internals"], internals, "{view} {extra:?}");
        assert!(proj.0.join(format!("renders/c6.{view}.png")).exists());
    }
}

#[test]
fn webgl_and_fallback_adapters_are_rejected() {
    let proj = TempProject::fixture("fixtures/simple");
    for (rep, what) in [
        (reply("webgl2", false, PNG_1X1), "WebGL2"),
        (reply("webgpu", true, PNG_1X1), "fallback adapter"),
    ] {
        let bin = TempProject::new();
        let r = fake_renderer(&bin.0, &rep.to_string(), 0);
        let o = rw(&proj.0)
            .env("RW_RENDER", &r)
            .args(["render", "--view", "side", "--imgsize", "1x1", "--json"])
            .output()
            .unwrap();
        assert_eq!(o.status.code(), Some(2));
        let v = out_json(&o);
        assert_eq!(v["error"]["code"], "io");
        assert!(
            v["error"]["message"].as_str().unwrap().contains(what),
            "{v}"
        );
        assert!(!proj.0.join("renders/c6.side.png").exists());
        // The explicit software override passes it through.
        rw(&proj.0)
            .env("RW_RENDER", &r)
            .env("RW_RENDER_ALLOW_SOFTWARE", "1")
            .args(["render", "--view", "side", "--imgsize", "1x1"])
            .assert()
            .code(0);
        assert!(
            std::fs::read_to_string(bin.0.join("args.txt"))
                .unwrap()
                .contains("--allow-software")
        );
        std::fs::remove_file(proj.0.join("renders/c6.side.png")).unwrap();
    }
}

#[test]
fn renderer_failures_are_io_errors() {
    let proj = TempProject::fixture("fixtures/simple");
    let cases: [(String, i32, &str); 3] = [
        (String::new(), 1, "without a reply"),
        (
            json!({"status": "error", "error": "no adapter"}).to_string(),
            1,
            "no adapter",
        ),
        (
            reply("webgpu", false, PNG_1X1).to_string(),
            0,
            "1x1 PNG for a 2x2 request",
        ),
    ];
    for (stdout, code, what) in cases {
        let bin = TempProject::new();
        let r = fake_renderer(&bin.0, &stdout, code);
        let o = rw(&proj.0)
            .env("RW_RENDER", &r)
            .args(["render", "--view", "top", "--imgsize", "2x2", "--json"])
            .output()
            .unwrap();
        let v = out_json(&o);
        assert_ne!(o.status.code(), Some(0), "{v}");
        assert!(
            v["error"]["message"].as_str().unwrap().contains(what),
            "{v}"
        );
    }
}

#[test]
fn absent_renderer_is_exit_2_with_a_hint() {
    let proj = TempProject::fixture("fixtures/simple");
    // RW_RENDER naming a missing file.
    let o = rw(&proj.0)
        .env("RW_RENDER", "/nonexistent/rocketwright-render")
        .args(["render", "--view", "iso", "--json"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    let v = out_json(&o);
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("RW_RENDER=/nonexistent/rocketwright-render")
    );
    assert!(v["error"]["hint"].as_str().unwrap().contains("RW_RENDER"));

    // No RW_RENDER and nothing beside a copy of the binary (HOME without ~/Applications).
    let dir = TempProject::new();
    let exe = dir.0.join("rocketwright");
    let src = assert_cmd::cargo::cargo_bin("rocketwright");
    // A real copy, not a hard link: a hard link shares the inode of
    // target/debug/rocketwright, so an OS kill of this exec (below) also
    // SIGKILLs the parallel tests running the cargo binary (GATE-flake).
    std::fs::copy(&src, &exe).unwrap();
    // macOS occasionally SIGKILLs the first exec of a freshly linked binary
    // from a new path under load (GATE-flake: seen ~1 in 20 runs, never
    // reproducible in isolation); retry that case only, so a real crash still fails.
    let run_copy = || {
        std::process::Command::new(&exe)
            .env_remove("RW_RENDER")
            .env("HOME", &dir.0)
            .args(["--project"])
            .arg(&proj.0)
            .args(["render", "--view", "front"])
            .output()
            .unwrap()
    };
    let mut o = run_copy();
    for _ in 0..2 {
        use std::os::unix::process::ExitStatusExt;
        if o.status.signal() != Some(9) {
            break;
        }
        eprintln!("copied binary SIGKILLed by the OS; retrying");
        std::thread::sleep(Duration::from_millis(200));
        o = run_copy();
    }
    let err = String::from_utf8_lossy(&o.stderr);
    assert_eq!(o.status.code(), Some(2), "{:?}: {err}", o.status);
    assert!(err.contains("rocketwright-render"), "{err}");
    assert!(
        err.contains(&dir.0.join("rocketwright-render").display().to_string()),
        "{err}"
    );

    // M3.5: exploded and section are renderer views too (they need it like iso).
    for view in ["exploded", "section"] {
        rw(&proj.0)
            .env("RW_RENDER", "/nonexistent/rocketwright-render")
            .args(["render", "--view", view])
            .assert()
            .code(2);
    }
}

/// `RW_GPU_TESTS=1`: the real renderer, in a GUI session with a GPU.
#[test]
fn real_renderer_draws_a_tube_in_under_5_s() {
    if std::env::var("RW_GPU_TESTS").ok().as_deref() != Some("1") {
        eprintln!("skipped: set RW_GPU_TESTS=1 (GUI session, make wasm, web bundle built)");
        return;
    }
    let proj = TempProject::new();
    std::fs::write(
        proj.0.join("rocketwright.toml"),
        "format = 1\nname = \"Tube\"\n",
    )
    .unwrap();
    std::fs::write(
        proj.0.join("rocket.rw.toml"),
        "name = \"Tube\"\n[c.nose]\ntype = \"nose_cone\"\nshape = \"ogive\"\nlength = \"160 mm\"\nod = \"54 mm\"\n[c.body]\ntype = \"body_tube\"\nattach = { to = \"nose.base\" }\nlength = \"600 mm\"\nod = \"54 mm\"\nid = \"50 mm\"\n",
    )
    .unwrap();
    let renderer = repo_root().join("bin/rocketwright-render");
    let t = Instant::now();
    let o = rw(&proj.0)
        .env("RW_RENDER", &renderer)
        .args(["render", "--view", "iso", "--json"])
        .output()
        .unwrap();
    let took = t.elapsed();
    assert_eq!(
        o.status.code(),
        Some(0),
        "{} / {}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
    assert!(took < Duration::from_secs(5), "took {took:?}");
    let v = out_json(&o);
    assert_eq!(v["backend"], "webgpu");
    let png = std::fs::read(proj.0.join(v["path"].as_str().unwrap())).unwrap();
    assert_eq!(rw_cli::render3d::png_size(&png), Some((1536, 1024)));
}

/// M2.7: `--compare <version>` sends the other model and the marks.
#[test]
fn compare_reaches_the_request() {
    let proj = TempProject::fixture("fixtures/simple");
    let bin = TempProject::new();
    let r = fake_renderer(&bin.0, &reply("webgpu", false, PNG_1X1).to_string(), 0);
    rw(&proj.0)
        .args(["set", "c.fins.span=60 mm"])
        .assert()
        .code(0);
    let o = rw(&proj.0)
        .env("RW_RENDER", &r)
        .args([
            "render",
            "--view",
            "iso",
            "--imgsize",
            "1x1",
            "--compare",
            "step:1",
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stdout)
    );
    assert_eq!(out_json(&o)["path"], "renders/c6.iso.compare.png");
    let req: Value =
        serde_json::from_str(&std::fs::read_to_string(bin.0.join("request.json")).unwrap())
            .unwrap();
    let validator = jsonschema::validator_for(&render_schema()).unwrap();
    let errors: Vec<String> = validator.iter_errors(&req).map(|e| e.to_string()).collect();
    assert!(errors.is_empty(), "request invalid: {errors:?}");
    assert_ne!(
        req["compare_evaluated"]["model_hash"],
        req["evaluated"]["model_hash"]
    );
    assert_eq!(req["compare_marks"][0]["id"], "fins");
    assert_eq!(req["compare_marks"][0]["status"], "changed");
    assert_eq!(req["out_path"], "renders/c6.iso.compare.png");
    // Without a renderer: exit 2 with the hint, as for any 3D view.
    rw(&proj.0)
        .env("RW_RENDER", "/nonexistent/rocketwright-render")
        .args(["render", "--view", "iso", "--compare", "step:1"])
        .assert()
        .code(2);
}

// ---- M2.8: mask IoU against the Rust-projected silhouette (D14) -------------

/// Root node types drawn when `internals` is off (rw-geom `is_axial` + `is_surface`).
const EXTERNAL_TYPES: [&str; 9] = [
    "nose_cone",
    "body_tube",
    "transition",
    "trapezoidal_fin_set",
    "elliptical_fin_set",
    "freeform_fin_set",
    "tube_fin_set",
    "launch_lug",
    "rail_button",
];

type V3 = [f64; 3];
/// Node transforms from the root down: (translation, rotation quaternion).
type Chain = Vec<(V3, [f64; 4])>;

fn sub3(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot3(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross3(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn unit3(a: V3) -> V3 {
    let l = dot3(a, a).sqrt();
    [a[0] / l, a[1] / l, a[2] / l]
}

/// Rotates `v` by the unit quaternion `q = [x, y, z, w]`.
fn quat_rotate(q: [f64; 4], v: V3) -> V3 {
    let u = [q[0], q[1], q[2]];
    let t = cross3(u, v).map(|c| 2.0 * c);
    let ut = cross3(u, t);
    [
        v[0] + q[3] * t[0] + ut[0],
        v[1] + q[3] * t[1] + ut[1],
        v[2] + q[3] * t[2] + ut[2],
    ]
}

/// The body-frame triangles of the external parts of a GLB from `rw export
/// glb` (the same writer the renderer's `meshModelGlb` uses). Node transforms
/// are translation + rotation (the writer emits no scale).
fn glb_triangles(glb: &[u8]) -> Vec<[V3; 3]> {
    let u32_at = |o: usize| u32::from_le_bytes(glb[o..o + 4].try_into().unwrap()) as usize;
    assert_eq!(&glb[..4], b"glTF");
    let json_len = u32_at(12);
    let doc: Value = serde_json::from_slice(&glb[20..20 + json_len]).unwrap();
    let bin = &glb[20 + json_len + 8..];
    let accessor = |i: usize| -> (usize, usize, &Value) {
        let a = &doc["accessors"][i];
        let v = &doc["bufferViews"][a["bufferView"].as_u64().unwrap() as usize];
        let off = v["byteOffset"].as_u64().unwrap_or(0) as usize
            + a["byteOffset"].as_u64().unwrap_or(0) as usize;
        (off, a["count"].as_u64().unwrap() as usize, a)
    };
    let f32_at = |o: usize| f32::from_le_bytes(bin[o..o + 4].try_into().unwrap()) as f64;
    let idx_at = |o: usize| u32::from_le_bytes(bin[o..o + 4].try_into().unwrap()) as usize;
    let mut tris = Vec::new();
    // (node, parent transforms applied innermost first)
    fn walk(doc: &Value, node: usize, chain: &mut Chain, out: &mut Vec<(usize, Chain)>) {
        let n = &doc["nodes"][node];
        let get = |k: &str, d: &[f64]| -> Vec<f64> {
            n[k].as_array()
                .map(|a| a.iter().map(|x| x.as_f64().unwrap()).collect())
                .unwrap_or_else(|| d.to_vec())
        };
        let t = get("translation", &[0.0; 3]);
        let r = get("rotation", &[0.0, 0.0, 0.0, 1.0]);
        chain.push(([t[0], t[1], t[2]], [r[0], r[1], r[2], r[3]]));
        if let Some(m) = n["mesh"].as_u64() {
            out.push((m as usize, chain.clone()));
        }
        for c in n["children"].as_array().into_iter().flatten() {
            walk(doc, c.as_u64().unwrap() as usize, chain, out);
        }
        chain.pop();
    }
    let mut placed = Vec::new();
    for root in doc["scenes"][0]["nodes"].as_array().unwrap() {
        let r = root.as_u64().unwrap() as usize;
        let ty = doc["nodes"][r]["extras"]["rw_type"].as_str().unwrap_or("");
        if EXTERNAL_TYPES.contains(&ty) {
            walk(&doc, r, &mut Vec::new(), &mut placed);
        }
    }
    for (mesh, chain) in placed {
        for prim in doc["meshes"][mesh]["primitives"].as_array().unwrap() {
            let (po, pn, _) = accessor(prim["attributes"]["POSITION"].as_u64().unwrap() as usize);
            let pos: Vec<V3> = (0..pn)
                .map(|k| {
                    let mut p = [
                        f32_at(po + 12 * k),
                        f32_at(po + 12 * k + 4),
                        f32_at(po + 12 * k + 8),
                    ];
                    for (t, q) in chain.iter().rev() {
                        let r = quat_rotate(*q, p);
                        p = [r[0] + t[0], r[1] + t[1], r[2] + t[2]];
                    }
                    p
                })
                .collect();
            let (io, icount, a) = accessor(prim["indices"].as_u64().unwrap() as usize);
            assert_eq!(a["componentType"], 5125, "u32 indices");
            for k in 0..icount / 3 {
                tris.push([0, 1, 2].map(|j| pos[idx_at(io + 4 * (3 * k + j))]));
            }
        }
    }
    tris
}

/// The silhouette of `tris` seen through the reported body-frame camera
/// (orthographic, three.js conventions: right = up × back), sampled at pixel
/// centres of a `w`×`h` image.
fn silhouette(tris: &[[V3; 3]], cam: &Value, w: usize, h: usize) -> Vec<bool> {
    let v3 = |k: &str| -> V3 {
        let a = cam[k].as_array().unwrap();
        [0, 1, 2].map(|i| a[i].as_f64().unwrap())
    };
    assert_eq!(cam["orthographic"], true, "check renders are orthographic");
    let (pos, target) = (v3("position"), v3("target"));
    let back = unit3(sub3(pos, target));
    let up = unit3(v3("up"));
    let right = unit3(cross3(up, back));
    let oh = cam["ortho_height"].as_f64().unwrap();
    let ow = oh * w as f64 / h as f64;
    let to_px = |p: V3| -> [f64; 2] {
        let d = sub3(p, target);
        [
            (dot3(d, right) / ow + 0.5) * w as f64,
            (0.5 - dot3(d, up) / oh) * h as f64,
        ]
    };
    let mut mask = vec![false; w * h];
    for t in tris {
        let [a, b, c] = t.map(to_px);
        let area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if area.abs() < 1e-12 {
            continue;
        }
        let x0 = a[0].min(b[0]).min(c[0]).floor().max(0.0) as usize;
        let x1 = (a[0].max(b[0]).max(c[0]).ceil() as usize).min(w);
        let y0 = a[1].min(b[1]).min(c[1]).floor().max(0.0) as usize;
        let y1 = (a[1].max(b[1]).max(c[1]).ceil() as usize).min(h);
        for y in y0..y1 {
            let py = y as f64 + 0.5;
            for x in x0..x1 {
                let px = x as f64 + 0.5;
                let e = |p: [f64; 2], q: [f64; 2]| {
                    (q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0])
                };
                let (e0, e1, e2) = (e(a, b), e(b, c), e(c, a));
                if (e0 >= 0.0 && e1 >= 0.0 && e2 >= 0.0) || (e0 <= 0.0 && e1 <= 0.0 && e2 <= 0.0) {
                    mask[y * w + x] = true;
                }
            }
        }
    }
    mask
}

/// The model pixels of a check render: those away from the clear colour
/// (sampled at the top-left corner) by more than `tol` in any channel.
fn png_mask(png: &[u8], tol: u8) -> (Vec<bool>, usize, usize) {
    let pm = resvg::tiny_skia::Pixmap::decode_png(png).unwrap();
    let (w, h) = (pm.width() as usize, pm.height() as usize);
    let px = pm.data();
    let bg = [px[0], px[1], px[2]];
    let mask = (0..w * h)
        .map(|i| (0..3).any(|c| px[4 * i + c].abs_diff(bg[c]) > tol))
        .collect();
    (mask, w, h)
}

fn iou(a: &[bool], b: &[bool]) -> f64 {
    let inter = a.iter().zip(b).filter(|(x, y)| **x && **y).count();
    let union = a.iter().zip(b).filter(|(x, y)| **x || **y).count();
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}

#[test]
fn silhouette_helpers_agree_on_a_square() {
    // Two triangles covering x in [-0.5, 0.5] m, z in [-0.25, 0.25] m, seen from -Y.
    let sq = [
        [[-0.5, 0.0, -0.25], [0.5, 0.0, -0.25], [0.5, 0.0, 0.25]],
        [[-0.5, 0.0, -0.25], [0.5, 0.0, 0.25], [-0.5, 0.0, 0.25]],
    ];
    let cam = json!({"position": [0.0, -2.0, 0.0], "target": [0.0, 0.0, 0.0], "up": [0.0, 0.0, 1.0], "orthographic": true, "ortho_height": 1.0});
    let m = silhouette(&sq, &cam, 40, 20);
    // ortho width 2 m over 40 px: the square spans 20x10 px, centred.
    assert_eq!(m.iter().filter(|v| **v).count(), 200);
    assert!(m[10 * 40 + 20] && !m[0] && !m[10 * 40 + 9] && m[10 * 40 + 10]);
    // +X is image right from -Y with +Z up.
    let half = [[[0.0, 0.0, -0.25], [0.5, 0.0, -0.25], [0.5, 0.0, 0.25]]];
    let hm = silhouette(&half, &cam, 40, 20);
    assert!(hm[14 * 40 + 29] && !hm[14 * 40 + 11]);
    assert!((iou(&m, &m) - 1.0).abs() < 1e-12);
    assert!(iou(&m, &hm) > 0.2 && iou(&m, &hm) < 0.3);
}

/// `RW_GPU_TESTS=1`: every check view's model pixels match the silhouette of
/// the exported mesh through the reported camera (IoU >= 0.95; anti-aliased
/// edges cost a few per cent on the slim views), and a mirrored camera
/// does not (the test discriminates).
#[test]
fn check_views_match_the_rust_silhouette() {
    if std::env::var("RW_GPU_TESTS").ok().as_deref() != Some("1") {
        eprintln!("skipped: set RW_GPU_TESTS=1 (GUI session, make wasm, web bundle built)");
        return;
    }
    let proj = TempProject::fixture("fixtures/simple");
    let glb_path = proj.0.join("model.glb");
    rw(&proj.0)
        .args(["export", "glb"])
        .arg(&glb_path)
        .assert()
        .code(0);
    let tris = glb_triangles(&std::fs::read(&glb_path).unwrap());
    assert!(tris.len() > 100, "{} triangles", tris.len());
    let renderer = repo_root().join("bin/rocketwright-render");
    let mut report = Vec::new();
    for view in ["iso", "side", "top", "front", "rear"] {
        let o = rw(&proj.0)
            .env("RW_RENDER", &renderer)
            .args(["render", "--view", view, "--imgsize", "600x400", "--json"])
            .output()
            .unwrap();
        assert_eq!(
            o.status.code(),
            Some(0),
            "{view}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        let v = out_json(&o);
        assert_eq!(v["backend"], "webgpu", "{view}");
        assert_eq!(v["png_sha256"].as_str().unwrap().len(), 64);
        let png = std::fs::read(proj.0.join(v["path"].as_str().unwrap())).unwrap();
        let (got, w, h) = png_mask(&png, 24);
        assert_eq!((w, h), (600, 400));
        let want = silhouette(&tris, &v["camera"], w, h);
        let score = iou(&got, &want);
        // A camera mirrored through the target (looking from the other side,
        // same up) flips the image left-right.
        let mut flipped = v["camera"].clone();
        let p: Vec<f64> = (0..3)
            .map(|i| v["camera"]["position"][i].as_f64().unwrap())
            .collect();
        let t: Vec<f64> = (0..3)
            .map(|i| v["camera"]["target"][i].as_f64().unwrap())
            .collect();
        flipped["position"] = json!([2.0 * t[0] - p[0], 2.0 * t[1] - p[1], 2.0 * t[2] - p[2]]);
        let wrong = iou(&got, &silhouette(&tris, &flipped, w, h));
        report.push(format!("{view}: IoU {score:.3} (mirrored {wrong:.3})"));
        assert!(score >= 0.95, "{view}: IoU {score:.3} < 0.95 ({report:?})");
        assert!(
            wrong < score - 0.2,
            "{view}: mirrored camera scores {wrong:.3} vs {score:.3}"
        );
    }
    eprintln!("{}", report.join("\n"));
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(proj.0.join("renders/manifest.json")).unwrap(),
    )
    .unwrap();
    for view in ["iso", "side", "top", "front", "rear"] {
        let e = &manifest["renders"][format!("renders/c6.{view}.png")];
        assert_eq!(e["view"], view, "{manifest}");
        assert_eq!(e["width"], 600);
    }
}
