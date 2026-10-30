//! The unit table: every named unit symbol, its dimension, and its SI scale.
//!
//! A value `v` in a unit converts to SI as `(v + offset) * scale`. Only the
//! absolute temperature scales (`degC`, `degF`) carry an offset; inside a
//! compound unit (`J/(kg*degC)`) the offset is dropped and the unit acts as a
//! temperature interval.
//!
//! Conversion factors are exact by definition where a definition exists
//! (international yard and pound, 1959; standard gravity 9.80665 m/s^2;
//! thermochemical calorie 4.184 J; standard atmosphere 101 325 Pa).

use std::f64::consts::PI;

use crate::dim::{DimKind, Dimension};

/// A resolved unit: SI scale, offset, and dimension.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Unit {
    /// SI value of one unit (after the offset).
    pub scale: f64,
    /// Added to a value before scaling (non-zero only for `degC`, `degF`).
    pub offset: f64,
    pub dim: Dimension,
}

impl Unit {
    /// The dimensionless unit `1`.
    pub const ONE: Unit = Unit {
        scale: 1.0,
        offset: 0.0,
        dim: Dimension::NONE,
    };

    /// Converts a value in this unit to SI.
    pub fn to_si(self, v: f64) -> f64 {
        (v + self.offset) * self.scale
    }

    /// Converts an SI value to this unit.
    pub fn from_si(self, si: f64) -> f64 {
        si / self.scale - self.offset
    }
}

/// One row of the unit table.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UnitDef {
    /// Canonical ASCII symbol (what the formatter writes).
    pub symbol: &'static str,
    /// Other accepted spellings (Unicode forms, common variants).
    pub aliases: &'static [&'static str],
    pub dim: Dimension,
    pub scale: f64,
    pub offset: f64,
}

impl UnitDef {
    /// The unit this row defines.
    pub const fn unit(&self) -> Unit {
        Unit {
            scale: self.scale,
            offset: self.offset,
            dim: self.dim,
        }
    }
}

const fn d(l: i8, m: i8, t: i8, th: i8, a: i8) -> Dimension {
    Dimension::new(l, m, t, th, a)
}

const L: Dimension = d(1, 0, 0, 0, 0);
const M: Dimension = d(0, 1, 0, 0, 0);
const T: Dimension = d(0, 0, 1, 0, 0);
const TH: Dimension = d(0, 0, 0, 1, 0);
const ANG: Dimension = d(0, 0, 0, 0, 1);
const VOL: Dimension = d(3, 0, 0, 0, 0);
const VEL: Dimension = d(1, 0, -1, 0, 0);
const ACC: Dimension = d(1, 0, -2, 0, 0);
const FORCE: Dimension = d(1, 1, -2, 0, 0);
const PRESS: Dimension = d(-1, 1, -2, 0, 0);
const ENERGY: Dimension = d(2, 1, -2, 0, 0);
const POWER: Dimension = d(2, 1, -3, 0, 0);
const FREQ: Dimension = d(0, 0, -1, 0, 0);
const ANGVEL: Dimension = d(0, 0, -1, 0, 1);
const IMPULSE: Dimension = d(1, 1, -1, 0, 0);
const DYNVISC: Dimension = d(-1, 1, -1, 0, 0);
const KINVISC: Dimension = d(2, 0, -1, 0, 0);

const INCH: f64 = 0.0254;
const FOOT: f64 = 0.3048;
const POUND: f64 = 0.453_592_37;
const G0: f64 = 9.806_65;
const LBF: f64 = POUND * G0;

macro_rules! units {
    ($( $sym:literal [$($alias:literal),*] $dim:expr, $scale:expr $(, off $off:expr)? ; )*) => {
        /// Every unit, grouped by dimension. Symbols and aliases are unique.
        pub const UNITS: &[UnitDef] = &[
            $( UnitDef {
                symbol: $sym,
                aliases: &[$($alias),*],
                dim: $dim,
                scale: $scale,
                offset: 0.0 $(+ $off)?,
            }, )*
        ];
    };
}

