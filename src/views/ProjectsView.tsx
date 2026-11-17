import React, { useEffect, useState } from 'react';
import { Archive, FolderKanban, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { avarestApi } from '../lib/api.ts';
import type { Project } from '../shared/types.ts';

export function ProjectsView({ onOpenAuth }: { onOpenAuth: () => void }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);

  const loadProjects = async () => {
    if (!user) return;
    const res = await avarestApi.getProjects();
    setProjects(res.projects);
  };

  useEffect(() => {
    void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (!user) {
    return (
      <div className="max-w-xl mx-auto my-12 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-4">
        <h2 className="font-display text-xl font-bold">Projects &amp; Workspace</h2>
        <p className="text-sm text-slate-500">Sign in to organize your AI conversations into projects.</p>
        <button type="button" onClick={onOpenAuth} className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 text-white">
          Sign In
        </button>
      </div>
    );
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await avarestApi.createProject({ name: name.trim(), description, instructions });
      setName('');
      setDescription('');
      setInstructions('');
      await loadProjects();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto w-full space-y-6">
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <FolderKanban className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">Create Project</h2>
        </div>

        <form onSubmit={handleCreate} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              className="px-3.5 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
            />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description"
              className="px-3.5 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
            />
          </div>
          <textarea
            rows={2}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Custom system instructions injected into conversations linked to this project..."
            className="w-full px-3.5 py-2.5 rounded-xl text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white inline-flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>Create Project</span>
          </button>
        </form>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {projects.length === 0 ? (
          <div className="md:col-span-2 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 text-xs text-slate-500">
            No projects created yet.
          </div>
        ) : (
          projects.map((p) => (
            <div
              key={p.id}
              className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                    {p.name} {p.archived ? '(Archived)' : ''}
                  </h3>
                  <p className="text-xs text-slate-500">{p.description || 'No description'}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={async () => {
                      await avarestApi.updateProject(p.id, { archived: !p.archived });
                      await loadProjects();
                    }}
                    className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    title="Archive / Unarchive"
                  >
                    <Archive className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await avarestApi.deleteProject(p.id);
                      await loadProjects();
                    }}
                    className="p-1.5 text-slate-400 hover:text-red-500"
                    title="Delete project"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {p.instructions && (
                <div className="text-xs text-slate-600 dark:text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-800">
                  {p.instructions}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
