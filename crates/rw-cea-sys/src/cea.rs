//! Safe layer over the CEA C binding.
//!
//! CEA's thermo/trans database is a single process global that cannot be
//! reloaded, and initialization is not thread safe (`cea.h`). So:
//! - [`Cea::init`] loads it exactly once (a `OnceLock`) from an absolute
//!   directory holding `thermo.lib` and `trans.lib`; a second call with the
//!   same directory returns the same handle, a different one is an error;
//! - every CEA call sequence runs under one process-wide `Mutex`.
//!
//! Every C call goes through CEA's setjmp/longjmp guard, so a Fortran abort
//! comes back as `CEA_FORTRAN_ABORT` instead of unwinding through Rust.

use std::ffi::{CString, c_char, c_int};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::ffi::{self, Handle, ReactantInput};
use crate::problem::{
    Basis, CeaError, Combustor, Component, EqState, Exit, Products, Ratio, Reactant, RocketProblem,
    Role, Stations, TpProblem,
};
use crate::units::TempUnit;

/// Directory of the compiled databases produced by this crate's build
/// (`$OUT_DIR/install/share/cea`). A build-tree path: for in-tree tests and
/// table generation only. Shipped binaries locate the data with
/// [`Cea::locate_data_dir`].
pub const BUILD_DATA_DIR: &str = env!("RW_CEA_BUILD_DATA_DIR");

/// Serializes every CEA call (and initialization) in the process.
static DB_LOCK: Mutex<()> = Mutex::new(());
static CEA: OnceLock<Cea> = OnceLock::new();

/// Handle to the initialized, process-global CEA database.
#[derive(Debug)]
pub struct Cea {
    data_dir: PathBuf,
}

fn lock() -> MutexGuard<'static, ()> {
    // A panic while holding the lock leaves no Rust state to repair; CEA's
    // own state is per-call (handles are destroyed by their guards).
    DB_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn last_error_message() -> String {
    let mut len: ffi::CeaInt = 0;
    // SAFETY: plain out-parameter.
    if unsafe { ffi::cea_last_error_message_len(&mut len) } != ffi::CEA_SUCCESS || len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u8; len as usize + 1];
    // SAFETY: buf holds len+1 bytes; CEA writes at most buf_len bytes.
    let rc = unsafe {
        ffi::cea_last_error_message_buf(buf.as_mut_ptr().cast::<c_char>(), buf.len() as ffi::CeaInt)
    };
    if rc != ffi::CEA_SUCCESS {
        return String::new();
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).trim().to_string()
}

/// Maps a `cea_err` to [`CeaError`]: `CEA_FORTRAN_ABORT` (a recovered
/// Fortran `abort`) and `CEA_NOT_CONVERGED` get their own variants.
fn check(call: &'static str, code: ffi::CeaErr) -> Result<(), CeaError> {
    match code {
        ffi::CEA_SUCCESS => Ok(()),
        ffi::CEA_FORTRAN_ABORT => Err(CeaError::FortranAbort {
            call,
            message: last_error_message(),
        }),
        ffi::CEA_NOT_CONVERGED => Err(CeaError::NotConverged),
        _ => Err(CeaError::Call {
            call,
            code,
            message: last_error_message(),
        }),
    }
}

fn cstring(what: &str, s: &str) -> Result<CString, CeaError> {
    CString::new(s).map_err(|_| CeaError::InvalidInput(format!("{what} `{s}` contains a NUL byte")))
}

