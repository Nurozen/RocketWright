//! `=` expressions (R2.3): dimension-typed arithmetic over unit literals,
//! `params.<name>`, and other components' *input* fields (`c.<id>.<field>`).
//!
//! Grammar (whitespace is free between tokens):
//!
//! ```text
//! expr    := term (('+' | '-') term)*
//! term    := unary (('*' | '/') unary)*
//! unary   := ('-' | '+') unary | power
//! power   := primary ('^' unary)?                      -- right-associative
//! primary := number unit? | ref | func '(' expr (',' expr)* ')' | 'pi' | '(' expr ')'
//! number  := digits ('.' digits?)? exp? ('/' digits)?  -- `1/4 in` is a fraction literal
//! ref     := ('params' | 'c') ('.' ident)+
//! func    := min | max | clamp | abs | sqrt
//! ```
//!
//! A unit follows its number (`54 mm`, `1200 kg/m^3`, `20 N*s`) and is parsed by
//! `rw-units`. A bare `0` adopts whatever dimension it meets (`max(x - 5 mm, 0)`);
//! every other bare number is dimensionless. Refs read source inputs only, never
//! evaluated outputs, so the reference graph is the source graph and a cycle is
//! an error (`RW-E042`). Shared vectors: `schema/testdata/exprs.json`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use rw_units::{DimKind, Dimension, UnitError, parse_quantity, parse_unit};

use crate::diag;

/// A value during evaluation: SI magnitude plus dimension.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Val {
    pub value: f64,
    pub dim: Dimension,
    /// A literal `0`: compatible with any dimension.
    pub any_dim: bool,
}

impl Val {
    pub fn new(value: f64, dim: Dimension) -> Self {
        Val {
            value,
            dim,
            any_dim: false,
        }
    }
    fn number(value: f64) -> Self {
        Val {
            value,
            dim: Dimension::NONE,
            any_dim: value == 0.0,
        }
    }
    /// The named dimension, if it has one.
    pub fn kind(&self) -> Option<DimKind> {
        DimKind::from_dimension(self.dim)
    }
}

/// What went wrong (the `err` slugs of `schema/testdata/exprs.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExprErrorKind {
    Syntax,
    UnknownRef,
    Cycle,
    DimensionMismatch,
    NotNumeric,
    Domain,
    UnknownUnit,
}

impl ExprErrorKind {
    /// The vector slug, e.g. `unknown_ref`.
    pub const fn slug(self) -> &'static str {
        match self {
            ExprErrorKind::Syntax => "syntax",
            ExprErrorKind::UnknownRef => "unknown_ref",
            ExprErrorKind::Cycle => "cycle",
            ExprErrorKind::DimensionMismatch => "dimension_mismatch",
            ExprErrorKind::NotNumeric => "not_numeric",
            ExprErrorKind::Domain => "domain",
            ExprErrorKind::UnknownUnit => "unknown_unit",
        }
    }
    /// The diagnostic code.
    pub const fn code(self) -> &'static str {
        match self {
            ExprErrorKind::Syntax => diag::E_EXPR_SYNTAX,
            ExprErrorKind::UnknownRef => diag::E_EXPR_UNKNOWN_REF,
            ExprErrorKind::Cycle => diag::E_EXPR_CYCLE,
            ExprErrorKind::DimensionMismatch => diag::E_EXPR_DIM,
            ExprErrorKind::NotNumeric => diag::E_EXPR_NOT_NUMERIC,
            ExprErrorKind::Domain => diag::E_EXPR_DOMAIN,
            ExprErrorKind::UnknownUnit => diag::E_UNIT_UNKNOWN,
        }
    }
}

/// An expression error with an agent-facing message.
#[derive(Debug, Clone, PartialEq)]
pub struct ExprError {
    pub kind: ExprErrorKind,
    pub message: String,
    pub hint: Option<String>,
}

impl ExprError {
    fn new(kind: ExprErrorKind, message: impl Into<String>) -> Self {
        ExprError {
            kind,
            message: message.into(),
            hint: None,
        }
    }
    fn hint(mut self, h: impl Into<String>) -> Self {
        self.hint = Some(h.into());
        self
    }
    fn syntax(message: impl Into<String>) -> Self {
        Self::new(ExprErrorKind::Syntax, message)
    }
    fn dim(message: impl Into<String>) -> Self {
        Self::new(ExprErrorKind::DimensionMismatch, message)
    }
}

