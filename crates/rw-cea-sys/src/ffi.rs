//! Hand-written FFI declarations for the NASA CEA C binding
//! (`third_party/cea/source/bind/c/cea.h`, enums from `cea_enum.h`). Only the
//! subset RocketWright uses; no bindgen (the header is small and stable).
//!
//! The database is a process global and CEA is not thread safe: call these
//! only through [`crate::Cea`], which serializes every call behind one Mutex.

use std::ffi::{c_char, c_int, c_void};

/// `cea_err` (`CEA_ERROR_CODE_ENUM`).
pub type CeaErr = c_int;
/// `cea_int`.
pub type CeaInt = c_int;
/// `cea_real`.
pub type CeaReal = f64;
/// Opaque handle (`cea_mixture`, `cea_rocket_solver`, `cea_rocket_solution`).
pub type Handle = *mut c_void;

// cea_error_code
pub const CEA_SUCCESS: CeaErr = 0;
pub const CEA_INVALID_FILENAME: CeaErr = 1;
pub const CEA_INVALID_PROPERTY_TYPE: CeaErr = 2;
pub const CEA_INVALID_EQUILIBRIUM_TYPE: CeaErr = 3;
pub const CEA_INVALID_ROCKET_TYPE: CeaErr = 4;
pub const CEA_INVALID_EQUILIBRIUM_SIZE_TYPE: CeaErr = 5;
pub const CEA_INVALID_INDEX: CeaErr = 6;
pub const CEA_INVALID_SIZE: CeaErr = 7;
pub const CEA_NOT_CONVERGED: CeaErr = 8;
pub const CEA_LAST_VALID_SOLUTION: CeaErr = 9;
pub const CEA_FORTRAN_ABORT: CeaErr = 10;

// cea_log_level
pub const CEA_LOG_NONE: c_int = 0;
pub const CEA_LOG_DEBUG: c_int = 10;
pub const CEA_LOG_INFO: c_int = 20;
pub const CEA_LOG_WARNING: c_int = 30;
pub const CEA_LOG_ERROR: c_int = 40;
pub const CEA_LOG_CRITICAL: c_int = 50;

// cea_equilibrium_type
pub const CEA_TP: c_int = 0;
pub const CEA_HP: c_int = 1;

// cea_property_type (mixture, equilibrium solution)
pub const CEA_TEMPERATURE: c_int = 0;
pub const CEA_PRESSURE: c_int = 1;
pub const CEA_DENSITY: c_int = 3;
pub const CEA_M: c_int = 4;
pub const CEA_MW: c_int = 5;
pub const CEA_ENTHALPY: c_int = 6;
pub const CEA_ENERGY: c_int = 7;
pub const CEA_ENTROPY: c_int = 8;
pub const CEA_GIBBS_ENERGY: c_int = 9;
pub const CEA_GAMMA_S: c_int = 10;
pub const CEA_FROZEN_CP: c_int = 11;
pub const CEA_EQUILIBRIUM_CP: c_int = 13;
pub const CEA_VISCOSITY: c_int = 15;

// cea_rocket_property_type
pub const CEA_ROCKET_TEMPERATURE: c_int = 0;
pub const CEA_ROCKET_PRESSURE: c_int = 1;
pub const CEA_ROCKET_DENSITY: c_int = 3;
pub const CEA_ROCKET_M: c_int = 4;
pub const CEA_ROCKET_MW: c_int = 5;
pub const CEA_ROCKET_ENTHALPY: c_int = 6;
pub const CEA_ROCKET_ENERGY: c_int = 7;
pub const CEA_ROCKET_ENTROPY: c_int = 8;
pub const CEA_ROCKET_GIBBS_ENERGY: c_int = 9;
pub const CEA_ROCKET_GAMMA_S: c_int = 10;
pub const CEA_ROCKET_FROZEN_CP: c_int = 11;
pub const CEA_ROCKET_EQUILIBRIUM_CP: c_int = 13;
pub const CEA_MACH: c_int = 15;
pub const CEA_SONIC_VELOCITY: c_int = 16;
pub const CEA_AE_AT: c_int = 17;
pub const CEA_C_STAR: c_int = 18;
pub const CEA_COEFFICIENT_OF_THRUST: c_int = 19;
pub const CEA_ISP: c_int = 20;
pub const CEA_ISP_VACUUM: c_int = 21;
pub const CEA_ROCKET_VISCOSITY: c_int = 22;
pub const CEA_ROCKET_EQUILIBRIUM_CONDUCTIVITY: c_int = 24;
pub const CEA_ROCKET_EQUILIBRIUM_PRANDTL: c_int = 26;

