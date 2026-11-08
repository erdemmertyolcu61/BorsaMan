/**
 * Hisse detayı — mali tablolar (v31.50). Satır tanımları tablo türüne göre
 * (sanayi / banka / sigorta); tek tablo bileşeni hepsini çizer. Sütunlar en
 * yeniden eskiye (İş Yatırım ile aynı yön); ilk sütun yatay kaydırmada sabit.
 */
import { useMemo, useState } from 'react';
import { fmtBig, fmtPct, fmtX, signTone } from './fmt.js';
import { singleQuarter, isFlowCode, quarterName } from '../../utils/financialStatements.js';

// tip: big (TL), pct (marj), yoy (işaretli %), x (oran)
const R = (key, label, type = 'big', opts = {}) => ({ key, label, type, ...opts });

export function incomeRows(kind) {
  if (kind === 'bank') {
    return [
      R('interestIncome', 'Faiz gelirleri'),
      R('interestExpense', 'Faiz giderleri'),
      R('netInterestIncome', 'Net faiz geliri', 'big', { strong: true }),
      R('netInterestYoY', 'Yıllık değişim', 'yoy', { sub: true }),
      R('netFees', 'Net ücret ve komisyon'),
      R('tradingPnl', 'Ticari kâr / zarar'),
      R('operatingIncome', 'Faaliyet gelirleri toplamı', 'big', { strong: true }),
      R('provisions', 'Kredi karşılık giderleri'),
      R('otherOpExpense', 'Diğer faaliyet giderleri'),
      R('netOperatingProfit', 'Net faaliyet kârı'),
      R('pretaxProfit', 'Vergi öncesi kâr'),
      R('tax', 'Vergi karşılığı'),
      R('netProfit', 'Dönem net kârı'),
      R('parentNet', 'Net kâr (grup payı)', 'big', { strong: true }),
      R('parentNetYoY', 'Yıllık değişim', 'yoy', { sub: true }),
    ];
  }
  if (kind === 'insurance') {
    return [
      R('nonLifeTechIncome', 'Hayat dışı teknik gelir'),
      R('nonLifeTechExpense', 'Hayat dışı teknik gider'),
      R('techBalance', 'Genel teknik bölüm dengesi', 'big', { strong: true }),
      R('parentNet', 'Dönem net kârı', 'big', { strong: true }),
      R('parentNetYoY', 'Yıllık değişim', 'yoy', { sub: true }),
    ];
  }
  return [
    R('revenue', 'Hasılat', 'big', { strong: true }),
    R('revenueYoY', 'Yıllık değişim', 'yoy', { sub: true }),
    R('cogs', 'Satışların maliyeti'),
    R('grossProfit', 'Brüt kâr', 'big', { strong: true }),
    R('grossMargin', 'Brüt marj', 'pct', { sub: true }),
    R('marketing', 'Pazarlama, satış, dağıtım'),
    R('gna', 'Genel yönetim giderleri'),
    R('rnd', 'Ar-Ge giderleri'),
    R('netOperatingProfit', 'Net faaliyet kârı'),
    R('depreciation', 'Amortisman'),
    R('ebitda', 'FAVÖK', 'big', { strong: true, hint: 'Brüt kâr − faaliyet giderleri + amortisman (İş Yatırım tanımı)' }),
    R('ebitdaMargin', 'FAVÖK marjı', 'pct', { sub: true }),
    R('ebitdaYoY', 'Yıllık değişim', 'yoy', { sub: true }),
    R('otherOpIncome', 'Diğer faaliyet gelirleri'),
    R('otherOpExpense', 'Diğer faaliyet giderleri'),
    R('operatingProfit', 'Esas faaliyet kârı', 'big', { strong: true }),
    R('operatingMargin', 'Faaliyet marjı', 'pct', { sub: true }),
    R('investIncome', 'Yatırım faaliyet gelirleri'),
    R('equityPickup', 'Özkaynak yöntemi kâr payı'),
    R('financeIncome', 'Finansman gelirleri'),
    R('financeExpense', 'Finansman giderleri'),
    R('pretaxProfit', 'Vergi öncesi kâr'),
    R('tax', 'Vergi'),
    R('netProfit', 'Dönem kârı'),
    R('parentNet', 'Net kâr (ana ortaklık)', 'big', { strong: true }),
    R('netMargin', 'Net marj', 'pct', { sub: true }),
    R('parentNetYoY', 'Yıllık değişim', 'yoy', { sub: true }),
    R('domesticSales', 'Yurt içi satışlar'),
    R('exportSales', 'Yurt dışı satışlar'),
  ];
}

