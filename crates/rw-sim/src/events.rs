//! Event location (R4.5): sign-change detection on accepted steps and
//! Brent's bracketing root finder run on the integrator's dense output.
//!
//! An event is a scalar switching function `g(t, y)`; it fires where `g`
//! changes sign in the configured [`Direction`]. Detection compares `g` at the
//! two ends of an accepted step, then [`brent_root`] refines the crossing
//! inside the step without further right-hand-side evaluations (the dense
//! output is the interpolant), following the procedure of Hairer, Norsett and
//! Wanner, *Solving ODEs I*, 2nd ed., sec. II.6 (continuous output used to
//! locate discontinuities). Two crossings inside one step cancel and are not
//! seen; steps are short compared with the flight events this targets.

/// Which sign changes of `g` fire the event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// `g` goes from negative to zero or positive.
    Rising,
    /// `g` goes from positive to zero or negative.
    Falling,
    /// Either of the above.
    Either,
}

/// True when `g` moving from `g0` (step start) to `g1` (step end) is a
/// crossing in `dir`. A start value of exactly zero is not a crossing: the
/// integration starts on the surface (for example right after a terminal
/// event restarts the flight there).
///
/// cite: n/a sign test on the switching function, no physics
pub fn crosses(dir: Direction, g0: f64, g1: f64) -> bool {
    let rising = g0 < 0.0 && g1 >= 0.0;
    let falling = g0 > 0.0 && g1 <= 0.0;
    match dir {
        Direction::Rising => rising,
        Direction::Falling => falling,
        Direction::Either => rising || falling,
    }
}

/// Result of [`brent_root`]: the best estimate and the final bracket.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bracket {
    /// The iterate with the smallest `|g|` (Brent's `b`).
    pub root: f64,
    /// Lower end of the final bracket (`g` has the sign of `g(a)` here, or is 0).
    pub lo: f64,
    /// Upper end of the final bracket (`g` has the sign of `g(b)` here, or is 0).
    pub hi: f64,
}

impl Bracket {
    /// The point just past the crossing when the function crossed while the
    /// argument increased from `lo` to `hi`: `g` there already has its
    /// post-crossing sign (or is exactly zero), so restarting an integration
    /// at it does not detect the same crossing again.
    ///
    /// cite: n/a bracket bookkeeping, no physics
    pub fn after(&self) -> f64 {
        self.hi
    }
}

