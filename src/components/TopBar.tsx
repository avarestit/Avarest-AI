import React from 'react';
import { Globe, LogIn, LogOut, Menu, Monitor, Moon, Plus, Search, Sun } from 'lucide-react';
import type { TranslationBundle } from '../i18n/translations.ts';
import type { ExperienceMode, LanguageCode, UserProfile } from '../shared/types.ts';
import type { NavSection } from './Sidebar.tsx';

export type ThemeMode = 'light' | 'dark' | 'system';

interface TopBarProps {
  activeSection: NavSection;
  onOpenMobileNav: () => void;
  themeMode: ThemeMode;
  onChangeThemeMode: (mode: ThemeMode) => void;
  language: LanguageCode;
  onChangeLanguage: (lang: LanguageCode) => void;
  experienceMode: ExperienceMode;
  onChangeExperienceMode: (mode: ExperienceMode) => void;
  user: UserProfile | null;
  environmentName: 'staging' | 'production';
  onOpenAuth: () => void;
  onSignOut: () => void;
  onNewChat: () => void;
  onOpenChatSearch: () => void;
  t: TranslationBundle;
}

export function TopBar({
  activeSection,
  onOpenMobileNav,
  themeMode,
  onChangeThemeMode,
  language,
  onChangeLanguage,
  experienceMode,
  onChangeExperienceMode,
  user,
  environmentName,
  onOpenAuth,
  onSignOut,
  onNewChat,
  onOpenChatSearch,
  t,
}: TopBarProps) {
  const sectionLabels: Record<NavSection, string> = {
    home: t.nav.home,
    chat: t.nav.chat,
    brain: t.nav.brain,
    agents: t.nav.agents,
    research: t.nav.research,
    coder: t.nav.coder,
    studio: t.nav.studio,
    knowledge: t.nav.knowledge,
    integrations: t.nav.integrations,
    projects: t.nav.projects,
    billing: t.nav.billing,
    settings: t.nav.settings,
    admin: t.nav.admin,
  };

  return (
    <header className="h-14 px-4 sm:px-6 flex items-center justify-between gap-3 bg-white dark:bg-[#0B1120] border-b border-slate-200 dark:border-slate-800 shrink-0">
      {/* Left: Mobile drawer button + Breadcrumb */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Open navigation"
          className="lg:hidden p-2 -ml-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="hidden sm:inline text-slate-400 dark:text-slate-500 whitespace-nowrap">
            {t.brandName}
          </span>
          <span className="hidden sm:inline text-slate-300 dark:text-slate-700">/</span>
          <h1 className="font-display font-semibold text-slate-900 dark:text-white truncate">
            {sectionLabels[activeSection]}
          </h1>
          <span className="hidden md:inline text-xs font-mono text-slate-400 dark:text-slate-500 whitespace-nowrap">
            · {environmentName}
          </span>
        </div>
      </div>

      {/* Right: Mode switch, language, theme (Light/Dark/System), search, new thread, account */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Beginner / Advanced Segmented Control */}
        <div className="hidden sm:flex items-center p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700">
          <button
            type="button"
            onClick={() => onChangeExperienceMode('beginner')}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              experienceMode === 'beginner'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {t.topbar.beginnerMode}
          </button>
          <button
            type="button"
            onClick={() => onChangeExperienceMode('advanced')}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              experienceMode === 'advanced'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {t.topbar.advancedMode}
          </button>
        </div>

        {/* Language Toggle (EN / BN) */}
        <button
          type="button"
          onClick={() => onChangeLanguage(language === 'en' ? 'bn' : 'en')}
          title="Switch language (English / বাংলা)"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <Globe className="w-3.5 h-3.5" />
          <span>{language === 'en' ? 'EN' : 'বাংলা'}</span>
        </button>

        {/* Theme Switcher (Light / Dark / System) */}
        <div
          role="group"
          aria-label="Color theme"
          className="flex items-center p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 shrink-0"
        >
          {(
            [
              { id: 'light', label: 'Light theme', icon: Sun },
              { id: 'dark', label: 'Dark theme', icon: Moon },
              { id: 'system', label: 'System theme', icon: Monitor },
            ] as const
          ).map((opt) => {
            const Icon = opt.icon;
            const active = themeMode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChangeThemeMode(opt.id)}
                title={opt.label}
                aria-label={opt.label}
                aria-pressed={active}
                className={`p-1.5 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  active
                    ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            );
          })}
        </div>

        {user ? (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onOpenChatSearch}
              title={t.chat.searchPlaceholder}
              aria-label="Search threads"
              className="hidden md:inline-flex p-1.5 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 shrink-0"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onNewChat}
              className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t.topbar.newChat}</span>
            </button>
            <button
              type="button"
              onClick={onSignOut}
              title={`${user.email} (${user.role}) — ${t.topbar.signOut}`}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline max-w-[110px] truncate">{user.fullName}</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onOpenAuth}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white transition-colors whitespace-nowrap shrink-0"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>{t.topbar.signIn}</span>
          </button>
        )}
      </div>
    </header>
  );
}
