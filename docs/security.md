# Security and robustness review (V1.1)

A read-only review of the V1.1 server code found 1 high, 8 medium and a number of low findings. Each one below is
listed with what changed and how it is verified. Where something is not fixed, it says so.

**Scope:**

- authorization across roles and properties;
- the agents' limits;
- discovery and onboarding;
- notifications and email;
- jobs, retries and concurrency;
- secrets;
- test-only endpoints;
- abuse of paid paths.

**Method:** a separate reviewer read the code with no access to the running app. Each fix was then made and covered by
tests where a test is possible. The regression tests are in `app/tests/api/audit.test.ts` and
`app/tests/unit/policy.test.ts`; [STATUS.md](../STATUS.md) has the run results.

## High

### H1. A manager could change, through discovery onboarding, a vendor that another property uses

**Was:**

- Onboarding matched a discovered business against every vendor in Relay, by name, phone or website host.
- On a match it linked that vendor, added the trade to its shared record and approved it here.
- The manager could then edit the shared name, trades and contacts, which changed the vendor for the other property's
  manager and residents too.
- Host matching could also merge unrelated businesses that share a host such as `facebook.com`, sending offers to the
  wrong contractor logins.

**Now:**

- **Matching:** a duplicate is the same Google Maps listing or the same 10-digit phone number. A matching name alone is
  shown as a concern, and onboarding refuses it (`name_taken`) instead of merging. Website hosts are not compared.
- **Onboarding a vendor that another property also uses:** this adds it to this property's directory only. Its trades
  and contacts are never changed. If it lacks the trade, onboarding is refused (`vendor_shared`).
- **Editing:** a vendor's shared details (name, trades, contacts) can only be edited by someone who manages every
  property that lists it. Otherwise the edit returns 403 `vendor_shared`, and the Vendors page shows "Shared with
  another property" instead of Edit. Approval is still per property, and every manager controls their own.
- **Concurrency:** two onboardings of the same new name at once give a 409, not a 500.

**Verified:** `audit.test.ts`, "H1". The existing discovery tests still pass: the demo's Evergreen duplicate is now
matched by phone.

**Known:** the V1.1 migration carries V1's global approval flag over to every property, because in V1 an approved
vendor was approved everywhere. Managers can remove that approval per property.

## Medium

| # | Finding | Fixed by | Verified |
| --- | --- | --- | --- |
| M1 | Emergency re-alerts took 25 unordered rows that never left the query, so a backlog could stop new emergencies from being re-alerted. One alert per recipient also meant M² alerts for M managers | One re-alert per emergency, oldest first, skipped if any recipient acknowledged it. Handled rows get `escalatedAt` and leave the query. The migration marks rows the old code had already re-alerted | `followups.test.ts`, "raised again once, then not again" |
| M2 | An AI escalation left the vendor's offer or visit live. Words from the original report could re-escalate a case the manager had resumed. `emergency` stayed true after a resume | An AI escalation releases the vendor first (slots cancelled, vendor told), like a manager's. After a manager has resumed a case, Relay AI can only suggest escalating. Resuming clears `emergency` | `audit.test.ts`, "M2" (the resume). The AI path needs the model and is covered by code review, not by a test |
| M3 | The staff-only note filter recognised only lines that start with "staff only", "internal" or "confidential". Bullets, bold, quotes and the rest of a staff block reached the resident-facing agent. The reply guard missed spaced or spelled-out digits | The notes are parsed into blocks. A marked line hides everything up to the next blank line, and a marked heading hides its whole section. Markers work as bullets, quotes, numbered items or in bold. Secrets include words mixing letters and digits. The guard catches "4 4 1 7", "4-4-1-7" and "four four one seven" | `policy.test.ts` (8 tests) |
| M4 | The test hooks (reset, sweep, budget overrides) had no authentication apart from two environment variables | Four gates: `RELAY_TEST_HOOKS=true`; never when `NODE_ENV=production`; loopback callers only (the socket address, never a forwarded header); and a shared token (constant-time compare) when `RELAY_TEST_HOOKS_TOKEN` is set. Fiber budget settings can only be changed while Fiber is in fixture mode or off | Every suite runs through the hooks. Calls from another machine were not tested |
| M5 | A vendor whose job was done saw a later vendor's work on the reopened case. A vendor that had only been offered a job saw the entry instructions | Vendor activity (times, start, progress, completion, confirmed visit, acceptance) is tagged with its vendor, and other vendors never see it. Access notes are shown once the vendor accepts | `audit.test.ts`, "M5" |
| M6 | No limits on paid paths (model calls, voice sessions) or on sign-in attempts | Per resident, per hour: 20 reports, 60 chat messages, 10 voice sessions. A conversation is capped at 20 resident messages, since each turn resends it to the model. Sign-in: 10 failures per username or 50 per address in 15 minutes, then 429 until the window passes. All configurable (`LIMIT_*`) | `audit.test.ts`, "M6" |
| M7 | A failed intake turn left the resident with no reply: the retry found the failed run and only cleared the marker. A slow turn could be taken over while it was still running, and the slow run's write could erase later messages. A failed coordinator run was dropped silently | **Intake:** a retry takes over a failed run while attempts remain, and when they run out the resident gets an apology and the form. A whole turn has a 3-minute deadline (every model call included), and a takeover waits 4 minutes. The conversation is written only while that turn is still pending (compare-and-set). **Coordinator:** a failed or interrupted run is recorded on the case ("AI review failed"), and the managers holding it are told once what is next. It is not re-run, because it may already have acted | `audit.test.ts`, "M7" (an injected failure, then the retry answers) |
| M8 | Missing indexes, and heavy reads on polled pages | Added indexes: `VendorAssignment(caseId, status)`, `AppointmentSlot(assignmentId, status)` and `Case(status, statusChangedAt)`. **Not changed:** the command center still runs about 20 queries per refresh, and the sweep still locks each case awaiting a resident's confirmation every minute. Fine at demo scale, not at hundreds of buildings | Migration `20261123080757_audit_fixes` |

