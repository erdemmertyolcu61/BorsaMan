// useSMCEngine.js — Owns a single SMCEngine instance per component and resets it
// whenever the active symbol changes, preventing OB/FVG bleed across assets.

import { useEffect, useRef } from 'react';
import SMCEngine from '../utils/SMC_Logic_Engine.js';

export function useSMCEngine(symbol) {
  const engineRef = useRef(null);
  if (engineRef.current == null) engineRef.current = new SMCEngine();

  useEffect(() => {
    // Symbol changed (or first mount with a symbol) → clear previous analysis.
    engineRef.current?.reset?.();
  }, [symbol]);

  useEffect(() => () => { engineRef.current?.reset?.(); }, []); // unmount safety

  return engineRef.current;
}

export default useSMCEngine;