/// Universal gas constant CEA uses for `hc = h/R` (J/kmol-K, `param.f90.in`).
pub const CEA_GAS_CONSTANT: f64 = 8314.51;
/// Maximum species name length (`species_name_len`, `param.f90.in`).
pub const CEA_SPECIES_NAME_LEN: usize = 15;
/// Maximum element symbol length (`element_name_len`, `param.f90.in`).
pub const CEA_ELEMENT_NAME_LEN: usize = 2;

/// `cea_reactant_input` (`cea.h`). C `bool` is Rust `bool`. All pointed-to
/// strings and arrays are copied by CEA during the call.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ReactantInput {
    pub name: *const c_char,
    pub num_elements: CeaInt,
    pub elements: *const *const c_char,
    pub coefficients: *const CeaReal,
    pub has_molecular_weight: bool,
    pub molecular_weight: CeaReal,
    pub has_enthalpy: bool,
    pub enthalpy: CeaReal,
    pub enthalpy_units: *const c_char,
    pub has_temperature: bool,
    pub temperature: CeaReal,
    pub temperature_units: *const c_char,
}

/// `cea_solver_opts` (`cea.h`). Initialize with [`cea_solver_opts_init`].
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct SolverOpts {
    pub trace: CeaReal,
    pub ions: bool,
    pub transport: bool,
    pub reactants: Handle,
    pub ninsert: CeaInt,
    pub insert: *const *const c_char,
    pub smooth_truncation: bool,
    pub truncation_width: CeaReal,
}