export function balanceRows(kind) {
  const tail = [
    R('roe', 'Özkaynak kârlılığı (12A)', 'pct'),
    R('roa', 'Aktif kârlılığı (12A)', 'pct'),
  ];
  if (kind === 'bank') {
    return [
      R('totalAssets', 'Toplam aktifler', 'big', { strong: true }),
      R('cash', 'Nakit ve merkez bankası'),
      R('loans', 'Krediler'),
      R('deposits', 'Mevduat'),
      R('loanToDeposit', 'Kredi / mevduat', 'pct'),
      R('equity', 'Özkaynaklar', 'big', { strong: true }),
      R('paidCapital', 'Ödenmiş sermaye'),
      ...tail,
    ];
  }
  if (kind === 'insurance') {
    return [
      R('totalAssets', 'Toplam aktifler', 'big', { strong: true }),
      R('currentAssets', 'Cari varlıklar'),
      R('cash', 'Nakit ve benzerleri'),
      R('currentLiabilities', 'Kısa vadeli yükümlülükler'),
      R('currentRatio', 'Cari oran', 'x'),
      R('equity', 'Özsermaye', 'big', { strong: true }),
      R('paidCapital', 'Ödenmiş sermaye'),
      ...tail,
    ];
  }
  return [
    R('totalAssets', 'Toplam varlıklar', 'big', { strong: true }),
    R('currentAssets', 'Dönen varlıklar'),
    R('cash', 'Nakit ve benzerleri', 'big', { sub: true }),
    R('shortInvestments', 'Kısa vadeli finansal yatırımlar', 'big', { sub: true }),
    R('receivables', 'Ticari alacaklar', 'big', { sub: true }),
    R('inventories', 'Stoklar', 'big', { sub: true }),
    R('nonCurrentAssets', 'Duran varlıklar'),
    R('ppe', 'Maddi duran varlıklar', 'big', { sub: true }),
    R('currentLiabilities', 'Kısa vadeli yükümlülükler'),
    R('shortFinDebt', 'Kısa vadeli finansal borç', 'big', { sub: true }),
    R('tradePayables', 'Ticari borçlar', 'big', { sub: true }),
    R('longLiabilities', 'Uzun vadeli yükümlülükler'),
    R('longFinDebt', 'Uzun vadeli finansal borç', 'big', { sub: true }),
    R('finDebt', 'Toplam finansal borç'),
    R('netDebt', 'Net borç', 'big', { strong: true, hint: 'Finansal borç − nakit − kısa vadeli finansal yatırımlar (eksi = net nakit)' }),
    R('equity', 'Özkaynaklar'),
    R('parentEquity', 'Ana ortaklık özkaynağı', 'big', { strong: true }),
    R('paidCapital', 'Ödenmiş sermaye'),
    R('netFxPosition', 'Net döviz pozisyonu'),
    R('currentRatio', 'Cari oran', 'x'),
    R('debtToEquity', 'Finansal borç / özkaynak', 'x'),
    R('netDebtToEbitda', 'Net borç / FAVÖK (12A)', 'x'),
    ...tail,
  ];
}

export function cashRows() {
  return [
    R('opCashFlow', 'İşletme faaliyetlerinden nakit', 'big', { strong: true }),
    R('capex', 'Yatırım harcamaları (capex)'),
    R('investingCashFlow', 'Yatırım faaliyetlerinden nakit'),
    R('fcf', 'Serbest nakit akımı', 'big', { strong: true }),
    R('dividendsPaid', 'Ödenen temettü'),
    R('financingCashFlow', 'Finansman faaliyetlerinden nakit'),
  ];
}

function fmtCell(v, type) {
  if (type === 'pct') return fmtPct(v, { digits: 1 });
  if (type === 'yoy') return fmtPct(v, { signed: true, digits: 1 });
  if (type === 'x') return fmtX(v, 2);
  return fmtBig(v);
}

const th = {
  padding: '7px 10px', textAlign: 'right', fontWeight: 600, color: 'var(--t3)', whiteSpace: 'nowrap',
  fontSize: 11, borderBottom: '1px solid var(--border2)', background: 'var(--bg2)',
};
const stickyCol = { position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg2)' };

/**
 * @param {{rows: Array, columns: Array<object>, hideEmpty?: boolean}} props
 *   columns: buildFinancialView satırları ({ name, …değerler })
 */
