# Avarest One — Powered by Avarest Brain

**Parent Brand:** Avarest AI  
**Primary User Platform:** Avarest One (`https://avarestai.com` / `https://staging.avarestai.com`)  
**Central Intelligence Engine:** Avarest Brain (`Routing · Reasoning · Memory · Orchestration`)

---

## Architecture Overview

```
AVAREST AI (Master Brand)
 └── AVAREST ONE (User Workspace, Chat, Research, Coder, Studio, Agents, Admin Console)
      └── AVAREST BRAIN (Internal Task Classifier, Capability Registry, Router, Fallback, Metering)
           └── SERVER-SIDE PROVIDER ADAPTERS (OpenAI, Google Gemini, Anthropic Claude, DeepSeek)
```

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS v4, Light/Dark/System theme, English & Bengali (`বাংলা`) support, Beginner & Advanced modes.
- **API & Orchestration:** Edge-compatible **Hono** API (`/src/server/app.ts`) running via `server.ts` locally/Cloud Run and `/src/worker.ts` on Cloudflare Workers.
- **Database & Auth:** Supabase Auth + PostgreSQL + pgvector + Storage + Row Level Security (`/supabase/migrations/0001_initial_schema.sql` & `/supabase/migrations/0002_security_hardening.sql`).

## Supabase Environments & Strict Isolation

| Environment | Branch | Supabase Project | Supabase URL |
| :--- | :--- | :--- | :--- |
| **Staging** (Default) | `develop` | `avarest-ai-staging` | `https://wdbtszlcdliwacvztmjl.supabase.co` |
| **Production** | `main` | `avarest-ai` | `https://zdvhksmtxelxcudssdus.supabase.co` |

Never configure `staging` with the `production` Supabase URL or vice versa. Startup and request middleware validate environment isolation automatically.

## Setup & Commands

```bash
npm install
cp .env.example .env
npm run dev      # Starts full-stack Express + Hono + Vite server on port 3000
npm run lint     # Runs tsc --noEmit
npm test         # Runs Vitest suite
npm run build    # Builds production frontend bundle
npm start        # Starts production Node server
```

## Security Controls

- All AI provider API keys (`GEMINI_API_KEY`, `OPENAI_API_KEY`, etc.) and `SUPABASE_SERVICE_ROLE_KEY` are strictly server-side.
- Admin Console endpoints (`/api/v1/admin/*`) enforce server-side `admin` / `super_admin` RBAC.
- Personal Memory is consent-gated (`memoryConsent`) and isolated per user.
- Agent runs with `requireApproval: true` pause at human approval checkpoints before executing.