impl std::fmt::Display for ExprError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

// ---- AST ---------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Func {
    Min,
    Max,
    Clamp,
    Abs,
    Sqrt,
}

impl Func {
    fn from_name(n: &str) -> Option<Func> {
        Some(match n {
            "min" => Func::Min,
            "max" => Func::Max,
            "clamp" => Func::Clamp,
            "abs" => Func::Abs,
            "sqrt" => Func::Sqrt,
            _ => return None,
        })
    }
    fn name(self) -> &'static str {
        match self {
            Func::Min => "min",
            Func::Max => "max",
            Func::Clamp => "clamp",
            Func::Abs => "abs",
            Func::Sqrt => "sqrt",
        }
    }
}

/// A parsed expression.
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    /// A literal in SI (a bare number is dimensionless; `0` is `any_dim`).
    Lit(Val),
    /// `params.d`, `c.body.od`.
    Ref(String),
    Neg(Box<Expr>),
    Bin(BinOp, Box<Expr>, Box<Expr>),
    Call(Func, Vec<Expr>),
}

impl Expr {
    /// The refs this expression reads, in order of first use, without duplicates.
    pub fn refs(&self) -> Vec<String> {
        let mut out = Vec::new();
        self.collect_refs(&mut out);
        out
    }
    fn collect_refs(&self, out: &mut Vec<String>) {
        match self {
            Expr::Lit(_) => {}
            Expr::Ref(r) => {
                if !out.contains(r) {
                    out.push(r.clone());
                }
            }
            Expr::Neg(e) => e.collect_refs(out),
            Expr::Bin(_, a, b) => {
                a.collect_refs(out);
                b.collect_refs(out);
            }
            Expr::Call(_, args) => args.iter().for_each(|a| a.collect_refs(out)),
        }
    }
}

/// True when a source string is an `=` expression.
pub fn is_expr(s: &str) -> bool {
    s.trim_start().starts_with('=')
}

// ---- parser ------------------------------------------------------------------

/// Parses an expression. The leading `=` is optional.
pub fn parse(src: &str) -> Result<Expr, ExprError> {
    let body = src.trim_start();
    let body = body.strip_prefix('=').unwrap_or(body);
    let mut p = P { s: body, i: 0 };
    p.ws();
    if p.at_end() {
        return Err(ExprError::syntax("empty expression after `=`")
            .hint("write a value after `=`, e.g. `= params.d * 2`"));
    }
    let e = p.expr()?;
    p.ws();
    if !p.at_end() {
        return Err(p.err(format!("unexpected `{}`", p.rest_snippet())));
    }
    Ok(e)
}

struct P<'a> {
    s: &'a str,
    i: usize,
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}
fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}
fn is_unit_start(c: char) -> bool {
    c.is_alphabetic() || matches!(c, '%' | '°' | 'µ' | 'μ' | '_')
}

