import { describe, it, expect, beforeEach } from 'vitest';

describe('Top10 Intelligence Module', () => {
  it('module exports exist', async () => {
    const mod = await import('../top10Intelligence.js');
    expect(typeof mod.initTop10Intelligence).toBe('function');
    expect(typeof mod.dailyTop10Cycle).toBe('function');
    expect(typeof mod.predictTomorrowTop10).toBe('function');
    expect(typeof mod.getSystemPerformance).toBe('function');
  });

  it('database module exports exist', async () => {
    const mod = await import('../database.js');
    expect(typeof mod.initDatabase).toBe('function');
    expect(typeof mod.getDatabase).toBe('function');
    expect(typeof mod.saveDatabase).toBe('function');
    expect(typeof mod.clearDatabase).toBe('function');
  });

  it('feature engine exports exist', async () => {
    const mod = await import('../featureEngine.js');
    expect(typeof mod.analyzeIndicatorsForTop10).toBe('function');
    expect(typeof mod.findTop10Patterns).toBe('function');
  });

  it('backtest module exports exist', async () => {
    const mod = await import('../top10Backtest.js');
    expect(typeof mod.runTop10Backtest).toBe('function');
    expect(typeof mod.getBacktestHistory).toBe('function');
    expect(typeof mod.runIntradayTop10Strategy).toBe('function');
  });

  it('rule discovery exports exist', async () => {
    const mod = await import('../ruleDiscovery.js');
    expect(typeof mod.discoverRules).toBe('function');
    expect(typeof mod.getTopRules).toBe('function');
  });
});
