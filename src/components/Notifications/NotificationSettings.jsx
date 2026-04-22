export default function NotificationSettings({ notifications, onClose }) {
  if (!notifications) return null;
  const { settings, updateSettings, isSupported } = notifications;

  if (!isSupported) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}>
        <div style={{
          background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 12, padding: 24, maxWidth: 400,
        }}>
          <h3 style={{ margin: '0 0 16px', color: 'var(--t1)' }}>🔔 Bildirim Ayarları</h3>
          <p style={{ color: 'var(--t2)', fontSize: 12 }}>
            Bu sistemde masaüstü bildirimleri desteklenmiyor. Lütfen Electron uygulamasını kullanın.
          </p>
          <button
            onClick={onClose}
            style={{
              padding: '8px 20px', background: 'var(--green)', border: 'none',
              borderRadius: 8, color: '#000', cursor: 'pointer', fontWeight: 600,
            }}
          >
            Tamam
          </button>
        </div>
      </div>
    );
  }

  const Checkbox = ({ label, field, disabled }) => (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={!!settings[field]}
          onChange={e => updateSettings({ [field]: e.target.checked })}
          disabled={disabled}
          style={{ width: 16, height: 16 }}
        />
        <span style={{ color: 'var(--t1)', fontSize: 13 }}>{label}</span>
      </label>
    </div>
  );

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 24, maxWidth: 480, width: '90%',
        maxHeight: '80vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, color: 'var(--t1)' }}>🔔 Bildirim Ayarları</h3>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--t2)', fontSize: 18, cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>

        <Checkbox label="Bildirimleri Aktif Et" field="enabled" />
        <Checkbox label="Sessiz Mod (ses çıkarma)" field="silentMode" disabled={!settings.enabled} />
        <Checkbox label="Uygulama içinde göster" field="showInApp" disabled={!settings.enabled} />

        <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '16px 0' }} />

        <Checkbox label="AL/SAT Sinyalleri" field="signals" disabled={!settings.enabled} />
        <Checkbox label="AI Advisor Fırsatları" field="advisorPicks" disabled={!settings.enabled} />
        <Checkbox label="Stop-Loss Bildirimleri" field="stopLoss" disabled={!settings.enabled} />
        <Checkbox label="Hedef Ulaşıldı Bildirimleri" field="targetHit" disabled={!settings.enabled} />
        <Checkbox label="İntraday Fırsatları" field="intraday" disabled={!settings.enabled} />

        <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '16px 0' }} />

        <div style={{ marginBottom: 16 }}>
          <label style={{ color: 'var(--t2)', fontSize: 11, marginBottom: 6, display: 'block' }}>
            Minimum Sinyal Skoru
          </label>
          <input
            type="range"
            min="5"
            max="9"
            step="0.5"
            value={settings.minScore}
            onChange={e => updateSettings({ minScore: parseFloat(e.target.value) })}
            disabled={!settings.enabled || !settings.signals}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--t3)', textAlign: 'center', marginTop: 4 }}>
            {settings.minScore.toFixed(1)}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 20px', background: 'var(--green)', border: 'none',
              borderRadius: 8, color: '#000', cursor: 'pointer', fontWeight: 600,
            }}
          >
            Kaydet
          </button>
        </div>
      </div>
    </div>
  );
}
