import { fetchData } from '../src/utils/fetchEngine.js';
import { calcAll } from '../src/utils/indicators.js';
import { genSignal } from '../src/utils/signals.js';

async function analyzeMissing(symbol) {
  console.log(`--- Analyzing ${symbol} ---`);
  try {
    // Fetch data (today is April 17, we want to look at April 16 close)
    const data = await fetchData(symbol, '1mo', '1d', console.log);
    if (!data || !data.prices) {
      console.log(`Could not fetch data for ${symbol}`);
      return;
    }

    // We simulate "yesterday" by omitting the last bar if the market is open today,
    // or just looking at the state before today's jump.
    // However, since fetchData gives us up-to-date bars, 
    // let's look at the bar BEFORE the current one.
    const prices = data.prices;
    const yesterdayPrices = prices.slice(0, -1); 
    
    const ind = calcAll(yesterdayPrices);
    const sig = genSignal(ind, yesterdayPrices);

    console.log(`Symbol: ${symbol}`);
    console.log(`Price (Yesterday): ${ind.lastClose}`);
    console.log(`Signal: ${sig.signal}`);
    console.log(`Score: ${sig.score}`);
    console.log(`Confidence: ${sig.conf}%`);
    console.log(`Class: ${sig.cls}`);
    console.log(`Reasons:`, sig.reasons.map(r => `${r.c}: ${r.t}`));
    
    // Check specific TradesTab thresholds
    const dailyRange = sig.dailyRange || 0;
    const change = ind.changePct || 0;
    
    console.log(`Daily Range: ${dailyRange.toFixed(2)}%`);
    console.log(`Change: ${change.toFixed(2)}%`);
    
    // Simple Score calculation simulation from TradesTab Step 3
    let s = 0;
    if (dailyRange > 3.5) s += 4; else if (dailyRange > 2.5) s += 3; else if (dailyRange > 1.8) s += 2; else if (dailyRange > 1.2) s += 1;
    if (change > 2) s += 3; else if (change > 0.8) s += 2; else if (change > 0) s += 1;
    if (ind.lastRSI < 30) s += 3; else if (ind.lastRSI < 40) s += 2;
    if (ind.volRatio > 1.5) s += 2;
    if (ind.obvTrend === 'accumulation') s += 3;
    if (sig.cls === 'buy') s += 3;
    
    console.log(`Estimated TradesTab intScore: ${s}`);
    console.log(`Threshold: 8`);

  } catch (err) {
    console.error(`Error analyzing ${symbol}:`, err);
  }
}

async function run() {
  await analyzeMissing('TEHOL');
  await analyzeMissing('KONTR');
}

run();
