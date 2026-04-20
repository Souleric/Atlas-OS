# AtlasOS — Project Context for Claude Code

## What Is This?

AtlasOS is Eric's personal AI Team OS built for **LabX Co** — his AI studio brand.
It is a single-user, multi-agent platform that lets Eric operate like a full team by himself.

This is NOT a client project. This is Eric's personal command center and internal infrastructure.
It will also serve as a live case study / proof of concept for LabX Co's positioning.

---

## Owner

**Eric** — Founder of LabX Co (AI studio), previously BETA Social (digital studio, Malaysia).
Solo operator. Only user of this system. No multi-tenant requirements.

---

## The Vision

A single chat interface where Eric talks naturally.
An orchestrator agent reads the intent, delegates to the right specialist agent(s),
agents collaborate autonomously, and Eric receives one clean final output.

Eric is only interrupted when an agent needs a decision it cannot make alone.

---

## Agent Roster

| Agent | Codename | Role |
|-------|----------|------|
| Personal Assistant | ARIA | Scheduling, Gmail, daily briefing, task capture |
| Designer | PIXEL | Visuals, carousels, brand assets, image gen |
| Account Manager | RELAY | Client follow-ups, project status, proposals |
| Marketer | SIGNAL | SEO, GEO, content strategy, ad copy |
| Sales | CLOSE | Lead tracking, outreach sequences, follow-up |
| Analytics | LENS | Metrics, reporting, performance insights |

### Orchestrator
- Routes incoming requests to the correct agent(s)
- Chains agents for complex multi-step tasks
- Compiles final output for Eric
- Only escalates to Eric when a decision is required

---

## Multi-Model Architecture

Each agent has a preferred model but can be overridden per task.

| Agent | Default Model | Fallback |
|-------|--------------|---------|
| ARIA | claude-sonnet-4 | gpt-4o |
| PIXEL | gpt-4o | claude-sonnet-4 |
| RELAY | claude-sonnet-4 | gpt-4o |
| SIGNAL | claude-sonnet-4 | gemini (web search tasks) |
| CLOSE | gpt-4o | claude-sonnet-4 |
| LENS | claude-sonnet-4 | gpt-4o |

Model is passed as a config parameter per agent — not hardcoded.
Eric can override per task via the UI.

---

## Agent Skills (Tools + Permissions)

Each agent has a defined skill set — tools it can call, APIs it can hit.

### ARIA
- Google Calendar (read/write)
- Gmail (read/draft/send)
- Notion (read/write tasks)
- Daily briefing generation

### PIXEL
- Flux / Ideogram / fal.ai image generation APIs
- Brand guidelines context (fetched from master context doc)
- PNG/SVG output

### RELAY
- Notion CRM database (client records, project status)
- Gmail (draft follow-up emails)
- WhatsApp Business API (follow-up messages)
- Proposal generation

### SIGNAL
- Web search (Brave/Serper API)
- GA4 data pull
- Meta Ads API
- SEO/GEO content generation

### CLOSE
- Supabase leads table
- Gmail outreach drafting
- Follow-up sequence tracking

### LENS
- GA4 API
- Meta Ads API
- Supabase queries
- Chart generation (Recharts or Chart.js)
- Report generation

---

## Tech Stack

```
Frontend        React + Tailwind CSS
Orchestrator    Claude API (claude-sonnet-4) — router system prompt
Agents          Claude API + OpenAI API (multi-model, per agent config)
MCP Servers     Gmail, Google Calendar, Notion (already connected)
Database        Supabase (leads, client data, conversation memory, agent outputs)
Human Workspace Notion (master context doc, client records, project tracking)
Image Gen       Flux / Ideogram via fal.ai
Hosting         Vercel (frontend) + Supabase (backend)
```

---

## Data Architecture

### Master Context Document (Notion)
Every agent reads this. It contains:
- Eric's identity, role, business context
- LabX Co's active projects and clients
- Eric's communication style and tone
- Current quarter goals
- Preferred tools and workflows

### Supabase Tables (to be created)
- `leads` — Sales pipeline
- `clients` — Active client records
- `projects` — Project status per client
- `conversations` — Agent memory / history
- `agent_outputs` — Logs of what each agent produced

---

## UI Design

Single chat interface with agent switcher strip at the top.

```
[ AUTO ] [ ARIA ] [ PIXEL ] [ RELAY ] [ SIGNAL ] [ CLOSE ] [ LENS ]
────────────────────────────────────────────────────────────────────
  Chat window — Eric types here
  Orchestrator routes automatically in AUTO mode
  Eric can force a specific agent by clicking its tab
```

Design aesthetic: **dark, command-center feel** — think HUD/OS, not chatbot.
Reference: Jarvis OS aesthetic Eric built previously (dark, Space Mono/Syne fonts, HUD style).

---

## Build Phases

| Phase | Scope | Priority |
|-------|-------|----------|
| 1 | Chat UI + Orchestrator + ARIA (PA) | First — daily utility |
| 2 | RELAY (Account Manager) + Notion integration | BETA Social pain point |
| 3 | LENS (Analytics) + Supabase setup | Data-driven decisions |
| 4 | PIXEL (Designer) + SIGNAL (Marketer) | Growth + polish |
| 5 | CLOSE (Sales) | Close the loop |

---

## API Keys Needed

- `ANTHROPIC_API_KEY` — Claude agents
- `OPENAI_API_KEY` — GPT-4o agents (PIXEL, CLOSE)
- `GOOGLE_API_KEY` / OAuth — Calendar, Gmail, GA4
- `NOTION_API_KEY` — Notion MCP
- `SUPABASE_URL` + `SUPABASE_ANON_KEY` — Database
- `SERPER_API_KEY` or `BRAVE_API_KEY` — Web search for SIGNAL
- `FAL_API_KEY` — Image generation for PIXEL

Store all in `.env.local`. Never commit to git.

---

## What This Is Not

- Not a client-facing product
- Not multi-tenant
- Not a SaaS (yet)
- Not for Angie or SY (internal to Eric only)

---

## Notes for Claude Code

- Always refer to the owner as Eric
- Default model for new agents: `claude-sonnet-4`
- Agent configs live in `/src/agents/` — one file per agent
- Shared orchestrator logic lives in `/src/orchestrator/`
- All API calls are server-side (Next.js API routes or Supabase edge functions)
- Never expose API keys to the frontend
- Use TypeScript throughout
- Use Tailwind for all styling — no CSS modules
- Component library: shadcn/ui
