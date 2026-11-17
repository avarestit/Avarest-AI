import React, { useEffect, useState } from 'react';
import { AlertCircle, Bot, Check, Play, Plus, XCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { avarestApi } from '../lib/api.ts';
import type { AgentConfig, AgentRun } from '../shared/types.ts';

export function AgentsView({ onOpenAuth }: { onOpenAuth: () => void }) {
  const { user } = useAuth();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<AgentConfig['category']>('research');
  const [instructions, setInstructions] = useState('');
  const [requireApproval, setRequireApproval] = useState(true);
  const [taskInputs, setTaskInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAll = async () => {
    if (!user) return;
    const [aRes, rRes] = await Promise.all([avarestApi.getAgents(), avarestApi.getAgentRuns()]);
    setAgents(aRes.agents);
    setRuns(rRes.runs);
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (!user) {
    return (
      <div className="max-w-xl mx-auto my-12 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-4">
        <h2 className="font-display text-xl font-bold">AI Agents &amp; Automation</h2>
        <p className="text-sm text-slate-500">Sign in to configure agents and review human approval checkpoints.</p>
        <button type="button" onClick={onOpenAuth} className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 text-white">
          Sign In
        </button>
      </div>
    );
  }

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !instructions.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await avarestApi.createAgent({
        name: name.trim(),
        category,
        instructions: instructions.trim(),
        allowedTools: ['knowledge_search'],
        maxSteps: 5,
        requireApproval,
      });
      setName('');
      setInstructions('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setBusy(false);
    }
  };

  const handleRunAgent = async (agentId: string) => {
    const task = (taskInputs[agentId] || '').trim();
    if (!task) {
      setError('Enter a task instruction before launching the agent.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await avarestApi.runAgent(agentId, task);
      setTaskInputs((prev) => ({ ...prev, [agentId]: '' }));
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Agent run failed');
    } finally {
      setBusy(false);
    }
  };

  const handleApproval = async (approvalId: string, decision: 'approved' | 'rejected') => {
    setBusy(true);
    setError(null);
    try {
      await avarestApi.decideApproval(approvalId, decision);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve approval');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto w-full space-y-6">
      {/* Create Agent Form */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <Bot className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
            Create Autonomous Agent
          </h2>
        </div>

        <form onSubmit={handleCreateAgent} className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Agent name (e.g., Security Policy Reviewer)"
            className="md:col-span-5 px-3.5 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as AgentConfig['category'])}
            className="md:col-span-3 px-3.5 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
          >
            <option value="research">Research</option>
            <option value="coding">Coding</option>
            <option value="document">Document Analysis</option>
            <option value="marketing">Marketing</option>
            <option value="business">Business Operations</option>
            <option value="automation">Workflow Automation</option>
          </select>
          <label className="md:col-span-4 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 px-2">
            <input
              type="checkbox"
              checked={requireApproval}
              onChange={(e) => setRequireApproval(e.target.checked)}
              className="rounded accent-indigo-600"
            />
            <span>Require Human Approval before execution</span>
          </label>
          <input
            type="text"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="System instructions and safety boundaries..."
            className="md:col-span-10 px-3.5 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
          />
          <button
            type="submit"
            disabled={busy || !name.trim() || !instructions.trim()}
            className="md:col-span-2 px-4 py-2.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white inline-flex items-center justify-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>Create</span>
          </button>
        </form>

        {error && (
          <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Configured Agents */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {agents.length === 0 ? (
          <div className="md:col-span-2 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 text-xs text-slate-500">
            No custom agents created yet. Use the form above to define an agent with approval controls.
          </div>
        ) : (
          agents.map((agent) => (
            <div
              key={agent.id}
              className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white">{agent.name}</h3>
                  <div className="text-xs text-slate-500">
                    {agent.category} · max {agent.maxSteps} steps · {agent.requireApproval ? 'Approval gated' : 'Direct run'}
                  </div>
                </div>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400">{agent.instructions}</p>
              <div className="flex gap-2 pt-2">
                <input
                  type="text"
                  value={taskInputs[agent.id] || ''}
                  onChange={(e) => setTaskInputs((prev) => ({ ...prev, [agent.id]: e.target.value }))}
                  placeholder="Task for this agent..."
                  className="flex-1 px-3 py-2 rounded-lg text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleRunAgent(agent.id)}
                  className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white inline-flex items-center gap-1.5"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Run</span>
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Execution History & Approval Checkpoints */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
          Agent Runs &amp; Human Approval Checkpoints
        </h3>
        {runs.length === 0 ? (
          <p className="text-xs text-slate-400">No agent runs recorded yet.</p>
        ) : (
          <div className="space-y-3">
            {runs.map((run) => (
              <div
                key={run.id}
                className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-slate-900 dark:text-white">
                    {run.agentName} · {run.status}
                  </span>
                  <span className="font-mono text-slate-400 tabular-nums">
                    {new Date(run.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="text-xs text-slate-600 dark:text-slate-400">Task: {run.inputTask}</div>

                {run.pendingApproval && run.pendingApproval.decision === 'pending' && (
                  <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs text-amber-800 dark:text-amber-200">
                      Approval required: {run.pendingApproval.actionSummary}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleApproval(run.pendingApproval!.id, 'approved')}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white inline-flex items-center gap-1"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Approve &amp; Execute</span>
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleApproval(run.pendingApproval!.id, 'rejected')}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white inline-flex items-center gap-1"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Reject</span>
                      </button>
                    </div>
                  </div>
                )}

                {run.outputSummary && (
                  <div className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap pt-1 border-t border-slate-100 dark:border-slate-800">
                    {run.outputSummary}
                  </div>
                )}
                {run.errorMessage && (
                  <div className="text-xs text-red-600 dark:text-red-400">{run.errorMessage}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
