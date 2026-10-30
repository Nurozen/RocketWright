//! Nose-cone and transition profile shapes r(ξ) (R4.1).
//!
//! Every shape is written in *tip coordinates*: ξ runs from 0 at the narrow
//! end (the tip) to `len` at the base, and r rises from 0 to `base`. Callers
//! place the curve in stations (x from the nose tip, +aft) and flip it for
//! transitions that shrink aft. Notation follows `docs/dev/literature-map.md`
//! (`l_n` = `len`, `r_1` = `base`, κ = `param`).

use rw_model::NoseShape;

/// Default shape parameter when the model gives none (or a non-finite one):
/// tangent ogive (κ = 1), 1/2 power, full parabola (κ = 1), Von Kármán (C = 0).
/// cite: n/a parameter defaults, no physics
pub fn default_param(shape: NoseShape) -> f64 {
    match shape {
        NoseShape::Ogive | NoseShape::Parabolic => 1.0,
        NoseShape::Power => 0.5,
        NoseShape::Conical | NoseShape::Ellipsoid | NoseShape::Haack => 0.0,
    }
}

/// Conical profile r = r_1 ξ / l_n.
/// cite: niskanen-2009 eq A.1 p 110
pub fn conical_radius(len: f64, base: f64, xi: f64) -> f64 {
    base * unit(xi, len)
}

/// Secant/tangent ogive: ρ from (A.4), r(ξ) from (A.5); κ = ρ_t/ρ in (0, 1].
/// κ → 0 degenerates to the cone (A.3).
/// cite: niskanen-2009 eq A.5 p 111
pub fn ogive_radius(len: f64, base: f64, kappa: f64, xi: f64) -> f64 {
    let k = kappa.clamp(0.0, 1.0);
    if k < 1e-6 || len <= 0.0 || base <= 0.0 {
        return conical_radius(len, base, xi);
    }
    let xi = xi.clamp(0.0, len);
    let kr = k * base;
    let rho2 =
        (len * len + base * base) * ((2.0 - k) * len * (2.0 - k) * len + kr * kr) / (4.0 * kr * kr);
    let c = len / k;
    let r = (rho2 - (c - xi).powi(2)).max(0.0).sqrt() - (rho2 - c * c).max(0.0).sqrt();
    r.max(0.0)
}

/// Elliptical (half-ellipsoid) profile r = r_1 sqrt(1 - (1 - ξ/l_n)²).
/// cite: niskanen-2009 eq A.6 p 111
pub fn ellipsoid_radius(len: f64, base: f64, xi: f64) -> f64 {
    let u = unit(xi, len);
    base * (1.0 - (1.0 - u) * (1.0 - u)).max(0.0).sqrt()
}

/// Parabolic series r = r_1 (ξ/l_n)(2 - κ ξ/l_n)/(2 - κ), κ in [0, 1].
/// cite: niskanen-2009 eq A.7 p 112
pub fn parabolic_radius(len: f64, base: f64, kappa: f64, xi: f64) -> f64 {
    let k = kappa.clamp(0.0, 1.0);
    let u = unit(xi, len);
    base * u * (2.0 - k * u) / (2.0 - k)
}

/// Power series r = r_1 (ξ/l_n)^κ, κ in [0, 1] (κ = 0 is a blunt cylinder).
/// cite: niskanen-2009 eq A.8 p 112
pub fn power_radius(len: f64, base: f64, kappa: f64, xi: f64) -> f64 {
    let k = kappa.clamp(0.0, 1.0);
    let u = unit(xi, len);
    if k == 0.0 {
        return base;
    }
    base * u.powf(k)
}

/// Haack series r = (r_1/sqrt π) sqrt(θ - sin(2θ)/2 + C sin³θ), θ = acos(1 - 2ξ/l_n)
/// (A.10). C = 0 is Von Kármán (LD), C = 1/3 is LV-Haack.
/// cite: niskanen-2009 eq A.9 p 113
pub fn haack_radius(len: f64, base: f64, c: f64, xi: f64) -> f64 {
    let u = unit(xi, len);
    let theta = (1.0 - 2.0 * u).clamp(-1.0, 1.0).acos();
    let s = theta.sin();
    let v = theta - 0.5 * (2.0 * theta).sin() + c * s * s * s;
    base / std::f64::consts::PI.sqrt() * v.max(0.0).sqrt()
}

