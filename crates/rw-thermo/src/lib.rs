//! Thermochemistry tables (R4.7): rocket performance from committed,
//! CEA-generated `.rwtbl` tables (`data/thermo/`, written by
//! `cargo xtask tables`), interpolated multilinearly in (O/F, ln Pc, ln eps).
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Tables load from bytes ([`Table::from_bytes`]);
//! the app ships them beside the wasm (`pkg/thermo/`, D19d) and the sidecar
//! embeds or reads them itself.
//!
//! # `.rwtbl` format, version 1
//!
//! ```text
//! magic    8 bytes  b"RWTBL01\n"
//! hlen     u32 LE   header length in bytes
//! header   hlen     UTF-8 JSON, [`Header`]
//! values   f32 LE   mode-major: for each mode, O/F, Pc: the chamber fields,
//!                   then for each eps the nozzle fields (`Header` order)
//! ```
//!
//! Every value is SI: K, Pa, kg/m^3, J/(kg K), kg/mol, m/s. A node CEA did
//! not converge on is NaN; a lookup touching it is an error, never a guess.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

use serde::{Deserialize, Serialize};

/// File magic (format version 1).
pub const MAGIC: &[u8; 8] = b"RWTBL01\n";
/// Header `format` value this crate reads and writes.
pub const FORMAT: u32 = 1;

/// Per-(mode, O/F, Pc) fields, in storage order.
pub const CHAMBER_FIELDS: [&str; 9] = [
    "t_c",
    "molar_mass_c",
    "gamma_c",
    "cp_c",
    "c_star",
    "rho_c",
    "t_t",
    "p_t",
    "gamma_t",
];
/// Per-(mode, O/F, Pc, eps) fields, in storage order.
pub const NOZZLE_FIELDS: [&str; 6] = ["pc_pe", "t_e", "gamma_e", "mach_e", "isp", "isp_vac"];

/// Flow model of a table slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Shifting equilibrium through the nozzle.
    Equilibrium,
    /// Composition frozen at [`Header::frozen_station`] (1 = chamber).
    Frozen,
}

/// How a table's reactant was defined for CEA.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReactantDef {
    /// Propellant id (`lox`, `n2o`, `ethanol`, `rp1`, `ch4`, `ipa`).
    pub id: String,
    /// CEA species name (`O2(L)`, or the custom name `N2O(L)`).
    pub name: String,
    /// Reactant temperature, K.
    pub t_k: f64,
    /// Custom reactants only: element counts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula: Option<Vec<(String, f64)>>,
    /// Custom reactants only: assigned enthalpy, J/mol.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h_j_per_mol: Option<f64>,
}

/// The JSON header of a `.rwtbl` file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Header {
    pub format: u32,
    /// Pair id and file stem (`lox-ethanol`).
    pub pair: String,
    pub oxidizer: ReactantDef,
    pub fuel: ReactantDef,
    /// NASA CEA library version that generated the values (`3.3.4`).
    pub cea_version: String,
    /// SHA-256 (hex) of the `thermo.inp` the database was compiled from.
    pub thermo_sha256: String,
    /// Oxidizer-to-fuel mass ratio axis (ascending; linear interpolation).
    pub of: Vec<f64>,
    /// Chamber pressure axis, Pa (ascending; interpolated in ln Pc).
    pub pc_pa: Vec<f64>,
    /// Supersonic area ratio axis Ae/At (ascending; interpolated in ln eps).
    pub eps: Vec<f64>,
    /// Slices in storage order.
    pub modes: Vec<Mode>,
    /// CEA `nfz` of the frozen slice (1 = chamber).
    pub frozen_station: u32,
    pub chamber_fields: Vec<String>,
    pub nozzle_fields: Vec<String>,
}

impl Header {
    /// Values per (mode, O/F, Pc) node: chamber fields plus every eps.
    ///
    /// cite: n/a table layout arithmetic, no physics
    pub fn node_len(&self) -> usize {
        CHAMBER_FIELDS.len() + self.eps.len() * NOZZLE_FIELDS.len()
    }

    /// Total number of stored values.
    ///
    /// cite: n/a table layout arithmetic, no physics
    pub fn value_count(&self) -> usize {
        self.modes.len() * self.of.len() * self.pc_pa.len() * self.node_len()
    }

    /// Offset of node `(mode, of, pc)` (indices) in the value array.
    ///
    /// cite: n/a table layout arithmetic, no physics
    pub fn node_offset(&self, mode: usize, of: usize, pc: usize) -> usize {
        ((mode * self.of.len() + of) * self.pc_pa.len() + pc) * self.node_len()
    }
}

