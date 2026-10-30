//! Integrator acceptance (plan M1.39a, spec Acceptance 2): convergence on a
//! ballistic case with an analytic solution, exponential decay, dense output,
//! event location error < 1e-4 s, and a cross-check against `ode_solvers`.

use super::*;
use crate::events::Direction;

const G: f64 = 9.80665;
/// Launch speed and terminal speed of the vertical quadratic-drag case.
const V0: f64 = 150.0;
const VT: f64 = 80.0;

/// Vertical flight with quadratic drag: h' = v, v' = -g - (g / vt^2) v |v|.
fn ballistic(_t: f64, y: &[f64; 2], dy: &mut [f64; 2]) {
    let k = G / (VT * VT);
    dy[0] = y[1];
    dy[1] = -G - k * y[1] * y[1].abs();
}

fn phi0() -> f64 {
    (V0 / VT).atan()
}

/// Ascent: v = vt tan(phi0 - g t / vt), h = (vt^2 / g) ln(cos(phi0 - g t / vt) / cos phi0).
fn ascent(t: f64) -> [f64; 2] {
    let a = phi0() - G * t / VT;
    [VT * VT / G * (a.cos() / phi0().cos()).ln(), VT * a.tan()]
}

fn t_apogee() -> f64 {
    VT * phi0() / G
}

fn h_apogee() -> f64 {
    VT * VT / (2.0 * G) * (1.0 + (V0 / VT).powi(2)).ln()
}

/// Descent from rest at apogee, tau after apogee.
fn descent(tau: f64) -> [f64; 2] {
    let x = G * tau / VT;
    [h_apogee() - VT * VT / G * x.cosh().ln(), -VT * x.tanh()]
}

/// Landing time measured from apogee: cosh(g tau / vt) = exp(g h_a / vt^2).
fn tau_landing() -> f64 {
    VT / G * (G * h_apogee() / (VT * VT)).exp().acosh()
}

/// Time the ascent passes altitude `h`.
fn t_ascent_at(h: f64) -> f64 {
    let a = (phi0().cos() * (G * h / (VT * VT)).exp()).acos();
    (phi0() - a) * VT / G
}

fn run_to<I: Stepper<[f64; 2]>>(st: &mut I, t_end: f64) {
    let mut f = ballistic;
    let out = solve(st, &mut f, t_end, &mut [], &mut |_| true).unwrap();
    assert_eq!(out.stop, Stop::End);
    assert_eq!(st.t(), t_end, "lands exactly on t_end");
}

fn err2(a: &[f64; 2], b: &[f64; 2]) -> (f64, f64) {
    ((a[0] - b[0]).abs(), (a[1] - b[1]).abs())
}

#[test]
fn dp54_ballistic_matches_analytic_at_default_tolerance() {
    let opts = Dp54Options::default();
    assert_eq!(opts.rtol, 1e-6);
    let mut st = Dp54::new(0.0, [0.0, V0], opts);
    run_to(&mut st, 8.0);
    let exact = ascent(8.0);
    let (eh, ev) = err2(st.y(), &exact);
    assert!(eh / exact[0] < 1e-5, "altitude rel err {}", eh / exact[0]);
    assert!(ev / V0 < 1e-5, "velocity err {ev}");
    let s = st.stats();
    assert!(s.accepted > 5 && s.accepted < 200, "{s:?}");
}

#[test]
fn dp54_ballistic_converges_with_tolerance() {
    let exact = ascent(8.0);
    let mut prev = f64::INFINITY;
    let mut prev_steps = 0;
    for rtol in [1e-4, 1e-6, 1e-8, 1e-10] {
        let opts = Dp54Options {
            rtol,
            atol: rtol * 1e-2,
            ..Default::default()
        };
        let mut st = Dp54::new(0.0, [0.0, V0], opts);
        run_to(&mut st, 8.0);
        let (eh, ev) = err2(st.y(), &exact);
        let e = (eh / exact[0]).max(ev / V0);
        assert!(
            e < prev,
            "error must fall with rtol: {e} !< {prev} at {rtol}"
        );
        assert!(
            e < 50.0 * rtol,
            "global error {e} out of proportion to rtol {rtol}"
        );
        let steps = st.stats().accepted;
        assert!(steps > prev_steps, "steps grow as rtol tightens");
        prev = e;
        prev_steps = steps;
    }
}

