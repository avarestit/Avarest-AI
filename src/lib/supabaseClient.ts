import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { validateEnvironmentIsolation } from '../shared/env.ts';

let cachedClient: SupabaseClient | null = null;

export function getPublicSupabaseValidation() {
  return validateEnvironmentIsolation({
    environment: import.meta.env.VITE_ENVIRONMENT,
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
    supabaseKeyPresent: Boolean(import.meta.env.VITE_SUPABASE_ANON_KEY),
  });
}

export function getPublicSupabaseClient(): SupabaseClient | null {
  if (cachedClient) return cachedClient;

  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  const validation = getPublicSupabaseValidation();

  if (!validation.valid || !validation.supabaseConfigured || !url || !anonKey) {
    return null;
  }

  cachedClient = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return cachedClient;
}