impl<'a> P<'a> {
    fn rest(&self) -> &'a str {
        &self.s[self.i..]
    }
    fn peek(&self) -> Option<char> {
        self.rest().chars().next()
    }
    fn peek_at(&self, n: usize) -> Option<char> {
        self.rest().chars().nth(n)
    }
    fn at_end(&self) -> bool {
        self.i >= self.s.len()
    }
    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.i += c.len_utf8();
        Some(c)
    }
    fn ws(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.bump();
        }
    }
    fn eat(&mut self, c: char) -> bool {
        self.ws();
        if self.peek() == Some(c) {
            self.bump();
            true
        } else {
            false
        }
    }
    fn rest_snippet(&self) -> String {
        self.rest().chars().take(12).collect()
    }
    fn err(&self, msg: impl Into<String>) -> ExprError {
        ExprError::syntax(format!(
            "{} (at byte {} of the expression)",
            msg.into(),
            self.i
        ))
    }

    fn expr(&mut self) -> Result<Expr, ExprError> {
        let mut lhs = self.term()?;
        loop {
            self.ws();
            let op = match self.peek() {
                Some('+') => BinOp::Add,
                Some('-') => BinOp::Sub,
                _ => return Ok(lhs),
            };
            self.bump();
            let rhs = self.term()?;
            lhs = Expr::Bin(op, Box::new(lhs), Box::new(rhs));
        }
    }

    fn term(&mut self) -> Result<Expr, ExprError> {
        let mut lhs = self.unary()?;
        loop {
            self.ws();
            let op = match self.peek() {
                Some('*') | Some('·') => BinOp::Mul,
                Some('/') => BinOp::Div,
                _ => return Ok(lhs),
            };
            self.bump();
            let rhs = self.unary()?;
            lhs = Expr::Bin(op, Box::new(lhs), Box::new(rhs));
        }
    }

    fn unary(&mut self) -> Result<Expr, ExprError> {
        self.ws();
        match self.peek() {
            Some('-') => {
                self.bump();
                Ok(Expr::Neg(Box::new(self.unary()?)))
            }
            Some('+') => {
                self.bump();
                self.unary()
            }
            _ => self.power(),
        }
    }

    fn power(&mut self) -> Result<Expr, ExprError> {
        let base = self.primary()?;
        if self.eat('^') {
            let exp = self.unary()?;
            return Ok(Expr::Bin(BinOp::Pow, Box::new(base), Box::new(exp)));
        }
        Ok(base)
    }

    fn primary(&mut self) -> Result<Expr, ExprError> {
        self.ws();
        match self.peek() {
            None => Err(self.err("expression ends early")),
            Some('(') => {
                self.bump();
                let e = self.expr()?;
                if !self.eat(')') {
                    return Err(self.err("missing `)`"));
                }
                Ok(e)
            }
            Some(c) if c.is_ascii_digit() || c == '.' => self.number(),
            Some(c) if is_ident_start(c) => self.ident_expr(),
            Some(_) => Err(self.err(format!("unexpected `{}`", self.rest_snippet()))),
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.i;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.bump();
        }
        self.i - start
    }

    fn number(&mut self) -> Result<Expr, ExprError> {
        let start = self.i;
        let int = self.digits();
        let mut frac = 0;
        if self.peek() == Some('.') {
            self.bump();
            frac = self.digits();
        }
        if int + frac == 0 {
            return Err(self.err("malformed number"));
        }
        if matches!(self.peek(), Some('e') | Some('E')) {
            let save = self.i;
            self.bump();
            if matches!(self.peek(), Some('+') | Some('-')) {
                self.bump();
            }
            if self.digits() == 0 {
                self.i = save; // `2 eV`-style: not an exponent
            }
        }
        let mut value: f64 = self.s[start..self.i]
            .parse()
            .map_err(|_| self.err("malformed number"))?;
        // A fraction literal `1/4` (no spaces) reads like the unit parser's.
        if self.peek() == Some('/') && self.peek_at(1).is_some_and(|c| c.is_ascii_digit()) {
            self.bump();
            let ds = self.i;
            self.digits();
            let den: f64 = self.s[ds..self.i]
                .parse()
                .map_err(|_| self.err("malformed fraction"))?;
            if den == 0.0 {
                return Err(ExprError::new(
                    ExprErrorKind::Domain,
                    "fraction with zero denominator",
                ));
            }
            value /= den;
        }
        // Optional unit.
        let save = self.i;
        self.ws();
        if self.peek().is_some_and(is_unit_start)
            && let Some(unit_end) = self.unit_extent()?
        {
            let text = &self.s[self.i..unit_end];
            let unit = parse_unit(text).map_err(unit_err)?;
            self.i = unit_end;
            return Ok(Expr::Lit(Val::new(unit.to_si(value), unit.dim)));
        }
        self.i = save;
        Ok(Expr::Lit(Val::number(value)))
    }

    /// Finds the end of the unit that starts at `self.i`: the longest run of
    /// unit factors joined by `*`, `/`, `·` (no spaces) that `rw-units`
    /// accepts. `None` when the word is a ref or function, not a unit.
    fn unit_extent(&self) -> Result<Option<usize>, ExprError> {
        let s = self.s;
        let mut i = self.i;
        let mut ends = Vec::new();
        let mut first = true;
        loop {
            let fstart = i;
            if s[i..].starts_with('(') {
                let mut depth = 0;
                for (k, c) in s[i..].char_indices() {
                    match c {
                        '(' => depth += 1,
                        ')' => {
                            depth -= 1;
                            if depth == 0 {
                                i += k + 1;
                                break;
                            }
                        }
                        c if c.is_whitespace() => return Ok(ends.last().copied()),
                        _ => {}
                    }
                }
                if i == fstart {
                    break;
                }
            } else {
                while let Some(c) = s[i..].chars().next() {
                    if is_unit_start(c) || (i > fstart && c.is_ascii_digit()) {
                        i += c.len_utf8();
                    } else {
                        break;
                    }
                }
                if i == fstart {
                    break;
                }
                if first {
                    let word = &s[fstart..i];
                    let next = s[i..].chars().next();
                    if next == Some('.')
                        || next == Some('(')
                        || word == "params"
                        || word == "c"
                        || Func::from_name(word).is_some()
                        || word == "pi"
                    {
                        return Ok(None);
                    }
                }
            }
            first = false;
            // exponent: ^int, ^-int, ^(int), ², ³
            let rest = &s[i..];
            if let Some(r) = rest.strip_prefix('^') {
                let mut k = 1;
                let r2 = r.strip_prefix('(');
                if r2.is_some() {
                    k += 1;
                }
                let r = r2.unwrap_or(r);
                let neg = r.starts_with('-');
                let digits = r[usize::from(neg)..]
                    .bytes()
                    .take_while(u8::is_ascii_digit)
                    .count();
                if digits == 0 {
                    break;
                }
                k += usize::from(neg) + digits;
                if r2.is_some() {
                    if !s[i + k..].starts_with(')') {
                        break;
                    }
                    k += 1;
                }
                i += k;
            } else if rest.starts_with('²') || rest.starts_with('³') {
                i += 2;
            }
            ends.push(i);
            let rest = &s[i..];
            let mut it = rest.chars();
            match (it.next(), it.next()) {
                (Some('*' | '/' | '·'), Some(n)) if is_unit_start(n) || n == '(' => {
                    i += rest.chars().next().map_or(1, char::len_utf8);
                }
                _ => break,
            }
        }
        if ends.is_empty() {
            return Ok(None);
        }
        for &end in ends.iter().rev() {
            if parse_unit(&s[self.i..end]).is_ok() {
                return Ok(Some(end));
            }
        }
        // Nothing parses: report the first factor.
        let first_end = ends[0];
        Err(parse_unit(&s[self.i..first_end])
            .map(|_| ExprError::syntax("bad unit"))
            .unwrap_or_else(unit_err))
    }

    fn ident(&mut self) -> &'a str {
        let start = self.i;
        while self.peek().is_some_and(is_ident_char) {
            self.bump();
        }
        &self.s[start..self.i]
    }

    fn ident_expr(&mut self) -> Result<Expr, ExprError> {
        let start = self.i;
        let word = self.ident();
        if let Some(f) = Func::from_name(word)
            && self.eat('(')
        {
            let mut args = vec![self.expr()?];
            while self.eat(',') {
                args.push(self.expr()?);
            }
            if !self.eat(')') {
                return Err(self.err(format!("missing `)` after the arguments of `{word}`")));
            }
            let ok = match f {
                Func::Min | Func::Max => !args.is_empty(),
                Func::Clamp => args.len() == 3,
                Func::Abs | Func::Sqrt => args.len() == 1,
            };
            if !ok {
                return Err(ExprError::syntax(format!(
                    "`{}` takes {} argument(s), got {}",
                    f.name(),
                    if f == Func::Clamp {
                        "3"
                    } else if matches!(f, Func::Min | Func::Max) {
                        "1 or more"
                    } else {
                        "1"
                    },
                    args.len()
                )));
            }
            return Ok(Expr::Call(f, args));
        }
        if word == "pi" && self.peek() != Some('.') {
            return Ok(Expr::Lit(Val::new(std::f64::consts::PI, Dimension::NONE)));
        }
        while self.peek() == Some('.') && self.peek_at(1).is_some_and(is_ident_start) {
            self.bump();
            self.ident();
        }
        let path = &self.s[start..self.i];
        if self.peek() == Some('(') {
            return Err(ExprError::syntax(format!("unknown function `{path}`"))
                .hint("functions: min, max, clamp, abs, sqrt"));
        }
        let root = path.split('.').next().unwrap_or("");
        let parts = path.split('.').count();
        if !matches!((root, parts), ("params", 2) | ("c", 3..)) {
            return Err(ExprError::new(
                ExprErrorKind::UnknownRef,
                format!("`{path}` is not a ref"),
            )
            .hint("refer to `params.<name>` or `c.<id>.<field>`"));
        }
        Ok(Expr::Ref(path.to_string()))
    }
}