#[test]
fn dp54_fixed_step_is_fifth_order() {
    // Disable control (huge tolerance) and pin the step: the observed order of
    // the propagated solution must be 5 (HNW Table 5.2 b weights).
    let pinned = |h: f64| Dp54Options {
        rtol: 1e9,
        atol: 1e9,
        h_init: Some(h),
        h_max: h,
        ..Default::default()
    };
    // y' = -y: the leading error term is generic, so the order shows cleanly.
    let mut errs = Vec::new();
    for h in [0.4, 0.2, 0.1] {
        let mut st = Dp54::new(0.0, [1.0], pinned(h));
        let mut f = |_t: f64, y: &[f64; 1], dy: &mut [f64; 1]| dy[0] = -y[0];
        solve(&mut st, &mut f, 8.0, &mut [], &mut |_| true).unwrap();
        assert_eq!(st.stats().accepted, (8.0 / h).round() as usize);
        errs.push((st.y()[0] - (-8f64).exp()).abs());
    }
    for w in errs.windows(2) {
        let p = (w[0] / w[1]).log2();
        assert!(
            (4.7..5.7).contains(&p),
            "decay: observed order {p} from {errs:?}"
        );
    }
    // Ballistic: converges at least at 5th order (its leading term nearly
    // cancels, so the pre-asymptotic rate is higher) until round-off.
    let mut errs = Vec::new();
    for h in [0.8, 0.4, 0.2] {
        let mut st = Dp54::new(0.0, [0.0, V0], pinned(h));
        run_to(&mut st, 8.0);
        assert_eq!(st.stats().accepted, (8.0 / h).round() as usize);
        errs.push(err2(st.y(), &ascent(8.0)).0);
    }
    for w in errs.windows(2) {
        let p = (w[0] / w[1]).log2();
        assert!(p > 4.7, "ballistic: observed order {p} from {errs:?}");
    }
}

#[test]
fn rk4_ballistic_is_fourth_order() {
    let exact = ascent(8.0);
    let mut errs = Vec::new();
    for h in [0.2, 0.1, 0.05, 0.025] {
        let mut st = Rk4::new(0.0, [0.0, V0], h);
        run_to(&mut st, 8.0);
        assert_eq!(st.stats().accepted, (8.0 / h).round() as usize);
        errs.push(err2(st.y(), &exact).0);
    }
    for w in errs.windows(2) {
        let p = (w[0] / w[1]).log2();
        assert!((3.7..4.3).contains(&p), "observed order {p} from {errs:?}");
    }
    // OpenRocket-style 0.05 s step is already accurate to ~1e-4 m here.
    assert!(errs[2] < 1e-3, "{errs:?}");
}

/// y_i' = -lambda_i y_i on a heap state (generic `Vec<f64>`).
#[allow(clippy::ptr_arg)] // the signature is fixed by the state type S = Vec<f64>
fn decay(_t: f64, y: &Vec<f64>, dy: &mut Vec<f64>) {
    for (i, (d, v)) in dy.iter_mut().zip(y).enumerate() {
        *d = -LAMBDA[i] * v;
    }
}
const LAMBDA: [f64; 3] = [0.5, 2.0, 10.0];

#[test]
fn dp54_exponential_decay_and_dense_output() {
    let mut st = Dp54::new(0.0, vec![1.0, 1.0, 1.0], Dp54Options::default());
    let mut f = decay;
    let mut max_dense_err: f64 = 0.0;
    let mut samples = 0;
    let mut buf = vec![0.0; 3];
    solve(&mut st, &mut f, 3.0, &mut [], &mut |s: &Dp54<Vec<f64>>| {
        let (t0, t1) = s.window();
        for j in 0..=8 {
            let t = t0 + (t1 - t0) * f64::from(j) / 8.0;
            s.dense(t, &mut buf);
            for (b, l) in buf.iter().zip(LAMBDA) {
                max_dense_err = max_dense_err.max((b - (-l * t).exp()).abs());
            }
            samples += 1;
        }
        true
    })
    .unwrap();
    for (i, (y, l)) in st.y().iter().zip(LAMBDA).enumerate() {
        let exact = (-l * 3.0).exp();
        let e = (y - exact).abs();
        assert!(e < 1e-6 * exact + 1e-8, "component {i}: err {e}");
    }
    assert!(samples > 50);
    assert!(max_dense_err < 1e-6, "dense output err {max_dense_err}");
}

