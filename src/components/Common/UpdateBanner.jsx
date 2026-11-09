/**
 * UpdateBanner — yeni sürüm hazır (v31.52).
 *
 * Eskiden tarama sürerken gelen güncelleme sessizce taramanın sonuna kalıyordu;
 * kullanıcı telefonda eski sürümü görüp "güncellenmedi" diyordu. Şimdi görünür:
 *  - 'scan'  : yeni sürüm kuruldu, tarama bitince kendiliğinden yenilenecek.
 *              "Şimdi yenile" taramayı keser; yarım kalan tarama açılışta devam eder
 *              (bist_scan_in_progress).
 *  - 'stuck' : sunucuda daha yeni paket var ama service worker almadı — önbelleği
 *              temizleyip yeniden yükler.
 */
import { useEffect, useState } from 'react';
import { UPDATE_EVENT, hardRefresh } from '../../utils/appUpdate.js';

export default function UpdateBanner({ isMobile }) {
  const [state, setState] = useState(() => (typeof window !== 'undefined' ? window.__bistUpdateState || null : null));
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const on = (e) => { setState(e.detail || null); setHidden(false); };
    window.addEventListener(UPDATE_EVENT, on);
    return () => window.removeEventListener(UPDATE_EVENT, on);
  }, []);

  if (!state || hidden) return null;
  const stuck = state.mode === 'stuck';
  const act = async () => {
    setBusy(true);
    if (stuck) { hardRefresh(); return; }
    // A worker still waiting gets the nudge first; the reload then ends the scan,
    // the old worker goes idle, the new one activates and the page reloads into it.
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      reg?.waiting?.postMessage({ type: 'SKIP_WAITING' });
    } catch { /* yok */ }
    window.location.reload();
  };

  return (
    <div role="status" style={{
      position: 'fixed', left: 12, right: 12, bottom: isMobile ? 132 : 16, zIndex: 9000,
      maxWidth: 520, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 10,
      background: 'var(--bg4)', border: '1px solid var(--border2)', borderRadius: 12,
      padding: '10px 12px', boxShadow: '0 8px 24px rgba(0,0,0,.35)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>Yeni sürüm hazır</div>
        <div style={{ fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.4 }}>
          {stuck
            ? 'Telefondaki paket eski kaldı. Yenile, önbelleği temizleyip yeni sürümü yükler.'
            : 'Tarama bitince kendiliğinden yenilenecek. Şimdi yenilersen tarama açılışta devam eder.'}
        </div>
      </div>
      <button onClick={act} disabled={busy} className="btn btn-go"
        style={{ width: 'auto', margin: 0, padding: '8px 14px', fontSize: 13, whiteSpace: 'nowrap' }}>
        {busy ? 'Yenileniyor…' : stuck ? 'Yenile' : 'Şimdi yenile'}
      </button>
      <span role="button" tabIndex={0} aria-label="Kapat" onClick={() => setHidden(true)}
        onKeyDown={(e) => { if (e.key === 'Enter') setHidden(true); }}
        style={{ color: 'var(--t3)', fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: '0 2px' }}>×</span>
    </div>
  );
}
