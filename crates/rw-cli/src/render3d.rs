//! The 3D views (`rw render --view iso|top|side|front|rear`, RL3): the
//! session builds a [`RenderRequest`] (IF8), [`locate`] finds
//! `rocketwright-render`, which gets the request as JSON on stdin, renders it
//! in a hidden Electron window with the shared web bundle (`?mode=render`),
//! and prints one [`RendererReply`] JSON line on stdout. The PNG in the reply
//! is the final tone-mapped sRGB canvas output, never a linear render-target
//! readback. The session writes it to `renders/<config>.<view>.png` and
//! indexes it in `renders/manifest.json` (the renderer writes nothing, I1).
//!
//! The renderer is found at, in order:
//! 1. `$RW_RENDER` (when set, the only candidate);
//! 2. beside the binary (`<bin>/rocketwright-render`; `bin/rocketwright-render`
//!    in a checkout, `dist/kit/bin/` in the kit);
//! 3. the app bundle: `<bin>/../Resources/bin/rocketwright-render` (the
//!    binary inside `RocketWright.app/Contents/MacOS`), then
//!    `/Applications/RocketWright.app` and `~/Applications/RocketWright.app`.
//!
//! When none exists the render fails with an I/O error (exit 2) and a hint.
//! A render on WebGL2 or a fallback (software) adapter is rejected (I11)
//! unless `RW_RENDER_ALLOW_SOFTWARE=1`.

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine;
use rw_api::{
    ApiError, ApiErrorCode, Camera, RenderBackend, RenderIn, RenderRequest, RenderResult,
    RenderScheme, View,
};
use rw_project::Session;
use serde::{Deserialize, Serialize};

use crate::render::{MAX_EDGE, ManifestEntry, RENDERS_DIR, err, sha256_hex, view_name};

/// File name of the renderer.
pub const RENDERER: &str = "rocketwright-render";
/// Overrides the renderer location.
pub const ENV_RENDER: &str = "RW_RENDER";
/// `1` accepts WebGL2 or a fallback adapter (never in gates, I11).
pub const ENV_ALLOW_SOFTWARE: &str = "RW_RENDER_ALLOW_SOFTWARE";
/// Renderer timeout in milliseconds (default [`DEFAULT_TIMEOUT`]).
pub const ENV_TIMEOUT: &str = "RW_RENDER_TIMEOUT_MS";
/// App bundle name.
pub const APP_BUNDLE: &str = "RocketWright.app";
/// Default image size (the bar capture size).
pub const DEFAULT_SIZE: (u32, u32) = (1536, 1024);
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// Hint printed when no renderer is found.
pub const MISSING_HINT: &str = "install the RocketWright app, put rocketwright-render beside the \
rocketwright binary, or set RW_RENDER=<path> (in a checkout: RW_RENDER=bin/rocketwright-render \
after `make wasm` and `pnpm --dir app --filter @rw/web build`); the 2D views (profile, fin, \
stations, anchors) need no renderer";

/// The views `rocketwright-render` draws today.
pub fn is_3d_view(v: View) -> bool {
    matches!(
        v,
        View::Iso
            | View::Top
            | View::Side
            | View::Front
            | View::Rear
            | View::Exploded
            | View::Section
    )
}

/// The explode factor when `--explode` is absent: fully exploded for
/// `--view exploded` (M3.5), assembled otherwise. `--view section` cuts the
/// model at the body x-z plane with real cut geometry in the renderer.
pub fn default_explode(v: View) -> f64 {
    if v == View::Exploded { 1.0 } else { 0.0 }
}

/// Renderer candidates, in search order. `env` is `$RW_RENDER`, `exe` the
/// running binary, `home` the user's home directory.
pub fn candidates(env: Option<&OsStr>, exe: Option<&Path>, home: Option<&Path>) -> Vec<PathBuf> {
    if let Some(e) = env.filter(|e| !e.is_empty()) {
        return vec![PathBuf::from(e)];
    }
    let mut out = Vec::new();
    if let Some(dir) = exe.and_then(Path::parent) {
        out.push(dir.join(RENDERER));
        out.push(dir.join("../Resources/bin").join(RENDERER));
    }
    let in_bundle = |apps: PathBuf| {
        apps.join(APP_BUNDLE)
            .join("Contents/Resources/bin")
            .join(RENDERER)
    };
    out.push(in_bundle(PathBuf::from("/Applications")));
    if let Some(h) = home {
        out.push(in_bundle(h.join("Applications")));
    }
    out
}

