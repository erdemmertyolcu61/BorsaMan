// v31.50 (kullanici karari): Istihbarat, Piyasa Nabzi ve Gercek Portfoy kaldirildi,
// yerlerine Hisse detayi geldi. Emoji etiketler v31.47 gorsel diline uyduruldu.
export default function Tabs({ activeTab, onTabChange }) {
  const tabs = [
    { id: 'analyze',  label: 'Tekil analiz' },
    { id: 'stock',    label: 'Hisse detayı' },
    { id: 'trades',   label: 'Günlük intraday' },
    { id: 'signals',  label: 'Sinyal takibi' },
    { id: 'paper',    label: 'Paper trading' },
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
