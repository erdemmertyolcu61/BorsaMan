/**
 * TCMB politika faizi (v31.47). The macro panel quoted a hard-coded 50% (a
 * fallback dated 2026-04-17); TCMB's own page read 36.00% on 2026-11-08.
 * The fixture below is the real table shape (tabs, width attributes, '-' in the
 * borrowing column), trimmed to its last rows.
 */
import { describe, it, expect } from 'vitest';
import { parseTcmbRepoHtml } from '../tcmbRate.js';

const row = (d, v) => `\t\t<tr>\n\t\t\t<td width="91">${d}</td>\n\t\t\t<td width="124">-</td>\n\t\t\t<td width="122">${v}</td>\n\t\t</tr>\n`;
const TABLE = `<table><tbody>\n\t\t<tr>\n\t\t\t<td width="91">Tarih</td>\n\t\t\t<td width="124">Borç Alma</td>\n\t\t\t<td width="122">Borç Verme</td>\n\t\t</tr>\n`
  + row('12.12.2025', '38.00') + row('23.01.2026', '37.00') + row('23.10.2026', '36.00')
  + '\t</tbody>\n</table>';

describe('parseTcmbRepoHtml', () => {
  it('reads the latest decision from the bottom of the table', () => {
    expect(parseTcmbRepoHtml(TABLE)).toEqual({
      rate: 36, date: '2026-10-23', previousRate: 37, previousDate: '2026-01-23',
    });
  });

  it('does not depend on row order', () => {
    const shuffled = `<table>${row('23.10.2026', '36.00')}${row('20.05.2010', '7.00')}${row('23.01.2026', '37,00')}</table>`;
    const r = parseTcmbRepoHtml(shuffled);
    expect(r.rate).toBe(36);
    expect(r.previousRate).toBe(37);
  });

  it('returns null for a page without the table (layout change, error page)', () => {
    expect(parseTcmbRepoHtml('<html><body>Bakım çalışması</body></html>')).toBeNull();
    expect(parseTcmbRepoHtml('')).toBeNull();
    expect(parseTcmbRepoHtml(null)).toBeNull();
  });
});
