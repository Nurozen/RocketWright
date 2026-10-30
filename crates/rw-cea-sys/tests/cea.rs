//! Live CEA tests (feature `cea`): RP-1311 example 8 against the vendored
//! reference output, the LOX/ethanol golden point, custom-reactant parity with
//! the database, unit handling, init rules, concurrency, and static linkage.
#![cfg(feature = "cea")]
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::Path;

use rw_cea_sys::{BUILD_DATA_DIR, Cea, CeaError, EnthalpyUnit, Exit, Reactant, Stations};

fn cea() -> &'static Cea {
    Cea::init(BUILD_DATA_DIR).expect("CEA init from the build data dir")
}

fn rel(a: f64, b: f64) -> f64 {
    if a == b { 0.0 } else { ((a - b) / b).abs() }
}

fn assert_rel(what: &str, got: f64, want: f64, tol: f64) {
    assert!(
        rel(got, want) <= tol,
        "{what}: got {got}, want {want} (rel err {:e} > {tol:e})",
        rel(got, want)
    );
}

/// Values of one row (`T, K`, `CSTAR, M/SEC`, ...) in each block of a
/// CEA2-format `.out` file.
fn reference_rows(text: &str, label: &str) -> Vec<Vec<f64>> {
    text.lines()
        .filter_map(|l| l.trim_start().strip_prefix(label))
        .map(|rest| {
            rest.split_whitespace()
                .map(|v| v.parse::<f64>().expect("reference number"))
                .collect()
        })
        .collect()
}

fn lox_ethanol(fuel: Reactant) -> Stations {
    cea()
        .rocket_iac(
            &fuel,
            &Reactant::db("O2(L)", 90.17),
            1.4,
            20.0,
            &Exit::supar(&[4.0]),
            None,
        )
        .expect("LOX/ethanol solve")
}

#[test]
fn version_is_vendored_3_3_4() {
    assert_eq!(cea().version().unwrap(), (3, 3, 4));
}

/// RP-1311 example 8: H2(L)/O2(L), O/F 5.55157, Pc 53.3172 bar, pi/p
/// 10,100,1000, subar 1.58, supar 25,50,75 (third_party/cea test inputs).
#[test]
fn rp1311_example8_matches_reference_output() {
    let exit = Exit {
        pi_p: vec![10.0, 100.0, 1000.0],
        subar: vec![1.58],
        supar: vec![25.0, 50.0, 75.0],
    };
    let s = cea()
        .rocket_iac(
            &Reactant::db("H2(L)", 20.27),
            &Reactant::db("O2(L)", 90.17),
            5.55157,
            53.3172,
            &exit,
            None,
        )
        .expect("example 8 solve");
    assert_eq!(s.len(), 9);

    // Plan acceptance values (RL2), within 1e-4 (absolute). CEA 3's c* is
    // 2332.33580; the legacy CEA2 reference output below prints 2332.33561.
    assert!((s.t_k[0] - 3383.8446).abs() < 1e-4, "Tc {}", s.t_k[0]);
    assert!((s.c_star[0] - 2332.3358).abs() < 1e-4, "c* {}", s.c_star[0]);
    assert_rel("Pc", s.p_bar[0], 53.3172, 1e-12);

    // Every printed station against the vendored reference output (legacy
    // CEA2 format): relative 1e-5 at the chamber, throat, and pressure-ratio
    // stations (0-4; observed <= 2e-6); 1e-4 at the area-ratio stations
    // (6-8) and 1e-3 at the subsonic one (5), which CEA hits only to its
    // iteration tolerance (Ae/At 1.58015 for 1.58, 49.9993 for 50): T and P
    // there agree to about 2e-5, and the subsonic Cf and Isp to about 1.1e-4.
    // Block 1 has [c, t, pi_p x3, subar, supar 25, 50]; block 2 repeats c, t
    // and adds supar 75.
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../third_party/cea/test/main_interface/reference_output/example8.out");
    let text = std::fs::read_to_string(&path).expect("example8.out");
    for (label, got) in [
        ("T, K", &s.t_k),
        ("P, BAR", &s.p_bar),
        ("Ae/At", &s.ae_at),
        ("CSTAR, M/SEC", &s.c_star),
        ("CF", &s.cf),
        ("Isp, M/SEC", &s.isp),
    ] {
        let rows = reference_rows(&text, label);
        assert!(rows.len() >= 2, "{label}: expected 2 reference blocks");
        let (b1, b2) = (&rows[0], &rows[1]);
        // Rows without a chamber column (Ae/At, CSTAR, CF, Isp) start at the throat.
        let skip = got.len() - 1 - b1.len();
        for (i, want) in b1.iter().enumerate() {
            assert_rel(
                &format!("{label}[{}]", i + skip),
                got[i + skip],
                *want,
                match i + skip {
                    0..=4 => 1e-5,
                    5 => 1e-3,
                    _ => 1e-4,
                },
            );
        }
        assert_rel(&format!("{label}[8]"), got[8], *b2.last().unwrap(), 1e-4);
    }
}

