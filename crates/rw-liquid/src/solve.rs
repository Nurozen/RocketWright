//! Brent's zero finder (bisection safeguarding secant and inverse quadratic
//! interpolation), used for the chamber-pressure solve of the blowdown, the
//! area ratio for a given exit pressure, and the liquid level of a tank.

/// Why a root solve failed.
#[derive(Debug, Clone, PartialEq)]
pub enum SolveError {
    /// `f(a)` and `f(b)` have the same sign.
    NoBracket { fa: f64, fb: f64 },
    /// A function value was not finite.
    NotFinite,
}

impl std::fmt::Display for SolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SolveError::NoBracket { fa, fb } => {
                write!(
                    f,
                    "no sign change in the bracket (f(a) = {fa}, f(b) = {fb})"
                )
            }
            SolveError::NotFinite => write!(f, "a function value was not finite"),
        }
    }
}

/// A zero of `f` in `[a, b]` to absolute tolerance `xtol`. Needs a sign
/// change; an exact zero at an end returns that end.
///
/// cite: brent1973 sec 4 p 47-60
pub fn brent<F: FnMut(f64) -> f64>(mut f: F, a: f64, b: f64, xtol: f64) -> Result<f64, SolveError> {
    let (mut a, mut b) = (a, b);
    let (mut fa, mut fb) = (f(a), f(b));
    if !(fa.is_finite() && fb.is_finite()) {
        return Err(SolveError::NotFinite);
    }
    if fa == 0.0 {
        return Ok(a);
    }
    if fb == 0.0 {
        return Ok(b);
    }
    if (fa > 0.0) == (fb > 0.0) {
        return Err(SolveError::NoBracket { fa, fb });
    }
    let (mut c, mut fc) = (a, fa);
    let mut d = b - a;
    let mut e = d;
    for _ in 0..200 {
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
            return Ok(b);
        }
        if e.abs() >= tol1 && fa.abs() > fb.abs() {
            let s = fb / fa;
            let (mut p, mut q) = if a == c {
                (2.0 * m * s, 1.0 - s)
            } else {
                let qq = fa / fc;
                let r = fb / fc;
                (
                    s * (2.0 * m * qq * (qq - r) - (b - a) * (r - 1.0)),
                    (qq - 1.0) * (r - 1.0) * (s - 1.0),
                )
            };
            if p > 0.0 {
                q = -q;
            } else {
                p = -p;
            }
            if 2.0 * p < (3.0 * m * q - (tol1 * q).abs()).min((e * q).abs()) {
                e = d;
                d = p / q;
            } else {
                d = m;
                e = m;
            }
        } else {
            d = m;
            e = m;
        }
        a = b;
        fa = fb;
        b += if d.abs() > tol1 { d } else { tol1.copysign(m) };
        fb = f(b);
        if !fb.is_finite() {
            return Err(SolveError::NotFinite);
        }
    }
    Ok(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_roots_and_rejects_missing_brackets() {
        let r = brent(|x| x * x - 2.0, 0.0, 2.0, 1e-14).unwrap();
        assert!((r - 2f64.sqrt()).abs() < 1e-12);
        let r = brent(|x: f64| x.cos() - x, 0.0, 1.0, 1e-14).unwrap();
        assert!((r - 0.739_085_133_215_160_6).abs() < 1e-12);
        assert!(matches!(
            brent(|x| x * x + 1.0, -1.0, 1.0, 1e-9),
            Err(SolveError::NoBracket { .. })
        ));
        assert_eq!(brent(|x| x, 0.0, 1.0, 1e-9), Ok(0.0));
    }
}
