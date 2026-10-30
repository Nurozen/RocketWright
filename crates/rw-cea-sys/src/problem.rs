//! Problem and result types for the safe CEA layer. Plain data: compiled with
//! or without the `cea` feature so callers can build requests either way.

use std::fmt;
use std::path::PathBuf;

use crate::units::EnthalpyUnit;

/// One reactant of a rocket problem.
#[derive(Debug, Clone, PartialEq)]
pub enum Reactant {
    /// A species in CEA's thermo database (e.g. `"O2(L)"`), at `t_k`. CEA
    /// computes its enthalpy from the database at that temperature.
    Db { name: String, t_k: f64 },
    /// A species defined by its formula and assigned enthalpy (the RP-1311
    /// `reac` dataset). `t_k` does not change `enthalpy`: supply h(T).
    Custom {
        name: String,
        /// Element symbol and atom count, e.g. `[("N", 2.0), ("O", 1.0)]`.
        formula: Vec<(String, f64)>,
        enthalpy: f64,
        enthalpy_unit: EnthalpyUnit,
        t_k: f64,
    },
}

impl Reactant {
    pub fn db(name: &str, t_k: f64) -> Self {
        Reactant::Db {
            name: name.to_string(),
            t_k,
        }
    }

    /// A custom reactant with its enthalpy in J/mol (SI; preferred).
    pub fn custom_j_per_mol(
        name: &str,
        formula: &[(&str, f64)],
        h_j_per_mol: f64,
        t_k: f64,
    ) -> Self {
        Reactant::Custom {
            name: name.to_string(),
            formula: formula.iter().map(|(e, n)| (e.to_string(), *n)).collect(),
            enthalpy: h_j_per_mol,
            enthalpy_unit: EnthalpyUnit::JPerMole,
            t_k,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Reactant::Db { name, .. } | Reactant::Custom { name, .. } => name,
        }
    }

    pub fn t_k(&self) -> f64 {
        match self {
            Reactant::Db { t_k, .. } | Reactant::Custom { t_k, .. } => *t_k,
        }
    }
}

/// The role of a reactant in a mixture (the deck's `fuel=`, `oxid=`, `name=`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    Fuel,
    Oxidizer,
    /// Neither fuel nor oxidizer (only with [`Ratio::AsGiven`]).
    Name,
}

/// One reactant with its role and relative amount (in the problem's [`Basis`]).
#[derive(Debug, Clone, PartialEq)]
pub struct Component {
    pub reactant: Reactant,
    pub role: Role,
    /// Relative amount within its role (or across all reactants for
    /// [`Ratio::AsGiven`]); need not sum to 1.
    pub amount: f64,
}

impl Component {
    pub fn fuel(reactant: Reactant, amount: f64) -> Self {
        Component {
            reactant,
            role: Role::Fuel,
            amount,
        }
    }

    pub fn oxidizer(reactant: Reactant, amount: f64) -> Self {
        Component {
            reactant,
            role: Role::Oxidizer,
            amount,
        }
    }

    pub fn name(reactant: Reactant, amount: f64) -> Self {
        Component {
            reactant,
            role: Role::Name,
            amount,
        }
    }
}

/// Whether [`Component::amount`] is a mass (`wt%`) or a mole amount (`moles`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Basis {
    #[default]
    Weight,
    Moles,
}

/// How fuel and oxidizer combine.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Ratio {
    /// Oxidizer-to-fuel mass ratio (`o/f=`).
    OxFuel(f64),
    /// Fuel mass percentage (`%fuel=`).
    PctFuel(f64),
    /// The component amounts are the mixture (no fuel/oxidizer split).
    AsGiven,
}

/// Combustor model.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub enum Combustor {
    /// Infinite-area combustor (`rocket iac`): stations `[chamber, throat, exits...]`.
    #[default]
    Iac,
    /// Finite-area combustor with contraction ratio Ac/At (`fac acat=`):
    /// stations `[injector, infinity, combustor end, throat, exits...]`
    /// (CEA 3 also returns the infinite-area point the legacy output omits).
    FacAcat(f64),
    /// Finite-area combustor with mass flow per chamber area, kg/(s m^2) (`fac ma=`).
    FacMdotPerArea(f64),
}

