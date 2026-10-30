//! Clearance rules and interference between parts.
//!
//! Every clearance row reads "`actual` must be at least `required`" in SI of
//! `dim`: fit rules compare the receiving bore (`actual`) with the inserted
//! diameter (`required`); `fin_tab_wall` compares the radial room under the
//! wall with the tab height; `fin_across_joint` compares the length of the
//! fin root that lies on its tube with the root chord; `recovery_volume`
//! compares the bay volume with the packed volume of everything in the bay.
//!
//! Interference treats internal parts as concentric annuli `[r_in, r_out]`
//! over `[x_fore, x_aft]` (off-axis or instanced parts are skipped).

use std::collections::BTreeMap;
use std::f64::consts::PI;

use rw_geom::Geometry;
use rw_model::{AnchorKind, Diagnostic, EvalComponent, EvalShape, EvaluatedModel};
use rw_units::DimKind;

use crate::diag::{self, diag};
use crate::dims::{bore, is_fin_set, packed};
use crate::motor::FIT_TOL;
use crate::{Clearance, ClearanceRule, Interference, InterferenceKind};

/// Axial overlap below this is a glue line, not interference (0.1 mm):
/// imported designs often place parts a few hundredths of a millimetre
/// into each other through inch rounding.
const OVERLAP_TOL: f64 = 1e-4;

/// A part inside a tube: an annulus over an axial range.
#[derive(Debug, Clone)]
struct Occupant<'a> {
    id: &'a str,
    x0: f64,
    x1: f64,
    r_in: f64,
    r_out: f64,
    /// Closes the bore (bounds a recovery bay).
    bounding: bool,
    recovery: bool,
    /// Lives in the tube as a child (not an inserted shoulder).
    child: bool,
    /// A motor-mount tube: it may stick out of the aft end of the airframe.
    motor_mount: bool,
}

fn occupant(c: &EvalComponent) -> Option<Occupant<'_>> {
    let instanced = c.instances.len() > 1
        || c.instances
            .iter()
            .any(|i| i.offset[1].abs() > FIT_TOL || i.offset[2].abs() > FIT_TOL);
    if c.radial.abs() > FIT_TOL || instanced {
        return None;
    }
    let (r_in, r_out, bounding, recovery) = match c.shape {
        EvalShape::CenteringRing { od, id, .. } => (0.5 * id, 0.5 * od, true, false),
        EvalShape::Bulkhead { od, .. } => (0.0, 0.5 * od, true, false),
        EvalShape::EngineBlock { od, id, .. } => (0.5 * id, 0.5 * od, true, false),
        EvalShape::InnerTube { od, id, .. } => (0.5 * id, 0.5 * od, true, false),
        EvalShape::Coupler { od, id, .. } => (0.5 * id, 0.5 * od, false, false),
        EvalShape::MassComponent { od, .. } | EvalShape::Tank { od, .. } => {
            (0.0, 0.5 * od, false, false)
        }
        _ => match packed(&c.shape) {
            Some((d, _)) => (0.0, 0.5 * d, false, true),
            None => return None,
        },
    };
    Some(Occupant {
        id: &c.id,
        x0: c.x_fore,
        x1: c.x_aft,
        r_in,
        r_out,
        bounding,
        recovery,
        child: true,
        motor_mount: matches!(
            c.shape,
            EvalShape::InnerTube {
                motor_mount: true,
                ..
            }
        ),
    })
}

