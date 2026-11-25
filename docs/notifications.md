# Follow-ups and notifications

In-app notifications are the primary channel and are always on. Email is secondary:

- only for people who opted in;
- only when SMTP is configured;
- only for events worth an email.

Scheduling uses the database and pg-boss. There is no SMS, no paid service and no new queue.

## The notification record

Every notification is one row per **recipient, event and channel** (`Notification` in `app/schema.prisma`):

| Field | Meaning |
| --- | --- |
| `userId`, `caseId` | recipient and case |
| `eventType` | what happened (`case.received`, `appointment.proposed`, `repair.completed`, `verification.reminder`, `agent.blocked`...) |
| `channel` | `IN_APP` or `EMAIL` |
| `createdAt`, `scheduledFor` | when it was created and when it may be sent |
| `attempts`, `nextAttemptAt`, `lastError` | retry state |
| `status`, `statusNote`, `sentAt`, `providerMessageId` | what really happened, in plain words |
| `dedupeKey` (unique) | idempotency: a retried action or a re-run sweep creates nothing new |
| `ackRequired`, `ackDueAt`, `readAt`, `acknowledgedAt` | who must act by when, and whether they did |
| `actionUrl` | a plain app link to the case: it requires signing in and carries no token |

### Delivery states never claim more than the channel proves

| Status | Meaning |
| --- | --- |
| `DELIVERED` | In-app only: the row is in the recipient's Relay inbox |
| `ACCEPTED` | Email: the SMTP server accepted it. Delivery to the mailbox is not confirmed |
| `CAPTURED` | Email: a local capture server (Mailpit, `SMTP_CAPTURE=true`) accepted it. It was not delivered to anyone |
| `PENDING` / `SENDING` | Queued, or claimed by a sender (with a 2-minute lease) |
| `FAILED` | Not sent after 3 attempts (backoff 1 min, then 5 min), with the last error |
| `SKIPPED` | Not sent, with the reason: no address, not opted in, email not configured, or the per-person hourly limit |

Nothing in Relay reports an email as delivered to a person.

## Behaviours

| | When | Who | Channel | Bound |
| --- | --- | --- | --- | --- |
| A | Report received | resident | in-app + email | once |
| B | Someone must act by a deadline: an offer (the vendor, "by X or the offer expires"), an estimate (the manager), visit times (the resident, "by X, then your manager follows up"), an emergency (managers, 15 min to acknowledge) | the person holding the case | in-app (+ email for actions) | one offer reminder at half time; an unacknowledged emergency is raised once more, once per emergency, and not if any manager acknowledged it |
| C | Visit times proposed: choose one or say none work | resident | in-app + email | `maxReminders` reminders (default 2), then the manager is told once |
| D | Upcoming confirmed visit | resident and contractor | in-app + email | once, `appointmentReminderMinutes` (24 h) ahead |
| E | Repair complete: "Yes, resolved" / "No, still having problems" | resident | in-app + email | "No" reopens the case for the manager, who is told; the coordinator wakes (`NOT_FIXED`) |
| F | No answer | resident, then manager | in-app + email | verification reminders stop at `maxReminders`; the manager is told once that they may close it as unverified; nothing is resolved automatically |
| G | Relay cannot proceed: the model is offline, no approved vendor and discovery off or failed, a search not run | managers | in-app (+ email) | once per trigger |
| H | A chat report the assistant did not finish: it could not reply, every attempt failed, or the resident stopped for 30 minutes with nothing filed (a possible emergency is filed at once instead, as a case) | the property's managers, with the resident's words; the resident, when a manager files it | in-app + email | once per review. Filing or closing it acknowledges every manager's alert. A new message after a close starts a new review |

Approval reminders are daily, at most three. Each reminder's dedupe key is unique to that reminder, so the sweep can
run every minute, twice, or on two servers, and nothing repeats or loops.

**Known gap:** three keys are per case, not per round of the case: verification reminders (`verify-reminder:n`), the
verification-overdue notice and approval reminders (`approval-reminder:day`). After "not fixed" and a second repair, or a
second approval, those reminders are skipped while the history still records "Reminder n of m sent". See
[V12_BASELINE.md](engineering/V12_BASELINE.md#4-backend-failure-classes); it is improvement 4 there.

**Acknowledgement.** Acting on a case (accepting the offer, choosing a time, deciding an approval) acknowledges the
actor's open notifications for it. "Got it" in the notification menu acknowledges one explicitly. Overdue
acknowledgements are listed in the manager's command center.

## Email

- **Transport:** nodemailer over plain SMTP, configured by `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
  `SMTP_SECURE` and `SMTP_CAPTURE`. With no `SMTP_HOST`, email is off and every email row is `SKIPPED`
  ("not configured").
- **Locally:** Mailpit (`docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit`), with `SMTP_CAPTURE=true`.
- **Content:** the notification title and a short body, a link to the case that requires signing in, and why the
  person gets it. Emails never carry access notes, codes, costs for residents, or other residents' details.
- **When it sends:** after the database commit, never inside the action's transaction, so a slow or failing mail
  server never blocks or rolls back a case action. The minute sweep also delivers anything due.
- **Claiming:** rows are claimed with `FOR UPDATE SKIP LOCKED`, so concurrent passes send each email once. A send
  interrupted by a crash is retried after its lease. Before each send the row is checked to still be this pass's
  claim, so a slow batch that outlives its lease does not send a row another pass has taken. The stable `Message-ID`
  (`<notification-id@relay.local>`) lets mail systems drop a duplicate in the rare remaining case: delivery is at
  least once.
- **Limits:** `EMAIL_MAX_PER_USER_PER_HOUR` (12). Over the limit the email is `SKIPPED` with the reason; the in-app
  notification is still delivered.
- **Preferences:** each person sets an address and opts in, from the notification menu ("Email notifications…").

## AI-drafted messages

The coordinator may draft a resident update, but only through `propose_resident_update`:

1. **Generated.** The draft is checked against the facts a resident may see on the case (`checkGrounding`): no
   amount, time, date, number or company name that is not on the case, no relative-time promise ("tomorrow"), and
   no guarantees. A draft that fails is refused with the reason, and the model can rewrite it.
2. **Approved.** It is saved as a `PENDING` proposal: "generated by Relay AI, checked against the case facts".
3. **Sent.** A manager approves or edits it. Only then is it sent, as an event marked "AI draft, sent by a manager"
   (`generatedBy: AI`, `approvedBy`, `edited`), with the delivery recorded per channel.

## Tests

`app/tests/api/followups.test.ts` (15 tests, against Mailpit's API) covers:

- correct recipients and nobody else;
- cross-property isolation;
- link and content minimisation;
- honest delivery states (`CAPTURED`, never `DELIVERED` / `ACCEPTED` for capture);
- opted-out and no-address skips with reasons;
- an offer with its deadline, a single half-time reminder, and acknowledgement by acting;
- C, with bounded reminders and one manager notice;
- declined times;
- D, once per person;
- E, then reopening;
- F, bounded and idempotent, never resolved automatically;
- concurrent delivery with no duplicates;
- an SMTP outage (retries, `FAILED` after 3, mail queued during the outage sent afterwards);
- missing configuration;
- one re-raise of an unacknowledged emergency;
- G, once per trigger.

The browser journey "follow-up" checks the in-app notification and the captured email, then reopening.
