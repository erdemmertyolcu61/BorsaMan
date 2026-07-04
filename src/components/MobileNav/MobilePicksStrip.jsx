/**
 * MobilePicksStrip — Mobile scan trigger bar.
 * Shows TARA button + progress. Cards are rendered by AIAdvisorDetailPanel.
 */
export default function MobilePicksStrip({ advisor = {}, onAnalyze }) {
  const { scanning, scanProgress = {}, manualScan, topPicks = [], lastUpdate } = advisor;

  const buyCount = topPicks.filter(p => p && p.cls !== 'sell').length;

  return (
    <div className="mobile-picks-strip">
      <div className="mobile-picks-title">
        <span style={{ fontSize: 14 }}>◈</span>
        {scanning
          ? <span>Taranıyor {scanProgress.total > 0 ? `${scanProgress.done}/${scanProgress.total}` : '...'}</span>
          : <span>AI Advisor {buyCount > 0 ? `· ${buyCount} AL` : ''}</span>
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

      {!scanning && !buyCount && (
        <div className="mobile-picks-empty">
          TARA butonuna basarak 648 hisseyi tarayın.
        </div>
      )}
    </div>
  );
}
