//! The whole engine from an [`EvalEngine`]: size the chamber and nozzle,
//! the injector, each propellant's feed path and pressure budget, the tanks,
//! then run the blowdown and build the thrust curve. Every step reports what
//! it computed and the design rules it broke; a step whose inputs are
//! missing (the `RW-W21x` warnings of `rw-model`) is skipped, not guessed.

use rw_model::components::engine::check as structural_check;
use rw_model::{Diagnostic, EvalEngine, EvalFeedNode, FeedNodeKind, FluidModel, Severity};
use rw_motor::ThrustCurve;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::blowdown::{self, Blowdown, BlowdownInput, EndReason, Side};
use crate::curve::{CurveSpec, TankPlacement, thrust_curve};
use crate::diag::{self, diag};
use crate::feed::{self, Branch};
use crate::injector::{self, InjectorSide};
use crate::props::{self, T_STORAGE};
use crate::rules;
use crate::sizing::{self, Sizing, SizingInput};
use crate::tank::TankGeom;
use crate::thermo::Thermo;

/// Design options.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DesignOptions {
    /// Ambient pressure of the thrust target and the curve, Pa.
    pub ambient_pressure: f64,
    /// Blowdown step and output grid, s.
    pub dt: f64,
    pub t_max: f64,
    /// Station of the motor's fore end in its mount (CG column of the
    /// curve); `None` leaves the CG at the motor's mid-length.
    pub motor_fore: Option<f64>,
}

impl Default for DesignOptions {
    fn default() -> Self {
        DesignOptions {
            ambient_pressure: crate::P_SEA_LEVEL,
            dt: 0.01,
            t_max: 120.0,
            motor_fore: None,
        }
    }
}

/// Both sides of the injector.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct InjectorDesign {
    pub pressure_drop: f64,
    pub ox: InjectorSide,
    pub fuel: InjectorSide,
}

/// One tank at ignition (SI).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TankReport {
    pub node: String,
    pub fluid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    pub volume: f64,
    pub liquid_volume: f64,
    pub liquid_density: f64,
    pub propellant_mass: f64,
    pub ullage_fraction: f64,
    pub pressure: f64,
    pub pressurant: String,
    /// Polytropic exponent of the ullage expansion (γ of the gas: adiabatic).
    pub polytropic_exponent: f64,
    pub pressurant_mass: f64,
    /// Ullage pressure once the load is gone (polytropic).
    pub final_pressure: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_mass: Option<f64>,
    pub hoop_stress: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hoop_safety_factor: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub station: Option<f64>,
    /// Liquid CG from the tank's aft inner pole.
    pub liquid_centroid: f64,
}

/// Blowdown totals.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BlowdownSummary {
    pub burn_time: f64,
    pub total_impulse: f64,
    pub average_thrust: f64,
    pub peak_thrust: f64,
    pub initial_chamber_pressure: f64,
    pub final_chamber_pressure: f64,
    pub ox_used: f64,
    pub fuel_used: f64,
    pub end: EndReason,
}

/// A liquid engine design (`engine_design`, SI).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "LiquidEngineDesign")]
pub struct Design {
    pub engine: String,
    /// Thermochemistry provenance (`table:n2o-ethanol`, `cea:native`).
    pub thermo: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sizing: Option<Sizing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injector: Option<InjectorDesign>,
    /// Oxidizer then fuel feed path, when the feed inputs are complete.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub feed: Vec<Branch>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tanks: Vec<TankReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blowdown: Option<BlowdownSummary>,
    /// Modelling assumptions shown with the results (page 06 Assumptions).
    pub assumptions: Vec<String>,
}

/// Everything [`design_engine`] produces.
#[derive(Debug, Clone, PartialEq)]
pub struct DesignResult {
    pub design: Design,
    pub blowdown: Option<Blowdown>,
    pub curve: Option<ThrustCurve>,
    /// Design-rule findings (`RW-E22x`).
    pub diagnostics: Vec<Diagnostic>,
    /// Pointers of the missing inputs (`RW-W21x` of the engine).
    pub missing_inputs: Vec<String>,
    /// What [`Self::curve_at`] needs to rebuild the curve for a mount.
    pub curve_spec: Option<CurveSpec>,
    /// Oxidizer and fuel liquid densities, kg/m³.
    pub densities: Option<(f64, f64)>,
}