/// The first candidate `is_file` accepts, else an I/O error (exit 2) with a hint.
pub fn locate_with(
    env: Option<&OsStr>,
    exe: Option<&Path>,
    home: Option<&Path>,
    is_file: impl Fn(&Path) -> bool,
) -> Result<PathBuf, ApiError> {
    let list = candidates(env, exe, home);
    if let Some(p) = list.iter().find(|p| is_file(p)) {
        return Ok(p.clone());
    }
    let message = match env.filter(|e| !e.is_empty()) {
        Some(e) => format!(
            "{ENV_RENDER}={} does not name a file, so the 3D views cannot render",
            Path::new(e).display()
        ),
        None => format!(
            "the 3D views need {RENDERER}, which was not found beside the binary or in the app (looked in {})",
            list.iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    };
    Err(err(ApiErrorCode::Io, message, Some(MISSING_HINT)))
}

/// [`locate_with`] over the process environment.
pub fn locate() -> Result<PathBuf, ApiError> {
    let env = std::env::var_os(ENV_RENDER);
    let exe = std::env::current_exe().ok();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    locate_with(env.as_deref(), exe.as_deref(), home.as_deref(), |p| {
        p.is_file()
    })
}

/// GPU adapter facts the renderer reports (WebGPU `GPUAdapterInfo`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AdapterInfo {
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub architecture: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub is_fallback_adapter: Option<bool>,
}

impl AdapterInfo {
    /// `vendor architecture`, else the description, else `unknown`.
    pub fn label(&self) -> String {
        let l = [self.vendor.as_str(), self.architecture.as_str()]
            .iter()
            .filter(|s| !s.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" ");
        if !l.is_empty() {
            l
        } else if !self.description.is_empty() {
            self.description.clone()
        } else {
            "unknown".into()
        }
    }

    /// A software adapter: flagged as fallback, or SwiftShader.
    pub fn is_software(&self) -> bool {
        self.is_fallback_adapter == Some(true)
            || [&self.vendor, &self.architecture, &self.description]
                .iter()
                .any(|s| s.to_ascii_lowercase().contains("swiftshader"))
    }
}

/// The one JSON line `rocketwright-render` prints on stdout.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RendererReply {
    /// `ready` or `error`.
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    /// `webgpu`, `webgl2`, or `none`.
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub adapter: Option<AdapterInfo>,
    /// The tone-mapped sRGB canvas output.
    #[serde(default)]
    pub png_base64: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub camera: Option<Camera>,
}

/// A reply that passed [`verify_reply`].
#[derive(Debug, Clone, PartialEq)]
pub struct Rendered {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub backend: RenderBackend,
    pub adapter: String,
    pub camera: Camera,
}

/// Width and height of a PNG (IHDR), or None.
pub fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" || &png[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(png[20..24].try_into().ok()?);
    Some((w, h))
}

const GPU_HINT: &str = "run from a logged-in GUI session on a machine with a GPU; \
RW_RENDER_ALLOW_SOFTWARE=1 accepts a software render (never for gates)";

/// Checks a reply against the request: ready, real WebGPU on a hardware
/// adapter (unless `allow_software`), a PNG of the requested size.
pub fn verify_reply(
    reply: RendererReply,
    width: u32,
    height: u32,
    allow_software: bool,
) -> Result<Rendered, ApiError> {
    if reply.status != "ready" {
        return Err(err(
            ApiErrorCode::Io,
            format!(
                "{RENDERER} failed: {}",
                reply.error.as_deref().unwrap_or("no error message")
            ),
            Some(GPU_HINT),
        ));
    }
    let adapter = reply.adapter.unwrap_or_default();
    let backend = match reply.backend.as_deref() {
        Some("webgpu") => RenderBackend::Webgpu,
        Some("webgl2") | Some("webgl") => RenderBackend::Webgl2,
        other => {
            return Err(err(
                ApiErrorCode::Io,
                format!("{RENDERER} reported no renderer backend ({other:?})"),
                Some(GPU_HINT),
            ));
        }
    };
    if !allow_software {
        if backend != RenderBackend::Webgpu {
            return Err(err(
                ApiErrorCode::Io,
                format!("{RENDERER} fell back to WebGL2 instead of WebGPU"),
                Some(GPU_HINT),
            ));
        }
        if adapter.is_software() {
            return Err(err(
                ApiErrorCode::Io,
                format!(
                    "{RENDERER} rendered on a fallback adapter ({})",
                    adapter.label()
                ),
                Some(GPU_HINT),
            ));
        }
    }
    let b64 = reply.png_base64.unwrap_or_default();
    let png = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| err(ApiErrorCode::Internal, format!("renderer PNG: {e}"), None))?;
    let size = png_size(&png).ok_or_else(|| {
        err(
            ApiErrorCode::Internal,
            format!("{RENDERER} returned no PNG"),
            None,
        )
    })?;
    if size != (width, height) {
        return Err(err(
            ApiErrorCode::Internal,
            format!(
                "{RENDERER} returned a {}x{} PNG for a {width}x{height} request",
                size.0, size.1
            ),
            None,
        ));
    }
    let camera = reply.camera.ok_or_else(|| {
        err(
            ApiErrorCode::Internal,
            format!("{RENDERER} reported no camera"),
            None,
        )
    })?;
    Ok(Rendered {
        png,
        width,
        height,
        backend,
        adapter: adapter.label(),
        camera,
    })
}

