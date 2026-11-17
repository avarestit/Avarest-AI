import React, { useEffect, useState } from 'react';
import { Brain, CheckCircle2, XCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { avarestApi } from '../lib/api.ts';
import type { ModelCapabilitySpec, RoutingLog } from '../shared/types.ts';

export function BrainView({ onOpenAuth }: { onOpenAuth: () => void }) {
  const { user } = useAuth();
  const [models, setModels] = useState<ModelCapabilitySpec[]>([]);
  const [logs, setLogs] = useState<RoutingLog[]>([]);
  const [policies, setPolicies] = useState<
    Array<{
      id: string;
      name: string;
      taskCategory: string;
      preferredModelId: string;
      fallbackModelId: string;
      maxCostTier: string;
      active: boolean;
    }>
  >([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    Promise.all([avarestApi.getModels(), avarestApi.getBrainLogs(), avarestApi.getBrainPolicies()])
      .then(([mRes, lRes, pRes]) => {
        setModels(mRes.models);
        setLogs(lRes.logs);
        setPolicies(pRes.policies);
      })
      .finally(() => setLoading(false));
  }, [user]);

  if (!user) {
    return (
      <div className="max-w-xl mx-auto my-12 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-4">
        <h2 className="font-display text-xl font-bold">Avarest Brain Orchestration</h2>
        <p className="text-sm text-slate-500">Sign in to inspect capability registry and live routing logs.</p>
        <button type="button" onClick={onOpenAuth} className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 text-white">
          Sign In
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto w-full space-y-6">
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-2">
        <div className="flex items-center gap-2.5">
          <Brain className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
            Avarest Brain — Central Intelligence Engine
          </h2>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-400 max-w-3xl">
          Avarest Brain powers task classification, capability-based model routing, context assembly, and provider fallback inside Avarest One. Only models with valid server-side credentials are marked ready.
        </p>
      </div>

      {/* Capability Registry Table */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
          Model Capability Registry
        </h3>
        {loading ? (
          <p className="text-xs text-slate-400">Loading registry...</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="pb-2.5 font-medium">Provider</th>
                  <th className="pb-2.5 font-medium">Model</th>
                  <th className="pb-2.5 font-medium">Capabilities</th>
                  <th className="pb-2.5 font-medium text-right">Context Window</th>
                  <th className="pb-2.5 font-medium text-right">Server Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {models.map((m) => (
                  <tr key={m.id}>
                    <td className="py-3 font-medium text-slate-800 dark:text-slate-200">{m.providerName}</td>
                    <td className="py-3 font-mono text-slate-700 dark:text-slate-300">{m.displayName}</td>
                    <td className="py-3 text-slate-500">{m.capabilities.join(' · ')}</td>
                    <td className="py-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                      {m.contextWindow.toLocaleString()}
                    </td>
                    <td className="py-3 text-right">
                      {m.configured ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Configured</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-slate-400 font-medium">
                          <XCircle className="w-3.5 h-3.5" />
                          <span>Missing Server Key</span>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Active Routing Policies */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
          Routing Policies
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                <th className="pb-2.5 font-medium">Policy</th>
                <th className="pb-2.5 font-medium">Task Category</th>
                <th className="pb-2.5 font-medium">Preferred Model</th>
                <th className="pb-2.5 font-medium">Fallback</th>
                <th className="pb-2.5 font-medium text-right">Cost Ceiling</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {policies.map((p) => (
                <tr key={p.id}>
                  <td className="py-2.5 font-medium text-slate-800 dark:text-slate-200">{p.name}</td>
                  <td className="py-2.5 font-mono text-slate-500">{p.taskCategory}</td>
                  <td className="py-2.5 font-mono text-indigo-600 dark:text-indigo-400">{p.preferredModelId}</td>
                  <td className="py-2.5 font-mono text-slate-500">{p.fallbackModelId}</td>
                  <td className="py-2.5 text-right text-slate-600 dark:text-slate-400">{p.maxCostTier}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Real Routing Logs */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
          Your Recent Routing Decisions
        </h3>
        {logs.length === 0 ? (
          <p className="text-xs text-slate-500 py-4">
            No routing decisions recorded yet. Send a chat message to generate live Brain routing logs.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="pb-2.5 font-medium">Time</th>
                  <th className="pb-2.5 font-medium">Task</th>
                  <th className="pb-2.5 font-medium">Model</th>
                  <th className="pb-2.5 font-medium">Reason</th>
                  <th className="pb-2.5 font-medium text-right">Latency</th>
                  <th className="pb-2.5 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="py-2.5 font-mono tabular-nums text-slate-500">
                      {new Date(l.createdAt).toLocaleTimeString()}
                    </td>
                    <td className="py-2.5 font-mono text-slate-700 dark:text-slate-300">{l.taskCategory}</td>
                    <td className="py-2.5 font-mono text-indigo-600 dark:text-indigo-400">{l.selectedModel}</td>
                    <td className="py-2.5 text-slate-600 dark:text-slate-400">{l.reason}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums">{l.latencyMs} ms</td>
                    <td className="py-2.5 text-right font-medium">{l.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
