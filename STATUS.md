# Relay V1 status

As of 2026-11-22, 23:40 EST. Branch `relay-v1`. Everything marked "verified" was executed against the running application; logs are in [docs/evidence/](docs/evidence/).

## Results

| Suite | Command (from `app/` unless noted) | Result | Log |
| --- | --- | --- | --- |
| Unit | `npx tsx --test tests/unit/*.test.ts` | **17 / 17 pass** | [unit-tests-run.txt](docs/evidence/unit-tests-run.txt) |
| API (workflow, reliability, safety) | `npx tsx --test --test-concurrency=1 tests/api/workflow.test.ts tests/api/reliability.test.ts` | **31 / 31 pass** | [api-tests-run.txt](docs/evidence/api-tests-run.txt) |
| Browser journey (Playwright, Chrome) | `cd app/e2e && npx playwright test` | **8 / 8 pass** (28 s) | [e2e-journey-run.txt](docs/evidence/e2e-journey-run.txt) |
| Agents on the real model | `npx tsx --test --test-concurrency=1 tests/api/agent.test.ts` | **2 / 2 pass** (165 s on CPU) | [agent-tests-run.txt](docs/evidence/agent-tests-run.txt) |
| Voice (real ElevenLabs agent, text mode) | scratchpad script, transcript saved | **Filed RLY-0055 through the client tool** | [voice-clienttool-run.txt](docs/evidence/voice-clienttool-run.txt) |
| Type-check | `npx tsc --noEmit -p tsconfig.json` | **clean** | |

The API and browser suites need the dev server running with `RELAY_TEST_HOOKS=true` and reset all cases.

## Acceptance scenarios

| Scenario | Status | Where |
| --- | --- | --- |
| 1–12: leaking kitchen sink, resident → manager → plumber → approval → confirmed visit → work → resident verification → RESOLVED, same persisted case, full history | **Pass**: over HTTP as three signed-in users, and in real Chrome with three separate browser sessions | `tests/api/workflow.test.ts`, `e2e/tests/journey.spec.ts` |
| Second category: appliance (washer) from report to RESOLVED, approved by policy | **Pass** | `tests/api/workflow.test.ts` |
| Chat intake: the agent asks its own follow-ups and files a CHAT case through the server | **Pass** (real model) | `tests/api/agent.test.ts` |
| Coordinator: wakes on the new case, reads it through tools, proposes an eligible vendor that policy holds for the manager; the manager accepts and the offer is sent | **Pass** (real model) | `tests/api/agent.test.ts` |
| Voice intake: real ElevenLabs agent asks, reads back, files through the client tool | **Verified in text mode**; live microphone not tested | `docs/evidence/voice-clienttool-run.txt` |

## Reliability and safety tests (all passing)

Every item is in `tests/api/reliability.test.ts` or `tests/api/workflow.test.ts`:

- **Duplicate intake:** a retried submission returns the same case, and concurrent identical submissions create one case.
- **Repeated actions:** a repeated assign, approve or cancel, and three concurrent offer responses, take effect exactly once.
- **Unauthorized access:**
  - no session gets 401 on every operation;
  - the wrong role gets 403;
  - another resident's case returns 404;
  - another contractor's job returns 404;
  - another property's case returns 404;
  - self sign-up is blocked.
- **Missing manager approval:** a visit cannot be confirmed and work cannot start; inspection-first responses need an explicit cap.
- **Contractor decline:** the case returns to the manager and the vendor loses access.
- **Missing contractor response:** the offer expires through the durable sweep (timestamps, not timers), and the sweep is idempotent.
- **Invalid state transitions** return 409.
- **Appointment conflict:** the same vendor and time for a second case returns 409; that window is marked unavailable and the contractor is asked for new times.
- **Cancellation after an offer** withdraws it from the vendor.
- **Background jobs and restart recovery:**
  - deadlines are swept from the database;
  - coordinator triggers are written in the same transaction as the event and re-queued by the sweep;
  - the dev server was restarted several times during the session and pending work resumed.
- **Emergency escalation:** a gas smell is escalated, and routine dispatch is blocked (409).
- **AI intake failure:** the chat returns `ai_unavailable` and the page switches to the form. Code path only: the model was up during the runs.
- **Wrong or missing voice credentials:** a clear 502/503 that points to the form. With the valid key a real token is issued (tested).
- **Failed database operation:** an injected fault rolls the whole intake back, and a retry with the same request id succeeds.
- **Completion without verification:** the case stays AWAITING_VERIFICATION after completion and after reminders; a manager can close it unverified only after the waiting period; "not fixed" reopens it.

