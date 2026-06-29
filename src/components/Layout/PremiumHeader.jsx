import { useState, useEffect } from 'react';
import NotificationSettings from '../Notifications/NotificationSettings.jsx';
import ProxySettings from '../Common/ProxySettings.jsx';
import MobileProfilePage from '../MobileProfile/MobileProfilePage.jsx';
import { isMarketOpen } from '../../hooks/useAIAdvisor.js';

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="icon-bell">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="icon-settings">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 20, height: 20 }}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
      <circle cx="12" cy="7" r="4"></circle>
    </svg>
  );
}

function formatClock(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { date, time };
}

export default function PremiumHeader({ badge, notifications, alertLog, advisor, livePrice, portfolio, scanHistory, onAnalyze, onTabChange }) {
  const [showNotifSettings, setShowNotifSettings] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showMobileProfile, setShowMobileProfile] = useState(false);
  const [unread, setUnread] = useState(0);
  const [now, setNow] = useState(new Date());
  const [marketOpen, setMarketOpen] = useState(isMarketOpen());

  useEffect(() => {
    const id = setInterval(() => {
      setNow(new Date());
      setMarketOpen(isMarketOpen());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const recent = notifications?.recentNotifications;
    if (recent?.length > 0) {
      const within24h = recent.filter(n => Date.now() - n.timestamp < 86400000);
      setUnread(within24h.length);
    } else {
      setUnread(0);
    }
  }, [notifications?.recentNotifications]);

  const enabled = notifications?.settings?.enabled;
  const isUnread = enabled && unread > 0;
  const { date, time } = formatClock(now);

  return (
    <>
      <header className="hdr">
        <div className="hdr-l">
          <div className="logo">
            BIST<span> · AI Trading Terminal</span>
          </div>
          {badge && (
            <div className={`badge ${badge.cls || ''}`}>{badge.text}</div>
          )}
        </div>

        <div className="hdr-r">
          {/* Desktop: bell + settings + clock */}
          <div className="hdr-desktop-only">
            {notifications && (
              <button
                className={`hdr-icon-btn ${isUnread ? 'unread' : ''}`}
                title="Bildirim Ayarları"
                onClick={() => setShowNotifSettings(true)}
                style={!enabled ? { opacity: 0.5 } : {}}
              >
                <BellIcon />
                {unread > 0 && (
                  <span style={{
                    position: 'absolute',
                    top: -6, right: -6,
                    background: 'var(--orange)',
                    color: '#000',
                    borderRadius: '50%',
                    width: 14, height: 14,
                    fontSize: 8, fontWeight: 800,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: '0 0 10px rgba(255,145,0,0.4)',
                    border: '1px solid var(--bg2)'
                  }}>
                    {unread > 9 ? '9+' : unread}
                  </span>
                )}
              </button>
            )}
            <button
              className="hdr-icon-btn"
              title="Ayarlar"
              onClick={() => setShowSettings(true)}
            >
              <SettingsIcon />
              <span style={{ marginLeft: 2 }}>AYARLAR</span>
            </button>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
              color: 'var(--t2)', marginLeft: 6,
            }}>
              <span style={{ color: marketOpen ? 'var(--green)' : 'var(--t3)', fontWeight: 700 }}>
                {marketOpen ? '● Piyasa Açık' : '○ Piyasa Kapalı'}
              </span>
              <span style={{ color: 'var(--t3)' }}>|</span>
              <span className="clock">{date} {time}</span>
            </div>
          </div>

          {/* Mobile: profile icon only */}
          <button
            className="hdr-icon-btn hdr-mobile-only"
            title="Profil"
            onClick={() => setShowMobileProfile(true)}
            style={{ position: 'relative' }}
          >
            <ProfileIcon />
            {isUnread && (
              <span style={{
                position: 'absolute',
                top: -4, right: -4,
                background: 'var(--orange)',
                borderRadius: '50%',
                width: 10, height: 10,
                boxShadow: '0 0 8px rgba(255,145,0,0.5)',
                border: '1px solid var(--bg2)',
              }} />
            )}
          </button>
        </div>
      </header>

      {showNotifSettings && (
        <NotificationSettings notifications={notifications} onClose={() => setShowNotifSettings(false)} />
      )}

      {showSettings && (
        <div
          onClick={() => setShowSettings(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
            zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg2)', border: '1px solid var(--border)',
              borderRadius: 10, padding: 20, minWidth: 420, maxWidth: 560,
              maxHeight: '80vh', overflowY: 'auto',
            }}
          >
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: 16,
            }}>
              <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 14 }}>
                AYARLAR
              </div>
              <button
                onClick={() => setShowSettings(false)}
                style={{
                  background: 'transparent', border: 'none',
                  color: 'var(--t2)', fontSize: 18, cursor: 'pointer',
                }}
              >
                ✕
              </button>
            </div>
            <ProxySettings />
          </div>
        </div>
      )}

      {showMobileProfile && (
        <MobileProfilePage
          notifications={notifications}
          portfolio={portfolio}
          onTabChange={(tab) => { setShowMobileProfile(false); onTabChange?.(tab); }}
          onClose={() => setShowMobileProfile(false)}
        />
      )}
    </>
  );
}
