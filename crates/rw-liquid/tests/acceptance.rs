//! Liquid acceptance (spec Acceptance 8b-d, plan M4.5):
//! `cargo test -p rw-liquid --features acceptance`.
//!
//! - 8b: the fixture engine's throat and exit areas against an SP-125 hand
//!   calculation from the table's c* and Cf;
//! - 8c: the blowdown integrator against the analytic isothermal and
//!   adiabatic ideal-gas blowdown, within 1%;
//! - 8d: tank geometry, propellant mass, and CG against the RocketPy (MIT)
//!   liquid-motor example, within 1%.
#![cfg(feature = "acceptance")]

use rw_liquid::blowdown::{Side, drain, polytropic_pressure};
use rw_liquid::tank::TankGeom;
use rw_liquid::{DesignOptions, TableThermo, design};
use rw_model::{EndCap, EvalOptions, SourceSet, eval, parse_source_with_warnings};

const TABLE: &[u8] = include_bytes!("../../../data/thermo/n2o-ethanol.rwtbl");

fn research_vehicle() -> rw_model::EvaluatedModel {
    let files: [(&str, &str); 4] = [
        (
            "rocketwright.toml",
            include_str!("../../../fixtures/research-vehicle/rocketwright.toml"),
        ),
        (
            "rocket.rw.toml",
            include_str!("../../../fixtures/research-vehicle/rocket.rw.toml"),
        ),
        (
            "parts/fin_can.rw.toml",
            include_str!("../../../fixtures/research-vehicle/parts/fin_can.rw.toml"),
        ),
        (
            "engines/demo.rw.toml",
            include_str!("../../../fixtures/research-vehicle/engines/demo.rw.toml"),
        ),
    ];
    let mut s = SourceSet::default();
    for (p, t) in files {
        let (d, w) = parse_source_with_warnings(p, t).unwrap();
        assert!(w.is_empty(), "{p}: {w:?}");
        s.docs.insert(p.to_string(), d);
    }
    eval(&s, &EvalOptions::default())
}

fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / b.abs()
}

/// 8b. SP-125 hand calculation for the fixture engine (spec R6.13): N2O/
/// ethanol, F = 1500 N at sea level, Pc = 20 bar, O/F = 4, ε = 4.
///
/// From the table at (4.0, 20 bar, ε 4), shifting equilibrium:
/// c* = 1554.139 m/s, Cf_vac = 1.598135, Pc/Pe = 24.255, γc = 1.16904.
///
/// - eq 1-33a: Cf = Cf_vac − ε pa/Pc = 1.598135 − 4 × 101325 / 2.0e6 = 1.395485
/// - eq 1-34:  At = F / (Cf Pc) = 1500 / (1.395485 × 2.0e6) = 5.37448e-4 m²
///             (Dt = 26.159 mm)
/// - Ae = ε At = 2.149791e-3 m² (De = 52.318 mm)
/// - eq 1-32:  ṁ = Pc At / c* = 2.0e6 × 5.37448e-4 / 1554.139 = 0.691634 kg/s
/// - eq 4-4:   Vc = L* At = 1.5 × 5.37448e-4 = 8.06172e-4 m³
#[test]
fn acceptance_8b_throat_and_exit_match_the_sp125_hand_calculation() {
    let m = research_vehicle();
    let table = rw_thermo::Table::from_bytes(TABLE).unwrap();
    let th = TableThermo::new(&table);
    let r = design(&m.engines["demo"], Some(&th), &DesignOptions::default());
    let s = r.design.sizing.expect("sized");
    for (what, got, hand) in [
        ("Cf", s.cf, 1.395_485),
        ("At", s.throat_area, 5.374_48e-4),
        ("Ae", s.exit_area, 2.149_791e-3),
        ("Dt", s.throat_diameter, 0.026_159),
        ("De", s.exit_diameter, 0.052_318),
        ("mdot", s.mdot, 0.691_634),
        ("Vc", s.chamber_volume, 8.061_72e-4),
    ] {
        assert!(rel(got, hand) < 1e-4, "{what}: {got} vs hand {hand}");
    }
    // Independent physics check: the ideal-gas Cf_vac (eq 1-33a with the
    // chamber γ and the table's Pe) lies within 3% of shifting equilibrium.
    let g = s.gamma_c;
    let pe_pc = s.exit_pressure / s.chamber_pressure;
    let ideal = (2.0 * g * g / (g - 1.0)
        * (2.0 / (g + 1.0)).powf((g + 1.0) / (g - 1.0))
        * (1.0 - pe_pc.powf((g - 1.0) / g)))
    .sqrt()
        + s.expansion_ratio * pe_pc;
    assert!(rel(ideal, s.cf_vac) < 0.03, "{ideal} vs {}", s.cf_vac);
    // The blowdown starts at the design point: valves are sized to it.
    let b = r.blowdown.expect("blowdown");
    assert!(rel(b.samples[0].chamber_pressure, 2.0e6) < 1e-4);
    assert!(rel(b.samples[0].thrust, 1500.0) < 1e-3);
    assert!(r.diagnostics.is_empty(), "{:?}", r.diagnostics);
}

