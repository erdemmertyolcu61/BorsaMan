import { useState } from 'react';

// Curated watchlist - NOT portfolio data
const CURATED_STOCKS = [
  { id: 'bist', symbol: 'BIST', price: 275.00, change: 0.67, changePercent: 0.67 },
  { id: 'thyao', symbol: 'THYAO', price: 52.00, change: 0.84, changePercent: 0.54 },
  { id: 'thyao_is', symbol: 'THYAO.IS', price: 16.30, change: 0.53, changePercent: 0.53 },
  { id: 'cord', symbol: 'CORD', price: 293.00, change: -1.22, changePercent: -1.22 },
  { id: 'arrec', symbol: 'ARREC', price: 7.50, change: 0.73, changePercent: 0.73 },
  { id: 'trnfp', symbol: 'TRNFP', price: 239.50, change: -0.49, changePercent: -0.49 },
  { id: 'euao', symbol: 'EUAO', price: 32.00, change: -0.57, changePercent: -0.57 },
  { id: 'buag', symbol: 'BUAG', price: 115.30, change: -0.65, changePercent: -0.65 },
  { id: 'kuren_is', symbol: 'KUREN.IS', price: 12.50, change: 0.94, changePercent: 0.94 },
  { id: 'keari', symbol: 'KEARI', price: 5.50, change: -0.18, changePercent: -0.18 },
  { id: 'buad', symbol: 'BUAD', price: 23.50, change: 0.16, changePercent: 0.16 },
];

export default function StockSelector({ onSelectStock }) {
  const [selectedSymbol, setSelectedSymbol] = useState('THYAO.IS');

  const handleSelect = (symbol) => {
    setSelectedSymbol(symbol);
    onSelectStock?.(symbol);
  };

  return (
    <div className="stock-selector">
      <div className="selector-header">
        <h3 className="selector-title">BIST WATCHLIST</h3>
        <button className="selector-menu">⋮</button>
      </div>

      <div className="stock-list">
        {CURATED_STOCKS.map((stock) => (
          <div
            key={stock.id}
            className={`stock-item ${selectedSymbol === stock.symbol ? 'active' : ''}`}
            onClick={() => handleSelect(stock.symbol)}
          >
            <div className="stock-info">
              <div className="stock-symbol">{stock.symbol}</div>
              <div className="stock-price">{stock.price.toFixed(2)}</div>
            </div>
            <div className={`stock-change ${stock.change >= 0 ? 'up' : 'dn'}`}>
              <span className="change-pct">{Math.abs(stock.changePercent).toFixed(2)}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
