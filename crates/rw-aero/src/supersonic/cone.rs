//! Supersonic flow on a circular cone (γ = 1.4).
//!
//! Zero incidence: the conical-flow (Taylor-Maccoll) equation in the form
//! and with the procedure of Sims, NASA SP-3004 (1964), pdf p 9: start on the
//! cone surface with a trial surface speed, integrate outward in the ray
//! angle θ until the Rankine-Hugoniot condition (5) holds, read the
//! free-stream Mach number from (6), and iterate the surface speed. Starting
//! on the surface keeps the integration well conditioned for the very
//! slender tangent cones a curved nose needs; the report's Tables 2 and 7
//! (surface pressure and Mach number) are the tests.
//!
//! Small incidence: (dC_N/dα) at α = 0 on the base area, from Sims, NASA
//! SP-3007 (1964) Table 2 (pdf p 28), which tabulates eq (34) (pdf p 14) of
//! Stone's first-order solution to 8 digits. The values below are our own
//! transcription of that table from the rendered page
//! (`tests/validation/nasa_sp_3007/`, which a test compares with this copy).
//! NACA TR 1328 Fig 4 plots the same quantity from Kopal's tables, whose
//! cross-flow component SP-3007 reports as wrongly computed, so SP-3007 is
//! the source (parity-log, supersonic body lift).

use crate::mach::{GAMMA, hermite};

/// Surface state of a cone at zero incidence.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConeFlow {
    /// Mach number on the cone surface.
    pub mach: f64,
    /// Surface pressure over free-stream pressure, p_c/p_∞.
    pub pressure: f64,
    /// Shock half-angle θ_w (rad).
    pub shock_angle: f64,
}

/// Relative step of the ray angle, Δθ = `RAY_STEP` θ.
const RAY_STEP: f64 = 0.04;
/// Half-angle (rad) below which the cone leaves the free stream unchanged
/// (the pressure rise is of order γ M² δ² ln(1/δ) < 1e-6).
const SLENDER: f64 = 1e-4;
/// Ray angle past which no shock is looked for (the wave is then normal to
/// the stream to within 4°, the M_∞ → 1 end of a slender cone's solutions).
const RAY_MAX: f64 = 1.5;

/// (du/dθ, dv/dθ) of SP-3004 (1)-(3): u radial, v = du/dθ, both over the
/// limiting speed.
fn rhs(theta: f64, u: f64, v: f64) -> (f64, f64) {
    let a2 = 0.5 * (GAMMA - 1.0) * (1.0 - u * u - v * v);
    (v, a2 * (u + v / theta.tan()) / (v * v - a2) - u)
}

fn rk4(theta: f64, u: f64, v: f64, h: f64) -> (f64, f64) {
    let k1 = rhs(theta, u, v);
    let k2 = rhs(theta + 0.5 * h, u + 0.5 * h * k1.0, v + 0.5 * h * k1.1);
    let k3 = rhs(theta + 0.5 * h, u + 0.5 * h * k2.0, v + 0.5 * h * k2.1);
    let k4 = rhs(theta + h, u + h * k3.0, v + h * k3.1);
    (
        u + h / 6.0 * (k1.0 + 2.0 * k2.0 + 2.0 * k3.0 + k4.0),
        v + h / 6.0 * (k1.1 + 2.0 * k2.1 + 2.0 * k3.1 + k4.1),
    )
}

/// SP-3004 (5) as a residual that falls through zero at the shock:
/// ((γ−1)/(γ+1)) (1 − u²)/(−v) − u tan θ.
fn shock_residual(theta: f64, u: f64, v: f64) -> f64 {
    (GAMMA - 1.0) / (GAMMA + 1.0) * (1.0 - u * u) / (-v) - u * theta.tan()
}

