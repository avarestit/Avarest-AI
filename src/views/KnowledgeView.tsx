import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Database, Search, Trash2, Upload } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { avarestApi } from '../lib/api.ts';
import type { KnowledgeChunkMatch, KnowledgeDocument, UserMemory } from '../shared/types.ts';

export function KnowledgeView({ onOpenAuth }: { onOpenAuth: () => void }) {
  const { user, updateProfile } = useAuth();
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [matches, setMatches] = useState<KnowledgeChunkMatch[]>([]);
  const [memories, setMemories] = useState<UserMemory[]>([]);
  const [memoryInput, setMemoryInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const loadData = async () => {
    if (!user) return;
    const [dRes, mRes] = await Promise.all([avarestApi.getKnowledgeDocs(), avarestApi.getMemories()]);
    setDocs(dRes.documents);
    setMemories(mRes.memories);
  };

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (!user) {
    return (
      <div className="max-w-xl mx-auto my-12 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-4">
        <h2 className="font-display text-xl font-bold">Knowledge &amp; Memory</h2>
        <p className="text-sm text-slate-500">Sign in to upload documents, search chunks, and manage consent-based memory.</p>
        <button type="button" onClick={onOpenAuth} className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 text-white">
          Sign In
        </button>
      </div>
    );
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    const mime =
      file.type ||
      (file.name.endsWith('.md')
        ? 'text/markdown'
        : file.name.endsWith('.csv')
          ? 'text/csv'
          : file.name.endsWith('.json')
            ? 'application/json'
            : 'text/plain');
    try {
      const content = await file.text();
      await avarestApi.uploadKnowledgeDoc({ fileName: file.name, mimeType: mime, content });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Document upload failed.');
    }
    e.target.value = '';
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    const res = await avarestApi.searchKnowledge(searchQuery.trim());
    setMatches(res.matches);
  };

  const handleToggleConsent = async () => {
    await updateProfile({ memoryConsent: !user.memoryConsent });
  };

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memoryInput.trim()) return;
    setError(null);
    try {
      await avarestApi.addMemory(memoryInput.trim());
      setMemoryInput('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save memory.');
    }
  };

  return (
    <div className="max-w-6xl mx-auto w-full space-y-6">
      {error && (
        <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Documents & Chunking */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Database className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
              Workspace Knowledge Base
            </h2>
          </div>
          <div>
            <input ref={fileRef} type="file" accept=".txt,.md,.csv,.json" onChange={handleUpload} className="hidden" />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white inline-flex items-center gap-1.5"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Upload Text / MD / CSV / JSON</span>
            </button>
          </div>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search indexed knowledge chunks..."
            className="flex-1 px-3.5 py-2 rounded-xl text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-900 dark:bg-slate-800 text-white inline-flex items-center gap-1.5"
          >
            <Search className="w-3.5 h-3.5" />
            <span>Search</span>
          </button>
        </form>

        {matches.length > 0 && (
          <div className="space-y-2 pt-2">
            <div className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">
              Retrieval Matches ({matches.length})
            </div>
            {matches.map((m, idx) => (
              <div key={idx} className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs space-y-1">
                <div className="font-mono text-slate-500">
                  {m.fileName} · Chunk #{m.chunkIndex} · Score {m.score}
                </div>
                <div className="text-slate-800 dark:text-slate-200">{m.content}</div>
              </div>
            ))}
          </div>
        )}

        <div className="overflow-x-auto pt-2">
          {docs.length === 0 ? (
            <p className="text-xs text-slate-400 py-4">No documents uploaded yet.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="pb-2 font-medium">File</th>
                  <th className="pb-2 font-medium">MIME</th>
                  <th className="pb-2 font-medium text-right">Chunks</th>
                  <th className="pb-2 font-medium text-right">Bytes</th>
                  <th className="pb-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td className="py-2.5 font-medium text-slate-800 dark:text-slate-200">{d.fileName}</td>
                    <td className="py-2.5 font-mono text-slate-500">{d.mimeType}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums">{d.chunkCount}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums">{d.byteSize}</td>
                    <td className="py-2.5 text-right">
                      <button
                        type="button"
                        onClick={async () => {
                          await avarestApi.deleteKnowledgeDoc(d.id);
                          await loadData();
                        }}
                        className="p-1 text-slate-400 hover:text-red-500"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Consent-Based User Memory */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
              Consent-Based Personal Memory
            </h3>
            <p className="text-xs text-slate-500">
              Memories are never stored or injected into Avarest Brain prompts unless you explicitly opt in.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleToggleConsent()}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold ${
              user.memoryConsent
                ? 'bg-emerald-600 text-white'
                : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200'
            }`}
          >
            {user.memoryConsent ? 'Memory Consent: Enabled' : 'Memory Consent: Disabled'}
          </button>
        </div>

        <form onSubmit={handleAddMemory} className="flex gap-2">
          <input
            type="text"
            disabled={!user.memoryConsent}
            value={memoryInput}
            onChange={(e) => setMemoryInput(e.target.value)}
            placeholder={user.memoryConsent ? 'Add a persistent preference or fact...' : 'Enable memory consent above to add memories'}
            className="flex-1 px-3.5 py-2 rounded-xl text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!user.memoryConsent || !memoryInput.trim()}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 disabled:opacity-50 text-white"
          >
            Save Memory
          </button>
        </form>

        <div className="space-y-2">
          {memories.length === 0 ? (
            <p className="text-xs text-slate-400">No personal memories stored.</p>
          ) : (
            memories.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs"
              >
                <span className="text-slate-800 dark:text-slate-200">{m.fact}</span>
                <button
                  type="button"
                  onClick={async () => {
                    await avarestApi.deleteMemory(m.id);
                    await loadData();
                  }}
                  className="text-slate-400 hover:text-red-500"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
