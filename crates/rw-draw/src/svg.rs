//! A tiny deterministic SVG writer: fixed two-decimal coordinates, escaped
//! text, and the shared drawing style of the check scheme.

use std::fmt::Write;

/// Ink colours of the check scheme.
pub(crate) mod ink {
    pub const PAPER: &str = "#ffffff";
    pub const LINE: &str = "#1f2933";
    pub const BODY: &str = "#e4e9ef";
    pub const FIN: &str = "#c9d3de";
    pub const INNER: &str = "#5b6b7c";
    pub const DIM: &str = "#3d4852";
    pub const CG: &str = "#1f2933";
    pub const CP: &str = "#c0392b";
    pub const ANCHOR: &str = "#2b6cb0";
}

/// A coordinate with two decimals and no negative zero.
pub(crate) fn n(v: f64) -> String {
    let r = (v * 100.0).round() / 100.0;
    if r == 0.0 || !r.is_finite() {
        "0".to_string()
    } else {
        let s = format!("{r:.2}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// A length in metres as millimetres with one decimal.
pub(crate) fn mm(v: f64) -> String {
    let r = (v * 1e4).round() / 10.0;
    format!("{:.1}", if r == 0.0 { 0.0 } else { r })
}

pub(crate) fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Text anchoring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Anchor {
    Start,
    Middle,
    End,
}

impl Anchor {
    fn name(self) -> &'static str {
        match self {
            Anchor::Start => "start",
            Anchor::Middle => "middle",
            Anchor::End => "end",
        }
    }
}

/// An SVG document under construction.
pub(crate) struct Svg {
    w: f64,
    h: f64,
    body: String,
}

impl Svg {
    pub fn new(w: f64, h: f64) -> Self {
        let mut s = Svg {
            w: w.ceil(),
            h: h.ceil(),
            body: String::new(),
        };
        let (w, h) = (s.w, s.h);
        s.rect(0.0, 0.0, w, h, ink::PAPER, "none", 0.0, None);
        s
    }

    pub fn finish(self) -> String {
        let mut out = String::new();
        let _ = writeln!(
            out,
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" \
             viewBox=\"0 0 {w} {h}\" font-family=\"Inter\">",
            w = n(self.w),
            h = n(self.h)
        );
        out.push_str(&self.body);
        out.push_str("</svg>\n");
        out
    }

    fn push(&mut self, s: String) {
        self.body.push_str("  ");
        self.body.push_str(&s);
        self.body.push('\n');
    }

    pub fn comment(&mut self, text: &str) {
        self.push(format!("<!-- {} -->", escape(text).replace("--", "- -")));
    }

    #[allow(clippy::too_many_arguments)]
    pub fn rect(
        &mut self,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: &str,
        stroke: &str,
        width: f64,
        dash: Option<&str>,
    ) {
        self.push(format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{fill}\" stroke=\"{stroke}\" \
             stroke-width=\"{}\"{}/>",
            n(x),
            n(y),
            n(w.max(0.0)),
            n(h.max(0.0)),
            n(width),
            dash_attr(dash)
        ));
    }

    /// A closed polygon.
    pub fn polygon(
        &mut self,
        pts: &[(f64, f64)],
        fill: &str,
        stroke: &str,
        width: f64,
        dash: Option<&str>,
    ) {
        if pts.len() < 2 {
            return;
        }
        let p: Vec<String> = pts
            .iter()
            .map(|(x, y)| format!("{},{}", n(*x), n(*y)))
            .collect();
        self.push(format!(
            "<polygon points=\"{}\" fill=\"{fill}\" stroke=\"{stroke}\" stroke-width=\"{}\" \
             stroke-linejoin=\"round\"{}/>",
            p.join(" "),
            n(width),
            dash_attr(dash)
        ));
    }

    pub fn polyline(&mut self, pts: &[(f64, f64)], stroke: &str, width: f64, dash: Option<&str>) {
        let p: Vec<String> = pts
            .iter()
            .map(|(x, y)| format!("{},{}", n(*x), n(*y)))
            .collect();
        self.push(format!(
            "<polyline points=\"{}\" fill=\"none\" stroke=\"{stroke}\" stroke-width=\"{}\"{}/>",
            p.join(" "),
            n(width),
            dash_attr(dash)
        ));
    }

    pub fn line(
        &mut self,
        a: (f64, f64),
        b: (f64, f64),
        stroke: &str,
        width: f64,
        dash: Option<&str>,
    ) {
        self.push(format!(
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{stroke}\" stroke-width=\"{}\"{}/>",
            n(a.0),
            n(a.1),
            n(b.0),
            n(b.1),
            n(width),
            dash_attr(dash)
        ));
    }

    pub fn circle(&mut self, c: (f64, f64), r: f64, fill: &str, stroke: &str, width: f64) {
        self.push(format!(
            "<circle cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"{fill}\" stroke=\"{stroke}\" stroke-width=\"{}\"/>",
            n(c.0),
            n(c.1),
            n(r),
            n(width)
        ));
    }

    /// Text at `at`, optionally rotated (degrees, clockwise) about `at`.
    pub fn text(
        &mut self,
        at: (f64, f64),
        s: &str,
        size: f64,
        anchor: Anchor,
        fill: &str,
        rotate: f64,
    ) {
        let rot = if rotate == 0.0 {
            String::new()
        } else {
            format!(
                " transform=\"rotate({} {} {})\"",
                n(rotate),
                n(at.0),
                n(at.1)
            )
        };
        self.push(format!(
            "<text x=\"{}\" y=\"{}\" font-size=\"{}\" text-anchor=\"{}\" fill=\"{fill}\"{rot}>{}</text>",
            n(at.0),
            n(at.1),
            n(size),
            anchor.name(),
            escape(s)
        ));
    }

    /// A filled arrowhead at `tip` pointing away from `from`.
    pub fn arrow(&mut self, tip: (f64, f64), from: (f64, f64), color: &str) {
        let (dx, dy) = (tip.0 - from.0, tip.1 - from.1);
        let len = dx.hypot(dy);
        if len <= 0.0 {
            return;
        }
        let (ux, uy) = (dx / len, dy / len);
        let (l, w) = (8.0, 3.0);
        let base = (tip.0 - ux * l, tip.1 - uy * l);
        self.polygon(
            &[
                tip,
                (base.0 - uy * w, base.1 + ux * w),
                (base.0 + uy * w, base.1 - ux * w),
            ],
            color,
            "none",
            0.0,
            None,
        );
    }

    /// A dimension line between `a` and `b` with arrowheads at both ends and
    /// `label` centred beside it (`offset` px along the line normal).
    pub fn dimension(&mut self, a: (f64, f64), b: (f64, f64), label: &str, offset: f64) {
        self.line(a, b, ink::DIM, 1.0, None);
        self.arrow(a, b, ink::DIM);
        self.arrow(b, a, ink::DIM);
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len = dx.hypot(dy).max(1e-9);
        let (nx, ny) = (dy / len, -dx / len);
        let mid = (
            0.5 * (a.0 + b.0) + nx * offset,
            0.5 * (a.1 + b.1) + ny * offset,
        );
        let vertical = dx.abs() < dy.abs();
        self.text(
            mid,
            label,
            12.0,
            Anchor::Middle,
            ink::DIM,
            if vertical { -90.0 } else { 0.0 },
        );
    }
}

fn dash_attr(dash: Option<&str>) -> String {
    dash.map(|d| format!(" stroke-dasharray=\"{d}\""))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_fixed_and_signless_at_zero() {
        assert_eq!(n(-0.001), "0");
        assert_eq!(n(1.0), "1");
        assert_eq!(n(1.005_1), "1.01");
        assert_eq!(n(-12.3), "-12.3");
        assert_eq!(mm(0.0416), "41.6");
        assert_eq!(mm(-0.00001), "0.0");
    }

    #[test]
    fn text_is_escaped() {
        let mut s = Svg::new(10.0, 10.0);
        s.text(
            (1.0, 1.0),
            "a<b & \"c\"",
            10.0,
            Anchor::Start,
            ink::LINE,
            0.0,
        );
        let out = s.finish();
        assert!(out.contains("a&lt;b &amp; &quot;c&quot;"));
        assert!(out.starts_with("<svg xmlns"));
    }
}
