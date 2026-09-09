import { describe, it, expect } from 'vitest';
import { resolveProxyBaseUrl, isLocalDevHost, DEFAULT_PROXY_URL } from '../proxyTarget.js';

describe('proxyTarget.resolveProxyBaseUrl', () => {
  it('PWA gets the deployed proxy — the case that was broken', () => {
    // A PWA has no window.Capacitor, so the old native-only condition fell
    // through to '' and every request went to the public CORS proxy race.
    const r = resolveProxyBaseUrl({ hostname: 'bist.example.app', origin: 'https://bist.example.app' });
    expect(r).toEqual({ url: DEFAULT_PROXY_URL, source: 'default' });
  });

  it('Capacitor native keeps working', () => {
    expect(resolveProxyBaseUrl({ hostname: 'localhost:', capacitorNative: true }).url).toBe(DEFAULT_PROXY_URL);
  });

  it('a stored setting beats everything', () => {
    const r = resolveProxyBaseUrl({
      stored: 'https://my-own-proxy.vercel.app',
      hostname: 'bist.example.app', origin: 'https://bist.example.app',
    });
    expect(r).toEqual({ url: 'https://my-own-proxy.vercel.app', source: 'stored' });
  });

  it('trims trailing slashes and whitespace from a stored value', () => {
    expect(resolveProxyBaseUrl({ stored: '  https://x.vercel.app///  ' }).url).toBe('https://x.vercel.app');
  });

  it('ignores an empty or whitespace-only stored value', () => {
    for (const bad of ['', '   ', null, undefined]) {
      expect(resolveProxyBaseUrl({ stored: bad, hostname: 'phone.app' }).source).toBe('default');
    }
  });

  it('same-origin when the app is served next to the proxy', () => {
    const r = resolveProxyBaseUrl({ hostname: 'proxy-delta-mocha-43.vercel.app', origin: 'https://proxy-delta-mocha-43.vercel.app' });
    expect(r).toEqual({ url: 'https://proxy-delta-mocha-43.vercel.app', source: 'same-origin' });
  });

  it('local dev returns empty so the Vite proxy handles /api/*', () => {
    // Returning the deployed proxy here would break `npm run dev`.
    for (const h of ['localhost', '127.0.0.1', '[::1]', 'macbook.local']) {
      expect(resolveProxyBaseUrl({ hostname: h }), h).toEqual({ url: '', source: 'local-dev' });
    }
  });

  it('local dev wins over the default even with an origin present', () => {
    expect(resolveProxyBaseUrl({ hostname: 'localhost', origin: 'http://localhost:3000' }).url).toBe('');
  });

  it('is defensive with no environment at all', () => {
    expect(resolveProxyBaseUrl().url).toBe(DEFAULT_PROXY_URL);
    expect(resolveProxyBaseUrl({}).source).toBe('default');
  });
});

describe('proxyTarget.isLocalDevHost', () => {
  it('recognises the dev hosts and nothing else', () => {
    expect(isLocalDevHost('localhost')).toBe(true);
    expect(isLocalDevHost('127.0.0.1')).toBe(true);
    expect(isLocalDevHost('proxy-delta-mocha-43.vercel.app')).toBe(false);
    expect(isLocalDevHost('')).toBe(false);
    expect(isLocalDevHost(undefined)).toBe(false);
  });
});
