//! Source fields → SI values, and component kinds → [`EvalShape`].
//!
//! [`Fields`] evaluates every dimensional field: a literal through `rw-units`
//! (`RW-E020`-`E023`), an `=` expression through [`crate::expr`] with a
//! dimension check (`RW-E04x`). A failed field reports one diagnostic at its
//! JSON pointer and evaluates to 0 so the rest of the model still evaluates.
//!
//! Defaults kept here are geometric only (ring/bulkhead OD from the parent's
//! bore, tube ID from wall thickness). Material, finish, and per-kind
//! validation live in [`crate::components`] (M1.24).

use rw_units::{DimKind, Qty, QtyRaw, UnitDim};

use crate::diag::Diagnostic;
use crate::expr::{Scope, expect_dim, is_expr};
use crate::types::{
    Component, ComponentKind, EndCap, EvalFinCommon, EvalFinTab, EvalShape, EvalShoulder,
    FinCrossSection, FinTab, NoseShape, Shoulder,
};

/// Evaluates source fields against a model value.
pub struct Fields<'a> {
    pub scope: Scope<'a>,
    pub diags: Vec<Diagnostic>,
}

/// `c.fins.tab.height` → `/c/fins/tab/height`.
pub fn ref_to_pointer(r: &str) -> String {
    format!("/{}", r.replace('.', "/"))
}

impl<'a> Fields<'a> {
    pub fn new(scope: Scope<'a>) -> Self {
        Fields {
            scope,
            diags: Vec::new(),
        }
    }

    /// Evaluates one field. `refpath` (`c.fins.span`) lets expressions be
    /// memoized and cycle-checked with the refs that read the same field;
    /// pass `None` for fields refs cannot address (configs, sims, arrays).
    pub fn q<D: UnitDim>(&mut self, q: &Qty<D>, refpath: Option<&str>, ptr: &str) -> f64 {
        match &q.raw {
            QtyRaw::Text(s) if is_expr(s) => {
                let r = match refpath {
                    Some(p) => self.scope.value_of(p),
                    None => self.scope.eval_str(s),
                };
                match r.and_then(|v| expect_dim(v, D::KIND)) {
                    Ok(v) => v,
                    Err(e) => {
                        let mut d = Diagnostic::new(e.kind.code(), ptr.to_string(), e.message);
                        d.hint = e.hint;
                        self.diags.push(d);
                        0.0
                    }
                }
            }
            _ => match q.literal() {
                Ok(Some(v)) => v.value,
                Ok(None) => 0.0,
                Err(e) => {
                    let hint = match D::KIND {
                        DimKind::Dimensionless => "write a number".to_string(),
                        k => format!("write a value with a unit, e.g. \"1 {}\"", k.si_unit()),
                    };
                    self.diags.push(
                        Diagnostic::new(e.code(), ptr.to_string(), e.to_string()).with_hint(hint),
                    );
                    0.0
                }
            },
        }
    }

    /// A field addressed by its ref path (`c.<id>.<field>`).
    pub fn at<D: UnitDim>(&mut self, q: &Qty<D>, refpath: &str) -> f64 {
        self.q(q, Some(refpath), &ref_to_pointer(refpath))
    }

    /// An optional field with a default.
    pub fn opt<D: UnitDim>(&mut self, q: Option<&Qty<D>>, refpath: &str, default: f64) -> f64 {
        q.map_or(default, |q| self.at(q, refpath))
    }
}

/// What a shape needs from its parent.
#[derive(Debug, Clone, Copy, Default)]
pub struct ParentInfo {
    /// Bore radius of the parent (default outer radius of rings and bulkheads).
    pub inner_r: f64,
}

/// The default shape parameter per profile (ogive: tangent, power: ½, Haack: C = 0).
pub fn default_shape_param(s: NoseShape) -> f64 {
    match s {
        NoseShape::Ogive | NoseShape::Parabolic => 1.0,
        NoseShape::Power => 0.5,
        NoseShape::Conical | NoseShape::Ellipsoid | NoseShape::Haack => 0.0,
    }
}

fn bore(
    f: &mut Fields,
    base: &str,
    od: f64,
    id: Option<&Qty<rw_units::markers::Length>>,
    t: Option<&Qty<rw_units::markers::Length>>,
) -> f64 {
    if let Some(id) = id {
        return f.at(id, &format!("{base}.id"));
    }
    if let Some(t) = t {
        return od - 2.0 * f.at(t, &format!("{base}.thickness"));
    }
    od
}