/// LOX(L)/C2H5OH(L), O/F 1.4, Pc 20 bar, eps 4, equilibrium (findings §6).
#[test]
fn lox_ethanol_golden_point() {
    let s = lox_ethanol(Reactant::db("C2H5OH(L)", 298.15));
    assert_eq!(s.len(), 3);
    let tol = 0.005; // printed to 0.01
    assert!((s.isp[2] - 2456.38).abs() < tol, "Isp {}", s.isp[2]);
    assert!(
        (s.isp_vac[2] - 2764.79).abs() < tol,
        "Ivac {}",
        s.isp_vac[2]
    );
    assert!((s.t_k[0] - 3107.20).abs() < tol, "Tc {}", s.t_k[0]);
    assert!((s.c_star[0] - 1714.28).abs() < tol, "c* {}", s.c_star[0]);
    assert!(
        (s.gamma_s[0] - 1.1456).abs() < 5e-5,
        "gamma_s {}",
        s.gamma_s[0]
    );
    assert!((s.cf[2] - 1.4329).abs() < 5e-5, "Cf {}", s.cf[2]);
    assert!((s.ae_at[2] - 4.0).abs() < 1e-4, "Ae/At {}", s.ae_at[2]);
}

/// Ethanol as a custom reactant (C2H6O, h = -277.510 kJ/mol, the database's
/// assigned enthalpy) equals the database species (to 1e-8: the solver's
/// iteration path differs in the last digits only).
#[test]
fn custom_ethanol_equals_db() {
    let db = lox_ethanol(Reactant::db("C2H5OH(L)", 298.15));
    let formula = [("C", 2.0), ("H", 6.0), ("O", 1.0)];
    let custom_j = lox_ethanol(Reactant::custom_j_per_mol(
        "EtOH(L)", &formula, -277_510.0, 298.15,
    ));
    let custom_kj = lox_ethanol(Reactant::Custom {
        name: "EtOH(L)".into(),
        formula: formula.iter().map(|(e, n)| (e.to_string(), *n)).collect(),
        enthalpy: -277.510,
        enthalpy_unit: EnthalpyUnit::KjPerMole,
        t_k: 298.15,
    });
    for custom in [&custom_j, &custom_kj] {
        for (what, a, b) in [
            ("T", &custom.t_k, &db.t_k),
            ("c*", &custom.c_star, &db.c_star),
            ("Isp", &custom.isp, &db.isp),
            ("Ivac", &custom.isp_vac, &db.isp_vac),
            ("gamma_s", &custom.gamma_s, &db.gamma_s),
        ] {
            for (x, y) in a.iter().zip(b.iter()) {
                assert_rel(what, *x, *y, 1e-8);
            }
        }
    }
}

/// N2O(L) as a custom reactant (h = 71.02 kJ/mol): with the exact unit enum
/// CEA uses the enthalpy (feasibility probe: Tc 2980.32 K, Isp 2227.49 m/s at
/// O/F 4; this build gives 2980.26 / 2227.46, within 1e-4); a misspelled unit
/// would have silently zeroed it (Tc about 2407 K). kJ and J spellings agree.
#[test]
fn custom_n2o_uses_assigned_enthalpy() {
    let n2o = Reactant::Custom {
        name: "N2O(L)".into(),
        formula: vec![("N".into(), 2.0), ("O".into(), 1.0)],
        enthalpy: 71.02,
        enthalpy_unit: EnthalpyUnit::KjPerMole,
        t_k: 298.15,
    };
    let s = cea()
        .rocket_iac(
            &Reactant::db("C2H5OH(L)", 298.15),
            &n2o,
            4.0,
            20.0,
            &Exit::supar(&[4.0]),
            None,
        )
        .expect("N2O/ethanol solve");
    assert_rel("Tc", s.t_k[0], 2980.32, 1e-4);
    assert_rel("Isp", s.isp[2], 2227.49, 1e-4);
    let n2o_j = Reactant::custom_j_per_mol("N2O(L)", &[("N", 2.0), ("O", 1.0)], 71_020.0, 298.15);
    let sj = cea()
        .rocket_iac(
            &Reactant::db("C2H5OH(L)", 298.15),
            &n2o_j,
            4.0,
            20.0,
            &Exit::supar(&[4.0]),
            None,
        )
        .expect("N2O/ethanol solve (J/mol)");
    assert_rel("Tc kJ vs J", s.t_k[0], sj.t_k[0], 1e-12);
}

#[test]
fn frozen_flow_differs_from_equilibrium() {
    let fuel = Reactant::db("C2H5OH(L)", 298.15);
    let ox = Reactant::db("O2(L)", 90.17);
    let exit = Exit::supar(&[4.0]);
    let eq = cea()
        .rocket_iac(&fuel, &ox, 1.4, 20.0, &exit, None)
        .unwrap();
    let fr = cea()
        .rocket_iac(&fuel, &ox, 1.4, 20.0, &exit, Some(1))
        .unwrap();
    assert_eq!(fr.t_k[0], eq.t_k[0]);
    assert!(
        fr.isp[2] < eq.isp[2],
        "frozen {} vs eq {}",
        fr.isp[2],
        eq.isp[2]
    );
    assert!(
        cea()
            .rocket_iac(&fuel, &ox, 1.4, 20.0, &exit, Some(3))
            .is_err()
    );
}