fn unit_err(e: UnitError) -> ExprError {
    match e {
        UnitError::UnknownUnit { unit } => {
            ExprError::new(ExprErrorKind::UnknownUnit, format!("unknown unit `{unit}`"))
                .hint("see `rw schema units` for unit symbols")
        }
        UnitError::DimensionMismatch { .. } | UnitError::UnitMissing { .. } => {
            ExprError::dim(e.to_string())
        }
        UnitError::Syntax { .. } => ExprError::syntax(e.to_string()),
    }
}

// ---- evaluation ----------------------------------------------------------------

/// Resolves a ref (`params.d`, `c.body.od`) to a value.
pub trait Resolve {
    fn resolve(&mut self, path: &str) -> Result<Val, ExprError>;
}

fn same_dim(a: Val, b: Val, what: &str) -> Result<Dimension, ExprError> {
    if a.any_dim {
        return Ok(b.dim);
    }
    if b.any_dim || a.dim == b.dim {
        return Ok(a.dim);
    }
    Err(ExprError::dim(format!(
        "cannot {what} {} and {}",
        dim_label(a.dim),
        dim_label(b.dim)
    ))
    .hint("give every term the same dimension, e.g. `params.d + 2 mm`"))
}

/// A readable dimension: its name if it has one, else its SI unit.
pub fn dim_label(d: Dimension) -> String {
    match DimKind::from_dimension(d) {
        Some(k) => format!("a {}", k.name().replace('_', " ")),
        None => format!("`{d}`"),
    }
}

