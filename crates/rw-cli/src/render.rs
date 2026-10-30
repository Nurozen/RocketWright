//! The `render` tool / `rw render --view profile|fin|stations|anchors`
//! (R3.1, M1.30): `rw-draw` SVG of the evaluated model (CG/CP markers from
//! the check report), rasterized deterministically by [`crate::render2d`],
//! written by the session to `renders/<config>.<view>.png` (plus the SVG),
//! and indexed in `renders/manifest.json`.
//!
//! `width`/`height` (`--imgsize WxH`) give the exact PNG size: the drawing is
//! scaled to fit and centred on a white canvas. With only a width, the
//! drawing is laid out at that width and the height follows the model.
//!
//! The 3D views go through `rocketwright-render` ([`crate::render3d`], RL3);
//! without it they fail with an I/O error (exit 2) and a hint.

use std::collections::BTreeMap;

use rw_api::{ApiError, ApiErrorCode, Camera, RenderBackend, RenderIn, RenderResult, View};
use rw_project::Session;
use serde::{Deserialize, Serialize};

/// Project-relative directory of renders.
pub const RENDERS_DIR: &str = "renders";
/// `renders/manifest.json`.
pub const MANIFEST: &str = "renders/manifest.json";
/// Default canvas width (CSS px) of the 2D views.
pub const DEFAULT_WIDTH: u32 = 1200;
/// Largest accepted edge (px).
pub const MAX_EDGE: u32 = 8192;

pub(crate) fn err(code: ApiErrorCode, message: impl Into<String>, hint: Option<&str>) -> ApiError {
    ApiError {
        outcome: None,
        code,
        message: message.into(),
        hint: hint.map(String::from),
        diagnostics: Vec::new(),
    }
}

/// One `renders/manifest.json` entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub view: View,
    pub config: String,
    pub model_hash: String,
    pub png_sha256: String,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub svg: Option<String>,
}

/// `renders/manifest.json`: PNG path → entry, key-sorted.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RenderManifest {
    pub renders: BTreeMap<String, ManifestEntry>,
}

/// The rw-draw view of a 2D `View`.
pub fn draw_view(v: View) -> Option<rw_draw::View> {
    Some(match v {
        View::Profile => rw_draw::View::Profile,
        View::Fin => rw_draw::View::Fin,
        View::Stations => rw_draw::View::Stations,
        View::Anchors => rw_draw::View::Anchors,
        _ => return None,
    })
}

/// CLI/file spelling of a view (`profile`, `iso`, ...).
pub fn view_name(v: View) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|x| x.as_str().map(String::from))
        .unwrap_or_default()
}

fn attr(tag: &str, name: &str) -> Option<f64> {
    let key = format!(" {name}=\"");
    let i = tag.find(&key)? + key.len();
    let j = tag[i..].find('"')? + i;
    tag[i..j].trim().parse().ok()
}

/// The `width`/`height` of a root `<svg>` element.
pub fn svg_size(svg: &str) -> Option<(f64, f64)> {
    let start = svg.find("<svg")?;
    let end = svg[start..].find('>')? + start;
    let tag = &svg[start..end];
    Some((attr(tag, "width")?, attr(tag, "height")?))
}

/// Wraps `svg` in an exact `w`×`h` canvas: scaled to fit, centred, white.
pub fn fit_svg(svg: &str, w: u32, h: u32) -> Option<String> {
    let (sw, sh) = svg_size(svg)?;
    if sw <= 0.0 || sh <= 0.0 {
        return None;
    }
    let body = svg.trim_start();
    let body = if body.starts_with("<?xml") {
        &body[body.find("?>")? + 2..]
    } else {
        body
    };
    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" viewBox=\"0 0 {w} {h}\">\
<rect x=\"0\" y=\"0\" width=\"{w}\" height=\"{h}\" fill=\"#ffffff\"/>\
<svg x=\"0\" y=\"0\" width=\"{w}\" height=\"{h}\" viewBox=\"0 0 {sw} {sh}\" preserveAspectRatio=\"xMidYMid meet\">{}</svg></svg>",
        strip_root(body)?
    ))
}

/// The children of the root `<svg>` element.
fn strip_root(svg: &str) -> Option<&str> {
    let start = svg.find("<svg")?;
    let open_end = svg[start..].find('>')? + start + 1;
    let close = svg.rfind("</svg>")?;
    (close >= open_end).then(|| &svg[open_end..close])
}

