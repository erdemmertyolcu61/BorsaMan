import { calcATR } from './indicators.js';

export const MarketRegime = {
  TRENDING_UP: 'TRENDING_UP',
  TRENDING_DOWN: 'TRENDING_DOWN',
  VOLATILE: 'VOLATILE',
  CHOPPY: 'CHOPPY',
  QUIET: 'QUIET',
  NORMAL: 'NORMAL'
};

export function detectMarketRegime(prices, ind) {
  const n = prices.length;
  if (n < 20) return MarketRegime.NORMAL;

  const atr = ind.atr?.[ind.atr.length - 1] || 0;
  const price = ind.lastClose || prices[n - 1]?.close || 0;
  const atrPercent = price > 0 ? (atr / price) * 100 : 0;

  const adx = ind.adx || 0;
  const plusDI = ind.plusDI || 0;
  const minusDI = ind.minusDI || 0;

  const recentReturns = [];
  for (let i = Math.max(0, n - 10); i < n - 1; i++) {
    if (prices[i]?.close && prices[i + 1]?.close) {
      recentReturns.push((prices[i + 1].close - prices[i].close) / prices[i].close);
    }
  }
  const volatility = recentReturns.length > 0 
    ? recentReturns.reduce((a, b) => a + Math.abs(b), 0) / recentReturns.length 
    : 0;

  const trendStrength = Math.abs(plusDI - minusDI);

  if (adx > 30 && plusDI > minusDI) {
    return { regime: MarketRegime.TRENDING_UP, strength: adx, atrPercent, volatility };
  } else if (adx > 30 && minusDI > plusDI) {
    return { regime: MarketRegime.TRENDING_DOWN, strength: adx, atrPercent, volatility };
  } else if (atrPercent > 5) {
    return { regime: MarketRegime.VOLATILE, strength: adx, atrPercent, volatility };
  } else if (adx < 15 && atrPercent < 2) {
    return { regime: MarketRegime.QUIET, strength: adx, atrPercent, volatility };
  } else if (adx < 20) {
    return { regime: MarketRegime.CHOPPY, strength: adx, atrPercent, volatility };
  }

  return { regime: MarketRegime.NORMAL, strength: adx, atrPercent, volatility };
}

