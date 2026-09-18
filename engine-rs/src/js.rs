//! JavaScript number semantics the engine reproduces bit for bit.
//!
//! The JS engine this crate replaces mixes `null`, `undefined` and numbers
//! freely: `null` is 0 in arithmetic and comparisons, `undefined` is NaN,
//! `x || d` replaces 0 and NaN too, `Math.max` propagates NaN (f64::max does
//! not), `Math.round` rounds halves up (f64::round rounds away from zero) and
//! `toFixed` rounds ties up (Rust's formatter rounds them to even). Every one
//! of those differences would silently change a score, so they live here.

/// Bit pattern marking a JS `null` inside an exported f64 series.
/// Genuine NaNs are canonical quiet NaNs and never carry this payload.
pub const NULL_BITS: u64 = 0x7FF4_DEAD_BEEF_0001;

/// A JS value that is `undefined`, `null` or a number.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum V {
    U,
    N,
    F(f64),
}

impl V {
    #[inline]
    pub fn from_opt(o: Option<f64>) -> V {
        match o {
            Some(x) => V::F(x),
            None => V::N,
        }
    }
    /// ToNumber: null -> 0, undefined -> NaN.
    #[inline]
    pub fn num(self) -> f64 {
        match self {
            V::U => f64::NAN,
            V::N => 0.0,
            V::F(x) => x,
        }
    }
    #[inline]
    pub fn truthy(self) -> bool {
        match self {
            V::F(x) => truthy(x),
            _ => false,
        }
    }
    /// `x == null`
    #[inline]
    pub fn nullish(self) -> bool {
        !matches!(self, V::F(_))
    }
    /// `x || d` with a numeric default.
    #[inline]
    pub fn or(self, d: f64) -> f64 {
        if self.truthy() {
            self.num()
        } else {
            d
        }
    }
}

/// `arr[i]` on a null-filled JS array (out of range -> undefined).
#[inline]
pub fn at(s: &[Option<f64>], i: isize) -> V {
    if i < 0 || i as usize >= s.len() {
        V::U
    } else {
        V::from_opt(s[i as usize])
    }
}

/// `arr[i]` on a JS array of numbers.
#[inline]
pub fn atf(s: &[f64], i: isize) -> V {
    if i < 0 || i as usize >= s.len() {
        V::U
    } else {
        V::F(s[i as usize])
    }
}

#[inline]
pub fn truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

/// `a || b` for numbers.
#[inline]
pub fn or(a: f64, b: f64) -> f64 {
    if truthy(a) {
        a
    } else {
        b
    }
}

/// Math.max(a, b)
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a > b {
        a
    } else if b > a {
        b
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() && b.is_sign_negative() {
            -0.0
        } else {
            0.0
        }
    } else {
        a
    }
}

/// Math.min(a, b)
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a < b {
        a
    } else if b < a {
        b
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() || b.is_sign_negative() {
            -0.0
        } else {
            0.0
        }
    } else {
        a
    }
}

/// Math.max(...xs)
pub fn max_all<I: IntoIterator<Item = f64>>(xs: I) -> f64 {
    xs.into_iter().fold(f64::NEG_INFINITY, max)
}

/// Math.min(...xs)
pub fn min_all<I: IntoIterator<Item = f64>>(xs: I) -> f64 {
    xs.into_iter().fold(f64::INFINITY, min)
}

/// Math.round: the closest integer, halves toward +Infinity.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    let r = if x - f >= 0.5 { f + 1.0 } else { f };
    if r == 0.0 && (x < 0.0 || (x == 0.0 && x.is_sign_negative())) {
        -0.0
    } else {
        r
    }
}

/// Number.prototype.toFixed(d): nearest, ties rounded up on the exact value.
pub fn to_fixed(x: f64, d: usize) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x.abs() >= 1e21 {
        return num_str(x);
    }
    let neg = x < 0.0;
    let a = x.abs();
    // Rust's `{:.d}` is correctly rounded too, ties to even. The two only differ
    // on an exact tie, i.e. |x|·10^d = N + ½ exactly, which for a binary double
    // holds iff |x|·2^(d+1) is an odd integer (scaling by 2^k is exact).
    let t = a * 2f64.powi(d as i32 + 1);
    let body = if t.fract() == 0.0 && t % 2.0 == 1.0 { fixed_half_up(a, d) } else { format!("{:.*}", d, a) };
    if neg {
        format!("-{}", body)
    } else {
        body
    }
}

