/**
 * MobileNav - Mobile navigation for smaller screens
 */
export default function MobileNav({ activeTab, onTabChange }) {
  const tabs = [
    { id: 'dashboard', label: 'Pano',   icon: '📊' },
    { id: 'analyze',  label: 'Analiz',  icon: '◉' },
    { id: 'trades',   label: 'Intraday',icon: '★' },
    { id: 'signals',  label: 'Sinyal',  icon: '◈' },
    { id: 'paper',    label: 'Paper',   icon: '📄' },
  ];

  return (
    <nav className="mobile-nav">
      <div className="mobile-nav-items">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`mobile-nav-item ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            <span className="mobile-nav-icon">{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
