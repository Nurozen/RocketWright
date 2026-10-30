//! One complete flight (R4.5): launch rail (1DOF) → 6DOF rigid body
//! (`crate::sixdof`) → recovery descent (3DOF, `crate::recovery`) → landing.
//!
//! Events: ignition, liftoff, rail exit, burnout, apogee, ejection (each
//! motor's burnout plus its delay), deployment (per device: ejection, apogee,
//! or timer plus delay, or an altitude on descent), tumble (ejection with no
//! device deployed), landing (z = 0 falling). The integrator restarts at every
//! ignition and burnout (F:144) and at every scheduled ejection or deployment
//! time, so no step straddles a change in the equations of motion; apogee,
//! altitude deployments, and landing are located on the dense output.

use std::collections::{BTreeMap, BTreeSet};

use rw_aero::AeroState;
use rw_model::{DeployEvent, EvalSim, RwRef};

use crate::events::Direction;
use crate::integrator::Event;
use crate::models::{Vehicle, norm};
use crate::phase::{DenseView, IntegratorChoice, PhaseHooks, run_phase};
use crate::rail::{self, RailState};
use crate::recovery::{Recovery, descent_accel};
use crate::sixdof::{self, State6};
use crate::threedof::{Grid, RailOut, event, fly_rail, integration_error};
use crate::{EventKind, FlightEvent, SimError};

/// Point-mass descent state `[x, y, z, vx, vy, vz]`.
pub type State3 = [f64; 6];

/// Run options.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FlightOptions {
    pub integrator: IntegratorChoice,
    /// Integration stops here if the vehicle has not landed (s).
    pub max_time: f64,
    /// Output grid spacing (s); event times are added as exact rows.
    pub sample_dt: f64,
}

impl FlightOptions {
    /// Options from a simulation definition (integrator per
    /// `Conditions.integrator`, `max_time`, `series_dt`).
    ///
    /// cite: n/a configuration mapping, no physics
    pub fn from_sim(sim: &EvalSim) -> Self {
        Self {
            integrator: IntegratorChoice::from_sim(sim),
            max_time: sim.max_time,
            sample_dt: sim.series_dt,
        }
    }
}

/// Which equations a sample came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Mode {
    Rail,
    Free,
    Descent,
}

/// One output row.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub t: f64,
    pub mode: Mode,
    /// Position (ENU, m), z above the launch site.
    pub pos: [f64; 3],
    /// Ground velocity (ENU, m/s).
    pub vel: [f64; 3],
    /// Acceleration (ENU, m/s²).
    pub acc: [f64; 3],
    pub speed: f64,
    pub airspeed: f64,
    pub mach: f64,
    /// Total angle of attack (rad); 0 on the rail and in descent.
    pub aoa: f64,
    pub thrust: f64,
    pub mass: f64,
    /// CG station (m).
    pub cg: f64,
    /// CP station (m); `None` in descent.
    pub cp: Option<f64>,
    /// Static margin (cal); `None` in descent.
    pub stability: Option<f64>,
    /// Drag coefficient on the vehicle reference area (in descent: the
    /// deployed drag area over it).
    pub cd: f64,
}

/// A complete flight.
#[derive(Debug, Clone, PartialEq)]
pub struct Flight {
    /// In time order.
    pub events: Vec<FlightEvent>,
    /// Grid rows plus one row per event, in time order.
    pub samples: Vec<Sample>,
    /// True when the vehicle landed before `max_time`.
    pub landed: bool,
    /// Reference area (m²) and length (m) of the aero model.
    pub ref_area: f64,
    pub ref_length: f64,
    /// Motors with an ejection delay, by mount id (sorted).
    pub ejection_delays: Vec<EjectionDelay>,
}

/// A motor's burnout time and configured ejection delay (s).
#[derive(Debug, Clone, PartialEq)]
pub struct EjectionDelay {
    pub mount: String,
    pub burnout: f64,
    pub delay: f64,
}

#[derive(Debug, Clone, Copy)]
enum Row {
    Rail(f64, RailState),
    Free(f64, State6),
    Descent(f64, State3, f64),
}