## Low

| Finding | Status |
| --- | --- |
| Two managers deciding the same AI proposal at once | **Fixed.** The proposal is checked again under the case lock; a failure never overwrites a proposal another manager carried out |
| A slow email batch could outlive its claim, and another pass could send the same email | **Fixed.** Before each send the row is checked to still be this pass's claim (attempt count), and the lease is refreshed |
| Related cases were not filtered by property, and the form accepted a client-supplied `intakeGroup` | **Fixed.** Related cases are the same resident's at the same property; only the chat agent sets the group |
| `getAiStatus` showed the model server address to every role | **Fixed.** The reason is generic and the address goes only to the server log |
| SMTP with a password could be sent in the clear if STARTTLS was stripped | **Fixed.** `requireTLS` is set whenever SMTP credentials are used without implicit TLS |
| Fiber error text was stored and shown verbatim | **Fixed.** Keys (`sk_live_…`, `sk_test_…`), bearer tokens and long token-like strings are removed first |
| The daily Fiber credit check was not atomic | **Fixed for one process.** The checks, the search and the charge record run one at a time in a process. Several processes could overshoot by one search each |
| An approval threshold up to $100,000 with autopilot approves money with no person | **Capped at $5,000.** Changes to autopilot, the threshold and auto-discovery are logged with who changed them (server log, not yet an audit table) |
| AI offers were recorded as made by the first manager, or by the resident if there was none | The event is Relay AI's. The responsible person on the offer is the property's manager, never the resident, and a property with no manager gets no AI offers |
| Reminder dedupe keys are per case, not per verification round | **Not fixed.** In a second round of verification after a reopen, reminders already sent in round one are not repeated |
| Notification email addresses are not verified | **Not fixed.** Addresses are entered by the person themselves. No confirmation email yet |
| Discoveries waiting for a manager never expire | **Not fixed.** Results are cached for 14 days, and a manager can force a new search |
| The clash check for visits to the same unit is not serialised | **Not fixed.** Two vendors' times for one unit could both be confirmed if chosen at the same instant |

## Checked and sound

- **Authorization:**
  - Every operation identifies the caller and checks the role.
  - Object checks run with the case row locked.
  - Residents see only their own cases and conversations, including through the intake agent's tools.
  - Discovery, candidates, proposals and settings are checked per property.
- **AI limits:**
  - The state machine limits the AI to offering approved vendors and escalating.
  - Messages to residents need a manager's approval and pass the grounding check.
  - Money, scheduling, closing and cancelling are never the AI's.
- **Data:**
  - Raw SQL is parameterised.
  - Idempotency keys are in place.
  - Partial unique indexes hold the key invariants: one live offer per case, one confirmed visit per assignment, and
    one active discovery per case and trade.
- **Discovery:**
  - Claims use compare-and-set, and onboarding takes a row lock.
  - The paid response is saved before processing, so a resumed run never pays twice.
- **Secrets:**
  - No environment variable reaches the browser.
  - `/health` returns on/off flags only, and logs record error names, not messages with values.
  - `.env.server` is gitignored and has never been committed; the repository contains no keys.
  - React blocks `javascript:` links in business URLs from discovery.