impl Cea {
    /// Loads `thermo.lib` and `trans.lib` from `data_dir` (absolute) once per
    /// process and returns the shared handle.
    pub fn init(data_dir: impl AsRef<Path>) -> Result<&'static Cea, CeaError> {
        let dir = data_dir.as_ref();
        if !dir.is_absolute() {
            return Err(CeaError::DataDir {
                dir: dir.to_path_buf(),
                reason: "must be an absolute path".into(),
            });
        }
        let _guard = lock();
        if let Some(cea) = CEA.get() {
            return if cea.data_dir == dir {
                Ok(cea)
            } else {
                Err(CeaError::AlreadyInitialized {
                    dir: cea.data_dir.clone(),
                })
            };
        }
        let thermo = dir.join("thermo.lib");
        let trans = dir.join("trans.lib");
        for f in [&thermo, &trans] {
            if !f.is_file() {
                return Err(CeaError::DataDir {
                    dir: dir.to_path_buf(),
                    reason: format!("missing {}", f.display()),
                });
            }
        }
        let path_c = |p: &Path| {
            p.to_str()
                .ok_or_else(|| CeaError::DataDir {
                    dir: dir.to_path_buf(),
                    reason: "path is not UTF-8".into(),
                })
                .and_then(|s| cstring("data path", s))
        };
        let (thermo_c, trans_c) = (path_c(&thermo)?, path_c(&trans)?);
        // SAFETY: valid NUL-terminated paths; serialized by DB_LOCK and run once.
        unsafe {
            check(
                "cea_set_log_level",
                ffi::cea_set_log_level(ffi::CEA_LOG_NONE),
            )?;
            check("cea_init_thermo", ffi::cea_init_thermo(thermo_c.as_ptr()))?;
            check("cea_init_trans", ffi::cea_init_trans(trans_c.as_ptr()))?;
        }
        Ok(CEA.get_or_init(|| Cea {
            data_dir: dir.to_path_buf(),
        }))
    }

    /// The handle, if [`Cea::init`] has succeeded in this process.
    pub fn get() -> Option<&'static Cea> {
        CEA.get()
    }

    /// The directory the database was loaded from.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Where a shipped binary finds the compiled databases: `$RW_CEA_DATA`,
    /// then `<bin>/../share/rocketwright/cea/` beside the executable, then
    /// the app bundle's `Resources/cea` ([`crate::data::locate_data_dir`]).
    /// Never a build-tree path.
    pub fn locate_data_dir() -> Result<PathBuf, CeaError> {
        crate::data::locate_data_dir()
    }

    /// [`Cea::init`] from [`Cea::locate_data_dir`] (what a shipped binary calls).
    pub fn init_located() -> Result<&'static Cea, CeaError> {
        Cea::init(Cea::locate_data_dir()?)
    }

    /// CEA library version `(major, minor, patch)`.
    pub fn version(&self) -> Result<(i32, i32, i32), CeaError> {
        let _guard = lock();
        let (mut a, mut b, mut c) = (0, 0, 0);
        // SAFETY: plain out-parameters.
        unsafe {
            check("cea_version_major", ffi::cea_version_major(&mut a))?;
            check("cea_version_minor", ffi::cea_version_minor(&mut b))?;
            check("cea_version_patch", ffi::cea_version_patch(&mut c))?;
        }
        Ok((a, b, c))
    }

    /// Infinite-area-combustor rocket solve for one fuel and one oxidizer at
    /// mixture ratio `of` and chamber pressure `pc_bar`. `frozen = None` is
    /// equilibrium flow; `Some(n)` freezes composition at station `n`
    /// (1 = chamber, 2 = throat). Shorthand for [`Cea::rocket`].
    pub fn rocket_iac(
        &self,
        fuel: &Reactant,
        oxid: &Reactant,
        of: f64,
        pc_bar: f64,
        exit: &Exit,
        frozen: Option<u32>,
    ) -> Result<Stations, CeaError> {
        let mut p =
            RocketProblem::bipropellant(fuel.clone(), oxid.clone(), of, pc_bar, exit.clone());
        p.frozen = frozen;
        self.rocket(&p)
    }

    /// A rocket problem (RP-1311 `problem rocket`, IAC or FAC), the same
    /// sequence CEA's own deck driver runs: reactant weights from the
    /// component amounts and ratio, the reactants' enthalpy at their
    /// temperatures as `hc`, then one solve.
    pub fn rocket(&self, p: &RocketProblem) -> Result<Stations, CeaError> {
        if !(p.pc_bar.is_finite() && p.pc_bar > 0.0) {
            return Err(CeaError::InvalidInput(format!(
                "Pc must be > 0 bar (got {})",
                p.pc_bar
            )));
        }
        let exit = &p.exit;
        for (what, list, min) in [
            ("pi_p", &exit.pi_p, 1.0),
            ("subar", &exit.subar, 1.0),
            ("supar", &exit.supar, 1.0),
        ] {
            if let Some(v) = list.iter().find(|v| !(v.is_finite() && **v > min)) {
                return Err(CeaError::InvalidInput(format!(
                    "{what} entries must be > {min} (got {v})"
                )));
            }
        }
        let n_frz = match p.frozen {
            None => 0,
            Some(n @ 1..=2) => n as c_int,
            Some(n) => {
                return Err(CeaError::InvalidInput(format!(
                    "frozen station must be 1 (chamber) or 2 (throat), got {n}"
                )));
            }
        };
        let (fac, mdot_or_acat, use_mdot) = match p.combustor {
            Combustor::Iac => (false, 0.0, false),
            Combustor::FacAcat(a) => (true, a, false),
            Combustor::FacMdotPerArea(m) => (true, m, true),
        };
        if fac && !(mdot_or_acat.is_finite() && mdot_or_acat > 0.0) {
            return Err(CeaError::InvalidInput(format!(
                "finite-area combustor parameter must be > 0 (got {mdot_or_acat})"
            )));
        }
        let n_stations = p.num_stations();
        let req = Request::new(&p.reactants, p.basis, p.ratio, &p.products)?;

        // Declared first so it is released last, after the handles are destroyed.
        let _guard = lock();
        let mix = req.mixtures()?;
        let mut solver = Guard::new(ffi::cea_rocket_solver_destroy);
        let mut soln = Guard::new(ffi::cea_rocket_solution_destroy);
        let mut converged: c_int = 0;
        let mut n: ffi::CeaInt = 0;
        let arr = |v: &Vec<f64>| {
            if v.is_empty() {
                ptr::null()
            } else {
                v.as_ptr()
            }
        };
        // SAFETY: every pointer refers to storage alive for the block (`req`,
        // `mix`, `exit`), with the lengths passed; handles are created before
        // use and destroyed by their guards; DB_LOCK is held.
        unsafe {
            let opts = req.solver_opts(mix.reac.0)?;
            check(
                "cea_rocket_solver_create_with_options",
                ffi::cea_rocket_solver_create_with_options(&mut solver.0, mix.prod.0, opts),
            )?;
            check(
                "cea_rocket_solution_create",
                ffi::cea_rocket_solution_create(&mut soln.0, solver.0),
            )?;
            let hc = mix.enthalpy_over_r(&req.temps)?;
            if fac {
                check(
                    "cea_rocket_solver_solve_fac",
                    ffi::cea_rocket_solver_solve_fac(
                        solver.0,
                        soln.0,
                        mix.weights.as_ptr(),
                        p.pc_bar,
                        arr(&exit.pi_p),
                        exit.pi_p.len() as ffi::CeaInt,
                        arr(&exit.subar),
                        exit.subar.len() as ffi::CeaInt,
                        arr(&exit.supar),
                        exit.supar.len() as ffi::CeaInt,
                        n_frz,
                        hc,
                        true,
                        mdot_or_acat,
                        use_mdot,
                        0.0,
                        false,
                    ),
                )?;
            } else {
                check(
                    "cea_rocket_solver_solve_iac",
                    ffi::cea_rocket_solver_solve_iac(
                        solver.0,
                        soln.0,
                        mix.weights.as_ptr(),
                        p.pc_bar,
                        arr(&exit.pi_p),
                        exit.pi_p.len() as ffi::CeaInt,
                        arr(&exit.subar),
                        exit.subar.len() as ffi::CeaInt,
                        arr(&exit.supar),
                        exit.supar.len() as ffi::CeaInt,
                        n_frz,
                        hc,
                        true,
                        0.0,
                        false,
                    ),
                )?;
            }
            check(
                "cea_rocket_solution_get_converged",
                ffi::cea_rocket_solution_get_converged(soln.0, &mut converged),
            )?;
            if converged == 0 {
                return Err(CeaError::NotConverged);
            }
            check(
                "cea_rocket_solution_get_size",
                ffi::cea_rocket_solution_get_size(soln.0, &mut n),
            )?;
        }
        if n as usize != n_stations {
            return Err(CeaError::Call {
                call: "cea_rocket_solution_get_size",
                code: ffi::CEA_INVALID_SIZE,
                message: format!("expected {n_stations} stations, CEA returned {n}"),
            });
        }
        let get = |prop: c_int, call: &'static str| -> Result<Vec<f64>, CeaError> {
            let mut v = vec![0.0; n_stations];
            // SAFETY: v holds n entries; soln is live; DB_LOCK is held.
            check(call, unsafe {
                ffi::cea_rocket_solution_get_property(soln.0, prop, n, v.as_mut_ptr())
            })?;
            Ok(v)
        };
        let transport = |prop: c_int, call: &'static str| -> Result<Option<Vec<f64>>, CeaError> {
            if p.products.transport {
                get(prop, call).map(Some)
            } else {
                Ok(None)
            }
        };
        Ok(Stations {
            t_k: get(ffi::CEA_ROCKET_TEMPERATURE, "get_property(T)")?,
            p_bar: get(ffi::CEA_ROCKET_PRESSURE, "get_property(P)")?,
            rho: get(ffi::CEA_ROCKET_DENSITY, "get_property(rho)")?,
            h: get(ffi::CEA_ROCKET_ENTHALPY, "get_property(h)")?,
            s: get(ffi::CEA_ROCKET_ENTROPY, "get_property(s)")?,
            m: get(ffi::CEA_ROCKET_M, "get_property(M)")?,
            mw: get(ffi::CEA_ROCKET_MW, "get_property(MW)")?,
            gamma_s: get(ffi::CEA_ROCKET_GAMMA_S, "get_property(gamma_s)")?,
            cp_eq: get(ffi::CEA_ROCKET_EQUILIBRIUM_CP, "get_property(cp_eq)")?,
            cp_frozen: get(ffi::CEA_ROCKET_FROZEN_CP, "get_property(cp_fr)")?,
            mach: get(ffi::CEA_MACH, "get_property(Mach)")?,
            sonic_velocity: get(ffi::CEA_SONIC_VELOCITY, "get_property(a)")?,
            ae_at: get(ffi::CEA_AE_AT, "get_property(Ae/At)")?,
            c_star: get(ffi::CEA_C_STAR, "get_property(c*)")?,
            cf: get(ffi::CEA_COEFFICIENT_OF_THRUST, "get_property(Cf)")?,
            isp: get(ffi::CEA_ISP, "get_property(Isp)")?,
            isp_vac: get(ffi::CEA_ISP_VACUUM, "get_property(Ivac)")?,
            viscosity: transport(ffi::CEA_ROCKET_VISCOSITY, "get_property(visc)")?,
            conductivity_eq: transport(
                ffi::CEA_ROCKET_EQUILIBRIUM_CONDUCTIVITY,
                "get_property(k_eq)",
            )?,
            prandtl_eq: transport(ffi::CEA_ROCKET_EQUILIBRIUM_PRANDTL, "get_property(Pr_eq)")?,
        })
    }

    /// An assigned temperature and pressure problem (RP-1311 `problem tp`):
    /// one equilibrium state per `(t, p)`, temperatures outer and pressures
    /// inner (CEA's order).
    pub fn tp(&self, p: &TpProblem) -> Result<Vec<EqState>, CeaError> {
        if p.t_k.is_empty() || p.p_bar.is_empty() {
            return Err(CeaError::InvalidInput(
                "tp needs at least one temperature and one pressure".into(),
            ));
        }
        if let Some(v) = p
            .t_k
            .iter()
            .chain(&p.p_bar)
            .find(|v| !(v.is_finite() && **v > 0.0))
        {
            return Err(CeaError::InvalidInput(format!(
                "tp temperatures and pressures must be > 0 (got {v})"
            )));
        }
        let req = Request::new(&p.reactants, p.basis, p.ratio, &p.products)?;

        let _guard = lock();
        let mix = req.mixtures()?;
        let mut solver = Guard::new(ffi::cea_eqsolver_destroy);
        let mut out = Vec::with_capacity(p.t_k.len() * p.p_bar.len());
        // SAFETY: as in `rocket`. Each point gets a fresh solution and
        // partials object: CEA computes cp_fr, cp_eq, and gamma_s only on a
        // solution's first solve, so a reused one would report stale values.
        unsafe {
            let opts = req.solver_opts(mix.reac.0)?;
            check(
                "cea_eqsolver_create_with_options",
                ffi::cea_eqsolver_create_with_options(&mut solver.0, mix.prod.0, opts),
            )?;
            for &t in &p.t_k {
                for &pb in &p.p_bar {
                    let mut partials = Guard::new(ffi::cea_eqpartials_destroy);
                    let mut soln = Guard::new(ffi::cea_eqsolution_destroy);
                    check(
                        "cea_eqsolution_create",
                        ffi::cea_eqsolution_create(&mut soln.0, solver.0),
                    )?;
                    check(
                        "cea_eqpartials_create",
                        ffi::cea_eqpartials_create(&mut partials.0, solver.0),
                    )?;
                    check(
                        "cea_eqsolver_solve_with_partials",
                        ffi::cea_eqsolver_solve_with_partials(
                            solver.0,
                            ffi::CEA_TP,
                            t,
                            pb,
                            mix.weights.as_ptr(),
                            soln.0,
                            partials.0,
                        ),
                    )?;
                    let mut converged: c_int = 0;
                    check(
                        "cea_eqsolution_get_converged",
                        ffi::cea_eqsolution_get_converged(soln.0, &mut converged),
                    )?;
                    if converged == 0 {
                        return Err(CeaError::NotConverged);
                    }
                    let get = |prop: c_int| -> Result<f64, CeaError> {
                        let mut v = 0.0;
                        check(
                            "cea_eqsolution_get_property",
                            ffi::cea_eqsolution_get_property(soln.0, prop, &mut v),
                        )?;
                        Ok(v)
                    };
                    out.push(EqState {
                        t_k: get(ffi::CEA_TEMPERATURE)?,
                        p_bar: get(ffi::CEA_PRESSURE)?,
                        rho: get(ffi::CEA_DENSITY)?,
                        h: get(ffi::CEA_ENTHALPY)?,
                        u: get(ffi::CEA_ENERGY)?,
                        g: get(ffi::CEA_GIBBS_ENERGY)?,
                        s: get(ffi::CEA_ENTROPY)?,
                        m: get(ffi::CEA_M)?,
                        mw: get(ffi::CEA_MW)?,
                        cp_eq: get(ffi::CEA_EQUILIBRIUM_CP)?,
                        cp_frozen: get(ffi::CEA_FROZEN_CP)?,
                        gamma_s: get(ffi::CEA_GAMMA_S)?,
                    });
                }
            }
        }
        Ok(out)
    }
}

