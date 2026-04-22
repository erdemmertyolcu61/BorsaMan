// Alternative BIST data sources (direct API calls instead of borsajs which requires Node.js)
// These endpoints are publicly accessible and don't require API keys

let _initialized = false;

export async function initBorsajsAdapter() {
  if (_initialized) return;
  _initialized = true;
  console.log('[BorsajsAdapter] Initialized');
}

const ASENAX_BASE = 'https://api.asenax.com/bist';

async function quickFetch(url, ms = 8000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { 
      if (!done) { done = true; reject(new Error('Timeout')); } 
    }, ms);
    fetch(url)
      .then(r => { if (!done) { done = true; clearTimeout(t); resolve(r); } })
      .catch(e => { if (!done) { done = true; clearTimeout(t); reject(e); } });
  });
}

export async function fetchBorsajsQuote(symbol) {
  await initBorsajsAdapter();
  const startTime = Date.now();
  
  try {
    const url = `${ASENAX_BASE}/get/${symbol}`;
    const r = await quickFetch(url, 8000);
    
    if (!r.ok) {
      console.warn(`[BorsajsAdapter] ${symbol} failed: ${r.status}`);
      return null;
    }
    
    const text = await r.text();
    if (!text || text.length < 10) return null;
    
    if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('<head>') || text.includes('<body>') || text.startsWith('<')) {
      console.warn('[Asenax] HTML response for', symbol, ':', text.slice(0, 80));
      return null;
    }
    
    let data;
    try {
      if (text.includes('callback') || text.includes('(')) {
        const jsonMatch = text.match(/\((.*)\)/);
        if (jsonMatch) {
          data = JSON.parse(jsonMatch[1]);
        }
      } else {
        data = JSON.parse(text);
      }
    } catch {
      return null;
    }
    
    if (!data || (!data.last && !data.close && !data.price)) {
      return null;
    }

    const result = {
      symbol: data.symbol || symbol,
      price: data.last || data.close || data.price,
      open: data.open,
      high: data.high,
      low: data.low,
      volume: data.volume,
      change: data.changePercent || data.change,
      prevClose: data.previousClose || data.close,
      date: new Date(),
      latency: Date.now() - startTime,
      source: 'asenax'
    };

    console.log(`[BorsajsAdapter] ${symbol}: ${result.price} TL [${result.latency}ms]`);
    return result;
  } catch (e) {
    console.warn(`[BorsajsAdapter] ${symbol}:`, e.message);
    return null;
  }
}

export async function fetchAsenaxList() {
  await initBorsajsAdapter();
  
  try {
    const url = `${ASENAX_BASE}/all`;
    const r = await quickFetch(url, 10000);
    
    if (!r.ok) return null;
    
    const text = await r.text();
    if (!text || text.length < 10) return null;
    
    let data;
    try {
      const jsonMatch = text.match(/\((.*)\)/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[1]);
      } else {
        data = JSON.parse(text);
      }
    } catch {
      return null;
    }
    
    if (!Array.isArray(data)) return null;
    
    return data.map(s => ({
      symbol: s.code || s.symbol,
      name: s.name,
      price: s.last || 0,
      change: s.changePercent || 0,
      volume: s.volume || 0
    })).filter(s => s.symbol);
  } catch (e) {
    console.warn('[BorsajsAdapter] List error:', e.message);
    return null;
  }
}

// Use BigPara (already integrated) as primary, this is fallback
export async function fetchWithFallback(symbol) {
  // Try BigPara first (already in fetchEngine)
  const { fetchBigParaQuote } = await import('./fetchEngine.js');
  const bigPara = await fetchBigParaQuote(symbol);
  
  if (bigPara) {
    return { ...bigPara, source: 'bigpara' };
  }
  
  // Fallback to Asenax
  const asenax = await fetchBorsajsQuote(symbol);
  if (asenax) {
    return { ...asenax, source: 'asenax' };
  }
  
  return null;
}

export const isBorsajsAvailable = () => true;