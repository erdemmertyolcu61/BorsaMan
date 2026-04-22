import { useState, useEffect, useRef, useCallback } from 'react';
import { getStockList, SECTORS } from '../utils/constants.js';
import { fetchSingle, fetchFundamentals, fetchBigParaList } from '../utils/fetchEngine.js';
import { getUnifiedAnalysis, getEliteConfluence } from '../utils/signals.js';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

const SCAN_INTERVAL_GLOBAL = 25 * 60 * 1000; // 25 min for broad market
const SCAN_INTERVAL_ELITE = 5 * 60 * 1000;   // 5 min for Elite/Portfolio
const MARKET_OPEN_HOUR = 10;
const MARKET_CLOSE_HOUR = 18;
const MONITOR_KEY = 'bist_monitor_v3';
const ALERT_COOLDOWN = 60 * 60 * 1000; // 1 hour
const WATCHLIST_POLL_INTERVAL = 2 * 60 * 1000; // 2 minutes for price alerts

function isMarketHours() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getHours();
  return hour >= MARKET_OPEN_HOUR && hour < MARKET_CLOSE_HOUR;
}

function loadMonitorState() {
  try {
    const saved = localStorage.getItem(MONITOR_KEY);
    return saved ? JSON.parse(saved) : { alerts: [], eliteAlerts: [], lastScan: null, cooldowns: {} };
  } catch { return { alerts: [], eliteAlerts: [], lastScan: null, cooldowns: {} }; }
}

function saveMonitorState(state) {
  try { localStorage.setItem(MONITOR_KEY, JSON.stringify(state)); } catch {}
}

async function sendNotification(title, body, tag) {
  if (Capacitor.isNativePlatform()) {
    try {
      await LocalNotifications.schedule({
        notifications: [{ title: title || 'FIRSAT YAKALANDI', body, id: Math.floor(Math.random() * 100000), schedule: { at: new Date(Date.now() + 500) }, extra: { tag } }]
      });
    } catch(e) {}
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: '/favicon.ico', tag, requireInteraction: true });
    setTimeout(() => n.close(), 30000);
  } catch {}
}

