import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fetchImageObjectUrl, get } from './api';

/** Respects the OS setting and re-evaluates if the user changes it mid-session. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false,
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);
  return reduced;
}

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * The last answer for each path, and when it arrived.
 *
 * The agent page renders one area at a time, so moving between two of them
 * unmounts every section in the first and mounts every section in the second.
 * Clicking Reach, Memory, Reach, Memory, Reach asked for accounts, providers,
 * tools, memories, knowledge, relationships and learned items eighteen times
 * over, for data that had not changed in the four seconds it took.
 *
 * Two seconds, because that is about the length of a decision somebody makes
 * with the mouse: long enough to cover flicking between areas, far too short
 * to show anybody a value that has since changed. Anything longer would start
 * being a cache, which this deliberately is not -- nothing is served from here
 * after two seconds, and `reload()` never reads it at all.
 */
const FRESH_MS = 2_000;

const recent = new Map<string, { at: number; data: unknown }>();

/** Forgets everything. Called on sign-out: the next person is a different person. */
export function forgetFetchedResources(): void {
  recent.clear();
}

/** Fetches a JSON resource, aborting in flight when the path changes or unmounts. */
export function useResource<T>(path: string | null, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [nonce, setNonce] = useState(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }

    /*
      A component mounting for the first time takes an answer that is seconds
      old. One that has reloaded is asking for a reason -- it has just written
      something, or it is a poller -- and always goes and looks.
    */
    const cached = recent.get(path);
    if (nonce === 0 && cached && Date.now() - cached.at < FRESH_MS) {
      setData(cached.data as T);
      setError(null);
      setLoading(false);
      return;
    }

    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setLoading(true);
    get<T>(path, ac.signal)
      .then((result) => {
        // Recorded even when this caller has gone: the value is good, and the
        // next thing to ask for the same path is usually a moment away.
        recent.set(path, { at: Date.now(), data: result });
        if (ac.signal.aborted) return;
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || (e as Error).name === 'AbortError') return;
        recent.delete(path);
        setError(e instanceof ApiError ? e.message : 'Something went wrong loading this.');
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  const reload = useCallback(() => {
    // Never from the record: a reload follows a write, and reading back what
    // was there before it would report the write as having done nothing.
    if (path) recent.delete(path);
    setNonce((n) => n + 1);
  }, [path]);
  return { data, error, loading, reload };
}

/**
 * Polls a resource while `active` is true and somebody is looking.
 *
 * Thirteen of these run across the interface and six never stop: the agent's
 * status every five seconds, notifications, the pause switch, browser tabs,
 * health, the inbox. AI17Z is left open -- it is the window somebody glances
 * at while the agent works -- so a tab sitting behind an editor all afternoon
 * was asking a local API a few thousand questions to render pixels nobody was
 * looking at, on the same machine the agent is driving a browser on.
 *
 * Two rules, and the second is what makes the first safe:
 *
 *   - nothing is asked while the document is hidden;
 *   - one poll fires the moment it is visible again, so what somebody comes
 *     back to is current rather than however stale it was when they left.
 *
 * Without the second, this would trade wasted requests for a screen that lies
 * for up to one interval, which is the worse of the two.
 */
export function usePolling(callback: () => void, intervalMs: number, active: boolean): void {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!active) return;

    let id: number | null = null;
    const stop = () => {
      if (id !== null) window.clearInterval(id);
      id = null;
    };
    const start = () => {
      if (id !== null) return;
      id = window.setInterval(() => saved.current(), intervalMs);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stop();
        return;
      }
      saved.current();
      start();
    };

    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, active]);
}

/**
 * Seconds since `active` last became true, or 0 while it is false.
 *
 * The point of showing this is not precision. An operation that has been going
 * for forty seconds and one that has hung look identical behind a spinner, and
 * the number is what lets somebody tell them apart without guessing.
 */
export function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}

/**
 * An image URL a plain `<img>` can use.
 *
 * Anything AI17Z stores itself lives behind the authenticated artifact route,
 * which an `<img src>` cannot reach -- it sends no Authorization header. This
 * fetches it properly and hands back an object URL; an external portrait URL
 * passes straight through untouched.
 *
 * The object URL is revoked when it is replaced or the component goes away.
 * Without that, changing a picture a few times leaks the old blobs for as long
 * as the tab is open.
 */
export function useAuthedImage(url: string | null | undefined): string | null {
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setResolved(null);
      return;
    }
    if (!url.startsWith('/api/')) {
      setResolved(url);
      return;
    }

    let objectUrl: string | null = null;
    let cancelled = false;
    void fetchImageObjectUrl(url)
      .then((next) => {
        if (cancelled) {
          // Arrived after the component moved on. Release it rather than
          // holding a blob nothing will ever draw.
          URL.revokeObjectURL(next);
          return;
        }
        objectUrl = next;
        setResolved(next);
      })
      // A missing picture is a missing picture. The glyph takes over.
      .catch(() => setResolved(null));

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return resolved;
}
