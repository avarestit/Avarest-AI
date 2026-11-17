import { normalizeEnvironment, SUPABASE_PROJECTS, validateEnvironmentIsolation, type EnvironmentName } from '../shared/env.ts';

export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface ServerBindings {
  AVAREST_ENVIRONMENT?: string;
  VITE_ENVIRONMENT?: string;
  APP_URL?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  AUTH_SESSION_SECRET?: string;
  ADMIN_BOOTSTRAP_SECRET?: string;
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  XAI_API_KEY?: string;
  LLAMA_API_KEY?: string;
  LLAMA_API_BASE_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  RATE_LIMIT_KV?: KVNamespaceLike;
}

export interface ConfigValidationSummary {
  missingRequired: string[];
  missingOptional: string[];
  warnings: string[];
  authSessionSecretStrong: boolean;
  adminBootstrapSecretStrong: boolean;
}

export interface ResolvedServerConfig {
  environment: EnvironmentName;
  appUrl: string;
  supabaseUrl: string | undefined;
  viteSupabaseUrl: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  supabaseAnonKey: string | undefined;
  supabaseConfigured: boolean;
  isolationErrors: string[];
  authSessionSecret: string;
  adminBootstrapSecret: string | undefined;
  hasRateLimitKv: boolean;
  configValidation: ConfigValidationSummary;
  providers: {
    gemini: string | undefined;
    openai: string | undefined;
    anthropic: string | undefined;
    deepseek: string | undefined;
    xai: string | undefined;
    llama: string | undefined;
    llamaBaseUrl: string;
  };
  oauth: {
    githubConfigured: boolean;
    googleConfigured: boolean;
  };
}

const PLACEHOLDER_PATTERN =
  /^(my_|your_|change_me|replace_me|placeholder|example|dummy-placeholder|sk-placeholder|todo)/i;

export function isPlaceholderValue(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_PATTERN.test(trimmed)) return true;
  if (/^<.*>$/.test(trimmed)) return true;
  if (trimmed === 'MY_GEMINI_API_KEY' || trimmed === 'MY_APP_URL') return true;
  return false;
}

function readVar(bindings: ServerBindings | undefined, key: keyof ServerBindings): string | undefined {
  const fromBinding = bindings?.[key];
  if (typeof fromBinding === 'string' && !isPlaceholderValue(fromBinding)) {
    return fromBinding.trim();
  }
  if (typeof process !== 'undefined' && process.env) {
    const fromProcess = process.env[key as string];
    if (typeof fromProcess === 'string' && !isPlaceholderValue(fromProcess)) {
      return fromProcess.trim();
    }
  }
  return undefined;
}

function readRawPlaceholderWarning(bindings: ServerBindings | undefined, key: keyof ServerBindings): boolean {
  const raw =
    (typeof bindings?.[key] === 'string' ? (bindings[key] as string) : undefined) ??
    (typeof process !== 'undefined' && process.env ? process.env[key as string] : undefined);
  return typeof raw === 'string' && raw.trim().length > 0 && isPlaceholderValue(raw);
}

// Lazy isolate-scoped fallback secret only for local/staging when AUTH_SESSION_SECRET is unset.
// Never evaluated at module import time (Cloudflare Workers disallows crypto.randomUUID in global scope)
// and never used in production.
let cachedEphemeralLocalSecret: string | null = null;

function getOrCreateEphemeralLocalSecret(): string {
  if (!cachedEphemeralLocalSecret) {
    cachedEphemeralLocalSecret = `avarest-local-${crypto.randomUUID()}`;
  }
  return cachedEphemeralLocalSecret;
}

