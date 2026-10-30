//! Point-mass flight: the rail phase (1DOF, `crate::rail`) followed by a
//! three-degree-of-freedom point mass with variable mass (R4.5).
//!
//! Free-flight state `[x, y, z, vx, vy, vz]` in the launch-site ENU frame.
//! The equation of motion (MM-12 written in vector form) is
//!
//! m(t) dv/dt = F_T(t) ê + D + m(t) g,  D = -q C_D A_ref v_rel/|v_rel|,
//!
//! with ê the thrust direction (along the air-relative velocity: the point
//! mass is assumed to weathercock instantly; along the rail axis while the
//! airspeed is below [`HEADING_MIN_SPEED`]), v_rel = v - w the air-relative
//! velocity, and g = (0, 0, -g(z)) per `Conditions.geodetic`. m(t) comes from
//! the IF5 mass model (for a [`crate::models::PointMass`]: dry mass plus the
//! motors' `ThrustCurve::mass_at`). The thrust curve already includes the
//! exhaust momentum flux, so no separate m-dot v term appears.
//!
//! Flight sequence: ignition → rail (liftoff when the net force first points
//! up the rail) → rail exit → free flight → apogee → landing (z = 0). The
//! integrator restarts at every motor ignition and burnout (explicit burnout
//! break, F:144); events are located on the dense output (M1.39a).

use rw_model::EvalSim;

use crate::events::Direction;
use crate::integrator::{Event, Stop};
use crate::models::{Vehicle, norm};
use crate::phase::{DenseView, IntegratorChoice, PhaseHooks, run_phase};
use crate::rail::{self, RailState};
use crate::{EventKind, FlightEvent, SimError};

/// Free-flight state `[x, y, z, vx, vy, vz]`.
pub type State3 = [f64; 6];

/// Below this airspeed (m/s) thrust acts along the rail axis instead of the
/// (ill-defined) air-relative velocity direction.
pub const HEADING_MIN_SPEED: f64 = 1e-6;

/// Acceleration (ENU, m/s²) of the free point mass at `t`, state `y`.
///
/// cite: mil-hdbk-762 eq 7-33 p 567
pub fn accel(veh: &Vehicle<'_>, t: f64, seg: Option<(f64, f64)>, y: &State3) -> [f64; 3] {
    let l = veh.loads(t, seg, y[2], [y[3], y[4], y[5]]);
    let e = if l.speed > HEADING_MIN_SPEED {
        [
            l.v_rel[0] / l.speed,
            l.v_rel[1] / l.speed,
            l.v_rel[2] / l.speed,
        ]
    } else {
        veh.env.rail_axis
    };
    let d = l.drag();
    [
        (l.thrust * e[0] + d[0]) / l.mass,
        (l.thrust * e[1] + d[1]) / l.mass,
        (l.thrust * e[2] + d[2]) / l.mass - l.g,
    ]
}

/// Right-hand side `d[x, v]/dt = [v, a]`.
///
/// cite: mil-hdbk-762 eq 7-33 p 567
pub fn rhs(veh: &Vehicle<'_>, t: f64, seg: Option<(f64, f64)>, y: &State3, dy: &mut State3) {
    let a = accel(veh, t, seg, y);
    dy[..3].copy_from_slice(&y[3..]);
    dy[3..].copy_from_slice(&a);
}

/// Run options.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Options3Dof {
    pub integrator: IntegratorChoice,
    /// Integration stops here if the vehicle has not landed (s).
    pub max_time: f64,
    /// Output grid spacing (s); event times are added as exact rows.
    pub sample_dt: f64,
    /// End the flight at apogee instead of landing.
    pub stop_at_apogee: bool,
}

impl Options3Dof {
    /// Options from a simulation definition (integrator per
    /// `Conditions.integrator`, `max_time`, `series_dt`).
    ///
    /// cite: n/a configuration mapping, no physics
    pub fn from_sim(sim: &EvalSim) -> Self {
        Self {
            integrator: IntegratorChoice::from_sim(sim),
            max_time: sim.max_time,
            sample_dt: sim.series_dt,
            stop_at_apogee: false,
        }
    }
}

/// Which equations a sample came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Rail,
    Free,
}

/// One output row.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub t: f64,
    pub phase: Phase,
    /// Position (ENU, m), z above the launch site.
    pub pos: [f64; 3],
    /// Ground velocity (ENU, m/s).
    pub vel: [f64; 3],
    /// Acceleration (ENU, m/s²).
    pub acc: [f64; 3],
    pub speed: f64,
    pub airspeed: f64,
    pub mach: f64,
    pub thrust: f64,
    pub mass: f64,
    pub cd: f64,
}

