//! Discs inside a tube: centering ring, bulkhead, engine block. The outer
//! diameter defaults to the parent's bore.

use rw_units::DimKind;

use super::Check;
use crate::diag;
use crate::types::{EvalComponent, EvalShape};

const L: DimKind = DimKind::Length;

pub(crate) fn check(chk: &mut Check, e: &EvalComponent) {
    let (length, od, id) = match &e.shape {
        EvalShape::CenteringRing { length, od, id } | EvalShape::EngineBlock { length, od, id } => {
            (*length, *od, Some(*id))
        }
        EvalShape::Bulkhead { length, od } => (*length, *od, None),
        _ => return,
    };
    chk.positive("length", length, L);
    if od <= 0.0 {
        chk.push(
            diag::E_GEOMETRY,
            "od",
            format!(
                "`{}.od` must be greater than 0; it defaults to the parent's bore, and this parent has none",
                chk.id
            ),
            "give `od`, or attach the part inside a tube",
        );
        return;
    }
    if let Some(id) = id
        && chk.non_negative("id", id, L)
    {
        chk.below("id", id, od, "the outer diameter", L);
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use crate::types::EvalShape;

    const MOUNT: &str = r#"
[c.mmt]
type = "inner_tube"
attach = { to = "body.aft", at = "aft", offset = "5 mm" }
length = "75 mm"
od = "19 mm"
thickness = "0.5 mm"
motor_mount = true
"#;

    #[test]
    fn case1_rings_and_engine_block() {
        let m = on_body(&format!(
            r#"{MOUNT}
[c.ring_fore]
type = "centering_ring"
attach = {{ to = "body.aft", at = "aft", offset = "-45 mm" }}
length = "2 mm"
od = "23 mm"
id = "19 mm"

[c.ring_aft]
type = "centering_ring"
attach = {{ to = "body.aft", at = "aft" }}
length = "2 mm"
id = "19 mm"

[c.block]
type = "engine_block"
attach = {{ to = "mmt.inner", at = "fore", offset = "2 mm" }}
length = "5 mm"
id = "12 mm"

[c.bh]
type = "bulkhead"
attach = {{ to = "body.fore", at = "fore", offset = "10 mm" }}
length = "3 mm"
"#
        ));
        assert_clean(&m);
        // Ring OD defaults to the body bore (23 mm); the block's to the mount's (18 mm).
        let EvalShape::CenteringRing { od, .. } = comp(&m, "ring_aft").shape else {
            panic!()
        };
        assert!((od - 0.023).abs() < 1e-12);
        let EvalShape::EngineBlock { od, id, .. } = comp(&m, "block").shape else {
            panic!()
        };
        assert!((od - 0.018).abs() < 1e-12 && (id - 0.012).abs() < 1e-12);
        let EvalShape::Bulkhead { od, .. } = comp(&m, "bh").shape else {
            panic!()
        };
        assert!((od - 0.023).abs() < 1e-12);
        assert!((comp(&m, "block").x_fore - 0.232).abs() < 1e-12);
    }

    #[test]
    fn ring_errors() {
        let m = on_body(
            r#"
[c.ring]
type = "centering_ring"
attach = { to = "body.aft", at = "aft" }
length = "0 mm"
id = "30 mm"

[c.block]
type = "engine_block"
attach = { to = "body.aft", at = "aft" }
length = "5 mm"
od = "20 mm"
id = "-1 mm"
"#,
        );
        assert_diag(&m, "RW-E061", "/c/ring/length");
        assert_diag(&m, "RW-E061", "/c/ring/id");
        assert_diag(&m, "RW-E061", "/c/block/id");
    }
}
