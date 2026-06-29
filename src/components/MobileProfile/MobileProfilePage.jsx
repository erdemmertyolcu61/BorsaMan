import { useState } from 'react';
import ProxySettings from '../Common/ProxySettings.jsx';

function ChevronRight() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function SectionNotifications({ notifications }) {
  if (!notifications) return null;
  const { settings, updateSettings, isSupported } = notifications;

  if (!isSupported) {
    return (
      <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>
        Bu sistemde masaustu bildirimleri desteklenmiyor.
      </div>
    );
  }

  const Checkbox = ({ label, field, disabled }) => (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0',
      borderBottom: '1px solid var(--border)', cursor: 'pointer',
    }}>
      <input
        type="checkbox"
        checked={!!settings[field]}
        onChange={e => updateSettings({ [field]: e.target.checked })}
        disabled={disabled}
        style={{ width: 18, height: 18, accentColor: 'var(--green)' }}
      />
      <span style={{ color: disabled ? 'var(--t3)' : 'var(--t1)', fontSize: 14 }}>{label}</span>
    </label>
  );

  return (
    <div>
      <Checkbox label="Bildirimleri Aktif Et" field="enabled" />
      <Checkbox label="Sessiz Mod" field="silentMode" disabled={!settings.enabled} />
      <Checkbox label="AL/SAT Sinyalleri" field="signals" disabled={!settings.enabled} />
      <Checkbox label="AI Advisor Firsatlari" field="advisorPicks" disabled={!settings.enabled} />
      <Checkbox label="Stop-Loss Bildirimleri" field="stopLoss" disabled={!settings.enabled} />
      <Checkbox label="Hedef Bildirimleri" field="targetHit" disabled={!settings.enabled} />
      <Checkbox label="Intraday Firsatlari" field="intraday" disabled={!settings.enabled} />
      <div style={{ padding: '12px 0' }}>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 6 }}>
          Minimum Sinyal Skoru: {settings.minScore?.toFixed(1) || '6.5'}
        </div>
        <input
          type="range" min="5" max="9" step="0.5"
          value={settings.minScore || 6.5}
          onChange={e => updateSettings({ minScore: parseFloat(e.target.value) })}
          disabled={!settings.enabled || !settings.signals}
          style={{ width: '100%' }}
        />
      </div>
    </div>
  );
}

export default function MobileProfilePage({ notifications, portfolio, onTabChange, onClose }) {
  const [activeSection, setActiveSection] = useState(null);

  const positions = portfolio?.positions || [];
  const totalValue = positions.reduce((s, p) => s + (p.currentPrice || p.entryPrice) * p.lots, 0);

  const menuItems = [
    {
      id: 'notifications',
      icon: '🔔',
      label: 'Bildirimler',
      sublabel: notifications?.settings?.enabled ? 'Aktif' : 'Kapali',
      color: 'var(--orange)',
    },
    {
      id: 'settings',
      icon: '⚙️',
      label: 'Ayarlar',
      sublabel: 'Proxy, API anahtarlari',
      color: 'var(--cyan)',
    },
    {
      id: 'portfolio',
      icon: '💼',
      label: 'Portfoy',
      sublabel: `${positions.length} pozisyon`,
      color: 'var(--green)',
      action: () => onTabChange?.('portfolio'),
    },
  ];

  if (activeSection === 'notifications') {
    return (
      <div className="mobile-profile-overlay">
        <div className="mobile-profile-page">
          <div className="mobile-profile-header">
            <button className="mobile-profile-back" onClick={() => setActiveSection(null)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <span className="mobile-profile-title">Bildirimler</span>
            <div style={{ width: 36 }} />
          </div>
          <div className="mobile-profile-content">
            <SectionNotifications notifications={notifications} />
          </div>
        </div>
      </div>
    );
  }

  if (activeSection === 'settings') {
    return (
      <div className="mobile-profile-overlay">
        <div className="mobile-profile-page">
          <div className="mobile-profile-header">
            <button className="mobile-profile-back" onClick={() => setActiveSection(null)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <span className="mobile-profile-title">Ayarlar</span>
            <div style={{ width: 36 }} />
          </div>
          <div className="mobile-profile-content">
            <ProxySettings />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mobile-profile-overlay">
      <div className="mobile-profile-page">
        <div className="mobile-profile-header">
          <div style={{ width: 36 }} />
          <span className="mobile-profile-title">Profil</span>
          <button className="mobile-profile-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="mobile-profile-content">
          {/* Avatar area */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: '24px 0 20px', gap: 10,
          }}>
            <div style={{
              width: 64, height: 64, borderRadius: '50%',
              background: 'linear-gradient(135deg, var(--green), var(--cyan))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 28, fontWeight: 700, color: '#000',
              boxShadow: '0 0 24px rgba(0,229,255,0.25)',
            }}>
              B
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--t1)', fontFamily: 'Space Grotesk, sans-serif' }}>
              BIST Terminal
            </div>
            <div style={{
              fontSize: 12, color: 'var(--t3)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--green)', display: 'inline-block',
              }} />
              AI Trading Terminal v21
            </div>
          </div>

          {/* Portfolio summary card */}
          <div style={{
            margin: '0 16px 20px',
            padding: 16,
            background: 'var(--bg3)',
            borderRadius: 12,
            border: '1px solid var(--border)',
          }}>
            <div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Portfoy Ozeti
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--t1)', fontFamily: 'Space Grotesk' }}>
                {totalValue.toLocaleString('tr-TR', { minimumFractionDigits: 0 })} TL
              </div>
              <div style={{ fontSize: 13, color: 'var(--green)', fontWeight: 600 }}>
                {positions.length} pozisyon
              </div>
            </div>
          </div>

          {/* Menu items */}
          <div style={{ padding: '0 16px' }}>
            {menuItems.map(item => (
              <button
                key={item.id}
                onClick={() => item.action ? item.action() : setActiveSection(item.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 14,
                  width: '100%', padding: '16px 12px',
                  background: 'var(--bg3)', border: '1px solid var(--border)',
                  borderRadius: 10, marginBottom: 10,
                  cursor: 'pointer', color: 'var(--t1)',
                  fontFamily: 'inherit', fontSize: 14,
                }}
              >
                <span style={{ fontSize: 22 }}>{item.icon}</span>
                <div style={{ flex: 1, textAlign: 'left' }}>
                  <div style={{ fontWeight: 600 }}>{item.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{item.sublabel}</div>
                </div>
                <ChevronRight />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