/// Errors from table parsing and lookup.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ThermoError {
    #[error("not an .rwtbl table: {0}")]
    Format(String),
    #[error("{axis} = {value} is outside the table range [{min}, {max}]")]
    OutOfRange {
        axis: &'static str,
        value: f64,
        min: f64,
        max: f64,
    },
    #[error("the table has no {0:?} slice")]
    NoMode(Mode),
    #[error("CEA did not converge at a table node next to the requested point")]
    NoData,
    #[error("invalid query: {0}")]
    InvalidQuery(String),
}

/// Chamber and throat conditions (SI).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Chamber {
    /// Chamber temperature, K.
    pub t_c: f64,
    /// Chamber molar mass M (1/n), kg/mol.
    pub molar_mass_c: f64,
    /// Chamber isentropic exponent gamma_s.
    pub gamma_c: f64,
    /// Chamber cp (equilibrium or frozen per mode), J/(kg K).
    pub cp_c: f64,
    /// Characteristic velocity c*, m/s.
    pub c_star: f64,
    /// Chamber density, kg/m^3.
    pub rho_c: f64,
    /// Throat temperature, K.
    pub t_t: f64,
    /// Throat pressure, Pa.
    pub p_t: f64,
    /// Throat gamma_s.
    pub gamma_t: f64,
}

/// Nozzle exit conditions and performance at one area ratio (SI).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Nozzle {
    /// Area ratio Ae/At.
    pub eps: f64,
    /// Chamber-to-exit pressure ratio Pc/Pe.
    pub pc_pe: f64,
    /// Exit temperature, K.
    pub t_e: f64,
    /// Exit gamma_s.
    pub gamma_e: f64,
    /// Exit Mach number.
    pub mach_e: f64,
    /// Specific impulse at ambient = exit pressure, m/s.
    pub isp: f64,
    /// Vacuum specific impulse, m/s.
    pub isp_vac: f64,
    /// Thrust coefficient at ambient = exit pressure (isp / c*).
    pub cf: f64,
    /// Vacuum thrust coefficient (isp_vac / c*).
    pub cf_vac: f64,
}

/// One interpolated operating point.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Performance {
    pub mode: Mode,
    pub of: f64,
    /// Chamber pressure, Pa.
    pub pc: f64,
    pub chamber: Chamber,
    /// Absent when the query gave no area ratio.
    pub nozzle: Option<Nozzle>,
}

/// A table lookup (the `thermo_lookup` WASM export's query). SI: `pc` in Pa.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    /// Must match the table's oxidizer id when given.
    #[serde(default)]
    pub oxidizer: Option<String>,
    /// Must match the table's fuel id when given.
    #[serde(default)]
    pub fuel: Option<String>,
    pub of: f64,
    /// Chamber pressure, Pa.
    pub pc: f64,
    /// Supersonic area ratio Ae/At (omit for chamber conditions only).
    #[serde(default)]
    pub eps: Option<f64>,
    /// Frozen flow instead of shifting equilibrium (default false).
    #[serde(default)]
    pub frozen: bool,
}

/// A parsed `.rwtbl` table.
#[derive(Debug, Clone, PartialEq)]
pub struct Table {
    header: Header,
    values: Vec<f32>,
}

/// Interpolation weights along one axis: lower index and fraction.
#[derive(Debug, Clone, Copy)]
struct Cell {
    i: usize,
    t: f64,
}

/// Locates `x` on an ascending axis (in the transformed coordinate `f`).
/// Exact endpoints and values within 1e-9 (relative) of them are inside.
fn locate(
    axis: &[f64],
    x: f64,
    name: &'static str,
    f: impl Fn(f64) -> f64,
) -> Result<Cell, ThermoError> {
    let (min, max) = (axis[0], axis[axis.len() - 1]);
    let slack = 1e-9 * max.abs().max(min.abs());
    if !x.is_finite() || x < min - slack || x > max + slack {
        return Err(ThermoError::OutOfRange {
            axis: name,
            value: x,
            min,
            max,
        });
    }
    if axis.len() == 1 {
        return Ok(Cell { i: 0, t: 0.0 });
    }
    let x = x.clamp(min, max);
    // Last index with axis[i] <= x, capped so i + 1 exists.
    let i = axis
        .partition_point(|a| *a <= x)
        .saturating_sub(1)
        .min(axis.len() - 2);
    let (a, b) = (f(axis[i]), f(axis[i + 1]));
    let t = ((f(x) - a) / (b - a)).clamp(0.0, 1.0);
    Ok(Cell { i, t })
}

