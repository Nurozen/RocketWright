//! Pressure-fed blowdown: each tank's ullage gas expands polytropically as
//! liquid leaves (p v^n = const, n = 1 isothermal, n = γ adiabatic), each
//! feed path is a resistance ΔP = R ṁ², and at every instant Brent's method
//! finds the chamber pressure where the two feed flows equal the nozzle flow
//! Pc At / c*(O/F, Pc). Classical RK4 integrates the liquid volumes.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::solve::brent;
use crate::thermo::{Thermo, clamp_to};

/// Ullage pressure after a polytropic expansion from (p0, v0) to v:
/// p = p0 (v0 / v)^n (SP-125 eq 5-15 with the perfect-gas law eq 5-1).
///
/// cite: sp-125 eq 5-15 p 168
pub fn polytropic_pressure(p0: f64, v0: f64, v: f64, n: f64) -> f64 {
    p0 * (v0 / v).powf(n)
}

/// Gas temperature after the same expansion: T = T0 (v0 / v)^(n − 1).
///
/// cite: sp-125 eq 5-15 p 168
pub fn polytropic_temperature(t0: f64, v0: f64, v: f64, n: f64) -> f64 {
    t0 * (v0 / v).powf(n - 1.0)
}

/// Pressurant mass in a volume: W = P V / (R T).
///
/// cite: sp-125 eq 5-1 p 161
pub fn pressurant_mass(p: f64, v: f64, r: f64, t: f64) -> f64 {
    p * v / (r * t)
}

/// One tank and its feed path.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Side {
    /// Internal tank volume, m³.
    pub tank_volume: f64,
    /// Loaded liquid volume, m³.
    pub liquid0: f64,
    /// Initial ullage pressure, Pa.
    pub p0: f64,
    /// Polytropic exponent of the ullage gas.
    pub n: f64,
    /// Liquid density, kg/m³.
    pub density: f64,
    /// Feed resistance tank → chamber (ΔP = R ṁ²), Pa s²/kg².
    pub resistance: f64,
}

impl Side {
    /// Ullage pressure with `liquid` m³ left.
    ///
    /// cite: sp-125 eq 5-15 p 168
    pub fn pressure(&self, liquid: f64) -> f64 {
        let vu0 = self.tank_volume - self.liquid0;
        let vu = self.tank_volume - liquid.max(0.0);
        polytropic_pressure(self.p0, vu0, vu, self.n)
    }

    /// Flow at chamber pressure `pc`: ṁ = √((p − Pc)/R), 0 without a drop.
    ///
    /// cite: sp-125 eq 4-40 p 137
    pub fn flow(&self, p: f64, pc: f64) -> f64 {
        if p > pc && self.resistance > 0.0 {
            ((p - pc) / self.resistance).sqrt()
        } else {
            0.0
        }
    }
}

/// Engine-level blowdown inputs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BlowdownInput {
    pub ox: Side,
    pub fuel: Side,
    pub throat_area: f64,
    pub expansion_ratio: f64,
    pub ambient_pressure: f64,
    /// Integration step and output grid, s.
    pub dt: f64,
    pub t_max: f64,
}

/// The state at one instant.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Sample {
    pub t: f64,
    pub chamber_pressure: f64,
    pub ox_tank_pressure: f64,
    pub fuel_tank_pressure: f64,
    pub mdot_ox: f64,
    pub mdot_fuel: f64,
    pub mixture_ratio: f64,
    pub thrust: f64,
    /// Liquid left, m³.
    pub ox_liquid: f64,
    pub fuel_liquid: f64,
}

/// Why the burn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    OxidizerDepleted,
    FuelDepleted,
    /// The thrust at ambient pressure fell to zero (deep over-expansion).
    ThrustZero,
    /// No chamber pressure balances the flows (a tank fell below the chamber).
    NoBalance,
    TimeLimit,
}

/// A computed blowdown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Blowdown {
    pub samples: Vec<Sample>,
    pub end: EndReason,
    pub burn_time: f64,
    pub total_impulse: f64,
    pub ox_used: f64,
    pub fuel_used: f64,
}