fn side_camera(model: &rw_model::EvaluatedModel) -> Camera {
    let length = model
        .components
        .iter()
        .map(|c| c.x_aft)
        .fold(0.0_f64, f64::max);
    let mid = length / 2.0;
    Camera {
        position: [mid, -(length.max(0.1)) * 2.0, 0.0],
        target: [mid, 0.0, 0.0],
        up: [0.0, 0.0, 1.0],
        orthographic: true,
        fov_deg: None,
        ortho_height: Some(model.reference.diameter.max(0.01) * 4.0),
    }
}

/// Writes a render (PNG, optional SVG) and its `renders/manifest.json`
/// entry through the session, the only writer (I1).
pub(crate) fn write_render(
    s: &mut Session,
    path: &str,
    png: Vec<u8>,
    svg: Option<(String, Vec<u8>)>,
    entry: ManifestEntry,
) -> Result<(), ApiError> {
    let mut manifest: RenderManifest = std::fs::read_to_string(s.root().join(MANIFEST))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    manifest.renders.insert(path.to_string(), entry);
    let mut mtext = serde_json::to_string_pretty(&manifest)
        .map_err(|e| err(ApiErrorCode::Internal, e.to_string(), None))?;
    mtext.push('\n');
    let mut files = vec![(path.to_string(), png)];
    files.extend(svg);
    files.push((MANIFEST.to_string(), mtext.into_bytes()));
    s.write_outputs(&files)
}

pub(crate) fn sha256_hex(b: &[u8]) -> String {
    rw_project::layout::sha256_hex(b)
}

/// User-facing label of a version (`step:3` → `Step 03`, `rev:7` → `Rev 07`,
/// `live` → `Current`).
pub fn version_label(v: &str) -> String {
    let v = v.trim();
    let num = |n: &str| n.trim().parse::<u32>().ok();
    if let Some(n) = v.strip_prefix("step:").and_then(num) {
        return format!("Step {n:02}");
    }
    if let Some(n) = v.strip_prefix("rev:").and_then(num) {
        return format!("Rev {n:02}");
    }
    if v.is_empty() || v.eq_ignore_ascii_case("live") {
        return "Current".into();
    }
    v.to_string()
}

/// The marks of `new` against `old` as rw-draw marks (id → mark).
pub fn draw_marks(marks: &[rw_api::ComponentMark]) -> BTreeMap<String, rw_draw::Mark> {
    marks
        .iter()
        .map(|m| {
            let k = match m.status {
                rw_api::MarkStatus::Removed => rw_draw::Mark::Removed,
                rw_api::MarkStatus::Changed => rw_draw::Mark::Changed,
                rw_api::MarkStatus::Added => rw_draw::Mark::Added,
            };
            (m.id.clone(), k)
        })
        .collect()
}

/// Renders a 2D view to `renders/` through the session (the only writer).
/// With `compare`, draws the compare profile of the current model against
/// that version (removed red, changed amber, added green).
pub fn render(s: &mut Session, i: &RenderIn) -> Result<RenderResult, ApiError> {
    render_2d_at(s, i, "live")
}

