import { isMarketOpen } from '../../hooks/useAIAdvisor.js';

/**
 * MobilePicksStrip — Compact AI Advisor status bar for mobile.
 * Mirrors the desktop AIAdvisorPanel aesthetic: status, sentiment, top picks, scan.
 */
export default function MobilePicksStrip({ advisor = {}, onAnalyze }) {
  const {
    scanning, scanProgress = {}, manualScan,
    topPicks = [], scanResults = [],
    marketSentiment, lastUpdate,
  } = advisor;

  const buys = marketSentiment?.buys || 0;
  const sells = marketSentiment?.sells || 0;
  const scanned = marketSentiment?.scanned || scanResults?.length || 0;
  const tuts = scanned - buys - sells;
  const sentiment = marketSentiment?.sentiment || '';
  const sentimentColor = marketSentiment?.color || 'var(--t3)';

  // AL pick'leri DAİMA gösterilir — kullanıcı talebi: ayı rejiminde bile AL
  // gorunmeli. Ham topPicks'i score'la sortlamak sell'lerin AL'lari ilk-4'ten
  // itmesine yol aciyordu. Cozum: (1) once AL'lar, (2) topPicks'te AL yoksa
  // (regime-gate hepsini elemis olabilir) scanResults'tan en guclu AL'lari cek,
  // (3) kalan slotlari sell'lerle doldur.
  const byScore = (a, b) => (b.score || 0) - (a.score || 0);
  const heldSyms = new Set(topPicks.map(p => p.symbol));
  let buyPicks = topPicks.filter(p => p.cls === 'buy').sort(byScore);
  if (buyPicks.length === 0) {
    buyPicks = (scanResults || [])
      .filter(r => r?.symbol && r.cls === 'buy' && (r.score || 0) >= 45 && !heldSyms.has(r.symbol))
      .sort(byScore)
      .slice(0, 3)
      .map(r => ({ ...r, _counterRegime: true })); // ayı/yatayda gate disi -> uyari rozeti
  }
  const sellPicks = topPicks.filter(p => p.cls === 'sell').sort(byScore);
  const sortedPicks = [...buyPicks, ...sellPicks].slice(0, 4);

  return (
    <div className="m-advisor-bar">
      {/* Row 1: Status + Sentiment + Counts + TARA */}
      <div className="m-advisor-row1">
        <div className="m-advisor-status">
          <span className={`m-advisor-dot ${scanning ? 'scanning' : 'ready'}`} />
          <span className="m-advisor-label">AI ADVISOR</span>
          {!scanning && (
            <span className="m-advisor-mode">
              {isMarketOpen() ? 'CANLI' : 'YARIN İÇİN'}
            </span>
          )}
        </div>

        {scanning ? (
          <span className="m-advisor-scanning">
            {scanProgress.total > 0 ? `${scanProgress.done}/${scanProgress.total}` : '...'}
          </span>
        ) : (
          <div className="m-advisor-sentiment">
            {sentiment && (
              <span className="m-advisor-regime" style={{ color: sentimentColor }}>
                {sentiment}
              </span>
            )}
            {scanned > 0 && (
              <>
                <span className="m-advisor-count green">{buys} AL</span>
                <span className="m-advisor-count yellow">{tuts} TUT</span>
                <span className="m-advisor-count red">{sells} SAT</span>
              </>
            )}
          </div>
        )}

        <button
          className={`m-advisor-tara ${scanning ? 'disabled' : ''}`}
          onClick={() => manualScan?.()}
          disabled={scanning}
        >
          TARA
        </button>
      </div>

      {/* Scan progress bar */}
      {scanning && (
        <div className="m-advisor-progress">
          <div
            className="m-advisor-progress-fill"
            style={{ width: scanProgress.total > 0 ? `${(scanProgress.done / scanProgress.total) * 100}%` : '0%' }}
          />
        </div>
      )}

      {/* Row 2: Top picks chips (scrollable) */}
      {sortedPicks.length > 0 && !scanning && (
        <div className="m-advisor-row2">
          <span className="m-advisor-best-label">En İyi:</span>
          <div className="m-advisor-chips">
            {sortedPicks.map((p) => {
              const isSell = p.cls === 'sell';
              const counter = p._counterRegime && !isSell;
              return (
                <button
                  key={p.symbol}
                  className={`m-advisor-chip ${isSell ? 'sell' : 'buy'}`}
                  onClick={() => onAnalyze?.(p.symbol)}
                  title={counter ? 'Rejime karşı AL — düşüş/yatay piyasada yüksek risk, küçük pozisyon' : undefined}
                >
                  {counter ? '⚠ ' : ''}{p.symbol} ({(p.score || 0).toFixed(1)})
                </button>
              );
            })}
          </div>
          {scanned > 0 && (
            <span className="m-advisor-scanned">
              <span className="m-advisor-scanned-dot" />
              {scanned} taranmış
            </span>
          )}
        </div>
      )}

      {/* Empty state */}
      {!scanning && sortedPicks.length === 0 && !scanned && (
        <div className="m-advisor-empty">
          TARA butonuna basarak 648 hisseyi tarayın.
        </div>
      )}
    </div>
  );
}