fn shoulder(f: &mut Fields, base: &str, s: Option<&Shoulder>, wall: f64) -> Option<EvalShoulder> {
    s.map(|s| EvalShoulder {
        length: f.at(&s.length, &format!("{base}.length")),
        od: f.at(&s.od, &format!("{base}.od")),
        thickness: f.opt(s.thickness.as_ref(), &format!("{base}.thickness"), wall),
        capped: s.capped,
    })
}

fn tab(f: &mut Fields, base: &str, t: Option<&FinTab>) -> Option<EvalFinTab> {
    t.map(|t| EvalFinTab {
        height: f.at(&t.height, &format!("{base}.tab.height")),
        length: f.at(&t.length, &format!("{base}.tab.length")),
        offset: f.opt(t.offset.as_ref(), &format!("{base}.tab.offset"), 0.0),
    })
}

#[allow(clippy::too_many_arguments)]
fn fin_common(
    f: &mut Fields,
    base: &str,
    count: u32,
    thickness: &Qty<rw_units::markers::Length>,
    cross: Option<FinCrossSection>,
    cant: Option<&Qty<rw_units::markers::Angle>>,
    t: Option<&FinTab>,
    fillet: Option<&Qty<rw_units::markers::Length>>,
) -> EvalFinCommon {
    EvalFinCommon {
        count,
        thickness: f.at(thickness, &format!("{base}.thickness")),
        cross_section: cross.unwrap_or(FinCrossSection::Square),
        cant: f.opt(cant, &format!("{base}.cant"), 0.0),
        fillet_radius: f.opt(fillet, &format!("{base}.fillet_radius"), 0.0),
        tab: tab(f, base, t),
    }
}

/// Inner volume of a tank: a cylinder closed by two end caps of the given shape.
pub fn tank_volume(length: f64, od: f64, wall: f64, cap: EndCap) -> f64 {
    let r = (od / 2.0 - wall).max(0.0);
    let inner_len = (length - 2.0 * wall).max(0.0);
    let pi = std::f64::consts::PI;
    // Cap depth and volume of one cap (sphere / 2:1 ellipsoid head).
    let (depth, cap_v) = match cap {
        EndCap::Flat => (0.0, 0.0),
        EndCap::Hemispherical => (r, 2.0 / 3.0 * pi * r.powi(3)),
        EndCap::Ellipsoidal => (r / 2.0, 2.0 / 3.0 * pi * r * r * (r / 2.0)),
    };
    let cyl = (inner_len - 2.0 * depth).max(0.0);
    pi * r * r * cyl + 2.0 * cap_v
}

/// Loaded propellant mass of a tank: m = ρ V_fill, with V_fill the `volume`
/// given, else `fraction` × the internal volume (clamped to the cavity; out of
/// range fills are reported by the tank rules), and ρ the liquid's reference
/// density ([`crate::fluids`]). An unknown propellant loads no mass.
/// cite: n/a m = ρ V (definition of density; ρ from the NIST WebBook table)
pub fn tank_propellant_mass(
    propellant: &str,
    internal: f64,
    fraction: Option<f64>,
    volume: Option<f64>,
) -> f64 {
    let Some(rho) = crate::fluids::liquid(propellant).map(|l| l.density) else {
        return 0.0;
    };
    let v = volume.or(fraction.map(|x| x * internal)).unwrap_or(0.0);
    rho * v.clamp(0.0, internal.max(0.0))
}

