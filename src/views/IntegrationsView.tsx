import React, { useEffect, useState } from 'react';
import { Link2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { avarestApi } from '../lib/api.ts';
import type { ConnectedAccount } from '../shared/types.ts';

export function IntegrationsView({ onOpenAuth }: { onOpenAuth: () => void }) {
  const { user } = useAuth();
  const [integrations, setIntegrations] = useState<ConnectedAccount[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    avarestApi
      .getIntegrations()
      .then((res) => setIntegrations(res.integrations))
      .finally(() => setLoading(false));
  }, [user]);

  if (!user) {
    return (
      <div className="max-w-xl mx-auto my-12 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-4">
        <h2 className="font-display text-xl font-bold">Connected Apps &amp; MCP</h2>
        <p className="text-sm text-slate-500">Sign in to inspect OAuth &amp; MCP integration availability.</p>
        <button type="button" onClick={onOpenAuth} className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 text-white">
          Sign In
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto w-full space-y-6">
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-2">
        <div className="flex items-center gap-2.5">
          <Link2 className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
            Connected Apps &amp; MCP Registry
          </h2>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Connection states are verified server-side. Apps remain disconnected or unconfigured until valid OAuth credentials and user consent tokens are stored on the server.
        </p>
      </div>

      {loading ? (
        <p className="text-xs text-slate-400">Checking server integration bindings...</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {integrations.map((item) => (
            <div
              key={item.id}
              className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">{item.displayName}</h3>
                <span className="text-xs font-mono text-slate-500">
                  {item.status === 'connected'
                    ? 'Connected'
                    : item.oauthConfigured
                      ? 'Ready to Connect'
                      : 'Not Configured'}
                </span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400">{item.detail}</p>
              <div className="text-[11px] font-mono text-slate-400">
                Scopes: {item.scopes.join(', ')}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
