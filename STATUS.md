# Relay V1.1 status

As of 2026-11-23, branch `relay-v1`. Everything marked as passing was run against the running application. The logs
are in [docs/evidence/](docs/evidence/).

## Results

| Suite | Command (from `app/` unless noted) | Result | Log |
| --- | --- | --- | --- |
| Type-check | `npx tsc --noEmit -p tsconfig.json` | **clean** | |
| Unit | `npx tsx --test tests/unit/*.test.ts` | **34 / 34 pass** | [unit-tests-run.txt](docs/evidence/unit-tests-run.txt) |
| API: workflow, reliability, discovery, follow-ups, V1.1 rules, security review | `npx tsx --test --test-concurrency=1 tests/api/{workflow,reliability,discovery,followups,v11,audit}.test.ts` | **85 / 85 pass** | [api-tests-run.txt](docs/evidence/api-tests-run.txt) |
| Browser journeys (Playwright, Chrome) | `cd app/e2e && npx playwright test journey` | **16 / 16 pass** (5.6 min) | [e2e-journey-run.txt](docs/evidence/e2e-journey-run.txt) |
| Agents on the real model | `npx tsx --test --test-concurrency=1 tests/api/agent.test.ts` | pending: runs after the live evaluation (V1: 2 / 2 pass) | [agent-tests-run.txt](docs/evidence/agent-tests-run.txt) |
| AI evaluation, deterministic, with the safety gate | `npx tsx tests/eval/deterministic.ts --gate` | **gate passes** | [eval-deterministic.json](docs/evidence/eval-deterministic.json) |
| AI evaluation, live model | `tests/eval/live.ts`, `tests/eval/live-coordinator.ts` | see [docs/ai-eval.md](docs/ai-eval.md) | [eval-summary.json](docs/evidence/eval-summary.json) |
| GitHub Actions (`.github/workflows/ci.yml`) | type-check, unit, deterministic eval gate, every API suite, browser journeys, on Postgres and Mailpit with no model | **green** ([run 45162425486](https://github.com/elaineh16/yc-hackathon/actions/runs/45162425486)) | |
| Screenshots, desktop, tablet and phone | `SCREENS=1 npx playwright test screens` | 28 | [docs/screenshots/v1.1/](docs/screenshots/v1.1/) |

The API and browser suites need the dev server running with `RELAY_TEST_HOOKS=true` and `FIBER_MODE=fixture`, and
Mailpit on :1025/:8025. They reset all cases.

## Fiber AI (vendor discovery)

- **Live calls: none.** No `FIBER_API_KEY` was available. The project environment and the user and machine
  environment variables were checked by name only; no value was printed.
- **Credits used:** 0. `chargeInfo` and warnings are recorded per search once a key is set; no live `chargeInfo`
  exists yet.
- **What ran instead:**
  - The same SDK code path runs against Fiber-shaped fixture responses of fictional businesses (`FIBER_MODE=fixture`).
  - The fixtures cover a normal result, empty results, provider down, credits exhausted (before and during), rate
    limiting, a server error, an invalid key and a slow response.
  - The fixture calls are counted, and the tests assert the cost controls.
- **To validate live:**
  1. Set `FIBER_API_KEY` in `app/.env.server`.
  2. Run `npx tsx scripts/fiber-live-check.ts --yes` from `app/`.

  It makes one capped search (at most 3 businesses kept), checks the balance first, and refuses if the reserve or the
  daily budget would be crossed. It writes the real `chargeInfo` and warnings to
  `docs/evidence/fiber-live-check.json`.

## Notifications: delivery states as tested

| Channel | State | Meaning | Tested |
| --- | --- | --- | --- |
| In-app | `DELIVERED`, then `ACKNOWLEDGED` when the person acts or presses "Got it" | In the recipient's inbox | API, Browser |
| Email | `CAPTURED` | Accepted by the local Mailpit test server. Not delivered to anyone | API, Browser (the message is read back from Mailpit) |
| Email | `ACCEPTED` | Accepted by a real SMTP server. Delivery to the mailbox is not confirmed | Code path only: no real SMTP server was used |
| Email | `SKIPPED` | Not sent, with the reason: not opted in, no address, email not configured, hourly limit | API |
| Email | `PENDING` (retry), then `FAILED` after 3 attempts | SMTP unreachable; retried after 1 and 5 minutes | API (SMTP pointed at a closed port) |

No email was sent outside this machine.

## Security review

1 high and 8 medium findings, each fixed or documented, with regression tests in `tests/api/audit.test.ts` and
`tests/unit/policy.test.ts`. Details: [docs/security.md](docs/security.md).

## Depends on external services

| Feature | Needs | Without it |
| --- | --- | --- |
| Chat intake and coordinator | An OpenAI-compatible model. Default: local Ollama `qwen2.5:3b` (free) | The form and every manual action work. The resident is told the assistant is offline; managers are told what is next |
| Vendor discovery | `FIBER_API_KEY` (or `FIBER_MODE=fixture` for fictional data) | Cases needing a vendor wait for a manager to add one; the case says so |
| Email | Any SMTP server (`SMTP_HOST`); Mailpit locally | In-app notifications only, and the manager is told |
| Voice intake | `ELEVENLABS_API_KEY`, `EL_AGENT_INTAKE_ID` | Voice tab hidden; chat and form work |
| Tracing | `TRACEROOT_API_KEY` | Tracing off, no other effect |

## Known limitations

- **Fiber:** no live search has been made (no key). The integration is verified against Fiber-shaped fixtures through
  the real SDK path, not against Fiber's servers.
- **Model quality and speed:**
  - The default model is a 3B model on CPU. It sometimes skips a question, picks the wrong tool, or over-escalates.
    Policy contains every one of those (see [docs/ai-eval.md](docs/ai-eval.md)), but the conversation quality is
    that of a small model.
  - An intake turn takes about 10 to 40 s, and a coordinator review 30 to 90 s. A larger model is a configuration
    change (`LLM_BASE_URL`, `LLM_MODEL`).
- **Safety rules out of sample:** held-out v2 is the honest estimate (see [docs/ai-eval.md](docs/ai-eval.md)). The
  rules are one layer: the model's own reading also escalates, and every case a rule cannot place goes to a person.
- **Email:** only Mailpit was used. A real SMTP server reports "accepted", which Relay never shows as delivered.
  Email addresses are not verified.
- **Limits:** rate limits and the sign-in throttle are in memory, per server process.
- **Scale:**
  - The command center runs about 20 queries per refresh, and the sweep re-checks some cases every minute. Fine
    for a few buildings, not yet for hundreds (see [docs/security.md](docs/security.md), M8).
  - Background jobs run as Wasp registers them with pg-boss 8: one job per queue, picked up every 2 seconds. A burst
    of case events queues coordinator reviews one after another.
- **Not built:** password reset, account management, photos, and creating a property from the UI.
- **Voice:** not re-verified with a live microphone in V1.1 (V1 verified it in text mode through the real agent).
- **Not deployed:** it runs locally (see the README); no free host was found for a Node server, PostgreSQL and a
  model together.

## Repository

- **Branch:** `relay-v1` on `elaineh16/yc-hackathon`, with
  [pull request #10](https://github.com/elaineh16/yc-hackathon/pull/10) to `main` (not merged).
- **Tag:** `hackathon-final` marks the hackathon demo as submitted.
- **History:** contributor history is preserved. `dashboard/` was renamed to `app/` with `git mv`.
