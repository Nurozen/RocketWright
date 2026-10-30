//! `rw-cea-probe`: a native CEA smoke solve for shipped layouts (M4.1b).
//!
//! - `rw-cea-probe` locates the compiled databases the way a shipped binary
//!   does (`$RW_CEA_DATA`, then `<bin>/../share/rocketwright/cea/`, then the
//!   app bundle's `Resources/cea`), solves LOX/ethanol and N2O(L)/IPA(L), and
//!   prints `data_dir=<dir>` plus one `key=value` line per result (`{:?}`,
//!   full precision). Exit 2 when the data is not found.
//! - `rw-cea-probe --install-data <prefix>` copies this build's databases to
//!   `<prefix>/share/rocketwright/cea/` (`make cea-data`, the kit).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::Path;
use std::process::ExitCode;

use rw_cea_sys::{BUILD_DATA_DIR, Cea, Exit, data, propellants};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => probe(),
        [flag, prefix] if flag == "--install-data" => {
            match data::install_data(Path::new(BUILD_DATA_DIR), Path::new(prefix)) {
                Ok(dest) => {
                    println!("{}", dest.display());
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("rw-cea-probe: install into {prefix}: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        _ => {
            eprintln!("usage: rw-cea-probe [--install-data <prefix>]");
            ExitCode::from(64)
        }
    }
}

fn probe() -> ExitCode {
    let cea = match Cea::init_located() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("rw-cea-probe: {e}");
            return ExitCode::from(2);
        }
    };
    println!("data_dir={}", cea.data_dir().display());
    let exit = Exit::supar(&[4.0, 10.0]);
    let cases = [
        (
            "lox_ethanol",
            propellants::ethanol_l(),
            propellants::lox(),
            1.4,
        ),
        ("n2o_ipa", propellants::ipa_l(), propellants::n2o_l(), 4.5),
    ];
    for (id, fuel, ox, of) in cases {
        match cea.rocket_iac(&fuel, &ox, of, 20.0, &exit, None) {
            Ok(s) => {
                println!("{id}.tc={:?}", s.t_k[0]);
                println!("{id}.c_star={:?}", s.c_star[0]);
                for (i, (isp, ivac)) in s.isp.iter().zip(&s.isp_vac).enumerate().skip(2) {
                    println!("{id}.isp[{i}]={isp:?}");
                    println!("{id}.isp_vac[{i}]={ivac:?}");
                }
            }
            Err(e) => {
                eprintln!("rw-cea-probe: {id}: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
    ExitCode::SUCCESS
}
