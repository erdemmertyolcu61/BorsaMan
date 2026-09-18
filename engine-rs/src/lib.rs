//! BIST indicator + signal engine (WebAssembly).
//!
//! ABI (all exports are plain C functions, no wasm-bindgen):
//!   eng_input_f64(count) -> *mut f64    scratch buffer JS fills with bars (o,h,l,c,v)*n
//!   eng_input_bytes(len) -> *mut u8     scratch buffer JS fills with UTF-8 JSON / text
//!   eng_calc(n) -> i32                  calcAll over the bars in the f64 buffer
//!   eng_series_ptr(id) / eng_series_len(id)   indicator series as u64 bit patterns
//!   eng_signal_begin(len) -> i32        genSignal phase 1 (opts JSON in the byte buffer)
//!   eng_signal_finish(score, len, c)    genSignal phase 2 (calibration reason in the byte buffer)
//!   eng_out_ptr() / eng_out_len()       JSON text produced by the last call
//! Series values are f64 bit patterns; JS `null` is NULL_BITS (see js.rs).

pub mod ind;
pub mod js;
pub mod json;
pub mod regime;
pub mod sig;

use core::cell::UnsafeCell;
use ind::{Bar, Chandelier, Indicators, Supertrend, Trix, VolProfile};
use json::J;

pub const ABI_VERSION: u32 = 1;
pub const SERIES_COUNT: usize = 27;

struct State {
    in_f64: Vec<f64>,
    in_bytes: Vec<u8>,
    bars: Vec<Bar>,
    ind: Option<Indicators>,
    series: Vec<Vec<u64>>,
    out: String,
    pending: Option<sig::Pending>,
}

struct Global(UnsafeCell<Option<State>>);
// wasm32 here is single threaded and JS never re-enters an export.
unsafe impl Sync for Global {}
static STATE: Global = Global(UnsafeCell::new(None));

#[allow(clippy::mut_from_ref)]
fn st() -> &'static mut State {
    unsafe {
        let slot = &mut *STATE.0.get();
        if slot.is_none() {
            *slot = Some(State {
                in_f64: Vec::new(),
                in_bytes: Vec::new(),
                bars: Vec::new(),
                ind: None,
                series: vec![Vec::new(); SERIES_COUNT],
                out: String::new(),
                pending: None,
            });
        }
        slot.as_mut().unwrap()
    }
}

fn enc(s: &[Option<f64>]) -> Vec<u64> {
    s.iter().map(|x| x.map_or(js::NULL_BITS, f64::to_bits)).collect()
}

fn enc_f(s: &[f64]) -> Vec<u64> {
    s.iter().map(|x| x.to_bits()).collect()
}

