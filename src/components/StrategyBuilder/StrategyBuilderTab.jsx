import { useRef, useState } from 'react';
import { generateStrategyCode } from '../../utils/claude.js';
import { getStockList, SECTORS } from '../../utils/constants.js';
import { fetchSingle } from '../../utils/fetchEngine.js';
import { calcAll } from '../../utils/indicators.js';
import { genSignal, calcPosition } from '../../utils/signals.js';

const PRESET_STRATEGIES = [
  { label: '🎯 Beni Zengin Edecek Hisseler', text: 'Beni zengin edecek en iyi firsatlar — guclu sinyal, kurumsal birikim ve yuksek potansiyel' },
  { label: '📈 Uzun Vadeli Yatirim (1-3 Yil)', text: 'MA200 ustunde, uzun vadeli yukselis trendinde, kurumsal birikim olan saglam hisseler' },
  { label: '🛡 Dusuk Riskli Portfoy', text: 'Dusuk riskli guvenli yatirimlar — yuksek risk/odul orani, dusuk volatilite, istikrarli trend' },
  { label: '⚡ Kisa Vade Momentum', text: 'Kisa vadede guclu momentum — ADX yuksek, hacim patlama, trend yukari, RSI uygun' },
  { label: '🔻 Dipten Donus', text: 'Asiri satim bolgesi RSI dusuk, MFI kurumsal birikim gosteriyor, Bollinger alt bant, hacim artisi' },
  { label: '🏦 Akilli Para Takibi', text: 'Kurumsal akilli para birikim yapiyor — OBV, CMF, Wyckoff analizi ile kurumsal alis tespit et' },
  { label: '💰 MACD + RSI Kombine', text: 'MACD yukari kessin, histogram pozitif olsun ve RSI 30-50 arasinda olsun, hacim artsin' },
  { label: '✨ Golden Cross + Hacim', text: 'Golden cross olsun, hacim ortalama 1.5x uzerinde, ADX guclu trend gostersin' },
  { label: '📊 Bollinger Squeeze Patlama', text: 'Bollinger bantlari sikismis, TTM squeeze aktif, momentum yukari, patlama bekleniyor' },
  { label: '🐋 Balina Aktivitesi', text: 'Buyuk hacim anomalisi, OBV birikim, Chaikin para girisi yuksek, Wyckoff birikim fazi' },
];

const delay = (ms) => new Promise(r => setTimeout(r, ms));

