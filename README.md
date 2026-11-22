# Relay — AI maintenance coordinator

YC Startups × ElevenLabs Hackathon, Nov 22, 2026.

**`PRD.md` is the product source of truth.** Read it and `DEMO.md` before coding. The two-person ownership split, API handoff and acceptance checklist are in `docs/EXECUTION_CONTRACT.md`.

## Required demo architecture

One Wasp full-stack application in `dashboard/`:
- Wasp React student page and staff/manager dashboard.
- Wasp Node.js server, APIs and server actions.
- Prisma + PostgreSQL.
- One ElevenLabs browser voice intake agent using the React SDK.
- Maritime hosts the Wasp Node server.
- Contractor responses and appointment confirmation are seeded/simulated and labelled.

**Twilio is optional only.** It is not required for the judging path and must not delay the browser voice flow. Do not add separate FastAPI, Express or Next.js applications.

## Two-person work split

- **Backend owner:** Wasp scaffold, Prisma schema, PostgreSQL, intake API, state transitions, seeded contractor results, staff/manager actions, approval enforcement, reset and Maritime deployment.
- **UI/voice owner:** student mobile page, ElevenLabs browser session, staff/manager dashboard, timeline and integration with the backend API/actions.

Both work in the same Wasp application on separate branches:
- Backend: `feat/wasp-core`
- UI/voice: `feat/dashboard`

## Local environment

Use WSL/Linux. After the Wasp scaffold exists:

```bash
cp .env.example dashboard/.env.server
```

Fill in real values locally. Never commit `dashboard/.env.server`.

See `PRD.md` for product requirements, `DEMO.md` for the rehearsal script and `docs/EXECUTION_CONTRACT.md` for the two-person execution plan.
