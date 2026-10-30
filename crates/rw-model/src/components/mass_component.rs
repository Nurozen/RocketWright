//! Mass components (avionics, ballast, wadding): a given mass with a packed
//! length and diameter. The diameter defaults to the parent's bore.

use rw_units::DimKind;

use super::Check;
use crate::types::{EvalComponent, EvalShape};

pub(crate) fn check(chk: &mut Check, e: &EvalComponent) {
    let EvalShape::MassComponent {
        mass, length, od, ..
    } = &e.shape
    else {
        return;
    };
    chk.non_negative("mass", *mass, DimKind::Mass);
    chk.non_negative("length", *length, DimKind::Length);
    chk.non_negative("od", *od, DimKind::Length);
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use crate::types::{EvalShape, MassRole};

    #[test]
    fn case1_wadding_and_roles() {
        let m = on_body(
            r#"
[c.wadding]
name = "Wadding"
type = "mass_component"
attach = { to = "body.fore", at = "fore", offset = "80 mm" }
mass = "2 g"
length = "30 mm"

[c.alt]
type = "mass_component"
attach = { to = "body.fore", at = "cg", offset = "150 mm" }
mass = "12 g"
length = "40 mm"
od = "20 mm"
role = "altimeter"
"#,
        );
        assert_clean(&m);
        let w = comp(&m, "wadding");
        assert_eq!((w.name.as_str(), w.x_fore), ("Wadding", 0.08));
        let EvalShape::MassComponent {
            mass,
            length,
            od,
            role,
        } = w.shape.clone()
        else {
            panic!()
        };
        assert_eq!((mass, length, role), (0.002, 0.03, None));
        // OD defaults to the body bore.
        assert!((od - 0.023).abs() < 1e-12);
        // The `cg` anchor sits mid-length without an override.
        let alt = comp(&m, "alt");
        assert!((alt.x_fore - 0.13).abs() < 1e-12, "{}", alt.x_fore);
        let EvalShape::MassComponent { role, .. } = alt.shape else {
            panic!()
        };
        assert_eq!(role, Some(MassRole::Altimeter));

        let bad = on_body(
            r#"
[c.m]
type = "mass_component"
attach = { to = "body.fore", at = "fore" }
mass = "-2 g"
length = "30 mm"
"#,
        );
        assert_diag(&bad, "RW-E061", "/c/m/mass");
    }
}
