# Relay V1.1 status

As of 2026-11-23, branch `relay-v1`. Everything marked as passing was run against the running application. The logs
are in [docs/evidence/](docs/evidence/).

## Results

| Suite | Command (from `app/` unless noted) | Result | Log |
| --- | --- | --- | --- |
| Type-check | `npx tsc --noEmit -p tsconfig.json` | **clean** | |
| Unit | `npx tsx --test tests/unit/*.test.ts` | **35 / 35 pass** | [unit-tests-run.txt](docs/evidence/unit-tests-run.txt) |
| API: workflow, reliability, discovery, follow-ups, V1.1 rules, security review | `npx tsx --test --test-concurrency=1 tests/api/{workflow,reliability,discovery,followups,v11,audit}.test.ts` | **86 / 86 pass** | [api-tests-run.txt](docs/evidence/api-tests-run.txt) |
| Browser journeys (Playwright, Chrome) | `cd app/e2e && npx playwright test journey --retries=1` | **16 / 16 pass** (2.6 min; none needed the retry) | [e2e-journey-run.txt](docs/evidence/e2e-journey-run.txt) |
| Agents on the real model | `npx tsx --test --test-concurrency=1 tests/api/agent.test.ts` | **2 / 2 pass** on `qwen2.5:3b` (CPU): the intake agent converses and files through the server (159 s); the coordinator wakes on the case, uses its tools, and every proposal passes policy (56 s) | [agent-tests-run.txt](docs/evidence/agent-tests-run.txt) |
| Demo videos | `app/e2e/demo` (see [docs/demo/DEMO_RUNBOOK.md](docs/demo/DEMO_RUNBOOK.md)) | **Product demo** "Relay: from request to resolution": 5:26, 98% real app footage, live Fiber search, reviewed frame by frame while playing; narration onsets within 0.04 s of the timeline. **Technical walkthrough**: 4:49, audio and captions within 0.1 s | [docs/demo/](docs/demo/) |
| AI evaluation, deterministic, with the safety gate | `npx tsx tests/eval/deterministic.ts --gate` | **gate passes** | [eval-deterministic.json](docs/evidence/eval-deterministic.json) |
| AI evaluation, live model | `tests/eval/live.ts`, `tests/eval/live-coordinator.ts` | see [docs/ai-eval.md](docs/ai-eval.md) | [eval-summary.json](docs/evidence/eval-summary.json) |
| GitHub Actions (`.github/workflows/ci.yml`) | type-check, unit, deterministic eval gate, every API suite, browser journeys, on Postgres and Mailpit with no model | **green** ([run 45162425486](https://github.com/elaineh16/yc-hackathon/actions/runs/45162425486)) | |
| Screenshots, desktop, tablet and phone | `SCREENS=1 npx playwright test screens` | 28 | [docs/screenshots/v1.1/](docs/screenshots/v1.1/) |

The API and browser suites need the dev server running with `RELAY_TEST_HOOKS=true` and `FIBER_MODE=fixture`, and
Mailpit on :1025/:8025. They reset all cases, and they refuse to start against a server whose Fiber mode could spend
credits. Like CI, they ran with no model (`LLM_DISABLED=true`): several discovery tests expect the agents' documented
"AI unavailable" path.

## Fiber AI (vendor discovery)

Verified live on 2026-11-23 with the key in `app/.env.server` (never printed, logged or committed). Details:
[docs/fiber.md](docs/fiber.md#live-verification).

| Check | How | Result |
| --- | --- | --- |
| Key loads, fixture mode off | `scripts/fiber-live-check.ts` in the WSL dev environment (it loads `.env.server` itself) | Key set, `FIBER_MODE` unset, mode `live` |
| Authentication and balance | The same script, without `--yes`: `GET /v1/get-org-credits` (free) | Authenticated: 2,500 of 2,500 credits |
| One live search **through the manager interface** | The manager approved the search on an AC case at Maple Court (no approved HVAC contractor); recorded by `app/e2e/demo/capture-fiber.mjs` | 20 places, 3 kept, 17 filtered; `chargeInfo` `{"method":"charged-now","creditsCharged":2}`; no warnings |
| Credits charged | Balance again (free) | 2,498: exactly 2 credits used |
| Persistence, deduplication, manager view, no resident data sent | The discovery row, the candidates (`fiber:google-maps`, keyed by place id) and the case page | As expected ([evidence](docs/evidence/fiber-live-ui-search.json), [screenshot](docs/screenshots/v1.1/fiber-live-discovery-panel.png)) |
| A test reset keeps the real search; reuse is free | `app/e2e/demo/check-fiber-retention.mjs` | Kept; a new case reused it with 0 credits |

- **Script check versus interface check:** the script made only the free balance calls. The single paid search was
  made through the manager interface, so it also exercised the job, the checks, the database and the page. The
  script's `--yes` search was not run, because it would have repeated the same query for 2 more credits.
- **Safeguards added for the live key:**
  - the API and browser suites refuse to run unless the server's Fiber mode is `fixture` or `off`;
  - the dev helper starts test servers with `FIBER_MODE=fixture`;
  - fixture data and real data are never shown together;
  - a test reset keeps real searches (the record of credits spent and the cache);
  - the balance in Settings is re-read after a paid search.
- **Total spent:** 2 credits. Nothing was verified, contacted, approved or offered work.

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

- **Fiber:** one live search (2 credits) is the whole of the live verification. Error responses (402, 429, 5xx) are
  tested against fixtures only.
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
- **Voice:** not re-verified with a live microphone in V1.1 (V1 verified it in text mode through the real agent). The
  ElevenLabs key now in `app/.env.server` is rejected by ElevenLabs (`401 invalid_api_key`, checked with a read-only
  call on 2026-11-23), so voice intake cannot start until it is replaced.
- **Not deployed:** it runs locally (see the README); no free host was found for a Node server, PostgreSQL and a
  model together.

## Repository

- **Branch:** `relay-v1` on `elaineh16/yc-hackathon`, with
  [pull request #10](https://github.com/elaineh16/yc-hackathon/pull/10) to `main` (not merged).
- **Tag:** `hackathon-final` marks the hackathon demo as submitted.
- **History:** contributor history is preserved. `dashboard/` was renamed to `app/` with `git mv`.