/// Shoulders of the neighbouring nose cones and transitions that insert
/// into `tube` (an axial body tube), as `(owner, x0, x1, od, thickness, capped)`.
fn shoulders_into<'a>(
    model: &'a EvaluatedModel,
    tube: &EvalComponent,
) -> Vec<(&'a str, f64, f64, f64, f64, bool)> {
    let near = |a: f64, b: f64| (a - b).abs() < 1e-6;
    let mut out = Vec::new();
    for c in &model.components {
        if c.containment != AnchorKind::Axial || c.id == tube.id {
            continue;
        }
        match &c.shape {
            EvalShape::NoseCone {
                shoulder: Some(s), ..
            } if near(c.x_aft, tube.x_fore) && s.length > 0.0 => out.push((
                c.id.as_str(),
                c.x_aft,
                c.x_aft + s.length,
                s.od,
                s.thickness,
                s.capped,
            )),
            EvalShape::Transition {
                fore_shoulder,
                aft_shoulder,
                ..
            } => {
                if let Some(s) = aft_shoulder
                    && near(c.x_aft, tube.x_fore)
                    && s.length > 0.0
                {
                    out.push((
                        c.id.as_str(),
                        c.x_aft,
                        c.x_aft + s.length,
                        s.od,
                        s.thickness,
                        s.capped,
                    ));
                }
                if let Some(s) = fore_shoulder
                    && near(c.x_fore, tube.x_aft)
                    && s.length > 0.0
                {
                    out.push((
                        c.id.as_str(),
                        c.x_fore - s.length,
                        c.x_fore,
                        s.od,
                        s.thickness,
                        s.capped,
                    ));
                }
            }
            _ => {}
        }
    }
    out
}

fn overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    a1.min(b1) - a0.max(b0)
}

/// Results of the clearance and interference pass.
pub(crate) struct Findings {
    pub clearance: Vec<Clearance>,
    pub interference: Vec<Interference>,
    pub diagnostics: Vec<Diagnostic>,
}

fn row(
    rule: ClearanceRule,
    a: &str,
    b: &str,
    required: f64,
    actual: f64,
    dim: DimKind,
) -> Clearance {
    let tol = if dim == DimKind::Volume { 0.0 } else { FIT_TOL };
    Clearance {
        rule,
        a: a.to_string(),
        b: Some(b.to_string()),
        required,
        actual,
        dim,
        pass: actual >= required - tol,
    }
}

fn mm(v: f64) -> f64 {
    v * 1e3
}

