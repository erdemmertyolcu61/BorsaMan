// Lightweight OpenTelemetry setup for BIST Terminal
// Provides tracing for fetch operations and signal processing
// Uses Web Tracer API (no external dependencies in browser)

let _tracer = null;
let _traceEnabled = false;

const TELEMETRY_KEY = 'bist_telemetry_enabled';

// ═══ STALE DATA DETECTION ═══
const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const _fetchTimestamps = {}; // { source: timestamp }

export function setFetchTimestamp(source) {
  _fetchTimestamps[source] = Date.now();
}

export function isDataStale(source, thresholdMs = STALE_THRESHOLD_MS) {
  const lastUpdate = _fetchTimestamps[source];
  if (!lastUpdate) return true;
  return Date.now() - lastUpdate > thresholdMs;
}

export function getDataFreshness(source) {
  const lastUpdate = _fetchTimestamps[source];
  if (!lastUpdate) return { stale: true, ageMs: null, ageText: 'Bilinmiyor' };
  
  const ageMs = Date.now() - lastUpdate;
  const ageMin = Math.floor(ageMs / 60000);
  
  return {
    stale: ageMs > STALE_THRESHOLD_MS,
    ageMs,
    ageText: ageMin < 1 ? '<1 dk' : `${ageMin} dk`,
    thresholdMin: STALE_THRESHOLD_MS / 60000
  };
}

export function getAllDataFreshness() {
  const sources = Object.keys(_fetchTimestamps);
  const result = {};
  
  for (const source of sources) {
    result[source] = getDataFreshness(source);
  }
  
  return result;
}

export function initTelemetry(enabled = true) {
  _traceEnabled = enabled && typeof window !== 'undefined';
  
  // Check localStorage preference
  try {
    const stored = localStorage.getItem(TELEMETRY_KEY);
    if (stored !== null) _traceEnabled = stored === 'true';
  } catch {}

  if (_traceEnabled && typeof window !== 'undefined') {
    // Simple console-based tracing (expandable to real OTel collector)
    console.log('[Telemetry] Tracing enabled for fetch & signal operations');
  }
  
  return _traceEnabled;
}

export function setTelemetryEnabled(enabled) {
  _traceEnabled = enabled;
  try {
    localStorage.setItem(TELEMETRY_KEY, String(enabled));
  } catch {}
}

export function isTelemetryEnabled() {
  return _traceEnabled;
}

// Simple tracer implementation (Web Tracer API compatible)
export function getTracer(name = 'bist-terminal') {
  if (!_tracer) {
    _tracer = new SimpleTracer(name);
  }
  return _tracer;
}

class SimpleTracer {
  constructor(name) {
    this.name = name;
    this._spans = [];
  }

  startSpan(name, options = {}) {
    const span = new SimpleSpan(name, options, this);
    if (_traceEnabled) {
      console.log(`[Trace] ${this.name}:start ${name}`);
    }
    return span;
  }

  recordSpan(span) {
    this._spans.push(span);
    // Keep only last 100 spans to avoid memory bloat
    if (this._spans.length > 100) {
      this._spans.shift();
    }
  }

  getSpans() {
    return [...this._spans];
  }

  clearSpans() {
    this._spans = [];
  }
}

class SimpleSpan {
  constructor(name, options, tracer) {
    this.name = name;
    this.tracer = tracer;
    this.startTime = Date.now();
    this.endTime = null;
    this.attributes = options.attributes || {};
    this.status = 'ok';
  }

  setAttribute(key, value) {
    this.attributes[key] = value;
  }

  setStatus(code, message) {
    this.status = code === 0 ? 'ok' : 'error';
    if (message) this.attributes['error.message'] = message;
  }

  end() {
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
    this.tracer.recordSpan(this);
    
    if (_traceEnabled && this.duration > 100) {
      console.log(`[Trace] ${this.tracer.name}:end ${this.name} ${this.duration}ms`);
    }
  }

  recordException(error) {
    this.setStatus(1, error?.message || String(error));
    this.attributes['exception'] = error?.message || String(error);
  }
}

// Convenience wrapper for fetch operations
export function traceFetch(label, fetchFn) {
  if (!_traceEnabled) return fetchFn();
  
  const span = getTracer('fetch').startSpan(label, {
    attributes: { 'http.label': label }
  });
  
  try {
    const result = fetchFn();
    if (result instanceof Promise) {
      return result
        .then(data => {
          span.setAttribute('fetch.success', true);
          span.end();
          return data;
        })
        .catch(err => {
          span.recordException(err);
          span.end();
          throw err;
        });
    }
    span.setAttribute('fetch.success', true);
    span.end();
    return result;
  } catch (err) {
    span.recordException(err);
    span.end();
    throw err;
  }
}

// Metrics collection (simple in-memory)
const _metrics = {
  fetchTotal: 0,
  fetchSuccess: 0,
  fetchFailure: 0,
  fetchLatencySum: 0,
  lastFetch: null,
  bySource: {},
};

export function recordFetchMetric(source, latencyMs, success) {
  _metrics.fetchTotal++;
  if (success) {
    _metrics.fetchSuccess++;
  } else {
    _metrics.fetchFailure++;
  }
  _metrics.fetchLatencySum += latencyMs;
  _metrics.lastFetch = { source, latencyMs, success, ts: Date.now() };
  
  if (!_metrics.bySource[source]) {
    _metrics.bySource[source] = { total: 0, success: 0, latencySum: 0 };
  }
  _metrics.bySource[source].total++;
  if (success) _metrics.bySource[source].success++;
  _metrics.bySource[source].latencySum += latencyMs;
}

export function getMetrics() {
  return {
    ..._metrics,
    avgLatency: _metrics.fetchTotal > 0 ? _metrics.fetchLatencySum / _metrics.fetchTotal : 0,
    successRate: _metrics.fetchTotal > 0 ? (_metrics.fetchSuccess / _metrics.fetchTotal) * 100 : 0,
    bySource: Object.fromEntries(
      Object.entries(_metrics.bySource).map(([k, v]) => [
        k,
        { ...v, avgLatency: v.total > 0 ? v.latencySum / v.total : 0 }
      ])
    )
  };
}

export function resetMetrics() {
  Object.keys(_metrics).forEach(k => {
    if (k === 'bySource') _metrics.bySource = {};
    else _metrics[k] = k === 'lastFetch' ? null : 0;
  });
}

// Auto-init on import (checks localStorage)
if (typeof window !== 'undefined') {
  initTelemetry();
}
