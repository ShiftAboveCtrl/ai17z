import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Saving while somebody types, without lying to them about it.
 *
 * Three rules, each of which exists because the obvious implementation breaks
 * one of them:
 *
 * A request per keystroke is not autosave, it is a denial of service somebody
 * is performing on their own database. So edits are debounced, and a save
 * already in flight does not race the next one -- the newest draft wins and the
 * stale response is discarded rather than overwriting it.
 *
 * "Saved" must mean saved. Showing it optimistically and then failing quietly
 * is worse than showing nothing, because the person closes the tab believing
 * their work is safe. The state only becomes `saved` when the server said so.
 *
 * And a failure has to stay visible. A toast that disappears after three
 * seconds is not a way to tell somebody their agent did not save.
 */

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';

const KEY = 'ai17z.autosave';

/** Whether autosave is on, remembered across sessions and shared between tabs. */
export function readAutosaveEnabled(): boolean {
  try {
    // Off by default. Turning it on is a choice somebody makes about their own
    // editing, and a version history that fills itself in unasked is a surprise.
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function setAutosaveEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // A browser that refuses storage still autosaves for this session.
  }
  window.dispatchEvent(new CustomEvent('ai17z:autosave', { detail: on }));
}

export function useAutosaveEnabled(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readAutosaveEnabled);
  useEffect(() => {
    const sync = () => setOn(readAutosaveEnabled());
    window.addEventListener('ai17z:autosave', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('ai17z:autosave', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return [on, useCallback((next: boolean) => setAutosaveEnabled(next), [])];
}

export interface AutosaveOptions<T> {
  /** Current editor contents. Compared by value, so no change means no save. */
  draft: T;
  /** What was last persisted, so a fresh screen does not save on arrival. */
  saved: T | null;
  enabled: boolean;
  /** Quiet time before a save. Long enough that typing does not trigger it. */
  delayMs?: number;
  save: (draft: T) => Promise<void>;
}

export interface AutosaveResult {
  state: SaveState;
  /** Present only while state is `failed`, and stays until the next success. */
  error: string | null;
  /** Force a save now, for an explicit button. */
  saveNow: () => Promise<void>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function useAutosave<T>(options: AutosaveOptions<T>): AutosaveResult {
  const { draft, saved, enabled, save, delayMs = 1_500 } = options;
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  const inFlight = useRef(false);
  const latest = useRef(draft);
  latest.current = draft;
  // What the last save attempt sent, so a retry of the same content is skipped.
  const attempted = useRef<T | null>(saved);

  const run = useCallback(async () => {
    // A save arriving while one is in flight must not be dropped.
    //
    // Returning early looks like it just skips a redundant request, but the
    // skipped one is never rescheduled: the newest text stays unsaved, the
    // label sits on "Saving" for ever, and the person believes their work is
    // going in. So the loop keeps going until what was sent is what the editor
    // currently holds.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      // Bounded: a draft changing faster than the network can keep up should
      // settle rather than spin, and the next edit schedules another pass.
      for (let pass = 0; pass < 5; pass += 1) {
        const snapshot = latest.current;
        if (same(snapshot, attempted.current)) break;

        setState('saving');
        try {
          await save(snapshot);
        } catch (e) {
          setState('failed');
          setError(e instanceof Error ? e.message : 'That could not be saved.');
          return;
        }
        attempted.current = snapshot;
        setError(null);

        if (same(latest.current, snapshot)) {
          // Only now. Optimistic success is how somebody closes a tab
          // believing their work is safe when it is not.
          setState('saved');
          return;
        }
      }
      setState(same(latest.current, attempted.current) ? 'saved' : 'dirty');
    } finally {
      inFlight.current = false;
    }
  }, [save]);

  useEffect(() => {
    if (!enabled) return;
    if (same(draft, attempted.current)) return;

    setState((current) => (current === 'failed' ? current : 'dirty'));
    const timer = setTimeout(() => void run(), delayMs);
    return () => clearTimeout(timer);
  }, [draft, enabled, delayMs, run]);

  return { state, error, saveNow: run };
}

/** The words shown next to an editor. Plain, and never optimistic. */
export function describeSaveState(state: SaveState): string {
  switch (state) {
    case 'saving':
      return 'Saving';
    case 'saved':
      return 'Saved';
    case 'failed':
      return 'Not saved';
    case 'dirty':
      return 'Unsaved changes';
    default:
      return '';
  }
}
