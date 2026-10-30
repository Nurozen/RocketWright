//! Built-in fluid data: liquid propellant densities and pressurant gas
//! constants. Values are standard reference values (NIST Chemistry WebBook)
//! at the stated temperature; they are inputs, not equations, and
//! `docs/dev/literature-map.md` (LQ rows) lists them.

use serde::{Deserialize, Serialize};

/// Storage temperature assumed for liquids and pressurant (K): 20 °C.
pub const T_STORAGE: f64 = 293.15;

pub use rw_model::fluids::{LiquidProps, canonical, liquid};

/// A pressurant gas: specific gas constant and ratio of specific heats.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GasProps {
    pub id: &'static str,
    /// Specific gas constant R = R_u / M, J/(kg K).
    pub r: f64,
    /// cp/cv.
    pub gamma: f64,
}

const GASES: &[GasProps] = &[
    GasProps {
        id: "n2",
        r: 296.80,
        gamma: 1.40,
    },
    GasProps {
        id: "he",
        r: 2077.1,
        gamma: 1.667,
    },
    GasProps {
        id: "air",
        r: 287.05,
        gamma: 1.40,
    },
];

/// Pressurant gas data (`n2`, `he`, `air`; case-insensitive, `N2`/`helium`).
/// cite: n/a property table lookup (ideal-gas constants)
pub fn gas(name: &str) -> Option<GasProps> {
    let lower = name.trim().to_ascii_lowercase();
    let id = match lower.as_str() {
        "nitrogen" | "gn2" => "n2",
        "helium" | "ghe" => "he",
        other => other,
    };
    GASES.iter().find(|g| g.id == id).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_resolve() {
        assert_eq!(liquid("N2O(L)").unwrap().id, "n2o");
        assert_eq!(liquid("ethanol").unwrap().density, 789.3);
        assert!(liquid("unobtainium").is_none());
        assert_eq!(gas("N2").unwrap().gamma, 1.4);
        assert_eq!(gas("helium").unwrap().id, "he");
    }
}
