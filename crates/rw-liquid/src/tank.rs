//! Tank geometry (SP-125 sec. 8, "Design of Propellant Tanks"): a cylinder
//! closed by two end caps (flat, hemispherical, or 2:1 ellipsoidal heads),
//! the liquid level and centroid for a loaded volume, the ullage centroid,
//! the shell mass, and the hoop stress.
//!
//! Heights `z` run from the aft inner end of the tank (where the liquid
//! settles under thrust) forward. In vehicle stations (+aft) a height `z`
//! sits at `x_aft − wall − z`.

use rw_model::{EndCap, EvalTankSpec};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::solve::brent;

/// A tank's outer geometry and wall.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TankGeom {
    /// Overall length including the end caps and walls.
    pub length: f64,
    pub od: f64,
    pub wall: f64,
    pub end_cap: EndCap,
}

impl From<&EvalTankSpec> for TankGeom {
    fn from(t: &EvalTankSpec) -> Self {
        TankGeom {
            length: t.length,
            od: t.od,
            wall: t.wall,
            end_cap: t.end_cap,
        }
    }
}

/// Volume π r² (h²/c − h³/(3c²)) of a cap of depth `c` filled to height
/// `h` from its pole (an ellipsoidal head of semi-axes r and c).
fn cap_volume(r: f64, c: f64, h: f64) -> f64 {
    if c <= 0.0 {
        return 0.0;
    }
    let h = h.clamp(0.0, c);
    std::f64::consts::PI * r * r * (h * h / c - h.powi(3) / (3.0 * c * c))
}

/// First moment about the pole of the same cap fill.
fn cap_moment(r: f64, c: f64, h: f64) -> f64 {
    if c <= 0.0 {
        return 0.0;
    }
    let h = h.clamp(0.0, c);
    std::f64::consts::PI * r * r * (2.0 * h.powi(3) / (3.0 * c) - h.powi(4) / (4.0 * c * c))
}

impl TankGeom {
    /// Inner radius.
    /// cite: n/a geometry accessor
    pub fn inner_radius(&self) -> f64 {
        (self.od / 2.0 - self.wall).max(0.0)
    }

    /// Inner length, pole to pole.
    /// cite: n/a geometry accessor
    pub fn inner_length(&self) -> f64 {
        (self.length - 2.0 * self.wall).max(0.0)
    }

    /// Depth of one end cap: r (hemisphere), r/2 (2:1 ellipsoid), 0 (flat).
    /// cite: sp-125 eq 8-16 p 347
    pub fn cap_depth(&self) -> f64 {
        rw_model::components::tank::cap_depth(self.end_cap, self.inner_radius())
    }

    fn cylinder(&self) -> f64 {
        (self.inner_length() - 2.0 * self.cap_depth()).max(0.0)
    }

    /// Internal volume: cylinder plus two caps.
    ///
    /// cite: sp-125 eq 8-29 p 348
    pub fn volume(&self) -> f64 {
        self.volume_below(self.inner_length())
    }

    /// Liquid volume below height `z` (from the aft inner pole).
    ///
    /// cite: sp-125 eq 8-29 p 348
    pub fn volume_below(&self, z: f64) -> f64 {
        let (r, c, l) = (self.inner_radius(), self.cap_depth(), self.cylinder());
        let li = 2.0 * c + l;
        let z = z.clamp(0.0, li);
        let full_cap = cap_volume(r, c, c);
        if z <= c {
            cap_volume(r, c, z)
        } else if z <= c + l {
            full_cap + std::f64::consts::PI * r * r * (z - c)
        } else {
            let y0 = li - z;
            full_cap + std::f64::consts::PI * r * r * l + (full_cap - cap_volume(r, c, y0))
        }
    }

    /// First moment of the liquid below `z` about the aft inner pole.
    ///
    /// cite: sp-125 eq 8-29 p 348
    pub fn moment_below(&self, z: f64) -> f64 {
        let (r, c, l) = (self.inner_radius(), self.cap_depth(), self.cylinder());
        let pi_r2 = std::f64::consts::PI * r * r;
        let li = 2.0 * c + l;
        let z = z.clamp(0.0, li);
        if z <= c {
            return cap_moment(r, c, z);
        }
        let bottom = cap_moment(r, c, c);
        let zc = z.min(c + l);
        let cyl = pi_r2 * (zc * zc - c * c) / 2.0;
        if z <= c + l {
            return bottom + cyl;
        }
        // Top cap, measured from the top pole: ∫ (li − y) A(y) dy.
        let y0 = li - z;
        let (v_full, m_full) = (cap_volume(r, c, c), cap_moment(r, c, c));
        let (v0, m0) = (cap_volume(r, c, y0), cap_moment(r, c, y0));
        bottom + cyl + li * (v_full - v0) - (m_full - m0)
    }

