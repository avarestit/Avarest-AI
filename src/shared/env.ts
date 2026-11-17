export type EnvironmentName = 'staging' | 'production';

export const SUPABASE_PROJECTS = {
  staging: {
    name: 'avarest-ai-staging',
    url: 'https://wdbtszlcdliwacvztmjl.supabase.co',
    branch: 'develop',
    appDomain: 'https://staging.avarestai.com',
    apiDomain: 'https://api-staging.avarestai.com',
  },
  production: {
    name: 'avarest-ai',
    url: 'https://zdvhksmtxelxcudssdus.supabase.co',
    branch: 'main',
    appDomain: 'https://avarestai.com',
    apiDomain: 'https://api.avarestai.com',
  },
} as const;

export function normalizeEnvironment(raw?: string): EnvironmentName {
  if (raw === 'production') return 'production';
  return 'staging';
}

export interface EnvironmentValidationResult {
  valid: boolean;
  environment: EnvironmentName;
  expectedSupabaseUrl: string;
  configuredSupabaseUrl: string | null;
  supabaseConfigured: boolean;
  errors: string[];
}

export function validateEnvironmentIsolation(params: {
  environment?: string;
  supabaseUrl?: string;
  supabaseKeyPresent?: boolean;
}): EnvironmentValidationResult {
  const environment = normalizeEnvironment(params.environment);
  const expectedSupabaseUrl = SUPABASE_PROJECTS[environment].url;
  const configuredSupabaseUrl = params.supabaseUrl?.trim() || null;
  const errors: string[] = [];

  if (configuredSupabaseUrl) {
    const oppositeEnv: EnvironmentName = environment === 'staging' ? 'production' : 'staging';
    const oppositeUrl = SUPABASE_PROJECTS[oppositeEnv].url;

    if (configuredSupabaseUrl === oppositeUrl) {
      errors.push(
        `CRITICAL ISOLATION VIOLATION: Environment "${environment}" is configured with "${oppositeEnv}" Supabase URL (${configuredSupabaseUrl}).`,
      );
    } else if (configuredSupabaseUrl !== expectedSupabaseUrl) {
      errors.push(
        `Supabase URL mismatch for "${environment}": expected ${expectedSupabaseUrl}, got ${configuredSupabaseUrl}.`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    environment,
    expectedSupabaseUrl,
    configuredSupabaseUrl,
    supabaseConfigured: Boolean(configuredSupabaseUrl && params.supabaseKeyPresent && errors.length === 0),
    errors,
  };
}
