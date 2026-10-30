//! Named anchors (R2.4, agent-data §4): where each anchor of an evaluated
//! shape sits, relative to the component's fore station.
//!
//! An anchor is `(dx, r)`: `dx` metres aft of the component's fore end, and
//! `r` the radius from the body axis. Surface parts take the parent's outer
//! radius `parent_r` at their station (fin roots sit on it). Inner parts
//! (rings, bulkheads, mass, recovery) report `r = 0` for their axial anchors.

use crate::types::{AnchorKind, ComponentType, EvalShape, anchor_kind};

/// One anchor relative to its component.
#[derive(Debug, Clone, PartialEq)]
pub struct RelAnchor {
    pub name: String,
    pub kind: AnchorKind,
    pub dx: f64,
    pub r: f64,
}

fn a(name: &str, dx: f64, r: f64) -> RelAnchor {
    RelAnchor {
        name: name.to_string(),
        kind: anchor_kind(name),
        dx,
        r,
    }
}

/// Axial extent (`x_aft - x_fore`) of a shape.
pub fn extent(s: &EvalShape) -> f64 {
    match s {
        EvalShape::NoseCone { length, .. }
        | EvalShape::BodyTube { length, .. }
        | EvalShape::Transition { length, .. }
        | EvalShape::TubeFinSet { length, .. }
        | EvalShape::InnerTube { length, .. }
        | EvalShape::Coupler { length, .. }
        | EvalShape::CenteringRing { length, .. }
        | EvalShape::Bulkhead { length, .. }
        | EvalShape::EngineBlock { length, .. }
        | EvalShape::LaunchLug { length, .. }
        | EvalShape::MassComponent { length, .. }
        | EvalShape::Tank { length, .. } => *length,
        EvalShape::TrapezoidalFinSet {
            root_chord,
            tip_chord,
            sweep,
            ..
        } => root_chord.max(sweep + tip_chord),
        EvalShape::EllipticalFinSet { root_chord, .. } => *root_chord,
        EvalShape::FreeformFinSet { points, .. } => points.iter().map(|p| p[0]).fold(0.0, f64::max),
        EvalShape::RailButton { od, .. } => *od,
        EvalShape::Parachute { packed_length, .. }
        | EvalShape::Streamer { packed_length, .. }
        | EvalShape::ShockCord { packed_length, .. } => *packed_length,
    }
}

/// Outer radius of a shape at `dx` aft of its fore end (for surface parts).
pub fn outer_radius_at(s: &EvalShape, dx: f64) -> f64 {
    match s {
        EvalShape::Transition {
            length,
            fore_od,
            aft_od,
            ..
        } => {
            let t = if *length > 0.0 {
                (dx / length).clamp(0.0, 1.0)
            } else {
                0.0
            };
            0.5 * (fore_od + (aft_od - fore_od) * t)
        }
        EvalShape::NoseCone { od, .. }
        | EvalShape::BodyTube { od, .. }
        | EvalShape::InnerTube { od, .. }
        | EvalShape::Coupler { od, .. }
        | EvalShape::CenteringRing { od, .. }
        | EvalShape::Bulkhead { od, .. }
        | EvalShape::EngineBlock { od, .. }
        | EvalShape::LaunchLug { od, .. }
        | EvalShape::RailButton { od, .. }
        | EvalShape::MassComponent { od, .. }
        | EvalShape::Tank { od, .. }
        | EvalShape::TubeFinSet { od, .. } => od / 2.0,
        _ => 0.0,
    }
}

/// Inner radius of a container (default outer radius of rings and bulkheads).
pub fn inner_radius(s: &EvalShape) -> f64 {
    match s {
        EvalShape::BodyTube { id, .. }
        | EvalShape::InnerTube { id, .. }
        | EvalShape::Coupler { id, .. } => id / 2.0,
        EvalShape::NoseCone { od, thickness, .. } => {
            if *thickness > 0.0 {
                od / 2.0 - thickness
            } else {
                0.0
            }
        }
        EvalShape::Transition {
            fore_od,
            aft_od,
            thickness,
            ..
        } => {
            if *thickness > 0.0 {
                fore_od.min(*aft_od) / 2.0 - thickness
            } else {
                0.0
            }
        }
        EvalShape::Tank { od, wall, .. } => od / 2.0 - wall,
        _ => 0.0,
    }
}

