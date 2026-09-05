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
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setLoading(true);
    get<T>(path, ac.signal)
      .then((result) => {
        if (ac.signal.aborted) return;
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || (e as Error).name === 'AbortError') return;
        setError(e instanceof ApiError ? e.message : 'Something went wrong loading this.');
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

/** Polls a resource while `active` is true. Used for live job and task views. */
export function usePolling(callback: () => void, intervalMs: number, active: boolean): void {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => saved.current(), intervalMs);
    return () => clearInterval(id);
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
