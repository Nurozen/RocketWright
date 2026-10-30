//! Deterministic 2D rasterization (spike M1.12): SVG → PNG through resvg with
//! only the vendored Inter fonts, plus a tolerance compare for PNG goldens.
//!
//! Determinism rules (I8):
//! - `resvg` is pinned exactly in the workspace manifest, built with `text`
//!   and without `system-fonts`, so the font database holds only the
//!   vendored Inter faces (OFL, `assets/fonts/OFL.txt`). Every generic family
//!   (`sans-serif`, `serif`, `monospace`, …) and the default family resolve
//!   to Inter, so text never depends on the host's fonts.
//! - Parsing is hermetic: no resources directory, and `<image>` hrefs that
//!   name files or URLs are dropped (only inline `data:` images render).
//! - The PNG carries no timestamp or text chunks; same SVG and scale give the
//!   same bytes.
//!
//! `rw-draw` (pure) produces the SVG strings this module rasterizes (M1.41).

use resvg::tiny_skia;
use resvg::usvg;

/// Family name of the vendored font.
pub const FONT_FAMILY: &str = "Inter";
/// Inter 4.1 Regular (weight 400), from the upstream release `extras/ttf/`.
pub const INTER_REGULAR: &[u8] = include_bytes!("../assets/fonts/Inter-Regular.ttf");
/// Inter 4.1 SemiBold (weight 600), from the upstream release `extras/ttf/`.
pub const INTER_SEMIBOLD: &[u8] = include_bytes!("../assets/fonts/Inter-SemiBold.ttf");
/// Fixed fixture used by the determinism tests and `rw render` smoke checks.
pub const DETERMINISM_SVG: &str = include_str!("../assets/render2d-determinism.svg");

/// Largest raster edge we produce, in pixels (guards against huge `scale`).
pub const MAX_EDGE_PX: u32 = 16_384;

/// Errors from rasterization and PNG comparison.
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum RenderError {
    #[error("svg parse error: {0}")]
    Parse(String),
    #[error("scale must be finite and > 0, got {0}")]
    BadScale(f32),
    #[error("raster size {width}x{height} is empty or exceeds {MAX_EDGE_PX} px")]
    BadSize { width: u32, height: u32 },
    #[error("png encode error: {0}")]
    Encode(String),
    #[error("png decode error: {0}")]
    Decode(String),
}

/// A straight-alpha RGBA8 raster, row-major, `width * height * 4` bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Raster {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Raster {
    /// Decodes a PNG into straight-alpha RGBA8.
    pub fn from_png(png: &[u8]) -> Result<Self, RenderError> {
        let pixmap =
            tiny_skia::Pixmap::decode_png(png).map_err(|e| RenderError::Decode(e.to_string()))?;
        Ok(Self::from_pixmap(pixmap))
    }

    fn from_pixmap(pixmap: tiny_skia::Pixmap) -> Self {
        let (width, height) = (pixmap.width(), pixmap.height());
        Raster {
            width,
            height,
            rgba: pixmap.take_demultiplied(),
        }
    }
}

/// Font database holding only the vendored Inter faces, with every generic
/// family mapped to Inter.
pub fn font_db() -> usvg::fontdb::Database {
    let mut db = usvg::fontdb::Database::new();
    db.load_font_data(INTER_REGULAR.to_vec());
    db.load_font_data(INTER_SEMIBOLD.to_vec());
    db.set_serif_family(FONT_FAMILY);
    db.set_sans_serif_family(FONT_FAMILY);
    db.set_cursive_family(FONT_FAMILY);
    db.set_fantasy_family(FONT_FAMILY);
    db.set_monospace_family(FONT_FAMILY);
    db
}

/// Hermetic parse options: fixed DPI, Inter as the default family, vendored
/// fonts only, no filesystem or network image loading.
pub fn options() -> usvg::Options<'static> {
    let mut opt = usvg::Options {
        dpi: 96.0,
        font_family: FONT_FAMILY.to_owned(),
        font_size: 12.0,
        languages: vec!["en".to_owned()],
        resources_dir: None,
        ..usvg::Options::default()
    };
    opt.image_href_resolver.resolve_string = Box::new(|_, _| None);
    *opt.fontdb_mut() = font_db();
    opt
}

