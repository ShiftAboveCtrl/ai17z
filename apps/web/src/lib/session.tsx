import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, get, post, setToken, getToken } from './api';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'OWNER' | 'MEMBER';
}

interface SessionState {
  user: SessionUser | null;
  needsOwner: boolean;
  loading: boolean;
  error: string | null;
  signIn(email: string, password: string): Promise<void>;
  createOwner(input: { email: string; password: string; displayName: string }): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [needsOwner, setNeedsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const status = await get<{ needsOwner: boolean }>('/api/bootstrap/status');
      setNeedsOwner(status.needsOwner);
      if (!status.needsOwner && getToken()) {
        try {
          const me = await get<{ user: SessionUser }>('/api/auth/me');
          setUser(me.user);
        } catch {
          // An expired token is not an error worth showing on load.
          setUser(null);
        }
      }
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the AI17Z API.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await post<{ user: SessionUser; token: string }>('/api/auth/login', { email, password });
    setToken(result.token);
    setUser(result.user);
    setNeedsOwner(false);
  }, []);

  const createOwner = useCallback(async (input: { email: string; password: string; displayName: string }) => {
    const result = await post<{ user: SessionUser; token: string }>('/api/bootstrap/owner', input);
    setToken(result.token);
    setUser(result.user);
    setNeedsOwner(false);
  }, []);

  const signOut = useCallback(async () => {
    await post('/api/auth/logout').catch(() => undefined);
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, needsOwner, loading, error, signIn, createOwner, signOut }),
    [user, needsOwner, loading, error, signIn, createOwner, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
