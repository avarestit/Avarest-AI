import React, { useState } from 'react';
import { CheckCircle2, Shield, XCircle } from 'lucide-react';
import type { ThemeMode } from '../components/TopBar.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import type { ExperienceMode, LanguageCode } from '../shared/types.ts';

export function SettingsView({
  language,
  onChangeLanguage,
  experienceMode,
  onChangeExperienceMode,
  themeMode,
  onChangeThemeMode,
  onOpenAuth,
}: {
  language: LanguageCode;
  onChangeLanguage: (lang: LanguageCode) => void;
  experienceMode: ExperienceMode;
  onChangeExperienceMode: (mode: ExperienceMode) => void;
  themeMode: ThemeMode;
  onChangeThemeMode: (mode: ThemeMode) => void;
  onOpenAuth: () => void;
}) {
  const { user, health, updateProfile } = useAuth();
  const [fullName, setFullName] = useState(user?.fullName || '');
  const [savedNotice, setSavedNotice] = useState(false);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !fullName.trim()) return;
    await updateProfile({ fullName: fullName.trim(), language, experienceMode });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  return (
    <div className="max-w-4xl mx-auto w-full space-y-6">
      {/* User Preferences */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <Shield className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
            Settings &amp; Security
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pb-2 border-b border-slate-100 dark:border-slate-800">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
              Theme Appearance
            </label>
            <select
              value={themeMode}
              onChange={(e) => onChangeThemeMode(e.target.value as ThemeMode)}
              className="w-full px-3.5 py-2 rounded-xl text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
            >
              <option value="system">System (Auto)</option>
              <option value="light">Light Mode</option>
              <option value="dark">Dark Mode</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
              Interface Language
            </label>
            <select
              value={language}
              onChange={(e) => onChangeLanguage(e.target.value as LanguageCode)}
              className="w-full px-3.5 py-2 rounded-xl text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
            >
              <option value="en">English</option>
              <option value="bn">বাংলা (Bengali)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
              Experience Mode
            </label>
            <select
              value={experienceMode}
              onChange={(e) => onChangeExperienceMode(e.target.value as ExperienceMode)}
              className="w-full px-3.5 py-2 rounded-xl text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
            >
              <option value="beginner">Beginner (Automatic Routing)</option>
              <option value="advanced">Advanced (Full Brain &amp; Agent Controls)</option>
            </select>
          </div>
        </div>

        {!user ? (
          <div className="text-xs text-slate-500 space-y-3">
            <p>Sign in to manage your profile, memory consent, and saved preferences.</p>
            <button type="button" onClick={onOpenAuth} className="px-4 py-2 rounded-lg bg-indigo-600 text-white font-semibold">
              Sign In
            </button>
          </div>
        ) : (
          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Full Name
                </label>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Account Role &amp; Email
                </label>
                <div className="px-3.5 py-2 rounded-xl text-xs font-mono bg-slate-100 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300">
                  {user.email} · {user.role}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="submit"
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                Save Preferences
              </button>
              {savedNotice && <span className="text-xs text-emerald-600">Preferences saved.</span>}
            </div>
          </form>
        )}
      </div>

      {/* Environment & Supabase Isolation Status */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-3">
        <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
          Environment, Database &amp; Isolation Verification
        </h3>
        {!health ? (
          <p className="text-xs text-slate-400">Checking environment health...</p>
        ) : (
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-500">Active Environment</span>
              <span className="font-mono font-semibold uppercase">{health.environment}</span>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-500">Expected Supabase URL</span>
              <span className="font-mono text-slate-700 dark:text-slate-300">{health.supabase.expectedUrl}</span>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-500">Persistence &amp; Auth Mode</span>
              <span className="inline-flex items-center gap-1.5 font-medium">
                {health.supabase.dbReachable ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    <span>PostgreSQL Reachable ({health.supabase.dbLatencyMs}ms · {health.supabase.authMode})</span>
                  </>
                ) : health.supabase.configured ? (
                  <>
                    <XCircle className="w-3.5 h-3.5 text-red-500" />
                    <span>Keys Set, DB Unreachable ({health.supabase.dbError || 'Connection failed'})</span>
                  </>
                ) : (
                  <>
                    <XCircle className="w-3.5 h-3.5 text-amber-500" />
                    <span>{health.storageMode} ({health.supabase.authMode})</span>
                  </>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-500">Rate Limiting Adapter</span>
              <span className="font-mono text-slate-700 dark:text-slate-300">{health.rateLimitMode}</span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-slate-500">Isolation Guard</span>
              <span className="font-medium text-emerald-600">
                {health.supabase.isolated ? 'Strict Isolation Verified' : 'Isolation Violation Detected'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
