//! Surface finish → roughness height ε (feeds skin friction, R4).
//!
//! A finish is a preset or an explicit `{ roughness = "60 um" }`. Presets
//! take the closest surface from the roughness table in Niskanen (2009)
//! Table 3.2 (data from Hoerner). Parity fixtures that must match another
//! tool's roughness give it explicitly.

use rw_units::DimKind;

use super::Check;
use crate::shape::Fields;
use crate::types::{EvalComponent, Finish, FinishPreset};

/// Roughness height ε (m) of a finish preset:
///
/// | preset | table surface | ε |
/// |---|---|---|
/// | `polished` | polished | 0.5 µm |
/// | `smooth_paint` | optimum paint-sprayed surface | 5 µm |
/// | `regular_paint` | production paint | 20 µm |
/// | `unfinished` | poor spray paint | 200 µm |
/// | `rough` | raw wood | 500 µm |
///
/// cite: niskanen-2009 tab 3.2 p 54
pub fn preset_roughness(p: FinishPreset) -> f64 {
    let um = match p {
        FinishPreset::Polished => 0.5,
        FinishPreset::SmoothPaint => 5.0,
        FinishPreset::RegularPaint => 20.0,
        FinishPreset::Unfinished => 200.0,
        FinishPreset::Rough => 500.0,
    };
    um * 1e-6
}

/// Evaluates a component's finish to its roughness (m); `None` without a finish.
pub(crate) fn eval_roughness(id: &str, finish: Option<&Finish>, f: &mut Fields) -> Option<f64> {
    match finish? {
        Finish::Preset(p) => Some(preset_roughness(*p)),
        Finish::Custom { roughness } => Some(f.at(roughness, &format!("c.{id}.finish.roughness"))),
    }
}

pub(crate) fn check(chk: &mut Check, e: &EvalComponent) {
    if let Some(r) = e.roughness {
        chk.non_negative("finish/roughness", r, DimKind::Length);
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn presets_are_ordered_smooth_to_rough() {
        let order = [
            FinishPreset::Polished,
            FinishPreset::SmoothPaint,
            FinishPreset::RegularPaint,
            FinishPreset::Unfinished,
            FinishPreset::Rough,
        ];
        for w in order.windows(2) {
            assert!(preset_roughness(w[0]) < preset_roughness(w[1]), "{w:?}");
        }
        assert!((preset_roughness(FinishPreset::RegularPaint) - 20e-6).abs() < 1e-18);
    }

    #[test]
    fn preset_and_custom_roughness_reach_the_model() {
        let m = model(
            r#"
[c.nose]
type = "nose_cone"
shape = "ogive"
length = "100 mm"
od = "25 mm"
finish = "polished"

[c.body]
type = "body_tube"
attach = { to = "nose.base" }
length = "300 mm"
od = "25 mm"
thickness = "1 mm"

[c.lug]
type = "launch_lug"
attach = { to = "body.mid" }
length = "35 mm"
od = "7 mm"
thickness = "1 mm"
finish = { roughness = "60 um" }
"#,
        );
        assert_clean(&m);
        assert_eq!(comp(&m, "nose").roughness, Some(0.5e-6));
        assert!((comp(&m, "lug").roughness.unwrap() - 60e-6).abs() < 1e-18);
        assert_eq!(comp(&m, "body").roughness, None);

        let bad = on_body(
            r#"
[c.lug]
type = "launch_lug"
attach = { to = "body.mid" }
length = "35 mm"
od = "7 mm"
thickness = "1 mm"
finish = { roughness = "-1 um" }
"#,
        );
        assert_diag(&bad, "RW-E061", "/c/lug/finish/roughness");
    }
}
