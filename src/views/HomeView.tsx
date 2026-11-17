import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Code2,
  FolderKanban,
  Globe2,
  Image,
  MessageSquare,
  Send,
  Sparkles,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import type { TranslationBundle } from '../i18n/translations.ts';
import { avarestApi } from '../lib/api.ts';
import type { Conversation, Project, UsageSummary } from '../shared/types.ts';
import type { NavSection } from '../components/Sidebar.tsx';

interface HomeViewProps {
  t: TranslationBundle;
  onNavigate: (section: NavSection) => void;
  onStartPromptInChat: (prompt: string) => void;
  onOpenConversation: (conversationId: string) => void;
  onOpenAuth: () => void;
}

export function HomeView({
  t,
  onNavigate,
  onStartPromptInChat,
  onOpenConversation,
  onOpenAuth,
}: HomeViewProps) {
  const { user, health } = useAuth();
  const [prompt, setPrompt] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) {
      setConversations([]);
      setProjects([]);
      setUsage(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    Promise.all([avarestApi.getConversations(), avarestApi.getProjects(), avarestApi.getUsage()])
      .then(([convRes, projRes, usageRes]) => {
        if (cancelled) return;
        setConversations(convRes.conversations.slice(0, 4));
        setProjects(projRes.projects.slice(0, 4));
        setUsage(usageRes.usage);
      })
      .catch(() => {
        // handled cleanly via empty states
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    if (!user) {
      onOpenAuth();
      return;
    }
    onStartPromptInChat(prompt.trim());
    setPrompt('');
  };

  const quickActions = [
    {
      label: t.home.actions.ask,
      icon: MessageSquare,
      action: () => onNavigate('chat'),
    },
    {
      label: t.home.actions.research,
      icon: Globe2,
      action: () => onNavigate('research'),
    },
    {
      label: t.home.actions.code,
      icon: Code2,
      action: () => onNavigate('coder'),
    },
    {
      label: t.home.actions.create,
      icon: Image,
      action: () => onNavigate('studio'),
    },
    {
      label: t.home.actions.analyze,
      icon: Sparkles,
      action: () => onNavigate('knowledge'),
    },
    {
      label: t.home.actions.agent,
      icon: Bot,
      action: () => onNavigate('agents'),
    },
  ];

  const configuredProvidersCount = health?.providers.filter((p) => p.configured).length ?? 0;

  return (
    <div className="max-w-5xl mx-auto w-full space-y-8 py-4">
      {/* Hero AI Prompt Area */}
      <section className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 sm:p-8 space-y-6">
        <div className="space-y-2 max-w-2xl">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white text-balance">
            {t.home.welcomeTitle}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            {t.home.welcomeSubtitle}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t.home.promptPlaceholder}
            className="flex-1 px-4 py-3 rounded-xl text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white transition-colors whitespace-nowrap shrink-0"
          >
            <span>{t.home.sendButton}</span>
            <Send className="w-4 h-4" />
          </button>
        </form>

        {/* Quick Actions */}
        <div className="space-y-3 pt-2">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {t.home.quickActionsTitle}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {quickActions.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={item.action}
                  className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-xs font-medium bg-slate-50 dark:bg-slate-900 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors whitespace-nowrap"
                >
                  <Icon className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Honest Real Usage & Environment Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-1">
          <div className="text-xs text-slate-500 dark:text-slate-400">Available Credits</div>
          <div className="font-mono text-2xl font-semibold text-slate-900 dark:text-white tabular-nums">
            {user && usage ? usage.balance.toFixed(2) : '—'}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {user ? `Plan: ${user.activePlan}` : 'Sign in to view account balance'}
          </div>
        </div>

        <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-1">
          <div className="text-xs text-slate-500 dark:text-slate-400">Recorded AI Requests</div>
          <div className="font-mono text-2xl font-semibold text-slate-900 dark:text-white tabular-nums">
            {user && usage ? usage.totalRequests : '0'}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {user && usage
              ? `${usage.totalInputTokens + usage.totalOutputTokens} total tokens metered`
              : 'No session active'}
          </div>
        </div>

        <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-1">
          <div className="text-xs text-slate-500 dark:text-slate-400">Configured AI Providers</div>
          <div className="font-mono text-2xl font-semibold text-slate-900 dark:text-white tabular-nums">
            {configuredProvidersCount} / {health?.providers.length ?? 6}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {configuredProvidersCount > 0
              ? 'Server-side provider adapters ready'
              : 'Add provider API keys in server Secrets'}
          </div>
        </div>
      </section>

      {/* Recent Conversations & Projects */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-display font-semibold text-sm text-slate-900 dark:text-white">
              {t.home.recentConversations}
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('chat')}
              className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"
            >
              <span>Open Chat</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {!user ? (
            <div className="py-6 text-xs text-slate-500 dark:text-slate-400 space-y-3">
              <p>Sign in to access persistent conversation history.</p>
              <button
                type="button"
                onClick={onOpenAuth}
                className="px-3.5 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700"
              >
                {t.topbar.signIn}
              </button>
            </div>
          ) : loading ? (
            <div className="py-6 text-xs text-slate-400">Loading conversations...</div>
          ) : conversations.length === 0 ? (
            <p className="py-6 text-xs text-slate-500 dark:text-slate-400">
              {t.home.emptyConversations}
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => onOpenConversation(conv.id)}
                  className="w-full py-3 text-left flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-900/50 px-2 rounded-lg transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                      {conv.title}
                    </div>
                    <div className="text-xs text-slate-400 tabular-nums">
                      {conv.routingMode} · {new Date(conv.updatedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-400 shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-display font-semibold text-sm text-slate-900 dark:text-white">
              {t.home.recentProjects}
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('projects')}
              className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"
            >
              <span>Manage Projects</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {!user ? (
            <p className="py-6 text-xs text-slate-500 dark:text-slate-400">
              Organize conversations and custom instructions inside workspace projects.
            </p>
          ) : loading ? (
            <div className="py-6 text-xs text-slate-400">Loading projects...</div>
          ) : projects.length === 0 ? (
            <p className="py-6 text-xs text-slate-500 dark:text-slate-400">
              {t.home.emptyProjects}
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {projects.map((proj) => (
                <button
                  key={proj.id}
                  type="button"
                  onClick={() => onNavigate('projects')}
                  className="w-full py-3 text-left flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-900/50 px-2 rounded-lg transition-colors"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FolderKanban className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                        {proj.name}
                      </div>
                      <div className="text-xs text-slate-400 truncate">
                        {proj.description || 'No description'}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Onboarding Guidance */}
      <section className="bg-slate-100/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
            {t.home.onboardingTitle}
          </h3>
          <p className="text-xs text-slate-600 dark:text-slate-400 max-w-2xl">
            {t.home.onboardingDesc}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('chat')}
          className="px-4 py-2 rounded-lg text-xs font-semibold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 whitespace-nowrap shrink-0"
        >
          Open Workspace Chat
        </button>
      </section>
    </div>
  );
}