/// Every anchor of a shape. `parent_r` is the parent's outer radius at the
/// component's station; `cg_dx` is a CG override measured from the fore end.
pub fn anchors(s: &EvalShape, parent_r: f64, cg_dx: Option<f64>) -> Vec<RelAnchor> {
    let len = extent(s);
    match s {
        EvalShape::NoseCone {
            od,
            thickness,
            shoulder,
            length,
            ..
        } => {
            let mut v = vec![a("tip", 0.0, 0.0), a("base", *length, od / 2.0)];
            if let Some(sh) = shoulder {
                v.push(a("shoulder_fore", *length, sh.od / 2.0));
                v.push(a("shoulder_aft", length + sh.length, sh.od / 2.0));
            }
            if *thickness > 0.0 {
                v.push(a("inner", 0.0, od / 2.0 - thickness));
            }
            v
        }
        EvalShape::BodyTube { od, id, .. } | EvalShape::Coupler { od, id, .. } => vec![
            a("fore", 0.0, od / 2.0),
            a("aft", len, od / 2.0),
            a("mid", len / 2.0, od / 2.0),
            a("inner", 0.0, id / 2.0),
            a("outer", 0.0, od / 2.0),
        ],
        EvalShape::Transition {
            fore_od,
            aft_od,
            thickness,
            fore_shoulder,
            aft_shoulder,
            ..
        } => {
            let mut v = vec![a("fore", 0.0, fore_od / 2.0), a("aft", len, aft_od / 2.0)];
            if let Some(sh) = fore_shoulder {
                v.push(a("shoulder_fore", -sh.length, sh.od / 2.0));
            }
            if let Some(sh) = aft_shoulder {
                v.push(a("shoulder_aft", len + sh.length, sh.od / 2.0));
            }
            if *thickness > 0.0 {
                v.push(a("inner", 0.0, fore_od / 2.0 - thickness));
            }
            v
        }
        EvalShape::TrapezoidalFinSet {
            fins,
            root_chord,
            tip_chord,
            span,
            sweep,
        } => {
            let mut v = vec![
                a("root_le", 0.0, parent_r),
                a("root_te", *root_chord, parent_r),
                a("tip_le", *sweep, parent_r + span),
                a("tip_te", sweep + tip_chord, parent_r + span),
            ];
            fin_extras(
                &mut v,
                fins.tab.as_ref().map(|t| (t.offset, t.length)),
                fins.count,
                parent_r,
            );
            v
        }
        EvalShape::EllipticalFinSet {
            fins,
            root_chord,
            span,
        } => {
            let mut v = vec![
                a("root_le", 0.0, parent_r),
                a("root_te", *root_chord, parent_r),
                a("tip_le", root_chord / 2.0, parent_r + span),
                a("tip_te", root_chord / 2.0, parent_r + span),
            ];
            fin_extras(
                &mut v,
                fins.tab.as_ref().map(|t| (t.offset, t.length)),
                fins.count,
                parent_r,
            );
            v
        }
        EvalShape::FreeformFinSet { fins, points } => {
            // Aft-most root point (y = 0); a closing point back at the root
            // LE must not pull the TE forward.
            let root_te = points
                .iter()
                .filter(|p| p[1].abs() <= 1e-9)
                .map(|p| p[0])
                .reduce(f64::max)
                .unwrap_or_else(|| match (points.first(), points.last()) {
                    (Some(f), Some(l)) => f[0].max(l[0]),
                    _ => 0.0,
                });
            let mut v = vec![a("root_le", 0.0, parent_r), a("root_te", root_te, parent_r)];
            fin_extras(
                &mut v,
                fins.tab.as_ref().map(|t| (t.offset, t.length)),
                fins.count,
                parent_r,
            );
            v
        }
        EvalShape::TubeFinSet { count, od, .. } => {
            let r = parent_r + od / 2.0;
            let mut v = vec![a("fore", 0.0, r), a("aft", len, r)];
            v.extend((0..*count).map(|n| a(&format!("fin{n}"), 0.0, r)));
            v
        }
        EvalShape::InnerTube { od, id, .. } => vec![
            a("fore", 0.0, od / 2.0),
            a("aft", len, od / 2.0),
            a("motor_retainer", len, id / 2.0),
            a("inner", 0.0, id / 2.0),
            a("outer", 0.0, od / 2.0),
        ],
        EvalShape::CenteringRing { .. }
        | EvalShape::Bulkhead { .. }
        | EvalShape::EngineBlock { .. } => vec![a("fore", 0.0, 0.0), a("aft", len, 0.0)],
        EvalShape::LaunchLug { od, .. } => {
            let r = parent_r + od / 2.0;
            vec![a("fore", 0.0, r), a("aft", len, r), a("mid", len / 2.0, r)]
        }
        EvalShape::RailButton { height, .. } => vec![
            a("fore", 0.0, parent_r),
            a("aft", len, parent_r),
            a("mid", len / 2.0, parent_r),
            a("top", len / 2.0, parent_r + height),
        ],
        EvalShape::Parachute { .. } | EvalShape::Streamer { .. } | EvalShape::ShockCord { .. } => {
            vec![a("attach", 0.0, 0.0)]
        }
        EvalShape::MassComponent { .. } => vec![
            a("fore", 0.0, 0.0),
            a("aft", len, 0.0),
            a("cg", cg_dx.unwrap_or(len / 2.0), 0.0),
        ],
        EvalShape::Tank { od, wall, .. } => vec![
            a("fore", 0.0, 0.0),
            a("aft", len, 0.0),
            a("inner", 0.0, od / 2.0 - wall),
            a("outlet", len, 0.0),
        ],
    }
}

