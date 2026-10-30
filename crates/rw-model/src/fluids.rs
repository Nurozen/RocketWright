//! Liquid propellant reference densities (NIST Chemistry WebBook values at
//! the stated temperature; `docs/dev/literature-map.md` LQ rows). They are
//! inputs, not equations. The model needs them for a filled tank's loaded
//! propellant mass; `rw_liquid::props` re-exports them for the engine design.

use serde::{Deserialize, Serialize};

/// A liquid propellant: id, density, and the temperature it applies at.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LiquidProps {
    pub id: &'static str,
    /// kg/m³.
    pub density: f64,
    /// K.
    pub t_k: f64,
}

const LIQUIDS: &[LiquidProps] = &[
    // Saturated liquid N2O at 20 °C (treated as single-phase, S:129).
    LiquidProps {
        id: "n2o",
        density: 786.6,
        t_k: 293.15,
    },
    LiquidProps {
        id: "ethanol",
        density: 789.3,
        t_k: 293.15,
    },
    LiquidProps {
        id: "ipa",
        density: 785.1,
        t_k: 293.15,
    },
    LiquidProps {
        id: "methanol",
        density: 791.8,
        t_k: 293.15,
    },
    LiquidProps {
        id: "rp1",
        density: 810.0,
        t_k: 293.15,
    },
    LiquidProps {
        id: "water",
        density: 998.2,
        t_k: 293.15,
    },
    // Cryogens at their normal boiling points.
    LiquidProps {
        id: "lox",
        density: 1141.0,
        t_k: 90.17,
    },
    LiquidProps {
        id: "ch4",
        density: 422.6,
        t_k: 111.64,
    },
];

/// Canonical id of a propellant name: table ids pass through; CEA species
/// names (`N2O(L)`, `C2H5OH(L)`, `IPA(L)`, `O2(L)`, `CH4(L)`, `RP-1`,
/// `CH3OH(L)`) map to their ids.
/// cite: n/a name normalisation, no physics
pub fn canonical(name: &str) -> String {
    let n = name.trim();
    let lower = n.to_ascii_lowercase();
    let id = match lower.as_str() {
        "n2o(l)" | "nitrous" | "nitrous_oxide" => "n2o",
        "c2h5oh(l)" | "etoh" => "ethanol",
        "ipa(l)" | "isopropanol" | "c3h8o,2propanol" => "ipa",
        "o2(l)" | "lo2" => "lox",
        "ch4(l)" | "methane" | "lch4" => "ch4",
        "rp-1" | "rp_1" | "kerosene" => "rp1",
        "ch3oh(l)" => "methanol",
        "h2o(l)" => "water",
        other => return other.to_string(),
    };
    id.to_string()
}

/// Liquid properties of a propellant (by id or CEA species name).
/// cite: n/a property table lookup (NIST Chemistry WebBook reference densities)
pub fn liquid(name: &str) -> Option<LiquidProps> {
    let id = canonical(name);
    LIQUIDS.iter().find(|l| l.id == id).copied()
}
