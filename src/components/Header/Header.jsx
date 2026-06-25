import { useState, useEffect } from 'react';
import { isProxyAvailable } from '../../utils/proxyEngine.js';
import ProxySettings from '../Common/ProxySettings.jsx';
import AlertLog from '../AlertLog/AlertLog.jsx';
import ScanHistoryDrawer from '../AIAdvisor/ScanHistoryDrawer.jsx';
import { NotificationSettings } from '../../hooks/useNotifications.jsx';

export default function Header({ badge, notifications, alertLog, advisor, livePrice, portfolio, scanHistory, onAnalyze }) {
  const [clock, setClock] = useState('--:--:--');
  const [mktOpen, setMktOpen] = useState(false);
  const [showProxySettings, setShowProxySettings] = useState(false);
  const [showNotificationSettings, setShowNotificationSettings] = useState(false);
  const [proxyStatus, setProxyStatus] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock(now.toLocaleTimeString('tr-TR'));
      const h = now.getHours(), d = now.getDay();
      setMktOpen(d >= 1 && d <= 5 && h >= 10 && h < 18);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setProxyStatus(isProxyAvailable() ? 'active' : 'inactive');
  }, []);

  useEffect(() => {
    if (notifications?.recentNotifications?.length > 0) {
      const last24h = notifications.recentNotifications.filter(
        n => Date.now() - n.timestamp < 24 * 60 * 60 * 1000
      );
      setUnreadCount(last24h.length);
    }
  }, [notifications?.recentNotifications]);

  return (
    <>
      <header className="hdr">
        <div className="hdr-l">
          <div className="logo">BIST<span> · AI Trading Terminal</span></div>
          <div className={`badge ${badge.cls}`}>{badge.text}</div>
        </div>
        <div className="hdr-r" style={{ display: 'flex', alignItems: 'center' }}>
          <ScanHistoryDrawer history={scanHistory} onAnalyze={onAnalyze} />
          <AlertLog alertLog={alertLog} onAnalyze={onAnalyze} advisor={advisor} livePrice={livePrice} portfolio={portfolio} />
          {notifications && (
            <button
              onClick={() => setShowNotificationSettings(true)}
              title="Bildirim Ayarları"
              style={{
                background: notifications.settings?.enabled
                  ? unreadCount > 0
                    ? 'rgba(255,152,0,0.2)'
                    : 'rgba(0,230,118,0.15)'
                  : 'rgba(100,100,100,0.15)',
                border: `1px solid ${
                  !notifications.settings?.enabled
                    ? 'var(--t3)'
                    : unreadCount > 0
                    ? 'var(--orange)'
                    : 'var(--green)'
                }`,
                borderRadius: 6,
                padding: '4px 8px',
                fontSize: 10,
                cursor: 'pointer',
                color: !notifications.settings?.enabled
                  ? 'var(--t3)'
                  : unreadCount > 0
                  ? 'var(--orange)'
                  : 'var(--green)',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                marginRight: 8,
                position: 'relative',
              }}
            >
              🔔
              {unreadCount > 0 && (
                <span style={{
                  position: 'absolute',
                  top: -4,
                  right: -4,
                  background: 'var(--orange)',
                  color: '#000',
                  borderRadius: '50%',
                  width: 16,
                  height: 16,
                  fontSize: 9,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>
          )}

          <button
            onClick={() => setShowProxySettings(true)}
            title="Sistem Ayarları & Proxy"
            style={{
              background: proxyStatus === 'active' ? 'rgba(0,255,150,0.1)' : 'rgba(255,160,0,0.1)',
              border: `1px solid ${proxyStatus === 'active' ? 'var(--green)' : 'var(--orange)'}`,
              borderRadius: 8,
              padding: '6px 12px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              color: proxyStatus === 'active' ? 'var(--green)' : 'var(--orange)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginRight: 10,
              boxShadow: proxyStatus === 'active' ? '0 2px 4px rgba(0,0,0,0.05)' : 'none',
              transition: 'all 0.2s',
            }}
            onMouseOver={e => e.currentTarget.style.filter = 'brightness(1.2)'}
            onMouseOut={e => e.currentTarget.style.filter = 'none'}
          >
            <span style={{ fontSize: 13 }}>⚙️</span> AYARLAR
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 10, color: 'var(--t2)', marginRight: 5 }}>
            <span style={{ color: mktOpen ? 'var(--green)' : 'var(--t3)', fontWeight: 600 }}>
              {mktOpen ? '● Piyasa Açık' : '○ Piyasa Kapalı'}
            </span>
            <span style={{ color: 'var(--border2)' }}>|</span>
            <span className="clock" style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700, color: 'var(--blue)' }}>{clock}</span>
          </div>
        </div>
      </header>

      {showProxySettings && (
        <ProxySettings onClose={() => setShowProxySettings(false)} />
      )}

      {showNotificationSettings && notifications && (
        <NotificationSettings onClose={() => setShowNotificationSettings(false)} />
      )}
    </>
  );
}