/// Coupler, ring, fin-tab, fin-joint, and recovery-volume rules plus
/// overlap and protrusion of internal parts.
pub(crate) fn check(model: &EvaluatedModel, geometry: &Geometry) -> Findings {
    let mut f = Findings {
        clearance: Vec::new(),
        interference: Vec::new(),
        diagnostics: Vec::new(),
    };
    let by_id: BTreeMap<&str, &EvalComponent> = model
        .components
        .iter()
        .map(|c| (c.id.as_str(), c))
        .collect();
    let mut children: BTreeMap<&str, Vec<&EvalComponent>> = BTreeMap::new();
    for c in &model.components {
        if let Some(p) = c.parent.as_deref() {
            children.entry(p).or_default().push(c);
        }
    }

    // Shoulders into body tubes (coupler fit).
    for tube in &model.components {
        let Some(id) = bore(&tube.shape) else {
            continue;
        };
        if !matches!(tube.shape, EvalShape::BodyTube { .. }) {
            continue;
        }
        for (owner, _, _, od, _, _) in shoulders_into(model, tube) {
            let r = row(
                ClearanceRule::CouplerFit,
                owner,
                &tube.id,
                od,
                id,
                DimKind::Length,
            );
            if !r.pass {
                f.diagnostics.push(diag(
                    diag::E_COUPLER_FIT,
                    Some(format!("/c/{owner}/shoulder/od")),
                    format!(
                        "The shoulder of `{owner}` is {:.2} mm wide but `{}` has a {:.2} mm bore",
                        mm(od),
                        tube.id,
                        mm(id)
                    ),
                    format!("Set c.{owner}.shoulder.od to at most {:.2} mm.", mm(id)),
                ));
            }
            f.clearance.push(r);
        }
    }

    for c in &model.components {
        let parent = c.parent.as_deref().and_then(|p| by_id.get(p).copied());
        match c.shape {
            EvalShape::Coupler { od, .. } => {
                if let Some(p) = parent
                    && let Some(id) = bore(&p.shape)
                {
                    let r = row(
                        ClearanceRule::CouplerFit,
                        &c.id,
                        &p.id,
                        od,
                        id,
                        DimKind::Length,
                    );
                    if !r.pass {
                        f.diagnostics.push(diag(
                            diag::E_COUPLER_FIT,
                            Some(format!("/c/{}/od", c.id)),
                            format!(
                                "Coupler `{}` is {:.2} mm wide but `{}` has a {:.2} mm bore",
                                c.id,
                                mm(od),
                                p.id,
                                mm(id)
                            ),
                            format!("Set c.{}.od to at most {:.2} mm.", c.id, mm(id)),
                        ));
                    }
                    f.clearance.push(r);
                }
            }
            EvalShape::CenteringRing {
                od, id: ring_id, ..
            } => {
                if let Some(p) = parent
                    && let Some(id) = bore(&p.shape)
                {
                    let r = row(
                        ClearanceRule::CenteringRingFit,
                        &c.id,
                        &p.id,
                        od,
                        id,
                        DimKind::Length,
                    );
                    if !r.pass {
                        f.diagnostics.push(diag(
                            diag::E_RING_FIT,
                            Some(format!("/c/{}/od", c.id)),
                            format!(
                                "Centering ring `{}` is {:.2} mm wide but `{}` has a {:.2} mm bore",
                                c.id,
                                mm(od),
                                p.id,
                                mm(id)
                            ),
                            format!("Set c.{}.od to at most {:.2} mm.", c.id, mm(id)),
                        ));
                    }
                    f.clearance.push(r);
                    for t in children.get(p.id.as_str()).into_iter().flatten() {
                        let EvalShape::InnerTube { od: t_od, .. } = t.shape else {
                            continue;
                        };
                        if overlap(c.x_fore, c.x_aft, t.x_fore, t.x_aft) <= FIT_TOL {
                            continue;
                        }
                        let r = row(
                            ClearanceRule::CenteringRingFit,
                            &t.id,
                            &c.id,
                            t_od,
                            ring_id,
                            DimKind::Length,
                        );
                        if !r.pass {
                            f.diagnostics.push(diag(
                                diag::E_RING_FIT,
                                Some(format!("/c/{}/id", c.id)),
                                format!(
                                    "Centering ring `{}` has a {:.2} mm bore but tube `{}` is {:.2} mm wide",
                                    c.id,
                                    mm(ring_id),
                                    t.id,
                                    mm(t_od)
                                ),
                                format!("Set c.{}.id to at least {:.2} mm.", c.id, mm(t_od)),
                            ));
                        }
                        f.clearance.push(r);
                    }
                }
            }
            _ => {}
        }
        if is_fin_set(c)
            && let Some(p) = parent
        {
            fin_rules(c, p, geometry, children.get(p.id.as_str()), &mut f);
        }
    }

    // Overlap, protrusion, and recovery bays per tube.
    for tube in &model.components {
        let Some(bore_d) = bore(&tube.shape) else {
            continue;
        };
        let r_bore = 0.5 * bore_d;
        let mut occ: Vec<Occupant<'_>> = children
            .get(tube.id.as_str())
            .into_iter()
            .flatten()
            .filter(|c| c.containment == AnchorKind::Inner)
            .filter_map(|c| occupant(c))
            .collect();
        if matches!(tube.shape, EvalShape::BodyTube { .. }) {
            for (owner, x0, x1, od, t, capped) in shoulders_into(model, tube) {
                occ.push(Occupant {
                    id: owner,
                    x0,
                    x1,
                    r_in: if capped || t <= 0.0 {
                        0.0
                    } else {
                        (0.5 * od - t).max(0.0)
                    },
                    r_out: 0.5 * od,
                    bounding: capped,
                    recovery: false,
                    child: false,
                    motor_mount: false,
                });
            }
        }
        // Nothing in the outer stack continues aft of this tube.
        let airframe_aft = !model.components.iter().any(|c| {
            c.containment == AnchorKind::Axial
                && c.id != tube.id
                && c.x_aft > tube.x_aft + FIT_TOL
                && c.x_fore >= tube.x_aft - FIT_TOL
        });
        for o in occ.iter().filter(|o| o.child) {
            let mut fore = tube.x_fore - o.x0;
            let mut aft = o.x1 - tube.x_aft;
            // A part that continues past the end into a coaxial tube it fits
            // (a coupler across a joint, a bulkhead at a coupler's end inside
            // the airframe) stays inside a bore: not a protrusion.
            if (fore > FIT_TOL || aft > FIT_TOL) && within_bores(model, o) {
                fore = 0.0;
                aft = 0.0;
            }
            // A motor mount sticking out of the aft end of the airframe is a
            // normal build (the motor hook / retainer sits on it).
            if o.motor_mount && airframe_aft {
                aft = 0.0;
            }
            if fore > FIT_TOL || aft > FIT_TOL {
                let (depth, station) = if fore >= aft {
                    (fore, o.x0)
                } else {
                    (aft, o.x1)
                };
                push_protrusion(&mut f, o.id, &tube.id, depth, station, "past the end of");
            }
            let radial = o.r_out - r_bore;
            let alongside = overlap(o.x0, o.x1, tube.x_fore, tube.x_aft) > FIT_TOL;
            if radial > FIT_TOL && !o.recovery && alongside {
                push_protrusion(&mut f, o.id, &tube.id, radial, o.x0, "through the wall of");
            }
        }
        for i in 0..occ.len() {
            for j in i + 1..occ.len() {
                let (a, b) = (&occ[i], &occ[j]);
                if a.recovery && b.recovery {
                    continue;
                }
                let ax = overlap(a.x0, a.x1, b.x0, b.x1);
                let rad = overlap(a.r_in, a.r_out, b.r_in, b.r_out);
                if ax > OVERLAP_TOL && rad > FIT_TOL {
                    let station = a.x0.max(b.x0);
                    f.diagnostics.push(diag(
                        diag::E_OVERLAP,
                        Some(format!("/c/{}", b.id)),
                        format!(
                            "`{}` and `{}` overlap by {:.1} mm at station {:.1} mm",
                            a.id,
                            b.id,
                            mm(ax),
                            mm(station)
                        ),
                        format!(
                            "Move `{}` with attach.offset, or shorten one of them by {:.1} mm.",
                            b.id,
                            mm(ax)
                        ),
                    ));
                    f.interference.push(Interference {
                        a: a.id.to_string(),
                        b: b.id.to_string(),
                        kind: InterferenceKind::Overlap,
                        depth: ax,
                        station,
                    });
                }
            }
        }
        recovery_bays(tube, r_bore, &occ, &mut f);
    }
    f
}

