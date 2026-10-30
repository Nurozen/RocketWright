//! Liquid engines in the sidecar (plan M4.6): thermochemistry selection (the
//! committed tables, embedded in the binary, or native CEA through
//! [`crate::cea_dispatch`]), cached engine designs, the design-rule findings
//! that join the model's diagnostics, the generated thrust curves that
//! resolve `engine:<id>` motor refs, and `engine_design` / `engine_simulate`.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

use rw_api::{EngineDesignOut, EnginePerformance};
use rw_liquid::design::DesignResult;
use rw_liquid::{DesignOptions, TableThermo, Thermo};
use rw_model::{Diagnostic, EvalEngine, EvalShape, EvaluatedModel};
use rw_motor::ThrustCurve;
use rw_thermo::Table;

/// The committed tables (`data/thermo/`), embedded: `(file stem, bytes)`.
const TABLES: [(&str, &[u8]); 6] = [
    (
        "lox-ethanol",
        include_bytes!("../../../data/thermo/lox-ethanol.rwtbl"),
    ),
    (
        "lox-rp1",
        include_bytes!("../../../data/thermo/lox-rp1.rwtbl"),
    ),
    (
        "lox-ch4",
        include_bytes!("../../../data/thermo/lox-ch4.rwtbl"),
    ),
    (
        "lox-ipa",
        include_bytes!("../../../data/thermo/lox-ipa.rwtbl"),
    ),
    (
        "n2o-ethanol",
        include_bytes!("../../../data/thermo/n2o-ethanol.rwtbl"),
    ),
    (
        "n2o-ipa",
        include_bytes!("../../../data/thermo/n2o-ipa.rwtbl"),
    ),
];

static PARSED: OnceLock<BTreeMap<&'static str, Table>> = OnceLock::new();

fn tables() -> &'static BTreeMap<&'static str, Table> {
    PARSED.get_or_init(|| {
        TABLES
            .iter()
            .filter_map(|(id, b)| Table::from_bytes(b).ok().map(|t| (*id, t)))
            .collect()
    })
}

/// The committed table for a propellant pair given by plain ids (`n2o`,
/// `ethanol`). CEA species names (`N2O(L)`) never match: they ask for the
/// native path.
pub fn table_for(oxidizer: &str, fuel: &str) -> Option<&'static Table> {
    tables().get(format!("{oxidizer}-{fuel}").as_str())
}

/// Bytes of a committed table (for the WASM bundle and tests).
pub fn table_bytes(pair: &str) -> Option<&'static [u8]> {
    TABLES.iter().find(|(id, _)| *id == pair).map(|(_, b)| *b)
}

/// The thermochemistry behind one engine.
pub enum EngineThermo {
    Table(&'static Table),
    /// Native CEA: exact points for sizing plus a grid for the blowdown.
    Native(Box<crate::cea_dispatch::NativeThermo>),
    /// Neither: the reason, reported as `RW-E227`.
    None(String),
}

/// Picks the thermochemistry for an engine: a committed table for a
/// tabulated pair of plain ids, otherwise native CEA (feature `cea`).
pub fn thermo_for(e: &EvalEngine) -> EngineThermo {
    if let Some(t) = table_for(&e.oxidizer, &e.fuel) {
        return EngineThermo::Table(t);
    }
    match crate::cea_dispatch::NativeThermo::new(e) {
        Ok(n) => EngineThermo::Native(Box::new(n)),
        Err(m) => EngineThermo::None(m),
    }
}

/// Designs one engine with its thermochemistry.
pub fn design_one(e: &EvalEngine, opts: &DesignOptions) -> DesignResult {
    match thermo_for(e) {
        EngineThermo::Table(t) => {
            let th = TableThermo::new(t);
            rw_liquid::design(e, Some(&th), opts)
        }
        EngineThermo::Native(n) => {
            let grid = n.grid(e);
            let gt = grid.as_ref().ok().map(TableThermo::new);
            let fast: Option<&dyn Thermo> = gt.as_ref().map(|t| t as &dyn Thermo);
            let th: &dyn Thermo = n.as_ref();
            let mut r = rw_liquid::design_engine(e, Some(th), fast.or(Some(th)), opts);
            if let Err(m) = grid {
                r.design
                    .assumptions
                    .push(format!("Blowdown on exact CEA points (no grid: {m})."));
            }
            r
        }
        EngineThermo::None(reason) => {
            let mut r = rw_liquid::design(e, None, opts);
            for d in &mut r.diagnostics {
                if d.code == rw_liquid::diag::E_THERMO {
                    d.message = format!("{} ({reason})", d.message);
                }
            }
            r
        }
    }
}

/// Designs keyed by engine id, each with the hash of the engine it was
/// computed from.
#[derive(Default)]
pub struct DesignCache {
    entries: Mutex<BTreeMap<String, (String, Arc<DesignResult>)>>,
}

impl std::fmt::Debug for DesignCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DesignCache")
    }
}

/// blake3 of an evaluated engine's canonical JSON.
pub fn engine_hash(e: &EvalEngine) -> String {
    let bytes = serde_json::to_vec(e).unwrap_or_default();
    blake3::hash(&bytes).to_hex().to_string()
}

