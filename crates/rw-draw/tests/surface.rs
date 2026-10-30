//! Rail buttons and launch lugs sit on the body outline at their radial
//! position in the side views (B3 round 8: the profile drew rail buttons as
//! a square on the centreline). SVG and PNG goldens of the profile on
//! `fixtures/surface.rw.toml`; regenerate with
//! `RW_UPDATE_GOLDEN=1 cargo test -p rw-draw --test surface`.
#![allow(clippy::disallowed_methods)]

use std::path::PathBuf;

use rw_cli::render2d::{Tolerance, compare_png, svg_to_png};
use rw_draw::{DrawOptions, Markers, View, draw};
use rw_model::{EvalOptions, EvaluatedModel, SourceSet, eval, parse_source_with_warnings};

const SURFACE: &str = include_str!("fixtures/surface.rw.toml");

fn golden(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(name)
}

fn update() -> bool {
    std::env::var_os("RW_UPDATE_GOLDEN").is_some()
}

fn model() -> EvaluatedModel {
    let (doc, warnings) = parse_source_with_warnings("rocket.rw.toml", SURFACE).unwrap();
    assert!(warnings.is_empty(), "{warnings:?}");
    let mut s = SourceSet::default();
    s.docs.insert("rocket.rw.toml".into(), doc);
    let m = eval(&s, &EvalOptions::default());
    assert!(m.diagnostics.is_empty(), "{:#?}", m.diagnostics);
    m
}

fn profile() -> String {
    let m = model();
    let g = rw_geom::build(&m);
    draw(
        View::Profile,
        &m,
        &g,
        &Markers::default(),
        &DrawOptions::default(),
    )
}

/// `(x, y)` points of every `<polygon>` in the SVG.
fn polygons(svg: &str) -> Vec<Vec<(f64, f64)>> {
    svg.split("<polygon points=\"")
        .skip(1)
        .map(|rest| {
            rest[..rest.find('"').unwrap()]
                .split_whitespace()
                .map(|p| {
                    let (x, y) = p.split_once(',').unwrap();
                    (x.parse().unwrap(), y.parse().unwrap())
                })
                .collect()
        })
        .collect()
}

#[test]
fn surface_parts_sit_on_the_outline() {
    let m = model();
    let g = rw_geom::build(&m);
    let svg = profile();
    // Page scale and axis, from the frame rule (margin 80 px, width 1200).
    let len = g.length;
    let s = (1200.0 - 160.0) / len;
    let half = rw_draw_half(&g);
    let y0 = 70.0 + s * half;
    let r_body = 0.0208;
    let polys = polygons(&svg);
    let span = |p: &Vec<(f64, f64)>| {
        let (lo, hi) = p.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |a, q| {
            (a.0.min(q.1), a.1.max(q.1))
        });
        // Page y → body z (m).
        ((y0 - hi) / s, (y0 - lo) / s)
    };
    let near = |a: f64, b: f64| (a - b).abs() < 2.5e-4;
    // Two rail buttons standing on the upper outline: z from r to r + 8 mm.
    let buttons = polys
        .iter()
        .filter(|p| p.len() == 12)
        .map(span)
        .filter(|(lo, hi)| near(*lo, r_body) && near(*hi, r_body + 0.008))
        .count();
    assert_eq!(buttons, 2, "rail buttons on the outline:\n{svg}");
    // Lug at 60 deg on the upper outline, lug at 240 deg on the lower one,
    // each centred one lug radius off the surface.
    let lugs: Vec<(f64, f64)> = polys
        .iter()
        .filter(|p| p.len() == 4)
        .map(span)
        .filter(|(lo, hi)| near(hi - lo, 0.006))
        .collect();
    assert!(
        lugs.iter().any(|(lo, _)| near(*lo, r_body)),
        "upper lug {lugs:?}"
    );
    assert!(
        lugs.iter().any(|(_, hi)| near(*hi, -r_body)),
        "lower lug {lugs:?}"
    );
    // Nothing surface-mounted straddles the centreline any more.
    for p in polys.iter().filter(|p| p.len() == 12 || p.len() == 4) {
        let (lo, hi) = span(p);
        assert!(!(lo < 0.0 && hi > 0.0 && hi - lo < 0.02), "{p:?}");
    }
}

/// Largest radius of the drawing (body, fins, external parts), as rw-draw's frame.
fn rw_draw_half(g: &rw_geom::Geometry) -> f64 {
    let mut h = 0.5 * g.max_diameter;
    for c in &g.components {
        if let Some(f) = &c.fins {
            h = h.max(f.root_radius + f.span);
        }
        for p in &c.outer {
            h = h.max(p.r);
        }
        h = h.max(c.bbox.max[2]).max(-c.bbox.min[2]);
    }
    h
}

#[test]
fn surface_profile_golden() {
    let a = profile();
    assert_eq!(a, profile(), "two runs differ (I8)");
    let path = golden("surface.profile.svg");
    if update() {
        std::fs::write(&path, &a).unwrap();
    }
    let want = std::fs::read_to_string(&path).expect("golden missing; run with RW_UPDATE_GOLDEN=1");
    assert_eq!(a, want, "profile drifted from {}", path.display());
    let png = svg_to_png(&a, 1.0).unwrap();
    let pp = golden("surface.profile.png");
    if update() {
        std::fs::write(&pp, &png).unwrap();
    }
    let want = std::fs::read(&pp).expect("golden missing; run with RW_UPDATE_GOLDEN=1");
    let r = compare_png(&png, &want, Tolerance::default()).unwrap();
    assert!(r.pass, "profile PNG differs from golden: {r:?}");
}
