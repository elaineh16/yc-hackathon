# 01. The chat safety net: an unfinished chat report always reaches a person

The first V1.2 improvement, ranked first in [V12_BASELINE.md](V12_BASELINE.md#6-improvements-ranked).

## The failure

- **Every chat report depended on the model.** A resident's chat message was saved and then waited for it. If the
  model was offline, timed out, failed on every attempt, or the server died mid-turn, the resident read "Your
  message is saved" and nothing reached anyone.
- **Abandoned chats were invisible.** A chat the resident stopped answering stayed open forever, visible only to
  them.
- **Even "I smell gas" reached no one.** The safety rules ran only when a report was filed, and filing needed the
  model.

**Measured before the change** (`docs/evidence/intake-failures-before.json`): in 8 scenarios where the assistant
failed, **0 reached a person** within 60 seconds. That includes a strong gas smell and water pouring through a
sparking ceiling light.

## Root causes

None of these are prompt problems, and no prompt text was changed.

| Cause | Kind | Where (at `59a52bd`) |
| --- | --- | --- |
| The safety rules ran only inside the filing path; the chat never consulted them | Missing deterministic safeguard | `cases/classify.ts:53`; `agent/intake.ts` did not import them |
| Conversations were visible only to their resident, and the command center had no view of them | Missing human fallback | `ops.ts:83`, `cases/read.ts:399` |
| A takeover after a crash ignored the attempt limit, so a turn that crashes the server was retried forever | Reliability | `agent/intake.ts:169-174` |

## What changed

1. **The safety screen** (`agent/intakeSafety.ts`).
   - **When:** after each resident message is saved, the server runs the same rules that classify every report on
     everything the resident has written so far.
   - **If they see a possible emergency:**
     - the server files it at once, from the resident's words verbatim, and escalates it;
     - it tells the resident, with the rules' safety advice, in the same request and without the model;
     - the case history says the safety rules filed it.
   - **Only the resident's own lines are screened.** Relay's questions about gas or smoke never trigger it.
2. **A review queue for unfinished chats.**
   - **When a chat goes to the property's managers:**
     - the assistant cannot reply (model offline, or every attempt failed);
     - the server died in the turn on every attempt;
     - the resident stopped for 30 minutes (`INTAKE_IDLE_MINUTES`, at least 5) with something written and nothing
       filed.
   - **What the managers get:** a notification with the resident's words. It is needs-review if the rules rate the
     words above routine, otherwise action.
   - **Where they act:** an "Unfinished chat reports" panel in the command center. They either file it as a case
     (idempotent) or close it with a reason.
   - **Who can act:** only managers of that property. Other managers get 404, residents 403.
   - **After a close:** a new resident message starts a new review.
3. **The resident is told the truth.**
   - Once the chat is in front of a person, the reply says: "Your message is saved, and I've passed it to your
     property manager so a person reads it". If flagging failed, the old text is kept.
   - When a manager files the chat, the resident gets an in-app notification and an email, since they have usually
     left the chat by then.
4. **A cap on takeovers.** A turn interrupted on every attempt is marked failed and goes to a person instead of
   being retried forever.
5. **Filing with the form closes the chat.** "Use the form with my words" passes the chat along, so the manager does
   not see both a review item and a case for the same problem. Only the resident's own unfiled chat on the same unit
   can be closed this way.
6. **Empty chats are abandoned.** A chat with nothing the resident said, idle for 30 minutes, is closed as abandoned
   and sent to no one.

**Schema:** six nullable columns on `IntakeConversation` (`reviewSince`, `reviewReason`, `reviewedAt`,
`reviewedById`, `reviewOutcome`, `reviewNote`) and one index (migration `20261125183646_intake_review`).

## Results

### Does a chat report reach a person when the assistant fails?

`tests/eval/intake-failures.ts`, against a dev server with no model.

- **Scenarios:** four messages, each with the assistant broken in two ways:
  - **offline:** the model is unreachable;
  - **error:** a failure that is not the model's, injected on every attempt.
- **"Reached a person":** a case for that resident, or a manager notification, within 60 s.

| Message | Mode | Before | After |
| --- | --- | --- | --- |
| H1 "There's a strong smell of gas in my kitchen." | offline / error | no / no | case in 17 ms / 17 ms |
| H2 "Water is pouring through the ceiling light in my bathroom and it's sparking." | offline / error | no / no | case in 17 ms / 14 ms |
| N1 "My dishwasher won't drain after the cycle finishes." | offline / error | no / no | manager notification in 1.1 s / 14.0 s |
| N2 "The bathroom fan has become very loud." | offline / error | no / no | manager notification in 1.9 s / 13.7 s |
| **All** | | **0 / 8** | **8 / 8** |

- **The error mode's 14 s** is the job's own retry before giving up.
- **What the resident was told:**
  - before, in every case: "Your message is saved";
  - after, for H1: "This could be dangerous, so I've passed it to your property manager straight away instead of
    asking more questions. Your report is saved as RLY-…. Leave the unit now. Do not use switches or flames. Call
    your gas utility's emergency line or 911 from outside. The property manager has been alerted in Relay. It is
    being handled as an emergency, not as a routine repair."
- **Evidence:** `docs/evidence/intake-failures-before.json`, `docs/evidence/intake-failures-after.json`.

### How much of it is deterministic?

The screen is the existing rules, unchanged, run on chat words after each message. `tests/eval/safety-screen.ts`
replays every dataset conversation message by message, as production does (`docs/evidence/safety-screen.json`).
Intervals are 95% Wilson.

| Dataset | Emergencies filed at the first message | Filed by the end of the conversation | Non-emergencies wrongly filed as emergencies |
| --- | --- | --- | --- |
| 99 tuned cases (in-sample) | 22/23 | 23/23 (86–100%) | 0/76 (0–5%) |
| Held-out v1 (in-sample since its first scoring) | 8/13 | 13/13 (77–100%) | 1/17 (1–27%): H003 |
| **Held-out v2 (out of sample)** | **3/13** | **7/13 (29–77%)** | **1/17 (1–27%): V026** |

- **What the screen adds:** timing and independence from the model, not detection.
  - It catches exactly what the rules already caught at filing.
  - It catches it in milliseconds, whether or not the model answers.
- **The six held-out v2 emergencies the rules miss still depend on the model:** V001, V011, V013, V015, V019 and
  V021. If the model fails on one of them, it reaches a manager through the review queue, as a review item rather
  than an emergency alert.
- **The cost is two false filings out of sample.**
  - H003 is a heater's first-use burning smell, filed on "BURNING smell!!" before the resident's second message says
    it is burnt dust.
  - V026 is a resident asking what to do *if* a storm floods the patio door.
  - Each becomes an emergency alert for the manager: an attention cost, in the conservative direction.

### Time to reach a person, on recorded live conversations

The recorded V1.1 live conversations, replayed through the screen. This is the deterministic part only; the live
harness itself does not call `sendIntakeMessage`.

| | Before: through the model | After: the screen |
| --- | --- | --- |
| The 10 emergencies in the live subset | 9 filed, after 13–296 s of model time (median 66 s) plus the resident's replies; **I001 never filed** | 9 filed at the first message, 10 by the second, within the request |
| The 13 held-out v2 emergencies | 12 filed, after 58–142 s of model time; V013 never filed | 7 filed (3 at the first message, 4 at the second). The other 6 as before, plus the review queue if the model fails |

<a id="tests"></a>

### Tests

| Suite | Before | After | New |
| --- | --- | --- | --- |
| Unit | 35/35 | **40/40** | `tests/unit/safety-net.test.ts`: the screen catches gas, sparking water and outlet smoke; it ignores ordinary problems and hazards the resident rules out; only the resident's lines count; the idle rule |
| API (seven suites, no model, as in CI) | 86/86 | **97/97** | `tests/api/intake-safety.test.ts`, 11 tests, listed below |
| Agents on the real model (`agent.test.ts`) | 2/2 (V1.1) | **not valid; re-run pending** | Every intake turn hit the 180 s deadline because the host was starved for memory: prompts were evaluated at 4.1 tokens/s. Each timeout took the new failure path (the resident was told the chat was passed on). [Log and diagnosis](../evidence/agent-tests-run-2026-11-25-starved-host.txt) |
| Browser journeys (Chrome) | 16/16 | **18/18** | Journey 6: a gas smell typed into the chat is filed at once; with the assistant offline, the manager files the chat from the command center, and the resident is told |

**The 11 API tests:**

1. An emergency is filed within the request, escalated, verbatim, and attributed to the rules.
2. An offline chat goes to the managers with a notification.
3. Only that property's managers can act on it.
4. Filing it is idempotent, and the resident is notified.
5. Closing it needs a reason, and a new message re-flags the chat.
6. The form closes the chat it came from.
7. Another resident's chat id cannot close a chat.
8. A resident cannot forge who filed the report.
9. A non-model failure on every attempt goes to a person.
10. A turn the server dies in twice is taken over once, then given up and passed to a person.
11. An empty chat is abandoned, not reviewed.

**Mutation checks** (each test run against a deliberately broken version):

| Broken version | Result |
| --- | --- |
| The takeover cap disabled | Test 10 fails: "Timed out waiting for the reply" (the turn stays pending forever) |
| `reportIssue` spreading the client's arguments again, as it did before | Test 8 fails. The case history reads "Priya Nair reported: … (chat with Relay's assistant, filed by Morgan Reyes after the assistant did not finish)" |