units! {
    // dimensionless
    "%" [] Dimension::NONE, 0.01;
    // length
    "m" [] L, 1.0;
    "km" [] L, 1e3;
    "cm" [] L, 1e-2;
    "mm" [] L, 1e-3;
    "um" ["µm", "μm"] L, 1e-6;
    "in" [] L, INCH;
    "ft" [] L, FOOT;
    "yd" [] L, 0.9144;
    "mi" [] L, 1609.344;
    "nmi" [] L, 1852.0;
    // mass
    "kg" [] M, 1.0;
    "g" [] M, 1e-3;
    "mg" [] M, 1e-6;
    "t" [] M, 1e3;
    "lb" ["lbm", "lbs"] M, POUND;
    "oz" [] M, POUND / 16.0;
    "slug" [] M, LBF / FOOT;
    // time
    "s" ["sec"] T, 1.0;
    "ms" [] T, 1e-3;
    "us" ["µs", "μs"] T, 1e-6;
    "min" [] T, 60.0;
    "h" ["hr"] T, 3600.0;
    "d" [] T, 86400.0;
    // temperature
    "K" [] TH, 1.0;
    "degC" ["°C"] TH, 1.0, off 273.15;
    "degF" ["°F"] TH, 5.0 / 9.0, off 459.67;
    "degR" ["°R"] TH, 5.0 / 9.0;
    // angle
    "rad" [] ANG, 1.0;
    "mrad" [] ANG, 1e-3;
    "deg" ["°"] ANG, PI / 180.0;
    "arcmin" [] ANG, PI / 10_800.0;
    "arcsec" [] ANG, PI / 648_000.0;
    "rev" [] ANG, 2.0 * PI;
    // volume
    "L" ["l"] VOL, 1e-3;
    "mL" ["ml"] VOL, 1e-6;
    "cc" [] VOL, 1e-6;
    "gal" [] VOL, 0.003_785_411_784;
    // velocity
    "kph" [] VEL, 1.0 / 3.6;
    "mph" [] VEL, 0.447_04;
    "kn" ["kt"] VEL, 1852.0 / 3600.0;
    // acceleration
    "gn" [] ACC, G0;
    // force
    "N" [] FORCE, 1.0;
    "mN" [] FORCE, 1e-3;
    "kN" [] FORCE, 1e3;
    "dyn" [] FORCE, 1e-5;
    "kgf" [] FORCE, G0;
    "lbf" [] FORCE, LBF;
    "ozf" [] FORCE, LBF / 16.0;
    // pressure
    "Pa" [] PRESS, 1.0;
    "hPa" [] PRESS, 1e2;
    "kPa" [] PRESS, 1e3;
    "MPa" [] PRESS, 1e6;
    "GPa" [] PRESS, 1e9;
    "bar" [] PRESS, 1e5;
    "mbar" [] PRESS, 1e2;
    "atm" [] PRESS, 101_325.0;
    "psi" [] PRESS, LBF / (INCH * INCH);
    "ksi" [] PRESS, 1e3 * LBF / (INCH * INCH);
    "torr" [] PRESS, 101_325.0 / 760.0;
    "mmHg" [] PRESS, 133.322_387_415;
    "inHg" [] PRESS, 3386.389;
    // energy
    "J" [] ENERGY, 1.0;
    "kJ" [] ENERGY, 1e3;
    "MJ" [] ENERGY, 1e6;
    "cal" [] ENERGY, 4.184;
    "kcal" [] ENERGY, 4184.0;
    "Wh" [] ENERGY, 3600.0;
    "kWh" [] ENERGY, 3.6e6;
    "BTU" ["Btu"] ENERGY, 1_055.055_852_62;
    // power
    "W" [] POWER, 1.0;
    "kW" [] POWER, 1e3;
    "MW" [] POWER, 1e6;
    "hp" [] POWER, 550.0 * LBF * FOOT;
    // frequency, angular velocity
    "Hz" [] FREQ, 1.0;
    "kHz" [] FREQ, 1e3;
    "rpm" [] ANGVEL, 2.0 * PI / 60.0;
    // impulse
    "Ns" [] IMPULSE, 1.0;
    // viscosity
    "P" [] DYNVISC, 0.1;
    "cP" [] DYNVISC, 1e-3;
    "St" [] KINVISC, 1e-4;
    "cSt" [] KINVISC, 1e-6;
    // remaining SI base units
    "mol" [] Dimension::full(0, 0, 0, 0, 1, 0, 0, 0), 1.0;
    "A" [] Dimension::full(0, 0, 0, 0, 0, 1, 0, 0), 1.0;
    "cd" [] Dimension::full(0, 0, 0, 0, 0, 0, 1, 0), 1.0;
}