impl DesignResult {
    /// The thrust curve with its CG column measured from a motor fore end at
    /// station `motor_fore` (the engine's mount), without re-running the
    /// blowdown.
    ///
    /// cite: n/a curve assembly from blowdown samples, no physics
    pub fn curve_at(&self, motor_fore: Option<f64>) -> Option<ThrustCurve> {
        let (spec, b, (ro, rf)) = (
            self.curve_spec.as_ref()?,
            self.blowdown.as_ref()?,
            self.densities?,
        );
        let spec = CurveSpec {
            motor_fore,
            ..spec.clone()
        };
        thrust_curve(b, &spec, ro, rf).ok()
    }
}

const ASSUMPTIONS: [&str; 5] = [
    "Single-phase liquid propellants at 20 °C (two-phase self-pressurizing N2O is not modelled).",
    "Ullage gas expands adiabatically (polytropic exponent = γ of the pressurant); no heat or mass transfer.",
    "Shifting-equilibrium thermochemistry (NASA CEA); ideal c* and Cf, no efficiency factors.",
    "Feed losses: Darcy lines with f = 0.02, orifices Cd = 0.61, valves Cd = 0.8 unless given.",
    "Thrust at sea-level ambient pressure; nozzle flow separation is not modelled.",
];

/// Designs an engine with one thermochemistry source for both sizing and
/// the blowdown.
///
/// cite: sp-125 eq 1-34 p 22
pub fn design(
    engine: &EvalEngine,
    thermo: Option<&dyn Thermo>,
    opts: &DesignOptions,
) -> DesignResult {
    design_engine(engine, thermo, thermo, opts)
}

fn err_at(out: &mut Vec<Diagnostic>, code: &str, path: String, msg: String, hint: &str) {
    out.push(diag(code, path, msg, hint));
}

fn tank_for<'a>(e: &'a EvalEngine, prop: &str) -> Option<(&'a String, &'a EvalFeedNode)> {
    e.nodes
        .iter()
        .find(|(_, n)| n.kind == FeedNodeKind::Tank && n.fluid.as_deref() == Some(prop))
}

/// The chamber-only part of a design: structural findings, the sizing, and
/// the chamber rules (injector drop, L*, contraction, exit pressure). The WASM
/// preview stops here; the sidecar continues with [`design_engine`].
#[derive(Debug, Clone, PartialEq)]
pub struct ChamberResult {
    pub thermo: String,
    pub sizing: Option<Sizing>,
    /// Design-rule findings (`RW-E22x`).
    pub diagnostics: Vec<Diagnostic>,
    /// Pointers of the missing inputs (`RW-W21x` of the engine).
    pub missing_inputs: Vec<String>,
    /// The structural check found an error (`RW-E200`/`E201`).
    pub blocked: bool,
}

