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

  const sortedPicks = [...topPicks]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 4);

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
              return (
                <button
                  key={p.symbol}
                  className={`m-advisor-chip ${isSell ? 'sell' : 'buy'}`}
                  onClick={() => onAnalyze?.(p.symbol)}
                >
                  {p.symbol} ({(p.score || 0).toFixed(1)})
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
