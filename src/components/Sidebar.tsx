import React from 'react';
import {
  Bot,
  Brain,
  ChevronLeft,
  ChevronRight,
  Code2,
  CreditCard,
  Database,
  FolderKanban,
  Globe2,
  Home,
  Image,
  Link2,
  MessageSquare,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react';
import { AvarestLogo } from './AvarestLogo.tsx';
import type { TranslationBundle } from '../i18n/translations.ts';
import type { ExperienceMode, UserProfile } from '../shared/types.ts';

export type NavSection =
  | 'home'
  | 'chat'
  | 'brain'
  | 'agents'
  | 'research'
  | 'coder'
  | 'studio'
  | 'knowledge'
  | 'integrations'
  | 'projects'
  | 'billing'
  | 'settings'
  | 'admin';

interface SidebarProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  experienceMode: ExperienceMode;
  user: UserProfile | null;
  t: TranslationBundle;
}

export function Sidebar({
  activeSection,
  onSelectSection,
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile,
  experienceMode,
  user,
  t,
}: SidebarProps) {
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  const coreItems: Array<{ id: NavSection; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'home', label: t.nav.home, icon: Home },
    { id: 'chat', label: t.nav.chat, icon: MessageSquare },
    { id: 'research', label: t.nav.research, icon: Globe2 },
    { id: 'coder', label: t.nav.coder, icon: Code2 },
    { id: 'studio', label: t.nav.studio, icon: Image },
    { id: 'projects', label: t.nav.projects, icon: FolderKanban },
    { id: 'knowledge', label: t.nav.knowledge, icon: Database },
  ];

  const advancedItems: Array<{ id: NavSection; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'brain', label: t.nav.brain, icon: Brain },
    { id: 'agents', label: t.nav.agents, icon: Bot },
    { id: 'integrations', label: t.nav.integrations, icon: Link2 },
    { id: 'billing', label: t.nav.billing, icon: CreditCard },
  ];

  const footerItems: Array<{ id: NavSection; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'settings', label: t.nav.settings, icon: Settings },
  ];

  if (isAdmin) {
    footerItems.push({ id: 'admin', label: t.nav.admin, icon: ShieldCheck });
  }

  const handleSelect = (id: NavSection) => {
    onSelectSection(id);
    onCloseMobile();
  };

  const renderNavList = (items: typeof coreItems, isCollapsed: boolean) =>
    items.map((item) => {
      const active = activeSection === item.id;
      const Icon = item.icon;
      return (
        <button
          key={item.id}
          type="button"
          onClick={() => handleSelect(item.id)}
          title={isCollapsed ? item.label : undefined}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
            active
              ? 'bg-indigo-600 text-white'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          <Icon className="w-4 h-4 shrink-0" />
          {!isCollapsed && <span className="truncate">{item.label}</span>}
        </button>
      );
    });

  const navContent = (isCollapsed: boolean) => (
    <div className="flex flex-col h-full">
      {/* Brand header inside sidebar */}
      <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 shrink-0">
        {!isCollapsed ? (
          <AvarestLogo variant="horizontal" size="sm" />
        ) : (
          <AvarestLogo variant="compact" size="sm" className="mx-auto" />
        )}
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label="Toggle sidebar"
          className="hidden lg:inline-flex p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        >
          {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation"
          className="lg:hidden p-1.5 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Navigation items */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        <div className="space-y-1">{renderNavList(coreItems, isCollapsed)}</div>

        {experienceMode === 'advanced' && (
          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-1">
            {!isCollapsed && (
              <div className="px-3 pb-1.5 text-xs font-medium text-slate-400 dark:text-slate-500">
                Orchestration & Workspace
              </div>
            )}
            {renderNavList(advancedItems, isCollapsed)}
          </div>
        )}
      </div>

      {/* Footer items */}
      <div className="p-3 border-t border-slate-200 dark:border-slate-800 space-y-1 shrink-0">
        {renderNavList(footerItems, isCollapsed)}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Collapsible Sidebar */}
      <aside
        className={`hidden lg:flex flex-col shrink-0 bg-white dark:bg-[#0B1120] border-r border-slate-200 dark:border-slate-800 transition-all duration-150 ${
          collapsed ? 'w-16' : 'w-64'
        }`}
      >
        {navContent(collapsed)}
      </aside>

      {/* Mobile Drawer Overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/50 backdrop-blur-xs"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative w-72 max-w-[85vw] bg-white dark:bg-[#0B1120] border-r border-slate-200 dark:border-slate-800 h-full z-10">
            {navContent(false)}
          </aside>
        </div>
      )}
    </>
  );
}