/// True when every station of `o` lies inside the bore of some coaxial
/// tube (body, inner tube, or coupler) that `o` fits.
fn within_bores(model: &EvaluatedModel, o: &Occupant<'_>) -> bool {
    let mut spans: Vec<(f64, f64)> = model
        .components
        .iter()
        .filter(|c| c.id != o.id && c.radial.abs() <= FIT_TOL)
        .filter(|c| {
            c.instances.len() <= 1
                && c.instances
                    .iter()
                    .all(|i| i.offset[1].abs() <= FIT_TOL && i.offset[2].abs() <= FIT_TOL)
        })
        .filter(|c| bore(&c.shape).is_some_and(|d| 0.5 * d >= o.r_out - FIT_TOL))
        .map(|c| (c.x_fore, c.x_aft))
        .collect();
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut covered = o.x0;
    for (a, b) in spans {
        if a > covered + FIT_TOL {
            break;
        }
        covered = covered.max(b);
        if covered >= o.x1 - FIT_TOL {
            return true;
        }
    }
    covered >= o.x1 - FIT_TOL
}

fn push_protrusion(f: &mut Findings, a: &str, b: &str, depth: f64, station: f64, how: &str) {
    f.diagnostics.push(diag(
        diag::E_PROTRUSION,
        Some(format!("/c/{a}")),
        format!("`{a}` sticks {:.1} mm {how} `{b}`", mm(depth)),
        format!(
            "Shrink or move `{a}` by {:.1} mm so it stays inside `{b}`.",
            mm(depth)
        ),
    ));
    f.interference.push(Interference {
        a: a.to_string(),
        b: b.to_string(),
        kind: InterferenceKind::Protrusion,
        depth,
        station,
    });
}