/// Free-stream Mach number and shock angle of the conical flow with surface
/// Mach number `surface_mach` on a cone of half-angle `delta`. The Mach
/// number is 1 when no shock is met before [`RAY_MAX`] and infinite past the
/// hypersonic limit.
fn free_stream(delta: f64, surface_mach: f64) -> (f64, f64) {
    let g2 = 0.5 * (GAMMA - 1.0);
    let m2 = surface_mach * surface_mach;
    let (mut theta, mut u, mut v) = (delta, (g2 * m2 / (1.0 + g2 * m2)).sqrt(), 0.0);
    // March toward the shock from the surface side. The residual falls
    // monotonically from +∞ on the surface to zero at the shock. Just outside
    // a weak shock the equation is singular (the speed normal to the ray is
    // sonic, v² = a²), and a step across that line returns garbage, so each
    // step covers at most half the distance to the shock estimated from the
    // residual's last rate of fall, and a step that does not lower the
    // residual to a positive value on the subsonic-normal side is retried at
    // half the length.
    let (mut g, mut rate) = (f64::INFINITY, 0.0);
    let mut h = theta * RAY_STEP;
    loop {
        if theta + h > RAY_MAX {
            return (1.0, RAY_MAX);
        }
        let next = rk4(theta, u, v, h);
        let a2 = 0.5 * (GAMMA - 1.0) * (1.0 - next.0 * next.0 - next.1 * next.1);
        let g_next = shock_residual(theta + h, next.0, next.1);
        if next.1 * next.1 < a2 && g_next > 0.0 && g_next < g {
            if g.is_finite() {
                rate = (g - g_next) / h;
            }
            theta += h;
            (u, v, g) = (next.0, next.1, g_next);
            h = theta * RAY_STEP;
            if rate > 0.0 {
                h = h.min(0.5 * g / rate);
            }
        } else {
            h *= 0.5;
        }
        if h < 1e-11 * theta {
            break;
        }
    }
    // Close the remaining gap with one Newton step on the residual.
    let x = if rate > 0.0 { g / rate } else { 0.0 };
    let at = (u + v * x, v);
    let shock = theta + x;
    // (6): M_∞² = (2/(γ−1)) u²/(cos²θ − u²).
    let (c2, u2) = (shock.cos().powi(2), at.0 * at.0);
    if u2 >= c2 {
        return (f64::INFINITY, shock);
    }
    ((u2 / (g2 * (c2 - u2))).sqrt(), shock)
}

/// Mach number and pressure on the surface of a cone of half-angle `delta`
/// (rad) at zero incidence in a stream of Mach number `mach`, and the shock
/// angle. `None` when the shock is detached or the surface flow is not
/// supersonic. The surface pressure follows from the total-pressure loss
/// across the shock and the isentropic relation at the surface Mach number.
/// cite: nasa-sp-3004 eq 1 p 9
/// cite: nasa-sp-3004 eq 5 p 9
/// cite: nasa-sp-3004 eq 6 p 9
pub fn cone_surface(mach: f64, delta: f64) -> Option<ConeFlow> {
    if !(mach > 1.0 && (0.0..1.0).contains(&delta)) {
        return None;
    }
    if delta <= SLENDER {
        return Some(ConeFlow {
            mach,
            pressure: 1.0,
            shock_angle: (1.0 / mach).asin(),
        });
    }
    // The free-stream Mach number rises with the surface Mach number, from
    // the lowest attached-shock value at a sonic surface.
    let (mut lo, mut hi) = (1.0 + 1e-6, mach);
    let mut f_lo = free_stream(delta, lo).0 - mach;
    if f_lo >= 0.0 {
        return None;
    }
    let mut f_hi = free_stream(delta, hi).0 - mach;
    let (mut x, mut shock, mut side) = (hi, 0.0, 0);
    for _ in 0..200 {
        x = if f_hi.is_finite() {
            hi - f_hi * (hi - lo) / (f_hi - f_lo)
        } else {
            0.5 * (lo + hi)
        };
        if !(x > lo && x < hi) {
            x = 0.5 * (lo + hi);
        }
        let (m_inf, s) = free_stream(delta, x);
        shock = s;
        let f = m_inf - mach;
        // Illinois: halve the stale end when the same side is hit twice.
        if f > 0.0 {
            (hi, f_hi) = (x, f);
            if side == 1 {
                f_lo *= 0.5;
            }
            side = 1;
        } else {
            (lo, f_lo) = (x, f);
            if side == -1 {
                f_hi *= 0.5;
            }
            side = -1;
        }
        if f.abs() < 1e-10 * mach || hi - lo < 1e-13 {
            break;
        }
    }
    let mn2 = (mach * shock.sin()).powi(2).max(1.0);
    let p = 1.0 + 2.0 * GAMMA / (GAMMA + 1.0) * (mn2 - 1.0);
    let rho = (GAMMA + 1.0) * mn2 / ((GAMMA - 1.0) * mn2 + 2.0);
    let total = p.powf(-1.0 / (GAMMA - 1.0)) * rho.powf(GAMMA / (GAMMA - 1.0));
    let stag = |m: f64| (1.0 + 0.5 * (GAMMA - 1.0) * m * m).powf(GAMMA / (GAMMA - 1.0));
    Some(ConeFlow {
        mach: x,
        pressure: total * stag(mach) / stag(x),
        shock_angle: shock,
    })
}