/// Rasterizes `svg` at `scale` (1.0 = one CSS px per pixel) onto a
/// transparent canvas. The size is the SVG size times `scale`, rounded up.
pub fn rasterize(svg: &str, scale: f32) -> Result<Raster, RenderError> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err(RenderError::BadScale(scale));
    }
    let tree =
        usvg::Tree::from_str(svg, &options()).map_err(|e| RenderError::Parse(e.to_string()))?;
    let size = tree.size();
    let width = (size.width() * scale).ceil();
    let height = (size.height() * scale).ceil();
    let (w, h) = (width as u32, height as u32);
    if !(1.0..=MAX_EDGE_PX as f32).contains(&width) || !(1.0..=MAX_EDGE_PX as f32).contains(&height)
    {
        return Err(RenderError::BadSize {
            width: w,
            height: h,
        });
    }
    let mut pixmap = tiny_skia::Pixmap::new(w, h).ok_or(RenderError::BadSize {
        width: w,
        height: h,
    })?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    Ok(Raster::from_pixmap(pixmap))
}

/// Rasterizes `svg` at `scale` and encodes it as PNG. Byte-identical for the
/// same inputs.
pub fn svg_to_png(svg: &str, scale: f32) -> Result<Vec<u8>, RenderError> {
    let raster = rasterize(svg, scale)?;
    encode_png(&raster)
}

/// Encodes a straight-alpha raster as RGBA8 PNG (no ancillary chunks).
pub fn encode_png(raster: &Raster) -> Result<Vec<u8>, RenderError> {
    let size =
        tiny_skia::IntSize::from_wh(raster.width, raster.height).ok_or(RenderError::BadSize {
            width: raster.width,
            height: raster.height,
        })?;
    // tiny-skia stores premultiplied pixels; premultiply so encode_png's
    // demultiply round-trips the straight values we hold.
    let mut data = raster.rgba.clone();
    for px in data.chunks_exact_mut(4) {
        let c = tiny_skia::ColorU8::from_rgba(px[0], px[1], px[2], px[3]).premultiply();
        px.copy_from_slice(&[c.red(), c.green(), c.blue(), c.alpha()]);
    }
    let pixmap = tiny_skia::Pixmap::from_vec(data, size).ok_or(RenderError::BadSize {
        width: raster.width,
        height: raster.height,
    })?;
    pixmap
        .encode_png()
        .map_err(|e| RenderError::Encode(e.to_string()))
}

/// Tolerance for comparing two rasters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tolerance {
    /// A pixel differs when any RGBA channel differs by more than this.
    pub channel: u8,
    /// The compare passes when the fraction of differing pixels is at most
    /// this (0.0 = none may differ).
    pub max_diff_fraction: f64,
}

impl Tolerance {
    /// Byte-exact pixels.
    pub const EXACT: Tolerance = Tolerance {
        channel: 0,
        max_diff_fraction: 0.0,
    };
}

impl Default for Tolerance {
    /// Anti-aliasing slack: channels within 2/255, at most 0.1 % of pixels off.
    fn default() -> Self {
        Tolerance {
            channel: 2,
            max_diff_fraction: 0.001,
        }
    }
}

/// Outcome of a raster comparison.
#[derive(Debug, Clone, PartialEq)]
pub struct CompareReport {
    pub width: u32,
    pub height: u32,
    /// Both rasters have the same dimensions. When false nothing else is
    /// compared and `pass` is false.
    pub same_size: bool,
    /// Pixels with some channel delta above `Tolerance::channel`.
    pub diff_pixels: u64,
    /// `diff_pixels / (width * height)`.
    pub diff_fraction: f64,
    /// Largest absolute channel delta over all pixels.
    pub max_channel_delta: u8,
    pub pass: bool,
}

/// Compares two rasters per pixel under `tol`.
pub fn compare(a: &Raster, b: &Raster, tol: Tolerance) -> CompareReport {
    let same_size = a.width == b.width && a.height == b.height && a.rgba.len() == b.rgba.len();
    if !same_size {
        return CompareReport {
            width: a.width,
            height: a.height,
            same_size,
            diff_pixels: 0,
            diff_fraction: 1.0,
            max_channel_delta: 0,
            pass: false,
        };
    }
    let mut diff_pixels = 0u64;
    let mut max_channel_delta = 0u8;
    for (pa, pb) in a.rgba.chunks_exact(4).zip(b.rgba.chunks_exact(4)) {
        let delta = pa
            .iter()
            .zip(pb)
            .map(|(x, y)| x.abs_diff(*y))
            .max()
            .unwrap_or(0);
        max_channel_delta = max_channel_delta.max(delta);
        if delta > tol.channel {
            diff_pixels += 1;
        }
    }
    let total = u64::from(a.width) * u64::from(a.height);
    let diff_fraction = if total == 0 {
        0.0
    } else {
        diff_pixels as f64 / total as f64
    };
    CompareReport {
        width: a.width,
        height: a.height,
        same_size,
        diff_pixels,
        diff_fraction,
        max_channel_delta,
        pass: diff_fraction <= tol.max_diff_fraction,
    }
}

