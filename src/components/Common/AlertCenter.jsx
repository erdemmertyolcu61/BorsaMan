// AlertCenter.jsx — Tiered alert UI.
//   severity: 'critical' → intrusive modal (Stop-Loss, Target hit, Risk breach)
//   severity: 'warn'     → sticky toast
//   severity: 'info'     → transient toast (FVG created, signal triggered)
//
// Usage: mount <AlertCenter /> once at App root. Dispatch via:
//   window.dispatchEvent(new CustomEvent('bist-alert', { detail: { severity, title, message, symbol, source } }))

import { useEffect, useRef, useState, useCallback } from 'react';

const TOAST_TTL = { info: 4500, warn: 10000, critical: 0 }; // 0 = sticky/modal
const MAX_TOASTS = 5;

const COLORS = {
  info:     { bg: '#0f172a', bd: '#38bdf8', fg: '#e0f2fe', accent: '#38bdf8', icon: 'i' },
  warn:     { bg: '#1c1917', bd: '#f59e0b', fg: '#fef3c7', accent: '#fbbf24', icon: '!' },
  critical: { bg: '#450a0a', bd: '#ef4444', fg: '#fee2e2', accent: '#f87171', icon: '✕' },
};

let _uid = 0;

export default function AlertCenter() {
  const [toasts, setToasts] = useState([]);
  const [modal, setModal]   = useState(null);
  const timersRef = useRef(new Map());

  const removeToast = useCallback((id) => {
    setToasts(t => t.filter(x => x.id !== id));
    const tm = timersRef.current.get(id);
    if (tm) { clearTimeout(tm); timersRef.current.delete(id); }
  }, []);

  const push = useCallback((alert) => {
    const sev = ['info', 'warn', 'critical'].includes(alert.severity) ? alert.severity : 'info';
    const item = {
      id: ++_uid,
      severity: sev,
      title: alert.title || (sev === 'critical' ? 'KRITIK UYARI' : sev === 'warn' ? 'Uyari' : 'Bildirim'),
      message: alert.message || alert.body || '',
      symbol: alert.symbol || null,
      source: alert.source || 'system',
      ts: Date.now(),
      actions: Array.isArray(alert.actions) ? alert.actions : null,
    };

    if (sev === 'critical') {
      // Latest critical wins; queue optional
      setModal(item);
      return;
    }

    setToasts(prev => {
      const next = [item, ...prev].slice(0, MAX_TOASTS);
      return next;
    });

    const ttl = TOAST_TTL[sev];
    if (ttl > 0) {
      const tm = setTimeout(() => removeToast(item.id), ttl);
      timersRef.current.set(item.id, tm);
    }
  }, [removeToast]);

  useEffect(() => {
    const handler = (e) => push(e.detail || {});
    window.addEventListener('bist-alert', handler);
    return () => window.removeEventListener('bist-alert', handler);
  }, [push]);

  useEffect(() => () => { // unmount cleanup
    for (const tm of timersRef.current.values()) clearTimeout(tm);
    timersRef.current.clear();
  }, []);

  // ESC closes modal
  useEffect(() => {
    if (!modal) return;
    const onKey = (e) => { if (e.key === 'Escape') setModal(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);

  return (
    <>
      {/* Toast stack — bottom-right, above AlertLog */}
      <div
        aria-live="polite"
        style={{
          position: 'fixed', right: 16, bottom: 92, zIndex: 9998,
          display: 'flex', flexDirection: 'column', gap: 8,
          pointerEvents: 'none', maxWidth: 380,
        }}
      >
        {toasts.map(t => {
          const c = COLORS[t.severity];
          return (
            <div
              key={t.id}
              role="status"
              onClick={() => removeToast(t.id)}
              style={{
                pointerEvents: 'auto',
                background: c.bg,
                color: c.fg,
                border: `1px solid ${c.bd}`,
                borderLeft: `4px solid ${c.accent}`,
                borderRadius: 6,
                padding: '8px 12px',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 12,
                boxShadow: '0 6px 22px rgba(0,0,0,0.45)',
                cursor: 'pointer',
                display: 'flex', gap: 10, alignItems: 'flex-start',
              }}
            >
              <span style={{
                width: 18, height: 18, flex: '0 0 18px', borderRadius: '50%',
                background: c.accent, color: '#0b0f19',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 900, fontSize: 11,
              }}>{c.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, marginBottom: 2 }}>
                  {t.symbol ? <span style={{ color: c.accent, marginRight: 6 }}>{t.symbol}</span> : null}
                  {t.title}
                </div>
                <div style={{ opacity: 0.9, lineHeight: 1.35 }}>{t.message}</div>
                {t.source && (
                  <div style={{ marginTop: 4, fontSize: 9, opacity: 0.55, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                    {t.source}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Critical modal — intrusive, blocks interaction */}
      {modal && (
        <div
          role="alertdialog"
          aria-modal="true"
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(3, 7, 18, 0.78)',
            backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            animation: 'bistAlertFade 120ms ease-out',
          }}
        >
          <div style={{
            width: 'min(480px, 92vw)',
            background: 'linear-gradient(180deg, #450a0a 0%, #1a0505 100%)',
            border: '2px solid #ef4444',
            borderRadius: 10,
            padding: 22,
            fontFamily: 'JetBrains Mono, monospace',
            color: '#fee2e2',
            boxShadow: '0 0 60px rgba(239,68,68,0.35)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <span style={{
                width: 36, height: 36, borderRadius: '50%', background: '#ef4444',
                color: '#0b0f19', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 900, fontSize: 20,
              }}>!</span>
              <div>
                <div style={{ fontSize: 10, letterSpacing: 1.5, opacity: 0.7 }}>KRITIK</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>
                  {modal.symbol ? <span style={{ color: '#fca5a5', marginRight: 8 }}>{modal.symbol}</span> : null}
                  {modal.title}
                </div>
              </div>
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 18 }}>{modal.message}</div>
            <div style={{ fontSize: 10, opacity: 0.55, marginBottom: 16 }}>
              Kaynak: {modal.source} · {new Date(modal.ts).toLocaleTimeString('tr-TR')}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {(modal.actions || []).map((a, i) => (
                <button key={i}
                  onClick={() => { try { a.onClick?.(); } finally { setModal(null); } }}
                  style={{
                    background: a.primary ? '#ef4444' : 'transparent',
                    color: a.primary ? '#0b0f19' : '#fee2e2',
                    border: '1px solid #ef4444',
                    borderRadius: 5, padding: '7px 14px',
                    fontWeight: 700, fontFamily: 'inherit',
                    cursor: 'pointer',
                  }}>
                  {a.label}
                </button>
              ))}
              <button
                onClick={() => setModal(null)}
                style={{
                  background: '#ef4444', color: '#0b0f19',
                  border: 'none', borderRadius: 5, padding: '7px 18px',
                  fontWeight: 800, fontFamily: 'inherit', cursor: 'pointer',
                }}>
                TAMAM
              </button>
            </div>
          </div>
          <style>{`@keyframes bistAlertFade { from { opacity: 0 } to { opacity: 1 } }`}</style>
        </div>
      )}
    </>
  );
}

// Convenience dispatcher
export function pushAlert(detail) {
  try { window.dispatchEvent(new CustomEvent('bist-alert', { detail })); } catch {}
}