export default function StrategyBuilderTab({ setBadge, addToPortfolio, portfolio, goToAnalyze }) {
  const [userText, setUserText] = useState('');
  const [codePreview, setCodePreview] = useState(null);
  const [running, setRunning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState({ pct: 0, label: '', ok: 0, fail: 0, left: 0 });
  const [results, setResults] = useState([]);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);
  const [explanations, setExplanations] = useState([]);
  const runningRef = useRef(false);

  const handleGenerateAndRun = async (overrideText) => {
    const input = overrideText || userText;
    if (!input.trim()) return;
    setGenerating(true);
    setRunning(false);
    setError(null);
    setCodePreview(null);
    setResults([]);
    setSource(null);
    setExplanations([]);
    setBadge?.({ text: 'Kod Uretiliyor...', cls: 'load' });

    const aiResp = await generateStrategyCode(input);
    setGenerating(false);
    if (aiResp.error) {
      setError(aiResp.error);
      setBadge?.({ text: 'Hata', cls: 'err' });
      return;
    }
    const jsCode = aiResp.code;
    setCodePreview(jsCode);
    setSource(aiResp.source || 'ai');
    if (aiResp.explanations) setExplanations(aiResp.explanations);

    // ── Sandboxed strategy compile ───────────────────────────────────────
    // We REFUSE eval() here. Untrusted AI/LLM output is passed through a
    // denylist (network / storage / dynamic-code access) and then compiled
    // with `new Function`, which restricts scope to its own arguments —
    // no access to this component's closure.
    let strategyFunc;
    try {
      const FORBIDDEN = /\b(fetch|XMLHttpRequest|WebSocket|import|require|eval|Function|globalThis|window|document|localStorage|sessionStorage|indexedDB|navigator|process|__proto__|constructor\s*\[)\b/;
      if (FORBIDDEN.test(jsCode)) throw new Error('Gizli API cagrisi tespit edildi — kod reddedildi.');
      if (jsCode.length > 4000) throw new Error('Kod çok uzun — guvenlik limiti.');
      // Compile in an isolated lexical scope. Only `ind`, `sig`, `data` are exposed.
      // `use strict` prevents accidental globals; no `this` leak.
      const factory = new Function('"use strict";\nreturn (' + jsCode + ');');
      strategyFunc = factory();
      if (typeof strategyFunc !== 'function') throw new Error('Donen sonuc bir fonksiyon degil!');
    } catch (e) {
      setError('Kod Calistirma Hatasi: ' + e.message);
      setBadge?.({ text: 'Hata', cls: 'err' });
      return;
    }

    setRunning(true);
    runningRef.current = true;
    setBadge?.({ text: 'Taranıyor...', cls: 'load' });

    const stocks = getStockList('bist100');
    const total = stocks.length;
    let ok = 0, fail = 0;
    const foundResults = [];

    for (let i = 0; i < stocks.length && runningRef.current; i += 4) {
      const batch = stocks.slice(i, i + 4);
      const tasks = batch.map(async (sym) => {
        try {
          const data = await fetchSingle(sym, '6mo', '1d', true);
          if (!data || data.prices.length < 20) { fail++; return; }
          const ind = calcAll(data.prices);
          const sig = genSignal(ind, data.prices);
          let match = false;
          try { match = strategyFunc(ind, sig, data); } catch {}
          if (match) {
            const lastBar = data.prices[data.prices.length - 1];
            foundResults.push({
              symbol: sym,
              price: ind.lastClose,
              change: ind.changePct,
              rsi: ind.lastRSI,
              volume: lastBar?.volume || 0,
              volRatio: ind.volRatio,
              signal: sig.signal,
              score: sig.score,
              cls: sig.cls,
              entry: sig.entry,
              stop: sig.stop,
              target: sig.t1,
              sector: SECTORS[sym] || 'Diger',
              mfi: ind.mfi,
              obvTrend: ind.obvTrend,
              adx: ind.adx,
            });
            ok++;
          }
        } catch {
          fail++;
        }
      });
      await Promise.all(tasks);
      const done = ok + fail;
      setProgress({
        pct: Math.round((done / total) * 100),
        label: batch.join(', '),
        ok, fail,
        left: total - done,
      });
      setResults([...foundResults]);
      await delay(350);
    }

    setRunning(false);
    runningRef.current = false;
    setBadge?.({ text: foundResults.length + ' Sonuç', cls: 'ok' });
    setProgress(p => ({ ...p, label: 'Tamamlandi — ' + foundResults.length + ' hisse bulundu' }));
  };

  const stopScan = () => {
    runningRef.current = false;
    setRunning(false);
  };

  return (
    <div style={{ padding: '24px 20px', maxWidth: 960, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--t1)', letterSpacing: '-0.3px' }}>
          <span style={{ color: 'var(--cyan)', marginRight: 8 }}>⚙</span>
          Dogal Dil ile Strateji İnşası
        </h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--t3)', lineHeight: 1.5, maxWidth: 700 }}>
          {`Yatirim hedefinizi veya teknik kosullari Turkce olarak yazin. "Beni zengin edecek hisseler", "1 yil vadede iyi getiri" veya "RSI 30 altinda ve hacim yuksek" gibi — sistem otomatik anlayip BIST 100'u tarayacaktir.`}
        </p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {PRESET_STRATEGIES.map((p, i) => (
          <button
            key={i}
            onClick={() => { setUserText(p.text); handleGenerateAndRun(p.text); }}
            style={{
              padding: '6px 14px', fontSize: 11, fontWeight: 500, fontFamily: 'inherit',
              background: 'var(--bg3)', color: 'var(--t2)',
              border: '1px solid var(--border)', borderRadius: 20,
              cursor: 'pointer', transition: 'all .2s',
            }}
            onMouseOver={e => { e.target.style.borderColor = 'var(--cyan)'; e.target.style.color = 'var(--cyan)'; }}
            onMouseOut={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.color = 'var(--t2)'; }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border)',
        borderRadius: 10, overflow: 'hidden', marginBottom: 20,
      }}>
        <textarea
          style={{
            width: '100%', minHeight: 72, padding: '14px 16px',
            fontSize: 13, lineHeight: 1.6, fontFamily: 'inherit',
            background: 'transparent', border: 'none', color: 'var(--t1)',
            resize: 'vertical', outline: 'none', boxSizing: 'border-box',
          }}
          value={userText}
          onChange={e => setUserText(e.target.value)}
          disabled={running || generating}
          placeholder="Ornek: RSI 30 altinda olsun ve hacim ortalamanin en az 2 kati olsun..."
        />
        <div style={{ display: 'flex', gap: 10, padding: '0 16px 14px', alignItems: 'center' }}>
          {!running && !generating ? (
            <button
              onClick={() => handleGenerateAndRun()}
              disabled={!userText.trim()}
              style={{
                padding: '10px 24px', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                background: userText.trim() ? 'linear-gradient(135deg, var(--cyan), #3b82f6)' : 'var(--bg4)',
                color: userText.trim() ? '#fff' : 'var(--t3)',
                border: 'none', borderRadius: 8,
                cursor: userText.trim() ? 'pointer' : 'default',
                transition: 'all .2s', letterSpacing: '0.3px',
              }}
            >
              ▶ Koda Cevir & Tara
            </button>
          ) : (
            <button
              onClick={stopScan}
              style={{
                padding: '10px 24px', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                background: 'var(--red2)', color: 'var(--red)',
                border: '1px solid var(--red)', borderRadius: 8, cursor: 'pointer',
              }}
            >
              ■ Durdur
            </button>
          )}
          {generating && (
            <span style={{ fontSize: 12, color: 'var(--cyan)', animation: 'pulse 1.5s infinite' }}>
              Strateji kodu uretiliyor...
            </span>
          )}
        </div>
      </div>

      {error && (
        <div style={{
          padding: '12px 16px', marginBottom: 16,
          background: 'var(--red2)', borderRadius: 8,
          borderLeft: '3px solid var(--red)',
          fontSize: 12, color: 'var(--red)', lineHeight: 1.5,
        }}>
          <strong>Hata:</strong> {error}
        </div>
      )}

      {codePreview && (
        <div style={{
          marginBottom: 20, background: 'var(--bg2)',
          border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden',
        }}>
          <div style={{
            padding: '10px 16px', borderBottom: '1px solid var(--border)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: 1 }}>
              Uretilen Filtre Kodu
            </span>
            <span style={{
              fontSize: 9, padding: '3px 10px', borderRadius: 12, fontWeight: 600,
              background: source === 'ai' ? 'rgba(139,92,246,.15)' : 'rgba(34,211,238,.12)',
              color: source === 'ai' ? '#a78bfa' : 'var(--cyan)',
              border: '1px solid ' + (source === 'ai' ? 'rgba(139,92,246,.3)' : 'rgba(34,211,238,.25)'),
            }}>
              {source === 'ai' ? 'Claude AI' : 'Yerel NLP Motor'}
            </span>
          </div>
          {explanations.length > 0 && (
            <div style={{
              padding: '10px 16px', borderBottom: '1px solid var(--border)',
              display: 'flex', flexWrap: 'wrap', gap: 6,
            }}>
              {explanations.map((ex, i) => (
                <span key={i} style={{
                  fontSize: 10, padding: '4px 10px', borderRadius: 6, fontWeight: 500,
                  background: 'var(--bg4)', color: 'var(--green)',
                  border: '1px solid rgba(74,222,128,.2)',
                }}>✓ {ex}</span>
              ))}
            </div>
          )}
          <pre style={{
            margin: 0, padding: '14px 16px',
            fontSize: 12, lineHeight: 1.6, color: 'var(--green)',
            overflowX: 'auto', whiteSpace: 'pre-wrap',
            fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', monospace",
          }}>{codePreview}</pre>
        </div>
      )}

      {(running || progress.ok > 0) && (
        <div style={{
          marginBottom: 20, background: 'var(--bg2)',
          border: '1px solid var(--border)', borderRadius: 10, padding: 16,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--t2)', marginBottom: 8 }}>
            <span>{progress.label}</span>
            <span style={{ fontWeight: 700, color: 'var(--cyan)' }}>{progress.pct}%</span>
          </div>
          <div style={{ height: 4, background: 'var(--bg4)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: progress.pct + '%',
              background: 'linear-gradient(90deg, var(--cyan), #3b82f6)',
              borderRadius: 4, transition: 'width .3s',
            }} />
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 10, color: 'var(--t3)' }}>
            <span><span style={{ color: 'var(--green)', fontWeight: 700 }}>{progress.ok}</span> basarili</span>
            <span><span style={{ color: 'var(--red)', fontWeight: 700 }}>{progress.fail}</span> hata</span>
            <span><span style={{ color: 'var(--cyan)', fontWeight: 700 }}>{progress.left}</span> kalan</span>
          </div>
        </div>
      )}

      {!running && results.length > 0 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 14 }}>
            Eslesen Hisseler
            <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--cyan)', fontWeight: 500 }}>
              ({results.length} sonuc)
            </span>
          </div>
          <div style={{
            display: 'grid', gap: 12,
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          }}>
            {[...results].sort((a, b) => b.score - a.score).map((r, i) => {
              const pos = calcPosition(portfolio?.cash || 10000, 2, r.entry, r.stop);
              return (
                <div
                  key={i}
                  style={{
                    background: 'var(--bg2)', border: '1px solid var(--border)',
                    borderRadius: 10, padding: 16, transition: 'border-color .2s',
                  }}
                  onMouseOver={e => (e.currentTarget.style.borderColor = 'var(--cyan)')}
                  onMouseOut={e => (e.currentTarget.style.borderColor = 'var(--border)')}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div>
                      <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--t1)' }}>{r.symbol}</span>
                      <span style={{ fontSize: 10, color: 'var(--t3)', marginLeft: 8 }}>{r.sector}</span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>
                        {r.price.toFixed(2)} <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--t3)' }}>TL</span>
                      </div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: r.change >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {r.change >= 0 ? '+' : ''}{r.change.toFixed(2)}%
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
                    {[
                      { l: 'RSI', v: r.rsi?.toFixed(1) || '-', c: r.rsi < 30 ? 'var(--green)' : r.rsi > 70 ? 'var(--red)' : 'var(--t1)' },
                      { l: 'Hacim', v: (r.volRatio?.toFixed(1) || '-') + 'x', c: r.volRatio > 1.5 ? 'var(--green)' : 'var(--t1)' },
                      { l: 'Skor', v: (r.score?.toFixed(1) || '-') + '/10', c: r.score >= 3 ? 'var(--green)' : r.score <= -1 ? 'var(--red)' : 'var(--yellow)' },
                    ].map((m, j) => (
                      <div key={j} style={{
                        background: 'var(--bg3)', borderRadius: 6,
                        padding: '6px 8px', textAlign: 'center',
                      }}>
                        <div style={{ fontSize: 9, color: 'var(--t3)', marginBottom: 2 }}>{m.l}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: m.c }}>{m.v}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    fontSize: 10, color: 'var(--t3)', marginBottom: 14, padding: '0 4px',
                  }}>
                    <span>Giriş: <span style={{ color: 'var(--blue)', fontWeight: 600 }}>{r.entry?.toFixed(2)}</span></span>
                    <span>Stop: <span style={{ color: 'var(--red)', fontWeight: 600 }}>{r.stop?.toFixed(2)}</span></span>
                    <span>Hedef: <span style={{ color: 'var(--green)', fontWeight: 600 }}>{r.target?.toFixed(2)}</span></span>
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                    {goToAnalyze && (
                      <button
                        onClick={() => {
                          window.dispatchEvent(new CustomEvent('ai-analyze', { detail: { symbol: r.symbol } }));
                          goToAnalyze();
                        }}
                        style={{
                          flex: 1, padding: '8px', fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                          background: 'var(--bg3)', color: 'var(--t2)',
                          border: '1px solid var(--border)', borderRadius: 6,
                          cursor: 'pointer', transition: 'all .2s',
                        }}
                        onMouseOver={e => { e.target.style.borderColor = 'var(--cyan)'; e.target.style.color = 'var(--cyan)'; }}
                        onMouseOut={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.color = 'var(--t2)'; }}
                      >
                        Detayli Analiz
                      </button>
                    )}
                    {addToPortfolio && (
                      <button
                        onClick={() => addToPortfolio(r.symbol, r.entry, r.stop, r.target, pos.shares || 1)}
                        style={{
                          flex: 1, padding: '8px', fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                          background: 'rgba(74,222,128,.1)', color: 'var(--green)',
                          border: '1px solid rgba(74,222,128,.25)', borderRadius: 6,
                          cursor: 'pointer', transition: 'all .2s',
                        }}
                        onMouseOver={e => (e.target.style.background = 'rgba(74,222,128,.2)')}
                        onMouseOut={e => (e.target.style.background = 'rgba(74,222,128,.1)')}
                      >
                        + Portföye Ekle
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!running && !generating && progress.pct === 100 && results.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '48px 20px',
          background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 10, color: 'var(--t3)', fontSize: 13,
        }}>
          <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.4 }}>🔍</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Sonuç Bulunamadi</div>
          <div style={{ fontSize: 11 }}>Filtre kosullariniz cok siki olabilir. Daha genis terimler deneyin.</div>
        </div>
      )}

      {!running && !generating && !codePreview && !error && results.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '48px 20px',
          background: 'var(--bg2)', border: '1px dashed var(--border)',
          borderRadius: 10, color: 'var(--t3)', fontSize: 12,
        }}>
          <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.3 }}>⚙</div>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--t2)', marginBottom: 6 }}>
            Strateji Olusturun
          </div>
          <div>Yukaridaki hazir sablonlardan birini secin veya kendi stratejinizi yazin.</div>
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 10, color: 'var(--t3)', textAlign: 'center', opacity: 0.6 }}>
        Bu tarama yatirim tavsiyesi degildir — kisisel arastirma yapiniz.
      </div>
    </div>
  );
}
