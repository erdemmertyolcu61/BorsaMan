/**
 * MobileNav — bottom tab bar.
 *
 * v31.22: Pano and the virtual Portfoy tab were removed, which left the overflow
 * sheet holding exactly ONE entry. A "Daha" button that hides a single item costs
 * a tap and a modal for nothing, so every tab now lives in the bar itself and the
 * sheet is gone. Six items fit 375px without horizontal scroll (measured).
 */
export default function MobileNav({ activeTab, onTabChange }) {
  const tabs = [
    { id: 'analyze',  label: 'Analiz',  icon: '◎' },
    { id: 'trades',   label: 'Trade',   icon: '★' },
    { id: 'signals',  label: 'Sinyal',  icon: '◈' },
    { id: 'paper',    label: 'Paper',   icon: '📄' },
    { id: 'realport', label: 'Portföy', icon: '💼' },
    { id: 'intel',    label: 'Haber',   icon: '🌍' },
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
