import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchSingle } from '../utils/fetchEngine.js';
import { getUnifiedAnalysis, genSignal } from '../utils/signals.js';
import { calcAll } from '../utils/indicators.js';
import { getStockList } from '../utils/constants.js';
import { dailyTop10Cycle, predictTomorrowTop10 } from '../utils/top10Intelligence.js';

const AGENT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SCAN_BATCH_SIZE = 20;

export function useActiveAgents(portfolio, onAlert) {
  const [agentStatus, setAgentStatus] = useState('idle');
  const [lastScan, setLastScan] = useState(null);
  const [opportunities, setOpportunities] = useState([]);
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0 });
  const [alerts, setAlerts] = useState([]);
  
  const isRunningRef = useRef(false);
  const intervalRef = useRef(null);
  const consecutiveFailuresRef = useRef(0);

  const addAlert = useCallback((type, title, message, data = {}) => {
    const alert = {
      id: Date.now(),
      type,
      title,
      message,
      data,
      timestamp: new Date()
    };
    setAlerts(prev => [alert, ...prev].slice(0, 50));
    
    // Also trigger callback if provided
    if (onAlert) {
      onAlert(alert);
    }
    
    return alert;
  }, [onAlert]);

  const scanForOpportunities = useCallback(async (symbols, batchStart) => {
    const batch = symbols.slice(batchStart, batchStart + SCAN_BATCH_SIZE);
    const results = [];
    
    for (let i = 0; i < batch.length; i++) {
      const symbol = batch[i];
      try {
        // Get historical data for signal analysis (includes price + change)
        const data = await fetchSingle(symbol, '1mo', '1d', true);
        
        if (!data || !data.prices || data.prices.length < 20) continue;
        
        const prices = data.prices;
        const last = prices[prices.length - 1];
        const prev = prices[prices.length - 2];
        if (!last || !prev || typeof last.close !== 'number' || typeof prev.close !== 'number') continue;
        
        const currentPrice = last.close;
        const currentChange = ((last.close / prev.close) - 1) * 100;
        
        const ind = calcAll(prices);
        const momScore = ind.momentumScore || 0;
        const hasMomentum = momScore >= 50 || (currentChange > 0.5 && ind.volRatio > 1.5);
        
        const signal = genSignal(ind, prices, {
          portfolio,
          allowSignal: true
        });
        
        if (!signal && !hasMomentum) continue;
        
        const score100 = signal?.score100 || 0;
        const isBuySignal = signal?.cls === 'buy' && score100 >= 40;
        const isReversal = signal?.reasons?.some(r => 
          r.t?.includes('Asiri satim') || r.t?.includes('dip') || r.t?.includes('oversold')
        );
        const isGapUp = ind.gapUp && (ind.gapPct || 0) > 1;
        const isMomentumSurge = momScore >= 60 || (ind.volumeSurge === 'explosive' || ind.volumeSurge === 'strong');
        
        if (isBuySignal || isReversal || isGapUp || isMomentumSurge || (hasMomentum && currentChange > 0)) {
          const finalScore = Math.max(
            score100,
            momScore,
            hasMomentum ? 50 : 0
          );
          
          results.push({
            symbol,
            price: currentPrice,
            change: currentChange,
            signal: signal?.signal || (hasMomentum ? 'MOMENTUM' : 'NEUTRAL'),
            cls: isBuySignal || isGapUp || isMomentumSurge ? 'buy' : (signal?.cls || 'neutral'),
            score: finalScore,
            momentumScore: momScore,
            reasons: signal?.reasons?.slice(0, 3) || (hasMomentum ? [{t: 'Hızla artıyor', c: 'var(--green)'}] : []),
            entry: signal?.entry || currentPrice,
            stop: signal?.stop || currentPrice * 0.96,
            target: signal?.target || currentPrice * 1.05,
            rr: signal?.rr || 1.5,
            momentumData: {
              gapPct: ind.gapPct,
              momentumIntraday: ind.momentumIntraday,
              volumeSurge: ind.volumeSurge,
              orBreakout: ind.orBreakout
            }
          });
        }
      } catch (e) {
        // Silently continue on individual failures
      }
    }
    
    return results;
  }, [portfolio]);

  const runAgentScan = useCallback(async () => {
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    
    setAgentStatus('scanning');
    const startTime = Date.now();
    
    try {
      // Get universe to scan - broader coverage
      const universe = getStockList('bistall');
      setScanProgress({ done: 0, total: universe.length });
      
      const allOpportunities = [];
      let batchIndex = 0;
      
      while (batchIndex < universe.length) {
        const batchResults = await scanForOpportunities(universe, batchIndex);
        allOpportunities.push(...batchResults);
        
        batchIndex += SCAN_BATCH_SIZE;
        setScanProgress({ done: Math.min(batchIndex, universe.length), total: universe.length });
        
        // Small delay between batches to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
      }
      
      // Sort by score
      allOpportunities.sort((a, b) => b.score - a.score);
      
      setOpportunities(allOpportunities.slice(0, 10));
      setLastScan(new Date());
      
      // Check for opportunities - lower threshold for alerts
      const highConf = allOpportunities.filter(o => o.score >= 50);
      
      if (highConf.length > 0) {
        const topOpp = highConf[0];
        
        addAlert(
          topOpp.cls === 'buy' ? 'opportunity' : 'warning',
          `${topOpp.cls === 'buy' ? '📈 AL' : '📉 SAT'} Fırsatı: ${topOpp.symbol}`,
          `Skor: ${topOpp.score.toFixed(0)} | Değişim: ${topOpp.change?.toFixed(1)}% | Momentum: ${topOpp.momentumScore || 0}`,
          topOpp
        );
        
        // Also dispatch custom event for notifications
        window.dispatchEvent(new CustomEvent('active-agent-opportunity', {
          detail: { opportunities: highConf }
        }));
        
        console.log(`[ActiveAgent] Found ${highConf.length} opportunities:`, highConf.map(o => `${o.symbol}(${o.score.toFixed(0)})`).join(', '));
      } else {
        console.log(`[ActiveAgent] Scan complete but no opportunities met criteria. Checked ${allOpportunities.length} candidates.`);
      }
      
      consecutiveFailuresRef.current = 0;
      
    } catch (e) {
      consecutiveFailuresRef.current++;
      console.error('[ActiveAgent] Scan failed:', e);
      
      // Alert on repeated failures
      if (consecutiveFailuresRef.current >= 3) {
        addAlert('error', 'Agent Hatası', `${consecutiveFailuresRef.current} tarama başarısız oldu`);
      }
    } finally {
      isRunningRef.current = false;
      setAgentStatus('idle');
      
      const duration = Date.now() - startTime;
      console.log(`[ActiveAgent] Scan complete in ${(duration/1000).toFixed(1)}s`);
    }
  }, [addAlert, scanForOpportunities]);

  const runTop10Prediction = useCallback(async () => {
    setAgentStatus('predicting');
    
    try {
      await dailyTop10Cycle();
      const predictions = await predictTomorrowTop10();
      
      if (predictions.length > 0) {
        const topPred = predictions[0];
        
        addAlert(
          'info',
          '🎯 Top10 Tahmini',
          `En olası: ${topPred.symbol} (${topPred.confidence}% güven)`,
          { predictions: predictions.slice(0, 3) }
        );
        
        window.dispatchEvent(new CustomEvent('active-agent-prediction', {
          detail: { predictions }
        }));
      }
    } catch (e) {
      console.error('[ActiveAgent] Top10 prediction failed:', e);
    } finally {
      setAgentStatus('idle');
    }
  }, [addAlert]);

  // Start/stop agent
  const startAgent = useCallback(() => {
    if (intervalRef.current) return;
    
    console.log('[ActiveAgent] Starting...');
    addAlert('info', 'Agent Aktif', 'Piyasa taraması başladı');
    
    // Initial scan
    runAgentScan();
    
    // Schedule periodic scans
    intervalRef.current = setInterval(() => {
      runAgentScan();
    }, AGENT_INTERVAL_MS);
    
    // Also run Top10 prediction every hour
    setInterval(() => {
      runTop10Prediction();
    }, 60 * 60 * 1000);
  }, [runAgentScan, runTop10Prediction, addAlert]);

  const stopAgent = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    console.log('[ActiveAgent] Stopped');
    addAlert('info', 'Agent Durdu', 'Piyasa taraması durduruldu');
  }, [addAlert]);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
  }, []);

  return {
    agentStatus,
    lastScan,
    opportunities,
    scanProgress,
    alerts,
    startAgent,
    stopAgent,
    runAgentScan,
    runTop10Prediction,
    clearAlerts
  };
}