export function getAdaptiveThresholds(ind, regime) {
  const baseThresholds = {
    rsiOversold: 35,
    rsiWeakOversold: 45,
    rsiOverbought: 65,
    rsiVeryOverbought: 75,
    volumeSpike: 2.0,
    volumeExplosion: 3.0,
    volumeLow: 0.5,
    bbWidthSqueeze: 5,
    momentumThreshold: 2
  };

  const { regime: r, atrPercent, volatility } = regime || { regime: MarketRegime.NORMAL, atrPercent: 2, volatility: 0.02 };

  const volatilityMultiplier = Math.max(0.5, Math.min(2, atrPercent / 3));

  const thresholds = { ...baseThresholds };

  switch (r) {
    case MarketRegime.TRENDING_UP:
    case MarketRegime.TRENDING_DOWN:
      thresholds.rsiOversold = Math.max(25, 35 - volatilityMultiplier * 5);
      thresholds.rsiWeakOversold = Math.max(35, 45 - volatilityMultiplier * 5);
      thresholds.rsiOverbought = Math.max(60, 65 - volatilityMultiplier * 3);
      thresholds.rsiVeryOverbought = Math.max(70, 75 - volatilityMultiplier * 3);
      thresholds.volumeSpike = 1.5 + volatilityMultiplier * 0.3;
      thresholds.volumeExplosion = 2.5 + volatilityMultiplier * 0.5;
      thresholds.bbWidthSqueeze = 4;
      thresholds.momentumThreshold = 1.5;
      break;

    case MarketRegime.VOLATILE:
      thresholds.rsiOversold = Math.max(20, 30 - volatilityMultiplier * 5);
      thresholds.rsiWeakOversold = Math.max(30, 40 - volatilityMultiplier * 5);
      thresholds.rsiOverbought = Math.min(75, 70 + volatilityMultiplier * 3);
      thresholds.rsiVeryOverbought = Math.min(85, 80 + volatilityMultiplier * 5);
      thresholds.volumeSpike = 2.5 + volatilityMultiplier * 0.5;
      thresholds.volumeExplosion = 4.0 + volatilityMultiplier;
      thresholds.volumeLow = 0.3;
      thresholds.bbWidthSqueeze = 3;
      thresholds.momentumThreshold = 3;
      break;

    case MarketRegime.CHOPPY:
      thresholds.rsiOversold = Math.max(30, 40 - volatilityMultiplier * 3);
      thresholds.rsiWeakOversold = Math.max(40, 50 - volatilityMultiplier * 3);
      thresholds.rsiOverbought = Math.min(70, 60 + volatilityMultiplier * 5);
      thresholds.rsiVeryOverbought = Math.min(80, 70 + volatilityMultiplier * 5);
      thresholds.volumeSpike = 2.0 + volatilityMultiplier * 0.3;
      thresholds.volumeExplosion = 3.5 + volatilityMultiplier * 0.5;
      thresholds.bbWidthSqueeze = 6;
      thresholds.momentumThreshold = 2.5;
      break;

    case MarketRegime.QUIET:
      thresholds.rsiOversold = Math.min(40, 35 + volatilityMultiplier * 3);
      thresholds.rsiWeakOversold = Math.min(50, 45 + volatilityMultiplier * 3);
      thresholds.rsiOverbought = Math.max(60, 65 + volatilityMultiplier * 3);
      thresholds.rsiVeryOverbought = Math.max(70, 75 + volatilityMultiplier * 3);
      thresholds.volumeSpike = 1.5 + volatilityMultiplier * 0.2;
      thresholds.volumeExplosion = 2.0 + volatilityMultiplier * 0.3;
      thresholds.volumeLow = 0.7;
      thresholds.bbWidthSqueeze = 8;
      thresholds.momentumThreshold = 1;
      break;

    case MarketRegime.NORMAL:
    default:
      thresholds.rsiOversold = 35 - volatilityMultiplier * 3;
      thresholds.rsiWeakOversold = 45 - volatilityMultiplier * 3;
      thresholds.rsiOverbought = 65 + volatilityMultiplier * 3;
      thresholds.rsiVeryOverbought = 75 + volatilityMultiplier * 3;
      thresholds.volumeSpike = 2.0 + volatilityMultiplier * 0.2;
      thresholds.volumeExplosion = 3.0 + volatilityMultiplier * 0.3;
      thresholds.bbWidthSqueeze = 5;
      thresholds.momentumThreshold = 2;
      break;
  }

  return thresholds;
}