/// Mach numbers of SP-3007 Table 2 (rows).
pub const SP3007_MACH: [f64; 16] = [
    1.5, 1.75, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0, 7.0, 8.0, 10.0, 12.0, 15.0, 20.0,
];
/// Cone half-angles of SP-3007 Table 2 in degrees (columns).
pub const SP3007_ANGLE_DEG: [f64; 12] = [
    2.5, 5.0, 7.5, 10.0, 12.5, 15.0, 17.5, 20.0, 22.5, 25.0, 27.5, 30.0,
];
const NA: f64 = f64::NAN;
/// SP-3007 Table 2, (dC_N/dα) at α = 0 per radian on the base area, as
/// printed (pdf p 28). The two blank cells (M 1.5 at 27.5° and 30°) are NaN.
#[rustfmt::skip]
pub const SP3007_CNA: [[f64; 12]; 16] = [
    [1.9770483, 1.9336127, 1.8821566, 1.8280992, 1.7735619, 1.7187816, 1.6630926, 1.6057182, 1.5462941, 1.4852936, NA, NA],
    [1.9731742, 1.9258447, 1.8737533, 1.8224578, 1.7730646, 1.7243971, 1.6746400, 1.6223425, 1.5666956, 1.5075064, 1.4451701, 1.3808820],
    [1.9690287, 1.9180672, 1.8661051, 1.8183423, 1.7742540, 1.7310117, 1.6859216, 1.6372641, 1.5842135, 1.5265736, 1.4645815, 1.3988695],
    [1.9602967, 1.9036740, 1.8548454, 1.8161039, 1.7820973, 1.7472553, 1.7083329, 1.6638860, 1.6134668, 1.5571606, 1.4953496, 1.4286279],
    [1.9514206, 1.8917127, 1.8493550, 1.8202950, 1.7941549, 1.7645092, 1.7287097, 1.6859461, 1.6362061, 1.5798551, 1.5174588, 1.4497109],
    [1.9426977, 1.8826075, 1.8487600, 1.8282076, 1.8074148, 1.7806466, 1.7461812, 1.7037859, 1.6537994, 1.5968132, 1.5335317, 1.4647351],
    [1.9343213, 1.8763907, 1.8516843, 1.8377630, 1.8203259, 1.7949749, 1.7608321, 1.7181330, 1.6674853, 1.6096523, 1.5454397, 1.4756774],
    [1.9264473, 1.8728601, 1.8568202, 1.8477350, 1.8322685, 1.8074272, 1.7730368, 1.7296967, 1.6782310, 1.6195188, 1.5544309, 1.4838272],
    [1.9191785, 1.8715909, 1.8632046, 1.8574765, 1.8430453, 1.8181556, 1.7832011, 1.7390731, 1.6867491, 1.6272149, 1.5613461, 1.4900257],
    [1.9066985, 1.8741557, 1.8772933, 1.8752450, 1.8611884, 1.8352940, 1.7988073, 1.7530357, 1.6991506, 1.6381839, 1.5710540, 1.4986224],
    [1.8972025, 1.8808308, 1.8911403, 1.8902959, 1.8754007, 1.8479983, 1.8098978, 1.7626404, 1.7074620, 1.6453960, 1.5773421, 1.5041237],
    [1.8906735, 1.8893943, 1.9037986, 1.9027991, 1.8865235, 1.8575153, 1.8179511, 1.7694507, 1.7132534, 1.6503536, 1.5816157, 1.5078364],
    [1.8854155, 1.9075860, 1.9248544, 1.9216225, 1.9022129, 1.8703588, 1.8284727, 1.7781460, 1.7205191, 1.6564935, 1.5868584, 1.5123524],
    [1.8876297, 1.9243231, 1.9408134, 1.9345246, 1.9122898, 1.8782443, 1.8347389, 1.7832191, 1.7246910, 1.6599792, 1.5898124, 1.5148790],
    [1.8980460, 1.9449893, 1.9576949, 1.9470431, 1.9215589, 1.8852675, 1.8402027, 1.7875704, 1.7282369, 1.6629184, 1.5922831, 1.5169846],
    [1.9201707, 1.9690214, 1.9743436, 1.9583547, 1.9295376, 1.8911343, 1.8446777, 1.7910947, 1.7310758, 1.6652577, 1.5942431, 1.5186494],
];

