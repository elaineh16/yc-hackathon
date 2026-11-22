# Relay — Team Execution Contract

**Source of truth:** `PRD.md` first, then `DEMO.md`. This document only assigns owners and coordinates implementation. If anything conflicts with the PRD, follow the PRD.

## 1. The current product (read this before coding)

Build the exact single-washer demo in the current PRD:

- A student opens the student page on a phone and starts a live, full-duplex ElevenLabs browser voice session.
- Relay asks at most three clarification questions and reads back MKV, the main laundry room, washer 2, dry floor, and reported `OE`.
- One server-side intake tool saves the report and returns success only after the work order is persisted.
- Wasp starts the staff request and seeded contractor progression.
- Staff and manager actions happen in the Wasp operator dashboard.
- Contractor outcomes and the final appointment are **simulated and visibly labelled**. Do not call real contractors.
- Manager approval is required for the $329 pre-tax estimate; the manager approves a $400 CAD all-in cap, conditional on diagnosis.
- The appointment appears only after the manager approves and the seeded confirmation is recorded.
- The student page polls and shows staff and repair updates. Staff retrieval and repair remain separate status lanes.

Do not expand the product into a generic operations agent.

## 2. Architecture

Build **one Wasp full-stack application** in `dashboard/`:

- Wasp: React student page, React operator dashboard, generated Node.js server, Wasp APIs/actions.
- Prisma + PostgreSQL: durable demo session, work order, staff request, seeded contractor outcomes, manager decision, appointment and timeline.
- Maritime: hosts the Wasp Node.js server and exposes the public health and intake endpoints.
- ElevenLabs React SDK: live browser voice session. The ElevenLabs API key stays server-side; the server issues the browser connection credential.
- Contractor calls are not real provider calls in this PRD. Contractor outcomes are deterministic seeded demo events.

**Do not create** FastAPI, a separate Express service, a separate Next.js app, Twilio phone calling, live contractor dialling, or required Fiber/Alter/TraceRoot integrations. Those are not part of the current PRD's required demo. Do not spend the four-hour build wiring them in. Optional sponsor integrations require an explicit team decision and must not delay the required flow.

Use PostgreSQL and `DATABASE_URL`; do not use the old SQLite `DB_PATH`.

## 3. Four owners and file boundaries

| Owner | Owns | Primary deliverable |
|---|---|---|
| C — Core/backend | Wasp scaffold, Prisma schema, server APIs/actions, workflow state, server-issued ElevenLabs connection credential, security, Maritime server deployment | Working Wasp app and durable backend |
| D — Dashboard | React student page and React operator dashboard inside the same Wasp app | Mobile student voice/status page and manager/staff console |
| V — Voice | ElevenLabs agent, React SDK browser session, intake prompt, browser connection and server-tool configuration | Live student conversation that saves a work order |
| I — QA/demo workflow | Seeded contractor fixtures/progression, acceptance tests, idempotency/replay tests, safety tests, reset/rehearsal checklist | Reproducible demo with verified state transitions |

### File ownership

- C alone edits `main.wasp.ts`, `schema.prisma`, database migrations and core workflow/server state transitions.
- D owns client pages, React components, styling and dashboard interactions. D must not create a separate frontend app.
- V owns ElevenLabs console configuration, agent prompt and client-side voice integration. V uses the exact endpoint and payload C confirms; V does not invent routes.
- I owns test plans, test fixtures and tests in the locations C establishes. I does not change core workflow behavior without coordinating with C.
- No one commits `.env`, API keys, signing secrets, phone numbers or other credentials.

## 4. API handoff

The PRD requires one Wasp custom POST intake API used by an ElevenLabs server tool. It does not prescribe an exact URL or JSON field names.

C must publish a short, definitive API contract before V wires the tool. It must include:
1. Exact public HTTPS URL and HTTP method.
2. Required authentication header and how the secret is checked.
3. Exact request JSON schema, including demo session ID and washer/location/symptom details.
4. Exact success and error response JSON.
5. Idempotency behavior for repeated tool calls.
6. How the work order ID is associated with the student's demo session.
7. Confirmation that the tool returns success only after the database write succeeds.

Recommended route if C has no existing reason to choose another: `POST /api/relay/intake`. This is a recommendation, not a route already implemented.

The server must also expose `GET /health`. The student page must obtain its ElevenLabs browser connection credential from the Wasp server; never expose the ElevenLabs API key in browser code.