**Logs:** `docs/evidence/unit-tests-run.txt`, `api-tests-run.txt`, `e2e-journey-run.txt`.

**One failed run, kept rather than hidden:**

- **What happened:** an earlier full journey run on the final code failed journey 1, the appliance flow, which
  does not touch chat code. The Windows host was out of memory, about 28,500 pages a second, and the login page never
  rendered.
- **The rerun:** 18/18 in 2.3 minutes, none needing the retry.
- **Log and diagnosis:** [e2e-journey-run-2026-11-25-starved-host.txt](../evidence/e2e-journey-run-2026-11-25-starved-host.txt).

## Problems found while doing this

1. **A forgery hole, introduced by this change and caught before commit.**
   - The form's `reportIssue` passed the client's arguments straight into `createCase`. So a resident could have set
     the new `filedBy` field and made the history say a manager or the safety rules filed their report.
   - **Fix:** `reportIssue` now takes the form's own fields by name.
   - Before this change the spread already overrode the agent's reading and the multi-issue group, so no released
     version was affected.
2. **A duplicate a resident's ordinary path would have caused.** The offline reply invites the resident to use the
   form, which would have left a review item and a case for the same problem. Filing with the form now closes the
   chat (change 5).
3. **The resident was never told.** The resident has usually left the chat by the time a manager files it, and a
   new visit starts a new chat, so the "filed it for you" message went unseen. Hence the notification (change 3).