/// Sizes the chamber and nozzle of `e` and checks the chamber rules.
///
/// cite: sp-125 eq 1-34 p 22
pub fn chamber(e: &EvalEngine, thermo: Option<&dyn Thermo>, opts: &DesignOptions) -> ChamberResult {
    let id = e.id.as_str();
    let base = format!("/engines/{id}");
    let p = |n: &str| format!("{base}/{n}");
    let structural = structural_check(e);
    let mut r = ChamberResult {
        thermo: thermo.map_or_else(|| "none".to_string(), |t| t.source()),
        sizing: None,
        diagnostics: Vec::new(),
        missing_inputs: structural
            .iter()
            .filter(|d| d.code.starts_with("RW-W21"))
            .filter_map(|d| d.path.clone())
            .collect(),
        blocked: structural.iter().any(|d| d.severity == Severity::Error),
    };
    let out = &mut r.diagnostics;
    if e.fluid_model == Some(FluidModel::TwoPhaseEquilibrium) {
        err_at(
            out,
            diag::E_FLUID_MODEL,
            p("fluid_model"),
            format!("engine `{id}`: the two-phase equilibrium fluid model is not supported yet"),
            "use `fluid_model = \"single_phase_liquid\"`",
        );
    }
    let Some(thermo) = thermo else {
        err_at(
            out,
            diag::E_THERMO,
            p("propellants"),
            format!(
                "engine `{id}`: no thermochemistry for {} / {}",
                e.oxidizer, e.fuel
            ),
            "use a tabulated pair (lox|n2o with ethanol, ipa, rp1, ch4) or run the sidecar built with native CEA",
        );
        return r;
    };
    let (Some(l_star), Some(contraction), Some(inj_dp)) = (
        e.l_star,
        e.contraction_ratio,
        e.injector.as_ref().and_then(|i| i.pressure_drop),
    ) else {
        return r;
    };
    if e.expansion_ratio.is_none() && e.exit_pressure.is_none() {
        return r;
    }
    if !(e.chamber_pressure > 0.0 && e.thrust > 0.0 && e.mixture_ratio > 0.0) {
        return r;
    }
    // SP-125 sec. 1 and 4.3.
    let input = SizingInput {
        thrust: e.thrust,
        chamber_pressure: e.chamber_pressure,
        mixture_ratio: e.mixture_ratio,
        expansion_ratio: e.expansion_ratio,
        exit_pressure: e.exit_pressure,
        contraction_ratio: contraction,
        l_star,
        ambient_pressure: opts.ambient_pressure,
    };
    let s = match sizing::size(&input, thermo) {
        Ok(s) => s,
        Err(m) => {
            err_at(
                out,
                diag::E_THERMO,
                p("mixture_ratio"),
                format!("engine `{id}`: cannot size the chamber: {m}"),
                "keep O/F, chamber pressure, and the area ratio inside the thermo table",
            );
            return r;
        }
    };
    out.extend(rules::injector_dp(
        id,
        p("injector"),
        inj_dp,
        e.chamber_pressure,
    ));
    out.extend(rules::l_star(id, p("l_star"), l_star));
    out.extend(rules::contraction(id, p("contraction_ratio"), contraction));
    let pe_ptr = if e.expansion_ratio.is_some() {
        p("expansion_ratio")
    } else {
        p("exit_pressure")
    };
    out.extend(rules::exit_pressure(
        id,
        pe_ptr,
        s.exit_pressure,
        opts.ambient_pressure,
    ));
    r.sizing = Some(s);
    r
}