/// The C-side storage for one problem's reactants and product options,
/// built (and validated) before taking the lock.
struct Request {
    owned: Vec<OwnedReactant>,
    inputs: Vec<ReactantInput>,
    temps: Vec<f64>,
    roles: Vec<Role>,
    amounts: Vec<f64>,
    basis: Basis,
    ratio: Ratio,
    only: Vec<CString>,
    omit: Vec<CString>,
    insert: Vec<CString>,
    only_ptrs: Vec<*const c_char>,
    omit_ptrs: Vec<*const c_char>,
    insert_ptrs: Vec<*const c_char>,
    ions: bool,
    trace: Option<f64>,
    transport: bool,
}

/// The live reactant and product mixtures plus the reactant weights.
struct Mixtures {
    // Field order is drop order: products before reactants.
    prod: Guard,
    reac: Guard,
    weights: Vec<f64>,
}

fn species_list(what: &str, names: &[String]) -> Result<Vec<CString>, CeaError> {
    names
        .iter()
        .map(|n| {
            if n.is_empty() || n.len() > ffi::CEA_SPECIES_NAME_LEN {
                Err(CeaError::InvalidInput(format!(
                    "{what} species `{n}` must be 1-{} bytes",
                    ffi::CEA_SPECIES_NAME_LEN
                )))
            } else {
                cstring(what, n)
            }
        })
        .collect()
}

