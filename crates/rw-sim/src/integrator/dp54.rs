//! Dormand-Prince 5(4) ("DOPRI5"): 7-stage explicit Runge-Kutta pair, FSAL,
//! local extrapolation (the 5th-order solution is propagated), elementary
//! step-size control, and 4th-order continuous (dense) output.
//!
//! Coefficients: Hairer, Norsett, Wanner, *Solving Ordinary Differential
//! Equations I*, 2nd rev. ed. (Springer 1993), Table 5.2 (sec. II.5), from
//! Dormand and Prince (1980). Step-size control and starting step: sec. II.4.
//! Dense output: sec. II.6, the continuous extension of Shampine (1986) in the
//! Hermite-like form `y0 + th (r1 + th1 (r2 + th (r3 + th1 r4)))`.

use super::{IntegratorError, OdeState, Stats, Stepper, rms_norm};

// Nodes c_i.
const C2: f64 = 1.0 / 5.0;
const C3: f64 = 3.0 / 10.0;
const C4: f64 = 4.0 / 5.0;
const C5: f64 = 8.0 / 9.0;

// Coupling coefficients a_ij.
const A21: f64 = 1.0 / 5.0;
const A31: f64 = 3.0 / 40.0;
const A32: f64 = 9.0 / 40.0;
const A41: f64 = 44.0 / 45.0;
const A42: f64 = -56.0 / 15.0;
const A43: f64 = 32.0 / 9.0;
const A51: f64 = 19372.0 / 6561.0;
const A52: f64 = -25360.0 / 2187.0;
const A53: f64 = 64448.0 / 6561.0;
const A54: f64 = -212.0 / 729.0;
const A61: f64 = 9017.0 / 3168.0;
const A62: f64 = -355.0 / 33.0;
const A63: f64 = 46732.0 / 5247.0;
const A64: f64 = 49.0 / 176.0;
const A65: f64 = -5103.0 / 18656.0;
// 5th-order weights b_i (= a_7i, FSAL; b2 = 0, b7 = 0).
const B1: f64 = 35.0 / 384.0;
const B3: f64 = 500.0 / 1113.0;
const B4: f64 = 125.0 / 192.0;
const B5: f64 = -2187.0 / 6784.0;
const B6: f64 = 11.0 / 84.0;
// Error weights e_i = b_i - b*_i, with the 4th-order b* =
// (5179/57600, 0, 7571/16695, 393/640, -92097/339200, 187/2100, 1/40).
const E1: f64 = 71.0 / 57600.0;
const E3: f64 = -71.0 / 16695.0;
const E4: f64 = 71.0 / 1920.0;
const E5: f64 = -17253.0 / 339200.0;
const E6: f64 = 22.0 / 525.0;
const E7: f64 = -1.0 / 40.0;
// Dense-output weights (Shampine 1986, as tabulated for DOPRI5).
const D1: f64 = -12715105075.0 / 11282082432.0;
const D3: f64 = 87487479700.0 / 32700410799.0;
const D4: f64 = -10690763975.0 / 1880347072.0;
const D5: f64 = 701980252875.0 / 199316789632.0;
const D6: f64 = -1453857185.0 / 822651844.0;
const D7: f64 = 69997945.0 / 29380423.0;

/// Tolerances and step limits for [`Dp54`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Dp54Options {
    /// Relative tolerance (R4.5 default 1e-6).
    pub rtol: f64,
    /// Absolute tolerance, in state units.
    pub atol: f64,
    /// First step; `None` picks one with the HNW starting-step algorithm.
    pub h_init: Option<f64>,
    /// Largest allowed step.
    pub h_max: f64,
    /// Safety factor on the optimal step (HNW `fac`).
    pub safety: f64,
    /// Smallest and largest step growth per step (HNW `facmin`, `facmax`).
    pub fac_min: f64,
    pub fac_max: f64,
    /// Cap on attempted steps (accepted + rejected) over the stepper's life.
    pub max_steps: usize,
}

impl Default for Dp54Options {
    fn default() -> Self {
        Self {
            rtol: 1e-6,
            atol: 1e-8,
            h_init: None,
            h_max: f64::INFINITY,
            safety: 0.9,
            fac_min: 0.2,
            fac_max: 10.0,
            max_steps: 1_000_000,
        }
    }
}

/// Dormand-Prince 5(4) stepper. See the module docs.
#[derive(Debug, Clone)]
pub struct Dp54<S: OdeState> {
    opts: Dp54Options,
    t: f64,
    y: S,
    /// k[0] = f(t, y) when `fsal_ok`; k[1..7] stage derivatives.
    k: [S; 7],
    fsal_ok: bool,
    h_next: Option<f64>,
    ytmp: S,
    ynew: S,
    // Dense output on [t0, t0 + h]: y(t0 + th h) = r0 + th (r1 + th1 (r2 + th (r3 + th1 r4))).
    t0: f64,
    h: f64,
    r: [S; 5],
    stats: Stats,
}

