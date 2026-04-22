import { useCallback, useEffect, useRef, useState } from 'react';
import { isElectron } from '../utils/proxyEngine.js';

const STORAGE_KEY = 'bist_notification_settings';

const DEFAULT_SETTINGS = {
  enabled: true,
  signals: true,
  alerts: true,
  stopLoss: true,
  targetHit: true,
  intraday: false,
  advisorPicks: true,
  minScore: 7,
  silentMode: false,
  showInApp: true,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_SETTINGS;
}

function saveSettings(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

async function requestBrowserPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

async function showBrowserNotification(n) {
  if (Notification.permission !== 'granted' && !(await requestBrowserPermission())) return null;
  const instance = new Notification(n.title, {
    body: n.body,
    icon: n.icon || '/icons/icon-192.png',
    tag: n.tag,
    requireInteraction: n.urgent || false,
    silent: n.silent || false,
  });
  instance.onclick = () => {
    window.focus();
    instance.close();
    n.onClick?.();
  };
  return instance;
}

function alertTypeName(t) {
  return {
    critical: 'KRİTİK',
    error: 'HATA',
    warning: 'UYARI',
    info: 'BİLGİ',
    success: 'BAŞARILI',
  }[t] || 'BİLDİRİM';
}

export function useNotifications() {
  const [settings, setSettings] = useState(loadSettings);
  const [isSupported, setIsSupported] = useState(false);
  const [permission, setPermission] = useState('default');
  const [recentNotifications, setRecentNotifications] = useState([]);
  const recentRef = useRef([]);
  const cooldownsRef = useRef(new Map());

  useEffect(() => {
    (async () => {
      if (isElectron()) {
        try {
          const ok = await window.electronAPI?.notifications?.isSupported?.();
          setIsSupported(ok || false);
          setPermission('electron');
        } catch {
          setIsSupported(false);
        }
      } else {
        setIsSupported('Notification' in window);
        if ('Notification' in window) setPermission(Notification.permission);
      }
    })();
  }, []);

  const updateSettings = useCallback((partial) => {
    setSettings(prev => {
      const next = { ...prev, ...partial };
      saveSettings(next);
      return next;
    });
  }, []);

  const setEnabled = useCallback((v) => updateSettings({ enabled: v }), [updateSettings]);
  const setSilentMode = useCallback((v) => updateSettings({ silentMode: v }), [updateSettings]);

  const clearHistory = useCallback(() => {
    setRecentNotifications([]);
    recentRef.current = [];
  }, []);

  const pushRecent = useCallback((n) => {
    const entry = {
      ...n,
      id: n.id || `notif-${Date.now()}`,
      timestamp: Date.now(),
    };
    recentRef.current = [entry, ...recentRef.current.slice(0, 99)];
    setRecentNotifications(recentRef.current);
  }, []);

  const checkCooldown = useCallback((key, ms = 60000) => {
    const last = cooldownsRef.current.get(key);
    if (last && Date.now() - last < ms) return true;
    cooldownsRef.current.set(key, Date.now());
    return false;
  }, []);

  const notify = useCallback(async (payload) => {
    if (!settings.enabled) return null;
    if (payload.cooldownKey && checkCooldown(payload.cooldownKey, payload.cooldownMs)) return null;

    const n = {
      id: payload.id || `${payload.type || 'info'}-${Date.now()}`,
      type: payload.type || 'info',
      title: payload.title,
      body: payload.body,
      tag: payload.tag,
      icon: payload.icon,
      silent: payload.silent || settings.silentMode,
      urgent: payload.urgent,
      data: payload.data,
      subtitle: payload.subtitle,
      timestamp: Date.now(),
    };

    try {
      if (isElectron() && window.electronAPI?.notifications) {
        await window.electronAPI.notifications.show({ ...n, silent: n.silent });
      } else if (isSupported) {
        showBrowserNotification(n);
      }
    } catch (err) {
      console.error('[Notifications] Error:', err);
    }

    if (settings.showInApp) pushRecent(n);
    return n;
  }, [settings.enabled, settings.silentMode, settings.showInApp, isSupported, pushRecent, checkCooldown]);

  const notifySignal = useCallback(async (data) => {
    if (!settings.signals || data.score < settings.minScore) return null;
    const icons = {
      strong_buy: '💚',
      strong_sell: '💔',
      buy: '🟢',
      sell: '🔴',
      watch: '👀',
    };
    return notify({
      id: `signal-${data.symbol}-${data.signal}`,
      type: 'signal',
      tag: `signal-${data.signal}`,
      title: `${icons[data.signal] || '📊'} ${data.signal?.toUpperCase()} — ${data.symbol}`,
      body: data.message || `${data.symbol}: Skor ${data.score?.toFixed(1)}, Fiyat ${data.price?.toFixed(2)} TL`,
      subtitle: data.subtitle,
      silent: settings.silentMode,
      urgent: data.score >= 8,
      cooldownKey: `signal-${data.symbol}`,
      cooldownMs: data.score >= 8 ? 300000 : 600000,
      data,
    });
  }, [settings.signals, settings.minScore, settings.silentMode, notify]);

  const notifyAlert = useCallback(async (data) => {
    if (!settings.alerts) return null;
    const icons = {
      critical: '🚨',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️',
      success: '✅',
    };
    const urgent = data.type === 'critical' || data.type === 'error';
    return notify({
      id: data.id || `alert-${Date.now()}`,
      type: 'alert',
      tag: `alert-${data.type}`,
      title: `${icons[data.type] || '🔔'} ${data.title || alertTypeName(data.type)}`,
      body: data.message || data.body,
      subtitle: data.subtitle,
      silent: settings.silentMode || data.silent,
      urgent,
      cooldownKey: data.cooldownKey,
      cooldownMs: data.cooldownMs || (urgent ? 60000 : 120000),
      data,
    });
  }, [settings.alerts, settings.silentMode, notify]);

  const notifyStopLoss = useCallback(async (data) => {
    if (!settings.stopLoss) return null;
    return notify({
      id: `stop-${data.symbol}`,
      type: 'alert',
      tag: 'stop-loss',
      title: `🛑 STOP-LOSS TETIKLANDI — ${data.symbol}`,
      body: `Fiyat ${data.price?.toFixed(2)} TL'ye düştü. Pozisyon kapatıldı.`,
      silent: false,
      urgent: true,
      cooldownKey: `stop-${data.symbol}`,
      cooldownMs: 300000,
      data,
    });
  }, [settings.stopLoss, notify]);

  const notifyTargetHit = useCallback(async (data) => {
    if (!settings.targetHit) return null;
    return notify({
      id: `target-${data.symbol}`,
      type: 'alert',
      tag: 'target-hit',
      title: `🎯 HEDEF ULASILDI — ${data.symbol}`,
      body: `Fiyat ${data.price?.toFixed(2)} TL'ye yükseldi. Kar realize edildi!`,
      silent: false,
      urgent: true,
      cooldownKey: `target-${data.symbol}`,
      cooldownMs: 300000,
      data,
    });
  }, [settings.targetHit, notify]);

  const notifyAdvisorPick = useCallback(async (pick) => {
    if (!settings.advisorPicks || pick.score < 6) return null;
    return notify({
      id: `advisor-${pick.symbol}`,
      type: 'signal',
      tag: 'advisor-pick',
      title: `⭐ AI FIRSAT — ${pick.symbol}`,
      body: `${pick.signal?.toUpperCase() || 'AL'} Sinyal! Skor: ${pick.score?.toFixed(1)}, R/R: ${pick.rr?.toFixed(1)}`,
      subtitle: pick.sector,
      silent: settings.silentMode,
      urgent: pick.score >= 8,
      cooldownKey: `advisor-${pick.symbol}`,
      cooldownMs: 600000,
      data: pick,
    });
  }, [settings.advisorPicks, settings.silentMode, notify]);

  const notifyIntraday = useCallback(async (data) => {
    if (!settings.intraday) return null;
    return notify({
      id: `intraday-${data.symbol}`,
      type: 'signal',
      tag: 'intraday',
      title: `⚡ İNTRADAY — ${data.symbol}`,
      body: data.message || `${data.signal?.toUpperCase()} Fırsatı`,
      silent: settings.silentMode,
      urgent: data.score >= 8,
      cooldownKey: `intraday-${data.symbol}`,
      cooldownMs: 180000,
      data,
    });
  }, [settings.intraday, settings.silentMode, notify]);

  const notifyPriceAlert = useCallback(async (symbol, price, direction) => {
    return notify({
      id: `price-${symbol}-${direction}`,
      type: 'alert',
      tag: `price-${direction}`,
      title: `${direction === 'up' ? '📈' : '📉'} FİYAT ALARMI — ${symbol}`,
      body: `${symbol} ${direction === 'up' ? 'yukarı' : 'aşağı'} kırıldı! ${price?.toFixed(2)} TL`,
      silent: settings.silentMode,
      urgent: false,
      cooldownKey: `price-${symbol}-${direction}`,
      cooldownMs: 300000,
      data: { symbol, price, direction },
    });
  }, [settings.silentMode, notify]);

  // Electron notification click handlers
  useEffect(() => {
    if (!isElectron()) return;
    const offClick = window.electronAPI?.notifications?.onClicked?.((n) => {
      console.log('[Notifications] Clicked:', n);
    });
    const offAction = window.electronAPI?.notifications?.onAction?.((n) => {
      console.log('[Notifications] Action:', n);
    });
    return () => {
      offClick?.();
      offAction?.();
    };
  }, []);

  const requestNotificationPermission = useCallback(async () => {
    return requestBrowserPermission();
  }, []);

  return {
    settings,
    updateSettings,
    setEnabled,
    setSilentMode,
    isSupported,
    permission,
    recentNotifications,
    clearHistory,
    notify,
    notifySignal,
    notifyAlert,
    notifyStopLoss,
    notifyTargetHit,
    notifyAdvisorPick,
    notifyIntraday,
    notifyPriceAlert,
    requestNotificationPermission,
  };
}
