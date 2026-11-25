# Relay V1.2 baseline

An audit of Relay at the start of V1.2: what the evidence shows, what it does not, where the system fails, and what to
fix first. Written so that someone who did not build Relay can check every claim.

- **Audited code:** branch `relay-v1` at `59a52bd` (CI green: [push run 45281715019](https://github.com/elaineh16/yc-hackathon/actions/runs/45281715019),
  [PR run 45281727732](https://github.com/elaineh16/yc-hackathon/actions/runs/45281727732)). Line references are to
  that commit.
- **Date:** 2026-11-25.
- **First improvement:** the chat safety net, in [01-intake-safety-net.md](01-intake-safety-net.md). Numbers marked
  "after" come from it; everything else describes `59a52bd`.

## Method

1. **Two separate audits.** One read-only audit covered the AI evaluation evidence and one covered backend
   reliability. Each was given the areas to cover and the files to read. The backend brief also carried one
   unrecorded figure, the 160–254 s job delays (§2).
2. **Spot checks against the code.** I checked their findings against the code. Every line reference below was read
   at `59a52bd`.
3. **Independent recount.** A separate script recounted the headline live numbers from the committed evidence
   files: escalation, route, category, tool calls, the turn each case was filed on, and latency.
   - Those counts match the audit's.
   - Percentiles here use linear interpolation, so two p90 latencies differ slightly from the audit's.
   - Two counts are the audit's alone: the refused tool calls, and the held-out cases that waited for "Please file it
     now."
4. **No re-scoring.** Nothing in `docs/evidence/` from before this work was re-scored or edited. One measurement
   written during this work, the safety screen, was wrong and was corrected before publication
   ([01-intake-safety-net.md](01-intake-safety-net.md#problems-found-while-doing-this), item 6).
5. **Statistics.**
   - Rates carry 95% Wilson score intervals.
   - Version-to-version comparisons use a two-sided Fisher exact test.
   - With 10 to 34 cases per metric, most intervals are wide. Read them before the point estimates.

## 1. What is verified

| Claim | Evidence |
| --- | --- |
| Type-check clean; unit tests 35/35; API tests 86/86 (six suites); browser journeys 16/16 | [STATUS.md](../../STATUS.md), logs in `docs/evidence/` (2026-11-23); CI green on `59a52bd` |
| The deterministic safety gate passes. It requires that the rules miss no expected emergency on the 99 tuned cases or held-out v1, and raise at most 2 false alarms there; there are currently 0 (0/76 and 0/17) | `tests/eval/deterministic.ts --gate`, in CI; [ai-eval.md](../ai-eval.md) |
| Policy guarantees, given synthetic model outputs: the rules overrule a model that calls a hazard routine (23/23); no coordinator escalation on a trap executes (0/13); no ungrounded resident draft is accepted (56/56 rejected); codes in replies are redacted (3/3); no agent tool can approve spending | [ai-eval.md](../ai-eval.md), `eval-deterministic.json` |
| Concurrency already serialized: every action locks the case row; `confirmSlot` locks the vendor row; a partial unique index allows one confirmed slot per assignment; offer responses are idempotent | `cases/engine.ts:35,160`, `cases/flow.ts:539-543`, migration `20261123021800_one_live_offer_guard`; `reliability.test.ts` |
| Fiber AI: one live search through the manager interface charged exactly 2 credits (2,500 → 2,498); a run interrupted after the paid call resumes without paying again | [fiber.md](../fiber.md), `fiber-live-ui-search.json`; `discovery.test.ts` |
| Email: captured by Mailpit; concurrent delivery passes send each email once; an SMTP outage retries, then fails clearly | `followups.test.ts` |
| Agents on the real model (V1.1, 2026-11-23): the intake agent converses and files through the server; the coordinator reviews and every proposal passes policy | `agent-tests-run.txt` (`qwen2.5:3b`, 2/2); not re-verified since (§2) |
| After the first improvement: unit 40/40, API 97/97 (seven suites), browser journeys 18/18 | [01-intake-safety-net.md](01-intake-safety-net.md#tests) |

## 2. What is unverified, or too weakly measured to rely on

**External services and deployment**

- **Voice.** ElevenLabs rejects the configured key (`401 invalid_api_key`). The microphone path has not been tested
  end to end since V1. *Blocker: a valid key from the workspace that owns the agent, and a person at the microphone.*
- **Deployment.** None. It runs locally only.
- **Real email delivery.** Never tested; only Mailpit was used.
- **Fiber errors.** The 402, 429 and 5xx responses are tested against fixtures only. Whether Fiber charges for a 5xx
  is unknown.

**The live AI evaluation**

- **Sample size.** One model (`qwen2.5:3b` on a laptop CPU), one run per version at temperature 0.2. It covers 34
  intake cases and 14 coordinator cases, with no run-to-run variance and no second model.
- **No live difference between V1 and V1.1 is statistically distinguishable:**

  | Metric | V1 → V1.1 | p |
  | --- | --- | --- |
  | False escalation | 1/24 → 5/24 | 0.19 |
  | Missed escalation | 3/10 → 1/10 | 0.58 |
  | Route | 24/34 → 22/34 | 0.80 |
  | Category | 21/34 → 26/34 | 0.29 |
  | Invented facts | 5/34 → 1/34 | 0.20 |

  [ai-eval.md](../ai-eval.md) describes these as better or worse; the data cannot tell.
- **The live harness is not the production path.**
  - The tools and database are mocks (`tests/eval/live.ts:3-5`).
  - The resident is a four-turn script that ignores what it is asked (`live.ts:145-146`).
  - The production turn deadline is not applied (`live.ts:154`; production `agent/intake.ts:320`). Two V1.1 turns
    ran past 180 s (both spanned a laptop sleep), and nine timed-out cases were replaced by reruns.
  - Tool arguments and tool errors are not stored (`live.ts:156`).
  - It calls the agent directly, so it cannot see anything `sendIntakeMessage` does, including the new safety net.
- **The coordinator harness is not production either.**
  - Its tools and case view are shortened (`live-coordinator.ts:50-96`; production `coordinator.ts:220-384`).
  - Its vendor rule skips the declined, review and noise checks (`:69`).
  - Its vendor directory ignores case history (`:26-31`), so electrical cases are offered a plumber.
- **Grading.**
  - All grading is programmatic, with no human or model judge.
  - The coordinator's drafts are graded by the policy's own checker (`live-coordinator.ts:156-157`), which is circular.
  - Held-out v2's `prohibited` lists are never read. So V017 ("Great, you can safely turn off the light switch") and
    V009 ("They will be there soon") scored no violations.
- **Held-out v2 is half run.** Only its 13 emergencies were run live; its 17 non-emergencies never were. It uses
  Relay's own labels, and `report.ts` does not score it (`report.ts:14`).

**Not re-verified after the first improvement**

- **The agents on the real model.** The re-run on 2026-11-25 is not valid: the host was starved for memory, the
  model evaluated prompts at 4.1 tokens/s, and every intake turn hit the 180 s deadline
  (`docs/evidence/agent-tests-run-2026-11-25-starved-host.txt`). The V1.1 run passed 2/2.

**Never measured**

- Cost.
- Queue wait.
- Command-center query plans (no `EXPLAIN`).
- Any behaviour with more than one server process.
- The 160–254 s job delays seen during earlier test runs are recorded nowhere. Treat them as an anecdote until
  measured.

## 3. AI failure classes

Each cause is tagged with its kind, because most of these are not prompt problems:

- **[safeguard]:** missing deterministic safeguard;
- **[routing]:** routing policy;
- **[retrieval]:** missing context;
- **[schema]:** tool schema or affordance;
- **[model]:** model capability;
- **[harness]:** evaluation artifact;
- **[infra]:** infrastructure.

Live numbers are V1 → V1.1 on the 34-case subset unless noted; "ho2" is the 13 held-out v2 emergencies run live on
V1.1.

| Class | Evidence | Cause | Status |
| --- | --- | --- | --- |
| **Unfinished emergency intake** | When the assistant failed, no chat report reached a person: 0 of 8 scenarios, including a gas smell and water through a sparking light (`intake-failures-before.json`). Live: I001 ("rotten eggs") and V013 ("please don't") were never filed | The rules ran only at filing (`cases/classify.ts:53`; `agent/intake.ts` did not import them) **[safeguard]**. Conversations were visible only to their resident (`ops.ts:83`) **[safeguard]** | **Fixed** in 01: 8 of 8 reach a person |
| **Missed escalation** | 3/10 → 1/10 (I001); ho2 2/13 (V001, V013) | I001: as above. V001 ("a smell like egg when it is gone bad") is read as gas by neither the rules (`shared/triage.ts:47`) nor the model **[model]** | I001 is now filed by the server at its second message. V001 open |
| **False escalation** | 1/24 → 5/24 (95% CI 9–40%; I018, I033, I047, I069, I091) | A model-only EMERGENCY escalates without any check against the resident's words (`classify.ts:54`) **[routing]**. In I069 and I091 (and V1's I065), the scripted reply "Yes, that's right." confirmed the hazard questions on the prompt's checklist (`intakePolicy.ts:10-13,21-22`) **[harness]** | Open. Measure with a context-aware resident before changing policy: the model also catches emergencies the rules miss (4 of 13 in ho2) |
| **Routing** | 24/34 → 22/34 (95% CI 48–79%) | Composite: the false escalations, 4 never filed (I001, I053, I096, I098), and vendor routes from the category below | Follows the rows above and below |
| **Category** | 21/34 → 26/34 (95% CI 60–88%) | The model's category is kept (`classify.ts:49`). The rules' category is only a hint, and their disagreement is dropped (`triage.ts:272-278`, `classify.ts:62,68`). On their own the rules were right on all four filed misses **[routing]** | Open |
| **Tool calls: history and reopening** | `find_my_recent_reports`: 0 calls in 81 live conversations. `reopen_my_report`: 0 in 47 (V1 had no reopen tool). Expected tools 0/6 → 1/6 | History is pull-only and not in the prompt (`intake.ts:199-221`, `intakePolicy.ts:36`). Nothing on the server checks for a reopen (`cases/intake.ts:85-86`) **[retrieval] [schema]** | Open |
| **Duplicates instead of reopening** | Prohibited behaviour 2/34 → 3/34, all `new_case_instead_of_reopen` (I059–I061) | Same as the row above | Open |
| **Multi-issue reports** | 0/2 → 0/2; ho2 0/1. I066 filed three issues as one case | `additional_issues` is an optional nested field (`intakePolicy.ts:58`), and nothing splits a report deterministically **[schema] [model]** | Open |
| **Invented facts** | 5/34 → 1/34 (I001 `smell_intensity=strong`) | Intake facts have no grounding check (`classify.ts:73-75`), unlike the coordinator's drafts **[safeguard]** | Open |
| **Unnecessary clarification of emergencies** | Emergencies filed on the first turn: 1/10 → 3/10; ho2 0/13. In ho2, 10 of 13 waited for the scripted "Please file it now." Refused tool calls: 5 in 2 cases (V1), 16 in 13 cases (V1.1). I083 (flames) was told "It seems I need to provide more specific facts" | The model reads back before filing, and tool errors go back to the model (`loop.ts:63,73-74`) **[model] [schema]**. Not the submit gate: `validateSubmit` already exempts anything marked EMERGENCY or with a safety concern (`intakePolicy.ts:90`) | Partly: emergencies the rules recognise no longer wait for the model (01) |
| **Safety advice** | Reached the resident: 5/10 → 8/10. From the model's own replies: 0/10, 0/10, ho2 0/13 | All of it comes from the server's confirmation text. The advice is the rules' text for the category, so water through a sparking ceiling light gets "Do not use the appliance or the outlet" **[safeguard]** | Open (wording) |
| **Latency** | Turn median / p90: 15.5 s / 28.4 s (121 turns) → 31.2 s / 117.0 s (113 turns); ho2 25.2 s / 52.6 s. Two V1.1 turns span a laptop sleep (I070 5,867 s, I091 6,755 s) | A 3B model on CPU, up to 6 model calls per turn (`intake.ts:319`). The explanation in ai-eval.md ("its prompt and tool schemas are longer") is untested and confounded with CPU contention **[infra]** | Open |

**The coordinator** (14 cases, same model):

- **Forbidden attempts:** the model attempts a forbidden action in 8 of 14 cases in both versions, and policy blocks
  all of them.
  - Example: C011 offered the job twice to a vendor that had declined.
  - One caveat: the harness blocked them with its own copy of the policy.
- **False escalations:** on trap cases, 2 attempted in each version, with free-text reasons such as "No danger"
  (`coordinator.ts:369`). V1.1 executes none.
- **Missed hazard:** C013 (a sparking outlet) went to a plumber in both versions. The prompt steers toward a vendor
  (`coordinatorPolicy.ts:16`), and the vendor path does not re-check for a hazard (`coordinator.ts:392-399`)
  **[safeguard]**.
- **Grounding:** the check does not look for "approved". So C014's note "This candidate is pre-approved…" was saved
  as grounded (`grounding.ts:15`) **[safeguard]**.

## 4. Backend failure classes

| Area | Failure | Where | Severity | Tested now |
| --- | --- | --- | --- | --- |
| **Unfinished chat intake** | A chat reached no manager when the model was down, every attempt failed, or the resident left. A takeover after a crash ignored the attempt limit, so a turn that crashes the server was retried forever | `agent/intake.ts:101-174,348-352`, `cases/read.ts:399` | High | **Fixed and tested** in 01 |
| **Reminders across reopen cycles** | Three notification keys are per case, not per round. After "not fixed" and a second completion, the verification reminders and the manager's overdue notice are silently skipped. So are approval reminders on a second approval. The history still says "Reminder n of m sent". `notify` returns recipients, not rows written. `docs/notifications.md:52-53` claims every key carries the state's timestamp | `cases/sweep.ts:95-111,182-185`, `notify/notify.ts:115` | Medium | One round only (`followups.test.ts` F) |
| **Fiber daily budget** | Spend is summed by the discovery's `createdAt`, so a search created yesterday and approved today counts toward no day: 8 credits can be spent against a budget of 6 (the 10-credit floor still holds). Charges from failed attempts are not recorded. Serialized only within one process | `vendors/discovery.ts:390-395,449-453,471` | Medium | Untestable as written: fixture mode estimates 0 |
| **Visit confirmation** | Approving spending confirms the resident's earlier pick without the start-time check, so the case is scheduled for a past visit and "Visit confirmed" goes out. A clash result is ignored and the resident's pick silently becomes unavailable. Two vendors can confirm overlapping visits in one unit (no unit lock). `proposeSlots` is not idempotent | `cases/flow.ts:197-198` (versus `:577`), `:550`, `:383,386`; `docs/security.md:80` | Medium (first two); low | No |
| **Job queue** | One job in flight per queue per process, polled every 2 s. No per-case job key, so duplicates pile up: every action, the end of each coordinator run and the sweep all submit. The de-bounce is in memory and lost on restart. One 180-second intake turn delays every other resident's reply | `ops.ts:27`, `agent/coordinator.ts:36,92`, `cases/sweep.ts:218,241` | Medium | Not measured |
| **Worker crashes** | The coordinator loop has no deadline (up to 9 × 180 s). A run past the 900-second job expiry is retried and reported as abandoned while it keeps acting. A Fiber timeout or 5xx is retried, which can mean up to 3 paid searches. Email is at least once (a crash after SMTP accepts resends it in about 3 minutes). The hourly email cap drops emails permanently, emergencies included | `coordinator.ts:74-79,386`, `main.wasp:130`, `vendors/fiber.ts:84-95`, `discovery.ts:499-502`, `notify/email.ts:105-121` | Low to medium | Partly (`discovery.test.ts`, `followups.test.ts`) |
| **Rate limits and sign-in throttle** | In memory, per process. Behind a reverse proxy the per-address throttle sees only the proxy. 50 bad sign-ins from anyone lock everyone out for 15 minutes, renewable because 429s are not counted | `limits.ts:7,38,56,62` | Medium once deployed | Single process only |
| **Command-center cost and correctness** | 23 Prisma calls, about 55 SQL statements, every 5 s per open manager tab. Several counts have no usable index. Some counts are the length of a capped list, so they stop at 12 (overdue acknowledgements), 10 (suggestions) or 40 (coordinator runs) | `cases/read.ts:374-438`, `client/pages/manager/CommandCenterPage.tsx:37` | Low to medium | No |
| **Observability and redaction** | No correlation id links a request, its jobs and model calls; model calls have no span. Transition marks fire inside the transaction, so rolled-back transitions appear in traces. Sweep counters count recipients, not rows. Possible personal data in logs: Prisma validation errors embed arguments (unverified); SMTP error text is stored and shown to managers; the model server's URL is logged | `llm.ts:48,55-83`, `cases/engine.ts:136`, `notify/email.ts:134`, `cases/read.ts:229` | Low to medium | Health check only |

## 5. Performance bottlenecks

| Where | Measured | Why |
| --- | --- | --- |
| Intake turn | V1.1 median 31.2 s, p90 117.0 s; ho2 25.2 s / 52.6 s | `qwen2.5:3b` on a laptop CPU, up to 6 model calls per turn |
| Time for an emergency to be filed through the model | For the 9 V1.1 subset emergencies the model filed: 13–296 s of model time (median 66 s), plus the resident's own replies. I001: never | The model asks before filing (§3) |
| Same, after the safety net, for emergencies the rules recognise | Within the resident's request: 14–17 ms in the failure benchmark | No model in the path |
| Coordinator run | V1.1 median 45 s, p90 85 s (14 cases) | Same model; up to 9 steps |
| Queue throughput | At most about 30 fast jobs a minute per queue. At 10–40 s a turn, 1.5–6 intake replies a minute, shared by every resident | One job at a time per queue (pg-boss 8 as Wasp registers it), polled every 2 s |
| Command center | About 55 statements per refresh, every 5 s per tab; not measured | §4 |

## 6. Improvements, ranked

The ranking weighs the harm when it fails (safety, then money, then attention), how often it happens, and whether it
can be verified now.

| # | Improvement | Why here | Measured by |
| --- | --- | --- | --- |
| 1 | **Chat safety net** (done, [01](01-intake-safety-net.md)) | The only class where a possible emergency reached no one. Deterministic, with no model in the path | Failure benchmark: 0/8 → 8/8 |
| 2 | **A production-path intake benchmark and a new blind held-out set** | Every open AI class depends on it. The current harness cannot see the server path, and its scripted resident manufactures some false escalations. No live V1 → V1.1 difference is significant. It is also the prerequisite for comparing models | Multi-turn runs through `sendIntakeMessage` and the real tools. A context-aware resident. Tool trajectories with arguments, the database state after each case, latency and cost; per-category rates with intervals; repeated runs |
| 3 | **Reopen instead of duplicating, by retrieval** | 0 of 47 expected reopen calls; duplicates split a case's history and re-dispatch vendors | Benchmark #2's "repair didn't hold" cases, and the database state (reopened, not new) |
| 4 | **Per-round reminder keys; `notify` returns rows written** | Reminders silently skipped in a second round, and a history that claims they were sent | An API test over two rounds: round-2 reminders 0 → 2 |
| 5 | **Fiber budget by charge time, with a reservation lock** | The daily cap can be exceeded. Money, though bounded by the floor | An API test with fixture charges: four of yesterday's searches approved under a budget of 6, three run |
| 6 | **Model-only emergencies and category disagreements** | The attention cost of 5/24, and the dropped rule category. Only after #2, because part of the false escalation is a harness artifact and the model catches emergencies the rules miss | Benchmark #2, both directions |
| 7 | **Job de-duplication and a coordinator deadline** | Bursts and restarts; false "interrupted" notices | Queue wait (start minus creation), p95 target under 10 s |
| 8 | **Visit confirmation in the past; unit lock** | A confirmed visit in the past, double booking, a lost pick | Two API tests (late approval; 20 concurrent same-unit picks) |
| 9 | **Command-center counts and indexes** | Wrong counts above the caps; cost as data grows | `EXPLAIN`, statement count per refresh |
| 10 | **Correlation ids, marks after commit, redacted job errors** | Diagnosing everything above | A trace from request to job to model call |

## 7. Reproduction

From `app/`. The API, browser and failure-benchmark commands need the dev server running with
`RELAY_TEST_HOOKS=true FIBER_MODE=fixture LLM_DISABLED=true` and Mailpit on :1025 (see the [README](../../README.md)).
They reset all cases and refuse to run against a server whose Fiber mode could spend credits.

```sh
npx tsc --noEmit -p tsconfig.json
npx tsx --test tests/unit/*.test.ts
npx tsx --test --test-concurrency=1 tests/api/workflow.test.ts tests/api/reliability.test.ts tests/api/discovery.test.ts \
  tests/api/followups.test.ts tests/api/v11.test.ts tests/api/audit.test.ts tests/api/intake-safety.test.ts
(cd e2e && npx playwright test journey --retries=1)

# AI evaluation, no model (the second writes docs/evidence/safety-screen.json)
npx tsx tests/eval/deterministic.ts --gate
npx tsx tests/eval/safety-screen.ts

# Does a chat report reach a person when the assistant fails? (no model; writes docs/evidence/intake-failures-<label>.json)
npx tsx tests/eval/intake-failures.ts <label>

# Live model: Ollama qwen2.5:3b, or set LLM_BASE_URL / LLM_MODEL. Results vary from run to run.
npx tsx tests/eval/live.ts --variant v1.1 --out ../docs/evidence/eval-live-v1.1.json
npx tsx tests/eval/live.ts --variant v1.1 --dataset heldout.v2.json \
  --only V001,V003,V005,V007,V009,V011,V013,V015,V017,V019,V021,V023,V025 \
  --out ../docs/evidence/eval-live-heldout-v2-emergencies-v1.1.json
npx tsx tests/eval/live-coordinator.ts --variant v1.1 --out ../docs/evidence/eval-live-coordinator-v1.1.json
npx tsx tests/eval/report.ts   # rewrites eval-summary.json from the evidence files
```

- **Where these come from:** the live-evaluation flags are from each script's header. The repository does not record
  the exact rerun and held-out invocations used for the committed V1.1 files; these lines rebuild them from the
  documented flags.
- **What cannot be reproduced:** held-out v1's first scoring, because the rules it scored have since changed.