/// The chamber pressure that balances feed and nozzle flow for the given
/// tank pressures, and the resulting flows and O/F.
///
/// cite: sp-125 eq 1-32 p 21
pub fn balance(
    input: &BlowdownInput,
    thermo: &dyn Thermo,
    p_ox: f64,
    p_fuel: f64,
) -> Option<(f64, f64, f64, f64)> {
    let (ox, fuel) = (&input.ox, &input.fuel);
    let of_of = |mo: f64, mf: f64| {
        if mf > 0.0 {
            clamp_to(mo / mf, thermo.of_range())
        } else {
            thermo.of_range().map_or(1e3, |r| r.1)
        }
    };
    let c_star = |of: f64, pc: f64| {
        thermo
            .point(of, clamp_to(pc, thermo.pc_range()), input.expansion_ratio)
            .map(|p| p.c_star)
            .unwrap_or(f64::NAN)
    };
    let g = |pc: f64| {
        let (mo, mf) = (ox.flow(p_ox, pc), fuel.flow(p_fuel, pc));
        mo + mf - pc * input.throat_area / c_star(of_of(mo, mf), pc)
    };
    let hi = p_ox.min(p_fuel);
    if hi.is_nan() || hi <= 0.0 {
        return None;
    }
    let pc = brent(g, hi * 1e-6, hi, 1e-6 * hi).ok()?;
    let (mo, mf) = (ox.flow(p_ox, pc), fuel.flow(p_fuel, pc));
    if !(mo > 0.0 && mf > 0.0) {
        return None;
    }
    Some((pc, mo, mf, of_of(mo, mf)))
}

/// Thrust at ambient pressure: F = Cf_vac Pc At − ε At pa (SP-125 eq 1-33a).
///
/// cite: sp-125 eq 1-33a p 21
pub fn thrust_at(input: &BlowdownInput, thermo: &dyn Thermo, pc: f64, of: f64) -> f64 {
    let cf_vac = thermo
        .point(of, clamp_to(pc, thermo.pc_range()), input.expansion_ratio)
        .map(|p| p.cf_vac)
        .unwrap_or(0.0);
    let at = input.throat_area;
    cf_vac * pc * at - input.expansion_ratio * at * input.ambient_pressure
}

fn sample(input: &BlowdownInput, thermo: &dyn Thermo, t: f64, vo: f64, vf: f64) -> Option<Sample> {
    let (p_ox, p_fuel) = (input.ox.pressure(vo), input.fuel.pressure(vf));
    let (pc, mo, mf, of) = balance(input, thermo, p_ox, p_fuel)?;
    Some(Sample {
        t,
        chamber_pressure: pc,
        ox_tank_pressure: p_ox,
        fuel_tank_pressure: p_fuel,
        mdot_ox: mo,
        mdot_fuel: mf,
        mixture_ratio: of,
        thrust: thrust_at(input, thermo, pc, of),
        ox_liquid: vo,
        fuel_liquid: vf,
    })
}

/// One classical RK4 step of `y' = f(y)` (autonomous), `None` when `f` fails.
///
/// cite: hnw1993 tab 1.2 p 138
pub fn rk4_step<const N: usize>(
    y: [f64; N],
    h: f64,
    f: &dyn Fn([f64; N]) -> Option<[f64; N]>,
) -> Option<[f64; N]> {
    let add = |a: [f64; N], b: [f64; N], s: f64| {
        let mut o = a;
        for i in 0..N {
            o[i] += s * b[i];
        }
        o
    };
    let k1 = f(y)?;
    let k2 = f(add(y, k1, h / 2.0))?;
    let k3 = f(add(y, k2, h / 2.0))?;
    let k4 = f(add(y, k3, h))?;
    let mut o = y;
    for i in 0..N {
        o[i] += h / 6.0 * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]);
    }
    Some(o)
}

