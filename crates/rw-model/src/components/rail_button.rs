//! Rail buttons: outer (base and flange) diameter, neck diameter, height,
//! base and flange heights.

use rw_units::DimKind;

use super::Check;
use crate::types::{EvalComponent, EvalShape};

const L: DimKind = DimKind::Length;

pub(crate) fn check(chk: &mut Check, e: &EvalComponent) {
    let EvalShape::RailButton {
        od,
        id,
        height,
        base_height,
        flange_height,
    } = &e.shape
    else {
        return;
    };
    let tall = chk.positive("height", *height, L);
    if chk.positive("od", *od, L) && chk.positive("id", *id, L) {
        chk.below("id", *id, *od, "the outer diameter", L);
    }
    let base = chk.non_negative("base_height", *base_height, L);
    if chk.non_negative("flange_height", *flange_height, L) && base && tall {
        chk.below(
            "flange_height",
            base_height + flange_height,
            *height,
            "the button height (with the base)",
            L,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use crate::types::EvalShape;

    #[test]
    fn rail_buttons_on_the_surface() {
        let m = on_body(
            r#"
[c.rb]
type = "rail_button"
attach = { to = "body.fore", at = "fore", offset = "50 mm" }
instances = { count = 2, pattern = "linear", spacing = "150 mm" }
od = "11 mm"
id = "6 mm"
height = "8 mm"
"#,
        );
        assert_clean(&m);
        let rb = comp(&m, "rb");
        assert_eq!(rb.instances.len(), 2);
        assert!((rb.radial - 0.0125).abs() < 1e-12, "{}", rb.radial);

        let bad = on_body(
            r#"
[c.rb]
type = "rail_button"
attach = { to = "body.fore", at = "fore" }
od = "6 mm"
id = "8 mm"
height = "0 mm"
"#,
        );
        assert_diag(&bad, "RW-E061", "/c/rb/id");
        assert_diag(&bad, "RW-E061", "/c/rb/height");

        // Base and flange default to a quarter of the height each.
        let EvalShape::RailButton {
            base_height,
            flange_height,
            ..
        } = comp(&m, "rb").shape
        else {
            panic!("rail button shape");
        };
        assert!((base_height - 0.002).abs() < 1e-15 && (flange_height - 0.002).abs() < 1e-15);

        let no_neck = on_body(
            r#"
[c.rb]
type = "rail_button"
attach = { to = "body.fore", at = "fore" }
od = "9.7 mm"
id = "8 mm"
height = "9.7 mm"
base_height = "5 mm"
flange_height = "5 mm"
"#,
        );
        assert_diag(&no_neck, "RW-E061", "/c/rb/flange_height");
    }
}
