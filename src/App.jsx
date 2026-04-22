import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppState } from './hooks/useAppState.js';
import { useAIAdvisor } from './hooks/useAIAdvisor.js';
import { useAlertLog } from './hooks/useAlertLog.js';
import { useLivePrices } from './hooks/useLivePrices.js';
import { useSignalTracker, setSignalNotificationHandler } from './hooks/useSignalTracker.js';
import { useNotifications } from './hooks/useNotifications.jsx';
import { useActiveAgents } from './hooks/useActiveAgents.js';
import { initTop10Intelligence, dailyTop10Cycle } from './utils/top10Intelligence.js';
import PremiumHeader from './components/Layout/PremiumHeader.jsx';
import AnalyzeTab from './components/Analyze/AnalyzeTab.jsx';
import TradesTab from './components/Trades/TradesTab.jsx';
import PortfolioTab from './components/Portfolio/PortfolioTab.jsx';
import SignalsTab from './components/Signals/SignalsTab.jsx';
import AIAdvisorPanel from './components/AIAdvisor/AIAdvisorPanel.jsx';
import AlertLog from './components/AlertLog/AlertLog.jsx';
import Tabs from './components/Tabs/Tabs.jsx';
import MobileNav from './components/MobileNav/MobileNav.jsx';
import ScanHistoryDrawer from './components/AIAdvisor/ScanHistoryDrawer.jsx';
import ActiveAgentsPanel from './components/AIAdvisor/ActiveAgentsPanel.jsx';

