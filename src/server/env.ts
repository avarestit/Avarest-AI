import { normalizeEnvironment, validateEnvironmentIsolation, type EnvironmentName } from '../shared/env.ts';

export interface ServerBindings {
  AVAREST_ENVIRONMENT?: string;
  VITE_ENVIRONMENT?: string;
  APP_URL?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  AUTH_SESSION_SECRET?: string;
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  XAI_API_KEY?: string;
  LLAMA_API_KEY?: string;
  LLAMA_API_BASE_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
}

export interface ResolvedServerConfig {
  environment: EnvironmentName;
  appUrl: string;
  supabaseUrl: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  supabaseAnonKey: string | undefined;
  supabaseConfigured: boolean;
  isolationErrors: string[];
  authSessionSecret: string;
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

function readVar(bindings: ServerBindings | undefined, key: keyof ServerBindings): string | undefined {
  const fromBinding = bindings?.[key];
  if (typeof fromBinding === 'string' && fromBinding.trim().length > 0) {
    return fromBinding.trim();
  }
  if (typeof process !== 'undefined' && process.env) {
    const fromProcess = process.env[key];
    if (typeof fromProcess === 'string' && fromProcess.trim().length > 0) {
      return fromProcess.trim();
    }
  }
  return undefined;
}

// Ephemeral fallback secret per process only for local/staging when AUTH_SESSION_SECRET is unset
const EPHEMERAL_LOCAL_SECRET = `avarest-local-${crypto.randomUUID()}`;

export function getServerConfig(bindings?: ServerBindings): ResolvedServerConfig {
  const envName = normalizeEnvironment(readVar(bindings, 'AVAREST_ENVIRONMENT'));
  const supabaseUrl = readVar(bindings, 'SUPABASE_URL') || readVar(bindings, 'VITE_SUPABASE_URL');
  const supabaseServiceRoleKey = readVar(bindings, 'SUPABASE_SERVICE_ROLE_KEY');
  const supabaseAnonKey = readVar(bindings, 'VITE_SUPABASE_ANON_KEY');

  const validation = validateEnvironmentIsolation({
    environment: envName,
    supabaseUrl,
    supabaseKeyPresent: Boolean(supabaseServiceRoleKey || supabaseAnonKey),
  });

  const configuredSecret = readVar(bindings, 'AUTH_SESSION_SECRET');

  return {
    environment: envName,
    appUrl: readVar(bindings, 'APP_URL') || 'http://localhost:3000',
    supabaseUrl,
    supabaseServiceRoleKey,
    supabaseAnonKey,
    supabaseConfigured: Boolean(supabaseUrl && supabaseServiceRoleKey && validation.valid),
    isolationErrors: validation.errors,
    authSessionSecret: configuredSecret || EPHEMERAL_LOCAL_SECRET,
    providers: {
      gemini: readVar(bindings, 'GEMINI_API_KEY'),
      openai: readVar(bindings, 'OPENAI_API_KEY'),
      anthropic: readVar(bindings, 'ANTHROPIC_API_KEY'),
      deepseek: readVar(bindings, 'DEEPSEEK_API_KEY'),
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
