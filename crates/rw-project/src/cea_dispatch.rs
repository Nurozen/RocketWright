//! Native CEA for arbitrary propellants (plan M4.6): a pair outside the
//! committed tables, or one named by CEA species (`N2O(L)`, `IPA(L)`,
//! `CH3OH(L)`), is solved by the vendored NASA CEA (`rw-cea-sys`, feature
//! `cea`). Sizing uses exact CEA points; the blowdown, which needs thousands
//! of evaluations, uses a small table CEA fills on a grid around the design.
//! Without the feature, [`NativeThermo::new`] explains how to get it and the
//! engine reports `RW-E227`.

use rw_liquid::{Thermo, ThermoPoint};
use rw_model::EvalEngine;

#[cfg(feature = "cea")]
use rw_cea_sys::{Cea, Exit, Reactant};

/// Reactant temperature for a CEA database species named directly, K.
pub const DB_SPECIES_T: f64 = 298.15;

/// The CEA reactant for a propellant name: the shipped definitions for the
/// known ids (custom N2O(L) and IPA(L) with their NIST enthalpies), else a
/// database species at 298.15 K.
#[cfg(feature = "cea")]
pub fn reactant(name: &str) -> Reactant {
    let id = rw_liquid::props::canonical(name);
    rw_cea_sys::propellants::reactant(&id).unwrap_or_else(|| Reactant::db(name, DB_SPECIES_T))
}

/// Native CEA behind [`Thermo`].
#[derive(Debug)]
pub struct NativeThermo {
    #[cfg(feature = "cea")]
    cea: &'static Cea,
    #[cfg(feature = "cea")]
    ox: Reactant,
    #[cfg(feature = "cea")]
    fuel: Reactant,
    label: String,
}

impl NativeThermo {
    /// Native CEA for an engine's propellants, or why it is unavailable.
    #[cfg(feature = "cea")]
    pub fn new(e: &EvalEngine) -> Result<NativeThermo, String> {
        let cea = Cea::init_located().map_err(|err| {
            format!("native CEA data not found: {err} (set RW_CEA_DATA or install share/rocketwright/cea)")
        })?;
        Ok(NativeThermo {
            cea,
            ox: reactant(&e.oxidizer),
            fuel: reactant(&e.fuel),
            label: format!("cea:native {}/{}", e.oxidizer, e.fuel),
        })
    }

    /// Native CEA for an engine's propellants, or why it is unavailable.
    #[cfg(not(feature = "cea"))]
    pub fn new(e: &EvalEngine) -> Result<NativeThermo, String> {
        Err(format!(
            "{} / {} is not a tabulated pair and this build has no native CEA (build rw-cli with --features cea)",
            e.oxidizer, e.fuel
        ))
    }

    /// A shifting-equilibrium table filled by CEA on a grid around the
    /// engine's design point (O/F ±60%, Pc 1 bar to above the highest tank
    /// pressure, the usual area ratios), for the blowdown.
    #[cfg(feature = "cea")]
    pub fn grid(&self, e: &EvalEngine) -> Result<rw_thermo::Table, String> {
        use rw_thermo::{CHAMBER_FIELDS, FORMAT, Header, Mode, NOZZLE_FIELDS, ReactantDef, Table};
        let of: Vec<f64> = (0..13)
            .map(|i| e.mixture_ratio * (0.4 + 0.1 * f64::from(i)))
            .collect();
        let top = e
            .nodes
            .values()
            .filter_map(|n| n.pressure)
            .fold(e.chamber_pressure, f64::max)
            * 1.05;
        let mut pc = vec![1e5];
        while *pc.last().unwrap_or(&top) < top {
            let next = (pc.last().copied().unwrap_or(1e5) * 1.45).min(top);
            pc.push(next);
        }
        let eps = vec![
            1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 15.0, 20.0, 30.0, 40.0,
        ];
        let def = |r: &Reactant, id: &str| ReactantDef {
            id: id.to_string(),
            name: r.name().to_string(),
            t_k: r.t_k(),
            formula: None,
            h_j_per_mol: None,
        };
        let header = Header {
            format: FORMAT,
            pair: format!("{}-{}", e.oxidizer, e.fuel),
            oxidizer: def(&self.ox, &e.oxidizer),
            fuel: def(&self.fuel, &e.fuel),
            cea_version: "native".into(),
            thermo_sha256: String::new(),
            of: of.clone(),
            pc_pa: pc.clone(),
            eps: eps.clone(),
            modes: vec![Mode::Equilibrium],
            frozen_station: 1,
            chamber_fields: CHAMBER_FIELDS.map(String::from).to_vec(),
            nozzle_fields: NOZZLE_FIELDS.map(String::from).to_vec(),
        };
        let node = header.node_len();
        let mut values = vec![f32::NAN; header.value_count()];
        for (i, &o) in of.iter().enumerate() {
            for (j, &p) in pc.iter().enumerate() {
                let Ok(s) =
                    self.cea
                        .rocket_iac(&self.fuel, &self.ox, o, p / 1e5, &Exit::supar(&eps), None)
                else {
                    continue;
                };
                let at = header.node_offset(0, i, j);
                let chamber = [
                    s.t_k[0],
                    s.m[0] * 1e-3,
                    s.gamma_s[0],
                    s.cp_eq[0] * 1e3,
                    s.c_star[0],
                    s.rho[0],
                    s.t_k[1],
                    s.p_bar[1] * 1e5,
                    s.gamma_s[1],
                ];
                let mut row: Vec<f64> = chamber.to_vec();
                for k in 0..eps.len() {
                    let e2 = 2 + k;
                    row.extend([
                        s.p_bar[0] / s.p_bar[e2],
                        s.t_k[e2],
                        s.gamma_s[e2],
                        s.mach[e2],
                        s.isp[e2],
                        s.isp_vac[e2],
                    ]);
                }
                if row.len() == node && row.iter().all(|v| v.is_finite()) {
                    for (dst, v) in values[at..at + node].iter_mut().zip(&row) {
                        *dst = *v as f32;
                    }
                }
            }
        }
        Table::new(header, values).map_err(|e| e.to_string())
    }

    /// Without native CEA there is no grid.
    #[cfg(not(feature = "cea"))]
    pub fn grid(&self, _e: &EvalEngine) -> Result<rw_thermo::Table, String> {
        Err("native CEA is not linked".into())
    }
}

impl Thermo for NativeThermo {
    #[cfg(feature = "cea")]
    fn point(&self, of: f64, pc: f64, eps: f64) -> Result<ThermoPoint, String> {
        let s = self
            .cea
            .rocket_iac(
                &self.fuel,
                &self.ox,
                of,
                pc / 1e5,
                &Exit::supar(&[eps]),
                None,
            )
            .map_err(|e| e.to_string())?;
        let c_star = s.c_star[0];
        Ok(ThermoPoint {
            c_star,
            cf_vac: s.isp_vac[2] / c_star,
            pc_pe: s.p_bar[0] / s.p_bar[2],
            t_c: s.t_k[0],
            gamma_c: s.gamma_s[0],
            molar_mass: s.m[0] * 1e-3,
            isp_vac: s.isp_vac[2],
        })
    }

    #[cfg(not(feature = "cea"))]
    fn point(&self, _of: f64, _pc: f64, _eps: f64) -> Result<ThermoPoint, String> {
        Err("native CEA is not linked".into())
    }

    fn eps_range(&self) -> Option<(f64, f64)> {
        Some((1.1, 200.0))
    }

    fn source(&self) -> String {
        self.label.clone()
    }
}
