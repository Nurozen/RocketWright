//! Thermochemistry behind one trait, so the design code does not care
//! whether a committed `.rwtbl` table (`rw-thermo`, pure, WASM) or the
//! sidecar's native CEA call (`rw-project`, feature `cea`) answers.

use rw_thermo::{Mode, Table};
use serde::{Deserialize, Serialize};

/// Combustion and nozzle properties at one operating point (SI). Shifting
/// equilibrium throughout (CEA `rocket eq`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ThermoPoint {
    /// Characteristic velocity c*, m/s.
    pub c_star: f64,
    /// Vacuum thrust coefficient at the area ratio.
    pub cf_vac: f64,
    /// Chamber-to-exit pressure ratio Pc/Pe at the area ratio.
    pub pc_pe: f64,
    /// Chamber temperature, K.
    pub t_c: f64,
    /// Chamber isentropic exponent.
    pub gamma_c: f64,
    /// Chamber molar mass, kg/mol.
    pub molar_mass: f64,
    /// Vacuum specific impulse, m/s.
    pub isp_vac: f64,
}

/// A source of [`ThermoPoint`]s for one propellant pair.
pub trait Thermo {
    /// The point at mixture ratio `of`, chamber pressure `pc` (Pa), and
    /// supersonic area ratio `eps`.
    fn point(&self, of: f64, pc: f64, eps: f64) -> Result<ThermoPoint, String>;
    /// Valid (min, max) of O/F, Pc (Pa), and eps; `None` = unbounded.
    fn of_range(&self) -> Option<(f64, f64)> {
        None
    }
    fn pc_range(&self) -> Option<(f64, f64)> {
        None
    }
    fn eps_range(&self) -> Option<(f64, f64)> {
        None
    }
    /// Provenance shown with the results (`table:n2o-ethanol`, `cea:native`).
    fn source(&self) -> String;
}

/// A committed table (shifting equilibrium slice).
#[derive(Debug, Clone, Copy)]
pub struct TableThermo<'a> {
    pub table: &'a Table,
}

impl<'a> TableThermo<'a> {
    /// cite: n/a constructor, no physics
    pub fn new(table: &'a Table) -> Self {
        TableThermo { table }
    }
}

fn range(v: &[f64]) -> Option<(f64, f64)> {
    Some((*v.first()?, *v.last()?))
}

impl Thermo for TableThermo<'_> {
    fn point(&self, of: f64, pc: f64, eps: f64) -> Result<ThermoPoint, String> {
        let p = self
            .table
            .performance(Mode::Equilibrium, of, pc, Some(eps))
            .map_err(|e| e.to_string())?;
        let n = p.nozzle.ok_or("the table returned no nozzle point")?;
        Ok(ThermoPoint {
            c_star: p.chamber.c_star,
            cf_vac: n.cf_vac,
            pc_pe: n.pc_pe,
            t_c: p.chamber.t_c,
            gamma_c: p.chamber.gamma_c,
            molar_mass: p.chamber.molar_mass_c,
            isp_vac: n.isp_vac,
        })
    }

    fn of_range(&self) -> Option<(f64, f64)> {
        range(&self.table.header().of)
    }

    fn pc_range(&self) -> Option<(f64, f64)> {
        range(&self.table.header().pc_pa)
    }

    fn eps_range(&self) -> Option<(f64, f64)> {
        range(&self.table.header().eps)
    }

    fn source(&self) -> String {
        format!("table:{}", self.table.header().pair)
    }
}

/// `x` clamped into an optional range.
/// cite: n/a clamp, no physics
pub fn clamp_to(x: f64, r: Option<(f64, f64)>) -> f64 {
    match r {
        Some((lo, hi)) => x.clamp(lo, hi),
        None => x,
    }
}
