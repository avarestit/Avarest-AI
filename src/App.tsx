/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  Brain,
  Sparkles,
  Cpu,
  Layers,
  Terminal,
  FileText,
  Image as ImageIcon,
  FolderGit2,
  Calendar,
  Mail,
  Settings,
  Sun,
  Moon,
  Sliders,
  Zap,
  Search,
  Send,
  Plus,
  Trash2,
  Copy,
  Check,
  ExternalLink,
  Database,
  Lock,
  Activity,
  Code,
  Workflow,
  Globe,
  Server,
  Key,
  Users,
  BarChart3,
  RefreshCw,
  Play,
  AlertCircle,
  CheckCircle2,
  MessageSquare,
  Bot,
  ChevronRight,
  Shield,
  Compass
} from 'lucide-react';

// Environment configurations as specified in Phase 01
const ENVIRONMENTS = {
  staging: {
    name: 'Staging (avarest-ai-staging)',
    url: 'https://wdbtszlcdliwacvztmjl.supabase.co',
    branch: 'develop',
    domain: 'https://staging.avarestai.com',
    status: 'Operational'
  },
  production: {
    name: 'Production (avarest-ai)',
    url: 'https://zdvhksmtxelxcudssdus.supabase.co',
    branch: 'main',
    domain: 'https://avarestai.com',
    status: 'Operational'
  }
};

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  timestamp: string;
  tokens?: number;
  routingDecision?: string;
}

interface ChatSession {
  id: string;
  title: string;
  model: string;
  messages: Message[];
  createdAt: string;
}

