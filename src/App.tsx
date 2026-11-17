/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { AuthModal } from './components/AuthModal.tsx';
import { Sidebar, type NavSection } from './components/Sidebar.tsx';
import { TopBar } from './components/TopBar.tsx';
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

function AvarestOneShell() {
  const { user, health, signOut, updateProfile } = useAuth();
  const [activeSection, setActiveSection] = useState<NavSection>('home');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(true);
  const [language, setLanguage] = useState<LanguageCode>('en');
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>('beginner');
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [pendingChatPrompt, setPendingChatPrompt] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

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

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          activeSection={activeSection}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          darkMode={darkMode}
          onToggleDarkMode={() => setDarkMode((d) => !d)}
          language={language}
          onChangeLanguage={handleChangeLanguage}
          experienceMode={experienceMode}
          onChangeExperienceMode={handleChangeExperienceMode}
          user={user}
          environmentName={health?.environment || 'staging'}
          onOpenAuth={() => setAuthModalOpen(true)}
          onSignOut={() => {
            signOut();
            if (activeSection === 'admin') setActiveSection('home');
          }}
          onNewChat={() => {
            setSelectedConversationId(null);
            setActiveSection('chat');
          }}
          t={t}
        />

        <main className="flex-1 p-4 sm:p-6 overflow-y-auto">
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
              onOpenAuth={() => setAuthModalOpen(true)}
            />
          )}
          {activeSection === 'admin' && <AdminView />}
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
