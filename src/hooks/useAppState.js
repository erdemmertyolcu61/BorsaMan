import { useState, useCallback } from 'react';

const PORTFOLIO_KEY = 'bist_portfolio';
const BROKER_KEY = 'bist_broker_config';

function loadBrokerConfig() {
  try {
    const saved = localStorage.getItem(BROKER_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return { type: 'simulated', config: {} };
}

function saveBrokerConfig(cfg) {
  try { localStorage.setItem(BROKER_KEY, JSON.stringify(cfg)); } catch {}
}

function loadPortfolio() {
  const fallback = { positions: [], cash: 10000, history: [] };
  try {
    const saved = localStorage.getItem(PORTFOLIO_KEY);
    if (!saved) return fallback;
    const parsed = JSON.parse(saved);
    if (!parsed || typeof parsed !== 'object') return fallback;
    // Normalize shape — older versions may have missing or non-array fields
    return {
      positions: Array.isArray(parsed.positions) ? parsed.positions : [],
      cash: Number.isFinite(parsed.cash) ? parsed.cash : 10000,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {}
  return fallback;
}

function savePortfolio(pf) {
  try { localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(pf)); } catch {}
}

export function useAppState() {
  const [activeTab, setActiveTab] = useState('analyze');
  const [badge, setBadge] = useState({ text: 'Hazir', cls: 'ok' });
  const [logs, setLogs] = useState([{ msg: 'Sistem hazir.', cls: 'info' }]);
  const [gData, setGData] = useState(null);
  const [gInd, setGInd] = useState(null);
  const [gSig, setGSig] = useState(null);
  const [scanResults, setScanResults] = useState([]);

  // Portfolio — persisted to localStorage
  const [portfolio, setPortfolio] = useState(loadPortfolio);
  const [brokerConfig, setBrokerConfig] = useState(loadBrokerConfig);

  const updatePortfolio = useCallback((updater) => {
    setPortfolio(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      savePortfolio(next);
      return next;
    });
  }, []);

  const addToPortfolio = useCallback((symbol, entryPrice, stopLoss, target, shares, positionType = 'trade') => {
    updatePortfolio(prev => {
      const cost = shares * entryPrice;
      if (cost > prev.cash) return prev; // not enough cash
      return {
        ...prev,
        cash: prev.cash - cost,
        positions: [...prev.positions, {
          symbol, entryPrice, currentPrice: entryPrice, stopLoss, target,
          shares, status: 'open', openedAt: new Date().toISOString(), positionType,
        }],
        history: [...prev.history, {
          date: new Date().toISOString(), action: 'BUY', symbol, shares, price: entryPrice, type: positionType,
        }],
      };
    });
  }, [updatePortfolio]);

  const log = useCallback((msg, cls = '') => {
    const time = new Date().toLocaleTimeString('tr-TR');
    setLogs(prev => [...prev.slice(-50), { msg: `[${time}] ${msg}`, cls }]);
  }, []);

  return {
    activeTab, setActiveTab,
    badge, setBadge,
    logs, log,
    gData, setGData, gInd, setGInd, gSig, setGSig,
    scanResults, setScanResults,
    portfolio, updatePortfolio, addToPortfolio,
    brokerConfig, setBrokerConfig: (cfg) => { saveBrokerConfig(cfg); setBrokerConfig(cfg); },
  };
}
