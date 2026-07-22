import { useState } from 'react';

export default function MobileNav({ activeTab, onTabChange }) {
  const [showMore, setShowMore] = useState(false);

  const primaryTabs = [
    { id: 'dashboard', label: 'Pano',    icon: '◉' },
    { id: 'analyze',   label: 'Analiz',  icon: '◎' },
    { id: 'trades',    label: 'Trade',   icon: '★' },
    { id: 'signals',   label: 'Sinyal',  icon: '◈' },
    { id: 'portfolio', label: 'Portföy', icon: '◆' },
  ];

  const overflowTabs = [
    { id: 'intel',    label: 'İstihbarat', icon: '🌍' },
    { id: 'paper',    label: 'Paper Trading', icon: '📄' },
    { id: 'realport', label: 'Gerçek Portföy', icon: '💼' },
  ];

  const handleTab = (id) => {
    onTabChange(id);
    setShowMore(false);
  };

  return (
    <>
      {showMore && (
        <div className="mobile-more-overlay" onClick={() => setShowMore(false)}>
          <div className="mobile-more-sheet" onClick={e => e.stopPropagation()}>
            <div className="mobile-more-handle" />
            {overflowTabs.map(tab => (
              <button
                key={tab.id}
                className={`mobile-more-item ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => handleTab(tab.id)}
              >
                <span className="mobile-more-icon">{tab.icon}</span>
                <span className="mobile-more-label">{tab.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <nav className="mobile-nav">
        <div className="mobile-nav-items">
          {primaryTabs.map((tab) => (
            <button
              key={tab.id}
              className={`mobile-nav-item ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => handleTab(tab.id)}
            >
              <span className="mobile-nav-icon">{tab.icon}</span>
              <span className="mobile-nav-label">{tab.label}</span>
            </button>
          ))}
          <button
            className={`mobile-nav-item ${overflowTabs.some(t => t.id === activeTab) ? 'active' : ''}`}
            onClick={() => setShowMore(!showMore)}
          >
            <span className="mobile-nav-icon">⋯</span>
            <span className="mobile-nav-label">Daha</span>
          </button>
        </div>
      </nav>
    </>
  );
}
