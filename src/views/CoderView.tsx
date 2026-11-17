import React, { useState } from 'react';
import { AlertCircle, Code2, Play, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { avarestApi } from '../lib/api.ts';
import { MarkdownRenderer } from '../components/MarkdownRenderer.tsx';

export function CoderView({ onOpenAuth }: { onOpenAuth: () => void }) {
  const { user } = useAuth();
  const [taskType, setTaskType] = useState<'generate' | 'explain' | 'debug' | 'refactor' | 'review'>('generate');
  const [language, setLanguage] = useState('TypeScript');
  const [prompt, setPrompt] = useState('');
  const [codeContext, setCodeContext] = useState('');
  const [output, setOutput] = useState('');
  const [metaInfo, setMetaInfo] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) {
    return (
      <div className="max-w-xl mx-auto my-12 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-4">
        <h2 className="font-display text-xl font-bold">AI Coder Workspace</h2>
        <p className="text-sm text-slate-500">Sign in to generate, debug, review, and refactor code.</p>
        <button type="button" onClick={onOpenAuth} className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 text-white">
          Sign In
        </button>
      </div>
    );
  }

  const handleRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || running) return;
    setError(null);
    setRunning(true);
    try {
      const res = await avarestApi.runCoder({
        taskType,
        language,
        prompt: prompt.trim(),
        codeContext: codeContext.trim() || undefined,
      });
      setOutput(res.output);
      setMetaInfo(`Routed to ${res.decision.selectedModel} · ${res.tokens.input + res.tokens.output} tokens`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI Coder request failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto w-full space-y-6">
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Code2 className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
              AI Coder
            </h2>
          </div>
          <div className="inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span>External repository writes require explicit GitHub OAuth &amp; human approval.</span>
          </div>
        </div>

        <form onSubmit={handleRun} className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <select
              value={taskType}
              onChange={(e) => setTaskType(e.target.value as typeof taskType)}
              className="px-3 py-2 rounded-xl text-xs font-medium bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
            >
              <option value="generate">Generate Code</option>
              <option value="explain">Explain Code</option>
              <option value="debug">Debug Error</option>
              <option value="refactor">Refactor</option>
              <option value="review">Security &amp; Code Review</option>
            </select>

            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="px-3 py-2 rounded-xl text-xs font-medium bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
            >
              <option value="TypeScript">TypeScript</option>
              <option value="Python">Python</option>
              <option value="SQL">PostgreSQL / SQL</option>
              <option value="Rust">Rust</option>
              <option value="Go">Go</option>
            </select>
          </div>

          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the function, bug fix, or review task..."
            className="w-full px-4 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />

          <textarea
            rows={5}
            value={codeContext}
            onChange={(e) => setCodeContext(e.target.value)}
            placeholder="Optional: paste existing code, stack trace, or diff context..."
            className="w-full px-4 py-3 rounded-xl text-xs font-mono bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />

          <button
            type="submit"
            disabled={running || !prompt.trim()}
            className="px-5 py-2.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white inline-flex items-center gap-2"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{running ? 'Running Analysis...' : 'Run AI Coder'}</span>
          </button>
        </form>

        {error && (
          <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {output && (
        <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-3">
          {metaInfo && <div className="text-xs font-mono text-slate-500">{metaInfo}</div>}
          <MarkdownRenderer content={output} />
        </div>
      )}
    </div>
  );
}