/// C¹ interpolant through `(xs, ys)` at `x` (clamped to the ends): cubic
/// Hermite segments with three-point node slopes.
fn interpolate(xs: &[f64], ys: &[f64], x: f64) -> f64 {
    let n = xs.len();
    if n == 1 {
        return ys[0];
    }
    let secant = |i: usize| (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    let slope = |i: usize| {
        if n == 2 {
            secant(0)
        } else if i == 0 {
            let (h0, h1) = (xs[1] - xs[0], xs[2] - xs[1]);
            ((2.0 * h0 + h1) * secant(0) - h0 * secant(1)) / (h0 + h1)
        } else if i == n - 1 {
            let (h0, h1) = (xs[n - 2] - xs[n - 3], xs[n - 1] - xs[n - 2]);
            ((2.0 * h1 + h0) * secant(n - 2) - h1 * secant(n - 3)) / (h0 + h1)
        } else {
            let (h0, h1) = (xs[i] - xs[i - 1], xs[i + 1] - xs[i]);
            (h1 * secant(i - 1) + h0 * secant(i)) / (h0 + h1)
        }
    };
    let x = x.clamp(xs[0], xs[n - 1]);
    let i = xs[1..n - 1].iter().take_while(|&&k| k <= x).count();
    hermite(
        x,
        xs[i],
        xs[i + 1],
        ys[i],
        slope(i),
        ys[i + 1],
        slope(i + 1),
    )
}

/// Normal-force slope (dC_N/dα) at α = 0, per radian on the base area, of a
/// cone of half-angle `delta` (rad) at Mach number `mach`: SP-3007 Table 2
/// interpolated in the half-angle and then in Mach number with C¹ cubics.
/// The slender-body value 2 is added as the δ = 0 column. `None` outside the
/// table: below M 1.5, above 30°, or in its two blank cells (above 25° below
/// M 1.75). Above M 20 the M 20 row is held.
/// cite: nasa-sp-3007 tab 2 p 28
/// cite: nasa-sp-3007 eq 34 p 14
pub fn cone_normal_force_slope(mach: f64, delta: f64) -> Option<f64> {
    let deg = delta.to_degrees();
    if !(mach >= SP3007_MACH[0] && (0.0..=30.0).contains(&deg)) {
        return None;
    }
    let mut angles = [0.0; 13];
    angles[1..].copy_from_slice(&SP3007_ANGLE_DEG);
    let (mut ms, mut vs) = (Vec::with_capacity(16), Vec::with_capacity(16));
    for (m, row) in SP3007_MACH.iter().zip(&SP3007_CNA) {
        let filled = row.iter().take_while(|v| !v.is_nan()).count();
        if deg > SP3007_ANGLE_DEG[filled - 1] {
            continue;
        }
        let mut values = [2.0; 13];
        values[1..].copy_from_slice(row);
        ms.push(*m);
        vs.push(interpolate(&angles[..=filled], &values[..=filled], deg));
    }
    (mach >= ms[0]).then(|| interpolate(&ms, &vs, mach))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_state_matches_sp_3004() {
        // SP-3004 Table 2 (p_s/p_∞, pdf p 13) and Table 7 (surface Mach
        // number, pdf p 18) at (half-angle°, M_∞). The report states an
        // integration error below 5e-6 in its velocities.
        for (deg, mach, p, ms) in [
            (10.0_f64, 1.5, 1.1949823, 1.3748579),
            (10.0, 2.0, 1.2924832, 1.8340453),
            (10.0, 3.0, 1.5510936, 2.7101402),
            (10.0, 6.0, 2.8100784, 4.9927832),
            (7.5, 2.0, 1.1836274, 1.8912335),
            (15.0, 2.0, 1.5662549, 1.7068837),
            (20.0, 3.0, 2.7908532, 2.2899646),
            (20.0, 1.5, 1.6094921, 1.1506488),
            (12.5, 5.0, 2.9432816, 4.0662668),
        ] {
            let c = cone_surface(mach, deg.to_radians()).expect("attached");
            assert!(
                (c.pressure / p - 1.0).abs() < 5e-5,
                "{deg}° M={mach}: p {}",
                c.pressure
            );
            assert!(
                (c.mach / ms - 1.0).abs() < 5e-5,
                "{deg}° M={mach}: M {}",
                c.mach
            );
            assert!(c.shock_angle > (1.0 / mach).asin() && c.shock_angle > deg.to_radians());
        }
    }

    #[test]
    fn slender_cones_approach_the_free_stream() {
        // Slender-body pressure rise C_p ≈ 2δ² ln(2/(β δ)) − δ², within its
        // own O(δ⁴ ln²δ) error, down to the cut-off.
        for mach in [1.5_f64, 3.0, 6.0] {
            let beta = (mach * mach - 1.0).sqrt();
            for delta in [2e-4_f64, 1e-3, 5e-3, 0.0142] {
                let c = cone_surface(mach, delta).expect("attached");
                let cp = 2.0 * delta * delta * (2.0 / (beta * delta)).ln() - delta * delta;
                let rise = 0.5 * GAMMA * mach * mach * cp;
                assert!(
                    ((c.pressure - 1.0) / rise - 1.0).abs() < 0.12,
                    "M={mach} δ={delta}: {} vs {rise}",
                    c.pressure - 1.0
                );
                assert!(c.mach < mach && c.mach > 0.98 * mach);
            }
            let free = cone_surface(mach, 0.0).unwrap();
            assert_eq!((free.mach, free.pressure), (mach, 1.0));
        }
    }

    #[test]
    fn detached_or_subsonic_cones_have_no_solution() {
        // SP-3004 lists M_∞ = 1.1159051 as the lowest for 10° (pdf p 6).
        assert!(cone_surface(1.11, 10f64.to_radians()).is_none());
        assert!(cone_surface(1.12, 10f64.to_radians()).is_some());
        // SP-3007 Table 2 is blank at M 1.5 for 27.5° and 30°.
        assert!(cone_surface(1.5, 27.5f64.to_radians()).is_none());
        assert!(cone_surface(1.5, 25f64.to_radians()).is_some());
        assert!(cone_surface(6.0, 60f64.to_radians()).is_none());
        assert!(cone_surface(0.9, 0.1).is_none());
        // Thick cone near the hypersonic limit of the surface Mach number.
        let c = cone_surface(6.0, 30f64.to_radians()).unwrap();
        assert!(c.mach > 2.0 && c.mach < 3.5 && c.pressure > 10.0);
    }

    #[test]
    fn table_2_copy_matches_the_transcription() {
        let csv = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/validation/nasa_sp_3007/nasa-sp-3007_table-2_dcn-dalpha.csv"
        ));
        let rows: Vec<Vec<&str>> = csv
            .lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .map(|l| l.split(',').collect())
            .collect();
        assert_eq!(rows.len(), 17);
        for (j, a) in SP3007_ANGLE_DEG.iter().enumerate() {
            assert_eq!(rows[0][j + 1].parse::<f64>().unwrap(), *a);
        }
        for (i, row) in rows[1..].iter().enumerate() {
            assert_eq!(row.len(), 13);
            assert_eq!(row[0].parse::<f64>().unwrap(), SP3007_MACH[i]);
            for j in 0..12 {
                let v = SP3007_CNA[i][j];
                if row[j + 1].is_empty() {
                    assert!(v.is_nan(), "row {i} col {j}");
                } else {
                    assert_eq!(row[j + 1].parse::<f64>().unwrap(), v, "row {i} col {j}");
                }
            }
        }
    }

    #[test]
    fn table_2_is_smooth() {
        // A misread digit e in one cell puts up to 6e into the fourth
        // difference along the uniform 2.5° grid. The fourth differences
        // vary smoothly from one Mach row to the next (within 0.004 of the
        // neighbours' mean as transcribed), so this catches a misread of
        // 0.001 or more. It cannot see errors in the later digits.
        let d4 = |row: &[f64; 12]| -> Vec<f64> {
            let n = row.iter().take_while(|v| !v.is_nan()).count();
            (2..n - 2)
                .map(|j| {
                    row[j - 2] - 4.0 * row[j - 1] + 6.0 * row[j] - 4.0 * row[j + 1] + row[j + 2]
                })
                .collect()
        };
        for i in 1..15 {
            let (lo, mid, hi) = (
                d4(&SP3007_CNA[i - 1]),
                d4(&SP3007_CNA[i]),
                d4(&SP3007_CNA[i + 1]),
            );
            for j in 0..lo.len().min(mid.len()).min(hi.len()) {
                let off = mid[j] - 0.5 * (lo[j] + hi[j]);
                assert!(off.abs() < 0.006, "row {i} col {}: {off}", j + 2);
            }
        }
    }

    #[test]
    fn slope_interpolation() {
        // Nodes are returned exactly; 2 at δ = 0 (slender body).
        for (i, m) in SP3007_MACH.iter().enumerate() {
            for (j, a) in SP3007_ANGLE_DEG.iter().enumerate() {
                let v = cone_normal_force_slope(*m, a.to_radians());
                if SP3007_CNA[i][j].is_nan() {
                    assert!(v.is_none());
                } else {
                    assert!((v.unwrap() - SP3007_CNA[i][j]).abs() < 1e-12, "{m} {a}");
                }
            }
            assert_eq!(cone_normal_force_slope(*m, 0.0), Some(2.0));
        }
        // Between nodes the value lies near the neighbours.
        let v = cone_normal_force_slope(2.2, 9f64.to_radians()).unwrap();
        assert!(v > 1.83 && v < 1.86, "{v}");
        // Outside the table.
        assert!(cone_normal_force_slope(1.49, 0.1).is_none());
        assert!(cone_normal_force_slope(3.0, 31f64.to_radians()).is_none());
        assert!(cone_normal_force_slope(1.6, 26f64.to_radians()).is_none());
        assert!(cone_normal_force_slope(1.75, 26f64.to_radians()).is_some());
        assert_eq!(
            cone_normal_force_slope(25.0, 0.2),
            cone_normal_force_slope(20.0, 0.2)
        );
        // C¹ in both directions across a node.
        let h = 1e-6;
        let f = |m: f64, d: f64| cone_normal_force_slope(m, d.to_radians()).unwrap();
        let kink_m = ((f(3.0 + h, 11.0) - f(3.0, 11.0)) - (f(3.0, 11.0) - f(3.0 - h, 11.0))) / h;
        let kink_d = ((f(3.2, 10.0 + h) - f(3.2, 10.0)) - (f(3.2, 10.0) - f(3.2, 10.0 - h))) / h;
        assert!(
            kink_m.abs() < 1e-4 && kink_d.abs() < 1e-4,
            "{kink_m} {kink_d}"
        );
    }
}