impl Request {
    fn new(
        reactants: &[Component],
        basis: Basis,
        ratio: Ratio,
        products: &Products,
    ) -> Result<Self, CeaError> {
        if reactants.is_empty() {
            return Err(CeaError::InvalidInput("no reactants".into()));
        }
        let has = |r: Role| reactants.iter().any(|c| c.role == r);
        match ratio {
            Ratio::OxFuel(v) | Ratio::PctFuel(v) => {
                if !(has(Role::Fuel) && has(Role::Oxidizer)) || has(Role::Name) {
                    return Err(CeaError::InvalidInput(
                        "an O/F or %fuel ratio needs fuel and oxidizer reactants only".into(),
                    ));
                }
                let ok = match ratio {
                    Ratio::OxFuel(_) => v.is_finite() && v > 0.0,
                    _ => v.is_finite() && v > 0.0 && v < 100.0,
                };
                if !ok {
                    return Err(CeaError::InvalidInput(format!(
                        "mixture ratio out of range (got {v})"
                    )));
                }
            }
            Ratio::AsGiven => {}
        }
        if let Some(c) = reactants
            .iter()
            .find(|c| !(c.amount.is_finite() && c.amount >= 0.0))
        {
            return Err(CeaError::InvalidInput(format!(
                "{}: amount must be >= 0 (got {})",
                c.reactant.name(),
                c.amount
            )));
        }
        if let Some(t) = products.trace
            && !(t.is_finite() && t > 0.0 && t < 1.0)
        {
            return Err(CeaError::InvalidInput(format!(
                "trace must be in (0, 1) (got {t})"
            )));
        }
        let owned = reactants
            .iter()
            .map(|c| OwnedReactant::new(&c.reactant))
            .collect::<Result<Vec<_>, _>>()?;
        let inputs = owned.iter().map(OwnedReactant::input).collect();
        let only = species_list("only", &products.only)?;
        let omit = species_list("omit", &products.omit)?;
        let insert = species_list("insert", &products.insert)?;
        let ptrs = |v: &Vec<CString>| v.iter().map(|s| s.as_ptr()).collect::<Vec<_>>();
        Ok(Request {
            only_ptrs: ptrs(&only),
            omit_ptrs: ptrs(&omit),
            insert_ptrs: ptrs(&insert),
            owned,
            inputs,
            temps: reactants.iter().map(|c| c.reactant.t_k()).collect(),
            roles: reactants.iter().map(|c| c.role).collect(),
            amounts: reactants.iter().map(|c| c.amount).collect(),
            basis,
            ratio,
            only,
            omit,
            insert,
            ions: products.ions,
            trace: products.trace,
            transport: products.transport,
        })
    }