Dashboard interactions should be Wasp server actions/queries:
- Load active work order and timeline.
- Staff accepts with ETA.
- Staff marks clothes retrieved or unavailable.
- Manager approves or denies the specified booking cap.
- Manager records the seeded confirmation only after approval.
- Reset the demo.

The voice agent must not have a tool that approves spending or confirms a booking.

## 5. Workflow invariants

1. The work order is persisted before the intake agent tells the student it was saved.
2. Repeated intake for the same open washer incident updates the existing order rather than creating duplicates.
3. Ask at most three clarification questions; read back the key details before saving.
4. Treat `OE` as a reported drainage symptom, not proof of a failed drain pump.
5. A reported safety hazard stops normal flow and directs the student to designated residence staff.
6. Staff retrieval and repair have separate statuses. Clothes can be retrieved while repair remains pending.
7. Staff assistance and the seeded contractor progression start independently after intake is saved.
8. Seeded contractor outcomes must be visibly labelled simulated: Bluejay $329 CAD pre-tax next day, conditional on diagnosis; QuickFix $99 CAD same-day diagnostic, repair extra; Metro voicemail.
9. Explain the recommendation using availability, known price and scope. Do not treat unknown values as known.
10. $329 pre-tax is above the $250 auto-approval threshold. Manager approval is required for a $400 CAD all-in cap, conditional on diagnosis.
11. Student preference is not manager approval.
12. Simulated confirmation is blocked until manager approval. Appointment appears only after the confirmation action is recorded.
13. Denial leaves the appointment unconfirmed.
14. Reset returns all state to a repeatable initial demo.
15. Repeated actions and polling must not create duplicate events or notifications.

## 6. Work in parallel immediately

- **C:** Initialize the Wasp app in `dashboard/`, run it locally, define the Prisma models and publish the intake API contract. Push the scaffold as the first PR.
- **D:** Design and implement the student and operator React screens inside the Wasp app. Until C's schema/query is ready, use typed mock data in client-only components and clearly isolate it for replacement.
- **V:** Build the ElevenLabs intake agent prompt and configure the browser-session plan. Verify account access and agent ID. Do not configure a guessed webhook URL; wait for C's confirmed endpoint contract.
- **I:** Turn section 5 and the PRD's “Ready to show” list into executable acceptance tests and seeded fixtures. Start with a test matrix and typed fixture proposal; integrate after C publishes model names.

## 7. Git / PR protocol

Branches:
- C: `feat/wasp-core`
- D: `feat/dashboard`
- V: `feat/voice`
- I: `feat/integrations` (this owner is QA/demo workflow under the current PRD; branch name is retained to avoid renaming confusion).

Everyone works on their own branch, never directly on `main`.

Each owner:
1. `git fetch origin`
2. Switch to their assigned branch.
3. Work only in owned files.
4. Run relevant checks.
5. Commit and push.
6. Open a PR to `main`.
7. Post the PR link, files changed, tests and blockers in team Discord.

C is integration coordinator and reviews shared API/schema changes. Merge C's Wasp scaffold first; D, V and I then update their branches from `main` and open integration PRs. No one silently changes API paths, payloads or database field names.

Discord update format:

```text
OWNER:
DONE:
COMMIT / PR:
FILES CHANGED:
TESTS RUN + RESULT:
BLOCKER:
API / SCHEMA CHANGE NEEDED: YES / NO
```

## 8. Demo acceptance checklist

- [ ] Student page works on phone over HTTPS.
- [ ] One tap starts the ElevenLabs browser voice session; End call works.
- [ ] Relay asks no more than three questions and reads back MKV / main laundry room / washer 2 / floor dry / OE.
- [ ] Successful intake creates one persisted work order and staff request.
- [ ] Repeat intake updates the same open incident.
- [ ] Staff accepts with 15-minute ETA; student page updates; staff can mark clothes retrieved.
- [ ] Bluejay, QuickFix and Metro results appear and are labelled simulated.
- [ ] Recommendation explains price, availability and scope accurately.
- [ ] Manager sees $329 pre-tax and approves a $400 all-in cap; denial path is also tested.
- [ ] Simulated confirmation is blocked before approval and appointment appears after confirmation.
- [ ] Safety hazard stops normal flow.
- [ ] Reset makes the demo repeatable.

## 9. Status reporting

C maintains one short status update in Discord or the PR. Do not have all four people edit a shared status file. Every milestone update must state what is implemented versus mocked/simulated. The team must never describe simulated contractor calls or appointments as real.
