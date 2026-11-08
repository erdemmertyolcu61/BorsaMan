/**
 * Makroekonomik takvim (v31.48). The old "calendar" was 8 client-generated
 * events with invented forecasts. This is doviz.com's server-rendered table; the
 * fixture copies its real markup (tab divs, bold date header, td classes,
 * importance spans, "(-)" suffix, empty cells).
 */
import { describe, it, expect } from 'vitest';
import {
  parseDovizCalendarHtml, withPpkDates, nextPpkDate, selectCalendarView, PPK_DATES_2026,
} from '../econCalendar.js';
import { parseDovizCalendar } from '../../../proxy/api/proxy.js';
import { parseDovizCalendar as parseRoot } from '../../../api/proxy.js';

const row = (t, region, imp, ev, act = '', exp = '', prev = '') => `
              <tr>
                <td class="time">${t}</td>
                <td class="region">${region}</td>
                <td><span class="importance ${imp}" title="x"></span></td>
                <td>${ev}</td>
                <td>${act}</td>
                <td>${exp}</td>
                <td>${prev}</td>
              </tr>`;
const day = (label, rows) => `
                  <div class="text-center mt-8 mb-8 text-bold">${label}</div>
        <div class="table main-table calendar-table rate-list">
          <table class="sticky">
            <thead>
              <th>Saat</th><th>Ülke</th><th>Önem</th><th>Olay</th><th>Gerçekleşen</th><th>Beklenti</th><th>Önceki</th>
            </thead>${rows.join('')}
          </table></div>`;

const HTML = `
  <div id="calendar-content-0" class=""><div class="no-events">Seçtiğiniz kriterlere uygun bir olay bulunmuyor.</div></div>
  <div id="calendar-content-1" class="hide">${day('10 Kasım 2026', [
    row('10:00', 'Türkiye', 'high', 'Sanayi Üretimi  (Yıllık) (-)', '', '', '-1,9'),
  ])}</div>
  <div id="calendar-content-3" class="hide">${day('03 Kasım 2026', [
    row('10:00', 'Türkiye', 'high', 'Enflasyon Oranı (Yıllık) (-)', '%29,77', '', '%29,73'),
    row('10:00', 'Türkiye', 'low', 'Küçük Bir Veri (-)'),
    row('16:00', 'ABD', 'low', 'Önemsiz ABD Verisi (-)'),
    row('22:00', 'Arjantin', 'high', 'Sanayi Üretimi (Yıllık) (-)', '', '', '-3,2'),
  ])}${day('10 Kasım 2026', [
    row('10:00', 'Türkiye', 'high', 'Sanayi Üretimi  (Yıllık) (-)', '', '', '-1,9'),
    row('16:30', 'ABD', 'high', 'TÜFE (Yıllık) (-)', '', '%3,1', '%3,0'),
  ])}</div>`;

describe('parseDovizCalendarHtml', () => {
  it('reads date headers, rows, importance and values; drops other countries and low non-TR rows', () => {
    const ev = parseDovizCalendarHtml(HTML);
    expect(ev).toEqual([
      { d: '2026-11-03', t: '10:00', c: 'TR', imp: 'high', ev: 'Enflasyon Oranı (Yıllık)', act: '%29,77', exp: null, prev: '%29,73' },
      { d: '2026-11-03', t: '10:00', c: 'TR', imp: 'low', ev: 'Küçük Bir Veri', act: null, exp: null, prev: null },
      { d: '2026-11-10', t: '10:00', c: 'TR', imp: 'high', ev: 'Sanayi Üretimi (Yıllık)', act: null, exp: null, prev: '-1,9' },
      { d: '2026-11-10', t: '16:30', c: 'US', imp: 'high', ev: 'TÜFE (Yıllık)', act: null, exp: '%3,1', prev: '%3,0' },
    ]);
  });

  it('the proxy copies parse exactly the same', () => {
    expect(parseDovizCalendar(HTML)).toEqual(parseDovizCalendarHtml(HTML));
    expect(parseRoot(HTML)).toEqual(parseDovizCalendarHtml(HTML));
  });

  it('returns [] for a page without the table', () => {
    expect(parseDovizCalendarHtml('<html>bakım</html>')).toEqual([]);
    expect(parseDovizCalendarHtml(null)).toEqual([]);
  });
});

describe('PPK dates', () => {
  it('adds the TCMB decision day unless the feed already lists a rate decision', () => {
    const merged = withPpkDates([{ d: '2026-12-10', t: '14:00', c: 'TR', imp: 'high', ev: 'Faiz Oranı Kararı' }], ['2026-12-10', '2026-10-22']);
    expect(merged.filter(e => e.d === '2026-12-10')).toHaveLength(1);
    expect(merged.find(e => e.d === '2026-10-22').ppk).toBe(true);
  });

  it('knows the next meeting', () => {
    expect(nextPpkDate('2026-11-08')).toBe('2026-12-10');
    expect(nextPpkDate('2026-12-10')).toBe('2026-12-10');
    expect(nextPpkDate('2026-12-11')).toBeNull();
    expect(PPK_DATES_2026).toHaveLength(8);
  });
});

describe('selectCalendarView', () => {
  it('upcoming: Turkey mid+ and other countries high only; recent: released Turkey data', () => {
    const ev = withPpkDates(parseDovizCalendarHtml(HTML), ['2026-12-10']);
    const v = selectCalendarView(ev, '2026-11-08', { days: 7 });
    expect(v.upcoming.map(e => e.ev)).toEqual(['Sanayi Üretimi (Yıllık)', 'TÜFE (Yıllık)']);
    expect(v.recentTr.map(e => e.ev)).toEqual(['Enflasyon Oranı (Yıllık)']);
  });
});