/// `render` with the drawn ("new") side at `version` (`history_compare
/// visual` draws `b` against `a`).
pub fn render_2d_at(
    s: &mut Session,
    i: &RenderIn,
    version: &str,
) -> Result<RenderResult, ApiError> {
    let Some(view) = draw_view(i.view) else {
        return crate::render3d::render(s, i);
    };
    if i.explode.is_some() {
        return Err(err(
            ApiErrorCode::InvalidInput,
            "explode applies to the 3D views",
            Some("drop it for profile, fin, stations, and anchors"),
        ));
    }
    if i.compare.is_some() && view != rw_draw::View::Profile {
        return Err(err(
            ApiErrorCode::InvalidInput,
            "the 2D compare draws the profile",
            Some("use --view profile, or a 3D view (iso, top, side, front, rear)"),
        ));
    }
    for (what, v) in [("width", i.width), ("height", i.height)] {
        if v.is_some_and(|v| v == 0 || v > MAX_EDGE) {
            return Err(err(
                ApiErrorCode::InvalidInput,
                format!("{what} must be 1..={MAX_EDGE} px"),
                None,
            ));
        }
    }
    let live = version.trim().is_empty() || version.trim().eq_ignore_ascii_case("live");
    let (model, report) = if live {
        s.evaluated(i.config.as_deref())?
    } else {
        s.evaluated_at(version, i.config.as_deref())?
    };
    let geometry = rw_geom::build(&model);
    // What was drawn, as numbers (the 2D views draw internals, dashed).
    let legend = crate::legend::legend(&model, &geometry, i.view, true);
    let layout_width = match (i.width, i.height) {
        (Some(w), None) => w,
        _ => DEFAULT_WIDTH,
    };
    let opts = rw_draw::DrawOptions {
        width: f64::from(layout_width),
        internals: true,
    };
    let svg = match &i.compare {
        Some(v) => {
            let (old, _) = s.evaluated_at(v, i.config.as_deref())?;
            let old_geometry = rw_geom::build(&old);
            let marks = draw_marks(&rw_project::history::compare::component_marks(&old, &model));
            let (la, lb) = (version_label(v), version_label(version));
            rw_draw::draw_compare(
                rw_draw::Side {
                    model: &old,
                    geometry: &old_geometry,
                    label: &la,
                },
                rw_draw::Side {
                    model: &model,
                    geometry: &geometry,
                    label: &lb,
                },
                &marks,
                &opts,
            )
        }
        None => {
            let markers = rw_draw::Markers::from_report(&report);
            rw_draw::draw(view, &model, &geometry, &markers, &opts)
        }
    };
    let svg = match (i.width, i.height) {
        (Some(w), Some(h)) => fit_svg(&svg, w, h)
            .ok_or_else(|| err(ApiErrorCode::Internal, "the drawing has no size", None))?,
        (None, Some(h)) => {
            let (sw, sh) = svg_size(&svg)
                .ok_or_else(|| err(ApiErrorCode::Internal, "the drawing has no size", None))?;
            let w = ((sw * f64::from(h) / sh).round() as u32).clamp(1, MAX_EDGE);
            fit_svg(&svg, w, h)
                .ok_or_else(|| err(ApiErrorCode::Internal, "the drawing has no size", None))?
        }
        _ => svg,
    };
    let raster = crate::render2d::rasterize(&svg, 1.0)
        .map_err(|e| err(ApiErrorCode::Internal, format!("rasterizing: {e}"), None))?;
    let png = crate::render2d::encode_png(&raster)
        .map_err(|e| err(ApiErrorCode::Internal, format!("encoding: {e}"), None))?;
    let config = model.config.clone().unwrap_or_else(|| "default".into());
    let vname = view_name(i.view);
    let stem = if i.compare.is_some() {
        format!("{RENDERS_DIR}/{config}.{vname}.compare")
    } else {
        format!("{RENDERS_DIR}/{config}.{vname}")
    };
    let path = format!("{stem}.png");
    let svg_path = format!("{stem}.svg");
    let png_sha256 = sha256_hex(&png);
    let entry = ManifestEntry {
        view: i.view,
        config: config.clone(),
        model_hash: model.model_hash.clone(),
        png_sha256: png_sha256.clone(),
        width: raster.width,
        height: raster.height,
        svg: Some(svg_path.clone()),
    };
    write_render(
        s,
        &path,
        png,
        Some((svg_path.clone(), svg.into_bytes())),
        entry,
    )?;
    Ok(RenderResult {
        view: i.view,
        path,
        svg_path: Some(svg_path),
        png_sha256,
        width: raster.width,
        height: raster.height,
        camera: side_camera(&model),
        backend: RenderBackend::Resvg,
        adapter: None,
        model_hash: model.model_hash,
        legend: Some(legend),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_an_exact_canvas() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"40\" viewBox=\"0 0 100 40\"><rect x=\"0\" y=\"0\" width=\"100\" height=\"40\" fill=\"#000\"/></svg>";
        assert_eq!(svg_size(svg), Some((100.0, 40.0)));
        let fitted = fit_svg(svg, 80, 60).unwrap();
        let r = crate::render2d::rasterize(&fitted, 1.0).unwrap();
        assert_eq!((r.width, r.height), (80, 60));
        // Letterboxed: the top-left corner is the white canvas, the centre is drawn.
        assert_eq!(&r.rgba[0..4], &[255, 255, 255, 255]);
        let c = ((30 * 80 + 40) * 4) as usize;
        assert_eq!(&r.rgba[c..c + 4], &[0, 0, 0, 255]);
    }

    #[test]
    fn view_names() {
        assert_eq!(view_name(View::Profile), "profile");
        assert!(draw_view(View::Iso).is_none());
    }
}
