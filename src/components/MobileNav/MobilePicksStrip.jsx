import { isMarketOpen } from '../../hooks/useAIAdvisor.js';
import { deriveDisplayPicks } from '../../utils/displayPicks.js';

/**
 * MobilePicksStrip — Compact AI Advisor status bar for mobile.
 * Mirrors the desktop AIAdvisorPanel aesthetic: status, sentiment, top picks, scan.
 */
export default function MobilePicksStrip({ advisor = {}, onAnalyze }) {
  const {
    scanning, scanProgress = {}, manualScan,
    topPicks = [], scanResults = [],
    marketSentiment,
  } = advisor;

  const buys = marketSentiment?.buys || 0;
  const sells = marketSentiment?.sells || 0;
  const scanned = marketSentiment?.scanned || scanResults?.length || 0;
  const tuts = scanned - buys - sells;
  const sentiment = marketSentiment?.sentiment || '';
  const sentimentColor = marketSentiment?.color || 'var(--t3)';

  // v31.59: masaustu panel, AL listesi (Sinyal sekmesi) ve tahmin karnesiyle AYNI sira —
  // deriveDisplayPicks (tek kaynak). Eskiden burada AL'lar skora gore yeniden siralaniyordu:
  // telefonun "En Iyi"si listeden farkli hisseleri one cikarabiliyordu.
  const regime = advisor.marketRegime?.regime || null;
  const sortedPicks = deriveDisplayPicks(topPicks, scanResults, !!(regime && regime !== 'BULL'), regime).slice(0, 4);

  return (
    <div className="m-advisor-bar">
      {/* Row 1: Status + Sentiment + Counts + TARA */}
      <div className="m-advisor-row1">
        <div className="m-advisor-status">
          <span className={`m-advisor-dot ${scanning ? 'scanning' : 'ready'}`} />
          <span className="m-advisor-label">AI Advisor</span>
          {!scanning && (
            <span className="m-advisor-mode">
              {isMarketOpen() ? 'Canlı' : 'Yarın için'}
            </span>
          )}
        </div>

        {scanning ? (
          <span className="m-advisor-scanning">
            {scanProgress.total > 0 ? `${scanProgress.done}/${scanProgress.total}` : '...'}
            {/* v31.32: 612/612'den sonraki son-işlem fazı — yoksa "dondu" görünüyor. */}
            {scanProgress.phase
              ? <span style={{ opacity: 0.65 }}> · {scanProgress.phase}</span>
              : null}
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
            {/* v31.40: tarama kapsami + verinin ait oldugu oturum gunu */}
            {advisor.coverage?.total > 0 && (
              <span
                className="m-advisor-count"
                title={`Kapsama ${advisor.coverage.scanned}/${advisor.coverage.total} · veri günü ${advisor.coverage.sessionDay || '?'}`}
                style={{ color: advisor.coverage.scanned / advisor.coverage.total >= 0.98 ? 'var(--green)' : 'var(--yellow)' }}
              >
                ◎ {advisor.coverage.scanned}/{advisor.coverage.total}
              </span>
            )}
          </div>
        )}

        <button
          className={`m-advisor-tara ${scanning ? 'disabled' : ''}`}
          onClick={() => manualScan?.()}
          disabled={scanning}
        >
          Tara
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
      {/* v31.48: ekran kapaninca tarama ne olur — kullanici bilsin */}
      {scanning && (
        <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 5 }}>
          {advisor.scanKeepAwake === 'active'
            ? 'Tarama bitene kadar ekran açık tutuluyor.'
            : 'Ekran kapanırsa tarama duraklar, uygulamaya dönünce kaldığı yerden sürer.'}
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
              const bestOfDay = p._bestOfDay && !isSell;
              const watchOnly = p._watchOnly && !isSell;
              return (
                <button
                  key={p.symbol}
                  className={`m-advisor-chip ${isSell ? 'sell' : 'buy'}`}
                  onClick={() => onAnalyze?.(p.symbol)}
                  title={watchOnly
                    ? ((p._regime || regime) === 'BEAR'
                      ? 'İzle, alım değil: piyasa düşüş rejiminde. Ölçümde bu rejimde AL adayları maliyet sonrası ≈0 getirdi (son iki yılda −%0,2). Paper açmaz.'
                      : 'İzle, alım değil: listeyi tamamlamak için gösterilir. Paper açmaz.')
                    : bestOfDay
                    ? 'Günün en iyisi — rejim kapısı boş bıraktı, pre-pump havuzundan garanti pick (yüksek risk, küçük pozisyon)'
                    : counter ? 'Rejime karşı AL — düşüş/yatay piyasada yüksek risk, küçük pozisyon' : undefined}
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
          Tara düğmesiyle tüm hisseleri tarayın.
        </div>
      )}
    </div>
  );
}