fn finite(v: f64, what: &str) -> Result<f64, ExprError> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(ExprError::new(
            ExprErrorKind::Domain,
            format!("{what} is not finite"),
        ))
    }
}

/// Evaluates an expression.
pub fn evaluate(e: &Expr, r: &mut dyn Resolve) -> Result<Val, ExprError> {
    Ok(match e {
        Expr::Lit(v) => *v,
        Expr::Ref(p) => r.resolve(p)?,
        Expr::Neg(a) => {
            let v = evaluate(a, r)?;
            Val {
                value: -v.value,
                ..v
            }
        }
        Expr::Bin(op, a, b) => {
            let x = evaluate(a, r)?;
            let y = evaluate(b, r)?;
            match op {
                BinOp::Add => Val::new(x.value + y.value, same_dim(x, y, "add")?),
                BinOp::Sub => Val::new(x.value - y.value, same_dim(x, y, "subtract")?),
                BinOp::Mul => {
                    let d = x
                        .dim
                        .checked_mul(y.dim)
                        .ok_or_else(|| ExprError::dim("dimension overflow"))?;
                    Val::new(finite(x.value * y.value, "the product")?, d)
                }
                BinOp::Div => {
                    if y.value == 0.0 {
                        return Err(ExprError::new(ExprErrorKind::Domain, "division by zero"));
                    }
                    let d = x
                        .dim
                        .checked_div(y.dim)
                        .ok_or_else(|| ExprError::dim("dimension overflow"))?;
                    Val::new(finite(x.value / y.value, "the quotient")?, d)
                }
                BinOp::Pow => {
                    if !y.dim.is_none() && !y.any_dim {
                        return Err(ExprError::dim(format!(
                            "an exponent must be a pure number, not {}",
                            dim_label(y.dim)
                        )));
                    }
                    let dim = if x.dim.is_none() || x.any_dim {
                        Dimension::NONE
                    } else {
                        let n = y.value.round();
                        if (y.value - n).abs() > 1e-9 || n.abs() > 16.0 {
                            return Err(ExprError::dim(format!(
                                "{} can only be raised to a whole power",
                                dim_label(x.dim)
                            )));
                        }
                        x.dim
                            .checked_pow(n as i8)
                            .ok_or_else(|| ExprError::dim("dimension overflow"))?
                    };
                    Val::new(finite(x.value.powf(y.value), "the power")?, dim)
                }
            }
        }
        Expr::Call(f, args) => {
            let vals = args
                .iter()
                .map(|a| evaluate(a, r))
                .collect::<Result<Vec<_>, _>>()?;
            match f {
                Func::Min | Func::Max => {
                    let mut acc = vals[0];
                    for v in &vals[1..] {
                        let dim = same_dim(acc, *v, f.name())?;
                        let pick = if *f == Func::Min {
                            v.value < acc.value
                        } else {
                            v.value > acc.value
                        };
                        let any = acc.any_dim && v.any_dim;
                        acc = Val {
                            value: if pick { v.value } else { acc.value },
                            dim,
                            any_dim: any,
                        };
                    }
                    acc
                }
                Func::Clamp => {
                    let (x, lo, hi) = (vals[0], vals[1], vals[2]);
                    let d1 = same_dim(x, lo, "clamp")?;
                    let x1 = Val { dim: d1, ..x };
                    let dim = same_dim(x1, hi, "clamp")?;
                    if lo.value > hi.value {
                        return Err(ExprError::new(
                            ExprErrorKind::Domain,
                            "clamp: the lower bound is above the upper bound",
                        ));
                    }
                    Val::new(x.value.clamp(lo.value, hi.value), dim)
                }
                Func::Abs => Val {
                    value: vals[0].value.abs(),
                    ..vals[0]
                },
                Func::Sqrt => {
                    let x = vals[0];
                    if x.value < 0.0 {
                        return Err(ExprError::new(
                            ExprErrorKind::Domain,
                            "sqrt of a negative value",
                        ));
                    }
                    let e = x.dim.exponents();
                    if e.iter().any(|k| k % 2 != 0) && !x.any_dim {
                        return Err(ExprError::dim(format!(
                            "sqrt of {} has no dimension",
                            dim_label(x.dim)
                        )));
                    }
                    let half = Dimension::from_exponents(e.map(|k| k / 2));
                    Val {
                        value: x.value.sqrt(),
                        dim: half,
                        any_dim: x.any_dim,
                    }
                }
            }
        }
    })
}

