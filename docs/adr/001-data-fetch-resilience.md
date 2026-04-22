# ADR-001: Data Fetch Resilience with Circuit Breaker

## Status
Accepted

## Date
2026-04-21

## Context
The BIST Terminal fetches market data from multiple sources:
- Self-hosted Vercel proxy
- Public CORS proxies (AllOrigins, CorsProxy.io, etc.)
- Direct API calls (Yahoo, BigPara, IsYatirim)

Previously, when a proxy source failed or was slow, the system would:
1. Continue hammering the failing source
2. Cause cascade timeouts across 100+ ticker scans
3. Result in poor user experience and high latency

## Decision
We implemented a lightweight per-source circuit breaker in `fetchEngine.js`:

1. **Failure Threshold**: After 3 consecutive failures, the circuit opens
2. **Backoff**: Exponential backoff (60s base * 2^n) before retry
3. **Race Pattern**: Promise.any picks the first successful proxy
4. **Graceful Degradation**: If all proxies fail, null is returned

### Implementation Details
- `_circuitState` tracks per-label failure count and backoff deadline
- `_isCircuitOpen(label)` checks if a source should be skipped
- `_recordFailure(label)` increments failures, opens circuit at threshold
- `_recordSuccess(label)` resets failure count on success

## Consequences
### Positive
- Faster scans by skipping known-bad proxies
- Automatic recovery when proxies come back
- Reduced latency via Promise.any race pattern

### Negative
- Added complexity in fetchEngine.js
- State persists in memory (no persistence across reloads)

## References
- Original Promise.any race pattern: CLAUDE.md v9
- Test coverage: `src/utils/__tests__/fetchEngine.test.js`
