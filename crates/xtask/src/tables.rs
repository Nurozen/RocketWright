//! `cargo xtask tables`: CEA thermochemistry tables (M4.2, R4.7, Acc 8a).
//!
//! - `cargo xtask tables [--pair <id>]...` solves every node of each shipped
//!   pair's grid with native CEA (`rw-cea-sys`) and writes
//!   `data/thermo/<pair>.rwtbl` ([`rw_thermo`] format v1).
//! - `cargo xtask tables --verify [--points N] [--seed S]` checks each
//!   committed table's header (CEA version, `thermo.inp` SHA-256, axes) and
//!   re-solves N random interior points per pair and mode natively: Isp,
//!   c*, and Tc must interpolate within 0.5%.
//!
//! Grid (cea-build.md §9): O/F uniform, step 0.025, over the pair's range;
//! Pc 5-100 bar log-spaced with ratio <= 1.5 (9 points); eps a fixed
//! supersonic list solved in one CEA call per (O/F, Pc); equilibrium and
//! frozen (at the chamber, `nfz = 1`) flow.
//!
//! The CEA work needs the `cea` feature (gfortran + cmake). Built without
//! it (the default `cargo xtask`), this module re-runs itself through
//! `cargo run -p xtask --features cea`.
// The grid and sampling helpers are used by the `cea` half (and tests).
#![cfg_attr(not(feature = "cea"), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// O/F step (cea-build.md §9: <= 0.19% Tc interpolation error).
pub const OF_STEP: f64 = 0.025;
/// Chamber pressure range, bar.
pub const PC_MIN_BAR: f64 = 5.0;
pub const PC_MAX_BAR: f64 = 100.0;
/// Largest ratio between neighbouring Pc points.
pub const PC_MAX_RATIO: f64 = 1.5;
/// Supersonic area ratios (neighbour ratio <= 1.5; denser below 3, where
/// Isp bends most in ln eps: 0.42% worst-case interpolation error with the
/// recipe's 1.5, 2, 3 spacing, under 0.15% with this list).
pub const EPS: [f64; 17] = [
    1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 15.0, 20.0, 30.0, 40.0, 60.0, 80.0, 100.0,
];
/// CEA `nfz` of the frozen slice (freeze at the chamber).
pub const FROZEN_STATION: u32 = 1;
/// Acceptance 8a bound on |table - native| / native for Isp, c*, and Tc.
pub const VERIFY_TOL: f64 = 0.005;
/// Default random points per pair and mode for `--verify`.
pub const VERIFY_POINTS: usize = 10;
/// Default `--verify` seed (fixed so CI is reproducible; `--seed` varies it).
pub const VERIFY_SEED: u64 = 0x5eed_4d42;

/// Rounds away float noise from `a + i * step` (axis values are decimal).
fn tidy(x: f64) -> f64 {
    (x * 1e9).round() / 1e9
}

/// The O/F axis for a range: `min, min + step, ..., max`.
pub fn of_axis(min: f64, max: f64) -> Vec<f64> {
    let n = ((max - min) / OF_STEP).round() as usize;
    (0..=n).map(|i| tidy(min + i as f64 * OF_STEP)).collect()
}

/// The Pc axis, Pa: log-spaced 5-100 bar with neighbour ratio <= 1.5.
pub fn pc_axis_pa() -> Vec<f64> {
    let span = (PC_MAX_BAR / PC_MIN_BAR).ln();
    let n = (span / PC_MAX_RATIO.ln()).ceil() as usize;
    (0..=n)
        .map(|k| {
            let bar = if k == n {
                PC_MAX_BAR
            } else {
                PC_MIN_BAR * (span * k as f64 / n as f64).exp()
            };
            tidy(bar * 1e5)
        })
        .collect()
}

/// SHA-256 (hex) of `third_party/cea/data/thermo.inp`.
pub fn thermo_sha256(root: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let path = root.join("third_party/cea/data/thermo.inp");
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// xorshift64* (deterministic sampling for `--verify`; no `rand`).
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.max(1))
    }

    /// Uniform in [0, 1).
    pub fn next_f64(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        let x = self.0.wrapping_mul(0x2545_f491_4f6c_dd1d);
        (x >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform in [a, b].
    pub fn uniform(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.next_f64()
    }

    /// Log-uniform in [a, b] (a, b > 0).
    pub fn log_uniform(&mut self, a: f64, b: f64) -> f64 {
        self.uniform(a.ln(), b.ln()).exp()
    }
}

fn repo_root() -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    root.canonicalize().unwrap_or(root)
}