/// Evaluates a component's shape parameters in SI.
pub fn eval_shape(id: &str, c: &Component, f: &mut Fields, parent: ParentInfo) -> EvalShape {
    let b = format!("c.{id}");
    let p = |n: &str| format!("{b}.{n}");
    match &c.kind {
        ComponentKind::NoseCone(n) => {
            let thickness = f.opt(n.thickness.as_ref(), &p("thickness"), 0.0);
            EvalShape::NoseCone {
                shape: n.shape,
                shape_param: f.opt(
                    n.shape_param.as_ref(),
                    &p("shape_param"),
                    default_shape_param(n.shape),
                ),
                length: f.at(&n.length, &p("length")),
                od: f.at(&n.od, &p("od")),
                thickness,
                shoulder: shoulder(f, &p("shoulder"), n.shoulder.as_ref(), thickness),
            }
        }
        ComponentKind::BodyTube(t) => {
            let od = f.at(&t.od, &p("od"));
            EvalShape::BodyTube {
                length: f.at(&t.length, &p("length")),
                od,
                id: bore(f, &b, od, t.id.as_ref(), t.thickness.as_ref()),
            }
        }
        ComponentKind::Transition(t) => {
            let thickness = f.opt(t.thickness.as_ref(), &p("thickness"), 0.0);
            EvalShape::Transition {
                shape: t.shape,
                shape_param: f.opt(
                    t.shape_param.as_ref(),
                    &p("shape_param"),
                    default_shape_param(t.shape),
                ),
                length: f.at(&t.length, &p("length")),
                fore_od: f.at(&t.fore_od, &p("fore_od")),
                aft_od: f.at(&t.aft_od, &p("aft_od")),
                thickness,
                fore_shoulder: shoulder(
                    f,
                    &p("fore_shoulder"),
                    t.fore_shoulder.as_ref(),
                    thickness,
                ),
                aft_shoulder: shoulder(f, &p("aft_shoulder"), t.aft_shoulder.as_ref(), thickness),
            }
        }
        ComponentKind::TrapezoidalFinSet(t) => EvalShape::TrapezoidalFinSet {
            fins: fin_common(
                f,
                &b,
                t.count,
                &t.thickness,
                t.cross_section,
                t.cant.as_ref(),
                t.tab.as_ref(),
                t.fillet_radius.as_ref(),
            ),
            root_chord: f.at(&t.root_chord, &p("root_chord")),
            tip_chord: f.at(&t.tip_chord, &p("tip_chord")),
            span: f.at(&t.span, &p("span")),
            sweep: f.at(&t.sweep, &p("sweep")),
        },
        ComponentKind::EllipticalFinSet(t) => EvalShape::EllipticalFinSet {
            fins: fin_common(
                f,
                &b,
                t.count,
                &t.thickness,
                t.cross_section,
                t.cant.as_ref(),
                t.tab.as_ref(),
                t.fillet_radius.as_ref(),
            ),
            root_chord: f.at(&t.root_chord, &p("root_chord")),
            span: f.at(&t.span, &p("span")),
        },
        ComponentKind::FreeformFinSet(t) => EvalShape::FreeformFinSet {
            fins: fin_common(
                f,
                &b,
                t.count,
                &t.thickness,
                t.cross_section,
                t.cant.as_ref(),
                t.tab.as_ref(),
                t.fillet_radius.as_ref(),
            ),
            points: t
                .points
                .iter()
                .enumerate()
                .map(|(i, [x, y])| {
                    [
                        f.q(x, None, &format!("/c/{id}/points/{i}/0")),
                        f.q(y, None, &format!("/c/{id}/points/{i}/1")),
                    ]
                })
                .collect(),
        },
        ComponentKind::TubeFinSet(t) => {
            let od = f.at(&t.od, &p("od"));
            EvalShape::TubeFinSet {
                count: t.count,
                length: f.at(&t.length, &p("length")),
                od,
                id: bore(f, &b, od, t.id.as_ref(), t.thickness.as_ref()),
            }
        }
        ComponentKind::InnerTube(t) => {
            let od = f.at(&t.od, &p("od"));
            EvalShape::InnerTube {
                length: f.at(&t.length, &p("length")),
                od,
                id: bore(f, &b, od, t.id.as_ref(), t.thickness.as_ref()),
                motor_mount: t.motor_mount,
                overhang: f.opt(t.overhang.as_ref(), &p("overhang"), 0.0),
            }
        }
        ComponentKind::Coupler(t) => {
            let od = f.at(&t.od, &p("od"));
            EvalShape::Coupler {
                length: f.at(&t.length, &p("length")),
                od,
                id: bore(f, &b, od, t.id.as_ref(), t.thickness.as_ref()),
            }
        }
        ComponentKind::CenteringRing(t) => EvalShape::CenteringRing {
            length: f.at(&t.length, &p("length")),
            od: f.opt(t.od.as_ref(), &p("od"), 2.0 * parent.inner_r),
            id: f.at(&t.id, &p("id")),
        },
        ComponentKind::Bulkhead(t) => EvalShape::Bulkhead {
            length: f.at(&t.length, &p("length")),
            od: f.opt(t.od.as_ref(), &p("od"), 2.0 * parent.inner_r),
        },
        ComponentKind::EngineBlock(t) => EvalShape::EngineBlock {
            length: f.at(&t.length, &p("length")),
            od: f.opt(t.od.as_ref(), &p("od"), 2.0 * parent.inner_r),
            id: f.at(&t.id, &p("id")),
        },
        ComponentKind::LaunchLug(t) => {
            let od = f.at(&t.od, &p("od"));
            EvalShape::LaunchLug {
                length: f.at(&t.length, &p("length")),
                od,
                id: bore(f, &b, od, t.id.as_ref(), t.thickness.as_ref()),
            }
        }
        ComponentKind::RailButton(t) => {
            let height = f.at(&t.height, &p("height"));
            EvalShape::RailButton {
                od: f.at(&t.od, &p("od")),
                id: f.at(&t.id, &p("id")),
                height,
                base_height: f.opt(t.base_height.as_ref(), &p("base_height"), 0.25 * height),
                flange_height: f.opt(t.flange_height.as_ref(), &p("flange_height"), 0.25 * height),
            }
        }
        ComponentKind::Parachute(t) => EvalShape::Parachute {
            diameter: f.at(&t.diameter, &p("diameter")),
            cd: f.at(&t.cd, &p("cd")),
            spill_hole: f.opt(t.spill_hole.as_ref(), &p("spill_hole"), 0.0),
            line_count: t.line_count.unwrap_or(0),
            line_length: f.opt(t.line_length.as_ref(), &p("line_length"), 0.0),
            line_material: t.line_material.clone(),
            packed_length: f.at(&t.packed_length, &p("packed_length")),
            packed_diameter: f.at(&t.packed_diameter, &p("packed_diameter")),
        },
        ComponentKind::Streamer(t) => EvalShape::Streamer {
            length: f.at(&t.length, &p("length")),
            width: f.at(&t.width, &p("width")),
            cd: f.opt(t.cd.as_ref(), &p("cd"), 0.0),
            packed_length: f.at(&t.packed_length, &p("packed_length")),
            packed_diameter: f.at(&t.packed_diameter, &p("packed_diameter")),
        },
        ComponentKind::ShockCord(t) => EvalShape::ShockCord {
            cord_length: f.at(&t.cord_length, &p("cord_length")),
            packed_length: f.at(&t.packed_length, &p("packed_length")),
            packed_diameter: f.at(&t.packed_diameter, &p("packed_diameter")),
        },
        ComponentKind::MassComponent(t) => EvalShape::MassComponent {
            mass: f.at(&t.mass, &p("mass")),
            length: f.at(&t.length, &p("length")),
            od: f.opt(t.od.as_ref(), &p("od"), 2.0 * parent.inner_r),
            role: t.role,
        },
        ComponentKind::Tank(t) => {
            let length = f.at(&t.length, &p("length"));
            let od = f.at(&t.od, &p("od"));
            let wall = f.at(&t.wall, &p("wall"));
            let volume = tank_volume(length, od, wall, t.end_cap);
            let propellant_mass = t.fill.as_ref().map_or(0.0, |fill| {
                // Refs cannot address fill fields (as in the engine feed).
                let get = |n: &str| ref_to_pointer(&p(n));
                let frac = fill
                    .fraction
                    .as_ref()
                    .map(|q| f.q(q, None, &get("fill.fraction")));
                let vol = fill
                    .volume
                    .as_ref()
                    .map(|q| f.q(q, None, &get("fill.volume")));
                tank_propellant_mass(&fill.propellant, volume, frac, vol)
            });
            EvalShape::Tank {
                length,
                od,
                wall,
                end_cap: t.end_cap,
                volume,
                propellant: t.fill.as_ref().map(|x| x.propellant.clone()),
                propellant_mass,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tank_volume_closed_forms() {
        let pi = std::f64::consts::PI;
        // Flat ends: a plain cylinder of the inner radius and inner length.
        assert!((tank_volume(1.0, 0.2, 0.0, EndCap::Flat) - pi * 0.01).abs() < 1e-15);
        // Hemispherical ends on a 2r-long tank: one sphere.
        let v = tank_volume(0.2, 0.2, 0.0, EndCap::Hemispherical);
        assert!((v - 4.0 / 3.0 * pi * 0.001).abs() < 1e-15);
    }
}
