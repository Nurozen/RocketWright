//! Visual flow studies (plan M5.1, D10c): `sims/<id>.rw.toml` with
//! `kind = "visual_flow"`. A study's run is a timeline, not a flight: the
//! tank drains with the engine's engineering blowdown while the attitude
//! source (a scripted tilt on a static stand, or a replayed flight run)
//! sets the body-frame specific force the page 06 GPU fluid settles along.
//! The run's manifest and `visual.json` carry `provenance = "visual"`
//! (I13): the fluid is illustrative and nothing here feeds an engineering
//! number. Everything below is a pure function of its inputs.

use rw_api::{Provenance, VisualEngineGeometry, VisualRun, VisualSample, VisualTank};
use rw_liquid::design::DesignResult;
use rw_model::{AttitudeSource, EdgeBc, EvalEngine, EvalSim, SchemaTag};

/// The study's file beside `manifest.json`.
pub const VISUAL_FILE: &str = "visual.json";

/// Timeline grid step, s.
pub const VISUAL_DT: f64 = 0.05;

/// Standard gravity, m/s².
const G0: f64 = 9.80665;

/// Feed line diameter when the tank's outlet edge gives none, m.
const DEFAULT_FEED_DIAMETER: f64 = 0.010;

/// A flight run's series, as far as a replay needs it (SI).
#[derive(Debug, Clone, PartialEq)]
pub struct ReplaySeries {
    /// `<sim>/<run-id>`.
    pub run: String,
    /// The flight's rod angle from vertical, degrees (the attitude on the pad).
    pub rod_angle_deg: f64,
    pub rail_length: f64,
    pub t: Vec<f64>,
    pub altitude: Vec<f64>,
    pub vz: Vec<f64>,
    pub speed: Vec<f64>,
}

/// Reads `t`, `altitude`, `vz`, and `speed` from a run's `series.csv`.
pub fn parse_replay_csv(
    csv: &str,
    run: &str,
    rod_angle_deg: f64,
    rail_length: f64,
) -> Result<ReplaySeries, String> {
    let mut lines = csv.lines();
    let header: Vec<&str> = lines
        .next()
        .ok_or("series.csv is empty")?
        .split(',')
        .collect();
    let col = |n: &str| {
        header
            .iter()
            .position(|h| *h == n)
            .ok_or_else(|| format!("series.csv has no `{n}` column"))
    };
    let (it, ia, iv, is) = (col("t")?, col("altitude")?, col("vz")?, col("speed")?);
    let mut s = ReplaySeries {
        run: run.to_string(),
        rod_angle_deg,
        rail_length,
        t: Vec::new(),
        altitude: Vec::new(),
        vz: Vec::new(),
        speed: Vec::new(),
    };
    for line in lines.filter(|l| !l.is_empty()) {
        let cells: Vec<&str> = line.split(',').collect();
        let num = |i: usize| cells.get(i).and_then(|c| c.parse::<f64>().ok());
        let (Some(t), Some(a), Some(v), Some(sp)) = (num(it), num(ia), num(iv), num(is)) else {
            continue;
        };
        // Event rows repeat a grid time; keep time strictly increasing.
        if s.t.last().is_some_and(|&last| t <= last) {
            continue;
        }
        s.t.push(t);
        s.altitude.push(a);
        s.vz.push(v);
        s.speed.push(sp);
    }
    if s.t.len() < 2 {
        return Err("series.csv has fewer than two samples".into());
    }
    Ok(s)
}

/// Linear interpolation of `y(x)` at `x0`, clamped to the ends (`xs` increasing).
fn lerp_at(xs: &[f64], ys: &[f64], x0: f64) -> f64 {
    match xs.iter().position(|&x| x >= x0) {
        None => *ys.last().unwrap_or(&0.0),
        Some(0) => ys[0],
        Some(i) => {
            let (x1, x2, y1, y2) = (xs[i - 1], xs[i], ys[i - 1], ys[i]);
            if x2 > x1 {
                y1 + (y2 - y1) * (x0 - x1) / (x2 - x1)
            } else {
                y2
            }
        }
    }
}

