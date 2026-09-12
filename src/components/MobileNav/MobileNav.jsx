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
 */
export default function MobileNav({ activeTab, onTabChange }) {
  const tabs = [
    { id: 'analyze',  label: 'Analiz',  icon: '◎' },
    { id: 'signals',  label: 'Sinyal',  icon: '◈' },
    { id: 'paper',    label: 'Paper',   icon: '📄' },
    { id: 'realport', label: 'Portföy', icon: '💼' },
    { id: 'market',   label: 'Piyasa',  icon: '📡' },
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
            <span className="mobile-nav-icon">{tab.icon}</span>
            <span className="mobile-nav-label">{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