impl<S: OdeState> Dp54<S> {
    /// A stepper at `(t0, y0)`.
    ///
    /// cite: hnw1993 tab 5.2 p 178
    pub fn new(t0: f64, y0: S, opts: Dp54Options) -> Self {
        let z = zeros_like(&y0);
        Self {
            opts,
            t: t0,
            k: core::array::from_fn(|_| z.clone()),
            fsal_ok: false,
            h_next: opts.h_init,
            ytmp: z.clone(),
            ynew: z.clone(),
            t0,
            h: 0.0,
            r: [y0.clone(), z.clone(), z.clone(), z.clone(), z],
            y: y0,
            stats: Stats::default(),
        }
    }

    /// The options in use.
    ///
    /// cite: n/a accessor, no physics
    pub fn options(&self) -> &Dp54Options {
        &self.opts
    }

    /// The step the controller proposes next (`None` before the first step
    /// when no `h_init` was given).
    ///
    /// cite: n/a accessor, no physics
    pub fn next_step(&self) -> Option<f64> {
        self.h_next
    }

    fn eval<F: FnMut(f64, &S, &mut S)>(&mut self, f: &mut F, t: f64, which: Which) {
        self.stats.rhs_evals += 1;
        match which {
            Which::K(i) => f(t, &self.ytmp, &mut self.k[i]),
            Which::K0 => f(t, &self.y, &mut self.k[0]),
            Which::New => f(t, &self.ynew, &mut self.k[6]),
        }
    }

    /// HNW starting step (sec. II.4): balance the first Euler step's local
    /// error against the tolerance, using one extra derivative evaluation.
    fn initial_step<F: FnMut(f64, &S, &mut S)>(&mut self, f: &mut F, span: f64) -> f64 {
        let (rtol, atol) = (self.opts.rtol, self.opts.atol);
        let y = self.y.as_slice();
        let f0 = self.k[0].as_slice();
        let d0 = rms_norm(y, y, y, rtol, atol);
        let d1 = rms_norm(f0, y, y, rtol, atol);
        let mut h0 = if d0 < 1e-5 || d1 < 1e-5 {
            1e-6
        } else {
            0.01 * d0 / d1
        };
        h0 = h0.min(self.opts.h_max).min(span);
        for ((yt, yi), fi) in self.ytmp.as_mut_slice().iter_mut().zip(y).zip(f0) {
            *yt = yi + h0 * fi;
        }
        let t1 = self.t + h0;
        self.eval(f, t1, Which::K(1));
        let y = self.y.as_slice();
        let diff: Vec<f64> = self.k[1]
            .as_slice()
            .iter()
            .zip(self.k[0].as_slice())
            .map(|(a, b)| a - b)
            .collect();
        let d2 = rms_norm(&diff, y, y, rtol, atol) / h0;
        let dm = d1.max(d2);
        let h1 = if dm <= 1e-15 {
            (h0 * 1e-3).max(1e-6)
        } else {
            (0.01 / dm).powf(1.0 / 5.0)
        };
        (100.0 * h0).min(h1).min(self.opts.h_max)
    }
}

#[derive(Clone, Copy)]
enum Which {
    K0,
    K(usize),
    New,
}

fn zeros_like<S: OdeState>(y: &S) -> S {
    let mut z = y.clone();
    z.as_mut_slice().fill(0.0);
    z
}

/// `out = y + h * sum_j w_j k_j` over the listed stages.
fn combine<S: OdeState>(out: &mut S, y: &S, h: f64, k: &[S; 7], w: &[(usize, f64)]) {
    let o = out.as_mut_slice();
    o.copy_from_slice(y.as_slice());
    for &(j, wj) in w {
        let hw = h * wj;
        for (oi, ki) in o.iter_mut().zip(k[j].as_slice()) {
            *oi += hw * ki;
        }
    }
}

