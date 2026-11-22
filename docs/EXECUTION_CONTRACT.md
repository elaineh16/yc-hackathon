# Relay — Two-Person Execution Contract

**Product source of truth:** `PRD.md`. **Rehearsal script:** `DEMO.md`. If this document conflicts with either, follow the current files on `main`.

## 1. Locked product and architecture

Build the exact single-washer demo:

1. Student opens the mobile page and starts a live, full-duplex ElevenLabs browser voice session.
2. Relay asks at most three clarification questions and reads back MKV, main laundry room, washer 2, dry floor and reported `OE`.
3. One authenticated server tool persists the work order before Relay says it was saved.
4. Wasp starts the staff request and seeded contractor progression.
5. Staff and manager actions happen in the Wasp operator dashboard.
6. Bluejay, QuickFix, Metro and the appointment are seeded/simulated and visibly labelled.
7. Manager approval is required before simulated confirmation. Staff retrieval and repair status remain separate.

**One application only:** Wasp React client + Wasp Node server + Prisma/PostgreSQL in `dashboard/`. Maritime hosts the Wasp Node server. The browser page uses the ElevenLabs React SDK; the ElevenLabs API key remains server-side.

**Twilio is optional only.** If an existing Twilio assistant/number is already working, preserve it as an optional fallback/bonus. Do not make it a dependency, do not replace the required browser-based ElevenLabs flow, and do not spend core build time on it.

Do not create a separate FastAPI, Express or Next.js app. Do not add live contractor calls, live bookings, or mandatory Fiber/Alter/TraceRoot integrations. Contractor responses and confirmation remain simulated.

## 2. Two owners, two branches

| Owner | Branch | Owns | Deliverable |
|---|---|---|---|
| **Backend owner — you** | `feat/wasp-core` | Wasp scaffold/config, Prisma schema/migrations, database, custom intake API, server queries/actions, workflow/state transitions, seeded results, approval checks, reset, health endpoint and Maritime deployment | Working backend and durable demo workflow |
| **UI/voice owner — teammate** | `feat/dashboard` | Student mobile page, ElevenLabs React SDK browser session, agent prompt/tool setup in coordination with backend owner, staff/manager dashboard, timeline, polling, loading/error/retry states and responsive styling | Complete student + operator experience inside the same Wasp app |

The UI/voice owner can start immediately by sketching the page/component structure and typed mock view-models. As soon as the backend owner pushes the minimal Wasp scaffold, the UI/voice owner updates their branch from the scaffold and implements inside it. Do not create a second scaffold.

### File boundaries

- Backend owner alone edits `main.wasp.ts`, `schema.prisma`, migrations and server workflow files.
- UI/voice owner edits client pages, components and styles.
- Agree on shared TypeScript request/response types before connecting the UI. Do not independently rename API fields.
- Neither person commits real `.env` files, API keys or tool secrets.
- Work on separate branches; no direct pushes to `main`.

## 3. Backend contract to publish for the UI/voice owner

The PRD requires a Wasp custom POST intake API but does not prescribe the exact route or JSON field names. Backend owner must publish these before the ElevenLabs tool is connected:

- Exact public HTTPS URL and method.
- Required auth header and server-side secret validation.
- Exact request JSON, including demo session ID, residence, room, washer, symptom, water/floor status and reported error code.
- Exact success and error JSON.
- Idempotency key and duplicate-report behavior.
- How the returned workOrderId links to the student's session.
- Confirmation that success is returned only after database persistence.

Recommended route if no existing route is implemented: `POST /api/relay/intake`. This is a recommendation, not a live endpoint yet. Also expose `GET /health`.

Student UI should call Wasp server queries/actions for the active work order and timeline. Do not expose manager approval or simulated confirmation as ElevenLabs voice tools.

## 4. Minimal data and workflow