4. **A race.** Filing from a chat created the case before checking whether the chat already had one. Now it checks
   first.
5. **Test cleanups that did nothing.**
   - `hook("fault", { point: "none", times: 0 })` armed an unused point instead of disarming the real one. It
     appeared in two new files and one existing file (`discovery.test.ts:303`).
   - All three now disarm the point by name, and the hook documents `times: 0`.
6. **A wrong measurement of my own.** The first version of `safety-screen.ts` scored only the first message and the
   whole conversation at once. Production files at the first message where the screen fires, so that version missed
   H003, which fires at message 1 but not over the whole conversation. Corrected before publication; the table above
   is the corrected one.

## What it does not do, and what is left

- **No new detection.** See above: the held-out v2 misses still depend on the model.
- **The 30-minute idle wait.**
  - A report the rules cannot read, and that the resident stops answering, reaches a person only after 30 minutes.
    V013 is the example: a neighbour heard saying "please don't".
  - It can be shortened (`INTAKE_IDLE_MINUTES`), at the price of reviews of chats the resident was still writing.
- **"Start over" sends nothing to review.** It abandons the chat, even if the words are concerning and the rules
  missed them.
  - Deliberate for now: the resident chose to restart, and rule-flagged emergencies are already filed.
  - The words are kept in the database.
  - Worth measuring how often restarted chats contain words before deciding.
- **Review alerts are not re-escalated.** They have no case, so they do not appear in the overdue-acknowledgement
  list, and the sweep does not raise them again as it does unacknowledged emergencies. The panel lists the oldest
  first.
- **The safety advice is the rules' text for the category.** Water through a sparking ceiling light gets "Do not use
  the appliance or the outlet".
- **Not measured with the live model.** The live harness bypasses `sendIntakeMessage`. The production-path benchmark
  (improvement 2) will measure the safety net end to end.

## Reproduce

From `app/`, with the dev server running with `RELAY_TEST_HOOKS=true FIBER_MODE=fixture LLM_DISABLED=true`:

```sh
npx tsx --test tests/unit/safety-net.test.ts
npx tsx --test --test-concurrency=1 tests/api/intake-safety.test.ts
npx tsx tests/eval/intake-failures.ts after    # writes docs/evidence/intake-failures-after.json
npx tsx tests/eval/safety-screen.ts            # no server needed; writes docs/evidence/safety-screen.json
(cd e2e && npx playwright test journeys -g "6. the chat safety net")
```

The "before" file was produced with the same script against the dev server before this change was loaded: its
replies are the old texts.