/// Everything calcAll returns that is not one of the 27 series.
pub fn indicators_json(ind: &Indicators) -> String {
    let mut j = J::new();
    j.obj();
    j.karr("sr");
    for s in &ind.sr {
        j.obj();
        j.ks("type", if s.res { "resistance" } else { "support" });
        j.kn("price", s.price);
        j.kn("idx", s.idx as f64);
        j.kn("count", s.count as f64);
        j.end_obj();
    }
    j.end_arr();
    j.kv("mfi", ind.mfi);
    j.ks("obvTrend", ind.obv_trend);
    j.ks("adlTrend", ind.adl_trend);
    j.kv("vwap", ind.vwap);
    j.kn("volRatio", ind.vol_ratio);
    j.kn("change", ind.change);
    j.kn("changePct", ind.change_pct);
    j.kv("cmf", ind.cmf);
    j.kv("adx", ind.adx);
    j.kv("plusDI", ind.plus_di);
    j.kv("minusDI", ind.minus_di);
    j.kobj("ttmSqueeze");
    j.kb("squeezeOn", ind.ttm.on);
    j.kn("squeezeCount", ind.ttm.count as f64);
    j.kn("momentum", ind.ttm.momentum);
    j.kb("firing", ind.ttm.firing);
    j.end_obj();
    j.kobj("chandelier");
    match &ind.chandelier {
        Chandelier::Short => {
            j.knull("longStop");
            j.knull("shortStop");
        }
        Chandelier::Full { long_stop, short_stop, atr } => {
            j.kn("longStop", *long_stop);
            j.kn("shortStop", *short_stop);
            j.kn("atr", *atr);
        }
    }
    j.end_obj();
    j.karr("candlePatterns");
    for c in &ind.candles {
        j.obj();
        j.ks("name", c.name);
        j.ks("type", c.kind);
        j.ks("desc", c.desc);
        j.end_obj();
    }
    j.end_arr();
    j.kv("atr", ind.atr);
    j.ks("wyckoffPhase", ind.wyckoff_phase);
    j.kso("obvDivergence", ind.obv_div);
    j.kso("rsiDivergence", ind.rsi_div);
    match &ind.spring {
        None => j.knull("wyckoffSpring"),
        Some(s) => {
            j.kobj("wyckoffSpring");
            j.ks("type", s.kind);
            j.kn("level", s.level);
            j.ks("desc", &s.desc);
            j.end_obj();
        }
    }
    match &ind.climax {
        None => j.knull("volumeClimax"),
        Some(c) => {
            j.kobj("volumeClimax");
            j.ks("type", c.kind);
            j.kn("volMultiple", c.vol_multiple);
            j.kn("priceChange", c.price_change);
            j.ks("desc", &c.desc);
            j.end_obj();
        }
    }
    match ind.di_conv {
        None => j.knull("diConvergence"),
        Some(gap) => {
            j.kobj("diConvergence");
            j.ks("type", "converging");
            j.ks("desc", "+DI ve -DI yakinlasti — trend zayifliyor");
            j.kn("gap", gap);
            j.end_obj();
        }
    }
    let ic = &ind.ichimoku;
    j.kobj("ichimoku");
    j.kv("lastTenkan", ic.last_tenkan);
    j.kv("lastKijun", ic.last_kijun);
    j.kv("lastSenkouA", ic.last_sa);
    j.kv("lastSenkouB", ic.last_sb);
    j.kso("tkCross", ic.tk_cross);
    j.kso("kumoBreakout", ic.kumo_breakout);
    j.kso("kumoTwist", ic.kumo_twist);
    j.ks("cloudPosition", ic.cloud);
    j.kv("kumoTop", ic.kumo_top);
    j.kv("kumoBottom", ic.kumo_bottom);
    j.end_obj();
    j.kobj("trix");
    match &ind.trix {
        Trix::Short => j.kb("full", false),
        Trix::Full { last, last_signal, crossover, .. } => {
            j.kb("full", true);
            j.kv("lastTRIX", *last);
            j.kv("lastSignal", *last_signal);
            j.kso("crossover", *crossover);
        }
    }
    j.end_obj();
    j.kobj("supertrend");
    match &ind.supertrend {
        Supertrend::Short => j.kb("full", false),
        Supertrend::Full { up, value, flip, .. } => {
            j.kb("full", true);
            j.ks("trend", if *up { "UP" } else { "DOWN" });
            j.kv("value", *value);
            j.kso("flip", *flip);
        }
    }
    j.end_obj();
    j.kobj("volumeProfile");
    match &ind.vp {
        VolProfile::Empty => {
            j.knull("poc");
            j.knull("valueAreaHigh");
            j.knull("valueAreaLow");
            j.karr("bins");
            j.end_arr();
        }
        VolProfile::Full { poc, vah, val, bins } => {
            j.kn("poc", *poc);
            j.kn("valueAreaHigh", *vah);
            j.kn("valueAreaLow", *val);
            j.karr("bins");
            for (price, volume) in bins {
                j.obj();
                j.kn("price", *price);
                j.kn("volume", *volume);
                j.end_obj();
            }
            j.end_arr();
        }
    }
    j.end_obj();
    j.kn("gapPct", ind.gap_pct);
    j.kb("gapUp", ind.gap_up);
    j.kb("gapDown", ind.gap_down);
    j.kn("momentum1h", ind.mom1h);
    j.kn("momentum4h", ind.mom4h);
    j.kn("momentumIntraday", ind.mom_intraday);
    j.ks("volumeSurge", ind.vol_surge);
    j.kn("relStrength", ind.rel_strength);
    j.kb("orBreakout", ind.or_breakout);
    j.kb("orBreakdown", ind.or_breakdown);
    j.kn("dayHighLowRange", ind.day_hl_range);
    j.kn("openToCurrentPct", ind.open_to_current_pct);
    j.kn("momentumScore", ind.momentum_score);
    if let Some(m) = &ind.mom_slope {
        j.kn("momentumSlope", m.value);
        j.ks("momentumTrend", m.trend);
        j.kb("forwardMomentum", m.has_momentum && m.is_gradual);
    }
    j.end_obj();
    j.finish()
}