Use Prisma/PostgreSQL for:
- DemoSession
- WorkOrder
- StaffRequest
- ContractorResult (seeded and labelled simulated)
- ManagerDecision
- Appointment (simulated)
- TimelineEvent

Keep two independent state lanes:

**Staff lane:** REQUESTED → ACCEPTED (ETA) → RETRIEVED, or UNAVAILABLE.

**Repair lane:** OPTIONS_PENDING → RECOMMENDED → PENDING_APPROVAL → APPROVED / DENIED → CONFIRMATION_PENDING → CONFIRMED.

Seeded contractor data:
- Bluejay: next day, $329 CAD pre-tax repair estimate, conditional on diagnosis.
- QuickFix: same day, $99 CAD diagnostic only, repair extra.
- Metro: voicemail; price and availability unknown.

The $329 pre-tax estimate exceeds the $250 auto-approval threshold. Manager approves a $400 CAD all-in cap including taxes and fees, conditional on diagnosis. Student preference is never manager approval. Simulated confirmation is accepted only after manager approval. Denial leaves appointment unconfirmed.

## 5. Edge cases to test

- Microphone permission denied; voice connection fails; retry works without false connected state.
- Missing/unclear intake details; maximum three clarifying questions; correction before save.
- Intake API/database failure; no false “saved” response.
- Duplicate intake for same open washer; one work order only.
- Wrong residence/room/washer corrected before persistence.
- `OE` treated as reported symptom, not confirmed pump diagnosis.
- Leak/electrical/smoke/unsafe condition stops normal flow and escalates to residence staff.
- Staff unavailable updates student and routes retrieval to manager.
- Clothes retrieved while repair remains pending.
- QuickFix diagnostic-only scope is not compared as a complete repair quote.
- Metro voicemail stays unknown for price/availability.
- Manager denial leaves appointment unconfirmed.
- Confirmation before approval is rejected server-side.
- Duplicate approve/confirm calls do not create duplicate appointment/timeline events.
- Session isolation: one student cannot see another session's work order.
- Polling does not write duplicate events.
- Reset returns the demo to a clean initial state and invalidates stale session state.
- All seeded contractor outcomes and appointment are visibly labelled simulated.
- API keys/tool secrets stay server-side and out of Git.

## 6. One-hour build order

1. **First 10 minutes — scaffold and agree contract.** Backend owner creates the minimal Wasp app and pushes it. UI/voice owner prepares the student and dashboard component shells against typed mock data.
2. **Minutes 10–25 — vertical slice.** Backend owner creates the core schema and intake API. UI/voice owner builds the work-order dashboard and student status view using the agreed response shape.
3. **Minutes 25–40 — close the workflow.** Add staff accept/retrieve/unavailable, seeded contractor results, manager approve/deny, and server-side confirmation guard. UI/voice owner wires polling and dashboard actions.
4. **Minutes 40–50 — live voice.** Connect the ElevenLabs browser session and intake tool to the confirmed endpoint. Do not put the API key in the browser. Twilio remains optional.
5. **Minutes 50–60 — test and rehearse.** Run the critical tests in section 5 and the demo script in `DEMO.md`. Fix broken state transitions before visual polish.

If time is lost, preserve this priority: (1) durable intake, (2) dashboard shows the same work order, (3) staff state updates, (4) manager approval guard, (5) simulated contractor/appointment states, (6) live voice polish. Never claim an incomplete or simulated provider action is live.

## 7. Git workflow

- Backend owner: `feat/wasp-core`
- UI/voice owner: `feat/dashboard`

Both start with `git fetch origin`, switch to their branch, commit small changes and open a PR to `main`. Once the backend scaffold is merged, the UI/voice owner updates their branch from `main`. Coordinate any API/schema change before merging.

Discord update format:

```text
OWNER:
DONE:
COMMIT / PR:
FILES CHANGED:
TESTS RUN + RESULT:
BLOCKER:
API / SCHEMA CHANGE: YES / NO
```