export default function App() {
  const state = useAppState();
  const advisor = useAIAdvisor(state.portfolio);
  const alertLog = useAlertLog(advisor);
  const signalTracker = useSignalTracker();
  const notifications = useNotifications();
  const [watchlist, setWatchlist] = useState(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('bist_watchlist') || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [intradayScan, setIntradayScan] = useState(null);
  const [scanHistory, setScanHistory] = useState([]);
  const scanningRef = useRef(false);
  const livePrice = useLivePrices(state.portfolio, state.updatePortfolio, watchlist, alertLog);

  // Update drawer results immediately when a scan completes
  useEffect(() => {
    if (!advisor.scanning && scanningRef.current && advisor.topPicks?.length > 0) {
      setScanHistory(advisor.topPicks);
    }
    scanningRef.current = advisor.scanning;
  }, [advisor.scanning, advisor.topPicks]);

  // ── Auto-run Top10 Intelligence at 18:30 (market close) ──
  const top10RanRef = useRef(false);
  const lastRunDateRef = useRef('');
  
  useEffect(() => {
    const checkAndRunTop10 = async () => {
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const hour = now.getHours();
      const minute = now.getMinutes();
      
      // Check if already ran today
      if (lastRunDateRef.current === today && top10RanRef.current) {
        return;
      }
      
      // Run at 18:30 (market close + 1 hour buffer)
      if (hour === 18 && minute >= 30 && minute <= 35) {
        if (!top10RanRef.current || lastRunDateRef.current !== today) {
          console.log('[App] Running daily Top10 Intelligence cycle...');
          try {
            await initTop10Intelligence();
            await dailyTop10Cycle();
            top10RanRef.current = true;
            lastRunDateRef.current = today;
            console.log('[App] Top10 Intelligence cycle complete');
          } catch (e) {
            console.warn('[App] Top10 cycle failed:', e);
          }
        }
      }
    };
    
    // Initial check
    checkAndRunTop10();
    
    // Check every minute
    const interval = setInterval(checkAndRunTop10, 60000);
    return () => clearInterval(interval);
  }, []);

  // Register notification handler globally for signal tracker
  useEffect(() => {
    setSignalNotificationHandler(notifications);
  }, [notifications]);

  // ── Shared callback: TradesTab scan results flow to all systems ──
  const onTradesScanComplete = useCallback((scanData) => {
    setIntradayScan(scanData);
    window.__tradesLastScan = scanData;
  }, []);

  // ── Auto-record advisor top picks into signal tracker ──
  const lastPicksRef = useRef(null);
  useEffect(() => {
    if (!advisor?.topPicks || advisor.topPicks === lastPicksRef.current) return;
    lastPicksRef.current = advisor.topPicks;
    for (const pick of advisor.topPicks) {
      if (pick.score >= 5 && pick.cls === 'buy') {
        signalTracker.recordSignal({
          symbol: pick.symbol,
          cls: pick.cls,
          signal: pick.signal,
          score: pick.score,
          conf: pick.conf,
          price: pick.price,
          entry: pick.entry,
          stop: pick.stop,
          target: pick.target,
          rr: pick.rr,
          source: 'advisor',
          sector: pick.sector,
        });

        // Desktop notification for high-score advisor picks
        if (pick.score >= 7.5) {
          notifications.notifyAdvisorPick(pick);
        }
      }
    }
  }, [advisor?.topPicks, signalTracker, notifications]);

  // ── Send notifications for new AI Advisor scan results ──
  useEffect(() => {
    const handler = (e) => {
      const { topPicks, results } = e.detail || {};

      if (results?.length > 0) {
        const eliteSignals = results.filter(r => r.score >= 8 && r.cls === 'buy');
        if (eliteSignals.length > 0) {
          const topSignal = eliteSignals.sort((a, b) => b.score - a.score)[0];
          notifications.notifySignal({
            symbol: topSignal.symbol,
            signal: topSignal.signal,
            cls: topSignal.cls,
            score: topSignal.score,
            price: topSignal.price,
            rr: topSignal.rr,
            message: `⭐ YENİ FIRSAT! ${topSignal.symbol} — ${topSignal.signal} | Skor: ${topSignal.score.toFixed(1)}`,
          });
        }
      }
    };

    window.addEventListener('advisor-scan-complete', handler);
    return () => window.removeEventListener('advisor-scan-complete', handler);
  }, [notifications]);

  // ── Record Active Agent opportunities to Signal Tracker ──
  useEffect(() => {
    const handler = (e) => {
      const { opportunities } = e.detail || {};
      if (!opportunities?.length) return;
      
      for (const opp of opportunities) {
        if (opp.score >= 40) {
          signalTracker.recordSignal({
            symbol: opp.symbol,
            cls: opp.cls,
            signal: opp.signal,
            score: opp.score,
            price: opp.price,
            entry: opp.entry,
            stop: opp.stop,
            target: opp.target,
            rr: opp.rr,
            source: 'active_agent',
            momentumScore: opp.momentumScore,
          });
        }
      }
    };

    window.addEventListener('active-agent-opportunity', handler);
    return () => window.removeEventListener('active-agent-opportunity', handler);
  }, [signalTracker]);

  // ── Send notifications for live price alerts ──
  useEffect(() => {
    if (!livePrice?.livePrices) return;

    const pos = state.portfolio?.positions?.filter(p => p.status === 'open') || [];
    for (const p of pos) {
      const lp = livePrice.livePrices[p.symbol];
      if (!lp) continue;

      if (p.stopLoss && lp.price <= p.stopLoss) {
        notifications.notifyAlert({
          type: 'critical',
          title: `🛑 STOP-LOSS — ${p.symbol}`,
          message: `Fiyat ${lp.price.toFixed(2)} TL'ye düştü! Stop: ${p.stopLoss.toFixed(2)} TL`,
          cooldownKey: `pos-stop-${p.symbol}`,
          cooldownMs: 300000,
        });
      }

      if (p.target && lp.price >= p.target) {
        notifications.notifyAlert({
          type: 'success',
          title: `🎯 HEDEF — ${p.symbol}`,
          message: `Fiyat ${lp.price.toFixed(2)} TL'ye yükseldi!`,
          cooldownKey: `pos-target-${p.symbol}`,
          cooldownMs: 300000,
        });
      }
    }
  }, [livePrice?.livePrices, state.portfolio?.positions, notifications]);

  const handleAIAnalyze = (symbol) => {
    state.setActiveTab('analyze');
    window.dispatchEvent(new CustomEvent('ai-analyze', { detail: { symbol } }));
  };

  return (
    <>
      <PremiumHeader badge={state.badge} notifications={notifications} />

      <AIAdvisorPanel
        advisor={advisor}
        addToPortfolio={state.addToPortfolio}
        portfolio={state.portfolio}
        onAnalyze={handleAIAnalyze}
      />

      <ActiveAgentsPanel
        portfolio={state.portfolio}
        onAnalyze={handleAIAnalyze}
      />

      <Tabs activeTab={state.activeTab} onTabChange={state.setActiveTab} />

      <div className={`tab-content ${state.activeTab === 'analyze' ? 'active' : ''}`}>
        <AnalyzeTab
          gData={state.gData} setGData={state.setGData}
          gInd={state.gInd} setGInd={state.setGInd}
          gSig={state.gSig} setGSig={state.setGSig}
          log={state.log} setBadge={state.setBadge}
          addToPortfolio={state.addToPortfolio}
          portfolio={state.portfolio}
          brokerConfig={state.brokerConfig}
          goToPortfolio={() => state.setActiveTab('portfolio')}
          advisorData={advisor}
          intradayScan={intradayScan}
        />
      </div>

      <div className={`tab-content ${state.activeTab === 'trades' ? 'active' : ''}`}>
        <TradesTab
          addToPortfolio={state.addToPortfolio}
          portfolio={state.portfolio}
          signalTracker={signalTracker}
          advisorData={advisor}
          onScanComplete={onTradesScanComplete}
        />
      </div>

      <div className={`tab-content ${state.activeTab === 'portfolio' ? 'active' : ''}`}>
        <PortfolioTab
          portfolio={state.portfolio}
          updatePortfolio={state.updatePortfolio}
          brokerConfig={state.brokerConfig}
          setBrokerConfig={state.setBrokerConfig}
          livePrice={livePrice}
          alertLog={alertLog}
          watchlist={watchlist}
          setWatchlist={setWatchlist}
        />
      </div>

      <div className={`tab-content ${state.activeTab === 'signals' ? 'active' : ''}`}>
        <SignalsTab
          tracker={signalTracker}
          onAnalyze={handleAIAnalyze}
        />
      </div>

      <AlertLog alertLog={alertLog} onAnalyze={handleAIAnalyze} advisor={advisor} livePrice={livePrice} portfolio={state.portfolio} />
      <ScanHistoryDrawer history={scanHistory} onAnalyze={handleAIAnalyze} />
      <MobileNav activeTab={state.activeTab} onTabChange={state.setActiveTab} />
    </>
  );
}