/// Scalar results of a point-mass flight.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Summary3Dof {
    /// Highest z above the launch site (m).
    pub apogee_m: f64,
    pub time_to_apogee_s: f64,
    pub max_velocity_ms: f64,
    pub max_accel_ms2: f64,
    pub max_mach: f64,
    pub liftoff_time_s: f64,
    pub rail_exit_time_s: f64,
    pub rail_exit_velocity_ms: f64,
    pub burnout_time_s: f64,
    pub burnout_altitude_m: f64,
    /// Landing time, or the end time when the run stopped before landing.
    pub flight_time_s: f64,
    /// Speed at landing (0 when the run did not land).
    pub landing_velocity_ms: f64,
    pub landing_x_m: f64,
    pub landing_y_m: f64,
}

/// A point-mass flight.
#[derive(Debug, Clone, PartialEq)]
pub struct Flight3Dof {
    /// In time order.
    pub events: Vec<FlightEvent>,
    /// Grid rows plus one row per event, in time order.
    pub samples: Vec<Sample>,
    pub summary: Summary3Dof,
    /// True when the run reached a landing (or apogee with `stop_at_apogee`).
    pub completed: bool,
}

/// Raw output row before derived quantities are evaluated.
#[derive(Debug, Clone, Copy)]
enum Row {
    Rail(f64, RailState),
    Free(f64, State3),
}

impl Row {
    fn t(&self) -> f64 {
        match *self {
            Row::Rail(t, _) | Row::Free(t, _) => t,
        }
    }
}

/// Uniform-grid sampler over accepted steps.
pub(crate) struct Grid {
    pub(crate) dt: f64,
    pub(crate) next: u64,
}

impl Grid {
    pub(crate) fn take<S: Clone>(
        &mut self,
        view: &dyn DenseView<S>,
        scratch: &mut S,
        mut push: impl FnMut(f64, &S),
    ) {
        if self.dt <= 0.0 {
            return;
        }
        let (t0, t1) = view.window();
        loop {
            let t = self.next as f64 * self.dt;
            if t > t1 {
                break;
            }
            self.next += 1;
            if t >= t0 {
                view.dense(t, scratch);
                push(t, scratch);
            }
        }
    }
}

pub(crate) fn event(t: f64, kind: EventKind, pos: [f64; 3], vel: [f64; 3]) -> FlightEvent {
    FlightEvent {
        t,
        kind,
        altitude: pos[2],
        velocity: norm(vel),
        source: None,
        branch: None,
    }
}

pub(crate) fn integration_error(e: crate::integrator::IntegratorError) -> SimError {
    let t = match e {
        crate::integrator::IntegratorError::StepSizeUnderflow { t, .. }
        | crate::integrator::IntegratorError::MaxSteps { t }
        | crate::integrator::IntegratorError::NonFinite { t } => t,
    };
    SimError::Integration {
        t,
        message: e.to_string(),
    }
}

/// How the rail phase ended.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct RailOut {
    pub(crate) liftoff: f64,
    pub(crate) t_exit: f64,
    pub(crate) state: RailState,
}

/// Runs the rail phase (1DOF) from t = 0 until rail exit. `on_step` sees
/// every accepted step (sampling, progress; `false` cancels); `on_break`
/// every restart at a break time.
pub(crate) fn fly_rail(
    veh: &Vehicle<'_>,
    integrator: IntegratorChoice,
    t_max: f64,
    breaks: &[f64],
    on_step: &mut dyn FnMut(&dyn DenseView<RailState>) -> bool,
    on_break: &mut dyn FnMut(f64, &RailState),
) -> Result<RailOut, SimError> {
    let rail_len = veh.env.rail_length;
    let y_rest: RailState = [0.0, 0.0];
    let liftoff_at_start = rail::free_accel(veh, 0.0, None, &y_rest) > 0.0;
    let mut liftoff = liftoff_at_start.then_some(0.0);
    if rail_len <= 0.0 && liftoff_at_start {
        return Ok(RailOut {
            liftoff: 0.0,
            t_exit: 0.0,
            state: y_rest,
        });
    }
    let mut cancelled = false;
    let mut ev: [Event<'_, RailState>; 2] = [
        // Liftoff: the net force first points up the rail. With no rail,
        // liftoff is also rail exit.
        Event::new(Direction::Rising, rail_len <= 0.0, |t, y: &RailState| {
            rail::free_accel(veh, t, None, y)
        }),
        Event::new(Direction::Rising, true, move |_t, y: &RailState| {
            y[0] - rail_len
        }),
    ];
    let mut step = |v: &dyn DenseView<RailState>| {
        let keep = on_step(v);
        cancelled |= !keep;
        keep
    };
    let end = run_phase(
        integrator,
        0.0,
        y_rest,
        t_max,
        breaks,
        &mut |seg, t, y: &RailState, dy: &mut RailState| rail::rhs(veh, t, Some(seg), y, dy),
        &mut ev,
        PhaseHooks {
            on_step: &mut step,
            on_break,
        },
    )
    .map_err(integration_error)?;
    if liftoff.is_none() {
        liftoff = end.hits.iter().find(|h| h.index == 0).map(|h| h.t);
    }
    match end.stop {
        Stop::Event(_) => Ok(RailOut {
            liftoff: liftoff.unwrap_or(end.t),
            t_exit: end.t,
            state: end.y,
        }),
        Stop::Cancelled => Err(SimError::Cancelled),
        Stop::End => Err(if cancelled {
            SimError::Cancelled
        } else {
            SimError::Integration {
                t: end.t,
                message: "the vehicle did not leave the rail before max_time".into(),
            }
        }),
    }
}

