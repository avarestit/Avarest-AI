import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  Check,
  Copy,
  Edit3,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import type { TranslationBundle } from '../i18n/translations.ts';
import { avarestApi } from '../lib/api.ts';
import type {
  ChatMessage,
  Conversation,
  ExperienceMode,
  ModelCapabilitySpec,
  Project,
} from '../shared/types.ts';
import { MarkdownRenderer } from '../components/MarkdownRenderer.tsx';

interface ChatViewProps {
  t: TranslationBundle;
  experienceMode: ExperienceMode;
  initialPrompt?: string | null;
  onConsumeInitialPrompt?: () => void;
  selectedConversationId?: string | null;
  onOpenAuth: () => void;
}

export function ChatView({
  t,
  experienceMode,
  initialPrompt,
  onConsumeInitialPrompt,
  selectedConversationId,
  onOpenAuth,
}: ChatViewProps) {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<ModelCapabilitySpec[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(selectedConversationId || null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [routingMode, setRoutingMode] = useState<'auto' | 'manual'>('auto');
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [compareMode, setCompareMode] = useState(false);
  const [compareModelId, setCompareModelId] = useState<string>('');
  const [compareOutput, setCompareOutput] = useState<{ model: string; text: string } | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [useKnowledge, setUseKnowledge] = useState(false);
  const [attachment, setAttachment] = useState<{
    fileName: string;
    mimeType: string;
    content: string;
  } | null>(null);

  const [inputText, setInputText] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadWorkspaceData = async (query?: string) => {
    if (!user) return;
    try {
      const [convRes, modelRes, projRes] = await Promise.all([
        avarestApi.getConversations(query),
        avarestApi.getModels(),
        avarestApi.getProjects(),
      ]);
      setConversations(convRes.conversations);
      setModels(modelRes.models);
      setProjects(projRes.projects);
      const configured = modelRes.models.filter((m) => m.configured);
      if (configured.length > 0 && !selectedModelId) {
        setSelectedModelId(configured[0].id);
        setCompareModelId(configured[1]?.id || configured[0].id);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load chat workspace');
    }
  };

  useEffect(() => {
    void loadWorkspaceData(searchTerm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, searchTerm]);

  useEffect(() => {
    if (selectedConversationId) {
      setActiveConvId(selectedConversationId);
    }
  }, [selectedConversationId]);

  useEffect(() => {
    if (!user || !activeConvId) {
      setMessages([]);
      return;
    }
    avarestApi
      .getConversation(activeConvId)
      .then((res) => {
        setMessages(res.conversation.messages || []);
      })
      .catch(() => {
        setMessages([]);
      });
  }, [user, activeConvId]);

  useEffect(() => {
    if (initialPrompt && user) {
      setInputText(initialPrompt);
      onConsumeInitialPrompt?.();
    }
  }, [initialPrompt, user, onConsumeInitialPrompt]);

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setErrorMsg(null);
    const file = e.target.files?.[0];
    if (!file) return;

    const allowedTypes = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];
    const inferredMime =
      file.type ||
      (file.name.endsWith('.md')
        ? 'text/markdown'
        : file.name.endsWith('.csv')
          ? 'text/csv'
          : file.name.endsWith('.json')
            ? 'application/json'
            : 'text/plain');

    if (!allowedTypes.includes(inferredMime)) {
      setErrorMsg('Only text, Markdown, CSV, and JSON files are supported for safe attachment parsing.');
      return;
    }
    if (file.size > 100_000) {
      setErrorMsg('Attachment exceeds 100 KB limit for direct chat context.');
      return;
    }

    const content = await file.text();
    setAttachment({ fileName: file.name, mimeType: inferredMime, content });
    e.target.value = '';
  };

  const sendMessageText = async (promptToSend: string) => {
    if (!user) {
      onOpenAuth();
      return;
    }
    if (!promptToSend.trim() || isStreaming) return;

    setErrorMsg(null);
    setCompareOutput(null);
    setIsStreaming(true);
    setStreamingText('');

    const optimisticUserMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      conversationId: activeConvId || 'pending',
      role: 'user',
      content: attachment ? `${promptToSend}\n\n[Attached: ${attachment.fileName}]` : promptToSend,
      inputTokens: 0,
      outputTokens: 0,
      citations: [],
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    let resolvedConvId = activeConvId;

    try {
      await avarestApi.streamChat(
        {
          conversationId: activeConvId || undefined,
          projectId: selectedProjectId || null,
          prompt: promptToSend,
          routingMode: experienceMode === 'beginner' ? 'auto' : routingMode,
          modelId: routingMode === 'manual' ? selectedModelId : null,
          useKnowledge,
          attachment: attachment || undefined,
        },
        {
          signal: controller.signal,
          onMeta: (meta) => {
            resolvedConvId = meta.conversationId;
            if (!activeConvId) {
              setActiveConvId(meta.conversationId);
            }
          },
          onDelta: (delta) => {
            setStreamingText((prev) => prev + delta);
          },
          onDone: (payload) => {
            setStreamingText('');
            setMessages((prev) => [...prev, payload.message]);
            void loadWorkspaceData(searchTerm);
          },
          onError: (msg) => {
            setErrorMsg(msg);
          },
        },
      );

      // Optional side-by-side comparison if enabled in Advanced mode
      if (compareMode && experienceMode === 'advanced' && compareModelId) {
        const cmpRes = await avarestApi.sendChat({
          conversationId: resolvedConvId || undefined,
          prompt: promptToSend,
          routingMode: 'manual',
          modelId: compareModelId,
        });
        setCompareOutput({
          model: compareModelId,
          text: cmpRes.assistantMessage.content,
        });
      }

      setAttachment(null);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to complete AI chat request.');
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const promptToSend = inputText.trim();
    if (!promptToSend) return;
    setInputText('');
    void sendMessageText(promptToSend);
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setIsStreaming(false);
  };

  const handleRetryLast = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      void sendMessageText(lastUser.content);
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const handleRenameSubmit = async (convId: string) => {
    if (!renameDraft.trim()) {
      setRenamingId(null);
      return;
    }
    await avarestApi.updateConversation(convId, { title: renameDraft.trim() });
    setRenamingId(null);
    void loadWorkspaceData(searchTerm);
  };

  const handleArchive = async (conv: Conversation) => {
    await avarestApi.updateConversation(conv.id, { archived: !conv.archived });
    void loadWorkspaceData(searchTerm);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    await avarestApi.deleteConversation(deleteTarget.id);
    if (activeConvId === deleteTarget.id) {
      setActiveConvId(null);
      setMessages([]);
    }
    setDeleteTarget(null);
    void loadWorkspaceData(searchTerm);
  };

  const configuredModels = models.filter((m) => m.configured);

  if (!user) {
    return (
      <div className="max-w-xl mx-auto my-12 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-4">
        <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
          Sign in to start chatting with Avarest One
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Your conversations, project instructions, and usage history are securely isolated per account.
        </p>
        <button
          type="button"
          onClick={onOpenAuth}
          className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white"
        >
          {t.topbar.signIn}
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-[calc(100vh-7.5rem)]">
      {/* Left Conversation History Panel */}
      <div className="lg:col-span-3 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-4 flex flex-col gap-3">
        <button
          type="button"
          onClick={() => {
            setActiveConvId(null);
            setMessages([]);
            setCompareOutput(null);
          }}
          className="w-full py-2.5 px-3 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white inline-flex items-center justify-center gap-2"
        >
          <Plus className="w-4 h-4" />
          <span>{t.chat.newConversation}</span>
        </button>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t.chat.searchPlaceholder}
            className="w-full pl-8 pr-3 py-2 rounded-lg text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div className="flex-1 overflow-y-auto space-y-1 max-h-[540px]">
          {conversations.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-6">No saved conversations</p>
          ) : (
            conversations.map((conv) => (
              <div
                key={conv.id}
                className={`group rounded-xl p-2.5 border transition-colors ${
                  activeConvId === conv.id
                    ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-800'
                    : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-900'
                }`}
              >
                {renamingId === conv.id ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && void handleRenameSubmit(conv.id)}
                      className="flex-1 px-2 py-1 text-xs rounded border border-indigo-400 bg-white dark:bg-slate-900"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => void handleRenameSubmit(conv.id)}
                      className="p-1 text-emerald-600"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveConvId(conv.id)}
                      className="flex-1 text-left min-w-0"
                    >
                      <div className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                        {conv.title}
                      </div>
                      <div className="text-[11px] text-slate-400 tabular-nums mt-0.5">
                        {conv.archived ? 'Archived · ' : ''}
                        {new Date(conv.updatedAt).toLocaleDateString()}
                      </div>
                    </button>
                    <div className="flex items-center gap-0.5 opacity-80 group-hover:opacity-100">
                      <button
                        type="button"
                        title={t.chat.rename}
                        onClick={() => {
                          setRenamingId(conv.id);
                          setRenameDraft(conv.title);
                        }}
                        className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                      >
                        <Edit3 className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        title={t.chat.archive}
                        onClick={() => void handleArchive(conv)}
                        className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                      >
                        <Archive className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        title={t.chat.confirmDelete}
                        onClick={() => setDeleteTarget(conv)}
                        className="p-1 text-slate-400 hover:text-red-500"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main Chat Pane */}
      <div className="lg:col-span-9 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl flex flex-col overflow-hidden">
        {/* Top Controls Bar */}
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {experienceMode === 'beginner' ? (
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                {t.chat.autoRoutingLabel}
              </span>
            ) : (
              <>
                <select
                  value={routingMode}
                  onChange={(e) => setRoutingMode(e.target.value as 'auto' | 'manual')}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
                >
                  <option value="auto">{t.chat.autoRoutingLabel}</option>
                  <option value="manual">{t.chat.manualModelLabel}</option>
                </select>

                {routingMode === 'manual' && (
                  <select
                    value={selectedModelId}
                    onChange={(e) => setSelectedModelId(e.target.value)}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id} disabled={!m.configured}>
                        {m.providerName} · {m.displayName} {m.configured ? '' : '(Unconfigured)'}
                      </option>
                    ))}
                  </select>
                )}

                {configuredModels.length > 1 && (
                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer ml-1">
                    <input
                      type="checkbox"
                      checked={compareMode}
                      onChange={(e) => setCompareMode(e.target.checked)}
                      className="rounded accent-indigo-600"
                    />
                    <span>{t.chat.compareToggle}</span>
                  </label>
                )}

                {compareMode && configuredModels.length > 1 && (
                  <select
                    value={compareModelId}
                    onChange={(e) => setCompareModelId(e.target.value)}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
                  >
                    {configuredModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        vs {m.displayName}
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}
          </div>

          <div className="flex items-center gap-3">
            {projects.length > 0 && (
              <select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    Project: {p.name}
                  </option>
                ))}
              </select>
            )}

            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={useKnowledge}
                onChange={(e) => setUseKnowledge(e.target.checked)}
                className="rounded accent-indigo-600"
              />
              <span>{t.chat.useKnowledge}</span>
            </label>
          </div>
        </div>

        {/* Messages Stream */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
          {messages.length === 0 && !isStreaming ? (
            <div className="h-full flex flex-col items-center justify-center text-center py-12 space-y-2">
              <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                {t.chat.emptyStateTitle}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md">
                {t.chat.emptyStateDesc}
              </p>
              {configuredModels.length === 0 && (
                <div className="mt-4 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200 max-w-md">
                  No AI provider models are currently active on the server. Configure a provider credential in the Secrets panel to enable live responses.
                </div>
              )}
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col gap-1.5 max-w-3xl ${msg.role === 'user' ? 'ml-auto items-end' : 'items-start'}`}
              >
                <div className="flex items-center gap-2 text-xs text-slate-400 tabular-nums">
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {msg.role === 'user' ? user.fullName : msg.modelId || 'Avarest Brain'}
                  </span>
                  <span>·</span>
                  <span>{new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {msg.outputTokens > 0 && (
                    <>
                      <span>·</span>
                      <span className="font-mono">{msg.inputTokens + msg.outputTokens} tok</span>
                    </>
                  )}
                </div>

                <div
                  className={`px-4 py-3 rounded-2xl text-sm ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-800 w-full'
                  }`}
                >
                  {msg.role === 'user' ? (
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  ) : (
                    <MarkdownRenderer content={msg.content} />
                  )}
                </div>

                {msg.role === 'assistant' && (
                  <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                    {msg.routingReason && <span>{msg.routingReason}</span>}
                    <button
                      type="button"
                      onClick={() => handleCopy(msg.id, msg.content)}
                      className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white"
                    >
                      {copiedId === msg.id ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedId === msg.id ? t.chat.copied : t.chat.copy}</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleRetryLast}
                      className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>{t.chat.retry}</span>
                    </button>
                  </div>
                )}
              </div>
            ))
          )}

          {isStreaming && (
            <div className="max-w-3xl space-y-2">
              <div className="text-xs text-slate-400">Avarest Brain streaming...</div>
              <div className="px-4 py-3 rounded-2xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <MarkdownRenderer content={streamingText || 'Routing request...'} />
              </div>
            </div>
          )}

          {compareOutput && (
            <div className="max-w-3xl p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/70 border border-indigo-200 dark:border-indigo-800 space-y-2">
              <div className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                Comparison Output · {compareOutput.model}
              </div>
              <MarkdownRenderer content={compareOutput.text} />
            </div>
          )}
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div className="mx-4 mb-2 px-4 py-2.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
            <button type="button" onClick={() => setErrorMsg(null)}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Composer */}
        <form onSubmit={handleSubmit} className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-2">
          {attachment && (
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs">
              <span>Attached: {attachment.fileName}</span>
              <button type="button" onClick={() => setAttachment(null)} className="text-slate-400 hover:text-red-500">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.csv,.json"
              onChange={handleFilePick}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title={t.chat.attachFile}
              className="p-3 rounded-xl text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 shrink-0"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={t.home.promptPlaceholder}
              className="flex-1 px-4 py-3 rounded-xl text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />

            {isStreaming ? (
              <button
                type="button"
                onClick={handleStop}
                className="px-4 py-3 rounded-xl text-xs font-semibold bg-red-600 hover:bg-red-700 text-white inline-flex items-center gap-1.5 shrink-0"
              >
                <Square className="w-3.5 h-3.5" />
                <span>{t.chat.stopGenerating}</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!inputText.trim()}
                className="px-5 py-3 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white inline-flex items-center gap-1.5 shrink-0"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </form>
      </div>

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60">
          <div className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 space-y-4">
            <h3 className="font-display font-bold text-base text-slate-900 dark:text-white">
              {t.chat.deleteConfirmTitle}
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              {t.chat.deleteConfirmBody} ({deleteTarget.title})
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
              >
                {t.chat.cancel}
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDelete()}
                className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white"
              >
                {t.chat.confirmDelete}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