impl Row {
    fn t(&self) -> f64 {
        match *self {
            Row::Rail(t, _) | Row::Free(t, _) | Row::Descent(t, _, _) => t,
        }
    }
    fn mode(&self) -> Mode {
        match self {
            Row::Rail(..) => Mode::Rail,
            Row::Free(..) => Mode::Free,
            Row::Descent(..) => Mode::Descent,
        }
    }
}

/// Current flight state after the rail.
#[derive(Debug, Clone, Copy)]
enum Dyn {
    Free(State6),
    /// Descent with the active drag area C_D·A (m²).
    Descent(State3, f64),
}

impl Dyn {
    fn pos_vel(&self) -> ([f64; 3], [f64; 3]) {
        let y = match self {
            Dyn::Free(y) => &y[..6],
            Dyn::Descent(y, _) => &y[..],
        };
        ([y[0], y[1], y[2]], [y[3], y[4], y[5]])
    }
    fn row(&self, t: f64) -> Row {
        match *self {
            Dyn::Free(y) => Row::Free(t, y),
            Dyn::Descent(y, cda) => Row::Descent(t, y, cda),
        }
    }
    fn descent(&self, cda: f64) -> Dyn {
        let (p, v) = self.pos_vel();
        Dyn::Descent([p[0], p[1], p[2], v[0], v[1], v[2]], cda)
    }
}

/// Point-mass descent right-hand side.
///
/// cite: niskanen-2013 sec 4.2.5 p 78
pub fn descent_rhs(veh: &Vehicle<'_>, t: f64, cd_area: f64, y: &State3, dy: &mut State3) {
    let a = descent_accel(
        veh.env,
        y[2],
        [y[3], y[4], y[5]],
        cd_area,
        veh.mass.at(t).mass,
    );
    dy[..3].copy_from_slice(&y[3..]);
    dy[3..].copy_from_slice(&a);
}

/// Device bookkeeping during a flight.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Pending {
    /// Deployment time once known.
    at: Option<f64>,
    done: bool,
}

const TIME_EPS: f64 = 1e-12;

/// One leg of a staged flight: the vehicle that flies from `t_start` (the
/// launch for the first leg, a stage separation for the others).
#[derive(Clone, Copy)]
pub struct Leg<'a> {
    pub t_start: f64,
    pub veh: Vehicle<'a>,
    pub recovery: &'a Recovery,
}

/// A stack released at a stage separation and flown on as a branch: `leg`
/// is the released stack's vehicle (its `t_start` is the separation time).
#[derive(Clone, Copy)]
pub struct Release<'a> {
    /// The separating stage (`branches/<stage>/`).
    pub stage: &'a str,
    /// Its first body component (the event source).
    pub first: &'a str,
    pub leg: Leg<'a>,
}

/// A staged flight: the main vehicle plus one branch per released stack.
#[derive(Debug, Clone, PartialEq)]
pub struct StagedFlight {
    pub main: Flight,
    /// `(stage, flight)` in separation order.
    pub branches: Vec<(String, Flight)>,
}

/// The record of one flight under construction.
struct Track {
    events: Vec<FlightEvent>,
    /// `(leg index, row)`.
    rows: Vec<(usize, Row)>,
    break_rows: Vec<(usize, Row)>,
    grid: Grid,
}

/// Flies `veh` from ignition to landing (or `max_time`) with the recovery
/// setup `recovery`. `progress` receives the fraction of `max_time` done;
/// returning `false` cancels.
///
/// cite: n/a phase sequencing over the cited equations of motion
pub fn simulate_flight(
    veh: &Vehicle<'_>,
    recovery: &Recovery,
    opts: &FlightOptions,
    progress: &mut dyn FnMut(f64) -> bool,
) -> Result<Flight, SimError> {
    let legs = [Leg {
        t_start: 0.0,
        veh: *veh,
        recovery,
    }];
    simulate_staged(&legs, &[], opts, progress).map(|s| s.main)
}

