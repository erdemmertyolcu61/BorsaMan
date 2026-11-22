/**
 * v31.57 — Araştırma betikleri (feature-edge-study, scan-window-review) canlı seçim
 * zincirinin kopyasını useAIAdvisor.js'ten keserek kurar. v31.55'te bir komşu fonksiyon
 * silinince kopya kırıldı ve kimse fark etmedi (betikler CI'da koşmuyor). Bu test,
 * kopyanın kurulabildiğini ve canlı fonksiyonların çağrılabildiğini kilitler.
 */
import { describe, it, expect } from 'vitest';
import { makeLiveReplica } from '../../../scripts/live-ranker-replica.mjs';

describe('canli secim zinciri kopyasi', () => {
  it('useAIAdvisor.js icinden kurulur ve calisir', async () => {
    const live = await makeLiveReplica();
    for (const k of ['_deriveHTFContext', 'calcTomorrowPotential', 'buildResult', 'rejectReason', 'confidenceOf', 'liveStopTarget']) {
      expect(typeof live[k]).toBe('function');
    }
    expect(Number.isFinite(live.calcTomorrowPotential({ score: 60, cls: 'buy', rsi: 55, volRatio: 1.2, change: 1 }))).toBe(true);
  });
});