export default function App() {
  // Theme state
  const [darkMode, setDarkMode] = useState<boolean>(true);
  
  // Environment state (Staging vs Production)
  const [environment, setEnvironment] = useState<'staging' | 'production'>('staging');
  
  // Beginner vs Advanced mode
  const [advancedMode, setAdvancedMode] = useState<boolean>(true);

  // Active navigation tab
  const [activeTab, setActiveTab] = useState<'chat' | 'brain' | 'agents' | 'studio' | 'knowledge' | 'tools' | 'workspace'>('chat');

  // Chat state
  const [sessions, setSessions] = useState<ChatSession[]>([
    {
      id: '1',
      title: 'Analyze Q1 Multi-Model Latency Benchmarks',
      model: 'avarest-brain-router',
      createdAt: '2026-11-17 12:00',
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'Compare the latency and throughput of Gemini 2.5 Flash vs Claude 3.5 Sonnet for real-time customer support streaming.',
          timestamp: '12:00'
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'Avarest Brain Router analyzed your request and selected Gemini 2.5 Flash for optimal first-token latency (118ms) and cost efficiency, while maintaining 98.4% rubric alignment compared to Claude 3.5 Sonnet.\n\n• Gemini 2.5 Flash: 118ms TTFT, 120 tokens/sec, $0.07/M tokens.\n• Claude 3.5 Sonnet: 240ms TTFT, 85 tokens/sec, $3.00/M tokens.\n\nRecommendation: Use Gemini 2.5 Flash for high-frequency chat, and fallback to Claude for complex code synthesis.',
          model: 'Gemini 2.5 Flash (Optimized by Avarest Brain)',
          timestamp: '12:01',
          tokens: 142,
          routingDecision: 'Routed via Cost-Latency Tradeoff Algorithm [Confidence: 99.2%]'
        }
      ]
    }
  ]);

  const [currentSessionId, setCurrentSessionId] = useState<string>('1');
  const [inputMessage, setInputMessage] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('avarest-brain-router');
  const [isComparing, setIsComparing] = useState<boolean>(false);
  const [compareModel, setCompareModel] = useState<string>('claude-3-5-sonnet');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Avarest Brain & Agents state
  const [routerLogs, setRouterLogs] = useState([
    { id: 'l1', time: '12:01:45', prompt: 'Summarize financial statement PDF', routedTo: 'Gemini 1.5 Pro', reason: 'Large context window (2M tokens) required', status: 'Success' },
    { id: 'l2', time: '12:00:12', prompt: 'Write unit test in Rust for async queue', routedTo: 'DeepSeek V3', reason: 'High code synthesis benchmark score', status: 'Success' },
    { id: 'l3', time: '11:58:30', prompt: 'Generate photorealistic product render', routedTo: 'Imagen 3 / Flux', reason: 'Modal modality: Image Generation', status: 'Success' },
  ]);

  // Agents state
  const [agents, setAgents] = useState([
    { id: 'a1', name: 'Avarest Research Agent', type: 'Research & Web RAG', status: 'Idle', lastRun: '10m ago', successRate: '99.4%' },
    { id: 'a2', name: 'Avarest Code Synthesizer', type: 'Full-Stack Developer', status: 'Active', lastRun: 'Running now', successRate: '98.1%' },
    { id: 'a3', name: 'Marketing & SEO Growth Bot', type: 'Content & Analytics', status: 'Idle', lastRun: '2h ago', successRate: '97.5%' },
    { id: 'a4', name: 'Browser Automation Agent', type: 'QA & E2E Testing', status: 'Idle', lastRun: '1d ago', successRate: '96.8%' }
  ]);

  // Creation Studio state
  const [studioPrompt, setStudioPrompt] = useState('Futuristic AI control dashboard with midnight navy glassmorphism and violet holographic accents');
  const [generatedImages, setGeneratedImages] = useState<string[]>([
    'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1634017839464-5c339ebe3cb4?auto=format&fit=crop&w=1200&q=80'
  ]);
  const [isCreatingImage, setIsCreatingImage] = useState(false);

  // Knowledge & Vector search state
  const [knowledgeDocs, setKnowledgeDocs] = useState([
    { id: 'd1', name: 'Avarest_One_Enterprise_Architecture.pdf', chunks: 142, size: '4.2 MB', updated: '2026-11-16' },
    { id: 'd2', name: 'API_Security_Guidelines_v2.docx', chunks: 88, size: '1.8 MB', updated: '2026-11-15' },
    { id: 'd3', name: 'Financial_Model_Q1_2027.xlsx', chunks: 215, size: '5.1 MB', updated: '2026-11-14' }
  ]);
  const [searchQuery, setSearchQuery] = useState('');

  // Connected Tools state
  const [toolsStatus, setToolsStatus] = useState({
    gmail: { connected: true, account: 'executive@avarestai.com' },
    drive: { connected: true, account: 'executive@avarestai.com' },
    calendar: { connected: true, account: 'executive@avarestai.com' },
    github: { connected: true, repo: 'avarest-ai/avarest-one' },
    mcp: { connected: true, servers: 4 }
  });

  // Effect to toggle dark mode class on html root
  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  // Current active session
  const currentSession = sessions.find(s => s.id === currentSessionId) || sessions[0];

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim() || isGenerating) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputMessage,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    const updatedMessages = [...currentSession.messages, userMsg];
    
    setSessions(sessions.map(s => s.id === currentSessionId ? { ...s, messages: updatedMessages } : s));
    const promptText = inputMessage;
    setInputMessage('');
    setIsGenerating(true);

    // Simulate Avarest Brain intelligent model routing & response
    setTimeout(() => {
      let responseModel = selectedModel;
      let routingNote = 'Direct Model Selection';
      if (selectedModel === 'avarest-brain-router') {
        responseModel = 'Gemini 2.5 Flash (Routed via Avarest Brain)';
        routingNote = 'Avarest Brain Router: Optimized for speed & precision [Confidence: 99.4%]';
      }

      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Avarest Brain successfully processed your prompt: "${promptText}".\n\nBased on real-time capability matching across our connected provider matrix (OpenAI, Gemini, Anthropic, DeepSeek), I have synthesized the optimal response.\n\n### Key Highlights:\n1. **Execution Status**: Verified across ${environment.toUpperCase()} Supabase instance (${ENVIRONMENTS[environment].url}).\n2. **Security & RLS**: Enforced strict row-level security and tenant isolation.\n3. **Token Economy**: Minimized context overhead by 34% using Avarest Brain memory retrieval.\n\nHow would you like to refine this output or deploy it as an autonomous agent task?`,
        model: responseModel,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        tokens: Math.floor(Math.random() * 200) + 85,
        routingDecision: routingNote
      };

      setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, messages: [...s.messages, assistantMsg] } : s));
      setIsGenerating(false);
    }, 1000);
  };

  const createNewChat = () => {
    const newS: ChatSession = {
      id: Date.now().toString(),
      title: `New Session ${sessions.length + 1}`,
      model: selectedModel,
      messages: [
        {
          id: Date.now().toString(),
          role: 'assistant',
          content: 'Hello! I am Avarest Brain, your central intelligence engine. How can I assist you across your workspace today?',
          model: 'Avarest Brain Core',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ],
      createdAt: new Date().toLocaleString()
    };
    setSessions([newS, ...sessions]);
    setCurrentSessionId(newS.id);
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col font-sans transition-colors duration-200">
      
      {/* 1. TOP NAVIGATION BAR (Strict Top Bar Contract: Brand — Nav Links — Primary Action) */}
      <header className="sticky top-0 z-50 flex items-center justify-between gap-8 px-6 py-3 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800">
        
        {/* Zone 1: Brand Wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 via-purple-600 to-pink-500 flex items-center justify-center text-white shadow-md shadow-indigo-500/20">
            <Brain className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold tracking-tight bg-gradient-to-r from-slate-900 via-indigo-950 to-indigo-700 dark:from-white dark:to-indigo-300 bg-clip-text text-transparent whitespace-nowrap">
                Avarest One
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono font-medium bg-indigo-50 dark:bg-indigo-950/80 text-indigo-600 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                BRAIN v2.5
              </span>
            </div>
          </div>
        </div>

        {/* Zone 2: Navigation Links (Single-line, whitespace-nowrap) */}
        <nav className="hidden lg:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-400">
          <button
            onClick={() => setActiveTab('chat')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-1 border-b-2 ${activeTab === 'chat' ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold' : 'border-transparent hover:text-slate-900 dark:hover:text-white'}`}
          >
            AI Chat & Hub
          </button>
          <button
            onClick={() => setActiveTab('brain')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-1 border-b-2 ${activeTab === 'brain' ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold' : 'border-transparent hover:text-slate-900 dark:hover:text-white'}`}
          >
            Avarest Brain
          </button>
          <button
            onClick={() => setActiveTab('agents')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-1 border-b-2 ${activeTab === 'agents' ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold' : 'border-transparent hover:text-slate-900 dark:hover:text-white'}`}
          >
            AI Agents & Work
          </button>
          <button
            onClick={() => setActiveTab('studio')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-1 border-b-2 ${activeTab === 'studio' ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold' : 'border-transparent hover:text-slate-900 dark:hover:text-white'}`}
          >
            Creation Studio
          </button>
          <button
            onClick={() => setActiveTab('knowledge')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-1 border-b-2 ${activeTab === 'knowledge' ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold' : 'border-transparent hover:text-slate-900 dark:hover:text-white'}`}
          >
            Research & RAG
          </button>
          <button
            onClick={() => setActiveTab('tools')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-1 border-b-2 ${activeTab === 'tools' ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold' : 'border-transparent hover:text-slate-900 dark:hover:text-white'}`}
          >
            Connected Tools
          </button>
          <button
            onClick={() => setActiveTab('workspace')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-1 border-b-2 ${activeTab === 'workspace' ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 font-semibold' : 'border-transparent hover:text-slate-900 dark:hover:text-white'}`}
          >
            Workspace & DB
          </button>
        </nav>

        {/* Zone 3: Primary Action & Controls */}
        <div className="flex items-center gap-3 shrink-0">
          
          {/* Environment Switcher Badge (Staging vs Production Supabase) */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-mono border border-slate-200 dark:border-slate-700">
            <Server className={`w-3.5 h-3.5 ${environment === 'production' ? 'text-emerald-500' : 'text-amber-500'}`} />
            <select
              value={environment}
              onChange={(e) => setEnvironment(e.target.value as 'staging' | 'production')}
              className="bg-transparent font-medium focus:outline-none cursor-pointer text-slate-800 dark:text-slate-200"
            >
              <option value="staging">Staging (avarest-ai-staging)</option>
              <option value="production">Production (avarest-ai)</option>
            </select>
          </div>

          {/* Theme Toggle */}
          <button
            onClick={() => setDarkMode(!darkMode)}
            className="p-2 rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title="Toggle Theme"
          >
            {darkMode ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-700" />}
          </button>

          {/* Primary CTA */}
          <button
            onClick={createNewChat}
            className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm shadow-indigo-600/20 transition-all whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Chat</span>
          </button>
        </div>
      </header>

      {/* MOBILE NAV BAR FOR SMALL SCREENS */}
      <div className="flex lg:hidden overflow-x-auto gap-2 px-4 py-2 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 text-xs font-medium">
        {[
          { id: 'chat', label: 'Chat' },
          { id: 'brain', label: 'Brain' },
          { id: 'agents', label: 'Agents' },
          { id: 'studio', label: 'Studio' },
          { id: 'knowledge', label: 'Knowledge' },
          { id: 'tools', label: 'Tools' },
          { id: 'workspace', label: 'Workspace' }
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`px-3 py-1.5 rounded-md whitespace-nowrap transition-colors ${activeTab === tab.id ? 'bg-indigo-600 text-white font-semibold' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* MAIN CONTENT AREA */}
      <main className="flex-1 flex flex-col max-w-7xl w-full mx-auto p-4 sm:p-6 gap-6">
        
        {/* =========================================================
            TAB 1: AI CHAT & MODEL HUB
           ========================================================= */}
        {activeTab === 'chat' && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 flex-1">
            
            {/* Sidebar: Session History */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 flex flex-col gap-4 shadow-sm">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Conversations</span>
                <span className="text-xs font-mono text-indigo-600 dark:text-indigo-400">{sessions.length} Active</span>
              </div>
              <div className="flex flex-col gap-1.5 overflow-y-auto max-h-[500px]">
                {sessions.map(s => (
                  <button
                    key={s.id}
                    onClick={() => setCurrentSessionId(s.id)}
                    className={`text-left p-3 rounded-xl text-xs font-medium transition-all flex flex-col gap-1 ${currentSessionId === s.id ? 'bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800/80 text-indigo-900 dark:text-indigo-200 shadow-sm' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300 border border-transparent'}`}
                  >
                    <div className="font-semibold truncate">{s.title}</div>
                    <div className="flex items-center justify-between text-[10px] text-slate-400">
                      <span>{s.createdAt}</span>
                      <span className="font-mono bg-slate-200 dark:bg-slate-800 px-1 rounded">{s.messages.length} msgs</span>
                    </div>
                  </button>
                ))}
              </div>

              {/* Model Hub Controls */}
              <div className="mt-auto pt-4 border-t border-slate-100 dark:border-slate-800 flex flex-col gap-3">
                <div className="text-xs font-semibold text-slate-500">Model Hub Routing</div>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full p-2.5 rounded-xl text-xs font-medium bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="avarest-brain-router">🧠 Avarest Brain (Intelligent Auto-Router)</option>
                  <option value="gemini-2-5-flash">⚡ Gemini 2.5 Flash (Ultra Fast)</option>
                  <option value="gemini-1-5-pro">💎 Gemini 1.5 Pro (2M Context)</option>
                  <option value="claude-3-5-sonnet">🤖 Claude 3.5 Sonnet (Code & Logic)</option>
                  <option value="gpt-4o">✨ OpenAI GPT-4o (Reasoning)</option>
                  <option value="grok-2">🚀 xAI Grok 2 (Real-time Web)</option>
                  <option value="deepseek-v3">🔬 DeepSeek V3 (Coding & Math)</option>
                </select>

                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>Compare Mode</span>
                  <input
                    type="checkbox"
                    checked={isComparing}
                    onChange={(e) => setIsComparing(e.target.checked)}
                    className="rounded accent-indigo-600 w-4 h-4 cursor-pointer"
                  />
                </div>
              </div>
            </div>

            {/* Main Chat Interface */}
            <div className="lg:col-span-3 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 flex flex-col shadow-sm overflow-hidden h-[750px]">
              
              {/* Chat Header */}
              <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-white/50 dark:bg-slate-900/50">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                    <Bot className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100">{currentSession.title}</h2>
                    <p className="text-xs text-slate-500 font-mono">Engine: {selectedModel} | Environment: {environment.toUpperCase()}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const updated = sessions.map(s => s.id === currentSessionId ? { ...s, messages: [s.messages[0]] } : s);
                      setSessions(updated);
                    }}
                    className="p-2 text-slate-500 hover:text-red-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                    title="Clear Chat Messages"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Chat Messages Stream */}
              <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
                {currentSession.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex gap-4 max-w-3xl ${msg.role === 'user' ? 'ml-auto flex-row-reverse' : ''}`}
                  >
                    <div className={`w-8 h-8 rounded-xl shrink-0 flex items-center justify-center ${msg.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-gradient-to-tr from-purple-600 to-indigo-600 text-white shadow-sm'}`}>
                      {msg.role === 'user' ? <Users className="w-4 h-4" /> : <Brain className="w-4 h-4" />}
                    </div>

                    <div className={`flex flex-col gap-1.5 ${msg.role === 'user' ? 'items-end' : ''}`}>
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">{msg.role === 'user' ? 'You' : (msg.model || 'Avarest Brain')}</span>
                        <span>·</span>
                        <span>{msg.timestamp}</span>
                        {msg.tokens && (
                          <>
                            <span>·</span>
                            <span className="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-[10px]">{msg.tokens} tokens</span>
                          </>
                        )}
                      </div>

                      <div className={`p-4 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${msg.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-slate-100 dark:bg-slate-800/80 text-slate-800 dark:text-slate-200 rounded-tl-none border border-slate-200/60 dark:border-slate-700/60'}`}>
                        {msg.content}
                      </div>

                      {msg.routingDecision && (
                        <div className="text-[11px] font-mono text-indigo-600 dark:text-indigo-400 bg-indigo-50/80 dark:bg-indigo-950/50 px-2.5 py-1 rounded-lg border border-indigo-100 dark:border-indigo-900/50 flex items-center gap-1.5">
                          <Zap className="w-3 h-3" />
                          <span>{msg.routingDecision}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {isGenerating && (
                  <div className="flex gap-4 items-center text-slate-400 text-xs font-mono animate-pulse">
                    <div className="w-8 h-8 rounded-xl bg-indigo-600/20 flex items-center justify-center">
                      <RefreshCw className="w-4 h-4 animate-spin text-indigo-600" />
                    </div>
                    <span>Avarest Brain is routing and synthesizing response across multi-model matrix...</span>
                  </div>
                )}
              </div>

              {/* Chat Input Box */}
              <form onSubmit={handleSendMessage} className="p-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center gap-3">
                <input
                  type="text"
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  placeholder="Ask Avarest Brain anything, or request code, analysis, or agent execution..."
                  className="flex-1 p-3.5 rounded-xl text-sm bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  type="submit"
                  disabled={isGenerating || !inputMessage.trim()}
                  className="px-5 py-3.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold rounded-xl transition-all shadow-md shadow-indigo-600/20 flex items-center gap-2"
                >
                  <span>Send</span>
                  <Send className="w-4 h-4" />
                </button>
              </form>

            </div>
          </div>
        )}

        {/* =========================================================
            TAB 2: AVAREST BRAIN (INTELLIGENCE ENGINE)
           ========================================================= */}
        {activeTab === 'brain' && (
          <div className="flex flex-col gap-6">
            <div className="bg-gradient-to-r from-indigo-900 via-purple-900 to-slate-900 rounded-3xl p-8 text-white shadow-xl relative overflow-hidden">
              <div className="absolute right-0 top-0 translate-x-12 -translate-y-12 w-96 h-96 bg-indigo-500/20 rounded-full blur-3xl pointer-events-none"></div>
              <div className="max-w-2xl flex flex-col gap-4 relative z-10">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/30 border border-indigo-400/30 text-indigo-200 text-xs font-mono">
                  <Brain className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Central Intelligence & Orchestration Engine</span>
                </div>
                <h1 className="text-3xl font-extrabold tracking-tight">Avarest Brain Matrix</h1>
                <p className="text-slate-300 text-sm leading-relaxed">
                  Avarest Brain acts as the central intelligence hub, routing prompts across optimal AI providers (Gemini, Claude, GPT, DeepSeek, Grok) based on latency, cost, security policies, and task requirements.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase text-slate-400">Router Status</span>
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                </div>
                <div className="text-2xl font-bold font-mono">99.98%</div>
                <p className="text-xs text-slate-500">Autonomous provider fallback operational with zero downtime across Staging and Production.</p>
              </div>

              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase text-slate-400">Avg Latency (TTFT)</span>
                  <span className="text-xs font-mono text-indigo-600 dark:text-indigo-400">-34% vs Baseline</span>
                </div>
                <div className="text-2xl font-bold font-mono">118 ms</div>
                <p className="text-xs text-slate-500">Optimized caching and smart edge routing via Gemini 2.5 Flash & Supabase edge functions.</p>
              </div>

              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase text-slate-400">Active Memory Vectors</span>
                  <span className="text-xs font-mono text-emerald-600">pgvector ready</span>
                </div>
                <div className="text-2xl font-bold font-mono">1,429,810</div>
                <p className="text-xs text-slate-500">Persistent user and enterprise knowledge indexed via Supabase pgvector extension.</p>
              </div>
            </div>

            {/* Live Routing Audit Logs */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-sm">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-indigo-600" />
                  <span>Real-Time Model Routing Audit Log</span>
                </h3>
                <span className="text-xs font-mono text-slate-400">Connected to {environment.toUpperCase()} DB</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 font-mono">
                      <th className="pb-3 font-semibold">Timestamp</th>
                      <th className="pb-3 font-semibold">Prompt Intent</th>
                      <th className="pb-3 font-semibold">Routed Provider</th>
                      <th className="pb-3 font-semibold">Routing Reason</th>
                      <th className="pb-3 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-mono">
                    {routerLogs.map(l => (
                      <tr key={l.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="py-3 text-slate-500">{l.time}</td>
                        <td className="py-3 font-medium text-slate-800 dark:text-slate-200">{l.prompt}</td>
                        <td className="py-3 text-indigo-600 dark:text-indigo-400">{l.routedTo}</td>
                        <td className="py-3 text-slate-500">{l.reason}</td>
                        <td className="py-3">
                          <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 border border-emerald-200 dark:border-emerald-800">
                            {l.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* =========================================================
            TAB 3: AI AGENTS & WORK
           ========================================================= */}
        {activeTab === 'agents' && (
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold tracking-tight">Avarest Autonomous Agents</h2>
                <p className="text-xs text-slate-500">Execute multi-step workflows, web research, and automated code synthesis.</p>
              </div>
              <button
                onClick={() => alert('Launching new autonomous agent pipeline...')}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-sm flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span>Create Agent</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {agents.map(agent => (
                <div key={agent.id} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-sm hover:border-indigo-500/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 flex items-center justify-center font-bold">
                        <Workflow className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">{agent.name}</h3>
                        <p className="text-xs text-slate-500">{agent.type}</p>
                      </div>
                    </div>
                    <span className={`px-2.5 py-1 rounded-full text-xs font-mono font-medium ${agent.status === 'Active' ? 'bg-emerald-50 dark:bg-emerald-950 text-emerald-600 border border-emerald-200 dark:border-emerald-800' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}`}>
                      {agent.status}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-slate-100 dark:border-slate-800 font-mono">
                    <span>Last Run: {agent.lastRun}</span>
                    <span>Success: <strong className="text-indigo-600 dark:text-indigo-400">{agent.successRate}</strong></span>
                  </div>

                  <div className="flex items-center gap-2 mt-2">
                    <button
                      onClick={() => alert(`Triggering agent execution for ${agent.name}...`)}
                      className="flex-1 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 text-slate-700 dark:text-slate-200 hover:text-indigo-600 rounded-xl text-xs font-semibold transition-colors flex items-center justify-center gap-1.5"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>Run Agent</span>
                    </button>
                    <button
                      onClick={() => alert(`Opening configuration for ${agent.name}`)}
                      className="p-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl text-slate-600 dark:text-slate-400"
                    >
                      <Settings className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* =========================================================
            TAB 4: CREATION STUDIO
           ========================================================= */}
        {activeTab === 'studio' && (
          <div className="flex flex-col gap-6">
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-sm">
              <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                <ImageIcon className="w-5 h-5 text-indigo-600" />
                <span>AI Creation Studio (Images & Assets)</span>
              </h2>
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  type="text"
                  value={studioPrompt}
                  onChange={(e) => setStudioPrompt(e.target.value)}
                  placeholder="Describe the image asset you wish to generate..."
                  className="flex-1 p-3 rounded-xl text-sm bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  onClick={() => {
                    setIsCreatingImage(true);
                    setTimeout(() => {
                      setGeneratedImages([
                        'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?auto=format&fit=crop&w=1200&q=80',
                        ...generatedImages
                      ]);
                      setIsCreatingImage(false);
                    }, 1200);
                  }}
                  disabled={isCreatingImage}
                  className="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold rounded-xl transition-all shadow-sm flex items-center justify-center gap-2 whitespace-nowrap"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>{isCreatingImage ? 'Generating...' : 'Generate Asset'}</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {generatedImages.map((imgUrl, idx) => (
                <div key={idx} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm group">
                  <div className="h-48 overflow-hidden relative">
                    <img src={imgUrl} alt="Generated asset" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" referrerPolicy="no-referrer" />
                  </div>
                  <div className="p-4 flex items-center justify-between text-xs text-slate-500 font-mono">
                    <span>Asset #{generatedImages.length - idx}</span>
                    <a href={imgUrl} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline flex items-center gap-1">
                      <span>View Full</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* =========================================================
            TAB 5: RESEARCH & KNOWLEDGE BASE
           ========================================================= */}
        {activeTab === 'knowledge' && (
          <div className="flex flex-col gap-6">
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">Enterprise Knowledge & Vector RAG</h2>
                  <p className="text-xs text-slate-500">Manage vector embeddings, documents, and private RAG data connected to Supabase pgvector.</p>
                </div>
                <button
                  onClick={() => alert('Upload document modal opened...')}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-sm flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  <span>Upload Document</span>
                </button>
              </div>

              <div className="flex items-center gap-3">
                <Search className="w-4 h-4 text-slate-400 ml-1" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search knowledge base embeddings and chunks..."
                  className="flex-1 p-2.5 text-xs bg-slate-100 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none"
                />
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 font-mono">
                      <th className="pb-3 font-semibold">Document Name</th>
                      <th className="pb-3 font-semibold">Indexed Chunks</th>
                      <th className="pb-3 font-semibold">File Size</th>
                      <th className="pb-3 font-semibold">Last Updated</th>
                      <th className="pb-3 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-mono">
                    {knowledgeDocs.filter(d => d.name.toLowerCase().includes(searchQuery.toLowerCase())).map(doc => (
                      <tr key={doc.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="py-3 font-medium text-slate-800 dark:text-slate-200 flex items-center gap-2">
                          <FileText className="w-4 h-4 text-indigo-600" />
                          <span>{doc.name}</span>
                        </td>
                        <td className="py-3 text-slate-500">{doc.chunks} chunks</td>
                        <td className="py-3 text-slate-500">{doc.size}</td>
                        <td className="py-3 text-slate-500">{doc.updated}</td>
                        <td className="py-3 text-right">
                          <button
                            onClick={() => alert(`Re-indexing ${doc.name}...`)}
                            className="px-2.5 py-1 bg-slate-100 dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-950 text-slate-700 dark:text-slate-300 rounded-lg text-[11px]"
                          >
                            Re-index
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* =========================================================
            TAB 6: CONNECTED APPS & TOOLS
           ========================================================= */}
        {activeTab === 'tools' && (
          <div className="flex flex-col gap-6">
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-6 shadow-sm">
              <div>
                <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">Connected Apps & MCP Tools</h2>
                <p className="text-xs text-slate-500">Secure OAuth and Model Context Protocol (MCP) tool integrations for Avarest One agents.</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {[
                  { name: 'Google Gmail', icon: Mail, status: 'Connected', account: toolsStatus.gmail.account },
                  { name: 'Google Drive', icon: FolderGit2, status: 'Connected', account: toolsStatus.drive.account },
                  { name: 'Google Calendar', icon: Calendar, status: 'Connected', account: toolsStatus.calendar.account },
                  { name: 'GitHub Repository', icon: Code, status: 'Connected', repo: toolsStatus.github.repo },
                  { name: 'Model Context Protocol (MCP)', icon: Server, status: 'Active', servers: `${toolsStatus.mcp.servers} Servers` }
                ].map((tool, idx) => (
                  <div key={idx} className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <tool.icon className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">{tool.name}</span>
                      </div>
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-50 dark:bg-emerald-950 text-emerald-600 border border-emerald-200 dark:border-emerald-800">
                        {tool.status}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 font-mono truncate">
                      {tool.account || tool.repo || tool.servers}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* =========================================================
            TAB 7: PROFESSIONAL WORKSPACE & SUPABASE DB CONFIG
           ========================================================= */}
        {activeTab === 'workspace' && (
          <div className="flex flex-col gap-6">
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col gap-6 shadow-sm">
              <div>
                <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">Workspace & Supabase Database Architecture</h2>
                <p className="text-xs text-slate-500">Strict database isolation between Staging and Production Supabase projects.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                
                {/* Staging Supabase Card */}
                <div className={`p-6 rounded-2xl border flex flex-col gap-4 ${environment === 'staging' ? 'border-indigo-500 bg-indigo-50/20 dark:bg-indigo-950/20' : 'border-slate-200 dark:border-slate-800'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Database className="w-5 h-5 text-amber-500" />
                      <h3 className="text-sm font-bold">Staging Supabase Project</h3>
                    </div>
                    <span className="px-2 py-0.5 rounded text-xs font-mono bg-amber-50 text-amber-700 border border-amber-200">
                      develop
                    </span>
                  </div>
                  <div className="text-xs font-mono text-slate-500 space-y-1">
                    <div><strong>Project Name:</strong> avarest-ai-staging</div>
                    <div><strong>Project URL:</strong> {ENVIRONMENTS.staging.url}</div>
                  </div>
                  <button
                    onClick={() => setEnvironment('staging')}
                    className={`mt-2 py-2 rounded-xl text-xs font-semibold transition-all ${environment === 'staging' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200'}`}
                  >
                    {environment === 'staging' ? 'Active Staging Environment' : 'Switch to Staging'}
                  </button>
                </div>

                {/* Production Supabase Card */}
                <div className={`p-6 rounded-2xl border flex flex-col gap-4 ${environment === 'production' ? 'border-indigo-500 bg-indigo-50/20 dark:bg-indigo-950/20' : 'border-slate-200 dark:border-slate-800'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Database className="w-5 h-5 text-emerald-500" />
                      <h3 className="text-sm font-bold">Production Supabase Project</h3>
                    </div>
                    <span className="px-2 py-0.5 rounded text-xs font-mono bg-emerald-50 text-emerald-700 border border-emerald-200">
                      main
                    </span>
                  </div>
                  <div className="text-xs font-mono text-slate-500 space-y-1">
                    <div><strong>Project Name:</strong> avarest-ai</div>
                    <div><strong>Project URL:</strong> {ENVIRONMENTS.production.url}</div>
                  </div>
                  <button
                    onClick={() => setEnvironment('production')}
                    className={`mt-2 py-2 rounded-xl text-xs font-semibold transition-all ${environment === 'production' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200'}`}
                  >
                    {environment === 'production' ? 'Active Production Environment' : 'Switch to Production'}
                  </button>
                </div>

              </div>
            </div>
          </div>
        )}

      </main>

      {/* FOOTER */}
      <footer className="py-6 px-6 text-center text-xs text-slate-400 border-t border-slate-200 dark:border-slate-800 mt-auto">
        Avarest One · One Platform. Every Intelligence. Powered by Avarest Brain.
      </footer>

    </div>
  );
}
