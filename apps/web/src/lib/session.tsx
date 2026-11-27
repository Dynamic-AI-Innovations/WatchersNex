import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError, OrgSummary, User } from './api';

interface SessionState {
  status: 'loading' | 'signed-out' | 'signed-in' | 'error';
  user?: User;
  organisations: OrgSummary[];
  error?: ApiError;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<SessionState, 'refresh' | 'signOut'>>({ status: 'loading', organisations: [] });

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setState({ status: 'signed-in', user: me.user, organisations: me.organisations });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setState({ status: 'signed-out', organisations: [] });
      } else {
        setState({ status: 'error', organisations: [], error: error instanceof ApiError ? error : undefined });
      }
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setState({ status: 'signed-out', organisations: [] });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <SessionContext.Provider value={{ ...state, refresh, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
