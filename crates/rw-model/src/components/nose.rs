//! Nose cones and transitions: every profile (conical, ogive, ellipsoid,
//! power, parabolic, Haack) and their shoulders.

use rw_units::DimKind;

use super::{Check, show};
use crate::diag;
use crate::types::{EvalComponent, EvalShape, EvalShoulder, NoseShape};

const L: DimKind = DimKind::Length;

/// The valid `shape_param` range `(lo, hi, lo_inclusive)` of a profile, or
/// `None` when the profile takes no parameter.
///
/// - ogive κ ∈ [0, 1]: 0 is a cone, 1 a tangent ogive (κ = ρ_t/ρ_o);
/// - parabolic κ ∈ [0, 1]: the series r ∝ x (2 − κx/l)/(2 − κ) stays monotone;
/// - power κ ∈ (0, 1]: r ∝ (x/l)^κ, convex for κ ≤ 1;
/// - Haack C ∈ [0, 2/3]: 0 is Von Kármán, 1/3 LV-Haack; above 2/3 the
///   profile overshoots the base radius before the base.
///
/// cite: niskanen-2009 eq A.3 p 111
pub fn shape_param_range(s: NoseShape) -> Option<(f64, f64, bool)> {
    match s {
        NoseShape::Ogive | NoseShape::Parabolic => Some((0.0, 1.0, true)),
        NoseShape::Power => Some((0.0, 1.0, false)),
        NoseShape::Haack => Some((0.0, 2.0 / 3.0, true)),
        NoseShape::Conical | NoseShape::Ellipsoid => None,
    }
}

fn shape_name(s: NoseShape) -> &'static str {
    match s {
        NoseShape::Conical => "conical",
        NoseShape::Ogive => "ogive",
        NoseShape::Ellipsoid => "ellipsoid",
        NoseShape::Power => "power",
        NoseShape::Parabolic => "parabolic",
        NoseShape::Haack => "haack",
    }
}

fn check_param(chk: &mut Check, shape: NoseShape, k: f64) {
    let Some((lo, hi, lo_incl)) = shape_param_range(shape) else {
        return;
    };
    let ok = k <= hi && if lo_incl { k >= lo } else { k > lo };
    if !ok {
        let open = if lo_incl { "[" } else { "(" };
        chk.push(
            diag::E_SHAPE_PARAM,
            "shape_param",
            format!(
                "`{}.shape_param` is {} but a {} profile needs {open}{}, {}]",
                chk.id,
                show(k, DimKind::Dimensionless),
                shape_name(shape),
                show(lo, DimKind::Dimensionless),
                show(hi, DimKind::Dimensionless)
            ),
            "set `shape_param` inside the range, or remove it for the default",
        );
    }
}

/// `field` is the shoulder table (`shoulder`, `fore_shoulder`, ...); `end_od`
/// is the outer diameter of the end it sits on.
fn check_shoulder(chk: &mut Check, field: &str, sh: &EvalShoulder, end_od: f64) {
    chk.positive(&format!("{field}/length"), sh.length, L);
    if chk.positive(&format!("{field}/od"), sh.od, L) {
        chk.at_most(
            &format!("{field}/od"),
            sh.od,
            end_od,
            "the outer diameter it sits on",
            L,
        );
        chk.non_negative(&format!("{field}/thickness"), sh.thickness, L);
        chk.at_most(
            &format!("{field}/thickness"),
            sh.thickness,
            sh.od / 2.0,
            "half the shoulder diameter",
            L,
        );
    }
}