## Implemented

- **Data model:**
  - users with roles, properties, units, residencies, vendors and trades;
  - cases, vendor assignments, spend approvals, appointment slots, append-only case events, notifications;
  - intake conversations, agent runs and agent proposals;
  - partial unique indexes for one live offer per case and one confirmed visit per job.
- **Case engine:** row locks, the shared state machine, an owner and next action for every status, one transaction per action.
- **Auth:** Wasp username and password; self sign-up blocked; object-level checks on every case read and write.
- **Workflow:**
  - report (form, chat, voice), triage, route, review, assign, withdraw;
  - accept or decline, fixed or inspection-first estimates, visit windows, policy or manager approval with a cap;
  - resident visit choice with clash checks, start, progress notes, completion with final cost (over-cap flagged);
  - verification, reopen, cancel, cancel visit, escalate, resume, handled outside, close unverified after the waiting period.
- **Agents (the model reasons, policy decides):** see [docs/architecture.md](docs/architecture.md).
  - intake agent with tools: building notes, recent reports, note facts, submit;
  - event-driven coordinator with tools: case, vendors with real workload and history, building notes, past cases, propose vendor, draft resident update, escalate, record assessment;
  - deterministic policy on every proposal, and every run recorded with each tool call.
- **Durable jobs:** pg-boss coordinator job, and a one-minute deadline sweep (offer expiry, verification reminders, overdue notices, approval nudges, lost-trigger recovery).
- **Interfaces:**
  - **Manager:** command center, case inbox (search, filters, sort, paging), case detail, settings (policy, autopilot, building notes, units, vendors).
  - **Resident (phone first):** requests, report by chat, voice or form, case page.
  - **Contractor (phone first):** job board and job page.
- **Voice:** server-issued ElevenLabs tokens; the agent "Relay voice intake" files through a client tool. Configure it with `node scripts/elevenlabs-setup.mjs`.
- **TraceRoot:** spans for intake, transitions, agent runs, voice sessions and the sweep, verified arriving in the TraceRoot project. Attributes are ids, enums and counts only.
- **Docs:** README, architecture, workflow, this file, screenshots, and the hackathon documents archived in `docs/archive/`.

## Depends on external services

| Feature | Needs | Without it |
| --- | --- | --- |
| Chat intake and coordinator | An OpenAI-compatible model. Default: local Ollama `qwen2.5:3b` (free) | The form and every manual action work; the UI says the assistant is offline; coordinator runs are recorded as skipped |
| Voice intake | `ELEVENLABS_API_KEY`, `EL_AGENT_INTAKE_ID` (configured on this machine) | Voice tab hidden; chat and form work |
| Tracing | `TRACEROOT_API_KEY` (configured on this machine) | Tracing off, no other effect |

## Known limitations and open items

- **Model quality.** On the small local model the coordinator sometimes calls a tool before it has the data, repeats calls, or over-escalates. Tool errors steer it back, an escalation the safety rules don't support becomes a suggestion, and a decided proposal cannot be flipped. A larger model (set `LLM_MODEL`, or a hosted endpoint) gives better judgment.
- **Speed.** On CPU only, an intake turn takes 10–40 s and a coordinator review 30–80 s.
- **Voice** was verified with the real agent in text mode, not with a live microphone in a browser; that needs a person speaking.
- **Notifications** are in-app only (no email or SMS, by scope). There is no account management UI: accounts come from the seed. No password reset, no photo attachments, no property creation from the UI (existing properties are editable and units can be added).
- **CI** (`.github/workflows/ci.yml`) is written but has not been run, because nothing was pushed.
- **Dev server.** It logs a React hydration warning on page load (no visible effect). Saving many files at once can trigger a recompile mid-copy; restart it if the server reports type errors that `npx tsc` does not.
- **Not deployed.** The app needs a Node server, PostgreSQL and a model; this session found no free host for all three, so it is reproducible locally (see README).

## Repository

- Local branch **`relay-v1`**, created from `main` after PR #8 was merged. Not pushed: the instructions were not to modify the team repository and not to create another repository. To publish, push the branch where you choose, for example `git push <remote> relay-v1`.
- Tag `hackathon-final`: the hackathon demo as submitted, with the final UI fixes.
- Contributor history is preserved; `dashboard/` was renamed to `app/` with `git mv`.