impl Combustor {
    /// Stations before the exit points: 2 (chamber, throat) or 4 (injector,
    /// infinity, combustor end, throat).
    pub fn leading_stations(&self) -> usize {
        match self {
            Combustor::Iac => 2,
            _ => 4,
        }
    }
}

/// Product-species options (`only`, `omit`, `insert`, `ions`, `trace`, `transport`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Products {
    /// Consider only these species (empty: every species the reactants' elements allow).
    pub only: Vec<String>,
    /// Exclude these species (ignored with `only`).
    pub omit: Vec<String>,
    /// Condensed species to include from the first point (`insert`).
    pub insert: Vec<String>,
    /// Include ionized species.
    pub ions: bool,
    /// Trace cutoff for mole fractions (`None`: CEA's default).
    pub trace: Option<f64>,
    /// Compute transport properties (viscosity, conductivity, Prandtl number).
    pub transport: bool,
}

/// A rocket problem (RP-1311 `problem rocket`).
#[derive(Debug, Clone, PartialEq)]
pub struct RocketProblem {
    pub reactants: Vec<Component>,
    pub basis: Basis,
    pub ratio: Ratio,
    pub pc_bar: f64,
    pub exit: Exit,
    pub combustor: Combustor,
    /// `None`: equilibrium; `Some(n)`: frozen at station `n` (1 chamber, 2 throat).
    pub frozen: Option<u32>,
    pub products: Products,
}

impl RocketProblem {
    /// One fuel and one oxidizer at mixture ratio `of`, IAC, default products.
    pub fn bipropellant(fuel: Reactant, oxid: Reactant, of: f64, pc_bar: f64, exit: Exit) -> Self {
        RocketProblem {
            reactants: vec![Component::fuel(fuel, 1.0), Component::oxidizer(oxid, 1.0)],
            basis: Basis::Weight,
            ratio: Ratio::OxFuel(of),
            pc_bar,
            exit,
            combustor: Combustor::Iac,
            frozen: None,
            products: Products::default(),
        }
    }

    /// Number of stations CEA returns.
    pub fn num_stations(&self) -> usize {
        self.combustor.leading_stations() + self.exit.num_exit_points()
    }
}

/// An assigned temperature and pressure problem (RP-1311 `problem tp`): one
/// equilibrium state per `(t, p)` pair, temperatures outer and pressures
/// inner (CEA's own order).
#[derive(Debug, Clone, PartialEq)]
pub struct TpProblem {
    pub reactants: Vec<Component>,
    pub basis: Basis,
    pub ratio: Ratio,
    pub p_bar: Vec<f64>,
    pub t_k: Vec<f64>,
    pub products: Products,
}

/// One equilibrium state. SI units as CEA reports them: K, bar, kg/m^3,
/// kJ/kg, kJ/(kg K), kg/kmol.
#[derive(Debug, Clone, PartialEq)]
pub struct EqState {
    pub t_k: f64,
    pub p_bar: f64,
    pub rho: f64,
    pub h: f64,
    pub u: f64,
    pub g: f64,
    pub s: f64,
    /// Molecular weight M (1/n), kg/kmol.
    pub m: f64,
    /// Molecular weight MW (mole-fraction weighted), kg/kmol.
    pub mw: f64,
    pub cp_eq: f64,
    pub cp_frozen: f64,
    pub gamma_s: f64,
}

/// Exit stations after the chamber and throat, in CEA's order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Exit {
    /// Chamber-to-exit pressure ratios Pc/Pe.
    pub pi_p: Vec<f64>,
    /// Subsonic area ratios Ae/At.
    pub subar: Vec<f64>,
    /// Supersonic area ratios Ae/At.
    pub supar: Vec<f64>,
}

impl Exit {
    pub fn supar(eps: &[f64]) -> Self {
        Exit {
            supar: eps.to_vec(),
            ..Exit::default()
        }
    }

    /// Number of stations CEA returns for an IAC problem: chamber, throat,
    /// then every exit point.
    pub fn num_stations(&self) -> usize {
        2 + self.num_exit_points()
    }

    /// Exit points after the throat.
    pub fn num_exit_points(&self) -> usize {
        self.pi_p.len() + self.subar.len() + self.supar.len()
    }
}