fn check_axis(name: &str, axis: &[f64], positive: bool) -> Result<(), ThermoError> {
    if axis.is_empty() {
        return Err(ThermoError::Format(format!("empty {name} axis")));
    }
    if axis
        .iter()
        .any(|v| !v.is_finite() || (positive && *v <= 0.0))
    {
        return Err(ThermoError::Format(format!("bad {name} axis value")));
    }
    if axis.windows(2).any(|w| w[1] <= w[0]) {
        return Err(ThermoError::Format(format!("{name} axis not ascending")));
    }
    Ok(())
}

impl Table {
    /// A table from a header and its values (the generator's constructor).
    ///
    /// cite: n/a container validation, no physics
    pub fn new(header: Header, values: Vec<f32>) -> Result<Table, ThermoError> {
        if header.format != FORMAT {
            return Err(ThermoError::Format(format!(
                "format {} (this build reads {FORMAT})",
                header.format
            )));
        }
        if header.chamber_fields != CHAMBER_FIELDS || header.nozzle_fields != NOZZLE_FIELDS {
            return Err(ThermoError::Format(
                "field lists differ from this build".into(),
            ));
        }
        check_axis("of", &header.of, true)?;
        check_axis("pc", &header.pc_pa, true)?;
        check_axis("eps", &header.eps, true)?;
        if header.modes.is_empty()
            || (1..header.modes.len()).any(|i| header.modes[..i].contains(&header.modes[i]))
        {
            return Err(ThermoError::Format("modes empty or repeated".into()));
        }
        if values.len() != header.value_count() {
            return Err(ThermoError::Format(format!(
                "{} values, header implies {}",
                values.len(),
                header.value_count()
            )));
        }
        Ok(Table { header, values })
    }

    /// Parses `.rwtbl` bytes.
    ///
    /// cite: n/a file-format reader, no physics
    pub fn from_bytes(bytes: &[u8]) -> Result<Table, ThermoError> {
        let rest = bytes
            .strip_prefix(MAGIC.as_slice())
            .ok_or_else(|| ThermoError::Format("bad magic".into()))?;
        if rest.len() < 4 {
            return Err(ThermoError::Format("truncated header length".into()));
        }
        let hlen = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
        let rest = &rest[4..];
        if rest.len() < hlen {
            return Err(ThermoError::Format("truncated header".into()));
        }
        let header: Header = serde_json::from_slice(&rest[..hlen])
            .map_err(|e| ThermoError::Format(format!("header: {e}")))?;
        let body = &rest[hlen..];
        if body.len() % 4 != 0 {
            return Err(ThermoError::Format(
                "value bytes not a multiple of 4".into(),
            ));
        }
        let values = body
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        Table::new(header, values)
    }