/// Scripted tilt on a static stand: the axis swings `swing` about `tilt`
/// from vertical with period `period`. The stand holds the vehicle, so the
/// specific force is gravity's reaction, straight up: in the body frame
/// (+X aft, +Z up) `g (-cos θ, 0, sin θ)`.
pub fn scripted_attitude(t: f64, tilt_deg: f64, swing_deg: f64, period: f64) -> (f64, [f64; 3]) {
    let deg = tilt_deg + swing_deg * (std::f64::consts::TAU * t / period).sin();
    let th = deg.to_radians();
    (deg, [-G0 * th.cos(), 0.0, G0 * th.sin()])
}

/// Replayed flight at `t`: the axis follows the flight path (the rod angle
/// until the vehicle moves), the axial specific force is the speed change
/// plus gravity's along-axis part, and the rail adds gravity's lateral part
/// until the vehicle leaves it (a zero-angle-of-attack replay).
pub fn replay_attitude(r: &ReplaySeries, t: f64) -> (f64, [f64; 3]) {
    let speed = lerp_at(&r.t, &r.speed, t);
    let vz = lerp_at(&r.t, &r.vz, t);
    let th = if speed > 1.0 {
        (vz / speed).clamp(-1.0, 1.0).acos()
    } else {
        r.rod_angle_deg.to_radians()
    };
    let h = 0.5 * VISUAL_DT;
    let dvdt = (lerp_at(&r.t, &r.speed, t + h) - lerp_at(&r.t, &r.speed, (t - h).max(0.0)))
        / (t + h - (t - h).max(0.0));
    let axial = dvdt + G0 * th.cos();
    let on_rail =
        lerp_at(&r.t, &r.altitude, t) < r.rail_length * r.rod_angle_deg.to_radians().cos();
    let lateral = if on_rail { G0 * th.sin() } else { 0.0 };
    (th.to_degrees(), [-axial, 0.0, lateral])
}

fn round(v: f64, sig: usize) -> f64 {
    rw_check::canon::round_sig(v, sig)
}

