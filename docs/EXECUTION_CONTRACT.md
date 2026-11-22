# Relay — Team Execution & Integration Contract

Status: proposed v1 contract for the Nov 22 hackathon build.
Source of truth: `PRD.md` and `DEMO.md`. If this document conflicts with either, the PRD/demo wins. C (core owner) locks endpoint details before V configures production tool calls.

## 1. Repository state and architecture

At the time this contract was prepared, `main` contains the PRD/demo/environment docs and no Wasp application scaffold yet.

Build ONE Wasp full-stack app in `dashboard/`:
- Wasp + its generated Node.js server and React client.
- Prisma + PostgreSQL for durable workflow state.
- Maritime hosts the Wasp Node server and public APIs.
- ElevenLabs + Twilio provide voice calling; Twilio also sends SMS.
- Fiber, Alter and TraceRoot are server-side integrations.

Do not create a FastAPI service, a separate Express server, or a second Next.js dashboard. Do not assume the React client is automatically hosted by the Maritime server; C must confirm the client hosting path.

The root `.env.example` is a credential checklist, not a production runtime file. Wasp server secrets belong in the server-side environment (locally, the Wasp app's `.env.server`; in production, Maritime's environment settings). Use `DATABASE_URL` for PostgreSQL; do not use the old SQLite-style `DB_PATH`.

## 2. Owners and file boundaries

| Owner | Responsibility | Owns |
|---|---|---|
| C (Lovina) | Wasp scaffold, database, backend APIs, orchestration, security, Maritime server deployment | Wasp app spec/config, Prisma schema/migrations, server API handlers, workflow/state machine |
| D | React dashboard inside Wasp | Client pages, components, styles, dashboard interactions |
| V | ElevenLabs agents and voice workflow | Agent prompts/configuration, voice tool definitions, post-call webhook setup, voice test scripts |
| I | Fiber, Alter, TraceRoot, Twilio SMS | Isolated server-side integration adapters and provider smoke tests |

File ownership rules:
- C is the only person who edits the Wasp app spec/config, Prisma schema and core workflow/state-machine files.
- D does not edit the Wasp app spec, Prisma schema, or backend workflow.
- V owns ElevenLabs console configuration and the voice tool schemas. V does not invent or independently implement backend endpoints; V uses the contract below after C confirms it.
- I owns provider adapters in the integration area C establishes after scaffold. I does not edit core workflow or Prisma schema.
- No one commits secrets, real `.env` files, test phone numbers from outside the consented team, or recordings containing personal data.

## 3. Git and merge protocol

Never work directly on `main`. Use one branch per owner:
- C: `feat/wasp-core`
- D: `feat/dashboard`
- V: `feat/voice`
- I: `feat/integrations`

Each owner:
1. Fetches latest `main` before starting.
2. Creates their named branch.
3. Works only in owned files.
4. Runs relevant checks and commits small, descriptive changes.
5. Pushes their branch and opens a PR into `main`.
6. Posts the PR link, changed files, test evidence and blockers in the team Discord.

Integration order:
1. C pushes the Wasp scaffold and initial API contract.
2. C's scaffold PR is reviewed and merged first, so all workstreams share the same base.
3. D, V and I rebase/update from `main`, then open their own PRs.
4. C is integration/release owner: reviews cross-workstream compatibility and coordinates merges. No direct pushes to `main`.

Discord update format (required after each meaningful milestone):
- DONE:
- COMMIT / PR:
- FILES CHANGED:
- TESTS RUN + RESULT:
- BLOCKER:
- CONTRACT CHANGE NEEDED: yes/no (explain if yes)

Only C edits the shared `docs/STATUS.md` if the team chooses to add one. Other owners report status in Discord/PR descriptions to avoid four people editing one status file.

## 4. Proposed Wasp API contract

These routes are a proposed concrete interpretation of the PRD's required API surfaces. C must implement/confirm the paths and payloads, then publish any changes once. V must use the confirmed contract exactly; do not let each agent invent its own field names.

All voice-tool POST requests:
- Require `X-Relay-Secret` and server-side validation.
- Include a unique `eventId` (UUID) for idempotency.
- Include the provider conversation/call ID where available.
- Validate every ID against the active work order and expected call purpose.
- Return a stable JSON response; never return secrets.
- Must not accept manager approval from a voice agent.

### A. Intake — `POST /api/relay/intake`

Request:
```json
{
  "eventId": "uuid",
  "providerConversationId": "elevenlabs-conversation-id",
  "student": { "phone": "+1..." },
  "incident": {
    "residence": "MKV",
    "room": "Main laundry room",
    "asset": "Washer 2",
    "symptom": "Washer will not drain; clothes stuck inside",
    "waterLocation": "inside drum",
    "floorDry": true,
    "errorCode": "OE"
  }
}
```

Response:
```json
{
  "workOrderId": "uuid",
  "result": "created",
  "staffRequestId": "uuid",
  "repairStatus": "OPEN"
}
```

If the same machine already has an open incident, update that work order rather than creating a duplicate. Read back the residence, room, asset and safety details before submission.

### B. Contractor result — `POST /api/relay/contractor-response`

Request:
```json
{
  "eventId": "uuid",
  "workOrderId": "uuid",
  "contractorId": "bluejay",
  "providerConversationId": "elevenlabs-conversation-id",
  "outcome": "OFFER",
  "offer": {
    "availabilityStart": "2026-11-23T09:00:00-05:00",
    "availabilityEnd": "2026-11-23T11:00:00-05:00",
    "amount": 329,
    "currency": "CAD",
    "priceType": "REPAIR_ESTIMATE",
    "scope": "Drain-pump repair estimate",
    "conditionalOnDiagnosis": true,
    "preTax": true
  }
}
```

