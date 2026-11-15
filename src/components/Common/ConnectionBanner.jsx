/**
 * ConnectionBanner — uygulamanın sunucusuna ulaşılamıyor (v31.55).
 *
 * Kullanıcı: "PWA güncellenmedi, internet açıkken bile erişim sağlayamıyor — Wi-Fi'deyken".
 * Ölçüldü: hattın Turkcell Superonline "Güvenli İnternet" aile profili tüm *.vercel.app
 * adlarını kesiyor. Önbellekteki kabuk açıldığı için uygulama "çalışıyor ama boş" görünüyordu;
 * ne güncelleme ne veri geliyordu ve sebebi hiçbir yerde yazmıyordu. Durum main.jsx'teki
 * /version.json yoklamasından gelir (appUpdate.reportServerReach).
 */
import { useEffect, useState } from 'react';
import { REACH_EVENT, getServerReach, requestServerRecheck } from '../../utils/appUpdate.js';

export default function ConnectionBanner({ isMobile }) {
  const [state, setState] = useState(getServerReach);
  const [hidden, setHidden] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const on = (e) => {
      const next = e?.detail?.state || getServerReach();
      setState(next);
      setChecking(false);
      if (next !== 'ok') setHidden(false);
    };
    window.addEventListener(REACH_EVENT, on);
    return () => window.removeEventListener(REACH_EVENT, on);
  }, []);

  if (hidden || (state !== 'blocked' && state !== 'offline')) return null;
  const blocked = state === 'blocked';
  const retry = () => {
    setChecking(true);
    requestServerRecheck();
    // Durum değişmezse olay gelmez — düğme takılı kalmasın.
    setTimeout(() => setChecking(false), 6000);
  };

  return (
    <div role="alert" style={{
      position: 'fixed', left: 12, right: 12, top: isMobile ? 64 : 58, zIndex: 9001,
      maxWidth: 560, margin: '0 auto', display: 'flex', alignItems: 'flex-start', gap: 10,
      background: 'var(--bg4)', border: '1px solid var(--red)', borderRadius: 12,
      padding: '10px 12px', boxShadow: '0 8px 24px rgba(0,0,0,.35)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>
          {blocked ? 'Uygulamanın sunucusuna ulaşılamıyor' : 'Çevrimdışı'}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.45, marginTop: 2 }}>
          {blocked ? (
            <>
              İnternet var ama bu ağ uygulamanın adresini engelliyor olabilir. Turkcell Superonline'da
              {' '}"Güvenli İnternet" aile profili tüm <b>*.vercel.app</b> adreslerini kapatıyor. Mobil veriye
              geçin ya da hattın Güvenli İnternet profilini kapatın. Bu sürece veri ve güncelleme gelmez;
              ekrandakiler son kayıtlı veridir.
            </>
          ) : (
            'İnternet bağlantısı yok. Ekrandakiler son kayıtlı veridir; bağlantı gelince kendiliğinden yenilenir.'
          )}
        </div>
      </div>
      <button onClick={retry} disabled={checking} className="btn btn-go"
        style={{ width: 'auto', margin: 0, padding: '8px 12px', fontSize: 12.5, whiteSpace: 'nowrap' }}>
        {checking ? 'Deneniyor…' : 'Tekrar dene'}
      </button>
      <span role="button" tabIndex={0} aria-label="Kapat" onClick={() => setHidden(true)}
        onKeyDown={(e) => { if (e.key === 'Enter') setHidden(true); }}
        style={{ color: 'var(--t3)', fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: '0 2px' }}>×</span>
    </div>
  );
}