/// Builds a study's timeline from its evaluated sim, the engine, and the
/// engine's design (whose blowdown drains the tank). `replay` is required
/// for a `run` attitude.
pub fn visual_run(
    sim: &EvalSim,
    engine: &EvalEngine,
    design: &DesignResult,
    run_id: &str,
    replay: Option<&ReplaySeries>,
) -> Result<VisualRun, String> {
    let v = sim
        .visual_flow
        .as_ref()
        .ok_or_else(|| format!("sim `{}` is not a visual flow study", sim.id))?;
    let b = design.blowdown.as_ref().ok_or_else(|| {
        format!(
            "engine `{}` has no blowdown yet (missing inputs)",
            engine.id
        )
    })?;
    let sizing = design
        .design
        .sizing
        .as_ref()
        .ok_or_else(|| format!("engine `{}` has no chamber sizing", engine.id))?;
    let branches = &design.design.feed;
    let node = match &v.tank {
        Some(t) => t.clone(),
        None => branches
            .first()
            .map(|br| br.tank.clone())
            .ok_or_else(|| format!("engine `{}` has no feed branch", engine.id))?,
    };
    let branch = branches
        .iter()
        .position(|br| br.tank == node)
        .ok_or_else(|| format!("tank `{node}` feeds no branch of engine `{}`", engine.id))?;
    let spec = engine
        .nodes
        .get(&node)
        .and_then(|n| n.tank.as_ref())
        .ok_or_else(|| format!("tank `{node}` has no geometry (`tank = {{ length, od, ... }}`)"))?;
    if v.attitude == AttitudeSource::Run && replay.is_none() {
        return Err(format!(
            "study `{}` replays `{}`, which has no run yet",
            sim.id,
            v.replay.as_deref().unwrap_or("?")
        ));
    }
    let liquid = |s: &rw_liquid::blowdown::Sample| {
        if branch == 0 {
            s.ox_liquid
        } else {
            s.fuel_liquid
        }
    };
    let ts: Vec<f64> = b.samples.iter().map(|s| s.t).collect();
    let liq: Vec<f64> = b.samples.iter().map(liquid).collect();
    let mdot: Vec<f64> = b.samples.iter().map(|s| s.mdot_ox + s.mdot_fuel).collect();
    let peak = mdot.iter().copied().fold(0.0, f64::max);
    let liq0 = liq.first().copied().unwrap_or(0.0);
    let t_end = ts.last().copied().unwrap_or(0.0);
    let feed_diameter = engine
        .edges
        .iter()
        .find(|e| e.from == node && e.bc != Some(EdgeBc::Closed))
        .and_then(|e| e.diameter)
        .unwrap_or(DEFAULT_FEED_DIAMETER);

    let n = (v.duration / VISUAL_DT).round().max(1.0) as usize;
    let samples = (0..=n)
        .map(|i| {
            let t = (i as f64 * VISUAL_DT).min(v.duration);
            let (tilt, f) = match (v.attitude, replay) {
                (AttitudeSource::Run, Some(r)) => replay_attitude(r, t),
                _ => scripted_attitude(t, v.tilt_deg, v.swing_deg, v.period),
            };
            let burning = t <= t_end;
            let flow = if burning && peak > 0.0 {
                lerp_at(&ts, &mdot, t) / peak
            } else {
                0.0
            };
            let left = lerp_at(&ts, &liq, t).max(0.0);
            VisualSample {
                t: round(t, 9),
                tilt_deg: round(tilt, 6),
                specific_force: f.map(|x| round(x, 6)),
                relative_flow: round(flow.clamp(0.0, 1.0), 6),
                relative_fill: round(
                    if liq0 > 0.0 {
                        (left / liq0).clamp(0.0, 1.0)
                    } else {
                        0.0
                    },
                    6,
                ),
                fill_fraction: round((left / spec.volume).clamp(0.0, 1.0), 6),
            }
        })
        .collect();

    let attitude_note = match (v.attitude, replay) {
        (AttitudeSource::Run, Some(r)) => format!(
            "Attitude replays flight run {}: the axis follows the flight path, the axial specific force is the speed change plus gravity, and the rail adds gravity's lateral part (zero angle of attack).",
            r.run
        ),
        _ => format!(
            "Attitude is a scripted tilt on a static stand: {} deg ± {} deg from vertical every {} s; the liquid feels gravity only.",
            v.tilt_deg, v.swing_deg, v.period
        ),
    };
    Ok(VisualRun {
        schema: SchemaTag,
        sim: sim.id.clone(),
        sim_name: sim.name.clone(),
        run_id: run_id.to_string(),
        provenance: Provenance::Visual,
        engine: engine.id.clone(),
        engine_name: engine.name.clone(),
        attitude: v.attitude,
        replay_run: replay.filter(|_| v.attitude == AttitudeSource::Run).map(|r| r.run.clone()),
        duration: v.duration,
        burn_time: round(b.burn_time, 9),
        tank: VisualTank {
            node: node.clone(),
            fluid: branches[branch].fluid.clone(),
            length: spec.length,
            od: spec.od,
            wall: spec.wall,
            end_cap: spec.end_cap,
            volume: round(spec.volume, 9),
            fill0: round(if spec.volume > 0.0 { liq0 / spec.volume } else { 0.0 }, 6),
        },
        geometry: VisualEngineGeometry {
            throat_diameter: round(sizing.throat_diameter, 9),
            exit_diameter: round(sizing.exit_diameter, 9),
            chamber_diameter: round(sizing.chamber_diameter, 9),
            chamber_length: round(sizing.chamber_length, 9),
            convergent_length: round(sizing.convergent_length, 9),
            nozzle_length: round(sizing.nozzle_length, 9),
            feed_diameter,
        },
        samples,
        assumptions: vec![
            "Visual model · Not an engineering result: the liquid is an illustrative GPU particle simulation (MLS-MPM), not a CFD solution.".into(),
            format!(
                "The tank drains with the engineering blowdown of engine `{}` (relative fill = liquid left over the initial liquid; burn time {:.2} s).",
                engine.id, b.burn_time
            ),
            "Relative flow is the blowdown's total propellant mass flow over its peak.".into(),
            attitude_note,
            "Streamlines through the feed line, engine inlet, and nozzle are illustrative, not computed.".into(),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series() -> ReplaySeries {
        // Rail 2 m at 5 deg; 10 m/s² for 1 s, then coasting straight up at 30 deg.
        let t: Vec<f64> = (0..=40).map(|i| f64::from(i) * 0.05).collect();
        let speed: Vec<f64> = t.iter().map(|&t| 10.0 * t.min(1.0)).collect();
        let vz: Vec<f64> = speed.iter().map(|s| s * 30f64.to_radians().cos()).collect();
        let altitude: Vec<f64> = t.iter().map(|&t| 5.0 * t * t).collect();
        ReplaySeries {
            run: "baseline/abc".into(),
            rod_angle_deg: 5.0,
            rail_length: 2.0,
            t,
            altitude,
            vz,
            speed,
        }
    }

    #[test]
    fn scripted_tilt_is_gravity_reaction_in_the_body_frame() {
        let (deg, f) = scripted_attitude(0.0, 50.0, 10.0, 4.0);
        assert!((deg - 50.0).abs() < 1e-12);
        assert!((f[0] + G0 * 50f64.to_radians().cos()).abs() < 1e-9);
        assert!((f[2] - G0 * 50f64.to_radians().sin()).abs() < 1e-9);
        let (deg, _) = scripted_attitude(1.0, 50.0, 10.0, 4.0);
        assert!(
            (deg - 60.0).abs() < 1e-9,
            "a quarter period swings to the peak"
        );
        let mag = (f[0] * f[0] + f[1] * f[1] + f[2] * f[2]).sqrt();
        assert!((mag - G0).abs() < 1e-9);
    }

    #[test]
    fn replay_follows_the_flight_path_and_the_rail() {
        let r = series();
        let (deg, f) = replay_attitude(&r, 0.0);
        assert!((deg - 5.0).abs() < 1e-9, "on the pad: the rod angle");
        assert!(f[2] > 0.0, "the rail holds the vehicle laterally");
        let (deg, f) = replay_attitude(&r, 0.5);
        assert!((deg - 30.0).abs() < 1e-6, "{deg}");
        assert!(
            (-f[0] - (10.0 + G0 * 30f64.to_radians().cos())).abs() < 1e-6,
            "{f:?}"
        );
        let (_, f) = replay_attitude(&r, 1.5);
        assert_eq!(f[2], 0.0, "off the rail: no lateral specific force");
        assert!(
            (-f[0] - G0 * 30f64.to_radians().cos()).abs() < 1e-6,
            "coasting: gravity's along-axis part"
        );
    }

    #[test]
    fn parses_a_series_csv() {
        let csv = "t,altitude,x,y,vz,speed\n0,0,0,0,0,0\n0.01,0.1,0,0,1,1\n0.01,0.1,0,0,1,1\n0.02,0.3,0,0,2,2\n";
        let r = parse_replay_csv(csv, "s/1", 5.0, 1.0).unwrap();
        assert_eq!(r.t, [0.0, 0.01, 0.02]);
        assert_eq!(r.speed, [0.0, 1.0, 2.0]);
        assert!(parse_replay_csv("t,altitude\n0,0\n", "s/1", 0.0, 1.0).is_err());
    }

    #[test]
    fn lerp_clamps_to_the_ends() {
        let xs = [0.0, 1.0, 2.0];
        let ys = [0.0, 10.0, 20.0];
        assert_eq!(lerp_at(&xs, &ys, -1.0), 0.0);
        assert_eq!(lerp_at(&xs, &ys, 1.5), 15.0);
        assert_eq!(lerp_at(&xs, &ys, 3.0), 20.0);
    }
}
