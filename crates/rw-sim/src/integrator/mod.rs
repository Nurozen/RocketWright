//! ODE integrators for the flight phases (R4.5, D13).
//!
//! - [`Dp54`]: Dormand-Prince 5(4) with step-size control and dense output,
//!   the default (Hairer, Norsett, Wanner, *Solving ODEs I*, 2nd ed. 1993,
//!   sec. II.4-II.6).
//! - [`Rk4`]: classical fixed-step Runge-Kutta with cubic Hermite dense output,
//!   for parity triage against fixed-step references (D13).
//! - [`solve`]: drives either stepper to `t_end`, locating events on the dense
//!   output (`crate::events`) and stopping on the first terminal one.
//!
//! Everything is generic over the state type ([`OdeState`]): fixed arrays,
//! `Vec<f64>`, or any flat `f64` vector a flight model defines. Integration
//! runs forward in time only.

pub mod dp54;
pub mod rk4;

pub use dp54::{Dp54, Dp54Options};
pub use rk4::Rk4;

use crate::events::{Direction, brent_root, crosses};

/// A state vector the integrators can work on: a flat view of `f64`s.
pub trait OdeState: Clone {
    fn as_slice(&self) -> &[f64];
    fn as_mut_slice(&mut self) -> &mut [f64];
}

impl<const N: usize> OdeState for [f64; N] {
    fn as_slice(&self) -> &[f64] {
        self
    }
    fn as_mut_slice(&mut self) -> &mut [f64] {
        self
    }
}

impl OdeState for Vec<f64> {
    fn as_slice(&self) -> &[f64] {
        self
    }
    fn as_mut_slice(&mut self) -> &mut [f64] {
        self
    }
}

/// Why an integration stopped early.
#[derive(Debug, Clone, PartialEq)]
pub enum IntegratorError {
    /// The step size fell below the floating-point resolution of `t`.
    StepSizeUnderflow { t: f64, h: f64 },
    /// More than the configured number of steps were attempted.
    MaxSteps { t: f64 },
    /// The right-hand side produced NaN or infinity and no smaller step helped.
    NonFinite { t: f64 },
}

impl core::fmt::Display for IntegratorError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::StepSizeUnderflow { t, h } => {
                write!(f, "step size underflow (h = {h:e}) at t = {t}")
            }
            Self::MaxSteps { t } => write!(f, "maximum number of steps exceeded at t = {t}"),
            Self::NonFinite { t } => write!(f, "non-finite derivative at t = {t}"),
        }
    }
}

/// Work counters for one stepper.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    pub accepted: usize,
    pub rejected: usize,
    pub rhs_evals: usize,
}

/// A one-step method with dense output over its last accepted step.
///
/// `f(t, y, dy)` writes the derivative of `y` at `t` into `dy`.
pub trait Stepper<S: OdeState> {
    /// Current time (end of the last accepted step, or the truncation point).
    fn t(&self) -> f64;
    /// Current state.
    fn y(&self) -> &S;
    /// Takes one accepted step forward, never past `t_limit` (it lands on
    /// `t_limit` exactly when it gets there).
    fn step<F: FnMut(f64, &S, &mut S)>(
        &mut self,
        f: &mut F,
        t_limit: f64,
    ) -> Result<(), IntegratorError>;
    /// The interval `[t0, t1]` the dense output covers (the last step).
    fn window(&self) -> (f64, f64);
    /// Dense output at `t` inside [`Stepper::window`].
    fn dense(&self, t: f64, out: &mut S);
    /// Moves the current point back to `t` inside the last step (state from
    /// the dense output). The dense output stays valid on `[t0, t]`.
    fn truncate(&mut self, t: f64);
    /// Restarts at `(t, y)`, e.g. after a state jump at an event. The next
    /// step re-evaluates the derivative there.
    fn reset(&mut self, t: f64, y: S);
    /// Work counters.
    fn stats(&self) -> Stats;
}

/// A boxed switching function `g(t, y)`.
pub type SwitchFn<'a, S> = Box<dyn FnMut(f64, &S) -> f64 + 'a>;

/// A switching function `g(t, y)` whose sign change is a flight event.
pub struct Event<'a, S> {
    pub g: SwitchFn<'a, S>,
    pub direction: Direction,
    /// Stop the integration at this event.
    pub terminal: bool,
}