/// Flies `veh` from ignition: rail 1DOF, then 3DOF point mass to landing (or
/// apogee, or `max_time`). `progress` receives the fraction of `max_time`
/// done; returning `false` cancels.
///
/// cite: mil-hdbk-762 eq 7-33 p 567
pub fn simulate_3dof(
    veh: &Vehicle<'_>,
    opts: &Options3Dof,
    progress: &mut dyn FnMut(f64) -> bool,
) -> Result<Flight3Dof, SimError> {
    let prop = veh.propulsion;
    let ignition = prop.first_ignition().ok_or(SimError::NoMotor)?;
    let burnout = prop.burnout().unwrap_or(ignition);
    let breaks = prop.breaks();
    let t_max = opts.max_time;
    if t_max.is_nan() || t_max <= 0.0 {
        return Err(SimError::Input {
            message: format!("max_time must be positive, got {t_max}"),
        });
    }
    let mut events = vec![event(ignition, EventKind::Ignition, [0.0; 3], [0.0; 3])];
    let mut rows: Vec<Row> = vec![Row::Rail(0.0, [0.0, 0.0])];
    let mut break_rows: Vec<Row> = Vec::new();
    let mut grid = Grid {
        dt: opts.sample_dt,
        next: 1,
    };
    let mut cancelled = false;

    // ---- rail ---------------------------------------------------------------
    let rail_out = {
        let mut scratch: RailState = [0.0, 0.0];
        let mut on_step = |v: &dyn DenseView<RailState>| {
            grid.take(v, &mut scratch, |t, y| rows.push(Row::Rail(t, *y)));
            let keep = progress(v.window().1 / t_max);
            cancelled |= !keep;
            keep
        };
        let mut on_break = |t: f64, y: &RailState| break_rows.push(Row::Rail(t, *y));
        fly_rail(
            veh,
            opts.integrator,
            t_max,
            &breaks,
            &mut on_step,
            &mut on_break,
        )?
    };
    let RailOut {
        liftoff,
        t_exit,
        state: rail_exit_state,
    } = rail_out;
    let (p_exit, v_exit) = rail::to_enu(veh, &rail_exit_state);
    events.push(event(liftoff, EventKind::Liftoff, [0.0; 3], [0.0; 3]));
    events.push(event(t_exit, EventKind::RailExit, p_exit, v_exit));

    // ---- free flight --------------------------------------------------------
    let y0: State3 = [
        p_exit[0], p_exit[1], p_exit[2], v_exit[0], v_exit[1], v_exit[2],
    ];
    rows.push(Row::Free(t_exit, y0));
    let mut ev: [Event<'_, State3>; 2] = [
        Event::new(Direction::Falling, opts.stop_at_apogee, |_t, y: &State3| {
            y[5]
        }),
        Event::new(Direction::Falling, true, |_t, y: &State3| y[2]),
    ];
    let mut scratch = y0;
    let mut on_step = |v: &dyn DenseView<State3>| {
        grid.take(v, &mut scratch, |t, y| rows.push(Row::Free(t, *y)));
        let keep = progress(v.window().1 / t_max);
        cancelled |= !keep;
        keep
    };
    let mut on_break = |t: f64, y: &State3| break_rows.push(Row::Free(t, *y));
    let end = if t_exit < t_max {
        Some(
            run_phase(
                opts.integrator,
                t_exit,
                y0,
                t_max,
                &breaks,
                &mut |seg, t, y: &State3, dy: &mut State3| rhs(veh, t, Some(seg), y, dy),
                &mut ev,
                PhaseHooks {
                    on_step: &mut on_step,
                    on_break: &mut on_break,
                },
            )
            .map_err(integration_error)?,
        )
    } else {
        None
    };
    let (t_end, y_end, stop, hits) = match end {
        Some(e) => (e.t, e.y, e.stop, e.hits),
        None => (t_exit, y0, Stop::End, Vec::new()),
    };
    if stop == Stop::Cancelled {
        return Err(SimError::Cancelled);
    }

    // Burnout (at a break, or at liftoff when it precedes rail exit).
    let burnout_row = break_rows
        .iter()
        .copied()
        .find(|r| r.t() == burnout)
        .filter(|_| burnout <= t_end);
    if let Some(r) = burnout_row {
        let (p, v) = row_pos_vel(veh, &r);
        events.push(event(burnout, EventKind::Burnout, p, v));
    }
    rows.extend(break_rows.iter().copied());
    let mut apogee = None;
    if let Some(h) = hits.iter().find(|h| h.index == 0) {
        let p = [h.y[0], h.y[1], h.y[2]];
        let v = [h.y[3], h.y[4], h.y[5]];
        events.push(event(h.t, EventKind::Apogee, p, v));
        rows.push(Row::Free(h.t, h.y));
        apogee = Some((h.t, h.y[2]));
    }
    let landed = stop == Stop::Event(1);
    if landed {
        let p = [y_end[0], y_end[1], y_end[2]];
        let v = [y_end[3], y_end[4], y_end[5]];
        events.push(event(t_end, EventKind::Landing, p, v));
    }
    rows.push(Row::Free(t_end, y_end));
    events.sort_by(|a, b| a.t.total_cmp(&b.t));

    // ---- samples and summary ------------------------------------------------
    rows.sort_by(|a, b| a.t().total_cmp(&b.t()));
    rows.dedup_by(|b, a| a.t() == b.t());
    let samples: Vec<Sample> = rows.iter().map(|r| sample(veh, r)).collect();
    let (apogee_t, apogee_z) = apogee.unwrap_or_else(|| {
        samples
            .iter()
            .map(|s| (s.t, s.pos[2]))
            .fold(
                (0.0, f64::NEG_INFINITY),
                |a, b| if b.1 > a.1 { b } else { a },
            )
    });
    let max_of = |f: &dyn Fn(&Sample) -> f64| samples.iter().map(f).fold(0.0, f64::max);
    let burn_ev = events.iter().find(|e| e.kind == EventKind::Burnout);
    let summary = Summary3Dof {
        apogee_m: apogee_z,
        time_to_apogee_s: apogee_t,
        max_velocity_ms: max_of(&|s| s.speed),
        max_accel_ms2: max_of(&|s| norm(s.acc)),
        max_mach: max_of(&|s| s.mach),
        liftoff_time_s: liftoff,
        rail_exit_time_s: t_exit,
        rail_exit_velocity_ms: norm(v_exit),
        burnout_time_s: burn_ev.map_or(burnout, |e| e.t),
        burnout_altitude_m: burn_ev.map_or(0.0, |e| e.altitude),
        flight_time_s: t_end,
        landing_velocity_ms: if landed {
            norm([y_end[3], y_end[4], y_end[5]])
        } else {
            0.0
        },
        landing_x_m: y_end[0],
        landing_y_m: y_end[1],
    };
    Ok(Flight3Dof {
        events,
        samples,
        summary,
        completed: landed || (opts.stop_at_apogee && stop == Stop::Event(0)),
    })
}

fn row_pos_vel(veh: &Vehicle<'_>, r: &Row) -> ([f64; 3], [f64; 3]) {
    match *r {
        Row::Rail(_, y) => rail::to_enu(veh, &y),
        Row::Free(_, y) => ([y[0], y[1], y[2]], [y[3], y[4], y[5]]),
    }
}

fn sample(veh: &Vehicle<'_>, r: &Row) -> Sample {
    let (pos, vel) = row_pos_vel(veh, r);
    let t = r.t();
    let (phase, acc) = match *r {
        Row::Rail(_, y) => {
            let a = rail::accel(veh, t, None, &y);
            let u = veh.env.rail_axis;
            (Phase::Rail, [a * u[0], a * u[1], a * u[2]])
        }
        Row::Free(_, y) => (Phase::Free, accel(veh, t, None, &y)),
    };
    let l = veh.loads(t, None, pos[2], vel);
    Sample {
        t,
        phase,
        pos,
        vel,
        acc,
        speed: norm(vel),
        airspeed: l.speed,
        mach: l.mach,
        thrust: l.thrust,
        mass: l.mass,
        cd: l.cd,
    }
}

#[cfg(test)]
mod tests;
