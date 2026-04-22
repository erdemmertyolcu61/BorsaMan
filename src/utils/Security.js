// Security.js — Encrypted secret bridge. Prefers Electron safeStorage (OS keychain),
// falls back to base64-obfuscated localStorage in plain browser contexts.

const LS_PREFIX = 'bist_sec_';

function hasElectron() {
  return typeof window !== 'undefined' && !!window.electronAPI?.security;
}

function b64enc(s) { try { return btoa(unescape(encodeURIComponent(s))); } catch { return s; } }
function b64dec(s) { try { return decodeURIComponent(escape(atob(s))); } catch { return s; } }

export default class Security {
  static async isSecure() {
    if (!hasElectron()) return false;
    try {
      const r = await window.electronAPI.security.isAvailable();
      return !!r?.available;
    } catch { return false; }
  }

  static async set(key, value) {
    if (value == null) return this.delete(key);
    if (hasElectron()) {
      const r = await window.electronAPI.security.set(key, String(value));
      if (r?.success) return true;
    }
    try { localStorage.setItem(LS_PREFIX + key, b64enc(String(value))); return true; }
    catch { return false; }
  }

  static async get(key) {
    if (hasElectron()) {
      const r = await window.electronAPI.security.get(key);
      if (r?.value != null) return r.value;
    }
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      return raw == null ? null : b64dec(raw);
    } catch { return null; }
  }

  static async delete(key) {
    if (hasElectron()) {
      try { await window.electronAPI.security.delete(key); } catch {}
    }
    try { localStorage.removeItem(LS_PREFIX + key); } catch {}
    return true;
  }

  static async list() {
    if (hasElectron()) {
      const r = await window.electronAPI.security.list();
      return r?.keys || [];
    }
    try {
      return Object.keys(localStorage)
        .filter(k => k.startsWith(LS_PREFIX))
        .map(k => k.slice(LS_PREFIX.length));
    } catch { return []; }
  }

  // ── One-time migration from plaintext localStorage ──
  static async migrateFromLocalStorage(mapping) {
    if (!hasElectron()) return { migrated: 0 };
    let n = 0;
    for (const [lsKey, secKey] of Object.entries(mapping)) {
      try {
        const v = localStorage.getItem(lsKey);
        if (v) {
          await this.set(secKey, v);
          localStorage.removeItem(lsKey);
          n++;
        }
      } catch {}
    }
    return { migrated: n };
  }
}
