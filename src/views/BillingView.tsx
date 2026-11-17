import React, { useEffect, useState } from 'react';
import { CreditCard } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { avarestApi } from '../lib/api.ts';
import type { UsageSummary } from '../shared/types.ts';

const PLAN_CATALOG = [
  { id: 'free', name: 'Free', audience: 'For first-time exploration', allowance: '100 credits / mo', price: '$0' },
  { id: 'starter', name: 'Starter', audience: 'For individual daily use', allowance: '1,000 credits / mo', price: '$12 / mo' },
  { id: 'pro', name: 'Pro', audience: 'For power users & coding', allowance: '4,000 credits / mo', price: '$29 / mo' },
  { id: 'ultra', name: 'Ultra', audience: 'For heavy multi-model workloads', allowance: '12,000 credits / mo', price: '$69 / mo' },
  { id: 'team', name: 'Team', audience: 'For collaborative workspaces', allowance: '25,000 shared credits', price: '$49 / seat' },
  { id: 'business', name: 'Business', audience: 'For scaling operations', allowance: '75,000 shared credits', price: '$99 / seat' },
  { id: 'enterprise', name: 'Enterprise', audience: 'For custom SLAs & dedicated routing', allowance: 'Custom quota', price: 'Custom' },
];

export function BillingView({ onOpenAuth }: { onOpenAuth: () => void }) {
  const { user } = useAuth();
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  useEffect(() => {
    if (!user) return;
    avarestApi
      .getUsage()
      .then((res) => setUsage(res.usage))
      .catch(() => {});
  }, [user]);

  if (!user) {
    return (
      <div className="max-w-xl mx-auto my-12 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-4">
        <h2 className="font-display text-xl font-bold">Usage &amp; Billing</h2>
        <p className="text-sm text-slate-500">Sign in to inspect your credit balance and atomic usage ledger.</p>
        <button type="button" onClick={onOpenAuth} className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 text-white">
          Sign In
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto w-full space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500">Active Plan</div>
          <div className="font-display text-xl font-bold capitalize mt-1">{user.activePlan}</div>
        </div>
        <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500">Credit Balance</div>
          <div className="font-mono text-xl font-bold tabular-nums mt-1">
            {usage ? usage.balance.toFixed(2) : '—'}
          </div>
        </div>
        <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500">Total Requests</div>
          <div className="font-mono text-xl font-bold tabular-nums mt-1">
            {usage ? usage.totalRequests : 0}
          </div>
        </div>
        <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500">Metered Tokens</div>
          <div className="font-mono text-xl font-bold tabular-nums mt-1">
            {usage ? (usage.totalInputTokens + usage.totalOutputTokens).toLocaleString() : 0}
          </div>
        </div>
      </div>

      {/* Commercial Plans Matrix */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
              Avarest One Commercial Tiers
            </h2>
          </div>
          <span className="text-xs text-slate-500">
            Live checkout is disabled until payment processor approval.
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                <th className="pb-2.5 font-medium">Tier</th>
                <th className="pb-2.5 font-medium">Target Audience</th>
                <th className="pb-2.5 font-medium">Monthly Credit Limit</th>
                <th className="pb-2.5 font-medium text-right">Reference Price</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {PLAN_CATALOG.map((tier) => (
                <tr key={tier.id} className={tier.id === user.activePlan ? 'bg-indigo-50/40 dark:bg-indigo-950/20' : ''}>
                  <td className="py-2.5 font-semibold text-slate-900 dark:text-white">
                    {tier.name} {tier.id === user.activePlan ? '(Current)' : ''}
                  </td>
                  <td className="py-2.5 text-slate-600 dark:text-slate-400">{tier.audience}</td>
                  <td className="py-2.5 font-mono tabular-nums text-slate-700 dark:text-slate-300">{tier.allowance}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums font-medium">{tier.price}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Atomic Credit Ledger */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">Credit Ledger</h3>
        {!usage || usage.ledger.length === 0 ? (
          <p className="text-xs text-slate-400">No credit transactions recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="pb-2 font-medium">Timestamp</th>
                  <th className="pb-2 font-medium">Reason</th>
                  <th className="pb-2 font-medium text-right">Delta</th>
                  <th className="pb-2 font-medium text-right">Balance After</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 font-mono tabular-nums">
                {usage.ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td className="py-2.5 text-slate-500">{new Date(entry.createdAt).toLocaleString()}</td>
                    <td className="py-2.5 font-sans text-slate-800 dark:text-slate-200">{entry.reason}</td>
                    <td className={`py-2.5 text-right ${entry.delta < 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                      {entry.delta > 0 ? `+${entry.delta.toFixed(4)}` : entry.delta.toFixed(4)}
                    </td>
                    <td className="py-2.5 text-right text-slate-700 dark:text-slate-300">
                      {entry.balanceAfter.toFixed(4)}
                    </td>
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
