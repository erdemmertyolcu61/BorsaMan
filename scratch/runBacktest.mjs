import { calcAll } from '../src/utils/indicators.js';
import { genSignal } from '../src/utils/signals.js';

const symbols = ['THYAO.IS', 'TUPRS.IS', 'ISCTR.IS', 'ASELS.IS', 'KCHOL.IS', 'GARAN.IS', 'BIMAS.IS', 'AKBNK.IS', 'SAHOL.IS', 'EREGL.IS'];

async function fetchYahooData(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=6mo&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const data = await res.json();
  const result = data.chart.result[0];
  const timestamps = result.timestamp;
  const quote = result.indicators.quote[0];
  
  const prices = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = quote.close[i];
    if (close !== null) {
      prices.push({
        date: new Date(timestamps[i] * 1000).toISOString(),
        open: quote.open[i] !== null ? quote.open[i] : close,
        high: quote.high[i] !== null ? quote.high[i] : close,
        low: quote.low[i] !== null ? quote.low[i] : close,
        close: close,
        volume: quote.volume[i] || 0
      });
    }
  }
  return prices;
}

async function runBacktest() {
  console.log(`BIST 30 Backtest Başlatılıyor... (Son 6 Ay)`);
  console.log(`Yeni Kurallar: Dinamik Trailing Stop (%3 kârda aktif, %2 izleyen) + %0.2 Slippage\n`);
  
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalProfitPct = 0;
  let activeTrades = 0;
  
  for (const sym of symbols) {
    try {
      const prices = await fetchYahooData(sym);
      if (prices.length < 100) continue;
      
      let inPosition = false;
      let entryPrice = 0;
      let entryDate = '';
      let initialStop = 0;
      let currentStop = 0;
      let target = 0;
      let trailingActive = false;
      let positionAge = 0;
      
      for (let i = 50; i < prices.length - 1; i++) {
        const slice = prices.slice(0, i + 1);
        const today = slice[slice.length - 1];
        const nextDay = prices[i + 1];
        
        if (inPosition) {
          positionAge++;
          // Check trailing stop logic (same as Tracker)
          const profitPct = ((today.close - entryPrice) / entryPrice) * 100;
          if (profitPct >= 3) {
            const newStop = today.close * 0.98;
            if (newStop > currentStop) {
              currentStop = newStop;
              trailingActive = true;
            }
          }
          
          // Check outcome on next day's price action (pessimistic check)
          let exitPrice = 0;
          let outcome = '';
          
          // Gap down below stop?
          if (nextDay.open <= currentStop) {
             exitPrice = nextDay.open;
             outcome = 'STOP_HIT';
          } 
          // Hit stop intraday?
          else if (nextDay.low <= currentStop) {
            exitPrice = currentStop;
            outcome = 'STOP_HIT';
          }
          // Hit target intraday?
          else if (nextDay.high >= target) {
            exitPrice = target;
            outcome = 'TARGET_HIT';
          }
          // Force close after 20 days or end of data
          else if (positionAge >= 20 || i === prices.length - 2) {
            exitPrice = nextDay.close;
            outcome = 'TIME_EXIT';
          }
          
          if (outcome) {
            const tradeProfit = ((exitPrice - entryPrice) / entryPrice) * 100;
            totalTrades++;
            totalProfitPct += tradeProfit;
            if (tradeProfit > 0) wins++;
            else losses++;
            
            inPosition = false;
          }
          
        } else {
          // Look for signals
          const ind = calcAll(slice);
          const sig = genSignal(ind, slice);
          
          // Strict AI Advisor Filter logic (Market Open Filter)
          const isBuy = sig.cls === 'buy';
          const score100 = Number(sig.score) || 0;
          const rr = Number(sig.rr) || 0;
          const momScore = ind.momentumScore || 0;
          
          const hasTraditionalSignal = isBuy && score100 >= 60 && rr >= 1.5;
          const hasMomentumBoost = isBuy && momScore >= 50 && score100 >= 55;
          
          if (hasTraditionalSignal || hasMomentumBoost) {
            // Enter position at next day's open + 0.2% slippage
            inPosition = true;
            entryPrice = nextDay.open * 1.002;
            entryDate = nextDay.date;
            initialStop = sig.stop;
            currentStop = sig.stop;
            target = sig.t1;
            trailingActive = false;
            positionAge = 0;
          }
        }
      }
    } catch (e) {
      console.log(`Failed to process ${sym}:`, e.message);
    }
  }
  
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  console.log(`=============================================`);
  console.log(`Toplam İşlem: ${totalTrades}`);
  console.log(`Başarılı (Win): ${wins}`);
  console.log(`Başarısız (Loss): ${losses}`);
  console.log(`Win-Rate: %${winRate.toFixed(2)}`);
  console.log(`Ortalama İşlem Başı Kâr: %${(totalTrades > 0 ? totalProfitPct / totalTrades : 0).toFixed(2)}`);
  console.log(`Toplam Kümülatif Kâr: %${totalProfitPct.toFixed(2)}`);
  console.log(`=============================================`);
}

runBacktest();
