//! Unit strings CEA accepts for reactant inputs, as closed enums.
//!
//! CEA's `convert_units_to_si` (`third_party/cea/source/units.f90`) matches
//! exact lowercase strings and, for anything else, logs an error but returns
//! the raw value with `cea_err == 0`: `"kJ/mol"`, `"KJ/MOLE"`, and `"kj/mol"`
//! all silently become 0 J for a custom reactant. These enums are the only way
//! a unit string reaches CEA from Rust, and parsing accepts only the exact
//! spellings CEA matches.

use std::ffi::CStr;
use std::fmt;
use std::str::FromStr;

/// Enthalpy units for a custom reactant's assigned enthalpy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EnthalpyUnit {
    /// `"j/mole"` (preferred: SI values).
    JPerMole,
    /// `"kj/mole"`.
    KjPerMole,
    /// `"kcal/mole"`.
    KcalPerMole,
    /// `"cal/mole"`.
    CalPerMole,
}

/// Temperature units for a reactant temperature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TempUnit {
    /// `"k"`.
    K,
    /// `"c"`.
    C,
    /// `"f"`.
    F,
    /// `"r"`.
    R,
}

impl EnthalpyUnit {
    pub const ALL: [EnthalpyUnit; 4] = [
        EnthalpyUnit::JPerMole,
        EnthalpyUnit::KjPerMole,
        EnthalpyUnit::KcalPerMole,
        EnthalpyUnit::CalPerMole,
    ];

    /// The exact string CEA matches, NUL-terminated for the C API.
    pub fn as_cstr(self) -> &'static CStr {
        match self {
            EnthalpyUnit::JPerMole => c"j/mole",
            EnthalpyUnit::KjPerMole => c"kj/mole",
            EnthalpyUnit::KcalPerMole => c"kcal/mole",
            EnthalpyUnit::CalPerMole => c"cal/mole",
        }
    }

    pub fn as_str(self) -> &'static str {
        self.as_cstr().to_str().expect("ascii unit")
    }
}

impl TempUnit {
    pub const ALL: [TempUnit; 4] = [TempUnit::K, TempUnit::C, TempUnit::F, TempUnit::R];

    /// The exact string CEA matches, NUL-terminated for the C API.
    pub fn as_cstr(self) -> &'static CStr {
        match self {
            TempUnit::K => c"k",
            TempUnit::C => c"c",
            TempUnit::F => c"f",
            TempUnit::R => c"r",
        }
    }

    pub fn as_str(self) -> &'static str {
        self.as_cstr().to_str().expect("ascii unit")
    }
}

/// A unit string CEA would silently misread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownUnit(pub String);

impl fmt::Display for UnknownUnit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "unit `{}` is not one of CEA's exact lowercase spellings",
            self.0
        )
    }
}

impl std::error::Error for UnknownUnit {}

impl FromStr for EnthalpyUnit {
    type Err = UnknownUnit;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|u| u.as_str() == s)
            .ok_or_else(|| UnknownUnit(s.to_string()))
    }
}

impl FromStr for TempUnit {
    type Err = UnknownUnit;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|u| u.as_str() == s)
            .ok_or_else(|| UnknownUnit(s.to_string()))
    }
}

impl fmt::Display for EnthalpyUnit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl fmt::Display for TempUnit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_lowercase_strings() {
        let h: Vec<&str> = EnthalpyUnit::ALL.iter().map(|u| u.as_str()).collect();
        assert_eq!(h, ["j/mole", "kj/mole", "kcal/mole", "cal/mole"]);
        let t: Vec<&str> = TempUnit::ALL.iter().map(|u| u.as_str()).collect();
        assert_eq!(t, ["k", "c", "f", "r"]);
        for u in EnthalpyUnit::ALL {
            assert_eq!(u.as_str().parse::<EnthalpyUnit>(), Ok(u));
        }
        for u in TempUnit::ALL {
            assert_eq!(u.as_str().parse::<TempUnit>(), Ok(u));
        }
    }

    #[test]
    fn rejects_spellings_cea_silently_misreads() {
        for s in [
            "kJ/mol", "KJ/MOLE", "kj/mol", "kJ/mole", "J/mole", "j/mol", "kcal/mol", "cal", "",
        ] {
            assert!(s.parse::<EnthalpyUnit>().is_err(), "{s:?} accepted");
        }
        for s in ["K", "C", "kelvin", "degc", " k", ""] {
            assert!(s.parse::<TempUnit>().is_err(), "{s:?} accepted");
        }
    }
}
