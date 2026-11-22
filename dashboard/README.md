# Relay Wasp app

One Wasp app (React + Node + Prisma/PostgreSQL) for the washer demo in `../DEMO.md`.

| Page | URL | Who |
| --- | --- | --- |
| Student | `/` | Phone browser: Talk to Relay, End call, live updates for this browser's session only |
| Operator dashboard | `/operator` | Laptop: staff actions, simulated contractor results, manager approval, simulated confirmation, timeline, reset |

## Run locally (WSL/Linux, Node >= 24.22.1)

```bash
npm i -g @wasp.sh/wasp-cli@0.22.0
cd dashboard
cp .env.server.example .env.server   # set RELAY_TOOL_SECRET; add ElevenLabs values for live voice
wasp start db                        # terminal 1: Postgres in Docker
wasp db migrate-dev                  # once
wasp start                           # terminal 2: client :3000, server :3001
```

Checks (server running):

```bash
npm test          # 9 unit tests for the rules in src/server/relay/domain.ts
npm run smoke     # 56 end-to-end HTTP checks. WARNING: resets the demo database
```

Rehearse without voice: set `ALLOW_TEST_REPORT=true` and open `/?test=1`. The student page then shows **Send test report
(no voice)**, which saves DEMO.md's report through the same intake path, labelled as a test report on the timeline.

## What the server enforces

- **Intake** saves before the agent is told "saved". One open work order per washer; an identical retry is a
  no-op and a changed report updates the same order. Water on the floor or a reported hazard escalates to
  staff (SAFETY) and stops contractor outreach.
- **Staff lane** (`REQUESTED → ACCEPTED (ETA) → RETRIEVED`, or `UNAVAILABLE` with the manager taking over) is
  separate from the **repair lane** (`OPTIONS_PENDING → PENDING_APPROVAL → CONFIRMATION_PENDING → CONFIRMED`,
  or `DENIED`, or `ESCALATED`).
- **Contractor results** (Bluejay $329 repair estimate, QuickFix $99 diagnostic only, Metro voicemail) and the
  **appointment** are seeded and labelled simulated. No contractor is ever contacted.
- **Approval**: $329 is over the $250 threshold, so the manager must approve an all-in cap ($400 default,
  stored apart from the estimate). **Simulated confirmation returns 409 unless the manager approved.**
- Every transition is a compare-and-set and every timeline event has a unique dedupe key, so double clicks,
  agent retries and polling never duplicate a step. Reset deletes every session; stale student pages start a
  new session automatically.

## ElevenLabs intake tool contract

`POST {PUBLIC_URL}/api/relay/intake` with headers `Content-Type: application/json` and
`X-Relay-Secret: <RELAY_TOOL_SECRET>`.

```json
{
  "demo_session_id": "{{demo_session_id}}",
  "residence": "MKV",
  "room": "main laundry room",
  "washer": "2",
  "symptom": "Washer won't drain; clothes stuck inside",
  "floor_status": "dry",
  "error_code": "OE",
  "safety_hazard": false,
  "hazard_details": null,
  "conversation_id": "{{system__conversation_id}}"
}
```

`floor_status`: `dry`, `wet` or `unknown`. `error_code` is what the display shows (or omit it).

| Status | Body | Meaning |
| --- | --- | --- |
| 201 | `{ok: true, work_order_id, work_order_number, created: true, duplicate: false, safety_escalated, message}` | Saved (new order) |
| 200 | same, `created: false` | Same washer already open: updated, or an identical retry (`duplicate: true`) |
| 400 | `{ok: false, error: "invalid_request", fields: [...], message}` | Missing or invalid fields; nothing saved |
| 401 / 503 | `{ok: false, error: "unauthorized" \| "not_configured", message}` | Bad secret / server not configured |
| 404 | `{ok: false, error: "unknown_session", message}` | Session id unknown (demo was reset) |
| 500 | `{ok: false, error: "save_failed", message}` | Database failure; nothing saved |

`message` is what the agent should say next. On failure it starts "The report was NOT saved".

Test it:

```bash
curl -s -X POST localhost:3001/api/relay/intake -H "Content-Type: application/json" \
  -H "X-Relay-Secret: $RELAY_TOOL_SECRET" \
  -d '{"demo_session_id":"<session id>","residence":"MKV","room":"main laundry room","washer":"2","symptom":"Washer will not drain","floor_status":"dry","error_code":"OE"}'
```

## ElevenLabs agent setup (dashboard, once)

1. Create agent **Relay intake**. Put its id in `EL_AGENT_INTAKE_ID`. Authentication: enable private agent
   (the server issues a conversation token per session).
2. First message: `Hi, I'm Relay, an AI assistant for residence maintenance. What's going on?`
3. System prompt:

   > You are Relay, an AI assistant that helps university residence students report maintenance problems. Say
   > you are an AI assistant. Collect: residence, laundry room, machine number, what is wrong, whether water is on
   > the floor or stays inside the drum, and any code on the display. Ask at most three short questions, only for
   > missing details. Read back the residence, room and machine, the floor status and the code, and let the
   > student correct them. Then call `save_work_order`. Only if it returns `ok: true`, say what its `message`
   > says; if `ok` is false, follow its `message` and never say the report was saved. A display code such as OE
   > is a reported symptom: do not diagnose it. If the student mentions water on the floor, smoke, sparks, a
   > burning smell or feeling unsafe, set `safety_hazard` true, tell them to stay away from the machine and
   > contact residence staff, and call the tool. Never promise prices, repair times or approvals.

4. Tool `save_work_order`: Webhook, POST, the URL above, header `X-Relay-Secret` (store it as a workspace
   secret), body params as in the contract. Set `demo_session_id` to the dynamic variable `demo_session_id` and
   `conversation_id` to `system__conversation_id`; the LLM fills the rest. `floor_status` is an enum
   (`dry`, `wet`, `unknown`); `safety_hazard` is a boolean.
5. The student page starts the session with `dynamicVariables: { demo_session_id }`, so the saved work order
   lands on that phone's page.

## TraceRoot

`src/server/tracing.ts` starts the SDK once in the Wasp `setupFn` when `TRACEROOT_API_KEY` is set and fails
open otherwise. Spans: `relay.voice_session.create`, `relay.intake.tool`, `relay.work_order.persist`,
`relay.safety.classify`, `relay.staff_request.create`, `relay.staff_status.update`,
`relay.contractor_results.seed`, `relay.recommendation.compute`, `relay.manager_decision`,
`relay.confirmation.guard`, `relay.appointment.simulate_confirm`, `relay.student_update.publish`,
`relay.demo.reset`, `relay.error`. Attributes are synthetic ids, outcomes and reason codes only; no audio,
transcripts, secrets or credentials.