/// Root chord of a planar fin set (root LE to root TE).
fn root_chord(shape: &EvalShape) -> Option<f64> {
    match shape {
        EvalShape::TrapezoidalFinSet { root_chord, .. }
        | EvalShape::EllipticalFinSet { root_chord, .. } => Some(*root_chord),
        EvalShape::FreeformFinSet { points, .. } => match (points.first(), points.last()) {
            (Some(f), Some(l)) => Some(f[0].max(l[0])),
            _ => None,
        },
        _ => None,
    }
}

/// Fin tab vs the wall and inner tube, and the fin root vs its tube's ends.
fn fin_rules(
    fins: &EvalComponent,
    tube: &EvalComponent,
    geometry: &Geometry,
    siblings: Option<&Vec<&EvalComponent>>,
    f: &mut Findings,
) {
    let (od, id) = match tube.shape {
        EvalShape::BodyTube { od, id, .. } => (od, id),
        _ => return,
    };
    // The root chord runs aft from the root LE (`x_fore`); a swept tip may
    // overhang the end of the tube.
    let root = root_chord(&fins.shape).unwrap_or(fins.x_aft - fins.x_fore);
    let root_aft = fins.x_fore + root;
    let on_tube = overlap(fins.x_fore, root_aft, tube.x_fore, tube.x_aft).max(0.0);
    let r = row(
        ClearanceRule::FinAcrossJoint,
        &fins.id,
        &tube.id,
        root,
        on_tube,
        DimKind::Length,
    );
    if !r.pass {
        let station = if root_aft > tube.x_aft + FIT_TOL {
            tube.x_aft
        } else {
            tube.x_fore
        };
        f.diagnostics.push(diag(
            diag::E_FIN_JOINT,
            Some(format!("/c/{}/root_chord", fins.id)),
            format!(
                "Fin set `{}` runs {:.1} mm past the end of `{}`",
                fins.id,
                mm(root - on_tube),
                tube.id
            ),
            format!(
                "Shorten the root chord by {:.1} mm or move the fins with attach.offset.",
                mm(root - on_tube)
            ),
        ));
        f.interference.push(Interference {
            a: fins.id.clone(),
            b: tube.id.clone(),
            kind: InterferenceKind::FinThroughJoint,
            depth: root - on_tube,
            station,
        });
    }
    f.clearance.push(r);

    let Some(tab) = geometry
        .components
        .iter()
        .find(|g| g.id == fins.id)
        .and_then(|g| g.fins.as_ref())
        .and_then(|g| g.tab.as_ref())
    else {
        return;
    };
    if tab.is_empty() {
        return;
    }
    let height = -tab.iter().map(|p| p[1]).fold(0.0, f64::min);
    let x0 = tab.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min);
    let x1 = tab.iter().map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max);
    if height <= 0.0 {
        return;
    }
    let r_outer = 0.5 * od;
    let inner = siblings
        .into_iter()
        .flatten()
        .filter(|s| overlap(s.x_fore, s.x_aft, x0, x1) > FIT_TOL)
        .filter_map(|s| match s.shape {
            EvalShape::InnerTube { od, .. } | EvalShape::Coupler { od, .. } => {
                Some((s.id.as_str(), 0.5 * od))
            }
            _ => None,
        })
        .max_by(|a, b| a.1.total_cmp(&b.1));
    let (b, room) = match inner {
        Some((sid, r)) => (sid, r_outer - r),
        None => (tube.id.as_str(), r_outer),
    };
    let r = row(
        ClearanceRule::FinTabWall,
        &fins.id,
        b,
        height,
        room,
        DimKind::Length,
    );
    if !r.pass {
        f.diagnostics.push(diag(
            diag::E_FIN_TAB,
            Some(format!("/c/{}/tab/height", fins.id)),
            format!(
                "Fin tab of `{}` is {:.2} mm deep but there is {:.2} mm to `{b}`",
                fins.id,
                mm(height),
                mm(room)
            ),
            format!(
                "Set c.{}.tab.height to at most {:.2} mm.",
                fins.id,
                mm(room)
            ),
        ));
    }
    f.clearance.push(r);
    let wall = 0.5 * (od - id);
    if height + FIT_TOL < wall {
        f.diagnostics.push(diag(
            diag::W_FIN_TAB_SHORT,
            Some(format!("/c/{}/tab/height", fins.id)),
            format!(
                "Fin tab of `{}` is {:.2} mm deep, less than the {:.2} mm wall of `{}`",
                fins.id,
                mm(height),
                mm(wall),
                tube.id
            ),
            format!(
                "Set c.{}.tab.height to at least {:.2} mm.",
                fins.id,
                mm(wall)
            ),
        ));
    }
}