impl<S: OdeState> Stepper<S> for Dp54<S> {
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
        if !self.fsal_ok {
            self.eval(f, self.t, Which::K0);
            self.fsal_ok = true;
        }
        let mut h = match self.h_next {
            Some(h) => h,
            None => self.initial_step(f, span),
        };
        let mut rejected = false;
        loop {
            if self.stats.accepted + self.stats.rejected >= self.opts.max_steps {
                return Err(IntegratorError::MaxSteps { t: self.t });
            }
            h = h.min(self.opts.h_max);
            // Land on t_limit exactly; avoid leaving a sliver (HNW dopri5 rule).
            let mut last = false;
            let h_free = h;
            if self.t + 1.01 * h >= t_limit {
                h = t_limit - self.t;
                last = true;
            }
            if h <= 16.0 * f64::EPSILON * self.t.abs().max(1.0) {
                return Err(IntegratorError::StepSizeUnderflow { t: self.t, h });
            }
            let t = self.t;
            let y = &self.y;
            combine(&mut self.ytmp, y, h, &self.k, &[(0, A21)]);
            self.eval(f, t + C2 * h, Which::K(1));
            combine(&mut self.ytmp, &self.y, h, &self.k, &[(0, A31), (1, A32)]);
            self.eval(f, t + C3 * h, Which::K(2));
            combine(
                &mut self.ytmp,
                &self.y,
                h,
                &self.k,
                &[(0, A41), (1, A42), (2, A43)],
            );
            self.eval(f, t + C4 * h, Which::K(3));
            combine(
                &mut self.ytmp,
                &self.y,
                h,
                &self.k,
                &[(0, A51), (1, A52), (2, A53), (3, A54)],
            );
            self.eval(f, t + C5 * h, Which::K(4));
            combine(
                &mut self.ytmp,
                &self.y,
                h,
                &self.k,
                &[(0, A61), (1, A62), (2, A63), (3, A64), (4, A65)],
            );
            self.eval(f, t + h, Which::K(5));
            combine(
                &mut self.ynew,
                &self.y,
                h,
                &self.k,
                &[(0, B1), (2, B3), (3, B4), (4, B5), (5, B6)],
            );
            self.eval(f, t + h, Which::New);
            // Local error estimate h * sum e_i k_i into ytmp (as a difference).
            {
                let zero = zeros_like(&self.y);
                combine(
                    &mut self.ytmp,
                    &zero,
                    h,
                    &self.k,
                    &[(0, E1), (2, E3), (3, E4), (4, E5), (5, E6), (6, E7)],
                );
            }
            let err = rms_norm(
                self.ytmp.as_slice(),
                self.y.as_slice(),
                self.ynew.as_slice(),
                self.opts.rtol,
                self.opts.atol,
            );
            let finite = err.is_finite() && self.ynew.as_slice().iter().all(|v| v.is_finite());
            if !finite {
                self.stats.rejected += 1;
                rejected = true;
                h *= self.opts.fac_min;
                if h <= 16.0 * f64::EPSILON * self.t.abs().max(1.0) {
                    return Err(IntegratorError::NonFinite { t: self.t });
                }
                continue;
            }
            // Optimal step from the 5th-order error model (HNW eq. 4.13, q = 4).
            let fac_max = if rejected { 1.0 } else { self.opts.fac_max };
            let fac = if err == 0.0 {
                fac_max
            } else {
                (self.opts.safety * err.powf(-1.0 / 5.0)).clamp(self.opts.fac_min, fac_max)
            };
            if err <= 1.0 {
                self.stats.accepted += 1;
                // Dense coefficients on [t, t + h].
                let (y0, y1, k1, k7) = (
                    self.y.as_slice(),
                    self.ynew.as_slice(),
                    self.k[0].as_slice(),
                    self.k[6].as_slice(),
                );
                let n = y0.len();
                let mut r1 = vec![0.0; n];
                let mut r2 = vec![0.0; n];
                let mut r3 = vec![0.0; n];
                for i in 0..n {
                    let ydiff = y1[i] - y0[i];
                    let bspl = h * k1[i] - ydiff;
                    r1[i] = ydiff;
                    r2[i] = bspl;
                    r3[i] = ydiff - h * k7[i] - bspl;
                }
                self.r[0].as_mut_slice().copy_from_slice(y0);
                self.r[1].as_mut_slice().copy_from_slice(&r1);
                self.r[2].as_mut_slice().copy_from_slice(&r2);
                self.r[3].as_mut_slice().copy_from_slice(&r3);
                {
                    let zero = zeros_like(&self.y);
                    let mut r4 = zero.clone();
                    combine(
                        &mut r4,
                        &zero,
                        h,
                        &self.k,
                        &[(0, D1), (2, D3), (3, D4), (4, D5), (5, D6), (6, D7)],
                    );
                    self.r[4] = r4;
                }
                self.t0 = t;
                self.h = h;
                self.t = if last { t_limit } else { t + h };
                core::mem::swap(&mut self.y, &mut self.ynew);
                self.k.swap(0, 6);
                self.h_next = Some(if last && !rejected {
                    // A step shortened to land on t_limit says nothing against
                    // the free step; keep the larger proposal.
                    (h * fac).max(h_free)
                } else {
                    h * fac
                });
                return Ok(());
            }
            self.stats.rejected += 1;
            rejected = true;
            h *= fac;
        }
    }

    fn window(&self) -> (f64, f64) {
        (self.t0, self.t)
    }

    fn dense(&self, t: f64, out: &mut S) {
        let th = if self.h > 0.0 {
            (t - self.t0) / self.h
        } else {
            0.0
        };
        let th1 = 1.0 - th;
        let o = out.as_mut_slice();
        let r: [&[f64]; 5] = core::array::from_fn(|i| self.r[i].as_slice());
        for (i, oi) in o.iter_mut().enumerate() {
            *oi = r[0][i] + th * (r[1][i] + th1 * (r[2][i] + th * (r[3][i] + th1 * r[4][i])));
        }
    }

    fn truncate(&mut self, t: f64) {
        let mut y = self.y.clone();
        self.dense(t, &mut y);
        self.y = y;
        self.t = t;
        self.fsal_ok = false;
    }

    fn reset(&mut self, t: f64, y: S) {
        self.r[0] = y.clone();
        for r in &mut self.r[1..] {
            r.as_mut_slice().fill(0.0);
        }
        self.t0 = t;
        self.h = 0.0;
        self.t = t;
        self.y = y;
        self.fsal_ok = false;
    }

    fn stats(&self) -> Stats {
        self.stats
    }
}
