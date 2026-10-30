//! Parasitic drag of launch guides: lugs and rail buttons (Niskanen 2009 §3.4.6),
//! taken on the mean dynamic pressure of the body boundary layer over the
//! guide's height (NACA TM 1299's q̄, layer thickness of NACA TM 1218). Lugs
//! use the 1/7-power turbulent profile; rail buttons a linear one
//! ([`LayerProfile`], PARITY-buttons-2).

use crate::mach::stagnation_cd;

/// Velocity profile u/U(y/δ) across the body boundary layer used for a
/// guide's mean dynamic pressure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerProfile {
    /// u/U = (y/δ)^(1/7) (NACA TM 1218 eq 17.3; literature-map PA-04, PA-05).
    SeventhPower,
    /// u/U = y/δ: the velocity taken to rise linearly from the wall to the
    /// layer edge. A model choice with no source in the folder (literature-map
    /// PA-08, Gaps 10): it gives the strong immersion (q̄ ∝ (h/δ)², so drag
    /// falling with station and rising with speed) of short pins.
    Linear,
}

/// Launch-guide drag on its reference area, max(1.3 − 0.3 l/d, 1) C_D•,stag.
/// cite: niskanen-2009 eq 3.95 p 62
pub fn lug_cd(length: f64, diameter: f64, mach: f64) -> f64 {
    let ratio = if diameter > 0.0 {
        length / diameter
    } else {
        0.0
    };
    (1.3 - 0.3 * ratio).max(1.0) * stagnation_cd(mach)
}

/// Launch-lug reference area π r_ext² − π r_int² max(1 − l/d, 0).
/// cite: niskanen-2009 eq 3.96 p 62
pub fn lug_area(r_ext: f64, r_int: f64, length: f64, diameter: f64) -> f64 {
    let ratio = if diameter > 0.0 {
        length / diameter
    } else {
        0.0
    };
    std::f64::consts::PI * (r_ext * r_ext - r_int * r_int * (1.0 - ratio).max(0.0))
}

/// Frontal sections of a rail-button spool as (y₀, y₁, width), y measured
/// from the body surface: base (outer diameter), neck (neck diameter),
/// flange (outer diameter). Base and flange are clamped to the height.
/// cite: n/a pure geometry (rail-button profile)
pub fn rail_button_sections(
    od: f64,
    id: f64,
    height: f64,
    base: f64,
    flange: f64,
) -> [(f64, f64, f64); 3] {
    let h = height.max(0.0);
    let b = base.clamp(0.0, h);
    let f = flange.clamp(0.0, h - b);
    let (od, id) = (od.max(0.0), id.clamp(0.0, od.max(0.0)));
    [(0.0, b, od), (b, h - f, id), (h - f, h, od)]
}

/// Rail button as a lug of the pin's frontal area with length equal to its
/// diameter: the frontal area is the projected spool profile Σ w (y₁ − y₀)
/// over [`rail_button_sections`] (the neck, not the flange, sets the middle
/// width). Returns (reference area, C_D• on it).
/// cite: niskanen-2009 sec 3.4.6 p 62
pub fn rail_button(sections: &[(f64, f64, f64)], od: f64, mach: f64) -> (f64, f64) {
    let area = sections.iter().map(|&(y0, y1, w)| w * (y1 - y0)).sum();
    (area, lug_cd(od, od, mach))
}

/// Turbulent flat-plate boundary-layer thickness δ = 0.37 x Re_x^(−1/5)
/// (1/7-power profile, valid for Re_x < 10⁷; literature-map PA-04).
/// Infinite for Re_x ≤ 0 (no flow).
/// cite: naca-tm-1218 eq 17.9 p 35
pub fn turbulent_bl_thickness(x: f64, re_x: f64) -> f64 {
    if re_x <= 0.0 || x <= 0.0 {
        return f64::INFINITY;
    }
    0.37 * x * re_x.powf(-0.2)
}

