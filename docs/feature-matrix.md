# Feature matrix

What Relay V1.1 does, and how each item was verified. "API" means an HTTP test against the running server
(`app/tests/api`). "Browser" means a Playwright journey in real Chrome (`app/e2e/tests`). "Live model" means the
local `qwen2.5:3b` model (`app/tests/eval`). Results and dates are in [STATUS.md](../STATUS.md).

## Cases and workflow

| Feature | Status | Verified by |
| --- | --- | --- |
| Report by form (works with no AI), chat (async agent) or voice (ElevenLabs) | Implemented | API, Browser; voice in text mode (V1 evidence) |
| One state, holder and next action on every case; one transaction per action; row locks | Implemented | Unit, API (concurrent and repeated actions) |
| Categories: plumbing, appliance, heating and cooling, electrical, locks and access, elevator, noise, something else | Implemented | Unit, API, deterministic eval |
| Safety rules: gas, fire and smoke, sparks, alarms, CO, shock, overheating batteries, flooding and spraying pipes, a ceiling bulging with water, sewage backup, water near electrics, elevator entrapment, someone at risk inside, no heat with someone at risk, violence. Negations, hypotheticals and similes are not hazards | Implemented | Unit, eval: 99 cases and two held-out sets of 30 |
| Lockouts to a person (identity check), never codes; noise handled directly by the manager | Implemented | API, Browser (ambiguous journey) |
| Vendor offers with deadlines, estimates, policy approval under a threshold, manager approval with a cap | Implemented | API, Browser |
| A contractor's request for more money: manager approves or declines, never the AI | Implemented | API |
| Visit scheduling with clash checks; cancel and propose again | Implemented | API, Browser |
| Completion is not resolution: "Yes, resolved" / "No, still having problems" reopens | Implemented | API, Browser |
| Durable deadlines and bounded reminders (minute sweep) | Implemented | API (sweep with a moved clock) |

## Vendors and discovery (Fiber AI)

| Feature | Status | Verified by |
| --- | --- | --- |
| Vendor directory per property; per-property approval; isolation between properties | Implemented | API |
| Coverage check, then a discovery task on the case (automatic or approved by a manager) | Implemented | API, Browser |
| Fiber AI search through the official SDK (`googleMapsSearch2`, `getOrgCredits`) | Implemented | Fixture mode only (no key was available for a live call) |
| Balance check, reserve, daily budget, cache, at most 3 kept, `chargeInfo` and warnings recorded | Implemented | API (fixtures) |
| Checks per place: business, trade, distance, contact, duplicate; reasons only from source fields | Implemented | API |
| Manager review: reject, shortlist, verify (with a note), approve for the property; duplicates approve the existing vendor | Implemented | API, Browser |
| Unverified candidates can never be dispatched; waiting cases resume on approval | Implemented | API, Browser |
| Failures (no key, API down, credits exhausted, rate limit, interrupted run) never block the case | Implemented | API, Browser (provider down) |

## Follow-ups and notifications

| Feature | Status | Verified by |
| --- | --- | --- |
| In-app notifications per recipient and event, with deadlines and acknowledgement | Implemented | API |
| Email over SMTP, opt-in, Mailpit locally; honest states (captured is never delivered) | Implemented | API, Browser (Mailpit) |
| Behaviours A–G | Implemented | API |
| Retries with backoff, no duplicates (SKIP LOCKED), per-person hourly limit, missing configuration | Implemented | API |
| AI-drafted resident updates: grounded, approved by a manager, recorded as generated, approved and sent | Implemented | Eval (grounding), code path in API runs |

## AI

| Feature | Status | Verified by |
| --- | --- | --- |
| Intake agent: asks before filing vague reports, multi-issue, reopen instead of a duplicate, observations, assumptions, unknowns | Implemented | Live model eval (subset) |
| Coordinator: discovery tools, grounded notes, escalation only with the rules' agreement, directory-only proposals | Implemented | Live model eval, deterministic eval |
| Prompt-injection hardening: quoted data, no dangerous tools, deterministic gates, reply guard, staff-only notes | Implemented | Eval (injection cases, code disclosure), API |
| Evaluation: 99 + 14 dataset cases, two held-out sets of 30, deterministic and live, before and after | Implemented | [ai-eval.md](ai-eval.md) |

## Security and limits

The findings and fixes are in [security.md](security.md).

| Feature | Status | Verified by |
| --- | --- | --- |
| Shared vendors: details editable only by a manager of every property that uses them; onboarding never merges by name or website | Implemented | API (`audit.test.ts`) |
| Staff-only building notes hidden from resident-facing agents (bullets, bold, blocks, sections); replies guarded against codes however written | Implemented | Unit (`policy.test.ts`), eval |
| Contractors see only their own vendor's activity; entry instructions only after accepting | Implemented | API |
| Per-user limits on reports, chat messages and voice sessions; conversation length cap; sign-in throttle | Implemented | API |
| Failed AI turns retried and always answered; failed coordinator reviews reported to the manager | Implemented | API (injected fault) |
| Test hooks: env flag, never in production, loopback only, optional shared token | Implemented | API suites run through them |

## Interfaces

| Feature | Status | Verified by |
| --- | --- | --- |
| Manager command center (metrics, intervention queue, discovery queue, AI workflows, overdue acknowledgements, activity) | Implemented | Browser, screenshots at 3 sizes |
| Case workspace with provenance (AI proposal, AI action, system, vendor, person, waiting, failed) | Implemented | Browser, screenshots |
| Vendors page (directory, discovery status and budget) and Settings (policy, follow-ups, discovery) | Implemented | Screenshots |
| Resident and contractor portals, phone first | Implemented | Browser at phone sizes, screenshots |

## Not done

- **Fiber:** no live call; it needs a key ([STATUS.md](../STATUS.md)).
- **Accounts:** no hosted deployment, no account management UI, no password reset, no photos.
- **Voice:** not re-verified with a live microphone.
