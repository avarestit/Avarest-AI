/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { AuthModal } from './components/AuthModal.tsx';
import { Sidebar, type NavSection } from './components/Sidebar.tsx';
import { TopBar, type ThemeMode } from './components/TopBar.tsx';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import { TRANSLATIONS } from './i18n/translations.ts';
import type { ExperienceMode, LanguageCode } from './shared/types.ts';
import { AdminView } from './views/AdminView.tsx';
import { AgentsView } from './views/AgentsView.tsx';
import { BillingView } from './views/BillingView.tsx';
import { BrainView } from './views/BrainView.tsx';
import { ChatView } from './views/ChatView.tsx';
import { CoderView } from './views/CoderView.tsx';
import { HomeView } from './views/HomeView.tsx';
import { IntegrationsView } from './views/IntegrationsView.tsx';
import { KnowledgeView } from './views/KnowledgeView.tsx';
import { ProjectsView } from './views/ProjectsView.tsx';
import { ResearchView } from './views/ResearchView.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { StudioView } from './views/StudioView.tsx';

const THEME_STORAGE_KEY = 'avarest_one_theme';

function getInitialThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    // ignore storage access errors
  }
  return 'system';
}

function AvarestOneShell() {
  const { user, health, signOut, updateProfile } = useAuth();
  const [activeSection, setActiveSection] = useState<NavSection>('home');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialThemeMode);
  const [language, setLanguage] = useState<LanguageCode>('en');
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>('beginner');
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [pendingChatPrompt, setPendingChatPrompt] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // ignore storage errors
    }

    const applyTheme = () => {
      const prefersDark =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      const useDark = themeMode === 'dark' || (themeMode === 'system' && prefersDark);
      document.documentElement.classList.toggle('dark', useDark);
    };

    applyTheme();

    if (themeMode !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => applyTheme();
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }, [themeMode]);

  useEffect(() => {
    if (user) {
      setLanguage(user.language);
      setExperienceMode(user.experienceMode);
    }
  }, [user]);

  const handleChangeLanguage = (lang: LanguageCode) => {
    setLanguage(lang);
    if (user) {
      void updateProfile({ language: lang }).catch(() => {});
    }
  };

  const handleChangeExperienceMode = (mode: ExperienceMode) => {
    setExperienceMode(mode);
    if (user) {
      void updateProfile({ experienceMode: mode }).catch(() => {});
    }
  };

  const t = TRANSLATIONS[language];

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-[#070B14] text-slate-900 dark:text-slate-100">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
        experienceMode={experienceMode}
        user={user}
        t={t}
      />

      <div className="flex-1 flex flex-col min-w-0 min-h-screen">
        <TopBar
          activeSection={activeSection}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          themeMode={themeMode}
          onChangeThemeMode={setThemeMode}
          language={language}
          onChangeLanguage={handleChangeLanguage}
          experienceMode={experienceMode}
          onChangeExperienceMode={handleChangeExperienceMode}
          user={user}
          environmentName={health?.environment || 'staging'}
          onOpenAuth={() => setAuthModalOpen(true)}
          onSignOut={() => {
            void signOut();
            if (activeSection === 'admin') setActiveSection('home');
          }}
          onNewChat={() => {
            setSelectedConversationId(null);
            setActiveSection('chat');
          }}
          onOpenChatSearch={() => setActiveSection('chat')}
          t={t}
        />

        <main className="flex-1 flex flex-col p-4 sm:p-6 overflow-y-auto">
          <div className="flex-1 flex flex-col">
            {activeSection === 'home' && (
              <HomeView
                t={t}
                onNavigate={setActiveSection}
                onStartPromptInChat={(prompt) => {
                  setPendingChatPrompt(prompt);
                  setSelectedConversationId(null);
                  setActiveSection('chat');
                }}
                onOpenConversation={(convId) => {
                  setSelectedConversationId(convId);
                  setActiveSection('chat');
                }}
                onOpenAuth={() => setAuthModalOpen(true)}
              />
            )}

            {activeSection === 'chat' && (
              <ChatView
                t={t}
                experienceMode={experienceMode}
                initialPrompt={pendingChatPrompt}
                onConsumeInitialPrompt={() => setPendingChatPrompt(null)}
                selectedConversationId={selectedConversationId}
                onOpenAuth={() => setAuthModalOpen(true)}
              />
            )}

            {activeSection === 'brain' && <BrainView onOpenAuth={() => setAuthModalOpen(true)} />}
            {activeSection === 'agents' && <AgentsView onOpenAuth={() => setAuthModalOpen(true)} />}
            {activeSection === 'research' && <ResearchView onOpenAuth={() => setAuthModalOpen(true)} />}
            {activeSection === 'coder' && <CoderView onOpenAuth={() => setAuthModalOpen(true)} />}
            {activeSection === 'studio' && <StudioView onOpenAuth={() => setAuthModalOpen(true)} />}
            {activeSection === 'knowledge' && <KnowledgeView onOpenAuth={() => setAuthModalOpen(true)} />}
            {activeSection === 'integrations' && <IntegrationsView onOpenAuth={() => setAuthModalOpen(true)} />}
            {activeSection === 'projects' && <ProjectsView onOpenAuth={() => setAuthModalOpen(true)} />}
            {activeSection === 'billing' && <BillingView onOpenAuth={() => setAuthModalOpen(true)} />}
            {activeSection === 'settings' && (
              <SettingsView
                language={language}
                onChangeLanguage={handleChangeLanguage}
                experienceMode={experienceMode}
                onChangeExperienceMode={handleChangeExperienceMode}
                themeMode={themeMode}
                onChangeThemeMode={setThemeMode}
                onOpenAuth={() => setAuthModalOpen(true)}
              />
            )}
            {activeSection === 'admin' && <AdminView />}
          </div>

          <footer className="mt-8 pt-4 border-t border-slate-200/80 dark:border-slate-800/80 text-center text-xs text-slate-500 dark:text-slate-400 shrink-0">
            Design &amp; Developed by{' '}
            <a
              href="https://avarestsoft.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              Avarest Soft
            </a>
          </footer>
        </main>
      </div>

      <AuthModal open={authModalOpen} onClose={() => setAuthModalOpen(false)} t={t} />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AvarestOneShell />
    </AuthProvider>
  );
}