export function getServerConfig(bindings?: ServerBindings): ResolvedServerConfig {
  const envName = normalizeEnvironment(readVar(bindings, 'AVAREST_ENVIRONMENT'));
  const viteEnvRaw = readVar(bindings, 'VITE_ENVIRONMENT');
  const serverSupabaseUrl = readVar(bindings, 'SUPABASE_URL');
  const viteSupabaseUrl = readVar(bindings, 'VITE_SUPABASE_URL');
  const supabaseUrl = serverSupabaseUrl || viteSupabaseUrl;
  const supabaseServiceRoleKey = readVar(bindings, 'SUPABASE_SERVICE_ROLE_KEY');
  const supabaseAnonKey = readVar(bindings, 'VITE_SUPABASE_ANON_KEY');

  const serverValidation = validateEnvironmentIsolation({
    environment: envName,
    supabaseUrl: serverSupabaseUrl,
    supabaseKeyPresent: Boolean(supabaseServiceRoleKey),
  });

  const viteValidation = validateEnvironmentIsolation({
    environment: viteEnvRaw || envName,
    supabaseUrl: viteSupabaseUrl,
    supabaseKeyPresent: Boolean(supabaseAnonKey),
  });

  const isolationErrors: string[] = [...serverValidation.errors];
  for (const err of viteValidation.errors) {
    if (!isolationErrors.includes(err)) {
      isolationErrors.push(err);
    }
  }

  if (viteEnvRaw && normalizeEnvironment(viteEnvRaw) !== envName) {
    isolationErrors.push(
      `CRITICAL ISOLATION VIOLATION: VITE_ENVIRONMENT ("${viteEnvRaw}") mismatches AVAREST_ENVIRONMENT ("${envName}").`,
    );
  }
  if (serverSupabaseUrl && viteSupabaseUrl && serverSupabaseUrl !== viteSupabaseUrl) {
    isolationErrors.push(
      `CRITICAL ISOLATION VIOLATION: SUPABASE_URL (${serverSupabaseUrl}) mismatches VITE_SUPABASE_URL (${viteSupabaseUrl}).`,
    );
  }
  if (
    envName === 'staging' &&
    (serverSupabaseUrl === SUPABASE_PROJECTS.production.url || viteSupabaseUrl === SUPABASE_PROJECTS.production.url)
  ) {
    const msg = `CRITICAL ISOLATION VIOLATION: Staging environment references production Supabase URL (${SUPABASE_PROJECTS.production.url}).`;
    if (!isolationErrors.includes(msg)) isolationErrors.push(msg);
  }

  const configuredSessionSecret = readVar(bindings, 'AUTH_SESSION_SECRET');
  const configuredBootstrapSecret = readVar(bindings, 'ADMIN_BOOTSTRAP_SECRET');
  const authSessionSecretStrong = Boolean(configuredSessionSecret && configuredSessionSecret.length >= 16);
  const adminBootstrapSecretStrong = Boolean(configuredBootstrapSecret && configuredBootstrapSecret.length >= 16);

  const missingRequired: string[] = [];
  if (envName === 'production' || Boolean(supabaseUrl || supabaseServiceRoleKey || supabaseAnonKey)) {
    if (!serverSupabaseUrl) missingRequired.push('SUPABASE_URL');
    if (!supabaseServiceRoleKey) missingRequired.push('SUPABASE_SERVICE_ROLE_KEY');
    if (!viteSupabaseUrl) missingRequired.push('VITE_SUPABASE_URL');
    if (!supabaseAnonKey) missingRequired.push('VITE_SUPABASE_ANON_KEY');
  }
  if (envName === 'production' && !authSessionSecretStrong) {
    missingRequired.push('AUTH_SESSION_SECRET (>= 16 chars)');
  }

  const geminiKey = readVar(bindings, 'GEMINI_API_KEY');
  const openaiKey = readVar(bindings, 'OPENAI_API_KEY');
  const anthropicKey = readVar(bindings, 'ANTHROPIC_API_KEY');
  const deepseekKey = readVar(bindings, 'DEEPSEEK_API_KEY');

  const missingOptional: string[] = [];
  if (!openaiKey) missingOptional.push('OPENAI_API_KEY');
  if (!geminiKey) missingOptional.push('GEMINI_API_KEY');
  if (!anthropicKey) missingOptional.push('ANTHROPIC_API_KEY');
  if (!deepseekKey) missingOptional.push('DEEPSEEK_API_KEY');
  if (!adminBootstrapSecretStrong) missingOptional.push('ADMIN_BOOTSTRAP_SECRET (>= 16 chars)');
  if (!bindings?.RATE_LIMIT_KV) missingOptional.push('RATE_LIMIT_KV');

  const warnings: string[] = [];
  if (configuredSessionSecret && !authSessionSecretStrong) {
    warnings.push('AUTH_SESSION_SECRET is shorter than 16 characters.');
  }
  if (configuredBootstrapSecret && !adminBootstrapSecretStrong) {
    warnings.push('ADMIN_BOOTSTRAP_SECRET is shorter than 16 characters and will keep bootstrap locked.');
  }
  for (const key of [
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ADMIN_BOOTSTRAP_SECRET',
    'AUTH_SESSION_SECRET',
  ] as const) {
    if (readRawPlaceholderWarning(bindings, key)) {
      warnings.push(`Placeholder value detected for ${key}; ignored as unconfigured.`);
    }
  }

  return {
    environment: envName,
    appUrl: readVar(bindings, 'APP_URL') || 'http://localhost:3000',
    supabaseUrl,
    viteSupabaseUrl,
    supabaseServiceRoleKey,
    supabaseAnonKey,
    supabaseConfigured: Boolean(serverSupabaseUrl && supabaseServiceRoleKey && isolationErrors.length === 0),
    isolationErrors,
    authSessionSecret:
      envName === 'production'
        ? authSessionSecretStrong && configuredSessionSecret
          ? configuredSessionSecret
          : ''
        : configuredSessionSecret || getOrCreateEphemeralLocalSecret(),
    adminBootstrapSecret: configuredBootstrapSecret,
    hasRateLimitKv: Boolean(bindings?.RATE_LIMIT_KV),
    configValidation: {
      missingRequired,
      missingOptional,
      warnings,
      authSessionSecretStrong,
      adminBootstrapSecretStrong,
    },
    providers: {
      gemini: geminiKey,
      openai: openaiKey,
      anthropic: anthropicKey,
      deepseek: deepseekKey,
      xai: readVar(bindings, 'XAI_API_KEY'),
      llama: readVar(bindings, 'LLAMA_API_KEY'),
      llamaBaseUrl: readVar(bindings, 'LLAMA_API_BASE_URL') || 'https://api.together.xyz/v1',
    },
    oauth: {
      githubConfigured: Boolean(readVar(bindings, 'GITHUB_CLIENT_ID')),
      googleConfigured: Boolean(readVar(bindings, 'GOOGLE_CLIENT_ID')),
    },
  };
}