export function useMarketMonitor(enabled, addToPortfolio, portfolio) {
  const [monitoring, setMonitoring] = useState(false);
  const [alerts, setAlerts] = useState(() => loadMonitorState().alerts.slice(-100));
  const [eliteAlerts, setEliteAlerts] = useState(() => loadMonitorState().eliteAlerts || []);
  const [lastScan, setLastScan] = useState(() => loadMonitorState().lastScan);
  const [scanning, setScanning] = useState(false);
  const [scanList, setScanList] = useState(() => loadMonitorState().scanList || 'bistall');
  const [stats, setStats] = useState({ scanned: 0, opportunities: 0, stocksDone: 0, stocksTotal: 0 });
  const [elitePicks, setElitePicks] = useState([]);
  
  const eliteIntervalRef = useRef(null);
  const globalIntervalRef = useRef(null);
  const watchlistIntervalRef = useRef(null);
  const scanningRef = useRef(false);
  const cooldownsRef = useRef(loadMonitorState().cooldowns || {});

  const addAlert = useCallback((alert, isElite = false) => {
    const time = new Date().toLocaleTimeString('tr-TR');
    const enriched = { ...alert, time, ts: Date.now() };

    if (isElite) {
      setEliteAlerts(prev => {
        const next = [enriched, ...prev].slice(0, 10);
        const state = loadMonitorState();
        state.eliteAlerts = next;
        saveMonitorState(state);
        return next;
      });
    } else {
      setAlerts(prev => {
        const next = [...prev, enriched].slice(-150);
        const state = loadMonitorState();
        state.alerts = next;
        state.lastScan = new Date().toISOString();
        saveMonitorState(state);
        return next;
      });
    }
  }, []);

  // --- ELITE INTRADAY RADAR (15m Frame) ---
  const scanEliteRadar = useCallback(async () => {
    if (scanningRef.current) return;
    
    // Fetch Macro Context (BIST100)
    let marketContext = null;
    try {
      marketContext = await fetchSingle('XU100', '3d', '15m', true);
    } catch(e) {}

    const portfolioSyms = (portfolio?.positions || []).filter(p => p.status === 'open').map(p => p.symbol);
    const eliteSyms = elitePicks.map(p => p.symbol);
    const targetStocks = [...new Set([...portfolioSyms, ...eliteSyms])].slice(0, 15);
    
    if (targetStocks.length === 0) return;

    for (const sym of targetStocks) {
      if (sym === 'XU100') continue;
      try {
        const data15m = await fetchSingle(sym, '3d', '15m', true);
        const fundamentals = await fetchFundamentals(sym);
        if (!data15m || !fundamentals) continue;

        const elite = getEliteConfluence(sym, data15m, fundamentals, marketContext);
        const key = `elite_${sym}_${elite?.type}`;
        
        if (elite && elite.isEmin && elite.confidence >= 90) {
          const last = cooldownsRef.current[key];
          if (!last || (Date.now() - last) > (ALERT_COOLDOWN / 2)) {
            cooldownsRef.current[key] = Date.now();
            const riskMsg = elite.macroRisk ? ' [MAKRO RİSK!]' : '';
            const dataMsg = elite.dataRisk ? ' [VERİ TUTARSIZLIĞI]' : '';
            const holyGrail = elite.isHolyGrail ? ' [HOLY GRAIL] ' : ' ';
            const candleMsg = elite.candleNotes ? ` | Yapı: ${elite.candleNotes}` : '';
            
            addAlert({ 
              type: elite.type, 
              msg: `EMİN++ [%${elite.confidence}] (15dk): ${sym}${holyGrail}${riskMsg}${dataMsg}${candleMsg}`, 
              symbol: sym, 
              confidence: elite.confidence, 
              isEmin: true,
              macroRisk: elite.macroRisk
            }, true);

            sendNotification(
              `ELITE SİNYAL [%${elite.confidence}]: ${sym}`, 
              `${elite.macroRisk ? 'DİKKAT: BIST100 Negatif!' : 'Wall Street Expert: ' + (elite.isHolyGrail ? 'Kutsal Kesişim Tespit Edildi.' : 'Stratejik Onay Verildi.')}`, 
              key
            );
          }
        }
      } catch (e) {}
    }
  }, [elitePicks, portfolio, addAlert]);

  // --- WATCHLIST PRICE ALERTS (BigPara) ---
  const scanWatchlistPrices = useCallback(async () => {
    try {
      const watchlist = JSON.parse(localStorage.getItem('bist_watchlist') || '[]');
      if (watchlist.length === 0) return;

      const stocks = await fetchBigParaList();
      if (!stocks) return;

      const stockMap = stocks.reduce((acc, s) => ({ ...acc, [s.symbol]: s.price }), {});

      for (const w of watchlist) {
        const last = stockMap[w.symbol];
        if (!last) continue;

        const upKey = `alert_up_${w.symbol}_${w.targetUp}`;
        const downKey = `alert_down_${w.symbol}_${w.targetDown}`;

        if (w.targetUp && last >= w.targetUp) {
          if (!cooldownsRef.current[upKey] || (Date.now() - cooldownsRef.current[upKey] > ALERT_COOLDOWN)) {
            cooldownsRef.current[upKey] = Date.now();
            addAlert({ type: 'buy', msg: `FİYAT ALARMI: ${w.symbol} hedefi geçti! Anlık: ${last.toFixed(2)} >= ${w.targetUp.toFixed(2)} TL`, symbol: w.symbol });
            sendNotification(`FİYAT ALARMI: ${w.symbol}`, `Hedef ${w.targetUp} TL geçildi! Anlık: ${last.toFixed(2)} TL`, upKey);
          }
        }
        if (w.targetDown && last <= w.targetDown) {
          if (!cooldownsRef.current[downKey] || (Date.now() - cooldownsRef.current[downKey] > ALERT_COOLDOWN)) {
            cooldownsRef.current[downKey] = Date.now();
            addAlert({ type: 'sell', msg: `FİYAT ALARMI: ${w.symbol} stop seviyesine düştü! Anlık: ${last.toFixed(2)} <= ${w.targetDown.toFixed(2)} TL`, symbol: w.symbol });
            sendNotification(`FİYAT ALARMI: ${w.symbol}`, `Stop ${w.targetDown} TL kırıldı! Anlık: ${last.toFixed(2)} TL`, downKey);
          }
        }
      }
    } catch (e) {}
  }, [addAlert]);

  // --- GLOBAL SCAN (1d Frame) ---
  const scanMarket = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);
    const stocks = getStockList(scanList);
    let scanned = 0, opportunities = 0, currentElite = [];

    setStats(prev => ({ ...prev, stocksDone: 0, stocksTotal: stocks.length }));

    for (let i = 0; i < stocks.length; i += 5) {
      const batch = stocks.slice(i, i + 5);
      await Promise.all(batch.map(async (sym) => {
        try {
          const data = await fetchSingle(sym, '6mo', '1d', true);
          if (!data || data.prices.length < 30) return;
          scanned++;
          const analysis = getUnifiedAnalysis(sym, data);
          if (!analysis) return;
          const { bestBuy, bestSell, ind } = analysis;
          
          if (bestBuy && bestBuy.confidence >= 80) {
            currentElite.push({ symbol: sym, sector: SECTORS[sym] || 'Genel', confidence: bestBuy.confidence, price: ind.lastClose, target: bestBuy.target, stop: bestBuy.stop, rr: bestBuy.rr, score: bestBuy.score });
          }

          const key = `${sym}_${bestBuy ? 'buy' : 'sell'}`;
          const last = cooldownsRef.current[key];
          if ((bestBuy || bestSell) && (!last || (Date.now() - last) > ALERT_COOLDOWN)) {
            const b = bestBuy || bestSell;
            cooldownsRef.current[key] = Date.now();
            opportunities++;
            addAlert({ type: b.direction, msg: `${b.direction.toUpperCase()} [%${b.confidence}]: ${sym} — ${ind.lastClose.toFixed(2)} TL. ${b.events[0].desc}`, symbol: sym, confidence: b.confidence });
            sendNotification(`${b.direction.toUpperCase()} [%${b.confidence}]: ${sym}`, `${ind.lastClose.toFixed(2)} TL. ${b.events[0].desc}`, key);
          }
        } catch (e) {}
      }));
      setStats(prev => ({ ...prev, stocksDone: Math.min(i + 5, stocks.length) }));
      await new Promise(r => setTimeout(r, 400));
    }
    
    currentElite.sort((a,b) => b.confidence - a.confidence);
    setElitePicks(currentElite.slice(0, 10));
    setLastScan(new Date().toISOString());
    setScanning(false);
    scanningRef.current = false;
  }, [scanList, addAlert]);

  const startMonitor = useCallback(async () => {
    if (!('Notification' in window) || Notification.permission !== 'granted') await Notification.requestPermission();
    setMonitoring(true);
    scanMarket();
    if (globalIntervalRef.current) clearInterval(globalIntervalRef.current);
    if (eliteIntervalRef.current) clearInterval(eliteIntervalRef.current);
    
    globalIntervalRef.current = window.setInterval(() => isMarketHours() && scanMarket(), SCAN_INTERVAL_GLOBAL);
    eliteIntervalRef.current = window.setInterval(() => isMarketHours() && scanEliteRadar(), SCAN_INTERVAL_ELITE);
    watchlistIntervalRef.current = window.setInterval(() => isMarketHours() && scanWatchlistPrices(), WATCHLIST_POLL_INTERVAL);
  }, [scanMarket, scanEliteRadar, scanWatchlistPrices]);

  const stopMonitor = useCallback(() => {
    setMonitoring(false);
    if (globalIntervalRef.current) clearInterval(globalIntervalRef.current);
    if (eliteIntervalRef.current) clearInterval(eliteIntervalRef.current);
    if (watchlistIntervalRef.current) clearInterval(watchlistIntervalRef.current);
  }, []);

  useEffect(() => {
    return () => { stopMonitor(); };
  }, [stopMonitor]);

  return { monitoring, scanning, alerts, eliteAlerts, lastScan, stats, scanList, setScanList, elitePicks, startMonitor, stopMonitor, clearAlerts: () => setAlerts([]), scanMarket };
}