/// The last stdout line that parses as a reply.
pub fn parse_reply(stdout: &str) -> Option<RendererReply> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .find_map(|l| serde_json::from_str(l).ok())
}

/// Output size: both given, or one with the 3:2 default aspect, or the default.
pub fn image_size(width: Option<u32>, height: Option<u32>) -> Result<(u32, u32), ApiError> {
    for (what, v) in [("width", width), ("height", height)] {
        if v.is_some_and(|v| v == 0 || v > MAX_EDGE) {
            return Err(err(
                ApiErrorCode::InvalidInput,
                format!("{what} must be 1..={MAX_EDGE} px"),
                None,
            ));
        }
    }
    let (dw, dh) = DEFAULT_SIZE;
    let scaled = |v: u32, num: u32, den: u32| {
        ((u64::from(v) * u64::from(num) + u64::from(den) / 2) / u64::from(den))
            .clamp(1, u64::from(MAX_EDGE)) as u32
    };
    Ok(match (width, height) {
        (Some(w), Some(h)) => (w, h),
        (Some(w), None) => (w, scaled(w, dh, dw)),
        (None, Some(h)) => (scaled(h, dw, dh), h),
        (None, None) => DEFAULT_SIZE,
    })
}

/// Runs the renderer on `req`: JSON on stdin, one reply line on stdout.
pub fn run_renderer(
    exe: &Path,
    req: &RenderRequest,
    allow_software: bool,
    timeout: Duration,
) -> Result<RendererReply, ApiError> {
    let input =
        serde_json::to_vec(req).map_err(|e| err(ApiErrorCode::Internal, e.to_string(), None))?;
    let mut cmd = Command::new(exe);
    if allow_software {
        cmd.arg("--allow-software");
    }
    cmd.env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        err(
            ApiErrorCode::Io,
            format!("starting {}: {e}", exe.display()),
            Some(MISSING_HINT),
        )
    })?;
    let mut stdin = child.stdin.take();
    let writer = std::thread::spawn(move || {
        // A renderer that exits early closes the pipe; its reply says why.
        if let Some(mut w) = stdin.take() {
            let _ = w.write_all(&input);
        }
    });
    let drain = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = drain(
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let errs = drain(
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err(
                    ApiErrorCode::Io,
                    format!("{RENDERER} timed out after {} ms", timeout.as_millis()),
                    Some(GPU_HINT),
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => {
                return Err(err(
                    ApiErrorCode::Io,
                    format!("waiting for {RENDERER}: {e}"),
                    None,
                ));
            }
        }
    };
    let _ = writer.join();
    let stdout = out.join().unwrap_or_default();
    let stderr = errs.join().unwrap_or_default();
    match parse_reply(&stdout) {
        Some(r) => Ok(r),
        None => {
            let tail: String = {
                let lines: Vec<&str> = stderr.lines().collect();
                lines[lines.len().saturating_sub(8)..].join("\n")
            };
            Err(err(
                ApiErrorCode::Io,
                format!("{RENDERER} exited ({status}) without a reply: {tail}"),
                Some(MISSING_HINT),
            ))
        }
    }
}

fn timeout_from_env() -> Duration {
    std::env::var(ENV_TIMEOUT)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map_or(DEFAULT_TIMEOUT, Duration::from_millis)
}