    fn len(&self) -> ffi::CeaInt {
        self.owned.len() as ffi::CeaInt
    }

    /// Creates the reactant and product mixtures and computes the reactant
    /// weights (CEA's `get_problem_weights`). Call with DB_LOCK held.
    fn mixtures(&self) -> Result<Mixtures, CeaError> {
        let mut mix = Mixtures {
            prod: Guard::new(ffi::cea_mixture_destroy),
            reac: Guard::new(ffi::cea_mixture_destroy),
            weights: vec![0.0; self.owned.len()],
        };
        let n = self.len();
        // SAFETY: `inputs` points into `owned`; species pointer arrays point
        // into the CString vectors; all alive for `self`. DB_LOCK is held.
        unsafe {
            if self.ions {
                check(
                    "cea_mixture_create_from_input_reactants_w_ions",
                    ffi::cea_mixture_create_from_input_reactants_w_ions(
                        &mut mix.reac.0,
                        n,
                        self.inputs.as_ptr(),
                    ),
                )?;
            } else {
                check(
                    "cea_mixture_create_from_input_reactants",
                    ffi::cea_mixture_create_from_input_reactants(
                        &mut mix.reac.0,
                        n,
                        self.inputs.as_ptr(),
                    ),
                )?;
            }
            if !self.only.is_empty() {
                let k = self.only.len() as ffi::CeaInt;
                if self.ions {
                    check(
                        "cea_mixture_create_w_ions",
                        ffi::cea_mixture_create_w_ions(&mut mix.prod.0, k, self.only_ptrs.as_ptr()),
                    )?;
                } else {
                    check(
                        "cea_mixture_create",
                        ffi::cea_mixture_create(&mut mix.prod.0, k, self.only_ptrs.as_ptr()),
                    )?;
                }
            } else {
                let k = self.omit.len() as ffi::CeaInt;
                let omit = if self.omit.is_empty() {
                    ptr::null()
                } else {
                    self.omit_ptrs.as_ptr()
                };
                if self.ions {
                    check(
                        "cea_mixture_create_products_from_input_reactants_w_ions",
                        ffi::cea_mixture_create_products_from_input_reactants_w_ions(
                            &mut mix.prod.0,
                            n,
                            self.inputs.as_ptr(),
                            k,
                            omit,
                        ),
                    )?;
                } else {
                    check(
                        "cea_mixture_create_products_from_input_reactants",
                        ffi::cea_mixture_create_products_from_input_reactants(
                            &mut mix.prod.0,
                            n,
                            self.inputs.as_ptr(),
                            k,
                            omit,
                        ),
                    )?;
                }
            }

            // Per-role amounts, converted to weights on a mole basis.
            let per_role = |role: Option<Role>| -> Result<Vec<f64>, CeaError> {
                let amounts: Vec<f64> = self
                    .amounts
                    .iter()
                    .zip(&self.roles)
                    .map(|(a, r)| {
                        if role.is_none_or(|x| x == *r) {
                            *a
                        } else {
                            0.0
                        }
                    })
                    .collect();
                match self.basis {
                    Basis::Weight => Ok(amounts),
                    Basis::Moles => {
                        let mut w = vec![0.0; amounts.len()];
                        check(
                            "cea_mixture_moles_to_weights",
                            ffi::cea_mixture_moles_to_weights(
                                mix.reac.0,
                                n,
                                amounts.as_ptr(),
                                w.as_mut_ptr(),
                            ),
                        )?;
                        Ok(w)
                    }
                }
            };
            match self.ratio {
                Ratio::AsGiven => mix.weights = per_role(None)?,
                Ratio::OxFuel(_) | Ratio::PctFuel(_) => {
                    let of = match self.ratio {
                        Ratio::PctFuel(pct) => (100.0 - pct) / pct,
                        Ratio::OxFuel(of) => of,
                        Ratio::AsGiven => unreachable!(),
                    };
                    let ox = per_role(Some(Role::Oxidizer))?;
                    let fu = per_role(Some(Role::Fuel))?;
                    check(
                        "cea_mixture_of_ratio_to_weights",
                        ffi::cea_mixture_of_ratio_to_weights(
                            mix.reac.0,
                            n,
                            ox.as_ptr(),
                            fu.as_ptr(),
                            of,
                            mix.weights.as_mut_ptr(),
                        ),
                    )?;
                }
            }
        }
        if !mix.weights.iter().any(|w| *w > 0.0) {
            return Err(CeaError::InvalidInput(
                "reactant amounts are all zero".into(),
            ));
        }
        Ok(mix)
    }

