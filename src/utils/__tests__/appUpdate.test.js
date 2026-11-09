/**
 * v31.52 — PWA güncellemesi taramayla yarışmasın. Saf parçalar: paket karşılaştırması
 * ve service worker'ı olmayan ortamda kapının hiç kapanmaması (test/jsdom, eski tarayıcı).
 */
import { describe, it, expect, vi } from 'vitest';
import { isNewerBuild, waitForUpdateCheck, isUpdatePending, setUpdatePending, announceUpdate, UPDATE_EVENT } from '../appUpdate.js';

describe('appUpdate', () => {
  it('farklı commit = yeni paket; yerel geliştirme hiç eski sayılmaz', () => {
    expect(isNewerBuild({ sha: 'fc24b70' }, { sha: '36d2698' })).toBe(true);
    expect(isNewerBuild({ sha: 'fc24b70' }, { sha: 'fc24b70' })).toBe(false);
    expect(isNewerBuild({ sha: 'fc24b70' }, { sha: 'dev' })).toBe(false);
    expect(isNewerBuild(null, { sha: 'abc' })).toBe(false);
    expect(isNewerBuild({}, { sha: 'abc' })).toBe(false);
  });

  it('service worker yoksa otomatik tarama kapıda beklemez', async () => {
    vi.useFakeTimers();
    let opened = false;
    waitForUpdateCheck(10000).then(() => { opened = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBe(true);
    vi.useRealTimers();
  });

  it('bekleyen güncelleme bayrağı ve şerit olayı', () => {
    setUpdatePending(true);
    expect(isUpdatePending()).toBe(true);
    setUpdatePending(false);
    expect(isUpdatePending()).toBe(false);
    const seen = [];
    const on = (e) => seen.push(e.detail.mode);
    window.addEventListener(UPDATE_EVENT, on);
    announceUpdate('scan');
    announceUpdate('scan');            // aynı durum ikinci kez yayınlanmaz
    announceUpdate('stuck', { sha: 'x' });
    window.removeEventListener(UPDATE_EVENT, on);
    expect(seen).toEqual(['scan', 'stuck']);
  });
});
