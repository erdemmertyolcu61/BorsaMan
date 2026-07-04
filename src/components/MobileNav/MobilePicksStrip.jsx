/**
 * MobilePicksStrip — Horizontal scrollable AI picks for mobile.
 * Shows scan button + top advisor picks in compact cards.
 */
export default function MobilePicksStrip({ advisor = {}, onAnalyze }) {
  const { topPicks = [], scanning, scanProgress = {}, manualScan, lastUpdate } = advisor;

  const displayPicks = topPicks.filter(p => p && p.symbol && p.cls !== 'sell').slice(0, 6);

  const medals = ['gold', 'silver', 'bronze'];

  return (
    <div className="mobile-picks-strip">
      <div className="mobile-picks-title">
        <span style={{ fontSize: 14 }}>◈</span>
        {scanning
          ? <span>Taranıyor {scanProgress.total > 0 ? `${scanProgress.done}/${scanProgress.total}` : '...'}</span>
          : <span>AI Advisor</span>
        }
        <button
          className="mobile-scan-btn"
          onClick={() => manualScan?.()}
          disabled={scanning}
        >
          {scanning ? '⏳' : '↻'} TARA
        </button>
      </div>

      {scanning && (
        <div className="mobile-scan-progress">
          <div
            className="mobile-scan-progress-fill"
            style={{ width: scanProgress.total > 0 ? `${(scanProgress.done / scanProgress.total) * 100}%` : '0%' }}
          />
        </div>
      )}

      {displayPicks.length > 0 && (
        <div className="mobile-picks-scroll">
          {displayPicks.map((pick, i) => (
            <button
              key={pick.symbol}
              className={`mobile-pick-card ${medals[i] || ''}`}
              onClick={() => onAnalyze?.(pick.symbol)}
            >
              <div className="mobile-pick-sym">{pick.symbol}</div>
              <div className="mobile-pick-signal">{pick.signal || '—'}</div>
              <div className="mobile-pick-row">
                <span className="mobile-pick-score">{Math.round(pick.confidence || pick.score || 0)}</span>
                <span className="mobile-pick-rr">R/R {(pick.rr || 0).toFixed(1)}</span>
              </div>
              {pick.grade && (
                <span className={`mobile-pick-grade ${(pick.grade || '').toLowerCase()}`}>
                  {pick.grade}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {!scanning && !displayPicks.length && (
        <div className="mobile-picks-empty">
          Henüz tarama yapılmadı. TARA butonuna basarak 648 hisseyi tarayın.
        </div>
      )}
    </div>
  );
}