#[test]
fn dense_output_is_continuous_and_interpolates_endpoints() {
    let mut st = Dp54::new(0.0, [0.0, V0], Dp54Options::default());
    let mut f = ballistic;
    let mut y0_prev = [0.0, V0];
    let mut t_prev = 0.0;
    let mut buf = [0.0; 2];
    solve(&mut st, &mut f, 8.0, &mut [], &mut |s: &Dp54<[f64; 2]>| {
        let (t0, t1) = s.window();
        assert_eq!(t0, t_prev);
        s.dense(t0, &mut buf);
        assert!(err2(&buf, &y0_prev).0 < 1e-12);
        s.dense(t1, &mut buf);
        assert!(err2(&buf, s.y()).0 < 1e-9 && err2(&buf, s.y()).1 < 1e-9);
        t_prev = t1;
        y0_prev = *s.y();
        true
    })
    .unwrap();
}

#[test]
fn rk4_exponential_decay_fourth_order_and_dense() {
    let f_exact = |t: f64| (-2.0 * t).exp();
    let mut errs = Vec::new();
    for h in [0.1, 0.05, 0.025] {
        let mut st = Rk4::new(0.0, [1.0], h);
        let mut f = |_t: f64, y: &[f64; 1], dy: &mut [f64; 1]| dy[0] = -2.0 * y[0];
        let mut dense_err: f64 = 0.0;
        let mut buf = [0.0];
        solve(&mut st, &mut f, 2.0, &mut [], &mut |s: &Rk4<[f64; 1]>| {
            let (t0, t1) = s.window();
            let tm = 0.5 * (t0 + t1);
            s.dense(tm, &mut buf);
            dense_err = dense_err.max((buf[0] - f_exact(tm)).abs());
            true
        })
        .unwrap();
        assert!(
            dense_err < 5.0 * h.powi(4),
            "Hermite dense err {dense_err} at h {h}"
        );
        errs.push((st.y()[0] - f_exact(2.0)).abs());
    }
    for w in errs.windows(2) {
        let p = (w[0] / w[1]).log2();
        assert!((3.8..4.2).contains(&p), "observed order {p}");
    }
}

/// Phase 1 to apogee (terminal) with a non-terminal 100 m crossing; phase 2
/// from apogee to landing (terminal). Returns (t_100, t_apogee, t_landing).
fn fly<I: Stepper<[f64; 2]>>(st: &mut I) -> (f64, f64, f64) {
    let mut f = ballistic;
    let mut events = [
        Event::new(Direction::Rising, false, |_t, y: &[f64; 2]| y[0] - 100.0),
        Event::new(Direction::Falling, true, |_t, y: &[f64; 2]| y[1]),
    ];
    let out = solve(st, &mut f, 100.0, &mut events, &mut |_| true).unwrap();
    assert_eq!(out.stop, Stop::Event(1));
    assert_eq!(out.hits.len(), 2, "{:?}", out.hits);
    assert_eq!(out.hits[0].index, 0);
    let apo = &out.hits[1];
    assert_eq!(st.t(), apo.t, "stepper truncated at the terminal event");
    assert_eq!(st.y(), &apo.y);
    assert!(apo.y[1].abs() < 1e-6, "v at apogee {}", apo.y[1]);
    assert!((apo.y[0] - h_apogee()).abs() < 1e-3, "apogee {}", apo.y[0]);
    let (t100, ta) = (out.hits[0].t, apo.t);

    // Restart (the burnout-break pattern): the apogee event must not refire.
    let mut events = [
        Event::new(Direction::Falling, false, |_t, y: &[f64; 2]| y[1]),
        Event::new(Direction::Falling, true, |_t, y: &[f64; 2]| y[0]),
    ];
    let out = solve(st, &mut f, 100.0, &mut events, &mut |_| true).unwrap();
    assert_eq!(out.stop, Stop::Event(1));
    assert_eq!(out.hits.len(), 1, "no spurious refire: {:?}", out.hits);
    let land = &out.hits[0];
    assert!(land.y[0] <= 0.0 && land.y[0] > -1e-6);
    let tl = land.t;
    let tau = tl - ta;
    let v_exact = descent(tau)[1];
    assert!(
        (land.y[1] - v_exact).abs() < 1e-3,
        "ground hit v {} vs {v_exact}",
        land.y[1]
    );
    (t100, ta, tl)
}

#[test]
fn dp54_event_times_within_1e4_s() {
    let mut st = Dp54::new(0.0, [0.0, V0], Dp54Options::default());
    let (t100, ta, tl) = fly(&mut st);
    let e100 = (t100 - t_ascent_at(100.0)).abs();
    let ea = (ta - t_apogee()).abs();
    let el = (tl - (t_apogee() + tau_landing())).abs();
    assert!(e100 < 1e-4 && ea < 1e-4 && el < 1e-4, "{e100} {ea} {el}");
    // At rtol 1e-6 the location error is far below the bound.
    assert!(e100.max(ea).max(el) < 1e-5, "{e100} {ea} {el}");
}