/// Mean dynamic pressure over a protuberance of height h in a boundary layer
/// of thickness δ, relative to the free stream: q̄/Q = (1/h)∫₀ʰ (u/U)² dy
/// with u/U = (y/δ)^(1/7) below δ (TM 1218 eq 17.3) and 1 above, i.e.
/// (7/9)(h/δ)^(2/7) for h ≤ δ and 1 − (2/9) δ/h for h > δ (PA-05).
/// cite: naca-tm-1299 fig 27 p 36
pub fn mean_q_ratio(height: f64, delta: f64) -> f64 {
    if delta <= 0.0 {
        return 1.0;
    }
    if height <= 0.0 {
        return 0.0;
    }
    if height <= delta {
        7.0 / 9.0 * (height / delta).powf(2.0 / 7.0)
    } else {
        1.0 - 2.0 / 9.0 * delta / height
    }
}

/// Mean dynamic pressure over a protuberance of height h for the linear
/// profile u/U = y/δ below δ and 1 above, relative to the free stream:
/// q̄/Q = (1/h)∫₀ʰ (u/U)² dy (the TM 1299 definition of q̄), i.e.
/// (1/3)(h/δ)² for h ≤ δ and 1 − (2/3) δ/h for h > δ (PA-08).
/// cite: naca-tm-1299 sec symbols p 3
pub fn mean_q_ratio_linear(height: f64, delta: f64) -> f64 {
    if delta <= 0.0 {
        return 1.0;
    }
    if height <= 0.0 {
        return 0.0;
    }
    if height <= delta {
        (height / delta).powi(2) / 3.0
    } else {
        1.0 - 2.0 / 3.0 * delta / height
    }
}

/// Boundary-layer factor on a wall protuberance's free-stream drag (PA-06):
/// its drag coefficient on the mean dynamic pressure q̄ over its height is
/// taken as the free-stream value, so D = C_D,free q̄ f and the factor is
/// q̄/Q, with δ from the running length x (station of the protuberance from
/// the nose tip) at Re_x = V x/ν. The source states this for h/δ > 1; the
/// Re(h) dependence of a submerged element is not modelled. Returns 1 when
/// there is no flow (Re_x ≤ 0).
/// cite: naca-tm-1299 sec 4 p 5
pub fn boundary_layer_factor(height: f64, x: f64, re_x: f64) -> f64 {
    if re_x <= 0.0 || x <= 0.0 {
        return 1.0;
    }
    mean_q_ratio(height, turbulent_bl_thickness(x, re_x))
}

