# Relay — Two-Person Execution Contract

**Product source of truth:** `PRD.md`. **Rehearsal script:** `DEMO.md`. **Trace instrumentation contract:** `docs/TRACEROOT.md`.

## 1. Locked architecture

Build the current single-washer demo:

- One Wasp full-stack application: Wasp React client + Wasp Node.js server + Prisma/PostgreSQL in `dashboard/`.
- Student uses the mobile browser page and ElevenLabs full-duplex voice session.
- Authenticated ElevenLabs server tool persists the work order before the agent says it was saved.
- Staff and manager actions happen in the operator dashboard.
- Bluejay, QuickFix, Metro and the appointment are seeded/simulated and visibly labelled.
- Server-side manager approval is mandatory before simulated confirmation.
- TraceRoot is required for agent/tool/workflow observability, detectors and evaluation cases.
- Maritime hosts the Wasp Node server.

Do not create separate FastAPI, Express or Next.js apps. Do not add live contractor calls or live bookings to this demo. Keep an existing Twilio integration only if it is already useful; it is not a dependency for the browser-based judging flow. Do not delete existing credentials or assets without checking whether they are used.

## 2. Two owners, two active branches

| Owner | Branch | Owns | Deliverable |
|---|---|---|---|
| **You — backend + reliability** | `feat/wasp-core` | Wasp scaffold/config, Prisma schema/migrations, PostgreSQL, intake API, server queries/actions, workflow/state machine, idempotency, safety/approval guards, TraceRoot server init and spans, detectors/evals, reset, health endpoint and Maritime deployment | Durable backend, enforceable workflow and inspectable traces |
| **Teammate — student UI + voice + dashboard** | `feat/dashboard` | Student mobile page, ElevenLabs React SDK browser session, voice connection/retry states, operator dashboard, staff/manager UI, timeline, polling, responsive styling and safe correlation-ID handoff | Complete student and operator experience inside the same Wasp app |

The existing `feat/wasp-core` and `feat/dashboard` branches currently point to the same starting commit as `main`; they contain no implementation yet. `feat/voice` and `feat/integrations` also point to that same commit and are not separate active workstreams. Do not delete a branch if anyone has unpushed local work; otherwise, stop using the extra branches and consolidate into the two active branches.

### File boundaries

- Backend owner alone edits Wasp server config, `schema.prisma`, migrations, server APIs/actions, workflow code and TraceRoot bootstrap.
- UI/voice owner edits Wasp client pages, components and styles, and the ElevenLabs browser session integration.
- Agree the intake request/response types and session/work-order correlation fields before either side wires the integration.
- Never expose TraceRoot or ElevenLabs secrets in browser variables or client bundles.
- Both open PRs to `main`; no direct pushes to `main`.

## 3. Backend contract for the UI/voice owner

The backend owner publishes before voice integration:
- Exact public HTTPS intake URL and method.
- Required auth header and server-side secret validation.
- Exact JSON request: demo session ID, residence, room, washer, symptom, floor/water status and reported error code.
- Exact success/error response and returned workOrderId.
- Idempotency key and duplicate-report behavior.
- How the workOrderId and safe trace correlation metadata are associated with the student session.
- Proof that success is returned only after database persistence.

Recommended route if none exists: `POST /api/relay/intake` (recommendation, not a live endpoint). Also expose `GET /health`.

## 4. Minimal data and state

Use Prisma/PostgreSQL for DemoSession, WorkOrder, StaffRequest, ContractorResult, ManagerDecision, Appointment and TimelineEvent.

Keep independent state lanes:

**Staff:** REQUESTED → ACCEPTED (ETA) → RETRIEVED, or UNAVAILABLE.

**Repair:** OPTIONS_PENDING → RECOMMENDED → PENDING_APPROVAL → APPROVED / DENIED → CONFIRMATION_PENDING → CONFIRMED.

Seeded outcomes:
- Bluejay: next day, $329 CAD pre-tax repair estimate, conditional on diagnosis.
- QuickFix: same day, $99 CAD diagnostic only, repair extra.
- Metro: voicemail; price and availability unknown.

