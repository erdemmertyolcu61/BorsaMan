//! Minimal JSON writer + reader (no serde: keeps the wasm build dependency-free).

use crate::js::V;
use core::fmt::Write;

/// JSON builder. Non-finite numbers are written as tagged strings and flagged,
/// the JS side revives them (JSON itself cannot carry NaN / Infinity).
pub struct J {
    pub s: String,
    stack: Vec<bool>,
    pub special: bool,
}

impl J {
    pub fn new() -> J {
        J { s: String::with_capacity(4096), stack: vec![true], special: false }
    }

    fn sep(&mut self) {
        if let Some(first) = self.stack.last_mut() {
            if *first {
                *first = false;
            } else {
                self.s.push(',');
            }
        }
    }

    fn raw_str(&mut self, v: &str) {
        self.s.push('"');
        for ch in v.chars() {
            match ch {
                '"' => self.s.push_str("\\\""),
                '\\' => self.s.push_str("\\\\"),
                '\n' => self.s.push_str("\\n"),
                '\r' => self.s.push_str("\\r"),
                '\t' => self.s.push_str("\\t"),
                c if (c as u32) < 0x20 => {
                    let _ = write!(self.s, "\\u{:04x}", c as u32);
                }
                c => self.s.push(c),
            }
        }
        self.s.push('"');
    }

    fn raw_num(&mut self, x: f64) {
        if x.is_finite() {
            let _ = write!(self.s, "{}", x);
        } else {
            self.special = true;
            self.s.push_str(if x.is_nan() {
                "\"__NaN__\""
            } else if x > 0.0 {
                "\"__Inf__\""
            } else {
                "\"__-Inf__\""
            });
        }
    }

    fn key(&mut self, k: &str) {
        self.sep();
        self.raw_str(k);
        self.s.push(':');
    }

    // ── values inside arrays ──
    pub fn n(&mut self, x: f64) {
        self.sep();
        self.raw_num(x);
    }
    pub fn st(&mut self, v: &str) {
        self.sep();
        self.raw_str(v);
    }
    pub fn obj(&mut self) {
        self.sep();
        self.s.push('{');
        self.stack.push(true);
    }
    pub fn end_obj(&mut self) {
        self.s.push('}');
        self.stack.pop();
    }
    pub fn end_arr(&mut self) {
        self.s.push(']');
        self.stack.pop();
    }

    // ── key/value pairs inside objects ──
    pub fn kn(&mut self, k: &str, x: f64) {
        self.key(k);
        self.raw_num(x);
    }
    /// undefined keys are omitted (JSON.stringify semantics), null written as null.
    pub fn kv(&mut self, k: &str, v: V) {
        match v {
            V::U => {}
            V::N => {
                self.key(k);
                self.s.push_str("null");
            }
            V::F(x) => self.kn(k, x),
        }
    }
    pub fn ks(&mut self, k: &str, v: &str) {
        self.key(k);
        self.raw_str(v);
    }
    pub fn kso(&mut self, k: &str, v: Option<&str>) {
        match v {
            Some(s) => self.ks(k, s),
            None => self.knull(k),
        }
    }
    pub fn kb(&mut self, k: &str, b: bool) {
        self.key(k);
        self.s.push_str(if b { "true" } else { "false" });
    }
    pub fn knull(&mut self, k: &str) {
        self.key(k);
        self.s.push_str("null");
    }
    pub fn kobj(&mut self, k: &str) {
        self.key(k);
        self.s.push('{');
        self.stack.push(true);
    }
    pub fn karr(&mut self, k: &str) {
        self.key(k);
        self.s.push('[');
        self.stack.push(true);
    }

    /// Finished text; a `__special` marker leads when revival is needed.
    pub fn finish(self) -> String {
        if self.special {
            // `{` + `"__special":1,` + rest (the root is always an object)
            let mut out = String::with_capacity(self.s.len() + 16);
            out.push_str("{\"__special\":1");
            if self.s.len() > 2 {
                out.push(',');
            }
            out.push_str(&self.s[1..]);
            out
        } else {
            self.s
        }
    }
}

/// Parsed JSON value.
#[derive(Debug, Clone)]
pub enum Jv {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Jv>),
    Obj(Vec<(String, Jv)>),
}

