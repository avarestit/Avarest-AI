import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, avarestApi, getStoredToken, resolveActiveAuthToken, setStoredToken } from '../lib/api.ts';
import { getPublicSupabaseClient } from '../lib/supabaseClient.ts';
import type { SystemHealthStatus, UserProfile } from '../shared/types.ts';

interface AuthContextValue {
  user: UserProfile | null;
  health: SystemHealthStatus | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName: string) => Promise<{ emailConfirmationRequired?: boolean }>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
  updateProfile: (patch: Partial<Pick<UserProfile, 'fullName' | 'language' | 'experienceMode' | 'memoryConsent'>>) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [health, setHealth] = useState<SystemHealthStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const explicitAuthInFlightRef = useRef(false);

  const refreshSession = useCallback(async () => {
    try {
      const h = await avarestApi.health();
      setHealth(h);
    } catch {
      // ignore initial health failure
    }

    const supa = getPublicSupabaseClient();
    const token = supa ? await resolveActiveAuthToken() : getStoredToken();
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }

    try {
      const res = await avarestApi.getSession();
      setUser(res.user);
    } catch (err) {
      if (supa && err instanceof ApiError && err.status === 401) {
        await supa.auth.signOut({ scope: 'local' }).catch(() => {});
      }
      setStoredToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();

    const supa = getPublicSupabaseClient();
    if (!supa) return;
    const { data: listener } = supa.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION') {
        return;
      }
      if (event === 'SIGNED_OUT' || !session?.access_token) {
        setStoredToken(null);
        setUser(null);
        return;
      }

      setStoredToken(session.access_token);
      if (event === 'TOKEN_REFRESHED' || explicitAuthInFlightRef.current) {
        return;
      }

      void avarestApi
        .getSession()
        .then((res) => setUser(res.user))
        .catch((err) => {
          if (err instanceof ApiError && err.status === 401) {
            setStoredToken(null);
            setUser(null);
          }
        });
    });
    return () => {
      listener.subscription.unsubscribe();
    };
  }, [refreshSession]);

  const signIn = async (email: string, password: string) => {
    const supa = getPublicSupabaseClient();
    if (supa) {
      explicitAuthInFlightRef.current = true;
      try {
        const { data, error } = await supa.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message);
        const token = data.session?.access_token || null;
        setStoredToken(token);
        if (!token) {
          throw new Error('Supabase Auth did not return an active session token.');
        }
        const res = await avarestApi.getSession();
        setUser(res.user);
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setStoredToken(null);
          await supa.auth.signOut({ scope: 'local' }).catch(() => {});
        }
        throw err;
      } finally {
        explicitAuthInFlightRef.current = false;
      }
    }

    const res = await avarestApi.login({ email, password });
    setStoredToken(res.token);
    setUser(res.user);
  };

  const register = async (email: string, password: string, fullName: string) => {
    const supa = getPublicSupabaseClient();
    if (supa) {
      explicitAuthInFlightRef.current = true;
      try {
        const { data, error } = await supa.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName } },
        });
        if (error) throw new Error(error.message);
        if (!data.session) {
          return { emailConfirmationRequired: true };
        }
        setStoredToken(data.session.access_token);
        const res = await avarestApi.getSession();
        setUser(res.user);
        return { emailConfirmationRequired: false };
      } finally {
        explicitAuthInFlightRef.current = false;
      }
    }

    const res = await avarestApi.register({ email, password, fullName });
    setStoredToken(res.token);
    setUser(res.user);
    return { emailConfirmationRequired: false };
  };

  const signOut = async () => {
    const supa = getPublicSupabaseClient();
    if (supa) {
      await supa.auth.signOut().catch(() => {});
    }
    setStoredToken(null);
    setUser(null);
  };

  const updateProfile = async (
    patch: Partial<Pick<UserProfile, 'fullName' | 'language' | 'experienceMode' | 'memoryConsent'>>,
  ) => {
    const res = await avarestApi.updateProfile(patch);
    setUser(res.user);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        health,
        loading,
        signIn,
        register,
        signOut,
        refreshSession,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
