# Super — the AI building superintendent

A tenant calls in with a problem. Super triages it, phones contractors until one says yes, books the visit,
and calls the tenant back to confirm. The property manager watches it all live on a dashboard.

Built at the YC Startups × ElevenLabs Hackathon, Nov 22, 2026.
Design doc: https://claude.ai/artifact/1C5gCtpm5JQpYCCWnoMvzc

## Repo layout

```
backend/     TypeScript + Express API: agent tool endpoints, dispatch loop, post-call webhook, JSON store
  src/routes/tools.ts      tools the ElevenLabs agents call mid-conversation
  src/routes/webhooks.ts   post-call transcript webhook
  src/routes/api.ts        REST API for the dashboard
  src/dispatch.ts          call contractors in order, retry, then call tenant to confirm
  src/elevenlabs.ts        outbound call + webhook signature
  src/seed.ts              tenants + contractors  <-- PUT TEAMMATES' REAL PHONE NUMBERS HERE
  public/index.html        fallback dashboard (works now)
  scripts/simulate.ts      runs the whole flow with no phones
agents/      system prompts, first messages and tool configs for the 3 ElevenLabs agents
dashboard/   the real Wasp dashboard goes here (+ API contract)
```

## Run it

```bash
cd backend
cp .env.example .env        # leave ELEVENLABS_API_KEY empty for DRY RUN (no real calls)
npm install
npm run dev                 # http://localhost:3001  (fallback dashboard at /)
npm run simulate            # in another terminal: fake a full ticket lifecycle
```

For real calls: fill in `.env`, deploy the backend somewhere public (Maritime, or a tunnel like
`cloudflared tunnel --url http://localhost:3001`), and point the agent tools and the post-call webhook at it
(see `agents/README.md`).

## Who does what

| Person | Lane | First milestone |
| --- | --- | --- |
| 1. Voice | ElevenLabs agents, phone number, prompts (`agents/`) | 12:15 — real inbound call reaches `create_ticket` |
| 2. Backend | `backend/`, deploy on Maritime, webhooks, dispatch loop, traceroot | 12:15 — public URL live with tool endpoints |
| 3. Frontend | `dashboard/` (Wasp / Open SaaS) on the `/api` contract | 1:00 — board + detail on real API |
| 4. Demo & glue | perks, Twilio verification, seed phones, testing, script, video, submission | 2:15 — backup recording; 2:40 — submitted |

Checkpoints: **12:15** inbound works → **1:00** dispatch calls a teammate → **1:45** full loop on real phones
→ **2:15** feature freeze + backup recording → **2:40** submit (deadline 3:00, late isn't judged).

## Partner tools used (keep updated for the submission form)

ElevenLabs (Agents, phone calls), Maritime (backend hosting), Wasp / Open SaaS (dashboard), Codevisor (coding agent),
traceroot (observability).