/// Looks up a unit by symbol or alias (case-sensitive: `mm` ≠ `Mm`).
pub fn lookup(symbol: &str) -> Option<&'static UnitDef> {
    UNITS
        .iter()
        .find(|u| u.symbol == symbol || u.aliases.contains(&symbol))
}

/// The table rows whose dimension is `kind`'s, in table order.
pub fn units_for(kind: DimKind) -> impl Iterator<Item = &'static UnitDef> {
    let dim = kind.dimension();
    UNITS.iter().filter(move |u| u.dim == dim)
}

impl DimKind {
    /// The coherent SI unit the formatter writes for this dimension
    /// (`""` for a pure number). Every one parses with scale 1.
    pub const fn si_unit(self) -> &'static str {
        match self {
            DimKind::Dimensionless => "",
            DimKind::Length => "m",
            DimKind::Mass => "kg",
            DimKind::Time => "s",
            DimKind::Temperature => "K",
            DimKind::Angle => "rad",
            DimKind::Area => "m^2",
            DimKind::Volume => "m^3",
            DimKind::Velocity => "m/s",
            DimKind::Acceleration => "m/s^2",
            DimKind::Force => "N",
            DimKind::Pressure => "Pa",
            DimKind::Density => "kg/m^3",
            DimKind::AreaDensity => "kg/m^2",
            DimKind::LineDensity => "kg/m",
            DimKind::Impulse => "N*s",
            DimKind::MassFlow => "kg/s",
            DimKind::AngularVelocity => "rad/s",
            DimKind::Inertia => "kg*m^2",
            DimKind::Energy => "J",
            DimKind::Power => "W",
            DimKind::Frequency => "Hz",
            DimKind::Torque => "N*m",
            DimKind::KinematicViscosity => "m^2/s",
            DimKind::DynamicViscosity => "Pa*s",
            DimKind::SpecificHeat => "J/(kg*K)",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_sixty_units() {
        assert!(UNITS.len() >= 60, "{}", UNITS.len());
    }

    #[test]
    fn symbols_and_aliases_are_unique() {
        let mut all: Vec<&str> = UNITS
            .iter()
            .flat_map(|u| std::iter::once(u.symbol).chain(u.aliases.iter().copied()))
            .collect();
        let n = all.len();
        all.sort_unstable();
        all.dedup();
        assert_eq!(all.len(), n);
    }

    #[test]
    fn symbols_are_lexable_atoms() {
        for u in UNITS {
            assert!(
                u.symbol
                    .chars()
                    .all(|c| c.is_ascii_alphabetic() || c == '%'),
                "{}",
                u.symbol
            );
            assert!(u.scale.is_finite() && u.scale > 0.0);
        }
    }

    #[test]
    fn exact_definitions() {
        assert_eq!(lookup("in").unwrap().scale, 0.0254);
        assert_eq!(lookup("lbf").unwrap().scale, 4.448_221_615_260_5);
        assert!((lookup("psi").unwrap().scale - 6_894.757_293_168_361).abs() < 1e-9);
        assert!((lookup("slug").unwrap().scale - 14.593_902_937_206_364).abs() < 1e-12);
        assert!((lookup("hp").unwrap().scale - 745.699_871_582_270_2).abs() < 1e-9);
        assert_eq!(lookup("°").unwrap().symbol, "deg");
    }

    #[test]
    fn every_kind_has_a_table_unit_or_compound() {
        // Named single-symbol units exist for the core mechanical dimensions.
        for k in [
            DimKind::Length,
            DimKind::Mass,
            DimKind::Time,
            DimKind::Temperature,
            DimKind::Angle,
            DimKind::Force,
            DimKind::Pressure,
            DimKind::Energy,
            DimKind::Power,
            DimKind::Impulse,
        ] {
            assert!(units_for(k).next().is_some(), "{k:?}");
        }
    }
}