/// One `recovery_volume` row per recovery item: the packed volume of every
/// recovery item in its bay against the bay's free volume. A bay runs
/// between the nearest bore-closing parts (bulkheads, rings, inner tubes,
/// engine blocks, capped shoulders) fore and aft of the item; parts that do
/// not close the bore (mass components, couplers, open shoulders) take
/// their own volume out of it.
fn recovery_bays(tube: &EvalComponent, r_bore: f64, occ: &[Occupant<'_>], f: &mut Findings) {
    let bay = |xc: f64| {
        let fore = occ
            .iter()
            .filter(|o| o.bounding && o.x1 <= xc + FIT_TOL)
            .map(|o| o.x1)
            .fold(tube.x_fore, f64::max);
        let aft = occ
            .iter()
            .filter(|o| o.bounding && o.x0 >= xc - FIT_TOL)
            .map(|o| o.x0)
            .fold(tube.x_aft, f64::min);
        (fore, aft)
    };
    for item in occ.iter().filter(|o| o.recovery) {
        let (x0, x1) = bay(0.5 * (item.x0 + item.x1));
        let len = (x1 - x0).max(0.0);
        let solid: f64 = occ
            .iter()
            .filter(|o| !o.bounding && !o.recovery)
            .map(|o| {
                PI * (o.r_out * o.r_out - o.r_in * o.r_in) * overlap(o.x0, o.x1, x0, x1).max(0.0)
            })
            .sum();
        let actual = (PI * r_bore * r_bore * len - solid).max(0.0);
        let required: f64 = occ
            .iter()
            .filter(|o| o.recovery)
            .filter(|o| {
                let c = 0.5 * (o.x0 + o.x1);
                c >= x0 - FIT_TOL && c <= x1 + FIT_TOL
            })
            .map(|o| PI * o.r_out * o.r_out * (o.x1 - o.x0))
            .sum();
        let r = row(
            ClearanceRule::RecoveryVolume,
            item.id,
            &tube.id,
            required,
            actual,
            DimKind::Volume,
        );
        if !r.pass {
            f.diagnostics.push(diag(
                diag::E_RECOVERY_VOLUME,
                Some(format!("/c/{}", item.id)),
                format!(
                    "The recovery bay of `{}` holds {:.0} cm³ but its contents pack to {:.0} cm³",
                    tube.id,
                    actual * 1e6,
                    required * 1e6
                ),
                format!(
                    "Lengthen `{}` by {:.0} mm, or reduce the packed size of `{}`.",
                    tube.id,
                    mm((required - actual) / (PI * r_bore * r_bore).max(1e-12)),
                    item.id
                ),
            ));
        }
        f.clearance.push(r);
    }
}
