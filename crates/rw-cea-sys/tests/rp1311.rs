//! Acceptance 5: RP-1311 examples 8-14 through the safe API, compared by key
//! against the vendored reference outputs
//! (`third_party/cea/test/main_interface/reference_output/example<n>.out`,
//! legacy CEA2 `long` format, the same files as upstream NASA CEA's).
//!
//! The reference files print each problem in blocks: every block repeats the
//! leading stations (chamber and throat, or injector, combustor end, and
//! throat) and continues the exit points. Rows are parsed by label, never by
//! line number (example 12 prints its blocks in a different order from the
//! deck), and mapped back onto CEA's station order.
#![cfg(feature = "cea")]
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::BTreeMap;
use std::path::Path;

use rw_cea_sys::{
    BUILD_DATA_DIR, Basis, Cea, Combustor, Component, EqState, Exit, Products, Ratio, Reactant,
    RocketProblem, Stations, TpProblem,
};

const PSIA_BAR: f64 = 0.068_947_572_931_683_6;
const ATM_BAR: f64 = 1.013_25;
const FT_M: f64 = 0.3048;
const G0: f64 = 9.806_65;
const CAL_J: f64 = 4.184;

fn cea() -> &'static Cea {
    Cea::init(BUILD_DATA_DIR).expect("CEA init from the build data dir")
}

fn reference(n: u32) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../third_party/cea/test/main_interface/reference_output/example{n}.out"
    ));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// One printed block: label -> values (first row with that label).
type Block = BTreeMap<String, Vec<f64>>;

/// Splits a reference file into its result blocks (rocket performance or
/// equilibrium properties), keeping only blocks whose header contains `kind`.
fn blocks(text: &str, kind: &str) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("THEORETICAL ROCKET PERFORMANCE")
            || t.starts_with("THERMODYNAMIC EQUILIBRIUM PROPERTIES")
        {
            inside = t.contains(kind);
            if inside {
                out.push(Block::new());
            }
            continue;
        }
        if !inside {
            continue;
        }
        let toks: Vec<&str> = t.split_whitespace().collect();
        let first_num = toks
            .iter()
            .rposition(|s| s.parse::<f64>().is_err())
            .map_or(0, |i| i + 1);
        if first_num == 0 || first_num == toks.len() {
            continue;
        }
        let label = toks[..first_num].join(" ");
        let vals = toks[first_num..]
            .iter()
            .map(|v| v.parse::<f64>().unwrap())
            .collect();
        out.last_mut().unwrap().entry(label).or_insert(vals);
    }
    out
}

/// Maps every block's columns onto station indices. `lead` leading stations
/// repeat in every block; rows without the first column (performance
/// parameters) are shifted by one.
fn by_station(blocks: &[Block], lead: usize, n: usize) -> BTreeMap<String, Vec<Option<f64>>> {
    let mut out: BTreeMap<String, Vec<Option<f64>>> = BTreeMap::new();
    let mut exit0 = lead;
    for b in blocks {
        let ncols = b["T, K"].len();
        for (label, vals) in b {
            let shift = ncols - vals.len();
            let row = out.entry(label.clone()).or_insert_with(|| vec![None; n]);
            for (i, v) in vals.iter().enumerate() {
                let col = i + shift;
                let st = if col < lead { col } else { exit0 + col - lead };
                if st < n {
                    row[st] = Some(*v);
                }
            }
        }
        exit0 += ncols - lead;
    }
    assert_eq!(
        exit0, n,
        "reference blocks cover {exit0} stations, expected {n}"
    );
    out
}

fn rel(a: f64, b: f64) -> f64 {
    if a == b { 0.0 } else { ((a - b) / b).abs() }
}

/// Drops CEA 3's FAC "infinity" station (index 1), which the legacy
/// reference does not print, so FAC stations line up with the reference.
fn fac_view(s: &Stations) -> Stations {
    let d = |v: &Vec<f64>| {
        let mut v = v.clone();
        v.remove(1);
        v
    };
    Stations {
        t_k: d(&s.t_k),
        p_bar: d(&s.p_bar),
        rho: d(&s.rho),
        h: d(&s.h),
        s: d(&s.s),
        m: d(&s.m),
        mw: d(&s.mw),
        gamma_s: d(&s.gamma_s),
        cp_eq: d(&s.cp_eq),
        cp_frozen: d(&s.cp_frozen),
        mach: d(&s.mach),
        sonic_velocity: d(&s.sonic_velocity),
        ae_at: d(&s.ae_at),
        c_star: d(&s.c_star),
        cf: d(&s.cf),
        isp: d(&s.isp),
        isp_vac: d(&s.isp_vac),
        viscosity: None,
        conductivity_eq: None,
        prandtl_eq: None,
    }
}

