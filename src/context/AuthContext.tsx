import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { avarestApi, getStoredToken, setStoredToken } from '../lib/api.ts';
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

  const refreshSession = useCallback(async () => {
    try {
      const h = await avarestApi.health();
      setHealth(h);
    } catch {
      // ignore initial health failure
    }

    const supa = getPublicSupabaseClient();
    if (supa) {
      try {
        const { data } = await supa.auth.getSession();
        const accessToken = data.session?.access_token || null;
        setStoredToken(accessToken);
        if (!accessToken) {
          setUser(null);
          setLoading(false);
          return;
        }
      } catch {
        setStoredToken(null);
        setUser(null);
        setLoading(false);
        return;
      }
    }

    const token = getStoredToken();
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }

    try {
      const res = await avarestApi.getSession();
      setUser(res.user);
    } catch {
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
    const { data: listener } = supa.auth.onAuthStateChange((_event, session) => {
      setStoredToken(session?.access_token || null);
      if (session?.access_token) {
        void avarestApi
          .getSession()
          .then((res) => setUser(res.user))
          .catch(() => setUser(null));
      } else {
        setUser(null);
      }
    });
    return () => {
      listener.subscription.unsubscribe();
    };
  }, [refreshSession]);

  const signIn = async (email: string, password: string) => {
    const supa = getPublicSupabaseClient();
    if (supa) {
      const { data, error } = await supa.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      setStoredToken(data.session?.access_token || null);
      const res = await avarestApi.getSession();
      setUser(res.user);
      return;
    }

    const res = await avarestApi.login({ email, password });
    setStoredToken(res.token);
    setUser(res.user);
  };

  const register = async (email: string, password: string, fullName: string) => {
    const supa = getPublicSupabaseClient();
    if (supa) {
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
