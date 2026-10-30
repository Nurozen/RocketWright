//! The shipped propellant pairs (R4.7) and the custom reactants CEA's
//! database lacks. Plain data, built with or without the `cea` feature, so the
//! table generator, the sidecar's native path, and tests share one definition.
//!
//! Custom reactant enthalpies (assigned enthalpy at 298.15 K, the RP-1311
//! `reac` dataset):
//! - N2O(L), saturated liquid at 298.15 K: h = 71.02 kJ/mol = CEA's gas
//!   Hf (81.600 kJ/mol, Gurvich 1989) minus [h_ig(298.15) - h_liq,sat(298.15)]
//!   from the NIST Webbook fluid data (Lemmon/Span EOS, C10024972).
//! - IPA(L), 2-propanol liquid: ΔfH°liq = -318.1 kJ/mol (NIST Webbook C67630;
//!   Snelson & Skinner 1961, Chao & Rossini 1965).

use crate::problem::Reactant;

/// N2O(L) assigned enthalpy at 298.15 K, J/mol (NIST, see module docs).
pub const N2O_L_H_J_PER_MOL: f64 = 71_020.0;
/// IPA(L) (2-propanol) standard enthalpy of formation, J/mol (NIST).
pub const IPA_L_H_J_PER_MOL: f64 = -318_100.0;
/// Reference temperature of both custom enthalpies, K.
pub const CUSTOM_T_K: f64 = 298.15;

/// Liquid nitrous oxide (custom reactant, N2 O1).
pub fn n2o_l() -> Reactant {
    Reactant::custom_j_per_mol(
        "N2O(L)",
        &[("N", 2.0), ("O", 1.0)],
        N2O_L_H_J_PER_MOL,
        CUSTOM_T_K,
    )
}

/// Liquid isopropanol (custom reactant, C3 H8 O1).
pub fn ipa_l() -> Reactant {
    Reactant::custom_j_per_mol(
        "IPA(L)",
        &[("C", 3.0), ("H", 8.0), ("O", 1.0)],
        IPA_L_H_J_PER_MOL,
        CUSTOM_T_K,
    )
}

/// Liquid oxygen at its normal boiling point (database species).
pub fn lox() -> Reactant {
    Reactant::db("O2(L)", 90.17)
}

/// Liquid ethanol (database species, h = -277.510 kJ/mol, TRC).
pub fn ethanol_l() -> Reactant {
    Reactant::db("C2H5OH(L)", 298.15)
}

/// RP-1 (database species, CH1.95, Mehta et al. 1995).
pub fn rp1() -> Reactant {
    Reactant::db("RP-1", 298.15)
}

/// Liquid methane at its normal boiling point (database species).
pub fn ch4_l() -> Reactant {
    Reactant::db("CH4(L)", 111.643)
}

/// A shipped propellant pair: identifiers, reactants, and the O/F range the
/// tables cover (cea-build.md §9).
#[derive(Debug, Clone, PartialEq)]
pub struct Pair {
    /// Table id, also the `.rwtbl` file stem (`lox-ethanol`).
    pub id: &'static str,
    /// The oxidizer and fuel ids used in queries (`lox`, `ethanol`).
    pub oxidizer: &'static str,
    pub fuel: &'static str,
    pub of_min: f64,
    pub of_max: f64,
}

impl Pair {
    pub fn oxidizer_reactant(&self) -> Reactant {
        reactant(self.oxidizer).expect("known oxidizer")
    }

    pub fn fuel_reactant(&self) -> Reactant {
        reactant(self.fuel).expect("known fuel")
    }
}

/// The six pairs of R4.7, in table order.
pub const PAIRS: [Pair; 6] = [
    Pair {
        id: "lox-ethanol",
        oxidizer: "lox",
        fuel: "ethanol",
        of_min: 0.5,
        of_max: 3.0,
    },
    Pair {
        id: "lox-rp1",
        oxidizer: "lox",
        fuel: "rp1",
        of_min: 1.0,
        of_max: 3.6,
    },
    Pair {
        id: "lox-ch4",
        oxidizer: "lox",
        fuel: "ch4",
        of_min: 1.5,
        of_max: 4.5,
    },
    Pair {
        id: "lox-ipa",
        oxidizer: "lox",
        fuel: "ipa",
        of_min: 0.6,
        of_max: 3.2,
    },
    Pair {
        id: "n2o-ethanol",
        oxidizer: "n2o",
        fuel: "ethanol",
        of_min: 2.0,
        of_max: 10.0,
    },
    Pair {
        id: "n2o-ipa",
        oxidizer: "n2o",
        fuel: "ipa",
        of_min: 2.0,
        of_max: 10.0,
    },
];

/// The reactant for a propellant id (`lox`, `n2o`, `ethanol`, `rp1`, `ch4`, `ipa`).
pub fn reactant(id: &str) -> Option<Reactant> {
    Some(match id {
        "lox" => lox(),
        "n2o" => n2o_l(),
        "ethanol" => ethanol_l(),
        "rp1" => rp1(),
        "ch4" => ch4_l(),
        "ipa" => ipa_l(),
        _ => return None,
    })
}

/// The pair for an oxidizer and fuel id.
pub fn pair(oxidizer: &str, fuel: &str) -> Option<&'static Pair> {
    PAIRS
        .iter()
        .find(|p| p.oxidizer == oxidizer && p.fuel == fuel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::units::EnthalpyUnit;

    #[test]
    fn custom_reactants_carry_nist_enthalpies_in_j_per_mol() {
        match n2o_l() {
            Reactant::Custom {
                enthalpy,
                enthalpy_unit,
                formula,
                ..
            } => {
                assert_eq!(enthalpy, 71_020.0);
                assert_eq!(enthalpy_unit, EnthalpyUnit::JPerMole);
                assert_eq!(formula, [("N".to_string(), 2.0), ("O".to_string(), 1.0)]);
            }
            r => panic!("{r:?}"),
        }
        match ipa_l() {
            Reactant::Custom { enthalpy, .. } => assert_eq!(enthalpy, -318_100.0),
            r => panic!("{r:?}"),
        }
    }

    #[test]
    fn pairs_resolve() {
        for p in &PAIRS {
            assert!(reactant(p.oxidizer).is_some() && reactant(p.fuel).is_some());
            assert_eq!(pair(p.oxidizer, p.fuel), Some(p));
            assert_eq!(p.id, format!("{}-{}", p.oxidizer, p.fuel));
            assert!(p.of_min < p.of_max);
        }
        assert!(pair("lox", "kerosene").is_none());
    }
}