/// Decodes two PNGs and compares them under `tol`.
pub fn compare_png(a: &[u8], b: &[u8], tol: Tolerance) -> Result<CompareReport, RenderError> {
    Ok(compare(&Raster::from_png(a)?, &Raster::from_png(b)?, tol))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, px: [u8; 4]) -> Raster {
        Raster {
            width: w,
            height: h,
            rgba: px.repeat((w * h) as usize),
        }
    }

    /// blake3 of the fixture PNG at scale 1. A change here means resvg, the
    /// fonts, or the fixture changed: bump it deliberately in the same commit.
    const GOLDEN_BLAKE3: &str = "be6f9a31125e2d8d66a4206950ce27240d3950cde8d6f2f3fdb72cc584af46d0";

    #[test]
    fn same_svg_twice_is_byte_identical() {
        let a = svg_to_png(DETERMINISM_SVG, 1.0).unwrap();
        let b = svg_to_png(DETERMINISM_SVG, 1.0).unwrap();
        assert_eq!(a, b);
        let c = svg_to_png(DETERMINISM_SVG, 2.0).unwrap();
        let d = svg_to_png(DETERMINISM_SVG, 2.0).unwrap();
        assert_eq!(c, d);
    }

    #[test]
    fn same_svg_on_other_threads_is_byte_identical() {
        let here = svg_to_png(DETERMINISM_SVG, 1.0).unwrap();
        let handles: Vec<_> = (0..4)
            .map(|_| std::thread::spawn(|| svg_to_png(DETERMINISM_SVG, 1.0).unwrap()))
            .collect();
        for h in handles {
            assert_eq!(h.join().unwrap(), here);
        }
    }

    #[test]
    fn fixture_png_matches_golden_hash() {
        let png = svg_to_png(DETERMINISM_SVG, 1.0).unwrap();
        assert_eq!(blake3::hash(&png).to_hex().as_str(), GOLDEN_BLAKE3);
    }

    #[test]
    fn png_has_no_time_or_text_chunks() {
        let png = svg_to_png(DETERMINISM_SVG, 1.0).unwrap();
        for chunk in [b"tIME", b"tEXt", b"iTXt", b"zTXt"] {
            assert!(
                !png.windows(4).any(|w| w == chunk),
                "{}",
                String::from_utf8_lossy(chunk)
            );
        }
    }

    #[test]
    fn fixture_size_follows_scale() {
        let r = rasterize(DETERMINISM_SVG, 1.0).unwrap();
        assert_eq!((r.width, r.height), (480, 200));
        let r = rasterize(DETERMINISM_SVG, 1.5).unwrap();
        assert_eq!((r.width, r.height), (720, 300));
    }

    #[test]
    fn font_db_holds_only_vendored_inter() {
        let db = font_db();
        assert_eq!(db.len(), 2);
        for face in db.faces() {
            assert!(face.families.iter().any(|(name, _)| name == FONT_FAMILY));
        }
    }

    fn ink(svg: &str) -> usize {
        rasterize(svg, 1.0)
            .unwrap()
            .rgba
            .chunks_exact(4)
            .filter(|p| p[3] > 0)
            .count()
    }

    fn text_svg(family: &str, weight: u32) -> String {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><text x="4" y="28" font-family="{family}" font-size="20" font-weight="{weight}">Rocket 123</text></svg>"#
        )
    }

    #[test]
    fn text_renders_with_vendored_font() {
        assert!(ink(&text_svg("Inter", 400)) > 100);
    }

    #[test]
    fn generic_and_unknown_families_fall_back_to_inter() {
        let inter = rasterize(&text_svg("Inter", 400), 1.0).unwrap();
        for family in ["sans-serif", "serif", "monospace", "Helvetica"] {
            let other = rasterize(&text_svg(family, 400), 1.0).unwrap();
            assert_eq!(other, inter, "{family}");
        }
    }

    #[test]
    fn semibold_differs_from_regular() {
        let regular = rasterize(&text_svg("Inter", 400), 1.0).unwrap();
        let semibold = rasterize(&text_svg("Inter", 600), 1.0).unwrap();
        assert_ne!(regular, semibold);
        assert!(ink(&text_svg("Inter", 600)) > ink(&text_svg("Inter", 400)));
    }

    #[test]
    fn external_images_are_not_loaded() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="/etc/hosts" width="10" height="10"/></svg>"#;
        assert_eq!(ink(svg), 0);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(matches!(
            rasterize("not svg", 1.0),
            Err(RenderError::Parse(_))
        ));
        assert_eq!(
            rasterize(DETERMINISM_SVG, 0.0),
            Err(RenderError::BadScale(0.0))
        );
        assert!(matches!(
            rasterize(DETERMINISM_SVG, f32::NAN),
            Err(RenderError::BadScale(_))
        ));
        assert!(matches!(
            rasterize(DETERMINISM_SVG, 1000.0),
            Err(RenderError::BadSize { .. })
        ));
        assert!(matches!(
            Raster::from_png(b"nope"),
            Err(RenderError::Decode(_))
        ));
    }

    #[test]
    fn png_round_trips_straight_alpha() {
        let r = rasterize(DETERMINISM_SVG, 1.0).unwrap();
        let png = encode_png(&r).unwrap();
        assert_eq!(png, svg_to_png(DETERMINISM_SVG, 1.0).unwrap());
        assert_eq!(Raster::from_png(&png).unwrap(), r);
    }

    #[test]
    fn compare_identical_passes_exact() {
        let png = svg_to_png(DETERMINISM_SVG, 1.0).unwrap();
        let rep = compare_png(&png, &png, Tolerance::EXACT).unwrap();
        assert!(rep.pass && rep.same_size);
        assert_eq!((rep.diff_pixels, rep.max_channel_delta), (0, 0));
        assert_eq!(rep.diff_fraction, 0.0);
    }

    #[test]
    fn compare_channel_tolerance() {
        let a = solid(4, 4, [100, 100, 100, 255]);
        let b = solid(4, 4, [102, 99, 100, 255]);
        let rep = compare(
            &a,
            &b,
            Tolerance {
                channel: 2,
                max_diff_fraction: 0.0,
            },
        );
        assert!(rep.pass);
        assert_eq!((rep.diff_pixels, rep.max_channel_delta), (0, 2));
        let rep = compare(
            &a,
            &b,
            Tolerance {
                channel: 1,
                max_diff_fraction: 0.0,
            },
        );
        assert!(!rep.pass);
        assert_eq!(rep.diff_pixels, 16);
        assert_eq!(rep.diff_fraction, 1.0);
    }

    #[test]
    fn compare_fraction_tolerance() {
        let a = solid(10, 10, [0, 0, 0, 255]);
        let mut b = a.clone();
        b.rgba[0] = 255; // one pixel of 100, red channel
        let rep = compare(
            &a,
            &b,
            Tolerance {
                channel: 0,
                max_diff_fraction: 0.01,
            },
        );
        assert!(rep.pass);
        assert_eq!((rep.diff_pixels, rep.max_channel_delta), (1, 255));
        assert!((rep.diff_fraction - 0.01).abs() < 1e-12);
        let rep = compare(
            &a,
            &b,
            Tolerance {
                channel: 0,
                max_diff_fraction: 0.009,
            },
        );
        assert!(!rep.pass);
        b.rgba[7] = 0; // second pixel, alpha channel
        let rep = compare(
            &a,
            &b,
            Tolerance {
                channel: 0,
                max_diff_fraction: 0.01,
            },
        );
        assert_eq!(rep.diff_pixels, 2);
        assert!(!rep.pass);
    }

    #[test]
    fn compare_size_mismatch_fails() {
        let rep = compare(
            &solid(4, 4, [0; 4]),
            &solid(4, 5, [0; 4]),
            Tolerance::default(),
        );
        assert!(!rep.same_size && !rep.pass);
    }

    #[test]
    fn compare_detects_render_change() {
        let base = svg_to_png(DETERMINISM_SVG, 1.0).unwrap();
        let moved = svg_to_png(&DETERMINISM_SVG.replace("cx=\"210\"", "cx=\"230\""), 1.0).unwrap();
        let rep = compare_png(&base, &moved, Tolerance::default()).unwrap();
        assert!(!rep.pass);
        assert!(rep.diff_pixels > 0);
    }
}