impl DesignCache {
    /// The design of `e` (computed once per engine content).
    pub fn get(&self, e: &EvalEngine) -> Arc<DesignResult> {
        let h = engine_hash(e);
        let mut m = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((hash, r)) = m.get(&e.id)
            && *hash == h
        {
            return r.clone();
        }
        let r = Arc::new(design_one(e, &DesignOptions::default()));
        m.insert(e.id.clone(), (h, r.clone()));
        r
    }
}

/// Adds every engine's design-rule findings to the model's diagnostics
/// (file `engines/<id>.rw.toml`) and rehashes when any were added.
pub fn add_rule_diagnostics(m: &mut EvaluatedModel, cache: &DesignCache) {
    let mut added = Vec::new();
    for e in m.engines.values() {
        let r = cache.get(e);
        for d in &r.diagnostics {
            let mut d = d.clone();
            if d.file.is_none() {
                d.file = Some(engine_file(m, &e.id, d.path.as_deref()));
            }
            added.push(d);
        }
    }
    if !added.is_empty() {
        m.diagnostics.extend(added);
        m.model_hash = rw_model::model_hash(m);
    }
}

fn engine_file(_m: &EvaluatedModel, id: &str, path: Option<&str>) -> String {
    match path {
        Some(p) if p.starts_with("/c/") => "rocket.rw.toml".to_string(),
        _ => format!("engines/{id}.rw.toml"),
    }
}

/// The station of a liquid curve's fore end in `mount`: the mount's aft end
/// plus its overhang minus the engine length (as solid motors sit).
fn motor_fore(m: &EvaluatedModel, mount: &str, length: f64) -> Option<f64> {
    let c = m.components.iter().find(|c| c.id == mount)?;
    let overhang = match c.shape {
        EvalShape::InnerTube { overhang, .. } => overhang,
        _ => 0.0,
    };
    Some(c.x_aft + overhang - length)
}

/// Generated curves of the engines the active configuration mounts, keyed
/// by motor ref (`engine:<id>`), with the propellant CG column measured
/// from the motor's fore end in its mount.
pub fn engine_curves(m: &EvaluatedModel, cache: &DesignCache) -> BTreeMap<String, ThrustCurve> {
    let mut out = BTreeMap::new();
    let Some(cfg) = m.config.as_deref().and_then(|c| m.configs.get(c)) else {
        return out;
    };
    for mm in &cfg.motors {
        let Some(id) = mm.engine.as_deref() else {
            continue;
        };
        let key = format!("engine:{id}");
        if out.contains_key(&key) {
            continue;
        }
        let Some(e) = m.engines.get(id) else {
            continue;
        };
        let r = cache.get(e);
        let Some(curve) = &r.curve else {
            continue;
        };
        let fore = motor_fore(m, &mm.mount, curve.length);
        let placed = r.curve_at(fore).unwrap_or_else(|| curve.clone());
        out.insert(key, placed);
    }
    out
}

/// The `engine_design` output for one engine (`None`: no such engine).
pub fn design_out(m: &EvaluatedModel, id: &str, cache: &DesignCache) -> Option<EngineDesignOut> {
    let e = m.engines.get(id)?;
    let r = cache.get(e);
    let prefix = format!("/engines/{id}");
    let comps: Vec<String> = e
        .nodes
        .values()
        .filter_map(|n| n.component.as_ref().map(|c| format!("/c/{c}/")))
        .collect();
    let mut diagnostics: Vec<Diagnostic> = m
        .diagnostics
        .iter()
        .filter(|d| {
            d.path.as_deref().is_some_and(|p| {
                p == prefix
                    || p.starts_with(&format!("{prefix}/"))
                    || comps.iter().any(|c| p.starts_with(c.as_str()))
                    || (p.ends_with("/engine") && p.starts_with("/configs/"))
            })
        })
        .cloned()
        .collect();
    for d in &r.diagnostics {
        if !diagnostics.iter().any(|x| x.key() == d.key()) {
            diagnostics.push(d.clone());
        }
    }
    let performance = r.design.sizing.as_ref().map(EnginePerformance::from);
    Some(EngineDesignOut {
        engine: id.to_string(),
        performance,
        missing_inputs: r.missing_inputs.clone(),
        diagnostics,
        design: Some(r.design.clone()),
    })
}

/// The series of an engine run (`runs/engine.<id>/<run>/series.csv`): time,
/// chamber and tank pressures, flows, O/F, thrust, liquid left (SI).
pub fn series_csv(b: &rw_liquid::blowdown::Blowdown) -> String {
    let mut s = String::from(
        "t_s,chamber_pressure_pa,ox_tank_pressure_pa,fuel_tank_pressure_pa,mdot_ox_kgs,mdot_fuel_kgs,mixture_ratio,thrust_n,ox_liquid_m3,fuel_liquid_m3\n",
    );
    let f = |x: f64| {
        let r = rw_check::canon::round_sig(x, crate::runs::SERIES_SIG_FIGS);
        if r == 0.0 {
            "0".to_string()
        } else {
            format!("{r}")
        }
    };
    for x in &b.samples {
        s.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{}\n",
            f(x.t),
            f(x.chamber_pressure),
            f(x.ox_tank_pressure),
            f(x.fuel_tank_pressure),
            f(x.mdot_ox),
            f(x.mdot_fuel),
            f(x.mixture_ratio),
            f(x.thrust),
            f(x.ox_liquid),
            f(x.fuel_liquid)
        ));
    }
    s
}