/// Renders a 3D view to `renders/` through the session (the only writer).
pub fn render(s: &mut Session, i: &RenderIn) -> Result<RenderResult, ApiError> {
    if !is_3d_view(i.view) {
        return Err(ApiError::not_implemented(&format!(
            "the {} view in rocketwright-render",
            view_name(i.view)
        )));
    }
    let explode = i.explode.unwrap_or(default_explode(i.view));
    if !(0.0..=1.0).contains(&explode) {
        return Err(err(
            ApiErrorCode::InvalidInput,
            "explode must be 0..1",
            None,
        ));
    }
    let (width, height) = image_size(i.width, i.height)?;
    let exe = locate()?;
    let (model, report) = s.evaluated(i.config.as_deref())?;
    // `--compare <version>`: that model and the marks of this one against it.
    let (compare_evaluated, compare_marks) = match &i.compare {
        Some(v) => {
            let (old, _) = s.evaluated_at(v, i.config.as_deref())?;
            let marks = rw_project::history::compare::component_marks(&old, &model);
            (Some(old), marks)
        }
        None => (None, Vec::new()),
    };
    let legend = crate::legend::legend(&model, &rw_geom::build(&model), i.view, explode > 0.0);
    let config = model.config.clone().unwrap_or_else(|| "default".into());
    let suffix = if i.compare.is_some() { ".compare" } else { "" };
    let path = format!("{RENDERS_DIR}/{config}.{}{suffix}.png", view_name(i.view));
    let req = RenderRequest {
        schema: rw_model::SchemaTag,
        view: i.view,
        scheme: i.scheme.unwrap_or(RenderScheme::Check),
        width,
        height,
        explode,
        // Exploded and cut-open views show the inner parts (M3.5).
        internals: explode > 0.0 || i.view == View::Section,
        config: model.config.clone(),
        evaluated: model,
        check: Some(report),
        compare_evaluated,
        compare_marks,
        out_path: path.clone(),
    };
    let allow_software = std::env::var(ENV_ALLOW_SOFTWARE).is_ok_and(|v| v == "1");
    let reply = run_renderer(&exe, &req, allow_software, timeout_from_env())?;
    let r = verify_reply(reply, width, height, allow_software)?;
    let png_sha256 = sha256_hex(&r.png);
    let model_hash = req.evaluated.model_hash.clone();
    let entry = ManifestEntry {
        view: i.view,
        config,
        model_hash: model_hash.clone(),
        png_sha256: png_sha256.clone(),
        width: r.width,
        height: r.height,
        svg: None,
    };
    crate::render::write_render(s, &path, r.png, None, entry)?;
    Ok(RenderResult {
        view: i.view,
        path,
        svg_path: None,
        png_sha256,
        width: r.width,
        height: r.height,
        camera: r.camera,
        backend: r.backend,
        adapter: Some(r.adapter),
        model_hash,
        legend: Some(legend),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn camera() -> Camera {
        Camera {
            position: [1.0, -1.0, 1.0],
            target: [0.3, 0.0, 0.0],
            up: [0.0, 0.0, 1.0],
            orthographic: true,
            fov_deg: None,
            ortho_height: Some(0.4),
        }
    }

    fn reply(backend: &str, fallback: Option<bool>, vendor: &str) -> RendererReply {
        RendererReply {
            status: "ready".into(),
            error: None,
            backend: Some(backend.into()),
            adapter: Some(AdapterInfo {
                vendor: vendor.into(),
                architecture: "metal-3".into(),
                description: String::new(),
                is_fallback_adapter: fallback,
            }),
            png_base64: Some(PNG_1X1.into()),
            width: Some(1),
            height: Some(1),
            camera: Some(camera()),
        }
    }

    #[test]
    fn env_override_is_the_only_candidate() {
        let c = candidates(
            Some(OsStr::new("/x/r")),
            Some(Path::new("/b/rocketwright")),
            None,
        );
        assert_eq!(c, vec![PathBuf::from("/x/r")]);
        let e = locate_with(Some(OsStr::new("/x/r")), None, None, |_| false).unwrap_err();
        assert_eq!(e.code.exit_code(), 2);
        assert!(e.message.contains("RW_RENDER=/x/r"), "{}", e.message);
    }

    #[test]
    fn search_order_beside_binary_then_bundle() {
        let c = candidates(
            None,
            Some(Path::new("/k/bin/rocketwright")),
            Some(Path::new("/home/u")),
        );
        assert_eq!(
            c,
            vec![
                PathBuf::from("/k/bin/rocketwright-render"),
                PathBuf::from("/k/bin/../Resources/bin/rocketwright-render"),
                PathBuf::from(
                    "/Applications/RocketWright.app/Contents/Resources/bin/rocketwright-render"
                ),
                PathBuf::from(
                    "/home/u/Applications/RocketWright.app/Contents/Resources/bin/rocketwright-render"
                ),
            ]
        );
        // An empty RW_RENDER is unset.
        assert_eq!(candidates(Some(OsStr::new("")), None, None).len(), 1);
        let found = locate_with(None, Some(Path::new("/k/bin/rocketwright")), None, |p| {
            p.ends_with("Resources/bin/rocketwright-render")
        })
        .unwrap();
        assert_eq!(
            found,
            PathBuf::from("/k/bin/../Resources/bin/rocketwright-render")
        );
    }

    #[test]
    fn absent_renderer_is_exit_2_with_a_hint() {
        let e = locate_with(None, Some(Path::new("/k/bin/rocketwright")), None, |_| {
            false
        })
        .unwrap_err();
        assert_eq!(e.code, ApiErrorCode::Io);
        assert_eq!(e.code.exit_code(), 2);
        assert!(e.message.contains("/k/bin/rocketwright-render"));
        assert!(e.hint.as_deref().unwrap().contains("RW_RENDER"));
    }

    #[test]
    fn accepts_webgpu_on_hardware() {
        let r = verify_reply(reply("webgpu", Some(false), "apple"), 1, 1, false).unwrap();
        assert_eq!(r.backend, RenderBackend::Webgpu);
        assert_eq!(r.adapter, "apple metal-3");
        assert_eq!((r.width, r.height), (1, 1));
        assert_eq!(r.camera, camera());
    }

    #[test]
    fn rejects_webgl_and_fallback_adapters() {
        for (rep, what) in [
            (reply("webgl2", Some(false), "apple"), "WebGL2"),
            (reply("webgpu", Some(true), "apple"), "fallback"),
            (reply("webgpu", None, "Google SwiftShader"), "fallback"),
            (reply("none", None, ""), "no renderer backend"),
        ] {
            let e = verify_reply(rep.clone(), 1, 1, false).unwrap_err();
            assert_eq!(e.code.exit_code(), 2);
            assert!(e.message.contains(what), "{}", e.message);
            if what != "no renderer backend" {
                assert!(verify_reply(rep, 1, 1, true).is_ok());
            }
        }
    }

    #[test]
    fn rejects_errors_and_wrong_sizes() {
        let mut r = reply("webgpu", Some(false), "apple");
        r.status = "error".into();
        r.error = Some("no adapter".into());
        let e = verify_reply(r, 1, 1, false).unwrap_err();
        assert!(e.message.contains("no adapter"));
        let e = verify_reply(reply("webgpu", Some(false), "apple"), 2, 1, false).unwrap_err();
        assert!(e.message.contains("1x1 PNG for a 2x1"), "{}", e.message);
    }

    #[test]
    fn reply_is_the_last_json_line() {
        let r = reply("webgpu", Some(false), "apple");
        let line = serde_json::to_string(&r).unwrap();
        let out = format!("noise\n{{not json\n{line}\n\n");
        assert_eq!(parse_reply(&out), Some(r));
        assert_eq!(parse_reply("nothing"), None);
    }

    #[test]
    fn sizes_default_to_3_by_2() {
        assert_eq!(image_size(None, None).unwrap(), (1536, 1024));
        assert_eq!(image_size(Some(900), None).unwrap(), (900, 600));
        assert_eq!(image_size(None, Some(400)).unwrap(), (600, 400));
        assert_eq!(image_size(Some(7), Some(9)).unwrap(), (7, 9));
        assert!(image_size(Some(0), None).is_err());
        assert!(image_size(None, Some(MAX_EDGE + 1)).is_err());
    }

    #[test]
    fn views() {
        assert!(is_3d_view(View::Iso) && is_3d_view(View::Rear));
        assert!(is_3d_view(View::Section) && is_3d_view(View::Exploded));
        assert!(!is_3d_view(View::Profile) && !is_3d_view(View::Anchors));
        assert_eq!(default_explode(View::Exploded), 1.0);
        assert_eq!(default_explode(View::Section), 0.0);
        assert_eq!(default_explode(View::Iso), 0.0);
        assert_eq!(
            png_size(
                &base64::engine::general_purpose::STANDARD
                    .decode(PNG_1X1)
                    .unwrap()
            ),
            Some((1, 1))
        );
    }
}