/// Exact-digit round-half-up (tie path of to_fixed; `a` is non-negative).
fn fixed_half_up(a: f64, d: usize) -> String {
    // Rust prints the exact binary value, correctly rounded at d + 40 digits;
    // the digit after position d is therefore exact for every f64 we meet.
    let s = format!("{:.*}", d + 40, a);
    let b = s.as_bytes();
    let dot = s.find('.').expect("fixed format has a point");
    let mut digits: Vec<u8> = Vec::with_capacity(dot + d + 1);
    digits.extend_from_slice(&b[..dot]);
    digits.extend_from_slice(&b[dot + 1..dot + 1 + d]);
    if b[dot + 1 + d] >= b'5' {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits[i] == b'9' {
                digits[i] = b'0';
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let int_len = digits.len() - d;
    let mut out = String::with_capacity(digits.len() + 2);
    out.push_str(core::str::from_utf8(&digits[..int_len]).unwrap());
    if d > 0 {
        out.push('.');
        out.push_str(core::str::from_utf8(&digits[int_len..]).unwrap());
    }
    out
}

/// Number.prototype.toString() / String(x) / `'' + x`.
pub fn num_str(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    let a = x.abs();
    let body = if a >= 1e21 || a < 1e-6 {
        let e = format!("{:e}", a);
        let (m, ex) = e.split_once('e').expect("exponent form");
        let exi: i32 = ex.parse().expect("exponent digits");
        format!("{}e{}{}", m, if exi < 0 { '-' } else { '+' }, exi.abs())
    } else {
        format!("{}", a)
    };
    if x < 0.0 {
        format!("-{}", body)
    } else {
        body
    }
}

/// String(v) for undefined / null / number.
pub fn v_str(v: V) -> String {
    match v {
        V::U => "undefined".to_string(),
        V::N => "null".to_string(),
        V::F(x) => num_str(x),
    }
}

/// `v.toFixed(d)` where v is known to be a number in the JS code path.
pub fn v_fixed(v: V, d: usize) -> String {
    to_fixed(v.num(), d)
}

/// Array.prototype.sort with a numeric comparator (stable, NaN -> equal).
pub fn cmp_num(d: f64) -> core::cmp::Ordering {
    if d < 0.0 {
        core::cmp::Ordering::Less
    } else if d > 0.0 {
        core::cmp::Ordering::Greater
    } else {
        core::cmp::Ordering::Equal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_matches_js() {
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(0.5, 0), "1");
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(to_fixed(-1.5, 0), "-2");
        assert_eq!(to_fixed(-0.0001, 2), "-0.00");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
        assert_eq!(to_fixed(9.995, 2), "9.99");
        assert_eq!(to_fixed(99.96, 1), "100.0");
        assert_eq!(to_fixed(f64::NAN, 1), "NaN");
        assert_eq!(to_fixed(f64::INFINITY, 1), "Infinity");
        assert_eq!(to_fixed(12.3456, 0), "12");
        // exact ties go up (JS), not to even (Rust's default)
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(0.375, 2), "0.38");
        assert_eq!(to_fixed(-2.5, 0), "-3");
        assert_eq!(to_fixed(1.45, 1), "1.4"); // 1.45 is really 1.4499999…
        assert_eq!(to_fixed(0.0, 1), "0.0");
    }

    #[test]
    fn num_str_matches_js() {
        assert_eq!(num_str(85.0), "85");
        assert_eq!(num_str(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(num_str(-0.0), "0");
        assert_eq!(num_str(1e21), "1e+21");
        assert_eq!(num_str(1.5e-7), "1.5e-7");
        assert_eq!(num_str(0.000001), "0.000001");
        assert_eq!(num_str(123456789012345680000.0), "123456789012345680000");
        assert_eq!(num_str(0.5), "0.5");
    }

    #[test]
    fn math_semantics() {
        assert!(max(f64::NAN, 1.0).is_nan());
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(2.5), 3.0);
        assert!(round(-0.4).is_sign_negative());
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(max_all(Vec::<f64>::new()), f64::NEG_INFINITY);
    }
}