fn fin_extras(v: &mut Vec<RelAnchor>, tab: Option<(f64, f64)>, count: u32, r: f64) {
    if let Some((off, len)) = tab {
        v.push(a("tab_fore", off, r));
        v.push(a("tab_aft", off + len, r));
    }
    v.extend((0..count).map(|n| a(&format!("fin{n}"), 0.0, r)));
}

/// True when `name` is an anchor of the type (`fin<n>` matches any `fin0`, `fin1`, ...).
pub fn type_has_anchor(t: ComponentType, name: &str) -> bool {
    t.anchors().iter().any(|&x| {
        x == name
            || (x == "fin<n>"
                && name
                    .strip_prefix("fin")
                    .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())))
    })
}

fn start_anchor(t: ComponentType) -> &'static str {
    let has = |n| t.anchors().contains(&n);
    ["fore", "tip", "root_le", "attach"]
        .into_iter()
        .find(|n| has(n))
        .unwrap_or("fore")
}

fn end_anchor(t: ComponentType) -> &'static str {
    let has = |n| t.anchors().contains(&n);
    ["aft", "base", "root_te", "attach"]
        .into_iter()
        .find(|n| has(n))
        .unwrap_or("aft")
}

/// The default `at` for `attach.to = "<id>.<to>"`: the mirrored anchor. An
/// aft-facing parent anchor takes the child's fore end, a fore-facing one its
/// aft end, `mid` its `mid`, and anything else (`inner`, `outer`, ...) its fore end.
pub fn default_at(to: &str, child: ComponentType) -> &'static str {
    match to {
        "aft" | "base" | "shoulder_aft" | "motor_retainer" | "root_te" | "tip_te" | "tab_aft"
        | "outlet" => start_anchor(child),
        "fore" | "tip" | "shoulder_fore" | "root_le" | "tip_le" | "tab_fore" => end_anchor(child),
        "mid" if child.anchors().contains(&"mid") => "mid",
        _ => start_anchor(child),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{EvalFinCommon, FinCrossSection};

    #[test]
    fn mirrored_defaults() {
        assert_eq!(default_at("aft", ComponentType::BodyTube), "fore");
        assert_eq!(default_at("base", ComponentType::BodyTube), "fore");
        assert_eq!(default_at("fore", ComponentType::Transition), "aft");
        assert_eq!(
            default_at("aft", ComponentType::TrapezoidalFinSet),
            "root_le"
        );
        assert_eq!(
            default_at("fore", ComponentType::TrapezoidalFinSet),
            "root_te"
        );
        assert_eq!(default_at("inner", ComponentType::Parachute), "attach");
        assert_eq!(default_at("mid", ComponentType::Coupler), "mid");
        assert_eq!(default_at("mid", ComponentType::CenteringRing), "fore");
    }

    #[test]
    fn per_fin_anchor_names() {
        assert!(type_has_anchor(ComponentType::TrapezoidalFinSet, "fin3"));
        assert!(!type_has_anchor(ComponentType::TrapezoidalFinSet, "fin"));
        assert!(!type_has_anchor(ComponentType::BodyTube, "fin0"));
    }

    #[test]
    fn trapezoid_anchor_stations() {
        let s = EvalShape::TrapezoidalFinSet {
            fins: EvalFinCommon {
                count: 3,
                thickness: 0.003,
                cross_section: FinCrossSection::Square,
                cant: 0.0,
                fillet_radius: 0.0,
                tab: None,
            },
            root_chord: 0.14,
            tip_chord: 0.06,
            span: 0.09,
            sweep: 0.045,
        };
        let v = anchors(&s, 0.027, None);
        let find = |n: &str| v.iter().find(|x| x.name == n).unwrap();
        assert_eq!(find("root_te").dx, 0.14);
        assert!((find("tip_te").dx - 0.105).abs() < 1e-15);
        assert!((find("tip_le").r - 0.117).abs() < 1e-15);
        assert!(v.iter().any(|x| x.name == "fin2") && !v.iter().any(|x| x.name == "fin3"));
        assert_eq!(extent(&s), 0.14);
    }

    #[test]
    fn lug_and_button_mid_and_top() {
        let lug = EvalShape::LaunchLug {
            length: 0.04,
            od: 0.006,
            id: 0.005,
        };
        let v = anchors(&lug, 0.0125, None);
        let mid = v.iter().find(|x| x.name == "mid").unwrap();
        assert_eq!(mid.dx, 0.02);
        assert!((mid.r - 0.0155).abs() < 1e-15);
        assert!(type_has_anchor(ComponentType::LaunchLug, "mid"));

        let button = EvalShape::RailButton {
            od: 0.01,
            id: 0.004,
            height: 0.008,
            base_height: 0.002,
            flange_height: 0.002,
        };
        let v = anchors(&button, 0.0125, None);
        let find = |n: &str| v.iter().find(|x| x.name == n).unwrap();
        assert_eq!((find("mid").dx, find("mid").r), (0.005, 0.0125));
        assert_eq!(find("top").dx, 0.005);
        assert!((find("top").r - 0.0205).abs() < 1e-15);
        assert_eq!(find("top").kind, crate::types::AnchorKind::Surface);
        assert!(type_has_anchor(ComponentType::RailButton, "top"));
        assert!(type_has_anchor(ComponentType::RailButton, "mid"));
        // A body's `mid` now mirrors onto the lug's `mid` (centred on it).
        assert_eq!(default_at("mid", ComponentType::LaunchLug), "mid");
    }

    #[test]
    fn freeform_root_te_ignores_closing_point() {
        let s = EvalShape::FreeformFinSet {
            fins: EvalFinCommon {
                count: 3,
                thickness: 0.002,
                cross_section: FinCrossSection::Square,
                cant: 0.0,
                fillet_radius: 0.0,
                tab: None,
            },
            points: vec![[0.0, 0.0], [0.03, 0.04], [0.08, 0.0], [0.0, 0.0]],
        };
        let v = anchors(&s, 0.0125, None);
        assert_eq!(v.iter().find(|x| x.name == "root_te").unwrap().dx, 0.08);
    }

    #[test]
    fn attach_to_lug_mid_and_button_top() {
        use crate::components::testutil::{assert_clean, comp, on_body};
        let m = on_body(
            r#"
[c.lug]
type = "launch_lug"
attach = { to = "body.fore", at = "fore", offset = "100 mm" }
length = "40 mm"
od = "6 mm"
thickness = "0.5 mm"

[c.w]
type = "mass_component"
attach = { to = "lug.mid", at = "fore" }
mass = "5 g"
length = "10 mm"
od = "10 mm"

[c.rb]
type = "rail_button"
attach = { to = "body.fore", at = "fore", offset = "200 mm" }
od = "10 mm"
id = "4 mm"
height = "8 mm"

[c.lug2]
type = "launch_lug"
attach = { to = "body.mid" }
length = "40 mm"
od = "6 mm"
thickness = "0.5 mm"
"#,
        );
        assert_clean(&m);
        let w = comp(&m, "w");
        assert!((w.x_fore - 0.12).abs() < 1e-12, "{}", w.x_fore);
        assert_eq!(w.parent.as_deref(), Some("body"));
        let rb = comp(&m, "rb");
        let top = rb.anchors.iter().find(|a| a.name == "top").unwrap();
        assert!((top.r - (0.0125 + 0.008)).abs() < 1e-12, "{}", top.r);
        // body.mid (150 mm) mirrors onto lug2.mid: the lug is centred there.
        let lug2 = comp(&m, "lug2");
        assert!((lug2.x_fore - 0.13).abs() < 1e-12, "{}", lug2.x_fore);
    }
}