/// Boundary-layer factor of a stepped protuberance: its frontal sections
/// (y₀, y₁, width) each take the layer's dynamic pressure over their own
/// heights, D ∝ Σ w ∫_{y₀}^{y₁} (u/U)² dy, with ∫₀ʸ (u/U)² dy = y q̄(y)/Q
/// (PA-05 for the 1/7-power profile, PA-08 for the linear one), divided by
/// the frontal area. Equals [`boundary_layer_factor`] for one section from
/// the wall and the 1/7-power profile. Returns 1 when there is no flow.
/// cite: naca-tm-1299 fig 27 p 36
pub fn profile_bl_factor(
    sections: &[(f64, f64, f64)],
    x: f64,
    re_x: f64,
    profile: LayerProfile,
) -> f64 {
    if re_x <= 0.0 || x <= 0.0 {
        return 1.0;
    }
    let delta = turbulent_bl_thickness(x, re_x);
    let integral = |y: f64| {
        y * match profile {
            LayerProfile::SeventhPower => mean_q_ratio(y, delta),
            LayerProfile::Linear => mean_q_ratio_linear(y, delta),
        }
    };
    let (mut q, mut a) = (0.0, 0.0);
    for &(y0, y1, w) in sections {
        if y1 > y0 && w > 0.0 {
            q += w * (integral(y1) - integral(y0));
            a += w * (y1 - y0);
        }
    }
    if a > 0.0 { q / a } else { 1.0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    #[test]
    fn lug_worked_values() {
        // Long lug (l/d ≥ 1): factor 1, full disc area.
        assert!((lug_cd(0.035, 0.007, 0.0) - 0.85).abs() < 1e-12);
        assert!((lug_area(0.0035, 0.0025, 0.035, 0.007) - PI * 0.0035 * 0.0035).abs() < 1e-15);
        // Wire loop (l → 0): factor 1.3, annulus only.
        assert!((lug_cd(0.0, 0.007, 0.0) - 1.3 * 0.85).abs() < 1e-12);
        let ann = PI * (0.0035_f64.powi(2) - 0.0025_f64.powi(2));
        assert!((lug_area(0.0035, 0.0025, 0.0, 0.007) - ann).abs() < 1e-15);
        // 9.7 mm spool, 8 mm neck, 2 mm base and flange: 9.7·4 + 8·5.7 mm².
        let sec = rail_button_sections(0.0097, 0.008, 0.0097, 0.002, 0.002);
        let (a, cd) = rail_button(&sec, 0.0097, 0.0);
        assert!((a - 84.4e-6).abs() < 1e-12, "{a}");
        assert!((cd - 0.85).abs() < 1e-12);
        // No neck (base + flange = height): the solid od × height pin.
        let solid = rail_button_sections(0.01, 0.006, 0.008, 0.004, 0.004);
        assert!((rail_button(&solid, 0.01, 0.0).0 - 8e-5).abs() < 1e-15);
        // Oversized base and flange are clamped to the height.
        let over = rail_button_sections(0.01, 0.006, 0.008, 0.006, 0.006);
        assert_eq!(
            over,
            [
                (0.0, 0.006, 0.01),
                (0.006, 0.006, 0.006),
                (0.006, 0.008, 0.01)
            ]
        );
    }

    #[test]
    fn boundary_layer_worked_values() {
        // δ = 0.37 x / Re_x^0.2: x = 1 m, Re_x = 10⁷ → 0.37/25.119 = 14.73 mm.
        let d = turbulent_bl_thickness(1.0, 1e7);
        assert!((d - 0.37 / 1e7_f64.powf(0.2)).abs() < 1e-15);
        assert!((d - 0.014730).abs() < 1e-5);
        // q̄/Q: 7/9 at h = δ from both branches, (7/9) 2^(−2/7) at h = δ/2,
        // 1 − 2/18 at h = 2δ, → 1 for h ≫ δ.
        assert!((mean_q_ratio(1.0, 1.0) - 7.0 / 9.0).abs() < 1e-15);
        assert!((mean_q_ratio(1.0 + 1e-12, 1.0) - 7.0 / 9.0).abs() < 1e-11);
        assert!((mean_q_ratio(0.5, 1.0) - 7.0 / 9.0 * 0.5_f64.powf(2.0 / 7.0)).abs() < 1e-15);
        assert!((mean_q_ratio(2.0, 1.0) - (1.0 - 1.0 / 9.0)).abs() < 1e-15);
        assert!(mean_q_ratio(1e6, 1.0) > 0.9999);
        // Numerical check of the integral (1/h)∫ min(y/δ,1)^(2/7) dy at h = 1.5 δ.
        let (h, dl, n) = (1.5, 1.0, 200_000);
        let num: f64 = (0..n)
            .map(|k| {
                let y = (k as f64 + 0.5) * h / n as f64;
                (y / dl).min(1.0).powf(2.0 / 7.0)
            })
            .sum::<f64>()
            / n as f64;
        assert!((mean_q_ratio(h, dl) - num).abs() < 1e-6);
        // A one-section profile from the wall is the plain factor; a stepped
        // spool weights each section's own mean dynamic pressure.
        let (x, re) = (1.0, 5e6);
        let one = profile_bl_factor(&[(0.0, 0.0097, 0.0097)], x, re, LayerProfile::SeventhPower);
        assert!((one - boundary_layer_factor(0.0097, x, re)).abs() < 1e-15);
        let spool = rail_button_sections(0.0097, 0.008, 0.0097, 0.002, 0.002);
        let f = profile_bl_factor(&spool, x, re, LayerProfile::SeventhPower);
        let d = turbulent_bl_thickness(x, re);
        let int = |y: f64| y * mean_q_ratio(y, d);
        let by_hand = (0.0097 * int(0.002)
            + 0.008 * (int(0.0077) - int(0.002))
            + 0.0097 * (int(0.0097) - int(0.0077)))
            / 84.4e-6;
        assert!((f - by_hand).abs() < 1e-12, "{f} vs {by_hand}");
        // Slower than the free stream, faster than the base alone.
        assert!(f < 1.0 && f > mean_q_ratio(0.002, d));
        assert_eq!(profile_bl_factor(&spool, x, 0.0, LayerProfile::Linear), 1.0);
        // No flow: no boundary-layer information, free-stream drag.
        assert_eq!(boundary_layer_factor(0.01, 1.0, 0.0), 1.0);
        assert_eq!(boundary_layer_factor(0.01, 0.0, 1e6), 1.0);
        // Thin layer near the tip → factor near 1; thick layer far aft → small.
        assert!(boundary_layer_factor(0.01, 0.01, 1e5) > 0.9);
        assert!(boundary_layer_factor(0.001, 2.0, 1e7) < 0.5);
    }

    #[test]
    fn linear_profile_worked_values() {
        // q̄/Q = (1/3)(h/δ)² below δ, 1 − (2/3)δ/h above; both 1/3 at h = δ.
        assert!((mean_q_ratio_linear(1.0, 1.0) - 1.0 / 3.0).abs() < 1e-15);
        assert!((mean_q_ratio_linear(1.0 + 1e-12, 1.0) - 1.0 / 3.0).abs() < 1e-11);
        assert!((mean_q_ratio_linear(0.5, 1.0) - 0.25 / 3.0).abs() < 1e-15);
        assert!((mean_q_ratio_linear(3.0, 1.0) - (1.0 - 2.0 / 9.0)).abs() < 1e-15);
        assert_eq!(mean_q_ratio_linear(0.0, 1.0), 0.0);
        assert_eq!(mean_q_ratio_linear(1.0, 0.0), 1.0);
        // Numerical check of (1/h)∫ min(y/δ, 1)² dy at h = 1.5 δ.
        let (h, n) = (1.5, 200_000);
        let num: f64 = (0..n)
            .map(|k| ((k as f64 + 0.5) * h / n as f64).min(1.0).powi(2))
            .sum::<f64>()
            / n as f64;
        assert!((mean_q_ratio_linear(h, 1.0) - num).abs() < 1e-6);
        // A submerged pin: far below the 1/7-power value, and q̄ ∝ δ⁻² so it
        // falls with station (x^-1.6) and rises with speed (Re_x^0.4).
        let spool = rail_button_sections(0.0097, 0.008, 0.0097, 0.002, 0.002);
        let lin = |x: f64, re: f64| profile_bl_factor(&spool, x, re, LayerProfile::Linear);
        let seventh = profile_bl_factor(&spool, 1.0, 7e6, LayerProfile::SeventhPower);
        assert!(
            lin(1.0, 7e6) < 0.2 * seventh,
            "{} vs {seventh}",
            lin(1.0, 7e6)
        );
        assert!((lin(1.0, 7e6 * 2.0) / lin(1.0, 7e6) - 2f64.powf(0.4)).abs() < 1e-9);
        let d = turbulent_bl_thickness(1.0, 7e6);
        let int = |y: f64| y.powi(3) / (3.0 * d * d);
        let by_hand = (0.0097 * int(0.002)
            + 0.008 * (int(0.0077) - int(0.002))
            + 0.0097 * (int(0.0097) - int(0.0077)))
            / 84.4e-6;
        assert!((lin(1.0, 7e6) - by_hand).abs() < 1e-12);
    }
}