    /// Serializes to `.rwtbl` bytes (deterministic: same table, same bytes).
    ///
    /// cite: n/a file-format writer, no physics
    pub fn to_bytes(&self) -> Vec<u8> {
        let header = serde_json::to_vec(&self.header).expect("header serializes");
        let mut out = Vec::with_capacity(12 + header.len() + 4 * self.values.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&(header.len() as u32).to_le_bytes());
        out.extend_from_slice(&header);
        for v in &self.values {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    }

    /// cite: n/a accessor, no physics
    pub fn header(&self) -> &Header {
        &self.header
    }

    /// The stored values (layout in the module docs).
    ///
    /// cite: n/a accessor, no physics
    pub fn values(&self) -> &[f32] {
        &self.values
    }

    fn mode_index(&self, mode: Mode) -> Result<usize, ThermoError> {
        self.header
            .modes
            .iter()
            .position(|m| *m == mode)
            .ok_or(ThermoError::NoMode(mode))
    }

    /// Multilinear blend of `n` consecutive values starting at `field` within
    /// each node, over the (O/F, Pc) cell and, when given, an eps cell.
    fn blend<const N: usize>(
        &self,
        mode: usize,
        of: Cell,
        pc: Cell,
        field: impl Fn(usize) -> usize,
        eps: Option<Cell>,
    ) -> Result<[f64; N], ThermoError> {
        let h = &self.header;
        let mut out = [0.0f64; N];
        let eps_corners: &[(usize, f64)] = &match eps {
            Some(e) if h.eps.len() > 1 => [(e.i, 1.0 - e.t), (e.i + 1, e.t)],
            Some(e) => [(e.i, 1.0), (e.i, 0.0)],
            None => [(0, 1.0), (0, 0.0)],
        };
        for (di, wi) in [(0, 1.0 - of.t), (1, of.t)] {
            for (dj, wj) in [(0, 1.0 - pc.t), (1, pc.t)] {
                let (i, j) = (
                    (of.i + di).min(h.of.len() - 1),
                    (pc.i + dj).min(h.pc_pa.len() - 1),
                );
                let base = h.node_offset(mode, i, j);
                for &(k, wk) in eps_corners {
                    let w = wi * wj * wk;
                    if w == 0.0 {
                        continue;
                    }
                    let start = base + field(k);
                    for (n, o) in out.iter_mut().enumerate() {
                        let v = f64::from(self.values[start + n]);
                        if !v.is_finite() {
                            return Err(ThermoError::NoData);
                        }
                        *o += w * v;
                    }
                }
            }
        }
        Ok(out)
    }

    fn cells(&self, of: f64, pc: f64) -> Result<(Cell, Cell), ThermoError> {
        let h = &self.header;
        Ok((
            locate(&h.of, of, "of", |x| x)?,
            locate(&h.pc_pa, pc, "pc", f64::ln)?,
        ))
    }

    /// Chamber and throat conditions at mixture ratio `of` and chamber
    /// pressure `pc` (Pa): bilinear in (O/F, ln Pc).
    ///
    /// cite: n/a multilinear interpolation of NASA CEA (RP-1311) table values
    pub fn chamber(&self, mode: Mode, of: f64, pc: f64) -> Result<Chamber, ThermoError> {
        let m = self.mode_index(mode)?;
        let (co, cp) = self.cells(of, pc)?;
        let v: [f64; 9] = self.blend(m, co, cp, |_| 0, None)?;
        Ok(Chamber {
            t_c: v[0],
            molar_mass_c: v[1],
            gamma_c: v[2],
            cp_c: v[3],
            c_star: v[4],
            rho_c: v[5],
            t_t: v[6],
            p_t: v[7],
            gamma_t: v[8],
        })
    }

    /// Nozzle performance at area ratio `eps`: trilinear in (O/F, ln Pc,
    /// ln eps); `cf` and `cf_vac` are the interpolated Isp over c*.
    ///
    /// cite: n/a multilinear interpolation of NASA CEA (RP-1311) table values
    pub fn nozzle(&self, mode: Mode, of: f64, pc: f64, eps: f64) -> Result<Nozzle, ThermoError> {
        let m = self.mode_index(mode)?;
        let (co, cp) = self.cells(of, pc)?;
        let ce = locate(&self.header.eps, eps, "eps", f64::ln)?;
        let nc = CHAMBER_FIELDS.len();
        let nn = NOZZLE_FIELDS.len();
        let v: [f64; 6] = self.blend(m, co, cp, |k| nc + k * nn, Some(ce))?;
        let c_star = self.blend::<1>(m, co, cp, |_| 4, None)?[0];
        Ok(Nozzle {
            eps,
            pc_pe: v[0],
            t_e: v[1],
            gamma_e: v[2],
            mach_e: v[3],
            isp: v[4],
            isp_vac: v[5],
            cf: v[4] / c_star,
            cf_vac: v[5] / c_star,
        })
    }

    /// Chamber conditions plus, with `eps`, nozzle performance.
    ///
    /// cite: n/a multilinear interpolation of NASA CEA (RP-1311) table values
    pub fn performance(
        &self,
        mode: Mode,
        of: f64,
        pc: f64,
        eps: Option<f64>,
    ) -> Result<Performance, ThermoError> {
        Ok(Performance {
            mode,
            of,
            pc,
            chamber: self.chamber(mode, of, pc)?,
            nozzle: eps.map(|e| self.nozzle(mode, of, pc, e)).transpose()?,
        })
    }

    /// Answers a [`Query`] (checks the propellant ids against the header).
    ///
    /// cite: n/a multilinear interpolation of NASA CEA (RP-1311) table values
    pub fn lookup(&self, q: &Query) -> Result<Performance, ThermoError> {
        for (what, want, have) in [
            ("oxidizer", &q.oxidizer, &self.header.oxidizer.id),
            ("fuel", &q.fuel, &self.header.fuel.id),
        ] {
            if let Some(w) = want
                && w != have
            {
                return Err(ThermoError::InvalidQuery(format!(
                    "{what} `{w}` does not match table `{}` ({have})",
                    self.header.pair
                )));
            }
        }
        let mode = if q.frozen {
            Mode::Frozen
        } else {
            Mode::Equilibrium
        };
        self.performance(mode, q.of, q.pc, q.eps)
    }
}

#[cfg(test)]
mod tests;
