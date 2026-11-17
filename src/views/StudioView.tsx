import React, { useEffect, useState } from 'react';
import { FileText, Image, Music, Video } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { avarestApi } from '../lib/api.ts';
import type { ModelCapabilitySpec } from '../shared/types.ts';

export function StudioView({ onOpenAuth }: { onOpenAuth: () => void }) {
  const { user } = useAuth();
  const [models, setModels] = useState<ModelCapabilitySpec[]>([]);

  useEffect(() => {
    if (!user) return;
    avarestApi
      .getModels()
      .then((res) => setModels(res.models))
      .catch(() => {});
  }, [user]);

  if (!user) {
    return (
      <div className="max-w-xl mx-auto my-12 bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-4">
        <h2 className="font-display text-xl font-bold">Creation Studio</h2>
        <p className="text-sm text-slate-500">Sign in to check configured creative providers and generate assets.</p>
        <button type="button" onClick={onOpenAuth} className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 text-white">
          Sign In
        </button>
      </div>
    );
  }

  const modalities = [
    {
      id: 'image',
      title: 'Image Generation',
      icon: Image,
      supported: models.some((m) => m.configured && m.capabilities.includes('image')),
      detail: 'Requires a configured image-capable provider key (e.g., paid Gemini image tier or OpenAI Images API).',
    },
    {
      id: 'video',
      title: 'Video Generation',
      icon: Video,
      supported: models.some((m) => m.configured && m.capabilities.includes('video')),
      detail: 'Requires a configured video generation provider (e.g., Gemini Omni Flash / Veo) on the server.',
    },
    {
      id: 'audio',
      title: 'Audio & Speech Synthesis',
      icon: Music,
      supported: models.some((m) => m.configured && m.capabilities.includes('audio')),
      detail: 'Requires a configured TTS / Lyria audio provider endpoint on the server.',
    },
    {
      id: 'document',
      title: 'Structured Document Creation',
      icon: FileText,
      supported: models.some((m) => m.configured && m.capabilities.includes('chat')),
      detail: 'Uses Avarest Brain text synthesis in AI Chat or Deep Research to draft Markdown briefs and specifications.',
    },
  ];

  return (
    <div className="max-w-5xl mx-auto w-full space-y-6">
      <div className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-2">
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
          AI Creation Studio
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Capability detection checks the server model registry honestly. Modalities without a configured provider key remain disabled rather than returning simulated media.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {modalities.map((mod) => {
          const Icon = mod.icon;
          return (
            <div
              key={mod.id}
              className="bg-white dark:bg-[#0B1120] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-3"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Icon className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white">{mod.title}</h3>
                </div>
                <span
                  className={`text-xs font-medium ${
                    mod.supported ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'
                  }`}
                >
                  {mod.supported ? 'Ready' : 'Provider Not Configured'}
                </span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{mod.detail}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