/// Rocket solution, one value per station ordered
/// `[chamber, throat, pi_p..., subar..., supar...]` (IAC) or `[injector,
/// infinity, combustor end, throat, ...]` (FAC). SI units as CEA reports them: K, bar,
/// kg/m^3, m/s, kJ/kg, kJ/(kg K).
#[derive(Debug, Clone, PartialEq)]
pub struct Stations {
    pub t_k: Vec<f64>,
    pub p_bar: Vec<f64>,
    pub rho: Vec<f64>,
    pub h: Vec<f64>,
    pub s: Vec<f64>,
    /// Molecular weight M (1/n), kg/kmol.
    pub m: Vec<f64>,
    /// Molecular weight MW (mole-fraction weighted), kg/kmol.
    pub mw: Vec<f64>,
    pub gamma_s: Vec<f64>,
    pub cp_eq: Vec<f64>,
    pub cp_frozen: Vec<f64>,
    pub mach: Vec<f64>,
    pub sonic_velocity: Vec<f64>,
    pub ae_at: Vec<f64>,
    pub c_star: Vec<f64>,
    pub cf: Vec<f64>,
    /// Specific impulse at Pa = Pe, m/s.
    pub isp: Vec<f64>,
    /// Vacuum specific impulse, m/s.
    pub isp_vac: Vec<f64>,
    /// Viscosity, millipoise (only with [`Products::transport`]).
    pub viscosity: Option<Vec<f64>>,
    /// Equilibrium thermal conductivity, mW/(cm K) (only with [`Products::transport`]).
    pub conductivity_eq: Option<Vec<f64>>,
    /// Equilibrium Prandtl number (only with [`Products::transport`]).
    pub prandtl_eq: Option<Vec<f64>>,
}

impl Stations {
    pub fn len(&self) -> usize {
        self.t_k.len()
    }

    pub fn is_empty(&self) -> bool {
        self.t_k.is_empty()
    }
}

/// Errors from the safe CEA layer.
#[derive(Debug, Clone, PartialEq)]
pub enum CeaError {
    /// A CEA call returned a nonzero `cea_err` other than the two mapped
    /// below (codes in [`crate::ffi`] with the `cea` feature).
    Call {
        call: &'static str,
        code: i32,
        message: String,
    },
    /// `CEA_FORTRAN_ABORT` (10): CEA hit a fatal Fortran `abort` (unknown
    /// species, bad formula, invalid area ratio, ...). CEA's setjmp guard
    /// recovered it, so the process and the database are intact; `message`
    /// is CEA's text (`cea_last_error_message_buf`).
    FortranAbort { call: &'static str, message: String },
    /// The solve finished without converging (`CEA_NOT_CONVERGED`, or a
    /// solution whose converged flag is 0).
    NotConverged,
    /// The thermo/trans data directory is not usable.
    DataDir { dir: PathBuf, reason: String },
    /// No candidate location holds the compiled databases (see
    /// [`crate::data::locate_data_dir`]).
    DataNotFound { tried: Vec<PathBuf> },
    /// CEA is already initialized with a different data directory (the
    /// database is process global and cannot be reloaded).
    AlreadyInitialized { dir: PathBuf },
    /// A request CEA would misread or reject (bad name, NUL byte, ...).
    InvalidInput(String),
}

impl fmt::Display for CeaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CeaError::Call {
                call,
                code,
                message,
            } => {
                write!(f, "CEA {call} failed with code {code}")?;
                if !message.is_empty() {
                    write!(f, ": {message}")?;
                }
                Ok(())
            }
            CeaError::FortranAbort { call, message } => {
                write!(f, "CEA {call} aborted (CEA_FORTRAN_ABORT)")?;
                if !message.is_empty() {
                    write!(f, ": {message}")?;
                }
                Ok(())
            }
            CeaError::NotConverged => f.write_str("CEA solve did not converge"),
            CeaError::DataNotFound { tried } => {
                f.write_str("CEA thermo data (thermo.lib, trans.lib) not found; tried")?;
                for t in tried {
                    write!(f, " {}", t.display())?;
                }
                f.write_str(" (set RW_CEA_DATA to the directory holding them)")
            }
            CeaError::DataDir { dir, reason } => {
                write!(f, "CEA data dir {}: {reason}", dir.display())
            }
            CeaError::AlreadyInitialized { dir } => write!(
                f,
                "CEA is already initialized with {} (process-global database)",
                dir.display()
            ),
            CeaError::InvalidInput(s) => write!(f, "invalid CEA input: {s}"),
        }
    }
}

impl std::error::Error for CeaError {}
