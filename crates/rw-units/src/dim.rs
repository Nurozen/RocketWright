//! Dimension exponent vectors and the named dimensions (`x-unit-dimension`).

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Exponents over the SI base dimensions plus plane angle.
///
/// Order: length L, mass M, time T, temperature Θ, amount N, current I,
/// luminous intensity J, angle A. Angle is tracked as its own dimension so a
/// bare number is never silently read as radians.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, JsonSchema)]
pub struct Dimension {
    pub l: i8,
    pub m: i8,
    pub t: i8,
    pub th: i8,
    pub n: i8,
    pub i: i8,
    pub j: i8,
    pub a: i8,
}

impl Dimension {
    /// Builds a dimension from exponents (L, M, T, Θ, A); N, I, J are zero.
    pub const fn new(l: i8, m: i8, t: i8, th: i8, a: i8) -> Self {
        Self {
            l,
            m,
            t,
            th,
            n: 0,
            i: 0,
            j: 0,
            a,
        }
    }
    pub const NONE: Self = Self::new(0, 0, 0, 0, 0);

    /// Builds a dimension from all eight exponents (L, M, T, Θ, N, I, J, A).
    #[allow(clippy::too_many_arguments)]
    pub const fn full(l: i8, m: i8, t: i8, th: i8, n: i8, i: i8, j: i8, a: i8) -> Self {
        Self {
            l,
            m,
            t,
            th,
            n,
            i,
            j,
            a,
        }
    }

    /// The exponents in the order L, M, T, Θ, N, I, J, A.
    pub const fn exponents(self) -> [i8; 8] {
        [
            self.l, self.m, self.t, self.th, self.n, self.i, self.j, self.a,
        ]
    }

    /// Inverse of [`Dimension::exponents`].
    pub const fn from_exponents(e: [i8; 8]) -> Self {
        Self::full(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7])
    }

    /// True for a pure number.
    pub const fn is_none(self) -> bool {
        let e = self.exponents();
        e[0] == 0
            && e[1] == 0
            && e[2] == 0
            && e[3] == 0
            && e[4] == 0
            && e[5] == 0
            && e[6] == 0
            && e[7] == 0
    }

    /// The dimension of a product (exponents add). `None` on `i8` overflow.
    pub fn checked_mul(self, rhs: Self) -> Option<Self> {
        self.zip(rhs, i8::checked_add)
    }

    /// The dimension of a quotient (exponents subtract). `None` on overflow.
    pub fn checked_div(self, rhs: Self) -> Option<Self> {
        self.zip(rhs, i8::checked_sub)
    }

    /// The dimension raised to an integer power. `None` on overflow.
    pub fn checked_pow(self, p: i8) -> Option<Self> {
        let mut out = [0i8; 8];
        for (o, e) in out.iter_mut().zip(self.exponents()) {
            *o = e.checked_mul(p)?;
        }
        Some(Self::from_exponents(out))
    }

    fn zip(self, rhs: Self, f: fn(i8, i8) -> Option<i8>) -> Option<Self> {
        let (a, b) = (self.exponents(), rhs.exponents());
        let mut out = [0i8; 8];
        for k in 0..8 {
            out[k] = f(a[k], b[k])?;
        }
        Some(Self::from_exponents(out))
    }
}

/// SI base symbols in the order of [`Dimension::exponents`].
pub(crate) const BASE_SYMBOLS: [&str; 8] = ["m", "kg", "s", "K", "mol", "A", "cd", "rad"];

/// Writes the coherent SI unit of the dimension, e.g. `kg/(m*s^2)`, `1/s`,
/// or `1` for a pure number. The output parses back to the same dimension
/// with scale 1.
impl fmt::Display for Dimension {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Mass first reads naturally (`kg*m^2`); the rest follow L, T, Θ, N, I, J, A.
        const ORDER: [usize; 8] = [1, 0, 2, 3, 4, 5, 6, 7];
        let e = self.exponents();
        let term = |k: usize, p: i8| -> String {
            if p == 1 {
                BASE_SYMBOLS[k].to_string()
            } else {
                format!("{}^{p}", BASE_SYMBOLS[k])
            }
        };
        let num: Vec<String> = ORDER
            .iter()
            .filter(|&&k| e[k] > 0)
            .map(|&k| term(k, e[k]))
            .collect();
        // `unsigned_abs` keeps `-128` well defined; such a dimension cannot be
        // written back (`^128` overflows), which the parser reports.
        let den: Vec<String> = ORDER
            .iter()
            .filter(|&&k| e[k] < 0)
            .map(|&k| {
                let p = e[k].unsigned_abs();
                if p == 1 {
                    BASE_SYMBOLS[k].to_string()
                } else {
                    format!("{}^{p}", BASE_SYMBOLS[k])
                }
            })
            .collect();
        let num = if num.is_empty() {
            "1".to_string()
        } else {
            num.join("*")
        };
        match den.len() {
            0 => f.write_str(&num),
            1 => write!(f, "{num}/{}", den[0]),
            _ => write!(f, "{num}/({})", den.join("*")),
        }
    }
}

