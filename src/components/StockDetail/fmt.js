// Hisse detayı — sayı biçimleri (tr-TR: virgül ondalık, nokta binlik).

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nf = (digits) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const NF = { 0: nf(0), 1: nf(1), 2: nf(2), 3: nf(3) };

export const DASH = '—';

/** 395,96 mr · 152,3 mn · 1,24 trn — TL tutarları için. */
export function fmtBig(v, { unit = '' } = {}) {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  const tail = unit ? ` ${unit}` : '';
  if (a >= 1e12) return `${NF[2].format(v / 1e12)} trn${tail}`;
  if (a >= 1e9) return `${NF[a >= 1e11 ? 1 : 2].format(v / 1e9)} mr${tail}`;
  if (a >= 1e6) return `${NF[1].format(v / 1e6)} mn${tail}`;
  if (a >= 1e3) return `${NF[0].format(v)}${tail}`;
  if (v === 0) return `0${tail}`;
  return `${NF[a >= 100 ? 0 : 2].format(v)}${tail}`;
}

/** Eksen için kısa: 400 mr, 1,2 trn */
export function fmtAxis(v) {
  if (!isNum(v)) return '';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e12) return `${NF[a >= 1e13 ? 0 : 1].format(v / 1e12)} trn`;
  if (a >= 1e9) return `${NF[a >= 1e10 ? 0 : 1].format(v / 1e9)} mr`;
  if (a >= 1e6) return `${NF[0].format(v / 1e6)} mn`;
  return NF[0].format(v);
}

/** +%12,4 (signed) ya da %12,4 */
export function fmtPct(v, { signed = false, digits = 1 } = {}) {
  if (!isNum(v)) return DASH;
  const sign = signed ? (v > 0 ? '+' : v < 0 ? '−' : '') : (v < 0 ? '−' : '');
  return `${sign}%${NF[digits].format(Math.abs(v))}`;
}

export function fmtNum(v, digits = 2) {
  if (!isNum(v)) return DASH;
  return NF[digits].format(v);
}

export function fmtPrice(v) {
  if (!isNum(v)) return DASH;
  return NF[Math.abs(v) >= 1000 ? 1 : 2].format(v);
}

export function fmtX(v, digits = 2) {
  if (!isNum(v)) return DASH;
  return `${NF[digits].format(v)}x`;
}

/** Yeşil/kırmızı yalnız işaret anlamı taşıyınca. */
export function signTone(v) {
  if (!isNum(v) || v === 0) return 'var(--t2)';
  return v > 0 ? 'var(--green)' : 'var(--red)';
}

/** technicalSnapshot satır biçimleri */
export function fmtByType(v, fmt) {
  switch (fmt) {
    case 'price': return fmtPrice(v);
    case 'pct': return fmtPct(v, { signed: true, digits: 2 });
    case 'num1': return fmtNum(v, 1);
    case 'num2': return fmtNum(v, 2);
    case 'num3': return fmtNum(v, 3);
    case 'ratio': return fmtX(v, 2);
    case 'big': return fmtBig(v);
    case 'tl': return fmtBig(v, { unit: 'TL' });
    case 'text': return v == null ? DASH : String(v);
    default: return isNum(v) ? fmtNum(v, 2) : (v == null ? DASH : String(v));
  }
}
