// ============================================================
// MARKET INTEL ENGINE
// ------------------------------------------------------------
// Orchestrates the "Daily Market Intelligence" by fetching
// top news, and asking AI to search the web for expert opinions.
// ============================================================

import { fetchRss } from './NewsEngine.js';
import { DEFAULT_NEWS_SOURCES } from './marketNewsEngine.js';
import { askMarketIntel } from './gemini.js';

const CACHE_KEY = 'bist_daily_intel_cache';
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

export async function getMarketIntel(forceRefresh = false) {
  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (Date.now() - cached.ts < CACHE_TTL_MS) {
          return cached.report;
        }
      }
    } catch (e) {}
  }

  try {
    // 1. Fetch raw news from all sources (limit to top 15 per source)
    const allNews = [];
    await Promise.all(DEFAULT_NEWS_SOURCES.map(async (s) => {
      try {
        const items = await fetchRss(s.url);
        if (items) {
          allNews.push(...items.slice(0, 15).map(it => ({ ...it, source: s.name })));
        }
      } catch (err) {
        console.warn(`Failed to fetch RSS for intel: ${s.name}`, err);
      }
    }));

    // 1.5 Add KAP Disclosures for major BIST stocks
    try {
      const { fetchKAPDisclosures } = await import('./kapEngine.js');
      const majorSymbols = ['THYAO', 'TUPRS', 'EREGL', 'ASELS', 'AKBNK', 'GARAN'];
      await Promise.all(majorSymbols.map(async (sym) => {
        try {
          const discs = await fetchKAPDisclosures(sym);
          if (discs && discs.length > 0) {
            // Sadece bugunun/yakin tarihin bildirimlerini al (ilk 3)
            allNews.push(...discs.slice(0, 3).map(d => ({ 
              title: `[${sym}] ${d.title}`, 
              source: 'KAP (Kamuyu Aydinlatma Platformu)' 
            })));
          }
        } catch (e) {}
      }));
    } catch (e) {
      console.warn('Failed to inject KAP news', e);
    }

    const shuffled = allNews.sort(() => 0.5 - Math.random()).slice(0, 60);

    // 2. Ask AI (Claude) to do a web search and generate a briefing
    const report = await askMarketIntel(shuffled);

    // Cache the result (report is now a JSON object with impacts, newsMarkdown, expertMarkdown)
    if (report) {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), report }));
    }

    return report;
  } catch (error) {
    console.error('Market Intel failed:', error);
    return null;
  }
}

