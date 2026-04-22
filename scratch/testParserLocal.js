import fetch from 'node-fetch'; // if we need it
// but node 18 has fetch natively so let's use it
// Copying parseFinancialData to test it isolated.

function normalizeTR(str) {
  return str
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/İ/g, 'i')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/Ü/g, 'u')
    .replace(/ş/g, 's').replace(/Ş/g, 's')
    .replace(/ö/g, 'o').replace(/Ö/g, 'o')
    .replace(/ç/g, 'c').replace(/Ç/g, 'c')
    .trim();
}

function parseFinancialData(rows, symbol, periodLabels) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const result = {
    symbol,
    source: 'isyatirim',
    fetchedAt: new Date().toISOString(),
    periods: periodLabels || [],
    metrics: {},
  };

  const itemMap = {
    'hasilat': 'revenue',
    'brut kar (zarar)': 'grossProfit',
    'brut kar': 'grossProfit',
    'esas faaliyet kari (zarari)': 'operatingIncome',
    'esas faaliyet kari': 'operatingIncome',
    'donem kari (zarari)': 'netIncome',
    'net donem kari': 'netIncome',
    'toplam varliklar': 'totalAssets',
    'donen varliklar': 'currentAssets',
    'nakit ve nakit benzerleri': 'cash',
    'kisa vadeli yukumlulukler': 'currentLiabilities',
    'uzun vadeli yukumlulukler': 'longTermDebt',
    'toplam yukumlulukler': 'totalLiabilities',
    'toplam ozkaynaklar': 'totalEquity',
    'odenmis sermaye': 'paidCapital',
  };

  for (const row of rows) {
    const descTr = row.itemDescTr || row.itemDesc || '';
    const normalized = normalizeTR(descTr.trim());

    let metricKey = null;
    if (itemMap[normalized]) metricKey = itemMap[normalized];
    
    if (!metricKey) {
      if (normalized.includes('hasilat') && !normalized.includes('diger') && !normalized.includes('maliyet')) {
        metricKey = result.metrics.revenue ? null : 'revenue';
      } else if (normalized.includes('brut kar') && !normalized.includes('diger')) {
        metricKey = result.metrics.grossProfit ? null : 'grossProfit';
      } else if ((normalized.includes('donem kari') || normalized.includes('net donem')) && !normalized.includes('diger') && !normalized.includes('kontrol')) {
        metricKey = result.metrics.netIncome ? null : 'netIncome';
      } else if (normalized.includes('toplam varlik') || normalized === 'varliklar toplami') {
        metricKey = result.metrics.totalAssets ? null : 'totalAssets';
      } else if (normalized.includes('donen varlik') && !normalized.includes('duran')) {
        metricKey = result.metrics.currentAssets ? null : 'currentAssets';
      } else if (normalized.includes('nakit ve nakit')) {
        metricKey = result.metrics.cash ? null : 'cash';
      } else if (normalized.includes('kisa vadeli') && (normalized.includes('yukumluluk') || normalized.includes('borc'))) {
        metricKey = result.metrics.currentLiabilities ? null : 'currentLiabilities';
      } else if (normalized.includes('toplam ozkaynak') || normalized === 'ozkaynaklar toplami') {
        metricKey = result.metrics.totalEquity ? null : 'totalEquity';
      } else if (normalized.includes('toplam yukumluluk') || normalized === 'yukumlulukler toplami') {
        metricKey = result.metrics.totalLiabilities ? null : 'totalLiabilities';
      } else if (normalized.includes('odenmis sermaye')) {
        metricKey = result.metrics.paidCapital ? null : 'paidCapital';
      } else if (normalized === 'esas faaliyet kari' || normalized.includes('esas faaliyet kar')) {
        metricKey = result.metrics.operatingIncome ? null : 'operatingIncome';
      }
    }

    if (!metricKey) continue;

    const values = {};
    for (let i = 1; i <= 4; i++) {
      const val = row['value' + i] || row['itemValue' + i] || row['Value' + i] || row['val' + i]; // CHECKING FALLBACKS
      const periodLabel = periodLabels[i - 1] || `P${i}`;
      if (val != null && val !== '' && val !== 0) {
        values[periodLabel] = typeof val === 'number' ? val : parseFloat(String(val).replace(/\./g, '').replace(',', '.')) || 0;
      }
    }
    
    // Check fallback for dates like "2025/12"
    if (Object.keys(values).length === 0) {
      for (const key of Object.keys(row)) {
        if (/^\d{4}[\/\-]\d{1,2}$/.test(key) && row[key] != null && row[key] !== '') {
          values[key] = typeof row[key] === 'number' ? row[key] : parseFloat(String(row[key]).replace(/\./g, '').replace(',', '.')) || 0;
        }
      }
    }

    if (Object.keys(values).length > 0) {
      result.metrics[metricKey] = values;
    }
  }

  const p1 = periodLabels[0] || Object.keys(result.metrics.revenue || {})[0];
  const p2 = periodLabels[1] || Object.keys(result.metrics.revenue || {})[1];

  if (p1) {
    const get = (key) => result.metrics[key]?.[p1] || 0;
    const getPrev = (key) => p2 ? (result.metrics[key]?.[p2] || 0) : 0;

    result.ratios = {
      grossMargin: get('revenue') > 0 ? (get('grossProfit') / get('revenue') * 100) : null,
      netMargin: get('revenue') > 0 ? (get('netIncome') / get('revenue') * 100) : null,
      operatingMargin: get('revenue') > 0 ? (get('operatingIncome') / get('revenue') * 100) : null,
      roe: get('totalEquity') > 0 ? (get('netIncome') / get('totalEquity') * 100) : null,
      roa: get('totalAssets') > 0 ? (get('netIncome') / get('totalAssets') * 100) : null,
      currentRatio: get('currentLiabilities') > 0 ? (get('currentAssets') / get('currentLiabilities')) : null,
      debtToEquity: get('totalEquity') > 0 ? (get('totalLiabilities') / get('totalEquity')) : null,
      revenueGrowth: getPrev('revenue') > 0 ? ((get('revenue') - getPrev('revenue')) / getPrev('revenue') * 100) : null,
    };
  }

  return result;
}

async function run() {
  const symbol = 'THYAO';
  const group = 'XI_29';
  const url = `https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/MaliTablo?companyCode=${symbol}&exchange=TRY&financialGroup=${group}&year1=2024&period1=9&year2=2024&period2=6&year3=2024&period3=3&year4=2023&period4=12`;
  
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }});
  const json = await res.json();
  const periods = ['2024/9', '2024/6', '2024/3', '2023/12'];
  const p = parseFinancialData(json.value || [], symbol, periods);
  
  if (p) {
     console.log('Metrics extracted:', Object.keys(p.metrics));
     console.log('Ratios extracted:', p.ratios);
  } else {
     console.log('Parse failed');
  }
}
run();