#[test]
fn init_rules() {
    let a = cea();
    assert!(std::ptr::eq(a, Cea::init(BUILD_DATA_DIR).unwrap()));
    assert!(std::ptr::eq(a, Cea::get().unwrap()));
    assert_eq!(a.data_dir(), Path::new(BUILD_DATA_DIR));
    assert!(matches!(
        Cea::init("relative/dir"),
        Err(CeaError::DataDir { .. })
    ));
    assert!(matches!(
        Cea::init("/nonexistent/rw-cea"),
        Err(CeaError::AlreadyInitialized { .. })
    ));
}

#[test]
fn rejects_bad_inputs() {
    let ox = Reactant::db("O2(L)", 90.17);
    let exit = Exit::supar(&[4.0]);
    let long = Reactant::db("A_NAME_LONGER_THAN_15", 298.15);
    assert!(matches!(
        cea().rocket_iac(&long, &ox, 1.4, 20.0, &exit, None),
        Err(CeaError::InvalidInput(_))
    ));
    let fuel = Reactant::db("C2H5OH(L)", 298.15);
    assert!(
        cea()
            .rocket_iac(&fuel, &ox, -1.0, 20.0, &exit, None)
            .is_err()
    );
    assert!(cea().rocket_iac(&fuel, &ox, 1.4, 0.0, &exit, None).is_err());
    assert!(
        cea()
            .rocket_iac(&fuel, &ox, 1.4, 20.0, &Exit::supar(&[0.5]), None)
            .is_err()
    );
    // An unknown database species is a CEA error, not a crash.
    let bogus = Reactant::db("NOTASPECIES", 298.15);
    assert!(
        cea()
            .rocket_iac(&bogus, &ox, 1.4, 20.0, &exit, None)
            .is_err()
    );
}

/// The process-global database is shared safely across threads (Mutex).
#[test]
fn concurrent_solves_agree() {
    let want = lox_ethanol(Reactant::db("C2H5OH(L)", 298.15));
    let got: Vec<Stations> = std::thread::scope(|s| {
        let hs: Vec<_> = (0..4)
            .map(|_| s.spawn(|| lox_ethanol(Reactant::db("C2H5OH(L)", 298.15))))
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    for g in got {
        assert_eq!(g, want);
    }
}

/// Static link: the test binary depends on libSystem only (no libgfortran or
/// libquadmath dylib, no build-tree rpath).
#[cfg(target_os = "macos")]
#[test]
fn links_libsystem_only() {
    let exe = std::env::current_exe().unwrap();
    let out = std::process::Command::new("otool")
        .arg("-L")
        .arg(&exe)
        .output()
        .expect("otool");
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    let deps: Vec<&str> = text
        .lines()
        .skip(1)
        .map(|l| l.trim().split(" (").next().unwrap())
        .collect();
    assert_eq!(deps, ["/usr/lib/libSystem.B.dylib"], "otool -L:\n{text}");
}

/// The shipped custom reactants (`propellants`: N2O(L) h = 71.02 kJ/mol,
/// IPA(L) h = -318.1 kJ/mol, NIST) reproduce the feasibility probe's points
/// at Pc 20 bar, eps 4 (findings §6: LOX/IPA O/F 1.6 Tc 3175.47 K, Isp
/// 2479.56 m/s; N2O/IPA O/F 4.5 Tc 3009.82 K, Isp 2233.65 m/s).
#[test]
fn shipped_custom_reactants_match_probe_points() {
    use rw_cea_sys::propellants;
    let exit = Exit::supar(&[4.0]);
    for (fuel, ox, of, tc, isp) in [
        (
            propellants::ipa_l(),
            propellants::lox(),
            1.6,
            3175.47,
            2479.56,
        ),
        (
            propellants::ipa_l(),
            propellants::n2o_l(),
            4.5,
            3009.82,
            2233.65,
        ),
        (
            propellants::ethanol_l(),
            propellants::n2o_l(),
            4.0,
            2980.32,
            2227.49,
        ),
    ] {
        let s = cea()
            .rocket_iac(&fuel, &ox, of, 20.0, &exit, None)
            .unwrap_or_else(|e| panic!("{} / {}: {e}", ox.name(), fuel.name()));
        assert_rel(&format!("{} Tc", fuel.name()), s.t_k[0], tc, 1e-4);
        assert_rel(&format!("{} Isp", fuel.name()), s.isp[2], isp, 1e-4);
    }
    // Every shipped pair solves mid-range.
    for p in &propellants::PAIRS {
        let of = 0.5 * (p.of_min + p.of_max);
        cea()
            .rocket_iac(
                &p.fuel_reactant(),
                &p.oxidizer_reactant(),
                of,
                20.0,
                &exit,
                None,
            )
            .unwrap_or_else(|e| panic!("{}: {e}", p.id));
    }
}