Allowed outcomes: `OFFER`, `VOICEMAIL`, `DECLINED`, `NO_ANSWER`, `FAILED`. An outcome without an offer must omit `offer`. The backend stores source call IDs and timestamps. Never turn voicemail/no-answer into a quote or availability.

### C. Student preference — `POST /api/relay/student-preference`

Request:
```json
{
  "eventId": "uuid",
  "workOrderId": "uuid",
  "contractorId": "bluejay",
  "preference": "PREFERRED",
  "providerConversationId": "elevenlabs-conversation-id"
}
```

This records preference only. It is NOT approval, authorization to spend, or permission to book.

### D. Contractor confirmation result — `POST /api/relay/contractor-confirmation`

Request:
```json
{
  "eventId": "uuid",
  "workOrderId": "uuid",
  "contractorId": "bluejay",
  "confirmationCallId": "server-created-call-id",
  "providerConversationId": "elevenlabs-conversation-id",
  "confirmed": true,
  "arrivalWindowStart": "2026-11-23T09:00:00-05:00",
  "arrivalWindowEnd": "2026-11-23T11:00:00-05:00"
}
```

The server accepts a positive confirmation only when:
- A manager approval exists for this work order, contractor and scope.
- The confirmation call was initiated by the backend for this approved request.
- The contractor ID and call context match.
- The result is positive and has a valid arrival window.

A student preference or contractor offer cannot satisfy these conditions. Only after positive confirmation may the appointment become `CONFIRMED` and the booked SMS be sent.

### E. ElevenLabs post-call webhook — `POST /webhooks/elevenlabs/post_call`

Verify the official ElevenLabs webhook signature against the raw request body before processing. Persist the provider conversation ID, event ID, agent/call purpose, terminal outcome and timestamp. Deduplicate webhook deliveries. Never trust an unsigned webhook.

### F. Health — `GET /health`

Return HTTP 200 and a small response indicating application health. Do not expose environment values, credentials or database connection details.

## 5. Dashboard contract

D exposes Wasp queries/actions (not public voice-agent tools):
- Query: active work order + staff state + contractor results + approval + appointment.
- Query: ordered timeline events.
- Action: staff accepts with ETA.
- Action: staff marks clothes retrieved / unavailable.
- Action: manager approves or denies the exact vendor, scope and maximum all-in amount.
- Action: reset the demo work order.

Manager approval must be authenticated and checked server-side. The voice agents must never be able to call the approval action. Dashboard polling target: approximately every two seconds, as specified by the PRD.

## 6. Workflow invariants (non-negotiable)

1. Staff retrieval and repair are separate status lanes. Clothes can be retrieved while repair remains pending.
2. Start staff assistance and the three contractor calls after the work order is durably saved; they run independently/in parallel.
3. Wait for all three contractor outcomes or a bounded timeout. A voicemail/no-answer must not stall the workflow.
4. For this demo, Bluejay's CAD $329 pre-tax conditional repair estimate exceeds the CAD $250 threshold. The manager must approve a maximum CAD $400 all-in cap (taxes/fees included), conditional on diagnosis.
5. The student may express a preference but cannot authorize building spend.
6. Only the manager dashboard action can approve this demo booking. Denial leaves the appointment unconfirmed.
7. The booking call starts only after approval. The appointment becomes confirmed only after Bluejay positively confirms an arrival window.
8. Send the booked SMS only after that positive confirmation. Log actual SMS success/failure.
9. Emergency/safety hazard: hand off to designated human and stop normal demo dispatch.
10. Enforce the server-side outbound allowlist on every call and SMS destination. Use consenting stand-in numbers only; keep `DEMO_MODE=true`.
11. Make tool requests, webhooks, call results and notifications idempotent. Replays must not create duplicate work orders, quotes, approvals, calls, appointments or messages.
12. Do not represent a simulated event as a live provider action. Label seeded/simulated data clearly.

## 7. PRD demo acceptance checklist

- [ ] One student call creates/updates the MKV main laundry room / washer 2 / OE ticket; floor is dry.
- [ ] Staff request is separate; staff accepts with 15-minute ETA; student receives ETA SMS; staff can mark clothes retrieved.
- [ ] Three allowlisted stand-in contractor calls start without waiting for staff.
- [ ] Bluejay offer, QuickFix diagnostic-only offer and Metro voicemail are accurately recorded.
- [ ] Recommendation explains the difference in timing and scope; does not treat OE as proof of pump failure.
- [ ] Student callback records preference but cannot book.
- [ ] Manager sees CAD $400 all-in cap and approves/denies in dashboard.
- [ ] Confirmation call cannot start before approval.
- [ ] Appointment and booked SMS appear only after contractor confirms.
- [ ] Reset returns the demo to a reproducible initial state.
- [ ] Full flow can be rehearsed repeatedly with only consenting, allowlisted stand-ins.

## 8. First 30-minute milestones

- C: Wasp scaffold runs locally; publish exact generated project structure, API paths, payloads and database connection requirement.
- D: agree on the work-order screen layout and implement the shell against typed mock data until C's query is available; replace mocks with real Wasp query once merged.
- V: configure the four agents and draft tool JSON schemas from section 4; do not point them at a guessed/unverified endpoint.
- I: verify each provider credential independently, build isolated adapters with mocked provider responses, and report which integrations are genuinely live vs mocked.

Every owner reports status with the required Discord template. C is the single integration/release owner; the PRD remains the product source of truth.