/// 8c. One tank draining through a resistance R (ΔP = R ṁ²) into vacuum:
/// with p = p0 (Vu0/Vu)^n and dVu/dt = ṁ/ρ = √(p/R)/ρ,
/// Vu^(n/2+1) = Vu0^(n/2+1) + (n/2+1) k t with k = √(p0 Vu0^n / R) / ρ.
#[test]
fn acceptance_8c_blowdown_matches_isothermal_and_adiabatic_analytic() {
    for n in [1.0, 1.4] {
        let side = Side {
            tank_volume: 6e-3,
            liquid0: 4.8e-3,
            p0: 50e5,
            n,
            density: 786.6,
            resistance: 1.65e7,
        };
        let vu0 = side.tank_volume - side.liquid0;
        let k = (side.p0 * vu0.powf(n) / side.resistance).sqrt() / side.density;
        let a = n / 2.0 + 1.0;
        let samples = drain(&side, 0.0, 0.01, 30.0);
        let mut checked = 0;
        let mut worst: f64 = 0.0;
        for (t, p, liquid) in samples {
            if liquid <= 0.0 {
                break;
            }
            let vu = (vu0.powf(a) + a * k * t).powf(1.0 / a);
            let p_exact = polytropic_pressure(side.p0, vu0, vu, n);
            let l_exact = side.tank_volume - vu;
            worst = worst.max(rel(p, p_exact)).max(rel(liquid, l_exact));
            checked += 1;
        }
        assert!(checked > 100, "n = {n}: only {checked} samples");
        assert!(worst < 0.01, "n = {n}: worst relative error {worst}");
        assert!(
            worst < 1e-6,
            "n = {n}: RK4 should be far inside 1% ({worst})"
        );
    }
}

/// 8d. RocketPy (MIT) `docs/user/motors/liquidmotor.rst` example: two
/// `CylindricalTank(radius = 0.1, height = 1.2, spherical_caps = True)`
/// tanks; oxidizer 32 kg liquid at 1220 kg/m³ + 0.01 kg gas at 1.9277 kg/m³
/// at position 1.0 m; fuel 21 kg at 789 kg/m³ + 0.01 kg gas at 1.59 kg/m³ at
/// 2.5 m (nozzle-to-chamber axis, tank centre). RocketPy fills liquid from
/// the bottom and stacks the gas volume (mass / density) above it. Reference
/// values: RocketPy's geometry integrated numerically (Simpson, 240k
/// panels) — total volume 0.0356047 m³, oxidizer level 0.868245 m from the
/// bottom, tank CGs −0.149387 m and −0.143139 m from the tank centres,
/// propellant 53.02 kg with its CG at 1.447487 m.
#[test]
fn acceptance_8d_tank_geometry_mass_and_cg_match_the_rocketpy_example() {
    let t = TankGeom {
        length: 1.2,
        od: 0.2,
        wall: 0.0,
        end_cap: EndCap::Hemispherical,
    };
    assert!(rel(t.volume(), 0.035_604_7) < 0.01);
    let tank_cg = |ml: f64, rl: f64, mg: f64, rg: f64| {
        let (vl, vg) = (ml / rl, mg / rg);
        let zl = t.level(vl);
        let zf = t.level(vl + vg);
        let cl = t.moment_below(zl) / vl;
        let cg = (t.moment_below(zf) - t.moment_below(zl)) / vg;
        (
            (cl * ml + cg * mg) / (ml + mg) - t.length / 2.0,
            zl,
            ml + mg,
        )
    };
    let (ox_cg, ox_level, ox_m) = tank_cg(32.0, 1220.0, 0.01, 1.9277);
    let (fu_cg, _, fu_m) = tank_cg(21.0, 789.0, 0.01, 1.59);
    assert!(rel(ox_level, 0.868_245) < 0.01, "{ox_level}");
    assert!(rel(ox_cg, -0.149_387) < 0.01, "{ox_cg}");
    assert!(rel(fu_cg, -0.143_139) < 0.01, "{fu_cg}");
    let mass = ox_m + fu_m;
    assert!(rel(mass, 53.02) < 0.01);
    let cg = (ox_m * (1.0 + ox_cg) + fu_m * (2.5 + fu_cg)) / mass;
    assert!(rel(cg, 1.447_487) < 0.01, "{cg}");
    // Our own liquid-only centroid agrees with the stacked definition when
    // the gas mass is negligible.
    let cl = t.liquid_centroid(32.0 / 1220.0) - 0.6;
    assert!((cl - (-0.149_544)).abs() < 1e-3, "{cl}");
}

/// The generated curve of the fixture engine is a valid `MotorSource::Liquid`
/// curve with mass falling to the residuals.
#[test]
fn the_fixture_engine_yields_a_flyable_curve() {
    let m = research_vehicle();
    let table = rw_thermo::Table::from_bytes(TABLE).unwrap();
    let th = TableThermo::new(&table);
    let r = design(&m.engines["demo"], Some(&th), &DesignOptions::default());
    let c = r.curve.expect("curve");
    assert!(matches!(c.source, rw_motor::MotorSource::Liquid { ref engine } if engine == "demo"));
    assert!(
        c.burn_time > 2.0 && c.total_impulse > 2000.0,
        "{} {}",
        c.burn_time,
        c.total_impulse
    );
    assert!(c.mass_at(0.0) > c.mass_at(c.burn_time));
    assert!((c.max_thrust - 1500.0).abs() < 2.0);
}