/// Finds a zero of `g` in `[a, b]` with Brent's method (bisection safeguarding
/// secant and inverse quadratic interpolation). Needs `ga = g(a)` and
/// `gb = g(b)` with `ga * gb <= 0`, and `a < b`. Stops when the bracket is
/// narrower than `2 * (2 eps |b| + xtol / 2)` or `g` is exactly zero.
///
/// The returned bracket keeps the orientation of the input: `lo` lies on the
/// `a` side of the zero and `hi` on the `b` side.
///
/// cite: brent1973 sec 4 p 47-60
pub fn brent_root<G: FnMut(f64) -> f64>(
    mut g: G,
    a: f64,
    b: f64,
    ga: f64,
    gb: f64,
    xtol: f64,
) -> Bracket {
    debug_assert!(a <= b, "brent_root needs a <= b");
    debug_assert!(ga * gb <= 0.0, "brent_root needs a sign change");
    if ga == 0.0 {
        return Bracket {
            root: a,
            lo: a,
            hi: a,
        };
    }
    if gb == 0.0 {
        return Bracket {
            root: b,
            lo: b,
            hi: b,
        };
    }
    // Brent's state: b is the best iterate, c the contrapoint (g(b) g(c) < 0),
    // a the previous b.
    let (mut a, mut fa) = (a, ga);
    let (mut b, mut fb) = (b, gb);
    let (mut c, mut fc) = (a, fa);
    let mut d = b - a;
    let mut e = d;
    const MAX_ITER: usize = 200;
    for _ in 0..MAX_ITER {
        if (fb > 0.0) == (fc > 0.0) {
            c = a;
            fc = fa;
            d = b - a;
            e = d;
        }
        if fc.abs() < fb.abs() {
            a = b;
            b = c;
            c = a;
            fa = fb;
            fb = fc;
            fc = fa;
        }
        let tol1 = 2.0 * f64::EPSILON * b.abs() + 0.5 * xtol;
        let m = 0.5 * (c - b);
        if m.abs() <= tol1 || fb == 0.0 {
            break;
        }
        if e.abs() < tol1 || fa.abs() <= fb.abs() {
            d = m;
            e = m;
        } else {
            let s = fb / fa;
            let (mut p, mut q);
            if a == c {
                // secant
                p = 2.0 * m * s;
                q = 1.0 - s;
            } else {
                // inverse quadratic interpolation
                let qq = fa / fc;
                let r = fb / fc;
                p = s * (2.0 * m * qq * (qq - r) - (b - a) * (r - 1.0));
                q = (qq - 1.0) * (r - 1.0) * (s - 1.0);
            }
            if p > 0.0 {
                q = -q;
            } else {
                p = -p;
            }
            if 2.0 * p < 3.0 * m * q - (tol1 * q).abs() && p < (0.5 * e * q).abs() {
                e = d;
                d = p / q;
            } else {
                d = m;
                e = m;
            }
        }
        a = b;
        fa = fb;
        b += if d.abs() > tol1 { d } else { tol1.copysign(m) };
        fb = g(b);
    }
    if fb == 0.0 {
        return Bracket {
            root: b,
            lo: b,
            hi: b,
        };
    }
    if (fb > 0.0) == (fc > 0.0) {
        // Iteration cap hit right after an update: the previous iterate `a`
        // has the opposite sign and is the valid contrapoint.
        c = a;
    }
    // The zero lies between b and c. Orientation: the end whose g has the sign
    // of the original g(a) is `lo`.
    let (lo, hi) = if (fb > 0.0) == (ga > 0.0) {
        (b, c)
    } else {
        (c, b)
    };
    Bracket { root: b, lo, hi }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossing_directions() {
        assert!(crosses(Direction::Rising, -1.0, 1.0));
        assert!(crosses(Direction::Rising, -1.0, 0.0));
        assert!(!crosses(Direction::Rising, 1.0, -1.0));
        assert!(!crosses(Direction::Rising, 0.0, 1.0));
        assert!(crosses(Direction::Falling, 1.0, -1.0));
        assert!(!crosses(Direction::Falling, -1.0, 1.0));
        assert!(crosses(Direction::Either, 1.0, -1.0));
        assert!(crosses(Direction::Either, -1.0, 1.0));
        assert!(!crosses(Direction::Either, 1.0, 2.0));
    }

    #[test]
    fn brent_transcendental() {
        // cos x = x, root 0.739085133215160641655...
        let mut n = 0;
        let br = brent_root(
            |x| {
                n += 1;
                x.cos() - x
            },
            0.0,
            1.0,
            1.0,
            1f64.cos() - 1.0,
            1e-14,
        );
        assert!((br.root - 0.739_085_133_215_160_6).abs() < 1e-13);
        assert!(br.lo <= 0.739_085_133_215_160_6 + 1e-13);
        assert!(br.hi >= 0.739_085_133_215_160_6 - 1e-13);
        assert!(n < 15, "superlinear convergence expected, took {n}");
    }

    #[test]
    fn brent_orientation_and_endpoints() {
        // Falling function: g(lo) > 0, g(hi) < 0.
        let g = |x: f64| 2.0 - x * x;
        let br = brent_root(g, 0.0, 2.0, g(0.0), g(2.0), 1e-12);
        assert!((br.root - 2f64.sqrt()).abs() < 1e-11);
        assert!(g(br.lo) >= 0.0 && g(br.hi) <= 0.0);
        assert!(br.hi - br.lo <= 4e-12 + 1e-15);
        // Zero at an endpoint.
        let br = brent_root(|x| x - 1.0, 1.0, 3.0, 0.0, 2.0, 1e-12);
        assert_eq!(br.root, 1.0);
        let br = brent_root(|x| x - 3.0, 1.0, 3.0, -2.0, 0.0, 1e-12);
        assert_eq!(br.after(), 3.0);
    }

    #[test]
    fn brent_flat_and_steep() {
        // Multiple root (x-1)^3: slow for Newton/secant, Brent falls back to bisection.
        let g = |x: f64| (x - 1.0).powi(3);
        let br = brent_root(g, 0.0, 3.0, g(0.0), g(3.0), 1e-10);
        assert!((br.root - 1.0).abs() < 1e-5);
        assert!(g(br.lo) <= 0.0 && g(br.hi) >= 0.0);
        // Step function: bisection still terminates on the jump.
        let g = |x: f64| if x < 0.3 { -1.0 } else { 1.0 };
        let br = brent_root(g, 0.0, 1.0, -1.0, 1.0, 1e-12);
        assert!((br.after() - 0.3).abs() < 1e-11 && br.after() >= 0.3);
    }
}
