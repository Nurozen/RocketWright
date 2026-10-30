//! Tubes: body tube, inner tube (motor mount), coupler, launch lug, and the
//! tube fin set. Each has a length, an outer diameter, and a bore from `id`
//! or `thickness` (neither: a zero-thickness wall).

use rw_units::DimKind;

use super::Check;
use crate::diag;
use crate::types::{Component, ComponentKind, EvalComponent, EvalShape};

const L: DimKind = DimKind::Length;

/// True when the bore came from `id` (else from `thickness`, or a zero wall
/// when neither is given).
fn bore_from_id(src: &Component) -> bool {
    match &src.kind {
        ComponentKind::BodyTube(x) => x.id.is_some(),
        ComponentKind::InnerTube(x) => x.id.is_some(),
        ComponentKind::Coupler(x) => x.id.is_some(),
        ComponentKind::LaunchLug(x) => x.id.is_some(),
        ComponentKind::TubeFinSet(x) => x.id.is_some(),
        _ => false,
    }
}

pub(crate) fn check(chk: &mut Check, src: &Component, e: &EvalComponent) {
    let (length, od, id) = match &e.shape {
        EvalShape::BodyTube { length, od, id }
        | EvalShape::InnerTube { length, od, id, .. }
        | EvalShape::Coupler { length, od, id }
        | EvalShape::LaunchLug { length, od, id } => (*length, *od, *id),
        EvalShape::TubeFinSet {
            count,
            length,
            od,
            id,
        } => {
            chk.count("count", *count, 1, 12);
            (*length, *od, *id)
        }
        _ => return,
    };
    chk.positive("length", length, L);
    if !chk.positive("od", od, L) {
        return;
    }
    if bore_from_id(src) {
        if chk.non_negative("id", id, L) {
            chk.below("id", id, od, "the outer diameter", L);
        }
    } else if id < 0.0 {
        // id = od - 2 t: a wall thicker than the radius.
        chk.push(
            diag::E_GEOMETRY,
            "thickness",
            format!(
                "`{}.thickness` must not exceed half the outer diameter",
                chk.id
            ),
            "set a wall thickness below od / 2",
        );
    }
    // Neither `id` nor `thickness`: a zero-thickness wall (no wall mass).
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use crate::types::EvalShape;

    #[test]
    fn case1_body_tube_inner_tube_and_lug() {
        let m = on_body(
            r#"
[c.mmt]
type = "inner_tube"
attach = { to = "body.aft", at = "aft", offset = "5 mm" }
length = "75 mm"
od = "19 mm"
thickness = "0.5 mm"
motor_mount = true
overhang = "3 mm"

[c.lug]
type = "launch_lug"
attach = { to = "body.mid", at = "fore", offset = "-17.5 mm", spin = "19 deg" }
length = "35 mm"
od = "7 mm"
thickness = "1 mm"
"#,
        );
        assert_clean(&m);
        let EvalShape::BodyTube { od, id, length } = comp(&m, "body").shape else {
            panic!()
        };
        assert_eq!((od, length), (0.025, 0.3));
        assert!((id - 0.023).abs() < 1e-12);
        let EvalShape::InnerTube {
            motor_mount,
            overhang,
            id,
            ..
        } = comp(&m, "mmt").shape
        else {
            panic!()
        };
        assert!(motor_mount);
        assert_eq!(overhang, 0.003);
        assert!((id - 0.018).abs() < 1e-12);
        let lug = comp(&m, "lug");
        assert!((lug.x_fore - 0.1325).abs() < 1e-12, "{}", lug.x_fore);
        assert!((lug.roll - 19f64.to_radians()).abs() < 1e-12);
    }

    #[test]
    fn coupler_and_tube_fins() {
        let m = on_body(
            r#"
[c.cpl]
type = "coupler"
attach = { to = "body.inner", at = "fore" }
length = "60 mm"
od = "23 mm"
id = "21 mm"

[c.tf]
type = "tube_fin_set"
attach = { to = "body.aft", at = "aft" }
count = 6
length = "50 mm"
od = "12 mm"
thickness = "0.5 mm"
"#,
        );
        assert_clean(&m);
        let EvalShape::TubeFinSet { count, id, .. } = comp(&m, "tf").shape else {
            panic!()
        };
        assert_eq!(count, 6);
        assert!((id - 0.011).abs() < 1e-12);
    }

    #[test]
    fn bore_errors_and_missing_wall() {
        let m = model(
            r#"
[c.body]
type = "body_tube"
length = "300 mm"
od = "25 mm"
id = "26 mm"

[c.cpl]
type = "coupler"
attach = { to = "body.inner", at = "fore" }
length = "60 mm"
od = "23 mm"
thickness = "12 mm"

[c.lug]
type = "launch_lug"
attach = { to = "body.outer" }
length = "-1 mm"
od = "5 mm"

[c.tf]
type = "tube_fin_set"
attach = { to = "body.aft", at = "aft" }
count = 13
length = "50 mm"
od = "12 mm"
id = "11 mm"
"#,
        );
        assert_diag(&m, "RW-E061", "/c/body/id");
        assert_diag(&m, "RW-E061", "/c/cpl/thickness");
        assert_diag(&m, "RW-E061", "/c/lug/length");
        assert_diag(&m, "RW-E061", "/c/tf/count");
    }
}