pub(crate) fn check(chk: &mut Check, e: &EvalComponent) {
    match &e.shape {
        EvalShape::NoseCone {
            shape,
            shape_param,
            length,
            od,
            thickness,
            shoulder,
        } => {
            check_param(chk, *shape, *shape_param);
            chk.positive("length", *length, L);
            if chk.positive("od", *od, L) {
                chk.non_negative("thickness", *thickness, L);
                chk.at_most("thickness", *thickness, od / 2.0, "the base radius", L);
                if let Some(sh) = shoulder {
                    check_shoulder(chk, "shoulder", sh, *od);
                }
            }
        }
        EvalShape::Transition {
            shape,
            shape_param,
            length,
            fore_od,
            aft_od,
            thickness,
            fore_shoulder,
            aft_shoulder,
        } => {
            check_param(chk, *shape, *shape_param);
            chk.positive("length", *length, L);
            let a = chk.non_negative("fore_od", *fore_od, L);
            let b = chk.non_negative("aft_od", *aft_od, L);
            if a && b && fore_od.max(*aft_od) <= 0.0 {
                chk.positive("aft_od", *aft_od, L);
            }
            chk.non_negative("thickness", *thickness, L);
            chk.at_most(
                "thickness",
                *thickness,
                fore_od.max(*aft_od) / 2.0,
                "the larger end radius",
                L,
            );
            if let Some(sh) = fore_shoulder {
                check_shoulder(chk, "fore_shoulder", sh, *fore_od);
            }
            if let Some(sh) = aft_shoulder {
                check_shoulder(chk, "aft_shoulder", sh, *aft_od);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    fn nose(fields: &str) -> crate::types::EvaluatedModel {
        model(&format!(
            "[c.nose]\ntype = \"nose_cone\"\nlength = \"100 mm\"\nod = \"25 mm\"\n{fields}\n"
        ))
    }

    #[test]
    fn every_profile_evaluates_with_its_default_param() {
        for (shape, k) in [
            ("conical", 0.0),
            ("ogive", 1.0),
            ("ellipsoid", 0.0),
            ("power", 0.5),
            ("parabolic", 1.0),
            ("haack", 0.0),
        ] {
            let m = nose(&format!("shape = \"{shape}\""));
            assert_clean(&m);
            let EvalShape::NoseCone { shape_param, .. } = comp(&m, "nose").shape else {
                panic!()
            };
            assert_eq!(shape_param, k, "{shape}");
        }
    }

    #[test]
    fn shape_param_ranges_per_profile() {
        for (shape, k, ok) in [
            ("ogive", "0", true),
            ("ogive", "1", true),
            ("ogive", "1.2", false),
            ("ogive", "-0.1", false),
            ("parabolic", "0.75", true),
            ("parabolic", "1.5", false),
            ("power", "0", false),
            ("power", "0.3", true),
            ("power", "2", false),
            ("haack", "0.3333", true),
            ("haack", "0.9", false),
            // Profiles without a parameter ignore it.
            ("conical", "5", true),
        ] {
            let m = nose(&format!("shape = \"{shape}\"\nshape_param = {k}"));
            let bad = codes(&m)
                .iter()
                .any(|(c, p)| c == "RW-E062" && p == "/c/nose/shape_param");
            assert_eq!(!bad, ok, "{shape} {k}: {:?}", codes(&m));
        }
    }

    #[test]
    fn case1_nose_with_capped_shoulder() {
        let m = nose(
            r#"shape = "ogive"
shape_param = 1
thickness = "2 mm"
shoulder = { length = "20 mm", od = "23 mm", thickness = "2 mm", capped = true }"#,
        );
        assert_clean(&m);
        let EvalShape::NoseCone {
            shoulder: Some(sh),
            thickness,
            ..
        } = &comp(&m, "nose").shape
        else {
            panic!()
        };
        assert_eq!((sh.length, sh.od, sh.thickness), (0.02, 0.023, 0.002));
        assert!(sh.capped);
        assert_eq!(*thickness, 0.002);
        let a: Vec<&str> = comp(&m, "nose")
            .anchors
            .iter()
            .map(|a| a.name.as_str())
            .collect();
        assert!(a.contains(&"shoulder_aft"), "{a:?}");
    }

    #[test]
    fn nose_geometry_errors() {
        let m = model(
            r#"[c.nose]
type = "nose_cone"
shape = "conical"
length = "0 mm"
od = "25 mm"
thickness = "20 mm"
shoulder = { length = "20 mm", od = "30 mm" }"#,
        );
        assert_diag(&m, "RW-E061", "/c/nose/length");
        assert_diag(&m, "RW-E061", "/c/nose/thickness");
        assert_diag(&m, "RW-E061", "/c/nose/shoulder/od");
    }

    #[test]
    fn transition_shapes_and_shoulders() {
        let ok = on_body(
            r#"
[c.tr]
type = "transition"
attach = { to = "body.aft", at = "fore" }
shape = "haack"
shape_param = 0.3333
length = "40 mm"
fore_od = "25 mm"
aft_od = "40 mm"
thickness = "1.5 mm"
fore_shoulder = { length = "15 mm", od = "23 mm" }
aft_shoulder = { length = "20 mm", od = "38 mm" }
"#,
        );
        assert_clean(&ok);
        let EvalShape::Transition {
            fore_shoulder: Some(f),
            ..
        } = &comp(&ok, "tr").shape
        else {
            panic!()
        };
        // Shoulder thickness defaults to the transition wall.
        assert_eq!(f.thickness, 0.0015);

        let bad = on_body(
            r#"
[c.tr]
type = "transition"
attach = { to = "body.aft", at = "fore" }
shape = "power"
shape_param = 0
length = "40 mm"
fore_od = "0 mm"
aft_od = "0 mm"
aft_shoulder = { length = "20 mm", od = "38 mm" }
"#,
        );
        assert_diag(&bad, "RW-E062", "/c/tr/shape_param");
        assert_diag(&bad, "RW-E061", "/c/tr/aft_od");
        assert_diag(&bad, "RW-E061", "/c/tr/aft_shoulder/od");
    }
}