/// Designs an engine: `thermo` sizes the chamber (exact), `fast` drives the
/// blowdown (many evaluations; a table or a CEA-built grid).
///
/// cite: sp-125 eq 1-34 p 22
#[allow(clippy::too_many_lines)]
pub fn design_engine(
    e: &EvalEngine,
    thermo: Option<&dyn Thermo>,
    fast: Option<&dyn Thermo>,
    opts: &DesignOptions,
) -> DesignResult {
    let id = e.id.as_str();
    let base = format!("/engines/{id}");
    let c = chamber(e, thermo, opts);
    let missing_inputs = c.missing_inputs.clone();
    let blocked = c.blocked;
    let mut out = c.diagnostics;
    let mut design = Design {
        engine: id.to_string(),
        thermo: c.thermo,
        sizing: c.sizing,
        injector: None,
        feed: Vec::new(),
        tanks: Vec::new(),
        blowdown: None,
        assumptions: ASSUMPTIONS.iter().map(|s| (*s).to_string()).collect(),
    };
    let done = |design: Design, out: Vec<Diagnostic>| DesignResult {
        design,
        blowdown: None,
        curve: None,
        diagnostics: out,
        missing_inputs: missing_inputs.clone(),
        curve_spec: None,
        densities: None,
    };
    let (Some(s), Some(thermo), Some(inj)) = (c.sizing, thermo, e.injector.as_ref()) else {
        return done(design, out);
    };
    let Some(inj_dp) = inj.pressure_drop else {
        return done(design, out);
    };
    let p = |n: &str| format!("{base}/{n}");

    // ---- injector (SP-125 eq 4-39, 4-40)
    let liquids = (props::liquid(&e.oxidizer), props::liquid(&e.fuel));
    let cd = inj.cd.unwrap_or(injector::DEFAULT_CD);
    if let (Some(lo), Some(lf)) = liquids {
        design.injector = Some(InjectorDesign {
            pressure_drop: inj_dp,
            ox: injector::size_side(s.mdot_ox, lo.density, cd, inj_dp),
            fuel: injector::size_side(s.mdot_fuel, lf.density, cd, inj_dp),
        });
    }

    // ---- tanks and feed (SP-125 sec. 5, 7, 8): only with complete inputs
    let feed_ready = !blocked
        && e.fluid_model == Some(FluidModel::SinglePhaseLiquid)
        && missing_inputs.is_empty();
    if !feed_ready {
        return done(design, out);
    }
    let Some(target) = e
        .nodes
        .iter()
        .find(|(_, n)| n.kind == FeedNodeKind::Engine)
        .map(|(k, _)| k.clone())
    else {
        return done(design, out);
    };
    let mut sides = Vec::new();
    let mut placements = Vec::new();
    let mut dry_mass = 0.0;
    let mut dry_moment = 0.0;
    let mut dry_known = true;
    for (prop, mdot, inj_side) in [
        (&e.oxidizer, s.mdot_ox, design.injector.map(|i| i.ox)),
        (&e.fuel, s.mdot_fuel, design.injector.map(|i| i.fuel)),
    ] {
        let Some((nid, node)) = tank_for(e, prop) else {
            return done(design, out);
        };
        let nb = format!("{base}/feed/node/{nid}");
        let Some(liq) = props::liquid(prop) else {
            err_at(
                &mut out,
                diag::E_PROPELLANT,
                format!("{nb}/fluid"),
                format!("no liquid density for `{prop}`"),
                "use n2o, lox, ethanol, ipa, methanol, rp1, ch4, or water",
            );
            return done(design, out);
        };
        let gas_name = node.pressurant.clone().unwrap_or_default();
        let Some(gas) = props::gas(&gas_name) else {
            err_at(
                &mut out,
                diag::E_PROPELLANT,
                format!("{nb}/pressurant"),
                format!("no gas data for pressurant `{gas_name}`"),
                "use n2, he, or air",
            );
            return done(design, out);
        };
        let (Some(spec), Some(p0)) = (node.tank.as_ref(), node.pressure) else {
            return done(design, out);
        };
        let Some(liquid0) = spec.fill_volume else {
            return done(design, out);
        };
        let geom = TankGeom::from(spec);
        let fill_ptr = match &node.component {
            Some(c) => format!("/c/{c}/fill"),
            None => format!("{nb}/tank/fill"),
        };
        let mat_ptr = match &node.component {
            Some(c) => format!("/c/{c}/material"),
            None => format!("{nb}/material"),
        };
        out.extend(rules::tank_margin(nid, fill_ptr, spec.volume, liquid0));
        let hoop = geom.hoop_stress(p0);
        let sf = spec.yield_strength.map(|y| y / hoop);
        if let Some(y) = spec.yield_strength {
            out.extend(rules::hoop(nid, mat_ptr, hoop, y));
        }
        let vu0 = spec.volume - liquid0;
        let m_gas = blowdown::pressurant_mass(p0, vu0.max(0.0), gas.r, T_STORAGE);
        let shell = if node.component.is_none() {
            spec.density.map(|rho| rho * geom.shell_volume())
        } else {
            None
        };
        let station = node.station;
        let x_aft = station.map(|st| st + geom.length / 2.0);
        dry_mass += m_gas + shell.unwrap_or(0.0);
        match station {
            Some(st) => dry_moment += (m_gas + shell.unwrap_or(0.0)) * st,
            None => dry_known = false,
        }
        if let Some(xa) = x_aft {
            placements.push(TankPlacement {
                geom,
                x_aft: xa,
                density: liq.density,
            });
        }
        design.tanks.push(TankReport {
            node: nid.clone(),
            fluid: prop.clone(),
            component: node.component.clone(),
            volume: spec.volume,
            liquid_volume: liquid0,
            liquid_density: liq.density,
            propellant_mass: liquid0 * liq.density,
            ullage_fraction: vu0 / spec.volume,
            pressure: p0,
            pressurant: gas.id.to_string(),
            polytropic_exponent: gas.gamma,
            pressurant_mass: m_gas,
            final_pressure: blowdown::polytropic_pressure(p0, vu0, spec.volume, gas.gamma),
            shell_mass: shell,
            hoop_stress: hoop,
            hoop_safety_factor: sf,
            station,
            liquid_centroid: geom.liquid_centroid(liquid0),
        });
        // Feed path and budget.
        let Some(path) = feed::path(nid, &target, &e.edges) else {
            return done(design, out);
        };
        let elems = feed::elements(e, &path);
        let inj_r = inj_side.map_or(0.0, |i| feed::orifice_resistance(liq.density, i.cd, i.area));
        let branch = feed::budget(
            nid,
            prop,
            liq.density,
            path.iter().map(|(n, _)| n.clone()).collect(),
            elems,
            mdot,
            p0,
            e.chamber_pressure,
            inj_dp,
            inj_r,
        );
        out.extend(rules::feed_pressure(
            nid,
            format!("{nb}/pressure"),
            p0,
            branch.required_pressure,
        ));
        sides.push(Side {
            tank_volume: spec.volume,
            liquid0,
            p0,
            n: gas.gamma,
            density: liq.density,
            resistance: branch.resistance,
        });
        design.feed.push(branch);
    }
    if out.iter().any(|d| d.severity == Severity::Error) {
        return done(design, out);
    }

    // ---- blowdown and curve
    let input = BlowdownInput {
        ox: sides[0],
        fuel: sides[1],
        throat_area: s.throat_area,
        expansion_ratio: s.expansion_ratio,
        ambient_pressure: opts.ambient_pressure,
        dt: opts.dt,
        t_max: opts.t_max,
    };
    let fast = fast.unwrap_or(thermo);
    let b = blowdown::simulate(&input, fast);
    let peak = b.samples.iter().map(|x| x.thrust).fold(0.0, f64::max);
    design.blowdown = Some(BlowdownSummary {
        burn_time: b.burn_time,
        total_impulse: b.total_impulse,
        average_thrust: if b.burn_time > 0.0 {
            b.total_impulse / b.burn_time
        } else {
            0.0
        },
        peak_thrust: peak,
        initial_chamber_pressure: b.samples.first().map_or(0.0, |x| x.chamber_pressure),
        final_chamber_pressure: b.samples.last().map_or(0.0, |x| x.chamber_pressure),
        ox_used: b.ox_used,
        fuel_used: b.fuel_used,
        end: b.end,
    });
    let spec = CurveSpec {
        engine: id.to_string(),
        designation: format!("{}-{:.0}N", id, s.thrust),
        length: s.total_length,
        diameter: s.chamber_diameter.max(s.exit_diameter),
        dry_mass,
        dry_station: (dry_known && dry_mass > 0.0).then(|| dry_moment / dry_mass),
        tanks: (placements.len() == 2).then(|| (placements[0], placements[1])),
        motor_fore: opts.motor_fore,
    };
    let densities = (sides[0].density, sides[1].density);
    let curve = if b.samples.len() >= 2 {
        match thrust_curve(&b, &spec, densities.0, densities.1) {
            Ok(c) => Some(c),
            Err(m) => {
                err_at(
                    &mut out,
                    diag::E_THERMO,
                    p("thrust"),
                    format!(
                        "engine `{id}`: the generated thrust curve is invalid: {}",
                        m.message
                    ),
                    "check the tank loads and pressures",
                );
                None
            }
        }
    } else {
        None
    };
    DesignResult {
        design,
        blowdown: Some(b),
        curve,
        diagnostics: out,
        missing_inputs,
        curve_spec: Some(spec),
        densities: Some(densities),
    }
}
