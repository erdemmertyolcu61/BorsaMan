// v31.48: which build is this device running? Shown in Profil so "mobilde guncel
// miyiz?" is answered on the phone itself. __APP_BUILD__ is injected by Vite
// (vite.config.js define) — the Vercel commit, or local git in dev.
/* global __APP_BUILD__ */
export const APP_VERSION = '31.52';

export const BUILD = (typeof __APP_BUILD__ !== 'undefined' && __APP_BUILD__)
  ? __APP_BUILD__
  : { sha: 'dev', time: null };

export function buildLabel() {
  let when = '';
  if (BUILD.time) {
    try {
      when = new Date(BUILD.time).toLocaleString('tr-TR', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul',
      });
    } catch { when = ''; }
  }
  return `Sürüm ${APP_VERSION} · ${BUILD.sha}${when ? ` · ${when}` : ''}`;
}
