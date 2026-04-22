/**
 * chartDraw.js — Pure canvas painter for the main OHLCV/SMC/MC chart.
 *
 * Extracted from Chart.jsx so:
 *   • The React component only handles refs, state, events (SRP).
 *   • The 400-line imperative canvas pipeline is easy to unit-test / swap.
 *   • Hot-reload no longer re-creates a giant closure on every render.
 *
 * Call site: pass the DOM nodes + data; no React hooks inside.
 */

export function drawChart({ canvas, container, prices, ind, viewRange, crosshair, mcData, smcData, entryZone }) {
  if (!prices || !ind || !canvas || !container) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth;
  const h = container.clientHeight;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);

  const startIdx = viewRange ? viewRange.start : 0;
  const endIdx = viewRange ? viewRange.end : prices.length - 1;
  const visiblePrices = prices.slice(startIdx, endIdx + 1);
  if (visiblePrices.length < 2) return;

  const pTop = 24, pBot = 38, pLeft = 10, pRight = 65;
  const volH = 50;
  const drawW = w - pLeft - pRight;
  const priceH = h - pTop - pBot - volH;

  let minP = Infinity, maxP = -Infinity;
  for (const p of visiblePrices) { minP = Math.min(minP, p.low); maxP = Math.max(maxP, p.high); }

  [ind.ma20, ind.ma50, ind.ma100].forEach(ma => {
    if (!ma) return;
    for (let i = startIdx; i <= endIdx; i++) {
      if (ma[i] != null) { minP = Math.min(minP, ma[i]); maxP = Math.max(maxP, ma[i]); }
    }
  });
  if (ind.bollinger) {
    for (let i = startIdx; i <= endIdx; i++) {
      if (ind.bollinger.upper[i]) maxP = Math.max(maxP, ind.bollinger.upper[i]);
      if (ind.bollinger.lower[i]) minP = Math.min(minP, ind.bollinger.lower[i]);
    }
  }

  const range = (maxP - minP) || 1;
  const margin = range * 0.08;
  const sMin = minP - margin, sMax = maxP + margin, sRange = sMax - sMin;

  const getY = (price) => pTop + priceH - ((price - sMin) / sRange) * priceH;
  const getX = (i) => pLeft + ((i - startIdx) / (visiblePrices.length - 1 || 1)) * drawW;

  let maxVol = 0;
  for (const p of visiblePrices) maxVol = Math.max(maxVol, p.volume || 0);
  if (maxVol === 0) maxVol = 1;
  const volTop = h - pBot - volH;
  const getVolY = (vol) => volTop + volH - (vol / maxVol) * (volH - 4);

  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = pTop + (i / 5) * priceH;
    ctx.moveTo(pLeft, y); ctx.lineTo(w - pRight, y);
    ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.font = '10px JetBrains Mono, monospace';
    const val = sMax - (i / 5) * sRange;
    ctx.fillText(Number.isFinite(val) ? val.toFixed(2) : '—', w - pRight + 8, y + 4);
  }
  ctx.moveTo(pLeft, volTop); ctx.lineTo(w - pRight, volTop);
  ctx.stroke();

  // X-axis date labels
  const labelCount = Math.min(Math.floor(drawW / 80), 8);
  if (labelCount > 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    for (let i = 0; i <= labelCount; i++) {
      const vi = Math.round((i / labelCount) * (visiblePrices.length - 1));
      const bar = visiblePrices[vi];
      if (!bar || !bar.date) continue;
      const d = bar.date instanceof Date ? bar.date : new Date(bar.date);
      const label = d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', timeZone: 'Europe/Istanbul' });
      const x = getX(vi + startIdx);
      ctx.fillText(label, x, h - pBot + 14);
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.moveTo(x, volTop + volH); ctx.lineTo(x, volTop + volH + 3);
      ctx.stroke();
    }
    ctx.textAlign = 'left';
  }

  // Volume bars
  const barW = Math.max(1, (drawW / visiblePrices.length) * 0.65);
  visiblePrices.forEach((p, vi) => {
    const x = getX(vi + startIdx);
    const isUp = p.close >= p.open;
    ctx.fillStyle = isUp ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.2)';
    const vy = getVolY(p.volume || 0);
    ctx.fillRect(x - barW / 2, vy, barW, volTop + volH - vy);
  });

  // Bollinger area
  if (ind.bollinger) {
    ctx.beginPath();
    ctx.fillStyle = 'rgba(41, 121, 255, 0.06)';
    for (let vi = 0; vi < visiblePrices.length; vi++) {
      const i = vi + startIdx;
      const y = ind.bollinger.upper[i] != null ? getY(ind.bollinger.upper[i]) : null;
      if (y == null) continue;
      if (vi === 0) ctx.moveTo(getX(i), y); else ctx.lineTo(getX(i), y);
    }
    for (let vi = visiblePrices.length - 1; vi >= 0; vi--) {
      const i = vi + startIdx;
      const y = ind.bollinger.lower[i] != null ? getY(ind.bollinger.lower[i]) : null;
      if (y == null) continue;
      ctx.lineTo(getX(i), y);
    }
    ctx.fill();
  }

  // Support/Resistance
  if (ind.sr && Array.isArray(ind.sr)) {
    ind.sr.slice(0, 6).forEach(level => {
      const y = getY(level.price);
      if (y < pTop || y > pTop + priceH) return;
      ctx.beginPath();
      ctx.strokeStyle = level.type === 'support' ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.moveTo(pLeft, y); ctx.lineTo(w - pRight, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = level.type === 'support' ? 'rgba(74,222,128,0.5)' : 'rgba(248,113,113,0.5)';
      ctx.font = '8px JetBrains Mono, monospace';
      ctx.fillText((level.type === 'support' ? 'D ' : 'R ') + (level.price || 0).toFixed(2), w - pRight + 3, y - 2);
    });
  }

  // SMC: FVGs
  const fvgs = Array.isArray(smcData?.fvgs) ? smcData.fvgs.filter(g => g && g.active !== false) : [];
  if (fvgs.length) {
    fvgs.slice(0, 8).forEach(g => {
      const xStart = g.index >= startIdx ? getX(g.index) : pLeft;
      const xEnd = w - pRight;
      const yHi = getY(g.gapHigh), yLo = getY(g.gapLow);
      if ([yHi, yLo].some(v => v < pTop - 40 || v > pTop + priceH + 40)) return;
      const isBull = g.type === 'bullish_fvg';
      const fill = isBull ? 'rgba(16,185,129,0.12)' : 'rgba(244,63,94,0.12)';
      const stroke = isBull ? 'rgba(16,185,129,0.45)' : 'rgba(244,63,94,0.45)';
      const top = Math.min(yHi, yLo);
      const ht = Math.max(1, Math.abs(yLo - yHi));
      ctx.fillStyle = fill;
      ctx.fillRect(xStart, top, xEnd - xStart, ht);
      ctx.strokeStyle = stroke; ctx.lineWidth = 0.8; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(xStart, top); ctx.lineTo(xEnd, top); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xStart, top + ht); ctx.lineTo(xEnd, top + ht); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = stroke;
      ctx.font = '8px JetBrains Mono, monospace';
      ctx.fillText(isBull ? 'FVG+' : 'FVG-', xStart + 3, top + 9);
    });
  }

  // SMC: Order Blocks + BOS + entry
  const obs = Array.isArray(smcData?.orderBlocks) ? smcData.orderBlocks.filter(o => o && o.active !== false) : [];
  if (obs.length) {
    obs.slice(0, 4).forEach(o => {
      const yHi = getY(o.zoneHigh), yLo = getY(o.zoneLow);
      if ([yHi, yLo].some(v => v < pTop - 20 || v > pTop + priceH + 20)) return;
      const isBull = o.type === 'bullish_ob';
      ctx.fillStyle = isBull ? 'rgba(74,222,128,0.10)' : 'rgba(248,113,113,0.10)';
      ctx.fillRect(pLeft, Math.min(yHi, yLo), w - pLeft - pRight, Math.abs(yLo - yHi));
      ctx.strokeStyle = isBull ? 'rgba(74,222,128,0.55)' : 'rgba(248,113,113,0.55)';
      ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(pLeft, yHi); ctx.lineTo(w - pRight, yHi); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pLeft, yLo); ctx.lineTo(w - pRight, yLo); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = isBull ? 'rgba(74,222,128,0.75)' : 'rgba(248,113,113,0.75)';
      ctx.font = 'bold 9px JetBrains Mono, monospace';
      ctx.fillText(isBull ? 'BULL OB' : 'BEAR OB', pLeft + 4, Math.min(yHi, yLo) + 10);
    });
  }
  if (smcData?.bos?.breakPrice != null) {
    const y = getY(smcData.bos.breakPrice);
    if (y >= pTop && y <= pTop + priceH) {
      ctx.strokeStyle = smcData.bos.direction === 'bull' ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)';
      ctx.lineWidth = 1; ctx.setLineDash([6, 3]);
      ctx.beginPath(); ctx.moveTo(pLeft, y); ctx.lineTo(w - pRight, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = smcData.bos.direction === 'bull' ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.9)';
      ctx.font = 'bold 9px JetBrains Mono, monospace';
      ctx.fillText('BOS ' + smcData.bos.breakPrice.toFixed(2), pLeft + 4, y - 3);
    }
  }
  if (Number.isFinite(entryZone)) {
    const y = getY(entryZone);
    if (y >= pTop && y <= pTop + priceH) {
      ctx.strokeStyle = 'rgba(34,211,238,0.8)';
      ctx.lineWidth = 1.2; ctx.setLineDash([8, 4]);
      ctx.beginPath(); ctx.moveTo(pLeft, y); ctx.lineTo(w - pRight, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(34,211,238,1)';
      ctx.font = 'bold 9px JetBrains Mono, monospace';
      ctx.fillText('ENTRY ' + entryZone.toFixed(2), pLeft + 4, y - 3);
    }
  }

  // Indicator lines
  const drawLine = (data, color, width = 1.2, dash = []) => {
    if (!data) return;
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
    let first = true;
    for (let vi = 0; vi < visiblePrices.length; vi++) {
      const i = vi + startIdx;
      if (data[i] == null) { first = true; continue; }
      const x = getX(i), y = getY(data[i]);
      if (first) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      first = false;
    }
    ctx.stroke(); ctx.setLineDash([]);
  };

  drawLine(ind.ma20, '#ffd600', 1.5);
  drawLine(ind.ma50, '#ff9100', 1.5);
  drawLine(ind.ma100, '#d500f9', 1.5);
  if (ind.ma200) drawLine(ind.ma200, '#00e5ff', 1, [4, 3]);

  // Candlesticks
  visiblePrices.forEach((p, vi) => {
    const i = vi + startIdx;
    const x = getX(i);
    const yO = getY(p.open), yC = getY(p.close), yH = getY(p.high), yL = getY(p.low);
    const isUp = p.close >= p.open;
    const upColor = '#10b981';
    const dnColor = '#f43f5e';
    ctx.strokeStyle = isUp ? upColor : dnColor;
    ctx.fillStyle = isUp ? upColor : dnColor;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
    const bH = Math.max(1, Math.abs(yC - yO));
    ctx.fillRect(x - barW / 2, Math.min(yO, yC), barW, bH);
  });

  // Monte Carlo overlay
  if (mcData && mcData.p5 && !viewRange) {
    const mcDays = mcData.days || mcData.p50.length - 1;
    const lastIdx = prices.length - 1;
    const lastX = getX(lastIdx);
    const projW = drawW * 0.25;
    const getMcX = (d) => lastX + (d / mcDays) * projW;
    const mcGetY = (price) => pTop + priceH - ((price - sMin) / sRange) * priceH;

    ctx.fillStyle = 'rgba(139,92,246,0.03)';
    ctx.fillRect(lastX, pTop, projW + 10, priceH);
    ctx.fillStyle = 'rgba(139,92,246,0.4)';
    ctx.font = '8px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('MC ' + mcDays + 'G', lastX + projW / 2, pTop + 12);
    ctx.textAlign = 'left';

    ctx.beginPath();
    ctx.fillStyle = 'rgba(239,83,80,0.06)';
    for (let d = 0; d <= mcDays; d++) ctx.lineTo(getMcX(d), mcGetY(mcData.p95[d]));
    for (let d = mcDays; d >= 0; d--) ctx.lineTo(getMcX(d), mcGetY(mcData.p5[d]));
    ctx.closePath(); ctx.fill();

    ctx.beginPath();
    ctx.fillStyle = 'rgba(38,166,154,0.10)';
    for (let d = 0; d <= mcDays; d++) ctx.lineTo(getMcX(d), mcGetY(mcData.p75[d]));
    for (let d = mcDays; d >= 0; d--) ctx.lineTo(getMcX(d), mcGetY(mcData.p25[d]));
    ctx.closePath(); ctx.fill();

    ctx.beginPath(); ctx.strokeStyle = 'rgba(38,166,154,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    for (let d = 0; d <= mcDays; d++) { const x = getMcX(d), y = mcGetY(mcData.p95[d]); d === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke(); ctx.setLineDash([]);

    ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5;
    for (let d = 0; d <= mcDays; d++) { const x = getMcX(d), y = mcGetY(mcData.p50[d]); d === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke();

    ctx.beginPath(); ctx.strokeStyle = 'rgba(239,83,80,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    for (let d = 0; d <= mcDays; d++) { const x = getMcX(d), y = mcGetY(mcData.p5[d]); d === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke(); ctx.setLineDash([]);

    const endX = getMcX(mcDays) + 3;
    const p95Val = mcData.p95 && mcData.p95[mcDays];
    const p50Val = mcData.p50 && mcData.p50[mcDays];
    const p5Val = mcData.p5 && mcData.p5[mcDays];
    ctx.font = '8px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(38,166,154,0.7)'; if (p95Val != null) ctx.fillText(p95Val.toFixed(1), endX, mcGetY(p95Val) + 3);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; if (p50Val != null) ctx.fillText(p50Val.toFixed(1), endX, mcGetY(p50Val) + 3);
    ctx.fillStyle = 'rgba(239,83,80,0.7)';  if (p5Val  != null) ctx.fillText(p5Val.toFixed(1),  endX, mcGetY(p5Val) + 3);

    if (mcData.profitProb != null) {
      const badgeX = lastX + projW / 2 - 22;
      const badgeY = pTop + 18;
      ctx.fillStyle = mcData.profitProb > 55 ? 'rgba(38,166,154,0.15)' : mcData.profitProb < 45 ? 'rgba(239,83,80,0.15)' : 'rgba(255,255,255,0.08)';
      ctx.beginPath(); ctx.roundRect(badgeX, badgeY, 44, 16, 3); ctx.fill();
      ctx.fillStyle = mcData.profitProb > 55 ? '#26a69a' : mcData.profitProb < 45 ? '#ef5350' : 'rgba(255,255,255,0.6)';
      ctx.font = 'bold 8px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('P' + (mcData.profitProb || 0).toFixed(0) + '%', badgeX + 22, badgeY + 11);
      ctx.textAlign = 'left';
    }
  }

  // Crosshair + OHLCV tooltip
  if (crosshair && crosshair.x >= pLeft && crosshair.x <= w - pRight) {
    ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.moveTo(crosshair.x, pTop); ctx.lineTo(crosshair.x, h - pBot); ctx.stroke();
    ctx.moveTo(pLeft, crosshair.y); ctx.lineTo(w - pRight, crosshair.y); ctx.stroke();
    ctx.setLineDash([]);

    const barIdx = Math.round(((crosshair.x - pLeft) / drawW) * (visiblePrices.length - 1));
    if (barIdx >= 0 && barIdx < visiblePrices.length) {
      const bar = visiblePrices[barIdx];
      const priceAtY = sMax - ((crosshair.y - pTop) / priceH) * sRange;
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(w - pRight, crosshair.y - 8, pRight, 16);
      ctx.fillStyle = '#fff';
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillText(priceAtY.toFixed(2), w - pRight + 4, crosshair.y + 4);
      const d = bar.date instanceof Date ? bar.date : new Date(bar.date);
      const dateStr = d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Europe/Istanbul' });
      const isUp = bar.close >= bar.open;
      const o = bar.open || 0, hi = bar.high || 0, l = bar.low || 0, c = bar.close || 0;
      const lines = [
        dateStr,
        'A: ' + o.toFixed(2) + '  Y: ' + hi.toFixed(2),
        'D: ' + l.toFixed(2) + '  K: ' + c.toFixed(2),
        'H: ' + (bar.volume > 1e6 ? (bar.volume / 1e6).toFixed(1) + 'M' : bar.volume > 1e3 ? (bar.volume / 1e3).toFixed(0) + 'K' : (bar.volume || 0)),
      ];
      const tw = 170, th = 58, tx = Math.min(crosshair.x + 12, w - pRight - tw - 5), ty = Math.max(pTop, crosshair.y - th - 5);
      ctx.fillStyle = 'rgba(15,23,42,0.95)';
      ctx.strokeStyle = 'rgba(148,163,184,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = isUp ? '#26a69a' : '#ef5350';
      ctx.font = 'bold 10px JetBrains Mono, monospace';
      ctx.fillText(lines[0], tx + 8, ty + 15);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.fillText(lines[1], tx + 8, ty + 29);
      ctx.fillText(lines[2], tx + 8, ty + 41);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(lines[3], tx + 8, ty + 53);
    }
  }
}