/// Parsed command line.
#[derive(Debug, Default, PartialEq)]
pub struct Args {
    pub verify: bool,
    pub pairs: Vec<String>,
    pub points: Option<usize>,
    pub seed: Option<u64>,
    pub out: Option<PathBuf>,
}

pub fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut a = Args::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match arg.as_str() {
            "--verify" => a.verify = true,
            "--pair" => a.pairs.push(value("--pair")?),
            "--points" => {
                a.points = Some(
                    value("--points")?
                        .parse()
                        .map_err(|e| format!("--points: {e}"))?,
                )
            }
            "--seed" => {
                a.seed = Some(
                    value("--seed")?
                        .parse()
                        .map_err(|e| format!("--seed: {e}"))?,
                )
            }
            "--out" => a.out = Some(PathBuf::from(value("--out")?)),
            other => return Err(format!("unknown argument `{other}`")),
        }
    }
    for p in &a.pairs {
        if !rw_cea_sys::propellants::PAIRS.iter().any(|x| x.id == *p) {
            return Err(format!("unknown pair `{p}`"));
        }
    }
    Ok(a)
}

pub const USAGE: &str =
    "usage: cargo xtask tables [--verify [--points N] [--seed S]] [--pair <id>]... [--out <dir>]";

pub fn main(args: &[String]) -> ExitCode {
    let parsed = match parse_args(args) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("xtask tables: {e}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    run(parsed, args)
}

/// Without the `cea` feature: re-run through cargo with it enabled.
#[cfg(not(feature = "cea"))]
fn run(_parsed: Args, args: &[String]) -> ExitCode {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let status = std::process::Command::new(cargo)
        .args(["run", "--quiet", "--manifest-path"])
        .arg(repo_root().join("Cargo.toml"))
        .args(["-p", "xtask", "--features", "cea", "--", "tables"])
        .args(args)
        .status();
    match status {
        Ok(s) if s.success() => ExitCode::SUCCESS,
        Ok(s) => {
            eprintln!("xtask tables: CEA build/run failed ({s}); needs gfortran and cmake");
            ExitCode::FAILURE
        }
        Err(e) => {
            eprintln!("xtask tables: spawn cargo: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(feature = "cea")]
fn run(parsed: Args, _args: &[String]) -> ExitCode {
    match gen_impl::run(parsed) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("xtask tables: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(feature = "cea")]
mod gen_impl {
    use super::*;
    use rw_cea_sys::propellants::{PAIRS, Pair};
    use rw_cea_sys::{BUILD_DATA_DIR, Cea, Exit, Reactant};
    use rw_thermo::{CHAMBER_FIELDS, FORMAT, Header, Mode, NOZZLE_FIELDS, ReactantDef, Table};

    fn cea() -> Result<&'static Cea, String> {
        Cea::init(BUILD_DATA_DIR).map_err(|e| e.to_string())
    }

    fn version(cea: &Cea) -> Result<String, String> {
        let (a, b, c) = cea.version().map_err(|e| e.to_string())?;
        Ok(format!("{a}.{b}.{c}"))
    }

    fn reactant_def(id: &str, r: &Reactant) -> ReactantDef {
        match r {
            Reactant::Db { name, t_k } => ReactantDef {
                id: id.into(),
                name: name.clone(),
                t_k: *t_k,
                formula: None,
                h_j_per_mol: None,
            },
            Reactant::Custom {
                name,
                formula,
                enthalpy,
                enthalpy_unit,
                t_k,
            } => {
                let scale = match enthalpy_unit {
                    rw_cea_sys::EnthalpyUnit::JPerMole => 1.0,
                    rw_cea_sys::EnthalpyUnit::KjPerMole => 1e3,
                    rw_cea_sys::EnthalpyUnit::KcalPerMole => 4184.0,
                    rw_cea_sys::EnthalpyUnit::CalPerMole => 4.184,
                };
                ReactantDef {
                    id: id.into(),
                    name: name.clone(),
                    t_k: *t_k,
                    formula: Some(formula.clone()),
                    h_j_per_mol: Some(enthalpy * scale),
                }
            }
        }
    }

    fn selected(args: &Args) -> Vec<&'static Pair> {
        PAIRS
            .iter()
            .filter(|p| args.pairs.is_empty() || args.pairs.iter().any(|x| x == p.id))
            .collect()
    }

    fn out_dir(args: &Args) -> PathBuf {
        args.out
            .clone()
            .unwrap_or_else(|| repo_root().join("data/thermo"))
    }

    /// The header a freshly generated table for `pair` carries.
    fn expected_header(pair: &Pair, cea_version: &str, sha: &str) -> Header {
        Header {
            format: FORMAT,
            pair: pair.id.into(),
            oxidizer: reactant_def(pair.oxidizer, &pair.oxidizer_reactant()),
            fuel: reactant_def(pair.fuel, &pair.fuel_reactant()),
            cea_version: cea_version.into(),
            thermo_sha256: sha.into(),
            of: of_axis(pair.of_min, pair.of_max),
            pc_pa: pc_axis_pa(),
            eps: EPS.to_vec(),
            modes: vec![Mode::Equilibrium, Mode::Frozen],
            frozen_station: FROZEN_STATION,
            chamber_fields: CHAMBER_FIELDS.map(String::from).to_vec(),
            nozzle_fields: NOZZLE_FIELDS.map(String::from).to_vec(),
        }
    }

    fn frozen_of(mode: Mode) -> Option<u32> {
        match mode {
            Mode::Equilibrium => None,
            Mode::Frozen => Some(FROZEN_STATION),
        }
    }

    /// One CEA solve for a node at the area ratios `eps` (a subset of the
    /// axis, at axis indices `ks`): writes the chamber fields and those eps
    /// slots of `out` (SI).
    #[allow(clippy::too_many_arguments)]
    fn solve_into(
        cea: &Cea,
        pair: &Pair,
        mode: Mode,
        of: f64,
        pc_pa: f64,
        eps: &[f64],
        ks: &[usize],
        out: &mut [f32],
    ) -> Result<(), String> {
        let s = cea
            .rocket_iac(
                &pair.fuel_reactant(),
                &pair.oxidizer_reactant(),
                of,
                pc_pa / 1e5,
                &Exit::supar(eps),
                frozen_of(mode),
            )
            .map_err(|e| e.to_string())?;
        let cp = match mode {
            Mode::Equilibrium => s.cp_eq[0],
            Mode::Frozen => s.cp_frozen[0],
        };
        let chamber = [
            s.t_k[0],
            s.m[0] * 1e-3,
            s.gamma_s[0],
            cp * 1e3,
            s.c_star[0],
            s.rho[0],
            s.t_k[1],
            s.p_bar[1] * 1e5,
            s.gamma_s[1],
        ];
        let nc = CHAMBER_FIELDS.len();
        let nn = NOZZLE_FIELDS.len();
        let mut vals = Vec::with_capacity(nc + ks.len() * nn);
        vals.extend(chamber);
        for e in 2..2 + ks.len() {
            vals.extend([
                s.p_bar[0] / s.p_bar[e],
                s.t_k[e],
                s.gamma_s[e],
                s.mach[e],
                s.isp[e],
                s.isp_vac[e],
            ]);
        }
        if vals.iter().any(|v| !v.is_finite()) {
            return Err("non-finite CEA output".into());
        }
        for (o, v) in out[..nc].iter_mut().zip(&vals[..nc]) {
            *o = *v as f32;
        }
        for (n, &k) in ks.iter().enumerate() {
            let at = nc + k * nn;
            let from = nc + n * nn;
            for (o, v) in out[at..at + nn].iter_mut().zip(&vals[from..from + nn]) {
                *o = *v as f32;
            }
        }
        Ok(())
    }

    /// One node: all area ratios in one solve; when that fails (frozen
    /// fuel-rich expansions can leave CEA's condensed-species range at large
    /// eps), each eps alone, so only the failing eps slots stay NaN. Returns
    /// the number of NaN eps slots (all of them when the chamber failed).
    fn solve_node(
        cea: &Cea,
        pair: &Pair,
        mode: Mode,
        of: f64,
        pc_pa: f64,
        eps: &[f64],
        out: &mut [f32],
    ) -> Result<usize, String> {
        let all: Vec<usize> = (0..eps.len()).collect();
        let first = match solve_into(cea, pair, mode, of, pc_pa, eps, &all, out) {
            Ok(()) => return Ok(0),
            Err(e) => e,
        };
        let mut missing = 0;
        for (k, e) in eps.iter().enumerate() {
            if solve_into(cea, pair, mode, of, pc_pa, &[*e], &[k], out).is_err() {
                missing += 1;
            }
        }
        if missing == eps.len() {
            return Err(first);
        }
        Ok(missing)
    }

    fn generate(cea: &Cea, pair: &Pair, header: Header) -> Result<(Table, usize, usize), String> {
        let mut values = vec![f32::NAN; header.value_count()];
        let (mut failed, mut partial) = (0, 0);
        for (m, &mode) in header.modes.iter().enumerate() {
            for (i, &of) in header.of.iter().enumerate() {
                for (j, &pc) in header.pc_pa.iter().enumerate() {
                    let at = header.node_offset(m, i, j);
                    let node = &mut values[at..at + header.node_len()];
                    match solve_node(cea, pair, mode, of, pc, &header.eps, node) {
                        Ok(0) => {}
                        Ok(_) => partial += 1,
                        Err(e) => {
                            node.fill(f32::NAN);
                            failed += 1;
                            eprintln!(
                                "xtask tables: {} {mode:?} O/F {of} Pc {} bar: {e} (stored as NaN)",
                                pair.id,
                                pc / 1e5
                            );
                        }
                    }
                }
            }
        }
        let table = Table::new(header, values).map_err(|e| e.to_string())?;
        Ok((table, failed, partial))
    }

    pub fn run(args: Args) -> Result<(), String> {
        let root = repo_root();
        let sha = thermo_sha256(&root)?;
        let cea = cea()?;
        let ver = version(cea)?;
        if args.verify {
            verify(cea, &args, &ver, &sha)
        } else {
            let dir = out_dir(&args);
            std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            for pair in selected(&args) {
                let (table, failed, partial) =
                    generate(cea, pair, expected_header(pair, &ver, &sha))?;
                let path = dir.join(format!("{}.rwtbl", pair.id));
                let bytes = table.to_bytes();
                std::fs::write(&path, &bytes).map_err(|e| format!("{}: {e}", path.display()))?;
                let h = table.header();
                println!(
                    "xtask tables: {} ({} O/F x {} Pc x {} eps x {} modes; nodes without data: {} whole, {} some eps; {} bytes)",
                    path.display(),
                    h.of.len(),
                    h.pc_pa.len(),
                    h.eps.len(),
                    h.modes.len(),
                    failed,
                    partial,
                    bytes.len()
                );
            }
            Ok(())
        }
    }

    fn verify(cea: &Cea, args: &Args, ver: &str, sha: &str) -> Result<(), String> {
        let dir = out_dir(args);
        let points = args.points.unwrap_or(VERIFY_POINTS);
        let seed = args.seed.unwrap_or(VERIFY_SEED);
        let mut rng = Rng::new(seed);
        let mut problems = Vec::new();
        println!(
            "xtask tables --verify: {points} random points per pair and mode, seed {seed}, tolerance {:.1}%",
            VERIFY_TOL * 100.0
        );
        for pair in selected(args) {
            let path = dir.join(format!("{}.rwtbl", pair.id));
            let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let table =
                Table::from_bytes(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
            let want = expected_header(pair, ver, sha);
            if *table.header() != want {
                problems.push(format!(
                    "{}: header differs from a fresh generation (CEA {ver}, thermo.inp {}...): regenerate with `make cea-tables`",
                    pair.id,
                    &sha[..12]
                ));
                continue;
            }
            let h = table.header();
            for &mode in &h.modes {
                let mut worst = [0.0f64; 3];
                let mut worst_at = (0.0, 0.0, 0.0);
                let mut n = 0;
                let mut tries = 0;
                while n < points {
                    tries += 1;
                    if tries > points * 20 {
                        problems.push(format!("{} {mode:?}: too many unusable points", pair.id));
                        break;
                    }
                    let of = rng.uniform(h.of[0], h.of[h.of.len() - 1]);
                    let pc = rng.log_uniform(h.pc_pa[0], h.pc_pa[h.pc_pa.len() - 1]);
                    let eps = rng.log_uniform(h.eps[0], h.eps[h.eps.len() - 1]);
                    let got = match table.performance(mode, of, pc, Some(eps)) {
                        Ok(p) => p,
                        Err(rw_thermo::ThermoError::NoData) => continue,
                        Err(e) => return Err(format!("{}: {e}", pair.id)),
                    };
                    let native = cea
                        .rocket_iac(
                            &pair.fuel_reactant(),
                            &pair.oxidizer_reactant(),
                            of,
                            pc / 1e5,
                            &Exit::supar(&[eps]),
                            frozen_of(mode),
                        )
                        .map_err(|e| format!("{} native O/F {of} Pc {pc} Pa: {e}", pair.id))?;
                    let nozzle = got.nozzle.expect("eps given");
                    let checks = [
                        ("Isp", nozzle.isp, native.isp[2]),
                        ("c*", got.chamber.c_star, native.c_star[0]),
                        ("Tc", got.chamber.t_c, native.t_k[0]),
                    ];
                    for (k, (what, t, nv)) in checks.into_iter().enumerate() {
                        let e = ((t - nv) / nv).abs();
                        if k == 0 && e > worst[0] {
                            worst_at = (of, pc / 1e5, eps);
                        }
                        worst[k] = worst[k].max(e);
                        if e > VERIFY_TOL {
                            problems.push(format!(
                                "{} {mode:?} {what} at O/F {of:.4} Pc {:.3} bar eps {eps:.3}: table {t:.3} vs native {nv:.3} ({:.3}%)",
                                pair.id,
                                pc / 1e5,
                                e * 100.0
                            ));
                        }
                    }
                    n += 1;
                }
                println!(
                    "  {:<12} {:<11} max error: Isp {:.4}% (O/F {:.3}, Pc {:.2} bar, eps {:.2})  c* {:.4}%  Tc {:.4}%",
                    pair.id,
                    format!("{mode:?}"),
                    worst[0] * 100.0,
                    worst_at.0,
                    worst_at.1,
                    worst_at.2,
                    worst[1] * 100.0,
                    worst[2] * 100.0
                );
            }
        }
        if problems.is_empty() {
            println!("xtask tables --verify: ok");
            Ok(())
        } else {
            Err(format!("verify failed:\n  {}", problems.join("\n  ")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn of_axis_is_uniform_decimal() {
        let a = of_axis(0.5, 3.0);
        assert_eq!(a.len(), 101);
        assert_eq!(a[0], 0.5);
        assert_eq!(a[1], 0.525);
        assert_eq!(a[100], 3.0);
        assert!(
            a.windows(2)
                .all(|w| ((w[1] - w[0]) - OF_STEP).abs() < 1e-12)
        );
        assert_eq!(of_axis(2.0, 10.0).len(), 321);
    }

    #[test]
    fn pc_axis_spans_5_to_100_bar_with_ratio_at_most_1_5() {
        let a = pc_axis_pa();
        assert_eq!(a.len(), 9);
        assert_eq!(a[0], 5e5);
        assert_eq!(*a.last().unwrap(), 100e5);
        assert!(a.windows(2).all(|w| w[1] / w[0] <= PC_MAX_RATIO));
    }

    #[test]
    fn eps_list_ratio_at_most_1_5() {
        assert!(
            EPS.windows(2)
                .all(|w| w[1] > w[0] && w[1] / w[0] <= 1.5 + 1e-12)
        );
    }

    #[test]
    fn rng_is_deterministic_and_in_range() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        for _ in 0..1000 {
            let x = a.next_f64();
            assert_eq!(x, b.next_f64());
            assert!((0.0..1.0).contains(&x));
            let y = a.log_uniform(1.5, 100.0);
            b.log_uniform(1.5, 100.0);
            assert!((1.5..=100.0).contains(&y));
        }
        assert_ne!(Rng::new(1).next_f64(), Rng::new(2).next_f64());
    }

    #[test]
    fn args() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let a = parse_args(&s(&["--verify", "--points", "3", "--pair", "lox-rp1"])).unwrap();
        assert!(a.verify);
        assert_eq!(a.points, Some(3));
        assert_eq!(a.pairs, ["lox-rp1"]);
        assert!(parse_args(&s(&["--pair", "lox-kerosene"])).is_err());
        assert!(parse_args(&s(&["--bogus"])).is_err());
        assert!(parse_args(&s(&["--points"])).is_err());
    }

    #[test]
    fn thermo_inp_hash_is_hex() {
        let h = thermo_sha256(&repo_root()).unwrap();
        assert_eq!(h.len(), 64);
        assert!(h.bytes().all(|b| b.is_ascii_hexdigit()));
    }
}