/// Integrates the blowdown from ignition until a tank empties, the thrust
/// reaches zero, the flows cannot balance, or `t_max`.
///
/// cite: sp-125 eq 5-15 p 168
pub fn simulate(input: &BlowdownInput, thermo: &dyn Thermo) -> Blowdown {
    let rhs = |y: [f64; 2]| -> Option<[f64; 2]> {
        let (p_ox, p_fuel) = (input.ox.pressure(y[0]), input.fuel.pressure(y[1]));
        let (_, mo, mf, _) = balance(input, thermo, p_ox, p_fuel)?;
        Some([-mo / input.ox.density, -mf / input.fuel.density])
    };
    let mut y = [input.ox.liquid0, input.fuel.liquid0];
    let mut t = 0.0;
    let mut samples = Vec::new();
    let end;
    match sample(input, thermo, 0.0, y[0], y[1]) {
        Some(s) => samples.push(s),
        None => {
            return finish(samples, EndReason::NoBalance, input);
        }
    }
    loop {
        if t >= input.t_max - 1e-12 {
            end = EndReason::TimeLimit;
            break;
        }
        let h = input.dt.min(input.t_max - t);
        let next = rk4_step(y, h, &rhs);
        let Some(mut ny) = next else {
            end = EndReason::NoBalance;
            break;
        };
        let mut nt = t + h;
        // A tank empties within the step: shorten it to the crossing.
        let mut depleted = None;
        for (i, reason) in [
            (0, EndReason::OxidizerDepleted),
            (1, EndReason::FuelDepleted),
        ] {
            if ny[i] <= 0.0 {
                let frac = y[i] / (y[i] - ny[i]);
                if depleted.is_none_or(|(f, _)| frac < f) {
                    depleted = Some((frac, reason));
                }
            }
        }
        if let Some((frac, _)) = depleted {
            let hh = h * frac;
            ny = [y[0] + (ny[0] - y[0]) * frac, y[1] + (ny[1] - y[1]) * frac];
            nt = t + hh;
        }
        let s = sample(input, thermo, nt, ny[0].max(0.0), ny[1].max(0.0));
        match s {
            Some(s) if s.thrust > 0.0 => {
                samples.push(s);
            }
            Some(_) => {
                end = EndReason::ThrustZero;
                break;
            }
            None => {
                end = EndReason::NoBalance;
                break;
            }
        }
        y = ny;
        t = nt;
        if let Some((_, reason)) = depleted {
            end = reason;
            break;
        }
    }
    finish(samples, end, input)
}

fn finish(samples: Vec<Sample>, end: EndReason, input: &BlowdownInput) -> Blowdown {
    let total_impulse = samples
        .windows(2)
        .map(|w| (w[1].t - w[0].t) * (w[0].thrust + w[1].thrust) / 2.0)
        .sum();
    let last = samples.last().copied();
    Blowdown {
        burn_time: last.map_or(0.0, |s| s.t),
        total_impulse,
        ox_used: last.map_or(0.0, |s| (input.ox.liquid0 - s.ox_liquid) * input.ox.density),
        fuel_used: last.map_or(0.0, |s| {
            (input.fuel.liquid0 - s.fuel_liquid) * input.fuel.density
        }),
        samples,
        end,
    }
}

/// One tank draining through its resistance into a constant back pressure
/// (the analytic blowdown case): `(t, ullage pressure, liquid left)` on the
/// RK4 grid until the tank empties or `t_end`.
///
/// cite: sp-125 eq 5-15 p 168
pub fn drain(side: &Side, back_pressure: f64, dt: f64, t_end: f64) -> Vec<(f64, f64, f64)> {
    let rhs = |y: [f64; 1]| -> Option<[f64; 1]> {
        let p = side.pressure(y[0]);
        Some([-side.flow(p, back_pressure) / side.density])
    };
    let mut y = [side.liquid0];
    let mut t = 0.0;
    let mut out = vec![(0.0, side.pressure(y[0]), y[0])];
    while t < t_end - 1e-12 && y[0] > 0.0 {
        let h = dt.min(t_end - t);
        let Some(ny) = rk4_step(y, h, &rhs) else {
            break;
        };
        y = [ny[0].max(0.0)];
        t += h;
        out.push((t, side.pressure(y[0]), y[0]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polytropic_relations() {
        assert!((polytropic_pressure(50e5, 1.0, 2.0, 1.0) - 25e5).abs() < 1e-6);
        let p = polytropic_pressure(50e5, 1.0, 2.0, 1.4);
        assert!((p - 50e5 * 0.5f64.powf(1.4)).abs() < 1e-6);
        // Ideal gas closes: p v = m R T along the path.
        let (r, t0) = (296.8, 293.15);
        let m = pressurant_mass(50e5, 1e-3, r, t0);
        let t = polytropic_temperature(t0, 1e-3, 2e-3, 1.4);
        assert!((p * 2e-3 - m * r * t).abs() < 1e-9);
    }
}