unsafe extern "C" {
    pub fn cea_solver_opts_init(opts: *mut SolverOpts) -> CeaErr;

    // Version, logging, errors
    pub fn cea_version_major(major: *mut CeaInt) -> CeaErr;
    pub fn cea_version_minor(minor: *mut CeaInt) -> CeaErr;
    pub fn cea_version_patch(patch: *mut CeaInt) -> CeaErr;
    pub fn cea_set_log_level(level: c_int) -> CeaErr;
    pub fn cea_last_error_message_len(message_len: *mut CeaInt) -> CeaErr;
    pub fn cea_last_error_message_buf(message: *mut c_char, buf_len: CeaInt) -> CeaErr;

    // Initialization (process global, not thread safe)
    pub fn cea_init_thermo(thermofile: *const c_char) -> CeaErr;
    pub fn cea_init_trans(transfile: *const c_char) -> CeaErr;
    pub fn cea_is_initialized(initialized: *mut CeaInt) -> CeaErr;

    // Mixtures
    pub fn cea_mixture_create_from_input_reactants(
        mix: *mut Handle,
        nreactants: CeaInt,
        reactants: *const ReactantInput,
    ) -> CeaErr;
    pub fn cea_mixture_create_products_from_input_reactants(
        mix: *mut Handle,
        nreactants: CeaInt,
        reactants: *const ReactantInput,
        nomit: CeaInt,
        omit: *const *const c_char,
    ) -> CeaErr;
    pub fn cea_mixture_create_from_input_reactants_w_ions(
        mix: *mut Handle,
        nreactants: CeaInt,
        reactants: *const ReactantInput,
    ) -> CeaErr;
    pub fn cea_mixture_create_products_from_input_reactants_w_ions(
        mix: *mut Handle,
        nreactants: CeaInt,
        reactants: *const ReactantInput,
        nomit: CeaInt,
        omit: *const *const c_char,
    ) -> CeaErr;
    /// Products from an explicit species list (the deck's `only`).
    pub fn cea_mixture_create(
        mix: *mut Handle,
        nspecies: CeaInt,
        species: *const *const c_char,
    ) -> CeaErr;
    pub fn cea_mixture_create_w_ions(
        mix: *mut Handle,
        nspecies: CeaInt,
        species: *const *const c_char,
    ) -> CeaErr;
    pub fn cea_mixture_destroy(mix: *mut Handle) -> CeaErr;
    pub fn cea_mixture_moles_to_weights(
        mix: Handle,
        len: CeaInt,
        moles: *const CeaReal,
        weights: *mut CeaReal,
    ) -> CeaErr;
    pub fn cea_mixture_of_ratio_to_weights(
        mix: Handle,
        len: CeaInt,
        oxidant_weights: *const CeaReal,
        fuel_weights: *const CeaReal,
        of_ratio: CeaReal,
        reactant_weights: *mut CeaReal,
    ) -> CeaErr;
    pub fn cea_mixture_calc_property_multitemp(
        mix: Handle,
        prop: c_int,
        len_weights: CeaInt,
        weights: *const CeaReal,
        len_temperatures: CeaInt,
        temperatures: *const CeaReal,
        value: *mut CeaReal,
    ) -> CeaErr;

    // Rocket solver
    pub fn cea_rocket_solver_create_with_reactants(
        solver: *mut Handle,
        products: Handle,
        reactants: Handle,
    ) -> CeaErr;
    pub fn cea_rocket_solver_create_with_options(
        solver: *mut Handle,
        products: Handle,
        options: SolverOpts,
    ) -> CeaErr;
    pub fn cea_rocket_solver_destroy(solver: *mut Handle) -> CeaErr;
    pub fn cea_rocket_solver_solve_iac(
        solver: Handle,
        soln: Handle,
        weights: *const CeaReal,
        pc: CeaReal,
        pi_p: *const CeaReal,
        n_pi_p: CeaInt,
        subar: *const CeaReal,
        nsubar: CeaInt,
        supar: *const CeaReal,
        nsupar: CeaInt,
        n_frz: CeaInt,
        hc_or_tc: CeaReal,
        use_hc: bool,
        tc_est: CeaReal,
        use_tc_est: bool,
    ) -> CeaErr;
    pub fn cea_rocket_solver_solve_fac(
        solver: Handle,
        soln: Handle,
        weights: *const CeaReal,
        pc: CeaReal,
        pi_p: *const CeaReal,
        n_pi_p: CeaInt,
        subar: *const CeaReal,
        nsubar: CeaInt,
        supar: *const CeaReal,
        nsupar: CeaInt,
        n_frz: CeaInt,
        hc_or_tc: CeaReal,
        use_hc: bool,
        mdot_or_acat: CeaReal,
        use_mdot: bool,
        tc_est: CeaReal,
        use_tc_est: bool,
    ) -> CeaErr;

    // Equilibrium solver
    pub fn cea_eqsolver_create_with_options(
        solver: *mut Handle,
        products: Handle,
        options: SolverOpts,
    ) -> CeaErr;
    pub fn cea_eqsolver_destroy(solver: *mut Handle) -> CeaErr;
    pub fn cea_eqsolver_solve(
        solver: Handle,
        eq_type: c_int,
        state1: CeaReal,
        state2: CeaReal,
        amounts: *const CeaReal,
        soln: Handle,
    ) -> CeaErr;
    pub fn cea_eqsolver_solve_with_partials(
        solver: Handle,
        eq_type: c_int,
        state1: CeaReal,
        state2: CeaReal,
        amounts: *const CeaReal,
        soln: Handle,
        partials: Handle,
    ) -> CeaErr;
    pub fn cea_eqpartials_create(partials: *mut Handle, solver: Handle) -> CeaErr;
    pub fn cea_eqpartials_destroy(partials: *mut Handle) -> CeaErr;
    pub fn cea_eqsolution_create(soln: *mut Handle, solver: Handle) -> CeaErr;
    pub fn cea_eqsolution_destroy(soln: *mut Handle) -> CeaErr;
    pub fn cea_eqsolution_get_property(soln: Handle, prop: c_int, value: *mut CeaReal) -> CeaErr;
    pub fn cea_eqsolution_get_converged(soln: Handle, converged: *mut c_int) -> CeaErr;

    // Rocket solution
    pub fn cea_rocket_solution_create(soln: *mut Handle, solver: Handle) -> CeaErr;
    pub fn cea_rocket_solution_destroy(soln: *mut Handle) -> CeaErr;
    pub fn cea_rocket_solution_get_size(soln: Handle, num_pts: *mut CeaInt) -> CeaErr;
    pub fn cea_rocket_solution_get_property(
        soln: Handle,
        prop: c_int,
        len: CeaInt,
        value: *mut CeaReal,
    ) -> CeaErr;
    pub fn cea_rocket_solution_get_converged(soln: Handle, converged: *mut c_int) -> CeaErr;
}
