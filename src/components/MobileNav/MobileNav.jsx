/**
 * MobileNav — bottom tab bar.
 *
 * v31.22: Pano and the virtual Portfoy tab were removed, which left the overflow
 * sheet holding exactly ONE entry, so every tab moved into the bar itself.
 *
 * v31.38 (user decision): Trade (15-minute intraday on 15-30 min delayed data)
 * and Haber (AI market intel — needs a Gemini key, never refreshed on the phone)
 * are gone from mobile. Their place is taken by Piyasa: KAP disclosures,
 * per-stock foreign ownership and relative momentum. Desktop keeps every tab.
 *
 * v31.47: emoji icons (📄 💼 📡 rendered as colour bitmaps next to two unicode
 * glyphs) were the most visible part of the "pixel-art" look the user named.
 * One stroke-icon set now, drawn in currentColor so the active tab tints it.
 *
 * v31.50 (user decision): Portföy (real holdings) and Piyasa are gone. Hisse —
 * every technical and fundamental value of one stock, 16 quarters of FAVÖK and
 * profit — takes their place.
 */
const ICONS = {
  analyze: (
    <>
      <path d="M4 4v16h16" />
      <path d="M8 14l3.5-3.5 3 3L19 8" />
    </>
  ),
  signals: (
    <path d="M3 12h4l2.5 6 5-12 2.5 6h4" />
  ),
  paper: (
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="2.5" />
      <path d="M9 8.5h6M9 12h6M9 15.5h3.5" />
    </>
  ),
  stock: (
    <>
      <rect x="4" y="3.5" width="16" height="17" rx="2.5" />
      <path d="M8.5 16.5v-3M12 16.5v-6M15.5 16.5V8" />
    </>
  ),
};

function NavIcon({ id }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[id]}
    </svg>
  );
}

export default function MobileNav({ activeTab, onTabChange }) {
  const tabs = [
    { id: 'analyze',  label: 'Analiz' },
    { id: 'stock',    label: 'Hisse' },
    { id: 'signals',  label: 'Sinyal' },
    { id: 'paper',    label: 'Paper' },
  ];

  return (
    <nav className="mobile-nav">
      <div className="mobile-nav-items">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`mobile-nav-item ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
            aria-label={tab.label}
            aria-current={activeTab === tab.id ? 'page' : undefined}
          >
            <span className="mobile-nav-icon"><NavIcon id={tab.id} /></span>
            <span className="mobile-nav-label">{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
