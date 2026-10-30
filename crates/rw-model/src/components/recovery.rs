//! Recovery: parachute (canopy, spill hole, shroud lines), streamer, shock
//! cord. Each also has a packed length and diameter inside its tube.

use rw_units::DimKind;

use super::Check;
use crate::types::{EvalComponent, EvalShape};

const L: DimKind = DimKind::Length;
const N: DimKind = DimKind::Dimensionless;

fn packed(chk: &mut Check, length: f64, diameter: f64) {
    chk.positive("packed_length", length, L);
    chk.positive("packed_diameter", diameter, L);
}

pub(crate) fn check(chk: &mut Check, e: &EvalComponent) {
    match &e.shape {
        EvalShape::Parachute {
            diameter,
            cd,
            spill_hole,
            line_count: _,
            line_length,
            line_material: _,
            packed_length,
            packed_diameter,
        } => {
            if chk.positive("diameter", *diameter, L)
                && chk.non_negative("spill_hole", *spill_hole, L)
            {
                chk.below(
                    "spill_hole",
                    *spill_hole,
                    *diameter,
                    "the canopy diameter",
                    L,
                );
            }
            chk.positive("cd", *cd, N);
            chk.non_negative("line_length", *line_length, L);
            packed(chk, *packed_length, *packed_diameter);
        }
        EvalShape::Streamer {
            length,
            width,
            cd,
            packed_length,
            packed_diameter,
        } => {
            chk.positive("length", *length, L);
            chk.positive("width", *width, L);
            chk.non_negative("cd", *cd, N);
            packed(chk, *packed_length, *packed_diameter);
        }
        EvalShape::ShockCord {
            cord_length,
            packed_length,
            packed_diameter,
        } => {
            chk.positive("cord_length", *cord_length, L);
            packed(chk, *packed_length, *packed_diameter);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use crate::types::EvalShape;

    #[test]
    fn case1_parachute_and_shock_cord() {
        let m = on_body(
            r#"
[c.chute]
type = "parachute"
attach = { to = "body.fore", at = "attach", offset = "32 mm" }
material = "ripstop"
diameter = "300 mm"
cd = 0.8
line_count = 6
line_length = "300 mm"
line_material = "cord"
packed_length = "42 mm"
packed_diameter = "18 mm"

[c.cord]
type = "shock_cord"
attach = { to = "body.fore", at = "attach", offset = "20 mm" }
material = "cord"
cord_length = "400 mm"
packed_length = "52 mm"
packed_diameter = "12 mm"

[materials.ripstop]
surface_density = "67 g/m^2"

[materials.cord]
line_density = "1.8 g/m"
"#,
        );
        assert_clean(&m);
        let chute = comp(&m, "chute");
        assert!((chute.x_fore - 0.032).abs() < 1e-12, "{}", chute.x_fore);
        let EvalShape::Parachute {
            diameter,
            cd,
            line_count,
            line_length,
            line_material,
            packed_length,
            packed_diameter,
            ..
        } = &chute.shape
        else {
            panic!()
        };
        assert_eq!(
            (*diameter, *cd, *line_count, *line_length),
            (0.3, 0.8, 6, 0.3)
        );
        assert_eq!(line_material.as_deref(), Some("cord"));
        assert!((packed_length - 0.042).abs() < 1e-12 && (packed_diameter - 0.018).abs() < 1e-12);
        assert!((m.materials["ripstop"].surface_density.unwrap() - 0.067).abs() < 1e-12);
        assert!((m.materials["cord"].line_density.unwrap() - 0.0018).abs() < 1e-12);
        let EvalShape::ShockCord { cord_length, .. } = comp(&m, "cord").shape else {
            panic!()
        };
        assert_eq!(cord_length, 0.4);
    }

    #[test]
    fn streamer_and_recovery_errors() {
        let ok = on_body(
            r#"
[c.st]
type = "streamer"
attach = { to = "body.fore", at = "attach" }
length = "1 m"
width = "50 mm"
cd = 0.6
packed_length = "40 mm"
packed_diameter = "20 mm"
"#,
        );
        assert_clean(&ok);

        let bad = on_body(
            r#"
[c.chute]
type = "parachute"
attach = { to = "body.fore", at = "attach" }
diameter = "300 mm"
cd = 0
spill_hole = "300 mm"
packed_length = "0 mm"
packed_diameter = "18 mm"

[c.st]
type = "streamer"
attach = { to = "body.fore", at = "attach" }
length = "1 m"
width = "0 mm"
packed_length = "40 mm"
packed_diameter = "20 mm"

[c.cord]
type = "shock_cord"
attach = { to = "body.fore", at = "attach" }
cord_length = "0 m"
packed_length = "52 mm"
packed_diameter = "12 mm"
"#,
        );
        assert_diag(&bad, "RW-E061", "/c/chute/cd");
        assert_diag(&bad, "RW-E061", "/c/chute/spill_hole");
        assert_diag(&bad, "RW-E061", "/c/chute/packed_length");
        assert_diag(&bad, "RW-E061", "/c/st/width");
        assert_diag(&bad, "RW-E061", "/c/cord/cord_length");
    }
}