export function DataTable({ rows, columns, hideEmpty = true, firstColWidth = 190 }) {
  const visible = hideEmpty
    ? rows.filter(r => columns.some(c => c[r.key] != null && c[r.key] !== 0))
    : rows;
  if (!columns.length || !visible.length) {
    return <div style={{ fontSize: 12, color: 'var(--t3)', padding: '10px 0' }}>Bu görünüm için veri yok.</div>;
  }
  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', margin: '0 -2px' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...th, ...stickyCol, zIndex: 2, textAlign: 'left', minWidth: firstColWidth }}>Kalem</th>
            {columns.map(c => <th key={c.label || c.name} style={th}>{c.name}{c.fromAnnual ? '*' : ''}</th>)}
          </tr>
        </thead>
        <tbody>
          {visible.map(r => (
            <tr key={r.key}>
              <td title={r.hint || ''} style={{
                ...stickyCol, padding: r.sub ? '4px 10px 4px 22px' : '6px 10px', whiteSpace: 'nowrap',
                color: r.sub ? 'var(--t3)' : r.strong ? 'var(--t1)' : 'var(--t2)',
                fontWeight: r.strong ? 600 : 400, fontSize: r.sub ? 11 : 12,
                borderTop: r.sub ? 'none' : '1px solid var(--border)',
              }}>
                {r.label}{r.hint ? <span style={{ color: 'var(--t3)', marginLeft: 4 }} aria-hidden="true">ⓘ</span> : null}
              </td>
              {columns.map(c => {
                const v = c[r.key];
                const tone = r.type === 'yoy' ? signTone(v) : r.strong ? 'var(--t1)' : r.sub ? 'var(--t3)' : 'var(--t2)';
                return (
                  <td key={c.label || c.name} style={{
                    padding: r.sub ? '4px 10px' : '6px 10px', textAlign: 'right', whiteSpace: 'nowrap', color: tone,
                    fontWeight: r.strong ? 600 : 400, fontSize: r.sub ? 11 : 12,
                    borderTop: r.sub ? 'none' : '1px solid var(--border)',
                  }}>{fmtCell(v, r.type)}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SECTIONS = [
  { id: 'income', label: 'Gelir tablosu', test: (c) => c.startsWith('3') },
  { id: 'balance', label: 'Bilanço', test: (c) => c.startsWith('1') || c.startsWith('2') },
  { id: 'cash', label: 'Nakit akışı ve dipnotlar', test: (c) => c.startsWith('4') },
];

export function Segmented({ options, value, onChange, size = 'md' }) {
  return (
    <div role="tablist" style={{ display: 'inline-flex', gap: 2, padding: 2, background: 'var(--bg3)', borderRadius: 9, flexWrap: 'wrap' }}>
      {options.map(o => {
        const active = o.id === value;
        return (
          <span key={o.id} role="tab" aria-selected={active} tabIndex={0}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(o.id); } }}
            style={{
              padding: size === 'sm' ? '4px 10px' : '6px 12px', borderRadius: 7, cursor: 'pointer', userSelect: 'none',
              fontSize: size === 'sm' ? 11 : 12, fontWeight: active ? 600 : 500,
              background: active ? 'var(--bg1)' : 'transparent', color: active ? 'var(--t1)' : 'var(--t2)',
            }}>{o.label}</span>
        );
      })}
    </div>
  );
}

/** İş Yatırım'ın tüm kalemleri — çeyreklik ya da kümülatif. */
export function FullStatement({ statements, labels, kind }) {
  const [section, setSection] = useState('income');
  const [mode, setMode] = useState('quarter');
  const sec = SECTIONS.find(s => s.id === section);
  const flowSection = section !== 'balance';
  const rows = useMemo(() => (statements || [])
    .filter(r => sec.test(r.code))
    .map(r => {
      const flow = isFlowCode(r.code, kind);
      const vals = {};
      for (const l of labels) vals[l] = flow && mode === 'quarter' ? singleQuarter(r.values, l) : (r.values[l] ?? null);
      return { ...r, vals };
    })
    .filter(r => labels.some(l => r.vals[l] != null && r.vals[l] !== 0)), [statements, labels, kind, mode, sec]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <Segmented options={SECTIONS} value={section} onChange={setSection} size="sm" />
        {flowSection && (
          <Segmented options={[{ id: 'quarter', label: 'Çeyreklik' }, { id: 'cum', label: 'Kümülatif' }]}
            value={mode} onChange={setMode} size="sm" />
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 8 }}>
        {rows.length} kalem · sıfır olan kalemler gizli · TL
      </div>
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 11.5, fontVariantNumeric: 'tabular-nums', minWidth: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...th, ...stickyCol, zIndex: 2, textAlign: 'left', minWidth: 220 }}>Kalem</th>
              {labels.map(l => <th key={l} style={th}>{quarterName(l)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.code}>
                <td title={r.en} style={{
                  ...stickyCol, padding: `5px 10px 5px ${10 + r.depth * 10}px`, maxWidth: 260, overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderTop: '1px solid var(--border)',
                  color: r.depth === 0 ? 'var(--t1)' : 'var(--t2)', fontWeight: r.depth === 0 ? 600 : 400,
                }}>{r.tr}</td>
                {labels.map(l => (
                  <td key={l} style={{ padding: '5px 10px', textAlign: 'right', whiteSpace: 'nowrap', borderTop: '1px solid var(--border)', color: 'var(--t2)' }}>
                    {fmtBig(r.vals[l])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
