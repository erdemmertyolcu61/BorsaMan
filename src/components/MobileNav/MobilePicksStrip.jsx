/**
 * MobilePicksStrip — Horizontal scrollable AI picks for mobile.
 * Shows top advisor picks in compact cards. Tapping a card triggers analysis.
 */
export default function MobilePicksStrip({ advisor = {}, onAnalyze }) {
  const { topPicks = [], scanning, scanProgress = {} } = advisor;

  const displayPicks = topPicks.filter(p => p && p.symbol && p.cls !== 'sell').slice(0, 6);

  if (!displayPicks.length && !scanning) return null;

  const medals = ['gold', 'silver', 'bronze'];

  return (
    <div className="mobile-picks-strip">
      <div className="mobile-picks-title">
        <span style={{ fontSize: 14 }}>◈</span>
        {scanning
          ? <span>Taranıyor {scanProgress.total > 0 ? `${scanProgress.done}/${scanProgress.total}` : '...'}</span>
          : <span>En iyi fırsatlar</span>
        }
      </div>
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
    </div>
  );
}