macro_rules! dim_kinds {
    ($( $(#[$doc:meta])* $variant:ident => $name:literal, $marker:ident, ($l:expr, $m:expr, $t:expr, $th:expr, $a:expr); )*) => {
        /// A named physical dimension, as written in `x-unit-dimension`.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "snake_case")]
        pub enum DimKind {
            $( $(#[$doc])* $variant, )*
        }

        impl DimKind {
            /// Every named dimension, in declaration order.
            pub const ALL: &'static [DimKind] = &[$(DimKind::$variant,)*];

            /// The `x-unit-dimension` spelling.
            pub const fn name(self) -> &'static str {
                match self { $(DimKind::$variant => $name,)* }
            }

            /// The exponent vector.
            pub const fn dimension(self) -> Dimension {
                match self { $(DimKind::$variant => Dimension::new($l, $m, $t, $th, $a),)* }
            }

            /// Looks a dimension up by its `x-unit-dimension` spelling.
            pub fn from_name(name: &str) -> Option<DimKind> {
                match name { $($name => Some(DimKind::$variant),)* _ => None }
            }
        }

        /// Zero-sized dimension markers for [`crate::Qty`].
        pub mod markers {
            use super::{DimKind, UnitDim};
            $(
                $(#[$doc])*
                #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
                pub struct $marker;
                impl UnitDim for $marker {
                    const KIND: DimKind = DimKind::$variant;
                }
            )*
        }
    };
}

impl DimKind {
    /// The first named dimension with this exponent vector. Energy and torque
    /// share one vector; this returns [`DimKind::Energy`].
    pub fn from_dimension(d: Dimension) -> Option<DimKind> {
        DimKind::ALL.iter().copied().find(|k| k.dimension() == d)
    }
}

/// A compile-time dimension tag for [`crate::Qty`].
pub trait UnitDim {
    const KIND: DimKind;
}

dim_kinds! {
    /// Pure number (ratios, counts, coefficients). Bare numbers allowed.
    Dimensionless => "dimensionless", Dimensionless, (0, 0, 0, 0, 0);
    /// m
    Length => "length", Length, (1, 0, 0, 0, 0);
    /// kg
    Mass => "mass", Mass, (0, 1, 0, 0, 0);
    /// s
    Time => "time", Time, (0, 0, 1, 0, 0);
    /// K
    Temperature => "temperature", Temperature, (0, 0, 0, 1, 0);
    /// rad
    Angle => "angle", Angle, (0, 0, 0, 0, 1);
    /// m^2
    Area => "area", Area, (2, 0, 0, 0, 0);
    /// m^3
    Volume => "volume", Volume, (3, 0, 0, 0, 0);
    /// m/s
    Velocity => "velocity", Velocity, (1, 0, -1, 0, 0);
    /// m/s^2
    Acceleration => "acceleration", Acceleration, (1, 0, -2, 0, 0);
    /// N
    Force => "force", Force, (1, 1, -2, 0, 0);
    /// Pa
    Pressure => "pressure", Pressure, (-1, 1, -2, 0, 0);
    /// kg/m^3
    Density => "density", Density, (-3, 1, 0, 0, 0);
    /// kg/m^2
    AreaDensity => "area_density", AreaDensity, (-2, 1, 0, 0, 0);
    /// kg/m
    LineDensity => "line_density", LineDensity, (-1, 1, 0, 0, 0);
    /// N*s
    Impulse => "impulse", Impulse, (1, 1, -1, 0, 0);
    /// kg/s
    MassFlow => "mass_flow", MassFlow, (0, 1, -1, 0, 0);
    /// rad/s
    AngularVelocity => "angular_velocity", AngularVelocity, (0, 0, -1, 0, 1);
    /// kg*m^2
    Inertia => "inertia", Inertia, (2, 1, 0, 0, 0);
    /// J
    Energy => "energy", Energy, (2, 1, -2, 0, 0);
    /// W
    Power => "power", Power, (2, 1, -3, 0, 0);
    /// 1/s
    Frequency => "frequency", Frequency, (0, 0, -1, 0, 0);
    /// N*m
    Torque => "torque", Torque, (2, 1, -2, 0, 0);
    /// m^2/s (kinematic viscosity)
    KinematicViscosity => "kinematic_viscosity", KinematicViscosity, (2, 0, -1, 0, 0);
    /// Pa*s
    DynamicViscosity => "dynamic_viscosity", DynamicViscosity, (-1, 1, -1, 0, 0);
    /// J/(kg*K)
    SpecificHeat => "specific_heat", SpecificHeat, (2, 0, -2, -1, 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_unique_and_snake_case() {
        let mut names: Vec<&str> = DimKind::ALL.iter().map(|d| d.name()).collect();
        for n in &names {
            assert!(n.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{n}");
        }
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), DimKind::ALL.len());
    }

    #[test]
    fn serde_name_matches_name() {
        for d in DimKind::ALL {
            let s = serde_json::to_value(d).unwrap();
            assert_eq!(s, serde_json::Value::String(d.name().into()));
        }
    }

    #[test]
    fn force_is_mass_times_acceleration() {
        let f = DimKind::Force.dimension();
        let a = DimKind::Acceleration.dimension();
        assert_eq!(f.m, 1);
        assert_eq!((f.l, f.t), (a.l, a.t));
    }
}