/// Checks a result against a field's dimension and returns the SI value.
pub fn expect_dim(v: Val, expected: DimKind) -> Result<f64, ExprError> {
    if v.any_dim || v.dim == expected.dimension() {
        return Ok(v.value);
    }
    Err(ExprError::dim(format!(
        "the expression gives {} but the field needs {}",
        dim_label(v.dim),
        dim_label(expected.dimension())
    ))
    .hint(format!(
        "make the expression a {} (unit `{}`)",
        expected.name().replace('_', " "),
        expected.si_unit()
    )))
}

// ---- scope: refs over a model value --------------------------------------------

/// Resolves refs against a model value (the JSON form of the merged
/// `rocket.rw.toml`: `params.<name>.value`, `c.<id>.<field...>`), memoizing
/// results and detecting cycles.
pub struct Scope<'a> {
    root: &'a Value,
    memo: BTreeMap<String, Result<Val, ExprError>>,
    stack: Vec<String>,
}

impl<'a> Scope<'a> {
    pub fn new(root: &'a Value) -> Self {
        Scope {
            root,
            memo: BTreeMap::new(),
            stack: Vec::new(),
        }
    }

    /// The source value a ref points at.
    pub fn lookup(&self, path: &str) -> Result<&'a Value, ExprError> {
        let mut parts = path.split('.');
        let root = parts.next().unwrap_or("");
        let unknown = || {
            ExprError::new(
                ExprErrorKind::UnknownRef,
                format!("`{path}` does not exist"),
            )
        };
        let mut v = match root {
            "params" => {
                let name = parts.next().ok_or_else(unknown)?;
                if parts.next().is_some() {
                    return Err(unknown().hint("refer to a param as `params.<name>`"));
                }
                return self
                    .root
                    .get("params")
                    .and_then(|p| p.get(name))
                    .and_then(|p| p.get("value"))
                    .ok_or_else(|| {
                        unknown().hint(format!("define `[params.{name}]` with a `value`"))
                    });
            }
            "c" => {
                let id = parts.next().ok_or_else(unknown)?;
                self.root.get("c").and_then(|c| c.get(id)).ok_or_else(|| {
                    unknown().hint(format!("no component `{id}`; see `rw eval` for ids"))
                })?
            }
            _ => return Err(unknown()),
        };
        for p in parts {
            v = v.get(p).ok_or_else(|| {
                unknown().hint(
                    "refs read input fields written in the source (and present there), not evaluated values",
                )
            })?;
        }
        Ok(v)
    }

    /// Evaluates a ref, with memoization and cycle detection.
    pub fn value_of(&mut self, path: &str) -> Result<Val, ExprError> {
        if let Some(r) = self.memo.get(path) {
            return r.clone();
        }
        if let Some(pos) = self.stack.iter().position(|p| p == path) {
            let mut chain: Vec<&str> = self.stack[pos..].iter().map(String::as_str).collect();
            chain.push(path);
            return Err(ExprError::new(
                ExprErrorKind::Cycle,
                format!("expression cycle: {}", chain.join(" -> ")),
            )
            .hint("break the cycle by giving one of these a literal value"));
        }
        let v = self.lookup(path)?;
        self.stack.push(path.to_string());
        let r = self.eval_value(v, path);
        self.stack.pop();
        self.memo.insert(path.to_string(), r.clone());
        r
    }

    /// Evaluates a source value (number, quantity string, or expression)
    /// without a dimension check.
    pub fn eval_value(&mut self, v: &Value, at: &str) -> Result<Val, ExprError> {
        match v {
            Value::Number(n) => Ok(Val::number(n.as_f64().unwrap_or(f64::NAN))),
            Value::String(s) if is_expr(s) => {
                let e = parse(s).map_err(|e| nested(e, at))?;
                evaluate(&e, self)
            }
            Value::String(s) => match parse_quantity(s) {
                Ok(q) => Ok(Val {
                    value: q.value,
                    dim: q.dim,
                    any_dim: q.value == 0.0 && q.dim.is_none(),
                }),
                Err(UnitError::Syntax { .. }) => Err(ExprError::new(
                    ExprErrorKind::NotNumeric,
                    format!("`{at}` is `{s}`, not a number or quantity"),
                )),
                Err(e) => Err(nested(unit_err(e), at)),
            },
            _ => Err(ExprError::new(
                ExprErrorKind::NotNumeric,
                format!("`{at}` is not a number or quantity"),
            )),
        }
    }

    /// Evaluates a source expression string (with its leading `=`).
    pub fn eval_str(&mut self, src: &str) -> Result<Val, ExprError> {
        let e = parse(src)?;
        evaluate(&e, self)
    }
}

