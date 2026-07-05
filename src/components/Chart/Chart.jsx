import { useRef, useEffect, useState, useCallback } from 'react';
import { drawChart, chartPads } from './chartDraw.js';

export default function Chart({ prices, ind, mcData, smcData, entryZone }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [crosshair, setCrosshair] = useState(null);
  const [viewRange, setViewRange] = useState(null); // {start, end} indices for zoom
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null); // {x, start, end}
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isRotated, setIsRotated] = useState(false);

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

  // Fullscreen change listener to sync state if user exits via hardware back button
  useEffect(() => {
    const handleFsChange = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
      if (!fs) setIsRotated(false);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  // Update rotation state if user physically rotates their device while in fullscreen
  useEffect(() => {
    const handleResize = () => {
      if (isFullscreen) {
        setIsRotated(window.innerHeight > window.innerWidth);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isFullscreen]);

  const lastPinchDistRef = useRef(null);

  const getCoords = useCallback((clientX, clientY) => {
    const cvs = canvasRef.current;
    if (!cvs) return null;
    if (isRotated) {
      return { x: clientY, y: window.innerWidth - clientX, w: cvs.offsetWidth };
    }
    const rect = cvs.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top, w: cvs.offsetWidth };
  }, [isRotated]);

  // Mouse handlers for crosshair and dragging
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0 || !prices) return;
    const coords = getCoords(e.clientX, e.clientY);
    if (!coords) return;
    const cur = viewRange || { start: 0, end: prices.length - 1 };
    setIsDragging(true);
    setDragStart({ x: coords.x, start: cur.start, end: cur.end });
  }, [prices, viewRange, getCoords]);

  const handleMouseMove = useCallback((e) => {
    const coords = getCoords(e.clientX, e.clientY);
    if (!coords) return;
    setCrosshair({ x: coords.x, y: coords.y });

    if (isDragging && dragStart && prices) {
      const { pLeft, pRight } = chartPads(coords.w);
      const drawW = coords.w - pLeft - pRight;
      const visibleCount = dragStart.end - dragStart.start + 1;
      const pixelsPerCandle = drawW / visibleCount;
      const dx = x - dragStart.x;
      const candleShift = Math.round(-dx / pixelsPerCandle);

      let newStart = dragStart.start + candleShift;
      let newEnd = dragStart.end + candleShift;

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
  }, [isDragging, dragStart, prices, viewRange, getCoords]);

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

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mouseup', handleMouseUp);
      return () => window.removeEventListener('mouseup', handleMouseUp);
    }
  }, [isDragging, handleMouseUp]);

  // Touch handlers — mobile UX contract:
  //   • one-finger drag        → pan
  //   • long-press (350ms)     → crosshair inspect mode (OHLC tooltip follows finger)
  //   • two-finger pinch       → zoom anchored at pinch midpoint
  //   • double-tap             → reset zoom (dblclick does not fire on touch)
  const touchModeRef = useRef('pan');      // 'pan' | 'inspect'
  const longPressTimerRef = useRef(null);
  const touchStartPosRef = useRef(null);
  const lastTapTsRef = useRef(0);

  const handleTouchStart = useCallback((e) => {
    if (!prices) return;
    if (e.touches.length === 1) {
      const coords = getCoords(e.touches[0].clientX, e.touches[0].clientY);
      if (!coords) return;

      const now = Date.now();
      if (now - lastTapTsRef.current < 300) {
        // Double-tap → reset zoom
        lastTapTsRef.current = 0;
        setViewRange(null);
        return;
      }
      lastTapTsRef.current = now;

      touchStartPosRef.current = { x: coords.x, y: coords.y };
      touchModeRef.current = 'pan';
      const cur = viewRange || { start: 0, end: prices.length - 1 };
      setIsDragging(true);
      setDragStart({ x: coords.x, start: cur.start, end: cur.end });
      lastPinchDistRef.current = null;

      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(() => {
        touchModeRef.current = 'inspect';
        setIsDragging(false);
        setDragStart(null);
        setCrosshair({ x: coords.x, y: coords.y });
      }, 350);
    } else if (e.touches.length === 2) {
      clearTimeout(longPressTimerRef.current);
      touchModeRef.current = 'pan';
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastPinchDistRef.current = Math.hypot(dx, dy);
      setIsDragging(false);
      setDragStart(null);
      setCrosshair(null);
    }
  }, [prices, viewRange, getCoords]);

  const handleTouchMove = useCallback((e) => {
    if (!prices) return;
    e.preventDefault();

    if (e.touches.length === 1) {
      const coords = getCoords(e.touches[0].clientX, e.touches[0].clientY);
      if (!coords) return;
      const { x, y, w } = coords;

      // Moved before the long-press fired → it's a pan, cancel inspect intent
      const sp = touchStartPosRef.current;
      if (touchModeRef.current === 'pan' && sp && Math.hypot(x - sp.x, y - sp.y) > 10) {
        clearTimeout(longPressTimerRef.current);
      }

      if (touchModeRef.current === 'inspect') {
        setCrosshair({ x, y });
        return;
      }

      if (!isDragging || !dragStart) return;
      const { pLeft, pRight } = chartPads(w);
      const drawW = w - pLeft - pRight;
      const visibleCount = dragStart.end - dragStart.start + 1;
      const pixelsPerCandle = drawW / visibleCount;
      const dx = x - dragStart.x;
      const candleShift = Math.round(-dx / pixelsPerCandle);

      let newStart = dragStart.start + candleShift;
      let newEnd = dragStart.end + candleShift;

      if (newStart < 0) { newStart = 0; newEnd = visibleCount - 1; }
      if (newEnd >= prices.length) { newEnd = prices.length - 1; newStart = Math.max(0, newEnd - visibleCount + 1); }

      setViewRange({ start: newStart, end: newEnd });
    } else if (e.touches.length === 2 && lastPinchDistRef.current != null) {
      const c1 = getCoords(e.touches[0].clientX, e.touches[0].clientY);
      const c2 = getCoords(e.touches[1].clientX, e.touches[1].clientY);
      if (!c1 || !c2) return;

      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const scale = dist / lastPinchDistRef.current;
      lastPinchDistRef.current = dist;

      const len = prices.length;
      const cur = viewRange || { start: 0, end: len - 1 };
      const visible = cur.end - cur.start + 1;
      const newVisible = Math.max(12, Math.min(len, Math.round(visible / scale)));

      // Anchor zoom at the pinch midpoint, not the view center
      const { pLeft, pRight } = chartPads(c1.w);
      const drawW = c1.w - pLeft - pRight;
      const midX = (c1.x + c2.x) / 2;
      const frac = Math.max(0, Math.min(1, (midX - pLeft) / (drawW || 1)));
      const anchorIdx = cur.start + frac * visible;

      let newStart = Math.round(anchorIdx - frac * newVisible);
      let newEnd = newStart + newVisible - 1;
      if (newStart < 0) { newStart = 0; newEnd = newVisible - 1; }
      if (newEnd >= len) { newEnd = len - 1; newStart = Math.max(0, newEnd - newVisible + 1); }

      if (newStart === 0 && newEnd === len - 1) setViewRange(null);
      else setViewRange({ start: newStart, end: newEnd });
    }
  }, [prices, isDragging, dragStart, viewRange, getCoords]);

  const handleTouchEnd = useCallback(() => {
    clearTimeout(longPressTimerRef.current);
    if (touchModeRef.current === 'inspect') setCrosshair(null);
    touchModeRef.current = 'pan';
    setIsDragging(false);
    setDragStart(null);
    lastPinchDistRef.current = null;
  }, []);

  useEffect(() => () => clearTimeout(longPressTimerRef.current), []);

  // Scroll to zoom
  const handleWheel = useCallback((e) => {
    if (!prices) return;
    const len = prices.length;
    const cur = viewRange || { start: 0, end: len - 1 };
    const visible = cur.end - cur.start + 1;
    const zoomIn = e.deltaY < 0;
    const factor = 0.15;
    const delta = Math.ceil(visible * factor);
    const newVisible = zoomIn ? Math.max(12, visible - delta) : Math.min(len, visible + delta);

    let centerIdx;
    if (crosshair) {
      const w = canvasRef.current ? canvasRef.current.offsetWidth : 800;
      const { pLeft, pRight } = chartPads(w);
      const drawW = w - pLeft - pRight;
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

  const toggleFullscreen = useCallback(async () => {
    const nextState = !isFullscreen;
    if (nextState) {
      const isPortrait = window.innerHeight > window.innerWidth;
      let rotated = false;
      
      if (containerRef.current?.requestFullscreen) {
        containerRef.current.requestFullscreen().catch(() => {});
      }
      
      if (window.screen?.orientation?.lock) {
        try {
          await window.screen.orientation.lock('landscape');
        } catch (err) {
          if (isPortrait) rotated = true;
        }
      } else if (isPortrait) {
        rotated = true;
      }
      
      setIsRotated(rotated);
      setIsFullscreen(true);
    } else {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
      if (window.screen?.orientation?.unlock) {
        window.screen.orientation.unlock();
      }
      setIsRotated(false);
      setIsFullscreen(false);
    }
  }, [isFullscreen]);

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

  const containerStyle = isFullscreen ? (
    isRotated ? {
      position: 'fixed', top: '50%', left: '50%',
      width: '100vh', height: '100vw',
      transform: 'translate(-50%, -50%) rotate(90deg)',
      zIndex: 9999, background: 'var(--bg0)',
    } : {
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      zIndex: 9999, background: 'var(--bg0)',
    }
  ) : {
    width: '100%', height: '100%', minHeight: '520px', position: 'relative', background: 'var(--bg0)'
  };

  return (
    <div className="chart-wrap" ref={containerRef} style={containerStyle}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: isDragging ? 'grabbing' : 'crosshair', touchAction: 'none' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={e => { e.preventDefault(); handleWheel(e); }}
        onDoubleClick={handleDoubleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
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
      <div className="ch-zoom-bar">
        {viewRange && (
          <button className="ch-zoom-btn" onClick={handleDoubleClick}>Tum Veri</button>
        )}
        <button className="ch-zoom-btn" onClick={() => {
          if (!prices) return;
          const len = prices.length;
          setViewRange(len > 60 ? { start: len - 60, end: len - 1 } : null);
        }}>
          3A
        </button>
        <button className="ch-zoom-btn" onClick={() => {
          if (!prices) return;
          const len = prices.length;
          setViewRange(len > 130 ? { start: len - 130, end: len - 1 } : null);
        }}>
          6A
        </button>
        <button className="ch-zoom-btn" onClick={() => {
          if (!prices) return;
          const len = prices.length;
          setViewRange(len > 252 ? { start: len - 252, end: len - 1 } : null);
        }}>
          1Y
        </button>
      </div>
      {/* Fullscreen toggle button */}
      <button
        onClick={toggleFullscreen}
        style={{
          position: 'absolute', bottom: 16, right: 16, zIndex: 10,
          background: 'rgba(13, 19, 32, 0.75)', color: '#a8b3c7',
          border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(4px)',
          borderRadius: 8, padding: 8, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}
        title="Tam Ekran"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {isFullscreen ? (
            <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
          ) : (
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
          )}
        </svg>
      </button>
    </div>
  );
}