The $329 estimate exceeds the $250 auto-approval threshold. Manager approves a $400 CAD all-in cap including taxes and fees, conditional on diagnosis. Student preference is never approval. Confirmation is accepted only after manager approval. Denial leaves the appointment unconfirmed.

## 5. TraceRoot implementation ownership

Backend owner:
1. Use Node.js >=24.22.1 for the current Wasp CLI (this also exceeds TraceRoot CLI's Node.js 20.12 minimum). From the repository root on `feat/wasp-core`, install Wasp and create the scaffold with `npm i -g @wasp.sh/wasp-cli@latest`, `wasp new dashboard -t minimal`, then `cd dashboard && wasp start`. After the scaffold starts, return to the repository root and run `npx -y traceroot-cli@latest setup`.
2. Review the generated TypeScript SDK setup. Initialize once in the Wasp Node server startup.
3. Instrument agent/tool and workflow boundaries listed in `docs/TRACEROOT.md`; do not assume ElevenLabs' hosted model internals are automatically visible.
4. Keep keys server-only, redact user content, and make trace export fail-open.
5. Verify the happy path and failure paths with `traceroot doctor`, `traceroot traces list --since 1h`, and `traceroot traces get <trace-id>`.
6. Add the initial detector/evaluation cases in `docs/TRACEROOT.md`.

UI/voice owner:
- Pass a stable, non-sensitive demoSessionId through the browser voice session and intake tool to the Wasp backend.
- Display user-facing connection, intake and workflow errors accurately.
- Never display “saved” before the server confirms persistence.
- Help verify that a single demo run can be correlated from the student interaction to the backend work order without exposing secrets or transcripts.

## 6. Critical edge cases

- Mic denied / voice connection failure / retry without false connected state.
- Missing or unclear intake details; maximum three questions; correction before save.
- Intake API or database failure; no false “saved” response.
- Duplicate intake for same open washer; one work order only.
- Wrong residence/room/washer corrected before persistence.
- `OE` remains a reported symptom, not a confirmed pump diagnosis.
- Leak/electrical/smoke/unsafe condition stops normal flow and escalates to residence staff.
- Staff unavailable updates student and routes retrieval to manager.
- Clothes retrieved while repair remains pending.
- QuickFix diagnostic-only scope is not compared as a complete repair quote.
- Metro voicemail stays unknown for price/availability.
- Manager denial leaves appointment unconfirmed.
- Confirmation before approval is rejected server-side, even if UI is bypassed.
- Duplicate approve/confirm calls do not create duplicate appointment/timeline events.
- Session isolation: one student cannot see another demo session's work order.
- Polling does not create writes; reset invalidates stale session state.
- TraceRoot outage does not break the core workflow.
- No API keys, transcripts, audio or personally identifying student data in traces.

## 7. One-hour execution sequence

1. **0–10 min:** backend owner creates the minimal Wasp scaffold and pushes it; teammate prepares page shells and typed mock view-models.
2. **10–25 min:** backend owner creates core schema + intake API and publishes the request/response contract; teammate builds student and operator screens against that contract.
3. **25–40 min:** wire staff status, seeded contractor outcomes, recommendation, manager approve/deny, confirmation guard and student polling.
4. **40–50 min:** run TraceRoot CLI setup, initialize the server SDK, add the first workflow spans and connect the ElevenLabs browser session to the real intake endpoint.
5. **50–60 min:** run the happy path plus critical failure cases; inspect the resulting TraceRoot trace; fix state-integrity or approval bugs before visual polish.

A fully polished, production-hardened system is not honestly guaranteed in one hour from an empty app scaffold. The one-hour target is a working, repeatable demo vertical slice with the critical safety, persistence and approval invariants enforced and observable.

## 8. Git workflow

- Backend: `feat/wasp-core`
- UI/voice: `feat/dashboard`
- Both sync from current `main`, commit small changes, open PRs, and coordinate API/schema changes before merging.
- Do not wait on the stale documentation PR. The new documentation PR should be reviewed and merged first; then scaffold work starts on the backend branch.

Discord update format:

```text
OWNER:
DONE:
COMMIT / PR:
FILES CHANGED:
TESTS RUN + RESULT:
TRACE ID / TRACE VERIFIED:
BLOCKER:
API / SCHEMA CHANGE: YES / NO
```
