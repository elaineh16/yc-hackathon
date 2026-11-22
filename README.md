# Relay — AI maintenance coordinator

YC Startups × ElevenLabs Hackathon, Nov 22, 2026.

**`PRD.md` is the source of truth.** Read it and `DEMO.md` before coding. The team ownership, API handoff, Git workflow and acceptance checklist are in `docs/EXECUTION_CONTRACT.md`.

## Current architecture

One Wasp full-stack application in `dashboard/`:
- Wasp React student page and operator dashboard.
- Wasp Node.js server and server actions/APIs.
- Prisma + PostgreSQL.
- ElevenLabs React SDK for live browser voice.
- Maritime hosts the Wasp Node server.

Contractor outcomes and appointment confirmation are simulated and must be labelled as such. Do not build live contractor calling or unrelated sponsor integrations unless the team explicitly changes the PRD.

## Team workstreams

- C: Wasp scaffold, database, server APIs/actions, workflow and Maritime.
- D: Student page and operator dashboard inside Wasp.
- V: ElevenLabs agent, browser voice session and intake tool.
- I: QA, seeded demo fixtures, acceptance tests and reset/rehearsal.

## Local environment

Use WSL/Linux for Wasp development. Copy the root environment template to the Wasp app's server environment file after the scaffold exists:

```bash
cp .env.example dashboard/.env.server
```

Fill in the values locally. Never commit `dashboard/.env.server`.

See `PRD.md` for the exact demo and `DEMO.md` for the rehearsal script.