fn nested(mut e: ExprError, at: &str) -> ExprError {
    if !at.is_empty() {
        e.message = format!("in `{at}`: {}", e.message);
    }
    e
}

impl Resolve for Scope<'_> {
    fn resolve(&mut self, path: &str) -> Result<Val, ExprError> {
        self.value_of(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const VECTORS: &str = include_str!("../../../schema/testdata/exprs.json");

    #[test]
    fn shared_vectors() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        let tol = v["rel_tol"].as_f64().unwrap();
        let ctx = &v["context"];
        let rows = v["vectors"].as_array().unwrap();
        assert!(rows.len() >= 18);
        for row in rows {
            let input = row["input"].as_str().unwrap();
            let dim = DimKind::from_name(row["dim"].as_str().unwrap()).unwrap();
            let mut scope = Scope::new(ctx);
            let got = parse(input).and_then(|e| {
                let refs = e.refs();
                let val = evaluate(&e, &mut scope)?;
                Ok((expect_dim(val, dim)?, refs))
            });
            match (&row.get("ok"), got) {
                (Some(ok), Ok((si, refs))) => {
                    let want = ok["si"].as_f64().unwrap();
                    assert!(
                        (si - want).abs() <= tol * want.abs().max(1e-300),
                        "{input}: {si} != {want}"
                    );
                    let want_refs: Vec<String> =
                        serde_json::from_value(ok["refs"].clone()).unwrap();
                    assert_eq!(refs, want_refs, "{input}");
                }
                (Some(_), Err(e)) => panic!("{input}: {e:?}"),
                (None, Ok(r)) => panic!("{input}: expected {}, got {r:?}", row["err"]),
                (None, Err(e)) => assert_eq!(e.kind.slug(), row["err"], "{input}: {e:?}"),
            }
        }
    }

    fn eval_in(ctx: &Value, src: &str) -> Result<Val, ExprError> {
        Scope::new(ctx).eval_str(src)
    }

    #[test]
    fn precedence_and_units() {
        let ctx = json!({});
        let v = eval_in(&ctx, "= 2 + 3 * 4").unwrap();
        assert_eq!(v.value, 14.0);
        let v = eval_in(&ctx, "= -2^2").unwrap();
        assert_eq!(v.value, -4.0);
        let v = eval_in(&ctx, "= 2^3^2").unwrap();
        assert_eq!(v.value, 512.0);
        let v = eval_in(&ctx, "= 1200 kg/m^3 * 2 m^3").unwrap();
        assert_eq!(v.kind(), Some(DimKind::Mass));
        assert!((v.value - 2400.0).abs() < 1e-9);
        let v = eval_in(&ctx, "= (54 mm)^2").unwrap();
        assert_eq!(v.kind(), Some(DimKind::Area));
        let v = eval_in(&ctx, "= sqrt(4 m^2)").unwrap();
        assert_eq!((v.value, v.kind()), (2.0, Some(DimKind::Length)));
        let v = eval_in(&ctx, "= 1/4 in").unwrap();
        assert!((v.value - 0.00635).abs() < 1e-15);
        let v = eval_in(&ctx, "= 10 mm*2").unwrap();
        assert!((v.value - 0.02).abs() < 1e-15);
        let v = eval_in(&ctx, "= 20 N*s").unwrap();
        assert_eq!(v.kind(), Some(DimKind::Impulse));
        let v = eval_in(&ctx, "= 2 * pi").unwrap();
        assert!((v.value - std::f64::consts::TAU).abs() < 1e-15);
    }

    #[test]
    fn errors() {
        let ctx = json!({"params": {"t": {"value": true}}});
        let k = |s: &str| eval_in(&ctx, s).unwrap_err().kind;
        assert_eq!(k("= 1 +"), ExprErrorKind::Syntax);
        assert_eq!(k("= (1"), ExprErrorKind::Syntax);
        assert_eq!(k("= foo(1)"), ExprErrorKind::Syntax);
        assert_eq!(k("= clamp(1, 2)"), ExprErrorKind::Syntax);
        assert_eq!(k("= d"), ExprErrorKind::UnknownRef);
        assert_eq!(k("= params.t"), ExprErrorKind::NotNumeric);
        assert_eq!(k("= 1 / 0"), ExprErrorKind::Domain);
        assert_eq!(k("= sqrt(2 m)"), ExprErrorKind::DimensionMismatch);
        assert_eq!(k("= 2 m ^ 0.5"), ExprErrorKind::DimensionMismatch);
        assert_eq!(k("= 3 furlongs"), ExprErrorKind::UnknownUnit);
        assert_eq!(k("= 2 c.x.y"), ExprErrorKind::Syntax);
    }

    #[test]
    fn self_reference_is_a_cycle() {
        let ctx = json!({"c": {"a": {"length": "= c.a.length + 1 mm"}}});
        assert_eq!(
            eval_in(&ctx, "= c.a.length").unwrap_err().kind,
            ExprErrorKind::Cycle
        );
    }

    #[test]
    fn nested_refs_resolve() {
        let ctx = json!({"c": {"fins": {"tab": {"height": "5 mm"}}}});
        let v = eval_in(&ctx, "= c.fins.tab.height * 2").unwrap();
        assert!((v.value - 0.01).abs() < 1e-15);
    }
}
