import React, { useEffect, useState } from 'react';
import { AlertCircle, ExternalLink, Globe2, Search } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { avarestApi } from '../lib/api.ts';
import type { ResearchReport } from '../shared/types.ts';
import { MarkdownRenderer } from '../components/MarkdownRenderer.tsx';

export function ResearchView({ onOpenAuth }: { onOpenAuth: () => void }) {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [reports, setReports] = useState<ResearchReport[]>([]);
  const [activeReport, setActiveReport] = useState<ResearchReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    avarestApi
      .getResearchReports()
      .then((res) => {
        setReports(res.reports);
        if (res.reports[0]) setActiveReport(res.reports[0]);
      })
      .catch(() => {});
  }, [user]);

  const handleRunResearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      onOpenAuth();
      return;
    }
    if (!query.trim() || running) return;
    setError(null);
    setRunning(true);
    try {
      const res = await avarestApi.runResearch(query.trim());
      setReports((prev) => [res.report, ...prev]);
      setActiveReport(res.report);
      setQuery('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Research request failed.');
    } finally {
      setRunning(false);
    }
  };

  if (!user) {
    return (
      <div className="max-w-xl mx-auto my-12 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-4">
        <h2 className="font-display text-xl font-bold">Deep Research Workspace</h2>
        <p className="text-sm text-slate-500">Sign in to run citation-aware research briefs.</p>
        <button type="button" onClick={onOpenAuth} className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 text-white">
          Sign In
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto w-full space-y-6">
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <Globe2 className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
            Deep Research
          </h2>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          When Gemini Search Grounding is configured on the server, retrieved web citations are listed separately from model-generated synthesis.
        </p>

        <form onSubmit={handleRunResearch} className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter a research topic or market analysis question..."
            className="flex-1 px-4 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            type="submit"
            disabled={running || !query.trim()}
            className="px-5 py-2.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
          >
            <Search className="w-4 h-4" />
            <span>{running ? 'Researching...' : 'Run Research'}</span>
          </button>
        </form>

        {error && (
          <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-4 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-4 space-y-2">
          <h3 className="text-xs font-semibold text-slate-500 px-2">Saved Reports</h3>
          {reports.length === 0 ? (
            <p className="text-xs text-slate-400 px-2 py-4">No research reports yet.</p>
          ) : (
            reports.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setActiveReport(r)}
                className={`w-full text-left p-3 rounded-xl border transition-colors ${
                  activeReport?.id === r.id
                    ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-800'
                    : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-900'
                }`}
              >
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 line-clamp-2">
                  {r.query}
                </div>
                <div className="text-[11px] text-slate-400 mt-1 tabular-nums">
                  {r.modelId} · {r.citations.length} sources
                </div>
              </button>
            ))
          )}
        </div>

        <div className="lg:col-span-8 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
          {!activeReport ? (
            <p className="text-xs text-slate-400 py-8 text-center">
              Run a research query or select a saved report to inspect sources and synthesis.
            </p>
          ) : (
            <>
              <div className="border-b border-slate-200 dark:border-slate-800 pb-4 space-y-1">
                <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
                  {activeReport.query}
                </h3>
                <div className="text-xs text-slate-500 tabular-nums">
                  Model: {activeReport.modelId} · Grounding: {activeReport.groundingActive ? 'Web Grounded' : 'Model Synthesis Only'} · {new Date(activeReport.createdAt).toLocaleString()}
                </div>
              </div>

              <MarkdownRenderer content={activeReport.reportMarkdown} />

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Verified Retrieved Citations ({activeReport.citations.length})
                </h4>
                {activeReport.citations.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    No external web citations were returned for this run. Treat output as model-generated analysis.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {activeReport.citations.map((cit, idx) => (
                      <li key={idx} className="text-xs">
                        <a
                          href={cit.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                          <ExternalLink className="w-3 h-3 shrink-0" />
                          <span>{cit.title}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