#[test]
fn rk4_event_times_within_1e4_s() {
    let mut st = Rk4::new(0.0, [0.0, V0], 0.05);
    let (t100, ta, tl) = fly(&mut st);
    let e100 = (t100 - t_ascent_at(100.0)).abs();
    let ea = (ta - t_apogee()).abs();
    let el = (tl - (t_apogee() + tau_landing())).abs();
    assert!(e100 < 1e-4 && ea < 1e-4 && el < 1e-4, "{e100} {ea} {el}");
}

#[test]
fn reset_restarts_from_a_new_state() {
    // State jump at an event (e.g. stage separation): restart with v halved.
    let mut st = Dp54::new(0.0, [0.0, V0], Dp54Options::default());
    let mut f = ballistic;
    let mut ev = [Event::new(Direction::Rising, true, |_t, y: &[f64; 2]| {
        y[0] - 100.0
    })];
    let out = solve(&mut st, &mut f, 100.0, &mut ev, &mut |_| true).unwrap();
    let hit = &out.hits[0];
    st.reset(hit.t, [hit.y[0], 0.0]);
    let mut ev = [Event::new(Direction::Falling, true, |_t, y: &[f64; 2]| {
        y[0]
    })];
    solve(&mut st, &mut f, 100.0, &mut ev, &mut |_| true).unwrap();
    // Dropped from rest at 100 m: tau with cosh(g tau / vt) = exp(g 100 / vt^2).
    let tau = VT / G * (G * 100.0 / (VT * VT)).exp().acosh();
    assert!(
        (st.t() - hit.t - tau).abs() < 1e-5,
        "{} vs {tau}",
        st.t() - hit.t
    );
}

#[test]
fn on_step_false_cancels() {
    let mut st = Rk4::new(0.0, [0.0, V0], 0.05);
    let mut f = ballistic;
    let mut n = 0;
    let out = solve(&mut st, &mut f, 8.0, &mut [], &mut |_| {
        n += 1;
        n < 3
    })
    .unwrap();
    assert_eq!(out.stop, Stop::Cancelled);
    assert!((st.t() - 0.15).abs() < 1e-12);
}

#[test]
fn non_finite_rhs_is_an_error() {
    let mut st = Dp54::new(0.0, [1.0], Dp54Options::default());
    let mut f = |t: f64, _y: &[f64; 1], dy: &mut [f64; 1]| {
        dy[0] = if t > 0.5 { f64::NAN } else { 1.0 };
    };
    let r = solve(&mut st, &mut f, 2.0, &mut [], &mut |_| true);
    assert!(r.is_err(), "{r:?}");
}

/// Cross-check against the independent `ode_solvers` DOPRI5 (dev-dependency).
#[test]
fn dp54_agrees_with_ode_solvers() {
    use ode_solvers::{Dopri5, OutputType, System, Vector2};
    struct Ball;
    impl System<f64, Vector2<f64>> for Ball {
        fn system(&self, t: f64, y: &Vector2<f64>, dy: &mut Vector2<f64>) {
            let mut d = [0.0; 2];
            ballistic(t, &[y[0], y[1]], &mut d);
            dy[0] = d[0];
            dy[1] = d[1];
        }
    }
    let (rtol, atol) = (1e-10, 1e-12);
    // Sparse output (step endpoints): the crate's Dense mode interpolates
    // with visibly larger error, and with dx = x_end returned garbage.
    let mut theirs = Dopri5::new(Ball, 0.0, 8.0, 1.0, Vector2::new(0.0, V0), rtol, atol);
    theirs.set_output(OutputType::Sparse);
    theirs.integrate().unwrap();
    let ty = theirs.y_out().last().unwrap();
    let opts = Dp54Options {
        rtol,
        atol,
        ..Default::default()
    };
    let mut st = Dp54::new(0.0, [0.0, V0], opts);
    run_to(&mut st, 8.0);
    let exact = ascent(8.0);
    let (eh, ev) = err2(st.y(), &[ty[0], ty[1]]);
    assert!(eh < 1e-7 && ev < 1e-7, "ours vs ode_solvers: {eh} {ev}");
    assert_eq!(theirs.x_out().last(), Some(&8.0));
    assert!((ty[0] - exact[0]).abs() < 1e-7);
}
