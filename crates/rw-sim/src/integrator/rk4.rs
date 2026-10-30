//! Classical 4th-order Runge-Kutta ("the" Runge-Kutta method, Kutta 1901),
//! fixed step (D13: lets parity triage separate integrator error from model
//! error against fixed-step references). Tableau: Hairer, Norsett, Wanner,
//! *Solving ODEs I*, 2nd ed., Table 1.2 (sec. II.1).
//!
//! Dense output is the cubic Hermite interpolant through `(t0, y0, f0)` and
//! `(t1, y1, f1)` (HNW sec. II.6), accurate to O(h^4). `f1` is the next step's
//! first stage, so it costs one evaluation per step only after a truncation.

use super::{IntegratorError, OdeState, Stats, Stepper};

/// Fixed-step classical RK4 stepper.
#[derive(Debug, Clone)]
pub struct Rk4<S: OdeState> {
    h: f64,
    t: f64,
    y: S,
    /// f(t, y) when `f_ok`.
    f_now: S,
    f_ok: bool,
    k2: S,
    k3: S,
    k4: S,
    ytmp: S,
    // Hermite data for the last step [t0, t0 + hd].
    t0: f64,
    hd: f64,
    y0: S,
    f0: S,
    y1: S,
    f1: S,
    stats: Stats,
}

impl<S: OdeState> Rk4<S> {
    /// A stepper at `(t0, y0)` with fixed step `h > 0`.
    ///
    /// cite: hnw1993 tab 1.2 p 138
    pub fn new(t0: f64, y0: S, h: f64) -> Self {
        assert!(h > 0.0 && h.is_finite(), "Rk4 step must be positive");
        let mut z = y0.clone();
        z.as_mut_slice().fill(0.0);
        Self {
            h,
            t: t0,
            f_now: z.clone(),
            f_ok: false,
            k2: z.clone(),
            k3: z.clone(),
            k4: z.clone(),
            ytmp: z.clone(),
            t0,
            hd: 0.0,
            y0: y0.clone(),
            f0: z.clone(),
            y1: y0.clone(),
            f1: z,
            y: y0,
            stats: Stats::default(),
        }
    }

    /// The fixed step.
    ///
    /// cite: n/a accessor, no physics
    pub fn step_size(&self) -> f64 {
        self.h
    }
}

fn axpy_into<S: OdeState>(out: &mut S, y: &S, a: f64, k: &S) {
    for ((o, yi), ki) in out
        .as_mut_slice()
        .iter_mut()
        .zip(y.as_slice())
        .zip(k.as_slice())
    {
        *o = yi + a * ki;
    }
}

impl<S: OdeState> Stepper<S> for Rk4<S> {
    fn t(&self) -> f64 {
        self.t
    }

    fn y(&self) -> &S {
        &self.y
    }

    fn step<F: FnMut(f64, &S, &mut S)>(
        &mut self,
        f: &mut F,
        t_limit: f64,
    ) -> Result<(), IntegratorError> {
        let span = t_limit - self.t;
        if span <= 0.0 {
            return Ok(());
        }
        let t = self.t;
        // Land on t_limit exactly; absorb round-off slivers into this step.
        let last = span <= self.h * (1.0 + 1e-9);
        let h = if last { span } else { self.h };
        if h <= 16.0 * f64::EPSILON * t.abs().max(1.0) {
            return Err(IntegratorError::StepSizeUnderflow { t, h });
        }
        if !self.f_ok {
            f(t, &self.y, &mut self.f_now);
            self.stats.rhs_evals += 1;
            self.f_ok = true;
        }
        let k1 = &self.f_now;
        axpy_into(&mut self.ytmp, &self.y, 0.5 * h, k1);
        f(t + 0.5 * h, &self.ytmp, &mut self.k2);
        axpy_into(&mut self.ytmp, &self.y, 0.5 * h, &self.k2);
        f(t + 0.5 * h, &self.ytmp, &mut self.k3);
        axpy_into(&mut self.ytmp, &self.y, h, &self.k3);
        f(t + h, &self.ytmp, &mut self.k4);
        let t1 = if last { t_limit } else { t + h };
        // y1 = y + h/6 (k1 + 2 k2 + 2 k3 + k4)
        for (i, o) in self.y1.as_mut_slice().iter_mut().enumerate() {
            *o = self.y.as_slice()[i]
                + h / 6.0
                    * (self.f_now.as_slice()[i]
                        + 2.0 * self.k2.as_slice()[i]
                        + 2.0 * self.k3.as_slice()[i]
                        + self.k4.as_slice()[i]);
        }
        if !self.y1.as_slice().iter().all(|v| v.is_finite()) {
            return Err(IntegratorError::NonFinite { t });
        }
        f(t1, &self.y1, &mut self.f1);
        self.stats.rhs_evals += 4;
        self.stats.accepted += 1;
        self.y0.clone_from(&self.y);
        self.f0.clone_from(&self.f_now);
        self.t0 = t;
        self.hd = h;
        self.y.clone_from(&self.y1);
        self.f_now.clone_from(&self.f1);
        self.t = t1;
        Ok(())
    }

    fn window(&self) -> (f64, f64) {
        (self.t0, self.t)
    }

    fn dense(&self, t: f64, out: &mut S) {
        if self.hd <= 0.0 {
            out.clone_from(&self.y);
            return;
        }
        let h = self.hd;
        let s = (t - self.t0) / h;
        // Cubic Hermite basis on [0, 1].
        let h00 = (1.0 + 2.0 * s) * (1.0 - s) * (1.0 - s);
        let h10 = s * (1.0 - s) * (1.0 - s);
        let h01 = s * s * (3.0 - 2.0 * s);
        let h11 = s * s * (s - 1.0);
        let (y0, f0, y1, f1) = (
            self.y0.as_slice(),
            self.f0.as_slice(),
            self.y1.as_slice(),
            self.f1.as_slice(),
        );
        for (i, o) in out.as_mut_slice().iter_mut().enumerate() {
            *o = h00 * y0[i] + h10 * h * f0[i] + h01 * y1[i] + h11 * h * f1[i];
        }
    }

    fn truncate(&mut self, t: f64) {
        let mut y = self.y.clone();
        self.dense(t, &mut y);
        self.y = y;
        self.t = t;
        self.f_ok = false;
    }

    fn reset(&mut self, t: f64, y: S) {
        self.t0 = t;
        self.hd = 0.0;
        self.t = t;
        self.y0.clone_from(&y);
        self.y1.clone_from(&y);
        self.y = y;
        self.f_ok = false;
    }

    fn stats(&self) -> Stats {
        self.stats
    }
}