export function getRegimeIndicatorWeights(regime) {
  const weights = {
    ma: 1.0,
    rsi: 1.0,
    macd: 1.0,
    bb: 1.0,
    volume: 1.0,
    stochastic: 1.0,
    adx: 1.0,
    fibonacci: 1.0,
    // New world-class indicators
    ichimoku: 1.0,
    supertrend: 1.0,
    trix: 1.0,
    williams: 1.0,
    volumeProfile: 1.0,
    roc: 1.0,
  };

  const { regime: r } = regime || { regime: MarketRegime.NORMAL };

  switch (r) {
    case MarketRegime.TRENDING_UP:
    case MarketRegime.TRENDING_DOWN:
      weights.ma = 1.5;
      weights.macd = 1.3;
      weights.adx = 1.4;
      weights.rsi = 0.6;
      weights.bb = 0.5;
      weights.stochastic = 0.7;
      // Trend-following indicators shine
      weights.ichimoku = 1.6;
      weights.supertrend = 1.5;
      weights.trix = 1.3;
      weights.williams = 0.6;
      weights.roc = 1.3;
      weights.volumeProfile = 0.7;
      break;

    case MarketRegime.VOLATILE:
      weights.ma = 0.7;
      weights.rsi = 1.3;
      weights.bb = 1.2;
      weights.volume = 1.4;
      weights.adx = 1.2;
      weights.macd = 0.8;
      // Volatility-aware indicators
      weights.ichimoku = 0.8;
      weights.supertrend = 1.3; // ATR-based = good in volatility
      weights.trix = 0.9;
      weights.williams = 1.3;
      weights.roc = 0.7;
      weights.volumeProfile = 1.2;
      break;

    case MarketRegime.CHOPPY:
      weights.rsi = 1.5;
      weights.bb = 1.3;
      weights.ma = 0.8;
      weights.macd = 0.7;
      weights.stochastic = 1.2;
      weights.adx = 0.6;
      // Mean-reversion indicators dominate
      weights.ichimoku = 0.5; // Cloud signals unreliable in chop
      weights.supertrend = 0.6;
      weights.trix = 0.7;
      weights.williams = 1.5;
      weights.roc = 0.8;
      weights.volumeProfile = 1.4;
      break;

    case MarketRegime.QUIET:
      weights.ma = 1.2;
      weights.bb = 1.3;
      weights.rsi = 1.2;
      weights.macd = 1.0;
      weights.volume = 0.8;
      // Quiet market: squeeze-based signals
      weights.ichimoku = 0.7;
      weights.supertrend = 0.8;
      weights.trix = 1.2;
      weights.williams = 1.0;
      weights.roc = 0.6;
      weights.volumeProfile = 1.0;
      break;

    case MarketRegime.NORMAL:
    default:
      break;
  }

  return weights;
}

export function detectHiddenDivergence(prices, ind) {
  if (!prices || prices.length < 20 || !ind.rsi || ind.rsi.length < 10) {
    return null;
  }

  const rsi = ind.rsi;
  const n = rsi.length;

  const priceHighs = [];
  const priceLows = [];
  const rsiHighs = [];
  const rsiLows = [];

  for (let i = Math.max(0, n - 20); i < n; i++) {
    const priceHigh = prices[i]?.high || 0;
    const priceLow = prices[i]?.low || 0;
    const rsiVal = rsi[i];

    priceHighs.push({ val: priceHigh, idx: i });
    priceLows.push({ val: priceLow, idx: i });
    rsiHighs.push({ val: rsiVal, idx: i });
    rsiLows.push({ val: rsiVal, idx: i });
  }

  priceHighs.sort((a, b) => b.val - a.val);
  priceLows.sort((a, b) => a.val - b.val);
  rsiHighs.sort((a, b) => b.val - a.val);
  rsiLows.sort((a, b) => a.val - b.val);

  const topPriceHigh = priceHighs[0];
  const topRsiHigh = rsiHighs[0];
  if (topPriceHigh && topRsiHigh) {
    const prevPriceIdx = Math.max(0, topPriceHigh.idx - 5);
    const prevRsiIdx = Math.max(0, topRsiHigh.idx - 5);
    const prevPrice = prices[prevPriceIdx]?.high || 0;
    const prevRsi = rsi[prevRsiIdx] || 50;

    if (topPriceHigh.val > prevPrice && topRsiHigh.val < prevRsi) {
      return {
        type: 'BEARISH_HIDDEN',
        description: 'Hidden bearish divergence - trend continuation',
        confidence: 75
      };
    }
  }

  const bottomPriceLow = priceLows[0];
  const bottomRsiLow = rsiLows[0];
  if (bottomPriceLow && bottomRsiLow) {
    const prevPriceIdx = Math.max(0, bottomPriceLow.idx - 5);
    const prevRsiIdx = Math.max(0, bottomRsiLow.idx - 5);
    const prevPrice = prices[prevPriceIdx]?.low || 0;
    const prevRsi = rsi[prevRsiIdx] || 50;

    if (bottomPriceLow.val < prevPrice && bottomRsiLow.val > prevRsi) {
      return {
        type: 'BULLISH_HIDDEN',
        description: 'Hidden bullish divergence - trend continuation',
        confidence: 75
      };
    }
  }

  return null;
}