    /// Solver options (`insert`, `trace`, `ions`, `transport`, reactants).
    /// The returned struct points into `self`.
    fn solver_opts(&self, reac: Handle) -> Result<ffi::SolverOpts, CeaError> {
        let mut opts = std::mem::MaybeUninit::<ffi::SolverOpts>::uninit();
        // SAFETY: cea_solver_opts_init fully initializes the struct.
        let mut opts = unsafe {
            check(
                "cea_solver_opts_init",
                ffi::cea_solver_opts_init(opts.as_mut_ptr()),
            )?;
            opts.assume_init()
        };
        if let Some(t) = self.trace {
            opts.trace = t;
        }
        opts.ions = self.ions;
        opts.transport = self.transport;
        opts.reactants = reac;
        opts.ninsert = self.insert.len() as ffi::CeaInt;
        opts.insert = if self.insert.is_empty() {
            ptr::null()
        } else {
            self.insert_ptrs.as_ptr()
        };
        Ok(opts)
    }
}

impl Mixtures {
    /// `h0/R` of the reactants at their temperatures (K), the `hc` CEA's
    /// deck driver passes to the rocket solver.
    fn enthalpy_over_r(&self, temps: &[f64]) -> Result<f64, CeaError> {
        let n = self.weights.len() as ffi::CeaInt;
        let mut h = 0.0f64;
        // SAFETY: both arrays hold n entries; the mixture is live; DB_LOCK is held.
        check("cea_mixture_calc_property_multitemp", unsafe {
            ffi::cea_mixture_calc_property_multitemp(
                self.reac.0,
                ffi::CEA_ENTHALPY,
                n,
                self.weights.as_ptr(),
                n,
                temps.as_ptr(),
                &mut h,
            )
        })?;
        Ok(h / ffi::CEA_GAS_CONSTANT)
    }
}

