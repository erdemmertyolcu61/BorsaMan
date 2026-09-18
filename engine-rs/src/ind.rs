//! Port of src/utils/indicators.js — calcAll and everything it calls.
//!
//! Every function mirrors the JS operation order so results match bit for bit:
//! the same summation order, JS Math.max/min NaN rules, `x || d` truthiness,
//! and `null` (None) vs `undefined` distinctions. Latent JS quirks are kept on
//! purpose (e.g. TRIX NaN head, ATR carry bug) — parity first, fixes later.

use crate::js::{self, V};

#[derive(Clone, Copy, Debug)]
pub struct Bar {
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: f64,
}

#[derive(Clone, Debug)]
pub struct Sr {
    pub res: bool,
    pub price: f64,
    pub idx: usize,
    pub count: u32,
}

#[derive(Clone, Debug)]
pub struct Candle {
    pub name: &'static str,
    pub kind: &'static str,
    pub desc: &'static str,
}

#[derive(Clone, Debug)]
pub enum Chandelier {
    Short,
    Full { long_stop: f64, short_stop: f64, atr: f64 },
}

impl Chandelier {
    pub fn long_stop(&self) -> V {
        match self {
            Chandelier::Short => V::N,
            Chandelier::Full { long_stop, .. } => V::F(*long_stop),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Ttm {
    pub on: bool,
    pub count: u32,
    pub momentum: f64,
    pub firing: bool,
}

#[derive(Clone, Debug)]
pub struct Spring {
    pub kind: &'static str,
    pub level: f64,
    pub desc: String,
}

#[derive(Clone, Debug)]
pub struct Climax {
    pub kind: &'static str,
    pub vol_multiple: f64,
    pub price_change: f64,
    pub desc: String,
}

#[derive(Clone, Debug)]
pub struct Ichimoku {
    pub tenkan: Vec<Option<f64>>,
    pub kijun: Vec<Option<f64>>,
    pub senkou_a: Vec<Option<f64>>,
    pub senkou_b: Vec<Option<f64>>,
    pub chikou: Vec<Option<f64>>,
    pub last_tenkan: V,
    pub last_kijun: V,
    pub last_sa: V,
    pub last_sb: V,
    pub tk_cross: Option<&'static str>,
    pub kumo_breakout: Option<&'static str>,
    pub kumo_twist: Option<&'static str>,
    pub cloud: &'static str,
    pub kumo_top: V,
    pub kumo_bottom: V,
}

#[derive(Clone, Debug)]
pub enum Trix {
    Short,
    Full { trix: Vec<f64>, signal: Vec<Option<f64>>, last: V, last_signal: V, crossover: Option<&'static str> },
}

#[derive(Clone, Debug)]
pub enum Supertrend {
    Short,
    Full { st: Vec<Option<f64>>, dir: Vec<f64>, up: bool, value: V, flip: Option<&'static str> },
}

#[derive(Clone, Debug)]
pub enum VolProfile {
    Empty,
    Full { poc: f64, vah: f64, val: f64, bins: Vec<(f64, f64)> },
}

impl VolProfile {
    pub fn poc(&self) -> V {
        match self {
            VolProfile::Empty => V::N,
            VolProfile::Full { poc, .. } => V::F(*poc),
        }
    }
}

#[derive(Clone, Debug)]
pub struct MomSlope {
    pub value: f64,
    pub trend: &'static str,
    pub is_steep: bool,
    pub is_gradual: bool,
    pub has_momentum: bool,
}

#[derive(Clone, Debug)]
pub struct Indicators {
    pub closes: Vec<f64>,
    pub ma20: Vec<Option<f64>>,
    pub ma50: Vec<Option<f64>>,
    pub ma100: Vec<Option<f64>>,
    pub ma200: Vec<Option<f64>>,
    pub rsi: Vec<Option<f64>>,
    pub stoch_k: Vec<Option<f64>>,
    pub stoch_d: Vec<Option<f64>>,
    pub macd: Vec<Option<f64>>,
    pub macd_sig: Vec<Option<f64>>,
    pub macd_hist: Vec<Option<f64>>,
    pub bb_u: Vec<Option<f64>>,
    pub bb_m: Vec<Option<f64>>,
    pub bb_l: Vec<Option<f64>>,
    pub sr: Vec<Sr>,
    pub mfi: V,
    pub obv: Vec<f64>,
    pub obv_trend: &'static str,
    pub adl: Vec<f64>,
    pub adl_trend: &'static str,
    pub vwap: V,
    pub vol_ratio: f64,
    pub last_close: f64,
    pub change: f64,
    pub change_pct: f64,
    pub cmf: V,
    pub adx: V,
    pub plus_di: V,
    pub minus_di: V,
    pub ttm: Ttm,
    pub chandelier: Chandelier,
    pub candles: Vec<Candle>,
    pub atr: V,
    pub wyckoff_phase: &'static str,
    pub obv_div: Option<&'static str>,
    pub rsi_div: Option<&'static str>,
    pub spring: Option<Spring>,
    pub climax: Option<Climax>,
    pub di_conv: Option<f64>,
    pub ichimoku: Ichimoku,
    pub williams: Vec<Option<f64>>,
    pub trix: Trix,
    pub supertrend: Supertrend,
    pub vp: VolProfile,
    pub roc10: Vec<Option<f64>>,
    pub roc20: Vec<Option<f64>>,
    pub gap_pct: f64,
    pub gap_up: bool,
    pub gap_down: bool,
    pub mom1h: f64,
    pub mom4h: f64,
    pub mom_intraday: f64,
    pub vol_surge: &'static str,
    pub rel_strength: f64,
    pub or_breakout: bool,
    pub or_breakdown: bool,
    pub day_hl_range: f64,
    pub open_to_current_pct: f64,
    pub momentum_score: f64,
    pub mom_slope: Option<MomSlope>,
}

impl Indicators {
    #[inline]
    fn last_of(&self, s: &[Option<f64>]) -> V {
        js::at(s, self.closes.len() as isize - 1)
    }
    pub fn last_ma20(&self) -> V {
        self.last_of(&self.ma20)
    }
    pub fn last_ma50(&self) -> V {
        self.last_of(&self.ma50)
    }
    pub fn last_ma100(&self) -> V {
        self.last_of(&self.ma100)
    }
    pub fn last_ma200(&self) -> V {
        self.last_of(&self.ma200)
    }
    pub fn last_rsi(&self) -> V {
        self.last_of(&self.rsi)
    }
    pub fn last_stoch_k(&self) -> V {
        self.last_of(&self.stoch_k)
    }
    pub fn last_stoch_d(&self) -> V {
        self.last_of(&self.stoch_d)
    }
    pub fn last_macd(&self) -> V {
        self.last_of(&self.macd)
    }
    pub fn last_macd_sig(&self) -> V {
        self.last_of(&self.macd_sig)
    }
    pub fn last_macd_hist(&self) -> V {
        self.last_of(&self.macd_hist)
    }
    pub fn last_bu(&self) -> V {
        self.last_of(&self.bb_u)
    }
    pub fn last_bm(&self) -> V {
        self.last_of(&self.bb_m)
    }
    pub fn last_bl(&self) -> V {
        self.last_of(&self.bb_l)
    }
    pub fn last_williams(&self) -> V {
        self.last_of(&self.williams)
    }
    pub fn last_roc10(&self) -> V {
        self.last_of(&self.roc10)
    }
    pub fn last_roc20(&self) -> V {
        self.last_of(&self.roc20)
    }
}

pub fn calc_ma(c: &[f64], p: usize) -> Vec<Option<f64>> {
    let n = c.len();
    let mut ma = vec![None; n];
    if p == 0 {
        return ma;
    }
    let mut i = p - 1;
    while i < n {
        let mut sum = 0.0;
        for j in (i + 1 - p)..=i {
            sum += c[j];
        }
        ma[i] = Some(sum / p as f64);
        i += 1;
    }
    ma
}

/// calcEMA on an array of numbers (every JS caller passes numbers only).
pub fn calc_ema(d: &[f64], p: usize) -> Vec<Option<f64>> {
    let n = d.len();
    let mut ema = vec![None; n];
    if n == 0 || n < p || p == 0 {
        return ema;
    }
    let k = 2.0 / (p as f64 + 1.0);
    let mut sum = 0.0;
    for x in d.iter().take(p) {
        sum += *x;
    }
    ema[p - 1] = Some(sum / p as f64);
    for i in p..n {
        let prev = ema[i - 1].unwrap();
        ema[i] = Some(d[i] * k + prev * (1.0 - k));
    }
    ema
}

pub fn calc_rsi(c: &[f64], p: usize) -> Vec<Option<f64>> {
    let n = c.len();
    let mut rsi = vec![None; n];
    if n < p + 1 {
        return rsi;
    }
    let pf = p as f64;
    let mut ag = 0.0;
    let mut al = 0.0;
    for i in 1..=p {
        let diff = c[i] - c[i - 1];
        if diff > 0.0 {
            ag += diff;
        } else {
            al += diff.abs();
        }
    }
    ag /= pf;
    al /= pf;
    rsi[p] = Some(if al == 0.0 { 100.0 } else { 100.0 - 100.0 / (1.0 + ag / al) });
    for i in (p + 1)..n {
        let diff = c[i] - c[i - 1];
        ag = (ag * (pf - 1.0) + (if diff > 0.0 { diff } else { 0.0 })) / pf;
        al = (al * (pf - 1.0) + (if diff < 0.0 { diff.abs() } else { 0.0 })) / pf;
        rsi[i] = Some(if al == 0.0 { 100.0 } else { 100.0 - 100.0 / (1.0 + ag / al) });
    }
    rsi
}

fn sma_skip_null(src: &[Option<f64>], w: usize) -> Vec<Option<f64>> {
    let n = src.len();
    let mut out = vec![None; n];
    for i in 0..n {
        if src[i].is_none() {
            continue;
        }
        let mut sum = 0.0;
        let mut cnt = 0usize;
        let start = if i + 1 >= w { i + 1 - w } else { 0 };
        for x in src.iter().take(i + 1).skip(start) {
            if let Some(v) = x {
                sum += *v;
                cnt += 1;
            }
        }
        if cnt >= w {
            out[i] = Some(sum / cnt as f64);
        }
    }
    out
}

pub fn calc_stoch_rsi(c: &[f64]) -> (Vec<Option<f64>>, Vec<Option<f64>>) {
    let (rp, sp, ks, ds) = (14usize, 14usize, 3usize, 3usize);
    let rsi = calc_rsi(c, rp);
    let n = c.len();
    let mut k = vec![None; n];
    let mut i = rp + sp - 1;
    while i < n {
        let mut hi = f64::NEG_INFINITY;
        let mut lo = f64::INFINITY;
        for x in rsi.iter().take(i + 1).skip(i + 1 - sp) {
            if let Some(r) = x {
                hi = js::max(hi, *r);
                lo = js::min(lo, *r);
            }
        }
        let ri = js::at(&rsi, i as isize).num();
        k[i] = Some(if hi != lo { (ri - lo) / (hi - lo) * 100.0 } else { 50.0 });
        i += 1;
    }
    let smooth_k = sma_skip_null(&k, ks);
    let d = sma_skip_null(&smooth_k, ds);
    (smooth_k, d)
}

pub fn calc_macd(c: &[f64]) -> (Vec<Option<f64>>, Vec<Option<f64>>, Vec<Option<f64>>) {
    let n = c.len();
    let ef = calc_ema(c, 12);
    let es = calc_ema(c, 26);
    let macd: Vec<Option<f64>> = (0..n)
        .map(|i| match (ef[i], es[i]) {
            (Some(a), Some(b)) => Some(a - b),
            _ => None,
        })
        .collect();
    let vals: Vec<f64> = macd.iter().filter_map(|x| *x).collect();
    let raw = calc_ema(&vals, 9);
    let mut signal = vec![None; n];
    let mut idx = 0usize;
    for i in 0..n {
        if macd[i].is_some() {
            signal[i] = raw[idx];
            idx += 1;
        }
    }
    let hist: Vec<Option<f64>> = (0..n)
        .map(|i| match (macd[i], signal[i]) {
            (Some(m), Some(s)) => Some(m - s),
            _ => None,
        })
        .collect();
    (macd, signal, hist)
}

pub fn calc_bollinger(c: &[f64], p: usize, mult: f64) -> (Vec<Option<f64>>, Vec<Option<f64>>, Vec<Option<f64>>) {
    let n = c.len();
    let middle = calc_ma(c, p);
    let mut upper = vec![None; n];
    let mut lower = vec![None; n];
    let mut i = p - 1;
    while i < n {
        let m = middle[i].unwrap();
        let mut sum_sq = 0.0;
        for x in c.iter().take(i + 1).skip(i + 1 - p) {
            let d = *x - m;
            sum_sq += d * d; // Math.pow(x, 2) === x * x (fdlibm special case)
        }
        let std = (sum_sq / p as f64).sqrt();
        upper[i] = Some(m + mult * std);
        lower[i] = Some(m - mult * std);
        i += 1;
    }
    (upper, middle, lower)
}

pub fn calc_sr(b: &[Bar]) -> Vec<Sr> {
    let n = b.len();
    if n < 10 {
        return Vec::new();
    }
    let mut levels: Vec<Sr> = Vec::new();
    for i in 2..n - 2 {
        let h = b[i].h;
        if h > b[i - 1].h && h > b[i - 2].h && h > b[i + 1].h && h > b[i + 2].h {
            levels.push(Sr { res: true, price: h, idx: i, count: 0 });
        }
        let l = b[i].l;
        if l < b[i - 1].l && l < b[i - 2].l && l < b[i + 1].l && l < b[i + 2].l {
            levels.push(Sr { res: false, price: l, idx: i, count: 0 });
        }
    }
    levels.sort_by(|a, b| js::cmp_num(a.price - b.price));
    let mut clustered: Vec<Sr> = Vec::new();
    for lv in levels {
        if let Some(f) = clustered.iter_mut().find(|c| (c.price - lv.price).abs() / lv.price < 0.015) {
            f.count += 1;
            f.price = (f.price + lv.price) / 2.0;
        } else {
            clustered.push(Sr { count: 1, ..lv });
        }
    }
    clustered.sort_by(|a, b| js::cmp_num(b.count as f64 - a.count as f64));
    clustered.truncate(8);
    clustered
}

pub fn calc_mfi(b: &[Bar], p: usize) -> V {
    let n = b.len();
    if n < p + 1 {
        return V::N;
    }
    let mut pos = 0.0;
    let mut neg = 0.0;
    let start = if n > p { core::cmp::max(1, n - p) } else { 1 };
    for i in start..n {
        let tp = (b[i].h + b[i].l + b[i].c) / 3.0;
        let prev = (b[i - 1].h + b[i - 1].l + b[i - 1].c) / 3.0;
        let mf = tp * b[i].v;
        if tp > prev {
            pos += mf;
        } else {
            neg += mf;
        }
    }
    if neg == 0.0 {
        return V::F(100.0);
    }
    V::F(100.0 - 100.0 / (1.0 + pos / neg))
}

pub fn calc_obv(b: &[Bar]) -> Vec<f64> {
    let mut obv = vec![0.0];
    for i in 1..b.len() {
        let prev = obv[i - 1];
        if b[i].c > b[i - 1].c {
            obv.push(prev + b[i].v);
        } else if b[i].c < b[i - 1].c {
            obv.push(prev - b[i].v);
        } else {
            obv.push(prev);
        }
    }
    obv
}

pub fn calc_obv_trend(obv: &[f64], closes: &[f64], lb: usize) -> &'static str {
    if obv.len() < lb {
        return "neutral";
    }
    let os = js::atf(obv, obv.len() as isize - lb as isize).num();
    let oe = js::atf(obv, obv.len() as isize - 1).num();
    let ps = js::atf(closes, closes.len() as isize - lb as isize).num();
    let pe = js::atf(closes, closes.len() as isize - 1).num();
    let obv_chg = (oe - os) / js::or(os.abs(), 1.0);
    let price_chg = if ps != 0.0 { (pe - ps) / ps } else { 0.0 };
    if obv_chg > 0.05 && price_chg < 0.0 {
        return "accumulation";
    }
    if obv_chg < -0.05 && price_chg > 0.0 {
        return "distribution";
    }
    if obv_chg > 0.05 && price_chg > 0.0 {
        return "confirmation";
    }
    "neutral"
}

pub fn calc_adl(b: &[Bar]) -> Vec<f64> {
    let mut adl = vec![0.0];
    for bar in b {
        let mfm = if bar.h == bar.l { 0.0 } else { ((bar.c - bar.l) - (bar.h - bar.c)) / (bar.h - bar.l) };
        let last = js::or(*adl.last().unwrap(), 0.0);
        adl.push(last + mfm * bar.v);
    }
    adl
}

pub fn calc_vwap(b: &[Bar], lb: usize) -> V {
    let n = b.len();
    let start = n.saturating_sub(lb);
    let mut cum_vol = 0.0;
    let mut cum_tp = 0.0;
    for bar in &b[start..] {
        let tp = (bar.h + bar.l + bar.c) / 3.0;
        cum_vol += bar.v;
        cum_tp += tp * bar.v;
    }
    if cum_vol > 0.0 {
        V::F(cum_tp / cum_vol)
    } else {
        V::N
    }
}

#[inline]
fn true_range(b: &[Bar], i: usize) -> f64 {
    let (hi, lo, pc) = (b[i].h, b[i].l, b[i - 1].c);
    js::max(js::max(hi - lo, (hi - pc).abs()), (lo - pc).abs())
}

pub fn calc_atr(b: &[Bar], p: usize) -> V {
    let trs: Vec<f64> = (1..b.len()).map(|i| true_range(b, i)).collect();
    let pf = p as f64;
    let mut atr: Vec<f64> = Vec::new();
    let mut sum = 0.0;
    for i in 0..trs.len() {
        sum += trs[i];
        if i + 1 >= p {
            if i + 1 == p {
                atr.push(sum / pf);
            } else {
                let last = *atr.last().unwrap();
                atr.push((last * (pf - 1.0) + trs[i]) / pf);
                sum -= trs[i + 1 - p];
            }
        }
    }
    match atr.last() {
        Some(x) => V::F(*x),
        None => V::N,
    }
}

#[derive(Clone, Debug)]
pub struct Fibs {
    pub up: bool,
    pub high: f64,
    pub low: f64,
    pub f0: f64,
    pub f236: f64,
    pub f382: f64,
    pub f5: f64,
    pub f618: f64,
    pub f1: f64,
    pub f1272: f64,
    pub f1618: f64,
}

pub fn calc_fibonacci(b: &[Bar]) -> Option<Fibs> {
    let n = b.len();
    let lb = core::cmp::min(60, n);
    let (mut hi, mut lo, mut hi_idx, mut lo_idx) = (f64::NEG_INFINITY, f64::INFINITY, 0usize, 0usize);
    for (i, bar) in b.iter().enumerate().skip(n - lb) {
        if bar.h > hi {
            hi = bar.h;
            hi_idx = i;
        }
        if bar.l < lo {
            lo = bar.l;
            lo_idx = i;
        }
    }
    let up = lo_idx < hi_idx;
    let diff = hi - lo;
    if diff <= 0.0 {
        return None;
    }
    Some(if up {
        Fibs {
            up, high: hi, low: lo,
            f0: hi, f236: hi - diff * 0.236, f382: hi - diff * 0.382, f5: hi - diff * 0.5, f618: hi - diff * 0.618,
            f1: lo, f1272: hi + diff * 0.272, f1618: hi + diff * 0.618,
        }
    } else {
        Fibs {
            up, high: hi, low: lo,
            f0: lo, f236: lo + diff * 0.236, f382: lo + diff * 0.382, f5: lo + diff * 0.5, f618: lo + diff * 0.618,
            f1: hi, f1272: lo - diff * 0.272, f1618: lo - diff * 0.618,
        }
    })
}

#[derive(Clone, Debug)]
pub struct Pivots {
    pub pp: f64,
    pub r1: f64,
    pub r2: f64,
    pub r3: f64,
    pub s1: f64,
    pub s2: f64,
    pub s3: f64,
}

pub fn calc_pivots(b: &[Bar]) -> Pivots {
    let last = b[b.len() - 1];
    let (h, l, c) = (last.h, last.l, last.c);
    let pp = (h + l + c) / 3.0;
    Pivots {
        pp,
        r1: 2.0 * pp - l,
        r2: pp + (h - l),
        r3: h + 2.0 * (pp - l),
        s1: 2.0 * pp - h,
        s2: pp - (h - l),
        s3: l - 2.0 * (h - pp),
    }
}

pub fn calc_cmf(b: &[Bar], p: usize) -> V {
    let n = b.len();
    if n < p {
        return V::N;
    }
    let mut mfv = 0.0;
    let mut vol = 0.0;
    for bar in &b[n - p..] {
        let mfm = if bar.h == bar.l { 0.0 } else { ((bar.c - bar.l) - (bar.h - bar.c)) / (bar.h - bar.l) };
        mfv += mfm * bar.v;
        vol += bar.v;
    }
    V::F(if vol > 0.0 { mfv / vol } else { 0.0 })
}

pub fn calc_adx(b: &[Bar], p: usize) -> (V, V, V) {
    let n = b.len();
    if n < p + 1 {
        return (V::N, V::N, V::N);
    }
    let pf = p as f64;
    let mut tr = Vec::with_capacity(n);
    let mut pdm = Vec::with_capacity(n);
    let mut mdm = Vec::with_capacity(n);
    for i in 1..n {
        let (h, l) = (b[i].h, b[i].l);
        tr.push(true_range(b, i));
        let up = h - b[i - 1].h;
        let down = b[i - 1].l - l;
        pdm.push(if up > down && up > 0.0 { up } else { 0.0 });
        mdm.push(if down > up && down > 0.0 { down } else { 0.0 });
    }
    let (mut s_tr, mut s_p, mut s_m) = (0.0, 0.0, 0.0);
    for i in 0..p {
        s_tr += tr[i];
        s_p += pdm[i];
        s_m += mdm[i];
    }
    let mut di_p: Vec<f64> = Vec::new();
    let mut di_m: Vec<f64> = Vec::new();
    let mut dx: Vec<f64> = Vec::new();
    for i in p..tr.len() {
        if i > p {
            s_tr = s_tr - s_tr / pf + tr[i - 1];
            s_p = s_p - s_p / pf + pdm[i - 1];
            s_m = s_m - s_m / pf + mdm[i - 1];
        }
        let pdi = if s_tr > 0.0 { (s_p / s_tr) * 100.0 } else { 0.0 };
        let mdi = if s_tr > 0.0 { (s_m / s_tr) * 100.0 } else { 0.0 };
        di_p.push(pdi);
        di_m.push(mdi);
        let sum = pdi + mdi;
        dx.push(if sum > 0.0 { (pdi - mdi).abs() / sum * 100.0 } else { 0.0 });
    }
    let mut adx_arr: Vec<f64> = Vec::new();
    if dx.len() >= p {
        let mut s = 0.0;
        for x in dx.iter().take(p) {
            s += *x;
        }
        adx_arr.push(s / pf);
        for x in dx.iter().skip(p) {
            let last = *adx_arr.last().unwrap();
            adx_arr.push((last * (pf - 1.0) + *x) / pf);
        }
    }
    let lv = |v: &Vec<f64>| match v.last() {
        Some(x) => V::F(*x),
        None => V::N,
    };
    (lv(&adx_arr), lv(&di_p), lv(&di_m))
}

pub fn calc_keltner(b: &[Bar], closes: &[f64]) -> (Vec<Option<f64>>, Vec<Option<f64>>) {
    let (ema_p, atr_p, mult) = (20usize, 14usize, 1.5);
    let ema = calc_ema(closes, ema_p);
    let n = b.len();
    let mut upper = vec![None; n];
    let mut lower = vec![None; n];
    let trs: Vec<f64> = (1..n).map(|i| true_range(b, i)).collect();
    for i in 0..n {
        let e = match ema[i] {
            Some(e) if i >= atr_p => e,
            _ => continue,
        };
        let mut s = 0.0;
        for x in trs.iter().take(i).skip(i - atr_p) {
            s += *x;
        }
        let atr = s / atr_p as f64;
        upper[i] = Some(e + mult * atr);
        lower[i] = Some(e - mult * atr);
    }
    (upper, lower)
}

pub fn calc_ttm(b: &[Bar], closes: &[f64]) -> Ttm {
    let (bu, bm, bl) = calc_bollinger(closes, 20, 2.0);
    let (ku, kl) = calc_keltner(b, closes);
    let n = b.len();
    let mut on = false;
    let mut count = 0u32;
    for i in n.saturating_sub(10)..n {
        if let (Some(u), Some(k_u)) = (bu[i], ku[i]) {
            let l = bl[i].unwrap();
            let k_l = kl[i].unwrap();
            if u < k_u && l > k_l {
                on = true;
                count += 1;
            }
        }
    }
    let mut momentum = 0.0;
    if n >= 3 {
        let last = b[n - 1].c - V::from_opt(bm[n - 1]).or(b[n - 1].c);
        let prev = b[n - 2].c - V::from_opt(bm[n - 2]).or(b[n - 2].c);
        momentum = last - prev;
    }
    Ttm { on, count, momentum, firing: count >= 3 }
}

pub fn calc_chandelier(b: &[Bar]) -> Chandelier {
    let (p, mult) = (22usize, 3.0);
    let n = b.len();
    if n < p + 1 {
        return Chandelier::Short;
    }
    let mut hh = f64::NEG_INFINITY;
    for bar in &b[n - p..] {
        if bar.h > hh {
            hh = bar.h;
        }
    }
    let mut ll = f64::INFINITY;
    for bar in &b[n - p..] {
        if bar.l < ll {
            ll = bar.l;
        }
    }
    let start = core::cmp::max(1, n - p - 1);
    let trs: Vec<f64> = (start..n).map(|i| true_range(b, i)).collect();
    let atr_len = core::cmp::min(p, trs.len());
    let mut atr = 0.0;
    for x in &trs[trs.len() - atr_len..] {
        atr += *x;
    }
    atr = if atr_len > 0 { atr / atr_len as f64 } else { 0.0 };
    Chandelier::Full { long_stop: hh - mult * atr, short_stop: ll + mult * atr, atr }
}

pub fn detect_wyckoff_phase(b: &[Bar], vol_ratio: f64, obv_trend: &str) -> &'static str {
    let n = b.len();
    if n < 30 {
        return "unknown";
    }
    let base = b[n - 20].c;
    let chg = if base != 0.0 { (b[n - 1].c - base) / base * 100.0 } else { 0.0 };
    let vt = vol_ratio;
    if obv_trend == "accumulation" && chg < 2.0 && chg > -5.0 {
        return "accumulation";
    }
    if obv_trend == "accumulation" && chg > 2.0 && vt > 1.3 {
        return "markup";
    }
    if obv_trend == "distribution" && chg > -2.0 && chg < 5.0 {
        return "distribution";
    }
    if obv_trend == "distribution" && chg < -2.0 && vt > 1.3 {
        return "markdown";
    }
    if chg > 5.0 && vt > 1.5 {
        return "markup";
    }
    if chg < -5.0 && vt > 1.5 {
        return "markdown";
    }
    "ranging"
}

pub fn calc_candles(b: &[Bar]) -> Vec<Candle> {
    let n = b.len();
    let mut out = Vec::new();
    if n < 5 {
        return out;
    }
    let c = b[n - 1];
    let p = b[n - 2];
    let body = (c.c - c.o).abs();
    let range = c.h - c.l;
    let upper = c.h - js::max(c.o, c.c);
    let lower = js::min(c.o, c.c) - c.l;
    let green = c.c > c.o;
    let red = c.c < c.o;
    if lower > body * 2.0 && upper < body * 0.5 {
        out.push(Candle { name: "Hammer", kind: "bullish", desc: "Güçlü alt iğne — alım baskısı" });
    }
    if upper > body * 2.0 && lower < body * 0.5 {
        out.push(Candle { name: "Shooting Star", kind: "bearish", desc: "Güçlü üst iğne — satış baskısı" });
    }
    if green && p.c < p.o && c.c > p.o && c.o < p.c {
        out.push(Candle { name: "Bullish Engulfing", kind: "bullish", desc: "Yutucu Boğa — önceki barı yuttu" });
    }
    if red && p.c > p.o && c.c < p.o && c.o > p.c {
        out.push(Candle { name: "Bearish Engulfing", kind: "bearish", desc: "Yutucu Ayı — önceki barı yuttu" });
    }
    if body > range * 0.9 && body > 1.0 {
        out.push(Candle {
            name: if green { "Bullish Marubozu" } else { "Bearish Marubozu" },
            kind: if green { "bullish" } else { "bearish" },
            desc: "Gövdesi dolu güçlü mum",
        });
    }
    if body < range * 0.1 {
        out.push(Candle { name: "Doji", kind: "neutral", desc: "Kararsızlık mumu" });
    }
    out
}

pub fn detect_obv_divergence(b: &[Bar], obv: &[f64], lb: usize) -> Option<&'static str> {
    let n = b.len();
    if n < lb + 5 || obv.len() < lb + 5 {
        return None;
    }
    let ps = b[n - lb].c;
    let pe = b[n - 1].c;
    let price_slope = (pe - ps) / ps;
    let os = obv[obv.len() - lb];
    let oe = obv[obv.len() - 1];
    let obv_slope = if os != 0.0 { (oe - os) / os.abs() } else { 0.0 };
    let (mut pl1, mut pl2, mut ol1, mut ol2) = (f64::INFINITY, f64::INFINITY, 0.0, 0.0);
    let (mut ph1, mut ph2, mut oh1, mut oh2) = (f64::NEG_INFINITY, f64::NEG_INFINITY, 0.0, 0.0);
    let half = lb / 2;
    for i in (n - lb)..(n - half) {
        if b[i].l < pl1 {
            pl1 = b[i].l;
            ol1 = obv[i];
        }
        if b[i].h > ph1 {
            ph1 = b[i].h;
            oh1 = obv[i];
        }
    }
    for i in (n - half)..n {
        if b[i].l < pl2 {
            pl2 = b[i].l;
            ol2 = obv[i];
        }
        if b[i].h > ph2 {
            ph2 = b[i].h;
            oh2 = obv[i];
        }
    }
    if pl2 < pl1 * 0.99 && ol2 > ol1 * 1.02 {
        return Some("bullish_div");
    }
    if ph2 > ph1 * 1.01 && oh2 < oh1 * 0.98 {
        return Some("bearish_div");
    }
    if pl2 > pl1 * 1.01 && ol2 < ol1 * 0.98 {
        return Some("hidden_bullish");
    }
    if ph2 < ph1 * 0.99 && oh2 > oh1 * 1.02 {
        return Some("hidden_bearish");
    }
    if price_slope < -0.02 && obv_slope > 0.05 {
        return Some("bullish_div");
    }
    if price_slope > 0.02 && obv_slope < -0.05 {
        return Some("bearish_div");
    }
    None
}

pub fn detect_wyckoff_spring(b: &[Bar], sr: &[Sr]) -> Option<Spring> {
    let n = b.len();
    if n < 10 || sr.is_empty() {
        return None;
    }
    let last = b[n - 1].c;
    let prev_low = b[n - 2].l;
    let prev_prev_low = if n > 2 { b[n - 3].l } else { prev_low };
    for s in sr.iter().filter(|s| !s.res && s.price < last * 1.03) {
        let broke = prev_low < s.price * 0.995 || prev_prev_low < s.price * 0.995;
        let recovered = last > s.price * 1.005;
        if broke && recovered {
            return Some(Spring {
                kind: "spring",
                level: s.price,
                desc: format!("Wyckoff Spring: {} TL destegin altina sarkip geri dondu", js::to_fixed(s.price, 2)),
            });
        }
    }
    for r in sr.iter().filter(|s| s.res && s.price > last * 0.97) {
        let n2 = b[n - 2].h;
        let n3 = if n > 2 { b[n - 3].h } else { n2 };
        let broke = n2 > r.price * 1.005 || n3 > r.price * 1.005;
        let fell = last < r.price * 0.995;
        if broke && fell {
            return Some(Spring {
                kind: "utad",
                level: r.price,
                desc: format!("Wyckoff UTAD: {} TL direncin uzerine cikip geri dondu", js::to_fixed(r.price, 2)),
            });
        }
    }
    None
}

pub fn detect_volume_climax(b: &[Bar], lb: usize) -> Option<Climax> {
    let n = b.len();
    if n < lb + 2 {
        return None;
    }
    let mut avg = 0.0;
    for bar in &b[n - lb - 1..n - 1] {
        avg += bar.v;
    }
    avg /= lb as f64;
    let last_vol = b[n - 1].v;
    let last_change = (b[n - 1].c - b[n - 2].c) / b[n - 2].c * 100.0;
    let vm = if avg > 0.0 { last_vol / avg } else { 1.0 };
    if vm >= 3.0 && last_change.abs() > 3.0 {
        let up = last_change > 0.0;
        return Some(Climax {
            kind: if up { "buying_climax" } else { "selling_climax" },
            vol_multiple: vm,
            price_change: last_change,
            desc: if up {
                format!("Alim klimaksi: {}x hacim ile +%{} — potansiyel geri cekilme", js::to_fixed(vm, 1), js::to_fixed(last_change, 1))
            } else {
                format!("Satim klimaksi: {}x hacim ile %{} — potansiyel dip firsat", js::to_fixed(vm, 1), js::to_fixed(last_change, 1))
            },
        });
    }
    if vm >= 2.5 && last_change.abs() < 0.5 {
        return Some(Climax {
            kind: "volume_exhaustion",
            vol_multiple: vm,
            price_change: last_change,
            desc: format!("Hacim tukenmesi: {}x hacim ama fiyat degismedi — yon degisimi olabilir", js::to_fixed(vm, 1)),
        });
    }
    None
}

pub fn detect_rsi_divergence(b: &[Bar], rsi: &[Option<f64>], lb: usize) -> Option<&'static str> {
    let n = b.len();
    if n < lb + 5 || rsi.len() < lb + 5 {
        return None;
    }
    let half = lb / 2;
    let (mut pl1, mut pl2, mut rl1, mut rl2) = (f64::INFINITY, f64::INFINITY, 50.0, 50.0);
    let (mut ph1, mut ph2, mut rh1, mut rh2) = (f64::NEG_INFINITY, f64::NEG_INFINITY, 50.0, 50.0);
    for i in (n - lb)..(n - half) {
        let r = V::from_opt(rsi[i]).or(50.0);
        if b[i].l < pl1 {
            pl1 = b[i].l;
            rl1 = r;
        }
        if b[i].h > ph1 {
            ph1 = b[i].h;
            rh1 = r;
        }
    }
    for i in (n - half)..n {
        let r = V::from_opt(rsi[i]).or(50.0);
        if b[i].l < pl2 {
            pl2 = b[i].l;
            rl2 = r;
        }
        if b[i].h > ph2 {
            ph2 = b[i].h;
            rh2 = r;
        }
    }
    if pl2 < pl1 * 0.99 && rl2 > rl1 + 3.0 {
        return Some("bullish");
    }
    if ph2 > ph1 * 1.01 && rh2 < rh1 - 3.0 {
        return Some("bearish");
    }
    None
}

pub fn calc_ichimoku(b: &[Bar]) -> Ichimoku {
    let (tp, kp, sbp) = (9usize, 26usize, 52usize);
    let n = b.len();
    let mut tenkan = vec![None; n];
    let mut kijun = vec![None; n];
    let mut sa = vec![None; n];
    let mut sb = vec![None; n];
    let mut chikou = vec![None; n];
    let phl = |s: usize, e: usize| {
        let mut hi = f64::NEG_INFINITY;
        let mut lo = f64::INFINITY;
        for bar in &b[s..=e] {
            if bar.h > hi {
                hi = bar.h;
            }
            if bar.l < lo {
                lo = bar.l;
            }
        }
        (hi + lo) / 2.0
    };
    for i in 0..n {
        if i + 1 >= tp {
            tenkan[i] = Some(phl(i + 1 - tp, i));
        }
        if i + 1 >= kp {
            kijun[i] = Some(phl(i + 1 - kp, i));
        }
        if let (Some(t), Some(k)) = (tenkan[i], kijun[i]) {
            sa[i] = Some((t + k) / 2.0);
        }
        if i + 1 >= sbp {
            sb[i] = Some(phl(i + 1 - sbp, i));
        }
        if i >= kp {
            chikou[i - kp] = Some(b[i].c);
        }
    }
    let ni = n as isize;
    let last_tenkan = js::at(&tenkan, ni - 1);
    let last_kijun = js::at(&kijun, ni - 1);
    let last_sa = js::at(&sa, ni - 1);
    let last_sb = js::at(&sb, ni - 1);
    let last_close = b[n - 1].c;
    let prev_t = if n >= 2 { js::at(&tenkan, ni - 2) } else { V::N };
    let prev_k = if n >= 2 { js::at(&kijun, ni - 2) } else { V::N };

    let mut tk_cross = None;
    if !last_tenkan.nullish() && !last_kijun.nullish() && !prev_t.nullish() && !prev_k.nullish() {
        let (lt, lk, pt, pk) = (last_tenkan.num(), last_kijun.num(), prev_t.num(), prev_k.num());
        if pt <= pk && lt > lk {
            tk_cross = Some("bullish");
        } else if pt >= pk && lt < lk {
            tk_cross = Some("bearish");
        }
    }
    let both = !last_sa.nullish() && !last_sb.nullish();
    let kumo_top = if both { V::F(js::max(last_sa.num(), last_sb.num())) } else { V::N };
    let kumo_bottom = if both { V::F(js::min(last_sa.num(), last_sb.num())) } else { V::N };
    let mut kumo_breakout = None;
    if !kumo_top.nullish() {
        let prev_close = if n >= 2 { b[n - 2].c } else { last_close };
        let (top, bot) = (kumo_top.num(), kumo_bottom.num());
        if last_close > top && prev_close <= top {
            kumo_breakout = Some("bullish");
        } else if last_close < bot && prev_close >= bot {
            kumo_breakout = Some("bearish");
        }
    }
    let mut kumo_twist = None;
    if n >= 3 {
        if let (Some(pa), Some(pb)) = (sa[n - 2], sb[n - 2]) {
            let prev_above = pa > pb;
            let curr_above = last_sa.num() > last_sb.num();
            if !prev_above && curr_above {
                kumo_twist = Some("bullish");
            } else if prev_above && !curr_above {
                kumo_twist = Some("bearish");
            }
        }
    }
    let mut cloud = "inside";
    if !kumo_top.nullish() {
        if last_close > kumo_top.num() {
            cloud = "above";
        } else if last_close < kumo_bottom.num() {
            cloud = "below";
        }
    }
    Ichimoku {
        tenkan, kijun, senkou_a: sa, senkou_b: sb, chikou,
        last_tenkan, last_kijun, last_sa, last_sb,
        tk_cross, kumo_breakout, kumo_twist, cloud, kumo_top, kumo_bottom,
    }
}

pub fn calc_williams(b: &[Bar], p: usize) -> Vec<Option<f64>> {
    let n = b.len();
    let mut wr = vec![None; n];
    let mut i = p - 1;
    while i < n {
        let mut hh = f64::NEG_INFINITY;
        let mut ll = f64::INFINITY;
        for bar in &b[i + 1 - p..=i] {
            if bar.h > hh {
                hh = bar.h;
            }
            if bar.l < ll {
                ll = bar.l;
            }
        }
        wr[i] = Some(if hh != ll { ((hh - b[i].c) / (hh - ll)) * -100.0 } else { -50.0 });
        i += 1;
    }
    wr
}

pub fn calc_trix(c: &[f64], p: usize) -> Trix {
    let e1 = calc_ema(c, p);
    let f1: Vec<f64> = e1.iter().filter_map(|x| *x).collect();
    let e2 = calc_ema(&f1, p);
    let f2: Vec<f64> = e2.iter().filter_map(|x| *x).collect();
    let e3 = calc_ema(&f2, p);
    let n = e3.len();
    if n < 2 {
        return Trix::Short;
    }
    // ema3 keeps its null head; JS arithmetic reads null as 0 and `null !== 0`
    // is true, so the head of the TRIX series is NaN / ±Infinity (kept).
    let num = |o: Option<f64>| o.unwrap_or(0.0);
    let mut trix = Vec::with_capacity(n - 1);
    for i in 1..n {
        let prev = e3[i - 1];
        let not_zero = match prev {
            None => true,
            Some(x) => x != 0.0,
        };
        trix.push(if not_zero { ((num(e3[i]) - num(prev)) / num(prev)) * 10000.0 } else { 0.0 });
    }
    let sp = 9usize;
    let mut signal = Vec::with_capacity(trix.len());
    for i in 0..trix.len() {
        if i + 1 < sp {
            signal.push(None);
            continue;
        }
        let mut s = 0.0;
        for x in &trix[i + 1 - sp..=i] {
            s += *x;
        }
        signal.push(Some(s / sp as f64));
    }
    let len = trix.len();
    let last = V::F(trix[len - 1]);
    let last_signal = V::from_opt(signal[len - 1]);
    let prev_t = if len > 1 { V::F(trix[len - 2]) } else { V::N };
    let prev_s = if len > 1 { V::from_opt(signal[len - 2]) } else { V::N };
    let mut crossover = None;
    if !last.nullish() && !last_signal.nullish() && !prev_t.nullish() && !prev_s.nullish() {
        let (lt, ls, pt, ps) = (last.num(), last_signal.num(), prev_t.num(), prev_s.num());
        if pt <= ps && lt > ls {
            crossover = Some("bullish");
        } else if pt >= ps && lt < ls {
            crossover = Some("bearish");
        }
    }
    Trix::Full { trix, signal, last, last_signal, crossover }
}

pub fn calc_supertrend(b: &[Bar], p: usize, mult: f64) -> Supertrend {
    let n = b.len();
    if n < p + 1 {
        return Supertrend::Short;
    }
    let mut st = vec![None; n];
    let mut dir = vec![0.0f64; n];
    let trs: Vec<f64> = (1..n).map(|i| true_range(b, i)).collect();
    let (mut prev_upper, mut prev_lower, mut prev_st) = (0.0f64, 0.0f64, 0.0f64);
    for i in p..n {
        let mut s = 0.0;
        for x in &trs[i - p..i] {
            s += js::or(*x, 0.0);
        }
        let atr = s / p as f64;
        let hl2 = (b[i].h + b[i].l) / 2.0;
        let mut upper = hl2 + mult * atr;
        let mut lower = hl2 - mult * atr;
        if prev_upper > 0.0 && b[i - 1].c <= prev_upper {
            upper = js::min(upper, prev_upper);
        }
        if prev_lower > 0.0 && b[i - 1].c >= prev_lower {
            lower = js::max(lower, prev_lower);
        }
        let d = if prev_st == prev_upper {
            if b[i].c > upper { 1.0 } else { -1.0 }
        } else if b[i].c < lower {
            -1.0
        } else {
            1.0
        };
        let v = if d == 1.0 { lower } else { upper };
        st[i] = Some(v);
        dir[i] = d;
        prev_upper = upper;
        prev_lower = lower;
        prev_st = v;
    }
    let last_dir = dir[n - 1];
    let value = js::at(&st, n as isize - 1);
    let mut flip = None;
    if n >= 2 && dir[n - 2] != 0.0 && dir[n - 1] != 0.0 {
        if dir[n - 2] == -1.0 && dir[n - 1] == 1.0 {
            flip = Some("bullish");
        } else if dir[n - 2] == 1.0 && dir[n - 1] == -1.0 {
            flip = Some("bearish");
        }
    }
    Supertrend::Full { st, dir, up: last_dir == 1.0, value, flip }
}

pub fn calc_volume_profile(b: &[Bar], lb: usize) -> VolProfile {
    let n = b.len();
    let start = n.saturating_sub(lb);
    let slice = &b[start..];
    if slice.len() < 10 {
        return VolProfile::Empty;
    }
    let mut hi = f64::NEG_INFINITY;
    let mut lo = f64::INFINITY;
    for bar in slice {
        if bar.h > hi {
            hi = bar.h;
        }
        if bar.l < lo {
            lo = bar.l;
        }
    }
    let range = hi - lo;
    if range <= 0.0 {
        return VolProfile::Empty;
    }
    const NB: usize = 24;
    let bin = range / NB as f64;
    let mut bins = [0.0f64; NB];
    for bar in slice {
        let idx = js::min((NB - 1) as f64, ((bar.c - lo) / bin).floor());
        // JS writes bins[-1] / bins[NaN] as ignored named properties.
        if idx >= 0.0 {
            bins[idx as usize] += bar.v;
        }
    }
    let mut max_vol = 0.0;
    let mut poc_idx = 0usize;
    for (i, v) in bins.iter().enumerate() {
        if *v > max_vol {
            max_vol = *v;
            poc_idx = i;
        }
    }
    let poc = lo + (poc_idx as f64 + 0.5) * bin;
    let mut total = 0.0;
    for v in bins.iter() {
        total += *v;
    }
    let target = total * 0.7;
    let mut va_vol = bins[poc_idx];
    let (mut va_lo, mut va_hi) = (poc_idx, poc_idx);
    while va_vol < target && (va_lo > 0 || va_hi < NB - 1) {
        let lo_add = if va_lo > 0 { bins[va_lo - 1] } else { 0.0 };
        let hi_add = if va_hi < NB - 1 { bins[va_hi + 1] } else { 0.0 };
        if lo_add >= hi_add && va_lo > 0 {
            va_lo -= 1;
            va_vol += bins[va_lo];
        } else if va_hi < NB - 1 {
            va_hi += 1;
            va_vol += bins[va_hi];
        } else {
            break;
        }
    }
    VolProfile::Full {
        poc,
        vah: lo + (va_hi as f64 + 1.0) * bin,
        val: lo + va_lo as f64 * bin,
        bins: bins.iter().enumerate().map(|(i, v)| (lo + (i as f64 + 0.5) * bin, *v)).collect(),
    }
}

pub fn calc_roc(c: &[f64], p: usize) -> Vec<Option<f64>> {
    let n = c.len();
    let mut roc = vec![None; n];
    for i in p..n {
        if c[i - p] != 0.0 {
            roc[i] = Some(((c[i] - c[i - p]) / c[i - p]) * 100.0);
        }
    }
    roc
}

/// calcAll(prices). Requires at least one bar (JS throws on an empty array;
/// the JS wrapper never routes that case here).
pub fn calc_all(b: &[Bar]) -> Indicators {
    let n = b.len();
    let closes: Vec<f64> = b.iter().map(|x| x.c).collect();
    let ma20 = calc_ma(&closes, 20);
    let ma50 = calc_ma(&closes, 50);
    let ma100 = calc_ma(&closes, 100);
    let ma200 = calc_ma(&closes, 200);
    let rsi = calc_rsi(&closes, 14);
    let (stoch_k, stoch_d) = calc_stoch_rsi(&closes);
    let (macd, macd_sig, macd_hist) = calc_macd(&closes);
    let (bb_u, bb_m, bb_l) = calc_bollinger(&closes, 20, 2.0);
    let sr = calc_sr(b);
    let mfi = calc_mfi(b, 14);
    let obv = calc_obv(b);
    let obv_trend = calc_obv_trend(&obv, &closes, 20);
    let adl = calc_adl(b);
    let vwap = calc_vwap(b, 20);
    let cmf = calc_cmf(b, 20);
    let (adx, plus_di, minus_di) = calc_adx(b, 14);
    let ttm = calc_ttm(b, &closes);
    let chandelier = calc_chandelier(b);
    let candles = calc_candles(b);

    let mut adl_trend = "neutral";
    if adl.len() >= 20 {
        let a0 = adl[adl.len() - 20];
        let chg = (adl[adl.len() - 1] - a0) / js::or(a0.abs(), 1.0);
        if chg > 0.05 {
            adl_trend = "accumulation";
        } else if chg < -0.05 {
            adl_trend = "distribution";
        }
    }
    let last_vol = b[n - 1].v;
    let lb = core::cmp::min(20, n);
    let mut avg_vol = 0.0;
    for bar in &b[n - lb..] {
        avg_vol += bar.v;
    }
    avg_vol /= lb as f64;
    let vol_ratio = if avg_vol > 0.0 { last_vol / avg_vol } else { 1.0 };
    let last_close = closes[n - 1];
    let prev_close = if n > 1 { closes[n - 2] } else { last_close };
    let change = last_close - prev_close;
    let change_pct = (change / prev_close) * 100.0;
    let atr = calc_atr(b, 14);

    let wyckoff_phase = detect_wyckoff_phase(b, vol_ratio, obv_trend);
    let obv_div = detect_obv_divergence(b, &obv, 15);
    let rsi_div = detect_rsi_divergence(b, &rsi, 20);
    let spring = detect_wyckoff_spring(b, &sr);
    let climax = detect_volume_climax(b, 20);
    let di_conv = if plus_di.nullish() || minus_di.nullish() {
        None
    } else {
        let gap = (plus_di.num() - minus_di.num()).abs();
        if gap < 5.0 { Some(gap) } else { None }
    };
    let ichimoku = calc_ichimoku(b);
    let williams = calc_williams(b, 14);
    let trix = calc_trix(&closes, 15);
    let supertrend = calc_supertrend(b, 10, 3.0);
    let vp = calc_volume_profile(b, 50);
    let roc10 = calc_roc(&closes, 10);
    let roc20 = calc_roc(&closes, 20);

    // ── intraday / momentum block ──
    let yesterday = if n >= 2 { closes[n - 2] } else { last_close };
    let today_open = js::or(b[n - 1].o, last_close);
    let gap_pct = if js::truthy(yesterday) { ((today_open - yesterday) / yesterday) * 100.0 } else { 0.0 };
    let gap_up = gap_pct > 1.0;
    let gap_down = gap_pct < -1.0;
    let t_open = js::or(b[n - 1].o, last_close);
    let t_high = js::or(b[n - 1].h, last_close);
    let t_low = js::or(b[n - 1].l, last_close);
    let day_hl_range = if (t_high - t_low) > 0.0 { (last_close - t_low) / (t_high - t_low) } else { 0.5 };
    let open_to_current_pct = if t_open > 0.0 { ((last_close - t_open) / t_open) * 100.0 } else { 0.0 };
    let vol_surge = if vol_ratio > 2.5 {
        "explosive"
    } else if vol_ratio > 1.8 {
        "strong"
    } else if vol_ratio > 1.3 {
        "moderate"
    } else {
        "normal"
    };
    let mom1h = if n >= 2 { ((closes[n - 1] - closes[n - 2]) / closes[n - 2]) * 100.0 } else { 0.0 };
    let mom4h = if n >= 4 { ((closes[n - 1] - closes[n - 4]) / closes[n - 4]) * 100.0 } else { mom1h };
    let mom_slope = if n < 5 {
        None
    } else {
        let recent = &closes[n - 5..];
        let mut s = 0.0;
        for x in recent {
            s += *x;
        }
        let avg = s / recent.len() as f64;
        let mut num = 0.0;
        let mut den = 0.0;
        for (i, x) in recent.iter().enumerate() {
            let k = i as f64 - 2.0;
            num += k * (*x - avg);
            den += k * k;
        }
        let slope = if den > 0.0 { (num / den) / avg * 100.0 } else { 0.0 };
        Some(MomSlope {
            value: slope,
            trend: if slope > 1.5 {
                "steep"
            } else if slope > 0.5 {
                "moderate"
            } else if slope > -0.5 {
                "gradual"
            } else if slope > -1.5 {
                "weak"
            } else {
                "declining"
            },
            is_steep: slope > 1.5,
            is_gradual: slope > 0.0 && slope <= 1.5,
            has_momentum: slope > 0.3,
        })
    };
    let (or_breakout, or_breakdown) = if n >= 2 {
        (last_close > b[n - 2].h, last_close < b[n - 2].l)
    } else {
        (false, false)
    };

    let mut ms = 0.0f64;
    if gap_up && day_hl_range > 0.5 {
        ms += 15.0;
    } else if gap_down {
        ms -= 15.0;
    }
    ms += if vol_ratio > 2.0 { 25.0 } else if vol_ratio > 1.5 { 15.0 } else { 0.0 };
    if open_to_current_pct > 0.0 {
        ms += js::min(25.0, open_to_current_pct * 5.0);
    } else {
        ms -= js::min(20.0, (open_to_current_pct * 5.0).abs());
    }
    if day_hl_range > 0.8 {
        ms += 15.0;
    } else if day_hl_range < 0.3 {
        ms -= 25.0;
    }
    let (gradual, steep, slope_v) = match &mom_slope {
        Some(m) => (m.is_gradual, m.is_steep, m.value),
        None => (false, false, f64::NAN),
    };
    if gradual && slope_v > 0.5 {
        ms += 20.0;
    } else if steep && change_pct > 3.0 {
        ms *= 0.5;
    } else if change_pct > 8.0 {
        ms *= 0.3;
    } else {
        ms += if change_pct > 0.0 { change_pct * 2.0 } else { change_pct * 0.5 };
    }
    let momentum_score = js::min(100.0, js::max(0.0, js::round(ms)));

    Indicators {
        closes, ma20, ma50, ma100, ma200, rsi, stoch_k, stoch_d, macd, macd_sig, macd_hist,
        bb_u, bb_m, bb_l, sr, mfi, obv, obv_trend, adl, adl_trend, vwap, vol_ratio,
        last_close, change, change_pct, cmf, adx, plus_di, minus_di, ttm, chandelier, candles, atr,
        wyckoff_phase, obv_div, rsi_div, spring, climax, di_conv, ichimoku, williams, trix,
        supertrend, vp, roc10, roc20, gap_pct, gap_up, gap_down, mom1h, mom4h,
        mom_intraday: open_to_current_pct, vol_surge, rel_strength: change_pct, or_breakout,
        or_breakdown, day_hl_range, open_to_current_pct, momentum_score, mom_slope,
    }
}
