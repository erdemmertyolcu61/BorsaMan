import { useState, useEffect } from 'react';
import { PROXY_BASE_URL, setProxyBaseUrl, getProxyStats } from '../../utils/fetchEngine.js';
import { getApiKey, setApiKey } from '../../utils/claude.js';
import { getGeminiApiKey, setGeminiApiKey } from '../../utils/gemini.js';

export default function ProxySettings() {
  const [url, setUrl] = useState(PROXY_BASE_URL || '');
  const [claudeKey, setClaudeKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const stats = getProxyStats();

  useEffect(() => {
    setClaudeKey(getApiKey());
    setGeminiKey(getGeminiApiKey());
  }, []);

  const save = () => {
    setProxyBaseUrl(url.trim());
    setApiKey(claudeKey.trim());
    setGeminiApiKey(geminiKey.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const test = async () => {
    if (!url.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const endpoint = url.trim().replace(/\/+$/, '') + '/api/proxy?source=bigpara_list';
      const t0 = Date.now();
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
      const ms = Date.now() - t0;
      if (res.ok) {
        const text = await res.text();
        setTestResult({ ok: true, ms, size: text.length });
      } else {
        setTestResult({ ok: false, msg: `HTTP ${res.status}` });
      }
    } catch (e) {
      setTestResult({ ok: false, msg: e.message });
    }
    setTesting(false);
  };

  return (
    <div style={{
      marginTop: 16, padding: 12,
      background: 'rgba(0,0,0,0.15)', borderRadius: 6,
      border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 14 }}>🤖</span>
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'Space Grotesk,sans-serif', color: 'var(--cyan)' }}>
          Claude API Anahtari (Anthropic)
        </span>
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 16 }}>
        <input
          className="inp"
          type="password"
          value={claudeKey}
          onChange={e => setClaudeKey(e.target.value)}
          onBlur={save}
          placeholder="sk-ant-api03-..."
          style={{ flex: 1, fontSize: 10, padding: 7 }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 14 }}>✨</span>
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'Space Grotesk,sans-serif', color: 'var(--cyan)' }}>
          Gemini API Anahtari (Haberler Icin)
        </span>
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 16 }}>
        <input
          className="inp"
          type="password"
          value={geminiKey}
          onChange={e => setGeminiKey(e.target.value)}
          onBlur={save}
          placeholder="AIzaSy..."
          style={{ flex: 1, fontSize: 10, padding: 7 }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 14 }}>🌐</span>
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'Space Grotesk,sans-serif', color: 'var(--cyan)' }}>
          CORS Proxy Ayarlari
        </span>
      </div>

      <div style={{ fontSize: 9, color: 'var(--t3)', lineHeight: 1.5, marginBottom: 10 }}>
        Kendi Vercel proxy'nizi deploy ederek veri cekmede %99 guvenilirlik elde edin.{' '}
        <code style={{ background: 'var(--bg0)', padding: '1px 4px', borderRadius: 3, fontSize: 8 }}>proxy/</code> klasorunu{' '}
        <code style={{ background: 'var(--bg0)', padding: '1px 4px', borderRadius: 3, fontSize: 8 }}> vercel --prod</code> ile deploy edin.
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <input
          className="inp"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onBlur={save}
          placeholder="https://your-proxy.vercel.app"
          style={{ flex: 1, fontSize: 10, padding: 7 }}
        />
        <button
          onClick={save}
          style={{
            fontSize: 9, padding: '6px 10px',
            background: saved ? 'var(--green)' : 'var(--bg3)',
            color: saved ? '#000' : 'var(--cyan)',
            border: `1px solid ${saved ? 'var(--green)' : 'var(--cyan)'}`,
            borderRadius: 4, cursor: 'pointer',
            fontFamily: 'inherit', fontWeight: 600,
          }}
        >
          {saved ? 'KAYDEDILDI' : 'KAYDET'}
        </button>
        <button
          onClick={test}
          disabled={testing || !url.trim()}
          style={{
            fontSize: 9, padding: '6px 10px',
            background: 'var(--bg3)', color: 'var(--yellow)',
            border: '1px solid var(--yellow)',
            borderRadius: 4, cursor: 'pointer',
            fontFamily: 'inherit', fontWeight: 600,
          }}
        >
          {testing ? '...' : 'TEST'}
        </button>
      </div>

      {testResult && (
        <div style={{
          fontSize: 9, padding: '4px 8px', borderRadius: 4, marginBottom: 6,
          background: testResult.ok ? 'rgba(0,200,83,0.08)' : 'rgba(255,23,68,0.08)',
          color: testResult.ok ? 'var(--green)' : 'var(--red)',
        }}>
          {testResult.ok
            ? `Basarili — ${testResult.ms}ms, ${(testResult.size / 1024).toFixed(0)}KB veri alindi`
            : `Basarisiz — ${testResult.msg}`}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, fontSize: 8, color: 'var(--t3)' }}>
        <span>Istek: <b>{stats.total ?? 0}</b></span>
        <span>Basarili: <b style={{ color: 'var(--green)' }}>{stats.ok ?? 0}</b></span>
        <span>
          Oran:{' '}
          <b style={{
            color: stats.total > 0
              ? stats.ok / stats.total > 0.8 ? 'var(--green)' : 'var(--yellow)'
              : 'var(--t3)',
          }}>
            {stats.total > 0 ? (stats.ok / stats.total * 100).toFixed(0) + '%' : '-'}
          </b>
        </span>
        {stats.sources && Object.keys(stats.sources).length > 0 && (
          <span>Kaynaklar: {Object.entries(stats.sources).map(([k, v]) => `${k}:${v}`).join(', ')}</span>
        )}
      </div>
    </div>
  );
}
