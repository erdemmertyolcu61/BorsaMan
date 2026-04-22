export default function Tabs({ activeTab, onTabChange }) {
  const tabs = [
    { id: 'analyze', label: '◉ Tekil Analiz' },
    { id: 'trades', label: '★ Günlük İntraday Trade' },
    { id: 'signals', label: '◈ Sinyal Takibi' },
    { id: 'portfolio', label: '◆ Portföy' },
  ];
  return (
    <div className="tabs">
      {tabs.map(t => (
        <button key={t.id} className={`tab ${activeTab === t.id ? 'active' : ''}`} onClick={() => onTabChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
