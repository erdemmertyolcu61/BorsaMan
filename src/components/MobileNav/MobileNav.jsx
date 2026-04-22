/**
 * MobileNav - Mobile navigation for smaller screens
 */
export default function MobileNav({ activeTab, onTabChange }) {
  const tabs = [
    { id: 'analyze', label: 'Analiz', icon: '◉' },
    { id: 'trades', label: 'İntraday', icon: '★' },
    { id: 'signals', label: 'Sinyal', icon: '◈' },
    { id: 'portfolio', label: 'Portföy', icon: '◆' },
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