impl<'a, S> Event<'a, S> {
    /// cite: n/a constructor, no physics
    pub fn new(direction: Direction, terminal: bool, g: impl FnMut(f64, &S) -> f64 + 'a) -> Self {
        Self {
            g: Box::new(g),
            direction,
            terminal,
        }
    }
}

/// One located event.
#[derive(Debug, Clone, PartialEq)]
pub struct EventHit<S> {
    /// Index into the `events` slice passed to [`solve`].
    pub index: usize,
    pub t: f64,
    pub y: S,
}

/// How [`solve`] ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// `t_end` reached.
    End,
    /// The terminal event with this index fired; the stepper sits at its time.
    Event(usize),
    /// `on_step` returned `false`.
    Cancelled,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Outcome<S> {
    pub stop: Stop,
    /// Every event located during this call, in time order (the terminal one last).
    pub hits: Vec<EventHit<S>>,
}

/// Absolute time tolerance of event location, seconds (well under the
/// 1e-4 s acceptance bound; the dense-output error dominates).
pub const EVENT_TIME_TOL: f64 = 1e-12;

/// Integrates from the stepper's current point to `t_end`, checking `events`
/// after each accepted step and locating sign changes on the dense output with
/// Brent's method. Non-terminal events are recorded; the first terminal event
/// truncates the step at its time and ends the call (the caller may continue
/// with another `solve`, or `reset` the stepper after changing the state).
/// `on_step` sees the stepper after every accepted (possibly truncated) step;
/// returning `false` cancels.
///
/// cite: hnw1993 sec II.6 p 188-196
pub fn solve<S, F, I>(
    stepper: &mut I,
    f: &mut F,
    t_end: f64,
    events: &mut [Event<'_, S>],
    on_step: &mut dyn FnMut(&I) -> bool,
) -> Result<Outcome<S>, IntegratorError>
where
    S: OdeState,
    F: FnMut(f64, &S, &mut S),
    I: Stepper<S>,
{
    let mut hits = Vec::new();
    let mut g_prev: Vec<f64> = events
        .iter_mut()
        .map(|e| (e.g)(stepper.t(), stepper.y()))
        .collect();
    let mut g_new = g_prev.clone();
    let mut scratch = stepper.y().clone();
    let mut found: Vec<(usize, f64)> = Vec::new();
    while stepper.t() < t_end {
        stepper.step(f, t_end)?;
        let (t0, t1) = stepper.window();
        found.clear();
        for (i, ev) in events.iter_mut().enumerate() {
            g_new[i] = (ev.g)(t1, stepper.y());
            if crosses(ev.direction, g_prev[i], g_new[i]) {
                let st = &*stepper;
                let g = &mut ev.g;
                let br = brent_root(
                    |t| {
                        st.dense(t, &mut scratch);
                        g(t, &scratch)
                    },
                    t0,
                    t1,
                    g_prev[i],
                    g_new[i],
                    EVENT_TIME_TOL,
                );
                found.push((i, br.after()));
            }
        }
        found.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
        let terminal = found.iter().position(|&(i, _)| events[i].terminal);
        let upto = terminal.map_or(found.len(), |p| p + 1);
        for &(index, t) in &found[..upto] {
            stepper.dense(t, &mut scratch);
            hits.push(EventHit {
                index,
                t,
                y: scratch.clone(),
            });
        }
        if let Some(p) = terminal {
            let (index, t) = found[p];
            stepper.truncate(t);
            if !on_step(stepper) {
                return Ok(Outcome {
                    stop: Stop::Cancelled,
                    hits,
                });
            }
            return Ok(Outcome {
                stop: Stop::Event(index),
                hits,
            });
        }
        core::mem::swap(&mut g_prev, &mut g_new);
        if !on_step(stepper) {
            return Ok(Outcome {
                stop: Stop::Cancelled,
                hits,
            });
        }
    }
    Ok(Outcome {
        stop: Stop::End,
        hits,
    })
}

/// Weighted RMS norm `sqrt(mean((v_i / sc_i)^2))` with
/// `sc_i = atol + rtol * max(|a_i|, |b_i|)`.
pub(crate) fn rms_norm(v: &[f64], a: &[f64], b: &[f64], rtol: f64, atol: f64) -> f64 {
    let n = v.len().max(1) as f64;
    let s: f64 = v
        .iter()
        .zip(a.iter().zip(b))
        .map(|(vi, (ai, bi))| {
            let sc = atol + rtol * ai.abs().max(bi.abs());
            (vi / sc).powi(2)
        })
        .sum();
    (s / n).sqrt()
}

#[cfg(test)]
mod tests;
