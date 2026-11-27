# Relay — AI maintenance coordinator

YC Startups × ElevenLabs Hackathon, Nov 22, 2026.

**`PRD.md` is the product source of truth.** `DEMO.md` is the rehearsal script. `docs/EXECUTION_CONTRACT.md` defines the two-person ownership split. **TraceRoot is required**; see `docs/TRACEROOT.md`.

## Required architecture

One Wasp full-stack application in `dashboard/`:
- Wasp React student page and staff/manager dashboard.
- Wasp Node.js server, APIs and server actions.
- Prisma + PostgreSQL.
- ElevenLabs browser voice intake.
- Maritime hosts the Wasp Node server.
- Seeded contractor responses and appointment confirmation, visibly labelled simulated.
- TraceRoot TypeScript SDK on the server, with explicit spans across the agent/tool/work-order/approval workflow, plus detectors and evaluation cases.

Do not create a second frontend/backend application. Do not put TraceRoot or ElevenLabs secrets in the browser.

## Two-person ownership

- **Backend + reliability (you):** Wasp scaffold, Prisma, APIs, workflow/state machine, server-side approval enforcement, TraceRoot server initialization/spans, detectors/evals and Maritime deployment.
- **Student UI + voice + dashboard (teammate):** student mobile page, ElevenLabs React SDK browser session, operator dashboard, timeline, polling, retry/error states, and safe correlation IDs passed into the server workflow.

Both work in the same Wasp app on separate branches: `feat/wasp-core` and `feat/dashboard`. The other legacy feature branches are not active workstreams.

## Setup

Use WSL/Linux and **Node.js >=24.22.1**. This is the current Wasp CLI requirement and also exceeds TraceRoot CLI's Node.js 20.12 minimum.

From the repository root on `feat/wasp-core`:

```bash
npm i -g @wasp.sh/wasp-cli@latest
wasp version
wasp new dashboard -t minimal
cd dashboard
wasp start
```

After the Wasp scaffold starts, return to the repository root and configure TraceRoot:

```bash
cd ..
npx -y traceroot-cli@latest setup
```

Complete the browser sign-in and inspect the generated diff. The CLI setup flow configures the project and asks the coding agent to add the TypeScript SDK instrumentation. Do not blindly accept generated changes; verify server-only secrets and the Wasp server bootstrap.

After the app runs, verify:

```bash
traceroot doctor
traceroot traces list --since 1h
traceroot traces get <trace-id>
```

See `docs/TRACEROOT.md` for the exact Relay span coverage, redaction rules, detectors, eval cases and acceptance gate.

## Environment

Copy `.env.example` to the Wasp server environment after the scaffold exists. Fill real values locally. Never commit `dashboard/.env.server`, `.env`, API keys, tool secrets or real student information.

See `PRD.md` for product requirements and `DEMO.md` for the exact demo sequence.
