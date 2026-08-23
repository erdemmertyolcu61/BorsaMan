import { useState, useEffect } from 'react';

/**
 * Track whether the viewport is phone-sized (v31.23).
 *
 * matchMedia is the ONLY source of truth. An earlier version seeded state from
 * window.innerWidth, which reports 0 while the page is not compositing (hidden
 * tab, some WebViews mid-init) — and `0 <= 768` wrongly reads as mobile.
 *
 * Used to swap wide desktop tables for card layouts on phones: the tables
 * scroll horizontally rather than breaking the page, but that pushes the
 * columns people actually came for off-screen.
 */
export function useIsMobile(breakpoint = 768) {
  const query = `(max-width: ${breakpoint}px)`;
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const on = (e) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    if (mq.addEventListener) {
      mq.addEventListener('change', on);
      return () => mq.removeEventListener('change', on);
    }
    mq.addListener(on);                       // Safari < 14
    return () => mq.removeListener(on);
  }, [query]);

  return isMobile;
}

export default useIsMobile;