impl Jv {
    pub fn get(&self, k: &str) -> Option<&Jv> {
        match self {
            Jv::Obj(kv) => kv.iter().find(|(key, _)| key == k).map(|(_, v)| v),
            _ => None,
        }
    }
    /// JS view of a numeric field: absent -> undefined, null -> null.
    pub fn v(&self, k: &str) -> V {
        match self.get(k) {
            None => V::U,
            Some(Jv::Null) => V::N,
            Some(Jv::Num(x)) => V::F(*x),
            // Callers validate types in JS before sending; anything else is
            // treated like undefined (never reached in practice).
            Some(_) => V::U,
        }
    }
    pub fn s(&self, k: &str) -> Option<&str> {
        match self.get(k) {
            Some(Jv::Str(s)) => Some(s.as_str()),
            _ => None,
        }
    }
    pub fn is_true(&self, k: &str) -> bool {
        matches!(self.get(k), Some(Jv::Bool(true)))
    }
    pub fn is_false(&self, k: &str) -> bool {
        matches!(self.get(k), Some(Jv::Bool(false)))
    }
}

pub fn parse(text: &str) -> Option<Jv> {
    let mut p = P { b: text.as_bytes(), i: 0 };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i == p.b.len() {
        Some(v)
    } else {
        None
    }
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> P<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\n' | b'\r' | b'\t') {
            self.i += 1;
        }
    }
    fn lit(&mut self, s: &[u8]) -> bool {
        if self.b.len() >= self.i + s.len() && &self.b[self.i..self.i + s.len()] == s {
            self.i += s.len();
            true
        } else {
            false
        }
    }
    fn value(&mut self) -> Option<Jv> {
        self.ws();
        match *self.b.get(self.i)? {
            b'{' => self.object(),
            b'[' => self.array(),
            b'"' => self.string().map(Jv::Str),
            b't' => self.lit(b"true").then_some(Jv::Bool(true)),
            b'f' => self.lit(b"false").then_some(Jv::Bool(false)),
            b'n' => self.lit(b"null").then_some(Jv::Null),
            _ => self.number(),
        }
    }
    fn object(&mut self) -> Option<Jv> {
        self.i += 1;
        let mut kv = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Some(Jv::Obj(kv));
        }
        loop {
            self.ws();
            let k = self.string()?;
            self.ws();
            if self.b.get(self.i) != Some(&b':') {
                return None;
            }
            self.i += 1;
            let v = self.value()?;
            kv.push((k, v));
            self.ws();
            match self.b.get(self.i)? {
                b',' => self.i += 1,
                b'}' => {
                    self.i += 1;
                    return Some(Jv::Obj(kv));
                }
                _ => return None,
            }
        }
    }
    fn array(&mut self) -> Option<Jv> {
        self.i += 1;
        let mut out = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            return Some(Jv::Arr(out));
        }
        loop {
            out.push(self.value()?);
            self.ws();
            match self.b.get(self.i)? {
                b',' => self.i += 1,
                b']' => {
                    self.i += 1;
                    return Some(Jv::Arr(out));
                }
                _ => return None,
            }
        }
    }
    fn hex4(&mut self) -> Option<u32> {
        let s = core::str::from_utf8(self.b.get(self.i..self.i + 4)?).ok()?;
        self.i += 4;
        u32::from_str_radix(s, 16).ok()
    }
    fn string(&mut self) -> Option<String> {
        if self.b.get(self.i) != Some(&b'"') {
            return None;
        }
        self.i += 1;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = *self.b.get(self.i)?;
            self.i += 1;
            match c {
                b'"' => return String::from_utf8(out).ok(),
                b'\\' => {
                    let e = *self.b.get(self.i)?;
                    self.i += 1;
                    match e {
                        b'"' => out.push(b'"'),
                        b'\\' => out.push(b'\\'),
                        b'/' => out.push(b'/'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'u' => {
                            let mut cp = self.hex4()?;
                            if (0xD800..0xDC00).contains(&cp) && self.lit(b"\\u") {
                                let lo = self.hex4()?;
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo.wrapping_sub(0xDC00) & 0x3FF);
                            }
                            let ch = char::from_u32(cp).unwrap_or('\u{FFFD}');
                            let mut buf = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                        }
                        _ => return None,
                    }
                }
                _ => out.push(c),
            }
        }
    }
    fn number(&mut self) -> Option<Jv> {
        let start = self.i;
        while self.i < self.b.len() && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
            self.i += 1;
        }
        let s = core::str::from_utf8(&self.b[start..self.i]).ok()?;
        s.parse::<f64>().ok().map(Jv::Num)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let v = parse(r#"{"a":1.5,"b":null,"c":"Türk \"x\"","d":[true,false],"e":{}}"#).unwrap();
        assert_eq!(v.v("a"), V::F(1.5));
        assert_eq!(v.v("b"), V::N);
        assert_eq!(v.v("zz"), V::U);
        assert_eq!(v.s("c"), Some("Türk \"x\""));
        let mut j = J::new();
        j.obj();
        j.kn("x", f64::NAN);
        j.ks("t", "a\"b");
        j.end_obj();
        let out = j.finish();
        assert_eq!(out, r#"{"__special":1,"x":"__NaN__","t":"a\"b"}"#);
    }
}