    /// Liquid height for a loaded volume `v` (Brent on [`Self::volume_below`]).
    ///
    /// cite: sp-125 eq 8-29 p 348
    pub fn level(&self, v: f64) -> f64 {
        let li = self.inner_length();
        if v <= 0.0 {
            return 0.0;
        }
        if v >= self.volume() {
            return li;
        }
        brent(|z| self.volume_below(z) - v, 0.0, li, 1e-12).unwrap_or(li)
    }

    /// Centroid height of a liquid volume `v` (0 when empty).
    ///
    /// cite: sp-125 eq 8-29 p 348
    pub fn liquid_centroid(&self, v: f64) -> f64 {
        let z = self.level(v);
        let vol = self.volume_below(z);
        if vol > 0.0 {
            self.moment_below(z) / vol
        } else {
            0.0
        }
    }

    /// Centroid height of the ullage above a liquid volume `v`.
    ///
    /// cite: sp-125 eq 8-29 p 348
    pub fn ullage_centroid(&self, v: f64) -> f64 {
        let li = self.inner_length();
        let z = self.level(v);
        let (vt, mt) = (self.volume(), self.moment_below(li));
        let (vl, ml) = (self.volume_below(z), self.moment_below(z));
        if vt - vl > 0.0 {
            (mt - ml) / (vt - vl)
        } else {
            li
        }
    }

    /// Wall (shell) volume: outer envelope minus the cavity.
    ///
    /// cite: sp-125 eq 8-29 p 348
    pub fn shell_volume(&self) -> f64 {
        let outer = TankGeom { wall: 0.0, ..*self };
        (outer.volume() - self.volume()).max(0.0)
    }

    /// Hoop (circumferential membrane) stress at pressure `p` above ambient:
    /// σ = p a / t, with a the mean wall radius (SP-125 eq 8-30 solved for
    /// the stress, weld efficiency 1).
    ///
    /// cite: sp-125 eq 8-30 p 348
    pub fn hoop_stress(&self, p: f64) -> f64 {
        let a = self.inner_radius() + self.wall / 2.0;
        if self.wall > 0.0 {
            p * a / self.wall
        } else {
            f64::INFINITY
        }
    }
}

/// Tank design volume Vt = V + T + B + U (usable, trapped, boil-off, ullage).
///
/// cite: sp-125 eq 8-1 p 341
pub fn design_volume(usable: f64, trapped: f64, boiloff: f64, ullage: f64) -> f64 {
    usable + trapped + boiloff + ullage
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn geom(cap: EndCap) -> TankGeom {
        TankGeom {
            length: 1.0,
            od: 0.2,
            wall: 0.0,
            end_cap: cap,
        }
    }

    #[test]
    fn volumes_and_moments_match_closed_forms() {
        let r: f64 = 0.1;
        let t = geom(EndCap::Hemispherical);
        assert!((t.volume() - (PI * r * r * 0.8 + 4.0 / 3.0 * PI * r.powi(3))).abs() < 1e-14);
        // Symmetric: the full centroid is mid-length.
        assert!((t.moment_below(1.0) / t.volume() - 0.5).abs() < 1e-12);
        // Hemisphere centroid sits 3r/8 above... below its flat face: 5r/8 from the pole.
        let v = t.volume_below(r);
        assert!((t.moment_below(r) / v - 5.0 * r / 8.0).abs() < 1e-12);
        for cap in [EndCap::Flat, EndCap::Ellipsoidal, EndCap::Hemispherical] {
            let t = geom(cap);
            for k in 1..20 {
                let v = t.volume() * f64::from(k) / 20.0;
                let z = t.level(v);
                assert!((t.volume_below(z) - v).abs() < 1e-12 * t.volume());
                // Liquid and ullage centroids recombine to the tank centroid.
                let total = t.liquid_centroid(v) * v + t.ullage_centroid(v) * (t.volume() - v);
                assert!((total / t.volume() - 0.5).abs() < 1e-9, "{cap:?} {k}");
            }
        }
        // A flat tank's liquid centroid is half the level.
        let f = geom(EndCap::Flat);
        assert!((f.liquid_centroid(0.01) - f.level(0.01) / 2.0).abs() < 1e-12);
    }

    #[test]
    fn shell_volume_and_hoop_stress() {
        let t = TankGeom {
            length: 0.5,
            od: 0.1,
            wall: 0.002,
            end_cap: EndCap::Flat,
        };
        let outer = PI * 0.05 * 0.05 * 0.5;
        let inner = PI * 0.048 * 0.048 * 0.496;
        assert!((t.shell_volume() - (outer - inner)).abs() < 1e-15);
        assert!((t.hoop_stress(5e6) - 5e6 * 0.049 / 0.002).abs() < 1e-6);
        assert_eq!(design_volume(1.0, 0.1, 0.0, 0.2), 1.3);
    }
}
