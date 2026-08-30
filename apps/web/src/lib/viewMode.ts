import { useCallback, useEffect, useState } from 'react';

/**
 * Easy or Advanced, for the whole application.
 *
 * One setting, not one per page and not one per agent. Somebody is an Easy Mode
 * person or an Advanced person; being dropped into the other because they
 * clicked a different agent is disorienting, and having to find the switch
 * again on each screen is worse.
 *
 * It lives in `localStorage` and is broadcast, so every component showing the
 * switch agrees with every other one the instant it changes — including in
 * another tab, which is what the `storage` event is for.
 */

const KEY = 'ai17z.viewMode';
const EVENT = 'ai17z:viewmode';

export type ViewMode = 'easy' | 'advanced';

export function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(KEY) === 'advanced' ? 'advanced' : 'easy';
  } catch {
    // Private-mode browsers block storage. Easy is the right default anyway.
    return 'easy';
  }
}

export function setViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Not being able to remember it is not worth telling anybody about.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
}

export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(readViewMode);

  useEffect(() => {
    const sync = () => setMode(readViewMode());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return [mode, useCallback((next: ViewMode) => setViewMode(next), [])];
}
