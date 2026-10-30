//! Joints (R2.5): display and check metadata on separation points:
//! `joint = { type = "friction" | "twist_lock" | "shear_pin" | "screw", count }`
//! on couplers, shoulders (nose cones and transitions that have one), and
//! bays (body tubes).

use super::Check;
use crate::diag;
use crate::types::{ComponentType, EvalComponent, EvalShape, JointType};

/// True when a component of this shape can carry a joint.
pub fn can_carry_joint(s: &EvalShape) -> bool {
    match s {
        EvalShape::Coupler { .. } | EvalShape::BodyTube { .. } => true,
        EvalShape::NoseCone { shoulder, .. } => shoulder.is_some(),
        EvalShape::Transition {
            fore_shoulder,
            aft_shoulder,
            ..
        } => fore_shoulder.is_some() || aft_shoulder.is_some(),
        _ => false,
    }
}

/// True when the joint type is counted (pins, screws).
pub const fn needs_count(t: JointType) -> bool {
    matches!(t, JointType::ShearPin | JointType::Screw)
}

pub(crate) fn check(chk: &mut Check, e: &EvalComponent) {
    let Some(j) = &e.joint else { return };
    if !can_carry_joint(&e.shape) {
        let t = e.component_type();
        let why = if matches!(t, ComponentType::NoseCone | ComponentType::Transition) {
            "it has no shoulder"
        } else {
            "joints sit on couplers, shoulders, and bays"
        };
        chk.push(
            diag::E_JOINT,
            "joint",
            format!("`{}` ({}) cannot carry a joint: {why}", chk.id, t.name()),
            "move the joint to the coupler, shoulder, or body tube at the separation point",
        );
        return;
    }
    match j.count {
        Some(0) => chk.push(
            diag::E_JOINT,
            "joint/count",
            format!("`{}.joint.count` is 0", chk.id),
            "give the number of pins or screws, or remove `count`",
        ),
        None if needs_count(j.kind) => chk.push(
            diag::W_JOINT_COUNT,
            "joint/count",
            format!("`{}.joint` has no `count`", chk.id),
            "add e.g. `count = 3`",
        ),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use crate::types::JointType;

    #[test]
    fn joints_on_couplers_shoulders_and_bays() {
        let m = model(
            r#"
[c.nose]
type = "nose_cone"
shape = "ogive"
length = "100 mm"
od = "25 mm"
thickness = "2 mm"
shoulder = { length = "20 mm", od = "23 mm" }
joint = { type = "friction" }

[c.body]
type = "body_tube"
attach = { to = "nose.base" }
length = "300 mm"
od = "25 mm"
thickness = "1 mm"
joint = { type = "shear_pin", count = 2 }

[c.cpl]
type = "coupler"
attach = { to = "body.aft", at = "mid" }
length = "60 mm"
od = "23 mm"
thickness = "1 mm"
joint = { type = "twist_lock" }
"#,
        );
        assert_clean(&m);
        let j = comp(&m, "body").joint.clone().unwrap();
        assert_eq!((j.kind, j.count), (JointType::ShearPin, Some(2)));
    }

    #[test]
    fn misplaced_or_uncounted_joints() {
        let m = model(
            r#"
[c.nose]
type = "nose_cone"
shape = "ogive"
length = "100 mm"
od = "25 mm"
joint = { type = "friction" }

[c.body]
type = "body_tube"
attach = { to = "nose.base" }
length = "300 mm"
od = "25 mm"
thickness = "1 mm"
joint = { type = "screw" }

[c.fins]
type = "trapezoidal_fin_set"
attach = { to = "body.aft", at = "root_te" }
count = 3
root_chord = "50 mm"
tip_chord = "30 mm"
span = "30 mm"
sweep = "20 mm"
thickness = "2 mm"
joint = { type = "shear_pin", count = 0 }
"#,
        );
        assert_diag(&m, "RW-E065", "/c/nose/joint");
        assert_diag(&m, "RW-W002", "/c/body/joint/count");
        assert_diag(&m, "RW-E065", "/c/fins/joint");
    }
}
