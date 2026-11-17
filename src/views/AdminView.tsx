import React, { useEffect, useState } from 'react';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { avarestApi } from '../lib/api.ts';
import type { UserProfile, UserRole } from '../shared/types.ts';

export function AdminView() {
  const { user } = useAuth();
  const [overview, setOverview] = useState<{
    environment: string;
    totalUsers: number;
    totalConversations: number;
    totalProjects: number;
    totalAgents: number;
    totalRoutingLogs: number;
    totalUsageRecords: number;
    providers: Array<{ id: string; displayName: string; configured: boolean }>;
  } | null>(null);
  const [users, setUsers] = useState<Array<UserProfile & { creditBalance: number }>>([]);
  const [flags, setFlags] = useState<Array<{ key: string; enabled: boolean; description: string }>>([]);
  const [auditLogs, setAuditLogs] = useState<
    Array<{ id: string; actorId: string; action: string; resourceType: string; detail: string; createdAt: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);

  const loadAdminData = async () => {
    setError(null);
    try {
      const [ovRes, uRes, fRes, alRes] = await Promise.all([
        avarestApi.adminOverview(),
        avarestApi.adminUsers(),
        avarestApi.adminFlags(),
        avarestApi.adminAuditLogs(),
      ]);
      setOverview(ovRes);
      setUsers(uRes.users);
      setFlags(fRes.flags);
      setAuditLogs(alRes.auditLogs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Admin authorization failed.');
    }
  };

  useEffect(() => {
    void loadAdminData();
  }, [user?.id]);

  if (error) {
    return (
      <div className="max-w-xl mx-auto my-12 p-6 rounded-2xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 shrink-0" />
        <span>{error}</span>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto w-full space-y-6">
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-2">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
            Protected Admin Console
          </h2>
        </div>
        <p className="text-xs text-slate-500">
          Server-enforced RBAC active. All role and feature-flag changes are recorded in the admin audit log.
        </p>
      </div>

      {overview && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          {[
            { label: 'Users', val: overview.totalUsers },
            { label: 'Conversations', val: overview.totalConversations },
            { label: 'Projects', val: overview.totalProjects },
            { label: 'Agents', val: overview.totalAgents },
            { label: 'Routing Logs', val: overview.totalRoutingLogs },
          ].map((stat) => (
            <div key={stat.label} className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <div className="text-xs text-slate-500">{stat.label}</div>
              <div className="font-mono text-2xl font-bold tabular-nums mt-1">{stat.val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Users & Roles Management */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">User &amp; Role Management</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                <th className="pb-2 font-medium">Email</th>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Plan</th>
                <th className="pb-2 font-medium text-right">Credits</th>
                <th className="pb-2 font-medium text-right">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="py-2.5 font-mono">{u.email}</td>
                  <td className="py-2.5">{u.fullName}</td>
                  <td className="py-2.5 capitalize">{u.activePlan}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums">{u.creditBalance.toFixed(2)}</td>
                  <td className="py-2.5 text-right">
                    <select
                      value={u.role}
                      onChange={async (e) => {
                        await avarestApi.adminUpdateRole(u.id, e.target.value as UserRole);
                        await loadAdminData();
                      }}
                      className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-xs"
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                      <option value="super_admin">super_admin</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Feature Flags */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-3">
        <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">Feature Flags</h3>
        <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
          {flags.map((f) => (
            <div key={f.key} className="py-3 flex items-center justify-between gap-4 text-xs">
              <div>
                <div className="font-mono font-semibold text-slate-900 dark:text-white">{f.key}</div>
                <div className="text-slate-500">{f.description}</div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  await avarestApi.adminToggleFlag(f.key, !f.enabled);
                  await loadAdminData();
                }}
                className={`px-3 py-1 rounded-lg font-semibold ${
                  f.enabled
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                {f.enabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Audit Logs */}
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-3">
        <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">Admin &amp; Security Audit Log</h3>
        <div className="overflow-x-auto max-h-80">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                <th className="pb-2 font-medium">Time</th>
                <th className="pb-2 font-medium">Action</th>
                <th className="pb-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 font-mono">
              {auditLogs.map((log) => (
                <tr key={log.id}>
                  <td className="py-2 text-slate-500 tabular-nums">{new Date(log.createdAt).toLocaleTimeString()}</td>
                  <td className="py-2 text-indigo-600 dark:text-indigo-400">{log.action}</td>
                  <td className="py-2 font-sans text-slate-700 dark:text-slate-300">{log.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
