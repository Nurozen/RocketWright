//! Runs one flight phase on the configured integrator, restarting the stepper
//! at every break time (ignition, burnout) so no step straddles a thrust
//! discontinuity (explicit burnout break, F:144).

use crate::integrator::{
    Dp54, Dp54Options, Event, EventHit, IntegratorError, OdeState, Rk4, Stepper, Stop, solve,
};

/// Which integrator a flight uses (`Conditions.integrator`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IntegratorChoice {
    /// Adaptive Dormand-Prince 5(4).
    Dp54(Dp54Options),
    /// Classical RK4 with a fixed step `h` (s).
    Rk4 { h: f64 },
}

impl IntegratorChoice {
    /// The integrator a simulation definition asks for: `dp54` with the sim's
    /// `rtol`/`atol` and `time_step_s` as the largest step, or `rk4` with
    /// `time_step_s` as the fixed step.
    ///
    /// cite: n/a configuration mapping, no physics
    pub fn from_sim(sim: &rw_model::EvalSim) -> Self {
        let dt = sim.conditions.time_step_s;
        match sim.conditions.integrator {
            rw_model::IntegratorKind::Dp54 => Self::Dp54(Dp54Options {
                rtol: sim.rtol,
                atol: sim.atol,
                h_max: if dt > 0.0 { dt } else { f64::INFINITY },
                ..Dp54Options::default()
            }),
            rw_model::IntegratorKind::Rk4 => Self::Rk4 { h: dt },
        }
    }
}

/// Read access to the stepper's last step for output sampling.
pub trait DenseView<S> {
    /// The interval the dense output covers.
    fn window(&self) -> (f64, f64);
    /// Dense output at `t` inside [`DenseView::window`].
    fn dense(&self, t: f64, out: &mut S);
}

impl<S: OdeState, I: Stepper<S>> DenseView<S> for I {
    fn window(&self) -> (f64, f64) {
        Stepper::window(self)
    }
    fn dense(&self, t: f64, out: &mut S) {
        Stepper::dense(self, t, out)
    }
}

/// How a phase ended.
#[derive(Debug, Clone, PartialEq)]
pub struct PhaseEnd<S> {
    pub stop: Stop,
    pub t: f64,
    pub y: S,
    /// Every event located during the phase, in time order.
    pub hits: Vec<EventHit<S>>,
}

/// Callbacks a phase reports to.
pub struct PhaseHooks<'h, S> {
    /// After every accepted step; `false` cancels.
    pub on_step: &'h mut dyn FnMut(&dyn DenseView<S>) -> bool,
    /// At every break the phase restarts at, with the state there.
    pub on_break: &'h mut dyn FnMut(f64, &S),
}

/// Integrates `f` from `(t0, y0)` to `t_end`, restarting at each `breaks`
/// time inside `(t0, t_end)`, and stops at the first terminal event. `f`
/// receives the current segment `(t_a, t_b)` first, so it can evaluate
/// one-sided limits at the segment ends.
///
/// cite: hnw1993 sec II.6 p 188-196
#[allow(clippy::too_many_arguments)]
pub fn run_phase<S, F>(
    choice: IntegratorChoice,
    t0: f64,
    y0: S,
    t_end: f64,
    breaks: &[f64],
    f: &mut F,
    events: &mut [Event<'_, S>],
    hooks: PhaseHooks<'_, S>,
) -> Result<PhaseEnd<S>, IntegratorError>
where
    S: OdeState,
    F: FnMut((f64, f64), f64, &S, &mut S),
{
    match choice {
        IntegratorChoice::Dp54(o) => {
            run_segments(&mut Dp54::new(t0, y0, o), t_end, breaks, f, events, hooks)
        }
        IntegratorChoice::Rk4 { h } => {
            run_segments(&mut Rk4::new(t0, y0, h), t_end, breaks, f, events, hooks)
        }
    }
}

fn run_segments<S, F, I>(
    stepper: &mut I,
    t_end: f64,
    breaks: &[f64],
    f: &mut F,
    events: &mut [Event<'_, S>],
    hooks: PhaseHooks<'_, S>,
) -> Result<PhaseEnd<S>, IntegratorError>
where
    S: OdeState,
    F: FnMut((f64, f64), f64, &S, &mut S),
    I: Stepper<S>,
{
    let PhaseHooks { on_step, on_break } = hooks;
    let mut hits = Vec::new();
    loop {
        let t = stepper.t();
        let seg_end = breaks
            .iter()
            .copied()
            .find(|&b| b > t)
            .map_or(t_end, |b| b.min(t_end));
        let seg = (t, seg_end);
        let mut f_seg = |tt: f64, y: &S, dy: &mut S| f(seg, tt, y, dy);
        let out = solve(stepper, &mut f_seg, seg_end, events, &mut |st: &I| {
            on_step(st)
        })?;
        hits.extend(out.hits);
        let at_end = |stepper: &I, stop, hits| PhaseEnd {
            stop,
            t: stepper.t(),
            y: stepper.y().clone(),
            hits,
        };
        match out.stop {
            Stop::End if seg_end < t_end => {
                let (tb, yb) = (stepper.t(), stepper.y().clone());
                on_break(tb, &yb);
                stepper.reset(tb, yb);
            }
            stop => return Ok(at_end(stepper, stop, hits)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::Direction;

    #[test]
    fn breaks_restart_and_events_survive() {
        // y' = 1 on [0, 1), 0 after: the jump at t = 1 is a break.
        let mut f = |seg: (f64, f64), _t: f64, _y: &[f64; 1], dy: &mut [f64; 1]| {
            dy[0] = if seg.1 <= 1.0 { 1.0 } else { 0.0 }
        };
        let mut events = [Event::new(Direction::Rising, false, |_t, y: &[f64; 1]| {
            y[0] - 0.5
        })];
        let mut broke = Vec::new();
        let end = run_phase(
            IntegratorChoice::Rk4 { h: 0.3 },
            0.0,
            [0.0],
            2.0,
            &[0.0, 1.0],
            &mut f,
            &mut events,
            PhaseHooks {
                on_step: &mut |_| true,
                on_break: &mut |t, y| broke.push((t, y[0])),
            },
        )
        .unwrap();
        assert_eq!(end.stop, Stop::End);
        assert_eq!(end.t, 2.0);
        assert!((end.y[0] - 1.0).abs() < 1e-14, "{}", end.y[0]);
        assert_eq!(broke.len(), 1);
        assert_eq!(broke[0].0, 1.0);
        assert_eq!(end.hits.len(), 1);
        assert!((end.hits[0].t - 0.5).abs() < 1e-9);
    }
}