/// Destroys a CEA handle on drop (null handles are skipped).
struct Guard(Handle, unsafe extern "C" fn(*mut Handle) -> ffi::CeaErr);

impl Guard {
    fn new(destroy: unsafe extern "C" fn(*mut Handle) -> ffi::CeaErr) -> Self {
        Guard(ptr::null_mut(), destroy)
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the handle was created by the matching CEA constructor
            // and is destroyed once; the caller still holds DB_LOCK.
            unsafe {
                (self.1)(&mut self.0);
            }
            self.0 = ptr::null_mut();
        }
    }
}

/// C-string storage behind one `cea_reactant_input`.
struct OwnedReactant {
    name: CString,
    elements: Vec<CString>,
    element_ptrs: Vec<*const c_char>,
    coefficients: Vec<f64>,
    enthalpy: Option<(f64, &'static std::ffi::CStr)>,
    t_k: f64,
}

impl OwnedReactant {
    fn new(r: &Reactant) -> Result<Self, CeaError> {
        let name = r.name();
        if name.is_empty() || name.len() > ffi::CEA_SPECIES_NAME_LEN {
            return Err(CeaError::InvalidInput(format!(
                "species name `{name}` must be 1-{} bytes",
                ffi::CEA_SPECIES_NAME_LEN
            )));
        }
        let t_k = r.t_k();
        if !(t_k.is_finite() && t_k > 0.0) {
            return Err(CeaError::InvalidInput(format!(
                "{name}: T must be > 0 K (got {t_k})"
            )));
        }
        let mut out = OwnedReactant {
            name: cstring("species name", name)?,
            elements: Vec::new(),
            element_ptrs: Vec::new(),
            coefficients: Vec::new(),
            enthalpy: None,
            t_k,
        };
        if let Reactant::Custom {
            formula,
            enthalpy,
            enthalpy_unit,
            ..
        } = r
        {
            if formula.is_empty() {
                return Err(CeaError::InvalidInput(format!("{name}: empty formula")));
            }
            for (el, count) in formula {
                if el.is_empty() || el.len() > ffi::CEA_ELEMENT_NAME_LEN {
                    return Err(CeaError::InvalidInput(format!(
                        "{name}: element `{el}` must be 1-{} bytes",
                        ffi::CEA_ELEMENT_NAME_LEN
                    )));
                }
                if !(count.is_finite() && *count > 0.0) {
                    return Err(CeaError::InvalidInput(format!(
                        "{name}: {el} count must be > 0"
                    )));
                }
                out.elements.push(cstring("element", el)?);
                out.coefficients.push(*count);
            }
            if !enthalpy.is_finite() {
                return Err(CeaError::InvalidInput(format!(
                    "{name}: enthalpy must be finite"
                )));
            }
            out.element_ptrs = out.elements.iter().map(|e| e.as_ptr()).collect();
            out.enthalpy = Some((*enthalpy, enthalpy_unit.as_cstr()));
        }
        Ok(out)
    }

    /// The C view. Valid while `self` is alive and unmoved in place.
    fn input(&self) -> ReactantInput {
        let custom = !self.elements.is_empty();
        let (has_h, h, h_units) = match self.enthalpy {
            Some((h, u)) => (true, h, u.as_ptr()),
            None => (false, 0.0, ptr::null()),
        };
        ReactantInput {
            name: self.name.as_ptr(),
            num_elements: self.elements.len() as ffi::CeaInt,
            elements: if custom {
                self.element_ptrs.as_ptr()
            } else {
                ptr::null()
            },
            coefficients: if custom {
                self.coefficients.as_ptr()
            } else {
                ptr::null()
            },
            has_molecular_weight: false,
            molecular_weight: 0.0,
            has_enthalpy: has_h,
            enthalpy: h,
            enthalpy_units: h_units,
            has_temperature: true,
            temperature: self.t_k,
            temperature_units: TempUnit::K.as_cstr().as_ptr(),
        }
    }
}