/// Compares `(label, scale, ours)` rows; returns the worst relative error.
/// `tol(label, station)` gives the tolerance.
fn compare(
    case: &str,
    refs: &BTreeMap<String, Vec<Option<f64>>>,
    rows: &[(&str, f64, &[f64])],
    tol: impl Fn(&str, usize) -> f64,
) -> f64 {
    let mut worst = 0.0f64;
    let mut checked = 0;
    let mut failures = Vec::new();
    for (label, scale, ours) in rows {
        let want = refs
            .get(*label)
            .unwrap_or_else(|| panic!("{case}: no `{label}` row in the reference"));
        assert_eq!(want.len(), ours.len(), "{case} {label}: station count");
        for (i, (w, got)) in want.iter().zip(ours.iter()).enumerate() {
            let Some(w) = w else { continue };
            let got = got * scale;
            let e = rel(got, *w);
            let t = tol(label, i);
            if e > t {
                failures.push(format!(
                    "{case} {label}[{i}]: got {got}, reference {w} (rel {e:.3e} > {t:e})"
                ));
            }
            worst = worst.max(e);
            checked += 1;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(checked > 10, "{case}: only {checked} values compared");
    worst
}

/// The rows every rocket case compares, in SI (`unit = 1`).
fn rocket_rows(s: &Stations) -> Vec<(&'static str, f64, &[f64])> {
    vec![
        ("P, BAR", 1.0, &s.p_bar),
        ("T, K", 1.0, &s.t_k),
        ("RHO, KG/CU M", 1.0, &s.rho),
        ("H, KJ/KG", 1.0, &s.h),
        ("S, KJ/(KG)(K)", 1.0, &s.s),
        ("M, (1/n)", 1.0, &s.m),
        ("GAMMAs", 1.0, &s.gamma_s),
        ("SON VEL,M/SEC", 1.0, &s.sonic_velocity),
        ("MACH NUMBER", 1.0, &s.mach),
        ("Ae/At", 1.0, &s.ae_at),
        ("CSTAR, M/SEC", 1.0, &s.c_star),
        ("CF", 1.0, &s.cf),
        ("Ivac, M/SEC", 1.0, &s.isp_vac),
        ("Isp, M/SEC", 1.0, &s.isp),
    ]
}

fn h2_o2() -> Vec<Component> {
    vec![
        Component::fuel(Reactant::db("H2(L)", 20.27), 100.0),
        Component::oxidizer(Reactant::db("O2(L)", 90.17), 100.0),
    ]
}

fn rocket(reactants: Vec<Component>, ratio: Ratio, pc_bar: f64, exit: Exit) -> RocketProblem {
    RocketProblem {
        reactants,
        basis: Basis::Weight,
        ratio,
        pc_bar,
        exit,
        combustor: Combustor::Iac,
        frozen: None,
        products: Products::default(),
    }
}

/// Station-dependent tolerance: CEA meets assigned area ratios only to its
/// iteration tolerance (the legacy reference and CEA 3 land a few 1e-5 apart
/// in Ae/At), and subsonic points sit on the steep side of the area-Mach
/// relation, where that slack is amplified about 10x. Transport properties
/// (CEA 3 revised the mixture rules' last digits) get 1e-4.
fn tol_for(area_stations: &[usize], subsonic: &[usize]) -> impl Fn(&str, usize) -> f64 {
    let (a, s) = (area_stations.to_vec(), subsonic.to_vec());
    move |label, i| {
        let transport = ["VISC,MILLIPOISE", "CONDUCTIVITY", "PRANDTL NUMBER"].contains(&label);
        if s.contains(&i) {
            2e-3
        } else if a.contains(&i) || transport {
            2e-4
        } else {
            2e-5
        }
    }
}

/// Ex 8: H2(L)/O2(L) IAC, O/F 5.55157, Pc 53.3172 bar, pi/p 10,100,1000,
/// subar 1.58, supar 25,50,75.
#[test]
fn example8_iac() {
    let p = rocket(
        h2_o2(),
        Ratio::OxFuel(5.55157),
        53.3172,
        Exit {
            pi_p: vec![10.0, 100.0, 1000.0],
            subar: vec![1.58],
            supar: vec![25.0, 50.0, 75.0],
        },
    );
    let s = cea().rocket(&p).expect("example 8");
    let refs = by_station(&blocks(&reference(8), "EQUILIBRIUM"), 2, 9);
    compare("ex8", &refs, &rocket_rows(&s), tol_for(&[6, 7, 8], &[5]));
}

/// Ex 9: FAC with Ac/At 1.58, pi/p 10,100,1000, supar 25,50,75.
#[test]
fn example9_fac_acat() {
    let mut p = rocket(
        h2_o2(),
        Ratio::OxFuel(5.55157),
        53.3172,
        Exit {
            pi_p: vec![10.0, 100.0, 1000.0],
            subar: vec![],
            supar: vec![25.0, 50.0, 75.0],
        },
    );
    p.combustor = Combustor::FacAcat(1.58);
    let s = cea().rocket(&p).expect("example 9");
    assert_eq!(
        s.len(),
        10,
        "injector, infinity, combustor end, throat, 6 exits"
    );
    let s = fac_view(&s);
    let refs = by_station(&blocks(&reference(9), "EQUILIBRIUM"), 3, 9);
    compare("ex9", &refs, &rocket_rows(&s), tol_for(&[1, 7, 8], &[]));
}

/// Ex 10: FAC with mdot/Ac 1333.9 kg/(s m^2) (the same chamber as ex 9).
#[test]
fn example10_fac_mdot() {
    let mut p = rocket(
        h2_o2(),
        Ratio::OxFuel(5.55157),
        53.3172,
        Exit {
            pi_p: vec![10.0, 100.0, 1000.0],
            subar: vec![],
            supar: vec![25.0, 50.0, 75.0],
        },
    );
    p.combustor = Combustor::FacMdotPerArea(1333.9);
    let s = cea().rocket(&p).expect("example 10");
    assert_eq!(
        s.len(),
        10,
        "injector, infinity, combustor end, throat, 6 exits"
    );
    let s = fac_view(&s);
    let refs = by_station(&blocks(&reference(10), "EQUILIBRIUM"), 3, 9);
    compare("ex10", &refs, &rocket_rows(&s), tol_for(&[1, 7, 8], &[]));
}

/// Ex 11: Li(cr)/F2(L) by moles (no O/F), Pc 1000 psia, ions, transport;
/// pi/p 68.0457, subar 10, supar 10,20,100.
#[test]
fn example11_moles_ions_transport() {
    let mut p = rocket(
        vec![
            Component::fuel(Reactant::db("Li(cr)", 298.15), 1.0),
            Component::oxidizer(Reactant::db("F2(L)", 85.02), 0.5556),
        ],
        Ratio::AsGiven,
        1000.0 * PSIA_BAR,
        Exit {
            pi_p: vec![68.0457],
            subar: vec![10.0],
            supar: vec![10.0, 20.0, 100.0],
        },
    );
    p.basis = Basis::Moles;
    p.products.ions = true;
    p.products.transport = true;
    let s = cea().rocket(&p).expect("example 11");
    let refs = by_station(&blocks(&reference(11), "EQUILIBRIUM"), 2, 7);
    let mut rows = rocket_rows(&s);
    rows.push(("VISC,MILLIPOISE", 1.0, s.viscosity.as_deref().unwrap()));
    rows.push(("CONDUCTIVITY", 1.0, s.conductivity_eq.as_deref().unwrap()));
    rows.push(("PRANDTL NUMBER", 1.0, s.prandtl_eq.as_deref().unwrap()));
    compare("ex11", &refs, &rows, tol_for(&[4, 5, 6], &[3]));
}

/// Ex 12: CH6N2(L)/N2O4(L), O/F 2.5, Pc 1000 psia, `only` products, frozen
/// at the throat (nfz=2; the reference prints the frozen blocks), pi/p
/// 68.0457, supar 5..200.
#[test]
fn example12_only_frozen_at_throat() {
    let mut p = rocket(
        vec![
            Component::fuel(Reactant::db("CH6N2(L)", 298.15), 100.0),
            Component::oxidizer(Reactant::db("N2O4(L)", 298.15), 100.0),
        ],
        Ratio::OxFuel(2.5),
        1000.0 * PSIA_BAR,
        Exit {
            pi_p: vec![68.0457],
            subar: vec![],
            supar: vec![5.0, 10.0, 25.0, 50.0, 75.0, 100.0, 150.0, 200.0],
        },
    );
    p.frozen = Some(2);
    p.products.only = [
        "CO", "CO2", "H", "HNO", "HO2", "H2", "H2O", "H2O2", "N", "NO", "NO2", "N2", "N2O", "O",
        "OH", "O2", "HCO", "NH", "CH4", "NH2", "NH3", "H2O(L)", "C(gr)",
    ]
    .map(String::from)
    .to_vec();
    let s = cea().rocket(&p).expect("example 12");
    let refs = by_station(&blocks(&reference(12), "FROZEN"), 2, 11);
    compare(
        "ex12",
        &refs,
        &rocket_rows(&s),
        tol_for(&[3, 4, 5, 6, 7, 8, 9, 10], &[]),
    );
}

/// Ex 13: tripropellant N2H4(L) 80% + Be(a) 20% / H2O2(L), 67% fuel by
/// weight, Pc 3000 psia, pi/p 3,10,30,300, insert BeO(L), trace 1e-10. The
/// reference prints non-SI units (`calories`): P atm, c* ft/s, Isp lbf s/lbm.
#[test]
fn example13_tripropellant_insert_calories() {
    let mut p = rocket(
        vec![
            Component::fuel(Reactant::db("N2H4(L)", 298.15), 80.0),
            Component::fuel(Reactant::db("Be(a)", 298.15), 20.0),
            Component::oxidizer(Reactant::db("H2O2(L)", 298.15), 100.0),
        ],
        Ratio::PctFuel(67.0),
        3000.0 * PSIA_BAR,
        Exit {
            pi_p: vec![3.0, 10.0, 30.0, 300.0],
            ..Exit::default()
        },
    );
    p.products.insert = vec!["BeO(L)".into()];
    p.products.trace = Some(1e-10);
    let s = cea().rocket(&p).expect("example 13");
    let refs = by_station(&blocks(&reference(13), "EQUILIBRIUM"), 2, 6);
    let rows: Vec<(&str, f64, &[f64])> = vec![
        ("P, ATM", 1.0 / ATM_BAR, &s.p_bar),
        ("T, K", 1.0, &s.t_k),
        ("RHO, G/CC", 1e-3, &s.rho),
        ("H, CAL/G", 1.0 / CAL_J, &s.h),
        ("M, (1/n)", 1.0, &s.m),
        ("GAMMAs", 1.0, &s.gamma_s),
        ("MACH NUMBER", 1.0, &s.mach),
        ("Ae/At", 1.0, &s.ae_at),
        ("CSTAR, FT/SEC", 1.0 / FT_M, &s.c_star),
        ("CF", 1.0, &s.cf),
        ("Isp, LB-SEC/LB", 1.0 / G0, &s.isp),
    ];
    compare("ex13", &refs, &rows, tol_for(&[], &[]));
}

/// Ex 14: tp, H2(L) 100 mol + O2(L) 60 mol (`name` reactants), P 0.05 atm,
/// T 1000..300 K, across the water condensation point (304.3 K).
#[test]
fn example14_tp_condensation() {
    let p = TpProblem {
        reactants: vec![
            Component::name(Reactant::db("H2(L)", 20.27), 100.0),
            Component::name(Reactant::db("O2(L)", 90.17), 60.0),
        ],
        basis: Basis::Moles,
        ratio: Ratio::AsGiven,
        p_bar: vec![0.05 * ATM_BAR],
        t_k: vec![1000.0, 500.0, 350.0, 305.0, 304.3, 304.2, 304.0, 300.0],
        products: Products::default(),
    };
    let states = cea().tp(&p).expect("example 14");
    assert_eq!(states.len(), 8);
    let col = |f: fn(&EqState) -> f64| states.iter().map(f).collect::<Vec<_>>();
    let (pb, t, rho, h, s, m, cp, g) = (
        col(|e| e.p_bar),
        col(|e| e.t_k),
        col(|e| e.rho),
        col(|e| e.h),
        col(|e| e.s),
        col(|e| e.m),
        col(|e| e.cp_eq),
        col(|e| e.gamma_s),
    );
    let refs = by_station(&blocks(&reference(14), "EQUILIBRIUM"), 0, 8);
    let rows: Vec<(&str, f64, &[f64])> = vec![
        ("P, BAR", 1.0, &pb),
        ("T, K", 1.0, &t),
        ("RHO, KG/CU M", 1.0, &rho),
        ("H, KJ/KG", 1.0, &h),
        ("S, KJ/(KG)(K)", 1.0, &s),
        ("M, (1/n)", 1.0, &m),
        ("Cp, KJ/(KG)(K)", 1.0, &cp),
        ("GAMMAs", 1.0, &g),
    ];
    compare("ex14", &refs, &rows, |_, _| 2e-5);
}

/// A Fortran `abort` inside CEA (an unknown product species in `only`)
/// comes back as `CeaError::FortranAbort` with CEA's message, and the
/// database still works afterwards.
#[test]
fn fortran_abort_is_mapped_and_recovered() {
    let mut p = rocket(h2_o2(), Ratio::OxFuel(5.0), 50.0, Exit::supar(&[10.0]));
    p.products.only = vec!["H2O".into(), "NOT_A_SPECIES".into()];
    match cea().rocket(&p) {
        Err(rw_cea_sys::CeaError::FortranAbort { message, .. }) => {
            assert!(!message.is_empty(), "abort message");
        }
        other => panic!("expected FortranAbort, got {other:?}"),
    }
    p.products.only.clear();
    cea().rocket(&p).expect("solve after a recovered abort");
}