fn series_of(ind: &Indicators) -> Vec<Vec<u64>> {
    let ic = &ind.ichimoku;
    let (trix, trix_sig) = match &ind.trix {
        Trix::Short => (Vec::new(), Vec::new()),
        Trix::Full { trix, signal, .. } => (enc_f(trix), enc(signal)),
    };
    let (st, dir) = match &ind.supertrend {
        Supertrend::Short => (Vec::new(), Vec::new()),
        Supertrend::Full { st, dir, .. } => (enc(st), enc_f(dir)),
    };
    vec![
        enc(&ind.ma20),
        enc(&ind.ma50),
        enc(&ind.ma100),
        enc(&ind.ma200),
        enc(&ind.rsi),
        enc(&ind.stoch_k),
        enc(&ind.stoch_d),
        enc(&ind.macd),
        enc(&ind.macd_sig),
        enc(&ind.macd_hist),
        enc(&ind.bb_u),
        enc(&ind.bb_m),
        enc(&ind.bb_l),
        enc_f(&ind.obv),
        enc_f(&ind.adl),
        enc(&ic.tenkan),
        enc(&ic.kijun),
        enc(&ic.senkou_a),
        enc(&ic.senkou_b),
        enc(&ic.chikou),
        enc(&ind.williams),
        trix,
        trix_sig,
        st,
        dir,
        enc(&ind.roc10),
        enc(&ind.roc20),
    ]
}

#[no_mangle]
pub extern "C" fn eng_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn eng_input_f64(count: usize) -> *mut f64 {
    let s = st();
    s.in_f64.clear();
    s.in_f64.resize(count, 0.0);
    s.in_f64.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn eng_input_bytes(len: usize) -> *mut u8 {
    let s = st();
    s.in_bytes.clear();
    s.in_bytes.resize(len, 0);
    s.in_bytes.as_mut_ptr()
}

/// calcAll over `n` bars laid out as o,h,l,c,v in the f64 input buffer.
#[no_mangle]
pub extern "C" fn eng_calc(n: usize) -> i32 {
    let s = st();
    if n == 0 || s.in_f64.len() < n * 5 {
        return -1;
    }
    s.bars = (0..n)
        .map(|i| {
            let k = i * 5;
            Bar { o: s.in_f64[k], h: s.in_f64[k + 1], l: s.in_f64[k + 2], c: s.in_f64[k + 3], v: s.in_f64[k + 4] }
        })
        .collect();
    let ind = ind::calc_all(&s.bars);
    s.series = series_of(&ind);
    s.out = indicators_json(&ind);
    s.ind = Some(ind);
    s.pending = None;
    0
}

#[no_mangle]
pub extern "C" fn eng_out_ptr() -> *const u8 {
    st().out.as_ptr()
}

#[no_mangle]
pub extern "C" fn eng_out_len() -> usize {
    st().out.len()
}

#[no_mangle]
pub extern "C" fn eng_series_ptr(id: usize) -> *const u64 {
    st().series.get(id).map_or(core::ptr::null(), |v| v.as_ptr())
}

#[no_mangle]
pub extern "C" fn eng_series_len(id: usize) -> usize {
    st().series.get(id).map_or(0, |v| v.len())
}

/// genSignal phase 1 on the bars of the last eng_calc; opts JSON in the byte buffer.
#[no_mangle]
pub extern "C" fn eng_signal_begin(len: usize) -> i32 {
    let s = st();
    let ind = match &s.ind {
        Some(i) => i,
        None => return -1,
    };
    let text = match core::str::from_utf8(&s.in_bytes[..len.min(s.in_bytes.len())]) {
        Ok(t) => t,
        Err(_) => return -2,
    };
    let opts = match json::parse(if text.is_empty() { "{}" } else { text }) {
        Some(v) => sig::parse_opts(&v),
        None => return -2,
    };
    let (pending, b) = sig::begin(&s.bars, ind, opts);
    let mut j = J::new();
    j.obj();
    j.kn("score100", b.score100);
    j.ks("cls", b.provisional);
    j.kso("regime", b.regime);
    j.end_obj();
    s.out = j.finish();
    s.pending = Some(pending);
    0
}

/// genSignal phase 2. `reason_c`: 0 = no calibration reason, 1 = bullish, 2 = bearish.
#[no_mangle]
pub extern "C" fn eng_signal_finish(score100: f64, reason_len: usize, reason_c: i32) -> i32 {
    let s = st();
    let pending = match s.pending.take() {
        Some(p) => p,
        None => return -3,
    };
    let ind = match &s.ind {
        Some(i) => i,
        None => return -1,
    };
    let reason = if reason_c == 0 || reason_len == 0 {
        None
    } else {
        let text = match core::str::from_utf8(&s.in_bytes[..reason_len.min(s.in_bytes.len())]) {
            Ok(t) => t.to_string(),
            Err(_) => return -2,
        };
        Some((text, if reason_c == 1 { sig::C::Bull } else { sig::C::Bear }))
    };
    s.out = sig::finish(&s.bars, ind, pending, score100, reason);
    0
}
