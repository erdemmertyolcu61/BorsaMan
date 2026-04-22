import { useRef, useEffect, useState, useCallback } from 'react';
import { drawChart } from './chartDraw.js';

export default function Chart({ prices, ind, mcData, smcData, entryZone }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [crosshair, setCrosshair] = useState(null);
  const [viewRange, setViewRange] = useState(null); // {start, end} indices for zoom
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null); // {x, start, end}

  // Auto-set initial view range for large datasets
  useEffect(() => {
    if (!prices || prices.length <= 250 || viewRange) return;
    // Show last 200 bars by default for large datasets
    setViewRange({ start: prices.length - 200, end: prices.length - 1 });
  }, [prices]); // eslint-disable-line react-hooks/exhaustive-deps

  const draw = useCallback(() => {
    drawChart({
      canvas: canvasRef.current,
      container: containerRef.current,
      prices, ind, viewRange, crosshair, mcData, smcData, entryZone,
    });
  }, [prices, ind, crosshair, viewRange, mcData, smcData, entryZone]);

  useEffect(() => { draw(); }, [draw]);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [draw]);

  // Mouse handlers for crosshair and dragging
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0 || !prices) return; // Only left click
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const cur = viewRange || { start: 0, end: prices.length - 1 };
    setIsDragging(true);
    setDragStart({ x, start: cur.start, end: cur.end });
  }, [prices, viewRange]);

  const handleMouseMove = useCallback((e) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setCrosshair({ x, y });

    if (isDragging && dragStart && prices) {
      const w = rect.width;
      const pLeft = 10, pRight = 65;
      const drawW = w - pLeft - pRight;
      const visibleCount = dragStart.end - dragStart.start + 1;
      const pixelsPerCandle = drawW / visibleCount;
      const dx = x - dragStart.x;
      const candleShift = Math.round(-dx / pixelsPerCandle);

      let newStart = dragStart.start + candleShift;
      let newEnd = dragStart.end + candleShift;

      // Bounds check
      if (newStart < 0) {
        newStart = 0;
        newEnd = visibleCount - 1;
      }
      if (newEnd >= prices.length) {
        newEnd = prices.length - 1;
        newStart = Math.max(0, newEnd - visibleCount + 1);
      }

      if (newStart !== (viewRange?.start || 0) || newEnd !== (viewRange?.end || 0)) {
        setViewRange({ start: newStart, end: newEnd });
      }
    }
  }, [isDragging, dragStart, prices, viewRange]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setDragStart(null);
  }, []);

  const handleDoubleClick = useCallback(() => {
    setViewRange(null);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setCrosshair(null);
    if (!isDragging) setIsDragging(false);
  }, [isDragging]);

  // Global mouse up to handle drag release outside canvas
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mouseup', handleMouseUp);
      return () => window.removeEventListener('mouseup', handleMouseUp);
    }
  }, [isDragging, handleMouseUp]);

  // Scroll to zoom
  const handleWheel = useCallback((e) => {
    if (!prices) return;
    const len = prices.length;
    const cur = viewRange || { start: 0, end: len - 1 };
    const visible = cur.end - cur.start + 1;
    // zoom factor: zoom faster when zoomed out, slower when zoomed in
    const zoomIn = e.deltaY < 0;
    const factor = zoomIn ? 0.15 : 0.15;
    const delta = Math.ceil(visible * factor);
    const newVisible = zoomIn ? Math.max(12, visible - delta) : Math.min(len, visible + delta);
    
    // Zoom centered on crosshair if available, else center
    let centerIdx;
    if (crosshair) {
      // Approximate index under mouse
      const rect = canvasRef.current?.getBoundingClientRect();
      const pLeft = 10, pRight = 65;
      const drawW = rect.width - pLeft - pRight;
      centerIdx = cur.start + ((crosshair.x - pLeft) / drawW) * visible;
    } else {
      centerIdx = (cur.start + cur.end) / 2;
    }

    let newStart = Math.round(centerIdx - (newVisible * ((centerIdx - cur.start) / visible)));
    let newEnd = newStart + newVisible - 1;

    if (newStart < 0) { newStart = 0; newEnd = newVisible - 1; }
    if (newEnd >= len) { newEnd = len - 1; newStart = Math.max(0, newEnd - newVisible + 1); }
    
    if (newStart === 0 && newEnd === len - 1) setViewRange(null);
    else setViewRange({ start: newStart, end: newEnd });
  }, [prices, viewRange, crosshair]);

  if (!prices || !ind) {
    return (
      <div className="chart-wrap">
        <div className="ch-ph">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity=".3"><path d="M3 3v18h18"/><path d="M18 17l-5-8-4 5-3-3"/></svg>
          <span>Hisse secip Analiz Et'e basin</span>
        </div>
      </div>
    );
  }

  return (
    <div className="chart-wrap" ref={containerRef} style={{ width: '100%', height: '100%', minHeight: '520px', position: 'relative', background: 'var(--bg0)' }}>
      <canvas 
        ref={canvasRef} 
        style={{ display: 'block', cursor: isDragging ? 'grabbing' : 'crosshair' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove} 
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave} 
        onWheel={e => { e.preventDefault(); handleWheel(e); }}
        onDoubleClick={handleDoubleClick}
      />
      {/* Legend */}
      <div style={{
        position: 'absolute', top: 6, left: 14, zIndex: 10,
        display: 'flex', gap: 10, fontSize: 9, alignItems: 'center',
      }}>
        <span style={{ color: '#ffd600', pointerEvents: 'none' }}>MA20</span>
        <span style={{ color: '#ff9100', pointerEvents: 'none' }}>MA50</span>
        <span style={{ color: '#d500f9', pointerEvents: 'none' }}>MA100</span>
        {ind.ma200 && <span style={{ color: '#00e5ff', pointerEvents: 'none' }}>MA200</span>}
        {ind.bollinger && <span style={{ color: 'rgba(41,121,255,0.6)', pointerEvents: 'none' }}>BB</span>}
        {mcData && <span style={{ color: 'rgba(139,92,246,0.8)', pointerEvents: 'none' }}>MC</span>}
      </div>
      {/* Zoom controls */}
      <div style={{ position: 'absolute', top: 6, right: 70, zIndex: 10, display: 'flex', gap: 4 }}>
        {viewRange && (
          <button onClick={handleDoubleClick} style={{
            background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
            color: 'rgba(255,255,255,0.6)', borderRadius: 3, padding: '2px 8px', fontSize: 9,
            cursor: 'pointer', fontFamily: 'inherit',
          }}>
            Tum Veri
          </button>
        )}
        <button onClick={() => {
          if (!prices) return;
          const len = prices.length;
          setViewRange(len > 60 ? { start: len - 60, end: len - 1 } : null);
        }} style={{
          background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
          color: 'rgba(255,255,255,0.6)', borderRadius: 3, padding: '2px 8px', fontSize: 9,
          cursor: 'pointer', fontFamily: 'inherit',
        }}>
          3A
        </button>
        <button onClick={() => {
          if (!prices) return;
          const len = prices.length;
          setViewRange(len > 130 ? { start: len - 130, end: len - 1 } : null);
        }} style={{
          background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
          color: 'rgba(255,255,255,0.6)', borderRadius: 3, padding: '2px 8px', fontSize: 9,
          cursor: 'pointer', fontFamily: 'inherit',
        }}>
          6A
        </button>
        <button onClick={() => {
          if (!prices) return;
          const len = prices.length;
          setViewRange(len > 252 ? { start: len - 252, end: len - 1 } : null);
        }} style={{
          background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
          color: 'rgba(255,255,255,0.6)', borderRadius: 3, padding: '2px 8px', fontSize: 9,
          cursor: 'pointer', fontFamily: 'inherit',
        }}>
          1Y
        </button>
      </div>
    </div>
  );
}