/// Radius of `shape` at ξ from the tip (dispatch over the six shapes).
/// cite: niskanen-2009 sec A.1 p 110-113
pub fn shape_radius(shape: NoseShape, param: f64, len: f64, base: f64, xi: f64) -> f64 {
    let p = if param.is_finite() {
        param
    } else {
        default_param(shape)
    };
    match shape {
        NoseShape::Conical => conical_radius(len, base, xi),
        NoseShape::Ogive => ogive_radius(len, base, p, xi),
        NoseShape::Ellipsoid => ellipsoid_radius(len, base, xi),
        NoseShape::Parabolic => parabolic_radius(len, base, p, xi),
        NoseShape::Power => power_radius(len, base, p, xi),
        NoseShape::Haack => haack_radius(len, base, p, xi),
    }
}

/// Non-clipped transition (A.7): the nose shape with base radius |r_aft - r_fore|
/// added to the smaller radius, tip at the narrow end. `x` is measured from the
/// transition's fore end, +aft.
/// cite: niskanen-2009 sec A.7 p 113
pub fn transition_radius(
    shape: NoseShape,
    param: f64,
    len: f64,
    r_fore: f64,
    r_aft: f64,
    x: f64,
) -> f64 {
    let x = x.clamp(0.0, len);
    if r_aft >= r_fore {
        r_fore + shape_radius(shape, param, len, r_aft - r_fore, x)
    } else {
        r_aft + shape_radius(shape, param, len, r_fore - r_aft, len - x)
    }
}

fn unit(xi: f64, len: f64) -> f64 {
    if len <= 0.0 {
        return 1.0;
    }
    (xi / len).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [NoseShape; 6] = [
        NoseShape::Conical,
        NoseShape::Ogive,
        NoseShape::Ellipsoid,
        NoseShape::Power,
        NoseShape::Parabolic,
        NoseShape::Haack,
    ];

    #[test]
    fn every_shape_runs_from_tip_to_base() {
        for shape in ALL {
            for p in [0.0, 0.25, 0.5, 1.0 / 3.0, 0.75, 1.0] {
                if shape == NoseShape::Power && p == 0.0 {
                    continue; // blunt cylinder: r(0) = base by definition
                }
                let r0 = shape_radius(shape, p, 0.3, 0.05, 0.0);
                let r1 = shape_radius(shape, p, 0.3, 0.05, 0.3);
                assert!(r0.abs() < 1e-12, "{shape:?} κ={p}: r(0) = {r0}");
                assert!((r1 - 0.05).abs() < 1e-12, "{shape:?} κ={p}: r(L) = {r1}");
            }
        }
    }

    #[test]
    fn monotone_profiles() {
        for shape in ALL {
            let p = default_param(shape);
            let mut prev = -1.0;
            for k in 0..=200 {
                let r = shape_radius(shape, p, 0.2, 0.03, 0.2 * k as f64 / 200.0);
                assert!(r >= prev - 1e-15, "{shape:?} not monotone at {k}");
                prev = r;
            }
        }
    }

    #[test]
    fn tangent_ogive_matches_circle_arc() {
        // Tangent ogive: arc of radius ρ_t = (R² + L²)/(2R) (A.2), centre at the base
        // station, ρ_t - R below the axis.
        let (l, r) = (0.22_f64, 0.027_f64);
        let rho = (r * r + l * l) / (2.0 * r);
        for k in 0..=10 {
            let x = l * k as f64 / 10.0;
            let expect = (rho * rho - (l - x).powi(2)).sqrt() - (rho - r);
            assert!((ogive_radius(l, r, 1.0, x) - expect).abs() < 1e-12);
        }
    }

    #[test]
    fn limits_reduce_to_cone() {
        for k in 0..=10 {
            let x = 0.1 * k as f64;
            let cone = conical_radius(1.0, 0.1, x);
            assert!((ogive_radius(1.0, 0.1, 0.0, x) - cone).abs() < 1e-15);
            assert!((parabolic_radius(1.0, 0.1, 0.0, x) - cone).abs() < 1e-15);
            assert!((power_radius(1.0, 0.1, 1.0, x) - cone).abs() < 1e-15);
            // a nearly-zero κ ogive is close to the cone
            assert!((ogive_radius(1.0, 0.1, 1e-4, x) - cone).abs() < 1e-5);
        }
    }

    #[test]
    fn transitions_hit_both_radii() {
        for shape in ALL {
            let p = default_param(shape);
            for (rf, ra) in [(0.02, 0.04), (0.04, 0.02)] {
                let a = transition_radius(shape, p, 0.1, rf, ra, 0.0);
                let b = transition_radius(shape, p, 0.1, rf, ra, 0.1);
                assert!(
                    (a - rf).abs() < 1e-12 && (b - ra).abs() < 1e-12,
                    "{shape:?}"
                );
            }
        }
    }
}
