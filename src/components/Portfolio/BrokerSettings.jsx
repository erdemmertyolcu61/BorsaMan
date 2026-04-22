import { BROKER_TYPES } from '../../utils/brokerEngine.js';
import ProxySettings from '../Common/ProxySettings.jsx';

const OPTIONS = [
  { id: BROKER_TYPES.SIMULATED, label: 'Simülasyon', icon: '🛠️' },
  { id: BROKER_TYPES.MIDAS_MANUAL, label: 'Midas (Köprü)', icon: '📱' },
  { id: BROKER_TYPES.WEBHOOK, label: 'Webhook', icon: '🔗' },
];

export default function BrokerSettings({ brokerConfig, setBrokerConfig }) {
  const cfg = brokerConfig || {};
  const type = cfg.type || BROKER_TYPES.SIMULATED;

  const setType = (t) => setBrokerConfig({ ...cfg, type: t });
  const setConfigField = (k, v) =>
    setBrokerConfig({ ...cfg, config: { ...cfg.config, [k]: v } });

  return (
    <div style={{
      padding: 16, background: 'var(--bg3)',
      borderRadius: 8, border: '1px solid var(--border)',
      marginTop: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <div className="dot yellow" />
        <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 14 }}>
          ARACI KURUM BAĞLANTISI
        </div>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
        gap: 10,
        marginBottom: 20,
      }}>
        {OPTIONS.map(o => (
          <button
            key={o.id}
            onClick={() => setType(o.id)}
            style={{
              padding: '12px 8px',
              background: type === o.id ? 'var(--bg4)' : 'var(--bg2)',
              border: type === o.id ? '1px solid var(--cyan)' : '1px solid var(--border)',
              borderRadius: 6, cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
              transition: 'all 0.2s',
            }}
          >
            <span style={{ fontSize: 18 }}>{o.icon}</span>
            <span style={{
              fontSize: 9, fontWeight: 700,
              color: type === o.id ? 'var(--cyan)' : 'var(--t2)',
              textTransform: 'uppercase',
            }}>
              {o.label}
            </span>
          </button>
        ))}
      </div>

      <div style={{ padding: 12, background: 'rgba(0,0,0,0.2)', borderRadius: 6 }}>
        {type === BROKER_TYPES.SIMULATED && (
          <div style={{ fontSize: 10, color: 'var(--t3)', lineHeight: 1.5 }}>
            Varsayılan simülasyon modu. İşlemler anında sanal portföyünüze eklenir.
            Herhangi bir gerçek işlem yapılmaz.
          </div>
        )}
        {type === BROKER_TYPES.MIDAS_MANUAL && (
          <div style={{ fontSize: 10, color: 'var(--t3)', lineHeight: 1.5 }}>
            <b>Midas Karar Destek Modu:</b> Terminal size işlem detaylarını sunar,
            siz telefonunuzdan işlemi tamamladıktan sonra sistem portföyünüzü günceller.
          </div>
        )}
        {type === BROKER_TYPES.WEBHOOK && (
          <div>
            <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 10 }}>
              İşlem detaylarını belirttiğiniz URL'e POST isteği olarak gönderir.
              Kendi botlarınızı bağlamak için uygundur.
            </div>
            <label className="lbl">Destek URL (Webhook)</label>
            <input
              className="inp"
              style={{ fontSize: 11, padding: 8 }}
              value={cfg.config?.webhookUrl || ''}
              onChange={e => setConfigField('webhookUrl', e.target.value)}
              placeholder="https://your-bot.com/api/trade"
            />
          </div>
        )}
      </div>

      <div style={{ marginTop: 15, fontSize: 8, color: 'var(--t3)', textAlign: 'right' }}>
        Bağlantı Türü:{' '}
        <b style={{ color: 'var(--cyan)', textTransform: 'uppercase' }}>
          {type.replace('_', ' ')}
        </b>
      </div>

      <ProxySettings />
    </div>
  );
}