/// Flies a staged vehicle: `legs[0]` from ignition, switching to `legs[i]`
/// at its `t_start` (a stage separation), where `releases[i - 1]` leaves and
/// is flown on as a branch to its own landing. A branch starts in tumbling
/// descent (no attitude; the released stack is not assumed stable) from the
/// separation state, and deploys its own recovery devices. The integrator
/// restarts at every separation, like at every scheduled event.
///
/// cite: n/a phase sequencing over the cited equations of motion
pub fn simulate_staged(
    legs: &[Leg<'_>],
    releases: &[Release<'_>],
    opts: &FlightOptions,
    progress: &mut dyn FnMut(f64) -> bool,
) -> Result<StagedFlight, SimError> {
    let Some(first_leg) = legs.first() else {
        return Err(SimError::Input {
            message: "a flight needs at least one vehicle leg".into(),
        });
    };
    if releases.len() + 1 != legs.len() {
        return Err(SimError::Input {
            message: "every leg after the first needs its released stack".into(),
        });
    }
    let veh = &first_leg.veh;
    let prop = veh.propulsion;
    let ignition = prop.first_ignition().ok_or(SimError::NoMotor)?;
    let t_max = opts.max_time;
    if t_max.is_nan() || t_max <= 0.0 {
        return Err(SimError::Input {
            message: format!("max_time must be positive, got {t_max}"),
        });
    }
    let breaks = prop.breaks();
    let mut track = Track {
        events: vec![event(ignition, EventKind::Ignition, [0.0; 3], [0.0; 3])],
        rows: vec![(0, Row::Rail(0.0, [0.0, 0.0]))],
        break_rows: Vec::new(),
        grid: Grid {
            dt: opts.sample_dt,
            next: 1,
        },
    };

    // ---- rail ---------------------------------------------------------------
    let RailOut {
        liftoff,
        t_exit,
        state: rail_exit,
    } = {
        let mut scratch: RailState = [0.0, 0.0];
        let (grid, rows, break_rows) = (&mut track.grid, &mut track.rows, &mut track.break_rows);
        let mut on_step = |v: &dyn DenseView<RailState>| {
            grid.take(v, &mut scratch, |t, y| rows.push((0, Row::Rail(t, *y))));
            progress(v.window().1 / t_max)
        };
        let mut on_break = |t: f64, y: &RailState| break_rows.push((0, Row::Rail(t, *y)));
        fly_rail(
            veh,
            opts.integrator,
            t_max,
            &breaks,
            &mut on_step,
            &mut on_break,
        )?
    };
    let (p_exit, v_exit) = rail::to_enu(veh, &rail_exit);
    track
        .events
        .push(event(liftoff, EventKind::Liftoff, [0.0; 3], [0.0; 3]));
    track
        .events
        .push(event(t_exit, EventKind::RailExit, p_exit, v_exit));
    track.rows.push((0, Row::Rail(t_exit, rail_exit)));

    // ---- free flight, separations, and descent ------------------------------
    let start = Dyn::Free(sixdof::initial_state(p_exit, v_exit, veh.env.rail_axis));
    let mut branches = Vec::new();
    let landed = fly_legs(
        legs,
        releases,
        start,
        t_exit,
        false,
        opts,
        &mut track,
        &mut branches,
        progress,
    )?;

    // Burnout and later ignitions (at a break row, on the rail or in free
    // flight; or at an event row when a phase ended exactly there).
    let at_row = |track: &Track, tb: f64| {
        track
            .break_rows
            .iter()
            .chain(track.rows.iter())
            .find(|r| r.1.t() == tb)
            .map(|&(i, r)| row_pos_vel(&legs[i].veh, &r))
    };
    // One burnout per distinct motor burnout time (each stage's motors).
    let mut burnouts: Vec<f64> = prop
        .motors()
        .iter()
        .map(crate::models::Propulsion::motor_burnout)
        .collect();
    burnouts.sort_by(f64::total_cmp);
    burnouts.dedup();
    for tb in burnouts {
        if let Some((p, v)) = at_row(&track, tb) {
            track.events.push(event(tb, EventKind::Burnout, p, v));
        }
    }
    let mut lit: Vec<f64> = prop
        .motors()
        .iter()
        .map(|m| m.ignition_time)
        .filter(|&t| t > ignition)
        .collect();
    lit.sort_by(f64::total_cmp);
    lit.dedup();
    for ti in lit {
        if let Some((p, v)) = at_row(&track, ti) {
            track.events.push(event(ti, EventKind::Ignition, p, v));
        }
    }
    Ok(StagedFlight {
        main: finish(legs, track, landed),
        branches,
    })
}

/// The grid index of the first sample at or after `t`.
fn grid_from(dt: f64, t: f64) -> u64 {
    if dt > 0.0 {
        (t / dt - 1e-9).ceil().max(0.0) as u64
    } else {
        0
    }
}

/// Flies a released stack from the separation state to its landing.
fn fly_branch(
    r: &Release<'_>,
    from: &Dyn,
    t: f64,
    separation: FlightEvent,
    opts: &FlightOptions,
    progress: &mut dyn FnMut(f64) -> bool,
) -> Result<Flight, SimError> {
    let legs = [r.leg];
    let start = from.descent(r.leg.recovery.tumble_cd_area);
    let mut track = Track {
        events: vec![separation],
        rows: vec![(0, start.row(t))],
        break_rows: Vec::new(),
        grid: Grid {
            dt: opts.sample_dt,
            next: grid_from(opts.sample_dt, t),
        },
    };
    let landed = fly_legs(
        &legs,
        &[],
        start,
        t,
        true,
        opts,
        &mut track,
        &mut Vec::new(),
        progress,
    )?;
    Ok(finish(&legs, track, landed))
}

/// Sorts and samples a finished track.
fn finish(legs: &[Leg<'_>], mut track: Track, landed: bool) -> Flight {
    track.rows.append(&mut track.break_rows);
    track.events.sort_by(|a, b| a.t.total_cmp(&b.t));
    let key = |r: &(usize, Row)| (r.1.mode(), r.0);
    track
        .rows
        .sort_by(|a, b| a.1.t().total_cmp(&b.1.t()).then(key(a).cmp(&key(b))));
    track
        .rows
        .dedup_by(|b, a| a.1.t() == b.1.t() && key(a) == key(b));
    let (ref_area, ref_length) = reference(&legs[0].veh);
    let samples = track
        .rows
        .iter()
        .map(|(i, r)| sample(&legs[*i].veh, r, ref_area))
        .collect();
    let mut delays: BTreeMap<&str, EjectionDelay> = BTreeMap::new();
    for m in legs.iter().flat_map(|l| l.veh.propulsion.motors()) {
        if let Some(delay) = m.delay {
            delays.entry(m.mount.as_str()).or_insert(EjectionDelay {
                mount: m.mount.clone(),
                burnout: crate::models::Propulsion::motor_burnout(m),
                delay,
            });
        }
    }
    Flight {
        events: track.events,
        samples,
        landed,
        ref_area,
        ref_length,
        ejection_delays: delays.into_values().collect(),
    }
}

/// Deployed drag area of a leg's devices.
fn deployed_cda(recovery: &Recovery, pending: &BTreeMap<String, Pending>) -> Option<f64> {
    let done: Vec<f64> = recovery
        .devices
        .iter()
        .filter(|d| pending.get(&d.id).is_some_and(|p| p.done))
        .map(|d| d.cd_area)
        .collect();
    (!done.is_empty()).then(|| done.iter().sum())
}

/// The free-flight and descent loop over the legs from `t0` in `state`.
/// Returns whether the vehicle landed.
#[allow(clippy::too_many_arguments)]
fn fly_legs(
    legs: &[Leg<'_>],
    releases: &[Release<'_>],
    mut state: Dyn,
    t0: f64,
    mut tumbling: bool,
    opts: &FlightOptions,
    track: &mut Track,
    branches: &mut Vec<(String, Flight)>,
    progress: &mut dyn FnMut(f64) -> bool,
) -> Result<bool, SimError> {
    let t_max = opts.max_time;
    let mut t = t0;
    let mut cur = 0usize;
    let mut fired: BTreeSet<String> = BTreeSet::new();
    let mut pending: BTreeMap<String, Pending> = BTreeMap::new();
    for leg in legs {
        for d in &leg.recovery.devices {
            pending.entry(d.id.clone()).or_insert(Pending {
                at: (d.event == DeployEvent::Timer).then_some(d.delay),
                done: false,
            });
        }
    }
    let mut apogee: Option<(f64, f64)> = None;
    let mut landed = false;
    loop {
        // Stage separations due now: the released stack flies on as a branch.
        while cur + 1 < legs.len() && legs[cur + 1].t_start <= t + TIME_EPS {
            let r = &releases[cur];
            let (p, v) = state.pos_vel();
            let mut ev = event(t, EventKind::StageSeparation, p, v);
            ev.source = Some(RwRef(format!("rw:c/{}", r.first)));
            track.events.push(ev.clone());
            track.rows.push((cur, state.row(t)));
            let b = fly_branch(r, &state, t, ev, opts, progress)?;
            branches.push((r.stage.to_string(), b));
            cur += 1;
            if let Dyn::Descent(..) = state {
                let cda = deployed_cda(legs[cur].recovery, &pending)
                    .unwrap_or(legs[cur].recovery.tumble_cd_area);
                state = state.descent(cda);
            }
            track.rows.push((cur, state.row(t)));
        }
        let leg = &legs[cur];
        let veh = &leg.veh;
        let recovery = leg.recovery;

        // This leg's ejection charges (each motor's burnout plus its delay).
        let mut ejections: Vec<(f64, &str)> = veh
            .propulsion
            .motors()
            .iter()
            .filter_map(|m| {
                let end = m.ignition_time + m.curve.points.last().map_or(0.0, |p| p.t);
                m.delay.map(|d| (end + d, m.mount.as_str()))
            })
            .collect();
        ejections.sort_by(|a, b| a.0.total_cmp(&b.0));
        let first_ejection = ejections.first().map(|e| e.0);
        for d in &recovery.devices {
            if d.event == DeployEvent::Ejection
                && let Some(pd) = pending.get_mut(&d.id)
                && !pd.done
            {
                pd.at = first_ejection.map(|e| e + d.delay);
            }
        }

        // Actions due now: ejection charges, then deployments.
        let (p, v) = state.pos_vel();
        for e in &ejections {
            if e.0 <= t + TIME_EPS && fired.insert(e.1.to_string()) {
                let mut ev = event(e.0, EventKind::Ejection, p, v);
                ev.source = Some(RwRef(format!("rw:c/{}", e.1)));
                track.events.push(ev);
            }
        }
        let mut deployed_now = false;
        for d in &recovery.devices {
            let Some(pd) = pending.get_mut(&d.id) else {
                continue;
            };
            if !pd.done && pd.at.is_some_and(|a| a <= t + TIME_EPS) {
                pd.done = true;
                deployed_now = true;
                let mut ev = event(t, EventKind::Deployment, p, v);
                ev.source = Some(RwRef(format!("rw:c/{}", d.id)));
                track.events.push(ev);
            }
        }
        let deployed = deployed_cda(recovery, &pending);
        let ejected = ejections.iter().any(|e| fired.contains(e.1));
        if deployed_now {
            track.rows.push((cur, state.row(t)));
            state = state.descent(deployed.unwrap_or(0.0));
            track.rows.push((cur, state.row(t)));
        } else if deployed.is_none() && !tumbling && ejected && matches!(state, Dyn::Free(_)) {
            // Ejected with nothing deployed: the vehicle tumbles.
            tumbling = true;
            track.events.push(event(t, EventKind::Tumble, p, v));
            track.rows.push((cur, state.row(t)));
            state = state.descent(recovery.tumble_cd_area);
            track.rows.push((cur, state.row(t)));
        }
        if t >= t_max - TIME_EPS {
            break;
        }

        let next = ejections
            .iter()
            .filter(|e| !fired.contains(e.1))
            .map(|e| e.0)
            .chain(
                recovery
                    .devices
                    .iter()
                    .filter_map(|d| pending.get(&d.id))
                    .filter(|p| !p.done)
                    .filter_map(|p| p.at),
            )
            .chain(legs.get(cur + 1).map(|l| l.t_start))
            .filter(|&a| a > t + TIME_EPS)
            .fold(t_max, f64::min);
        let open =
            |d: &crate::recovery::RecoveryDevice| pending.get(&d.id).is_some_and(|p| !p.done);
        let apogee_needed = apogee.is_none();
        // Stop at apogee for apogee devices, and for unarmed altitude devices:
        // one whose altitude the flight never climbs above deploys at apogee
        // (the fallback below), so the segment must not run on past it.
        let apogee_terminal = apogee_needed
            && recovery.devices.iter().any(|d| {
                open(d)
                    && (d.event == DeployEvent::Apogee
                        || (d.event == DeployEvent::Altitude
                            && pending.get(&d.id).is_some_and(|p| p.at.is_none())))
            });
        // Altitude deployments armed after apogee (on descent).
        let alt_devs: Vec<(usize, f64)> = recovery
            .devices
            .iter()
            .enumerate()
            .filter(|(_, d)| {
                open(d)
                    && pending.get(&d.id).is_some_and(|p| p.at.is_none())
                    && d.event == DeployEvent::Altitude
            })
            .filter_map(|(i, d)| d.altitude.map(|h| (i, h)))
            .collect();

        let breaks = veh.propulsion.breaks();
        let watch = Watch {
            apogee: apogee_needed.then_some(apogee_terminal),
            altitudes: &alt_devs,
        };
        let mut on_progress = |w: (f64, f64)| progress(w.1 / t_max);
        let out = match state {
            Dyn::Free(y0) => run_free(
                veh,
                cur,
                opts.integrator,
                t,
                y0,
                next,
                &breaks,
                watch,
                track,
                &mut on_progress,
            )?,
            Dyn::Descent(y0, cda) => run_descent(
                veh,
                cur,
                opts.integrator,
                t,
                y0,
                cda,
                next,
                &breaks,
                watch,
                track,
                &mut on_progress,
            )?,
        };
        t = out.t;
        state = out.state;
        if let Some((ta, sa)) = out.apogee {
            let (p, v) = sa.pos_vel();
            track.events.push(event(ta, EventKind::Apogee, p, v));
            track.rows.push((cur, sa.row(ta)));
            apogee = Some((ta, p[2]));
            for d in &recovery.devices {
                let Some(pd) = pending.get_mut(&d.id) else {
                    continue;
                };
                if pd.done || pd.at.is_some() {
                    continue;
                }
                // Apogee devices; and altitude devices whose altitude the
                // flight never climbed above (they deploy at apogee).
                let below =
                    d.event == DeployEvent::Altitude && d.altitude.is_some_and(|h| h >= p[2]);
                if d.event == DeployEvent::Apogee || below {
                    pd.at = Some(ta + d.delay);
                }
            }
        }
        match out.stop {
            SegStop::Cancelled => return Err(SimError::Cancelled),
            SegStop::Event(Watched::Landing) => {
                let (p, v) = state.pos_vel();
                track.events.push(event(t, EventKind::Landing, p, v));
                landed = true;
                break;
            }
            SegStop::Event(Watched::Altitude(i)) => {
                let d = &recovery.devices[i];
                if let Some(pd) = pending.get_mut(&d.id) {
                    pd.at = Some(t + d.delay);
                }
            }
            SegStop::Event(Watched::Apogee) | SegStop::End => {}
        }
    }
    track.rows.push((cur, state.row(t)));
    Ok(landed)
}

/// Reference area and length of the aero model.
fn reference(veh: &Vehicle<'_>) -> (f64, f64) {
    let c = veh.aero.eval_at(
        0.0,
        &AeroState {
            mach: 0.0,
            speed: 0.0,
            alpha: 0.0,
            roll_rate: 0.0,
            pitch_rate: 0.0,
            kinematic_viscosity: veh.env.air(0.0).kinematic_viscosity,
            thrusting: false,
        },
        veh.mass.at(0.0).cg,
    );
    (c.ref_area, c.ref_length)
}

/// Events watched during a free-flight or descent segment.
struct Watch<'w> {
    /// `Some(terminal)` while apogee is still to be found.
    apogee: Option<bool>,
    /// Pending altitude deployments `(device index, altitude)`.
    altitudes: &'w [(usize, f64)],
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Watched {
    Apogee,
    Landing,
    Altitude(usize),
}

struct SegmentEnd {
    stop: SegStop<Watched>,
    t: f64,
    state: Dyn,
    /// Apogee located in this segment (time and state).
    apogee: Option<(f64, Dyn)>,
}

/// [`crate::integrator::Stop`] with the event index mapped to what it means.
#[derive(Debug, Clone, Copy, PartialEq)]
enum SegStop<E> {
    End,
    Event(E),
    Cancelled,
}

#[allow(clippy::too_many_arguments)]
fn run_free(
    veh: &Vehicle<'_>,
    leg: usize,
    integrator: IntegratorChoice,
    t0: f64,
    y0: State6,
    t_end: f64,
    breaks: &[f64],
    watch: Watch<'_>,
    track: &mut Track,
    progress: &mut dyn FnMut((f64, f64)) -> bool,
) -> Result<SegmentEnd, SimError> {
    let mut map = Vec::new();
    let mut ev: Vec<Event<'_, State6>> = Vec::new();
    if let Some(terminal) = watch.apogee {
        map.push(Watched::Apogee);
        ev.push(Event::new(
            Direction::Falling,
            terminal,
            |_t, y: &State6| y[5],
        ));
    }
    map.push(Watched::Landing);
    ev.push(Event::new(Direction::Falling, true, |_t, y: &State6| y[2]));
    for &(i, h) in watch.altitudes {
        map.push(Watched::Altitude(i));
        ev.push(Event::new(
            Direction::Falling,
            true,
            move |_t, y: &State6| y[2] - h,
        ));
    }
    let mut scratch = y0;
    let (grid, rows, break_rows) = (&mut track.grid, &mut track.rows, &mut track.break_rows);
    let mut on_step = |v: &dyn DenseView<State6>| {
        grid.take(v, &mut scratch, |t, y| rows.push((leg, Row::Free(t, *y))));
        progress(v.window())
    };
    let mut on_break = |t: f64, y: &State6| break_rows.push((leg, Row::Free(t, *y)));
    let end = run_phase(
        integrator,
        t0,
        y0,
        t_end,
        breaks,
        &mut |seg, t, y: &State6, dy: &mut State6| sixdof::rhs(veh, t, Some(seg), y, dy),
        &mut ev,
        PhaseHooks {
            on_step: &mut on_step,
            on_break: &mut on_break,
        },
    )
    .map_err(integration_error)?;
    let apogee = end
        .hits
        .iter()
        .find(|h| map[h.index] == Watched::Apogee)
        .map(|h| (h.t, Dyn::Free(h.y)));
    Ok(SegmentEnd {
        stop: map_stop(end.stop, &map),
        t: end.t,
        state: Dyn::Free(end.y),
        apogee,
    })
}

#[allow(clippy::too_many_arguments)]
fn run_descent(
    veh: &Vehicle<'_>,
    leg: usize,
    integrator: IntegratorChoice,
    t0: f64,
    y0: State3,
    cda: f64,
    t_end: f64,
    breaks: &[f64],
    watch: Watch<'_>,
    track: &mut Track,
    progress: &mut dyn FnMut((f64, f64)) -> bool,
) -> Result<SegmentEnd, SimError> {
    let mut map = Vec::new();
    let mut ev: Vec<Event<'_, State3>> = Vec::new();
    if let Some(terminal) = watch.apogee {
        map.push(Watched::Apogee);
        ev.push(Event::new(
            Direction::Falling,
            terminal,
            |_t, y: &State3| y[5],
        ));
    }
    map.push(Watched::Landing);
    ev.push(Event::new(Direction::Falling, true, |_t, y: &State3| y[2]));
    for &(i, h) in watch.altitudes {
        map.push(Watched::Altitude(i));
        ev.push(Event::new(
            Direction::Falling,
            true,
            move |_t, y: &State3| y[2] - h,
        ));
    }
    let mut scratch = y0;
    let (grid, rows, break_rows) = (&mut track.grid, &mut track.rows, &mut track.break_rows);
    let mut on_step = |v: &dyn DenseView<State3>| {
        grid.take(v, &mut scratch, |t, y| {
            rows.push((leg, Row::Descent(t, *y, cda)))
        });
        progress(v.window())
    };
    let mut on_break = |t: f64, y: &State3| break_rows.push((leg, Row::Descent(t, *y, cda)));
    let end = run_phase(
        integrator,
        t0,
        y0,
        t_end,
        breaks,
        &mut |_seg, t, y: &State3, dy: &mut State3| descent_rhs(veh, t, cda, y, dy),
        &mut ev,
        PhaseHooks {
            on_step: &mut on_step,
            on_break: &mut on_break,
        },
    )
    .map_err(integration_error)?;
    let apogee = end
        .hits
        .iter()
        .find(|h| map[h.index] == Watched::Apogee)
        .map(|h| (h.t, Dyn::Descent(h.y, cda)));
    Ok(SegmentEnd {
        stop: map_stop(end.stop, &map),
        t: end.t,
        state: Dyn::Descent(end.y, cda),
        apogee,
    })
}

fn map_stop(s: crate::integrator::Stop, map: &[Watched]) -> SegStop<Watched> {
    match s {
        crate::integrator::Stop::End => SegStop::End,
        crate::integrator::Stop::Event(i) => SegStop::Event(map[i]),
        crate::integrator::Stop::Cancelled => SegStop::Cancelled,
    }
}

fn row_pos_vel(veh: &Vehicle<'_>, r: &Row) -> ([f64; 3], [f64; 3]) {
    match *r {
        Row::Rail(_, y) => rail::to_enu(veh, &y),
        Row::Free(_, y) => ([y[0], y[1], y[2]], [y[3], y[4], y[5]]),
        Row::Descent(_, y, _) => ([y[0], y[1], y[2]], [y[3], y[4], y[5]]),
    }
}

fn sample(veh: &Vehicle<'_>, r: &Row, ref_area: f64) -> Sample {
    let (pos, vel) = row_pos_vel(veh, r);
    let t = r.t();
    match *r {
        Row::Rail(_, y) => {
            let u = veh.env.rail_axis;
            let a = rail::accel(veh, t, None, &y);
            let l = sixdof::loads(veh, t, None, &sixdof::initial_state(pos, vel, u));
            Sample {
                t,
                mode: Mode::Rail,
                pos,
                vel,
                acc: [a * u[0], a * u[1], a * u[2]],
                speed: norm(vel),
                airspeed: l.airspeed,
                mach: l.mach,
                aoa: 0.0,
                thrust: l.thrust,
                mass: l.mass,
                cg: l.cg,
                cp: Some(l.cp),
                stability: Some(l.stability_cal()),
                cd: l.cd,
            }
        }
        Row::Free(_, y) => {
            let l = sixdof::loads(veh, t, None, &y);
            Sample {
                t,
                mode: Mode::Free,
                pos,
                vel,
                acc: l.accel,
                speed: norm(vel),
                airspeed: l.airspeed,
                mach: l.mach,
                aoa: l.aoa,
                thrust: l.thrust,
                mass: l.mass,
                cg: l.cg,
                cp: Some(l.cp),
                stability: Some(l.stability_cal()),
                cd: l.cd,
            }
        }
        Row::Descent(_, y, cda) => {
            let mp = veh.mass.at(t);
            let acc = descent_accel(veh.env, y[2], vel, cda, mp.mass);
            let air = veh.env.air(y[2]);
            let w = veh.env.wind_at(y[2]);
            let airspeed = norm([vel[0] - w[0], vel[1] - w[1], vel[2] - w[2]]);
            Sample {
                t,
                mode: Mode::Descent,
                pos,
                vel,
                acc,
                speed: norm(vel),
                airspeed,
                mach: airspeed / air.speed_of_sound,
                aoa: 0.0,
                thrust: veh.propulsion.thrust(t),
                mass: mp.mass,
                cg: mp.cg,
                cp: None,
                stability: None,
                cd: if ref_area > 0.0 { cda / ref_area } else { 0.0 },
            }
        }
    }
}

#[cfg(test)]
mod tests;
