# Relay V2 — Engineering Handoff: Real Maintenance Coordination

**Date:** 2026-11-22 · **Status:** Proposed V2, not implemented or production-ready · **Baseline:** \`main\` at \`872e89f\` (merged PR #8)

## Product outcome

A resident calls a real building phone number and reports **any residential maintenance issue**. Relay verifies context, collects facts, categorizes the issue, creates a durable work order, decides between staff, emergency escalation, or an approved contractor, obtains a real quote and available time, gets any required spending authorization, secures the contractor's actual acceptance, notifies the resident, and follows up through resolution.

**Rule:** The AI converses and proposes. The server authenticates, validates, authorizes, persists, and verifies. A call attempt is not a contractor offer; an offer is not approval; approval is not a confirmed booking; a claimed resolution is not verified completion.

## Baseline: what the merged hackathon version actually does

**Existing:** Wasp/React and Node/TypeScript, Prisma/PostgreSQL, ElevenLabs browser voice and authenticated intake webhook, staff action flow, approval enforcement, TraceRoot spans, student/operator UI. Some real external voice/tool interactions were tested during the hackathon.

**Simulated:** three fixed contractor outcomes (Bluejay, QuickFix, Metro), the recommendation scenario, and appointment confirmation. There is no general-purpose issue classification, real vendor roster, inbound telephone number workflow, outbound vendor calling, multi-day follow-up, PMS synchronization, or production authentication.

Keep the working app. **Do not blend seeded demo outcomes with real production state**. Keep simulation behind a separate explicit environment/test adapter.

## Architecture

\`\`\`text
Resident voice phone / web / SMS
         |
Twilio inbound -> ElevenLabs Resident Agent
         |      (authenticated server tools; scoped actions)
         v
Wasp API / React dashboards -- RBAC for resident, staff, manager, vendor
         |
    PostgreSQL/Prisma (source of truth)
         |  requests, evidence, approvals, appointments, events
  outbox/inbox for provider side effects and callbacks
         |
Durable TypeScript worker (Temporal as multi-day target)
         |        ^ wait on reply, manager decision, vendor acknowledgment
         +--> ElevenLabs Vendor Agent + Twilio outbound
         +--> SMS/email provider, delivery callbacks
         +--> authorized PMS adapter (Buildium OR AppFolio pilot)
         +--> scheduled follow-ups / failure escalation
         |
       TraceRoot + audit + metrics
\`\`\`

**Agents:** one resident-facing agent for intake/status and one vendor-facing agent for availability/quote collection. Do not build a seven-agent swarm before proving the two-channel workflow.

**Durability:** Temporal gives explicit timers, callbacks and retryable activities for long waits. Start with the smallest reliable worker compatible with the current Wasp app; Wasp background jobs or a Postgres job queue can cover a narrow pilot if correctly persisted. Provider calls, notifications and final booking need *idempotency* even when activity retries occur.

## Concrete example: a tenant reports a leaking pipe

1. Caller dials authorized building number; agent identifies itself as AI and verifies property/unit through a permitted method. Never trust caller ID alone.
2. Voice agent collects observed facts, property, unit, access, impact and safety indicators; calls \`upsert_maintenance_request\`.
3. Backend validates request and building scope; assigns \`PLUMBING\`, severity, evidence and an owner. Hazard policy sends significant leaks to an on-call human. Unknown categories become \`NEEDS_INFO\` rather than an invented diagnosis.
4. For an authorized nonemergency, worker chooses qualified, in-coverage vendors on an approved roster with permitted contact hours.
5. Vendor agent calls **consented test/vendor numbers only**, logs each call's external ID and delivery/call status, gathers a quote and times. Silence/voicemail is recorded as unavailable or unknown.
6. Backend normalizes offers by scope (diagnostic vs repair vs inspection), total-cost uncertainty, time, availability and policies. An LLM never makes binding decisions by itself.
7. Above the building's threshold, manager approves a **specific offer version** with a spend cap, scope, and expiry; stale or changed offers require fresh approval.
8. Only after both tenant access availability and vendor's explicit confirmation does system persist \`CONFIRMED\`. A successful outbound API request is *not* acceptance.
9. Tenant receives an actual SMS/phone update with tracked delivery; reminders, no-show recovery and rescheduling are durable jobs.
10. Vendor/staff supplies completion evidence; resident may verify; manager resolves exceptions and closes the work order.

## Data redesign

Add models (scoped by organization and property): \`Organization\`, \`Property\`, \`Unit\`, \`Resident\`, \`Asset\`, \`Membership\`, \`Role\`, \`PropertyPolicy\`, \`Vendor\`, \`VendorCoverage\`, \`VendorContact\`, \`MaintenanceRequest\`, \`IssueClassification\`, \`Conversation\`, \`VendorOutreachAttempt\`, \`VendorOffer\`, \`ApprovalDecision\`, \`Appointment\`, \`Notification\`, \`FollowUpTask\`, \`CompletionEvidence\`, \`WorkflowRun\`, \`AuditEvent\`, \`ProviderWebhookInbox\`, \`OutboxEvent\`.

Important unique constraints:
- Deduplication key scoped to (organization, property, unit, asset, active incident), **not** to a globally numbered washer.
- \`(provider, providerEventId)\` unique for inbound callbacks.
- Unique outbound effect key and provider correlation ID to prevent duplicate calls/SMS/bookings.
- Offer version, approval version, and appointment confirmation evidence are linked.

Status machines:
- Request: \`REPORTED -> TRIAGED -> DISPATCH_READY -> IN_PROGRESS -> RESOLUTION_PENDING -> RESOLVED -> CLOSED\`, with \`NEEDS_INFO\`, \`EMERGENCY_ESCALATED\`, \`CANCELLED\`, \`BLOCKED_HUMAN\`.
- Vendor: \`QUEUED -> CALL_REQUESTED -> RINGING -> CONNECTED -> OFFER_RECEIVED|DECLINED|NO_ANSWER|VOICEMAIL|FAILED\`; selected offer progresses to \`APPROVAL_PENDING -> APPROVED -> COMMIT_REQUESTED -> CONFIRMED|EXPIRED|REJECTED\`.
- Staff lane and notification lane remain independent of vendor/repair state.

Every transition has a precondition, actor, audit event and idempotency behavior. Do not expose arbitrary status-write tools to the LLM.

## Minimal external adapters

\`TelephonyProvider\`: initiate verified inbound/outbound agent calls, receive status and conclusion events, correlate provider conversation/call IDs, enforce allowlist/consent.

\`NotificationProvider\`: SMS/email send, delivery callback and retries.

\`PropertySystemAdapter\`: resident/property lookup; create/update work order; reconcile external status; fail safely on missing permissions. Implement exactly one pilot PMS.

\`VendorDirectory\`: approved contacts, categories/trades, licenses/insurance verification as required, operating hours, escalation policy, preferred ranking.

Provider docs:
- ElevenLabs tools: https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools
- ElevenLabs/Twilio outbound calls: https://elevenlabs.io/docs/eleven-agents/api-reference/integrations/twilio/outbound-call
- Twilio calls: https://www.twilio.com/docs/voice/api/call-resource
- Twilio SMS: https://www.twilio.com/docs/messaging/api/message-resource
- Temporal TypeScript: https://docs.temporal.io/develop/typescript
- Buildium API: https://developer.buildium.com/
- AppFolio Stack API: https://www.appfolio.com/stack/partners/api

## Production safety

1. Never place unapproved calls, dispatch emergencies autonomously, guarantee a technician or promise a price/time without real acknowledgment.
2. Enforce building-specific policies: approved vendors, call windows, tenant consent, emergency contacts, allowed trades and spend limits. Default deny unconfigured external actions.
3. Enforce role and tenant/property authorization on **every endpoint and action**. A shared browser session ID or one operator PIN is insufficient for real production.
4. Validate provider webhook signatures, dedupe callbacks and bound retries; explicitly test server restarts during calls, expired approvals and delayed offer messages.
5. Review tenant/call recording privacy, consent, retention and local legal requirements before serving real residents.
6. Trace structured outcomes and correlation IDs with TraceRoot, not raw recordings, transcripts, phone numbers, addresses or credentials.

## Implementation order, each as a separate tested PR

1. \`v2/tenant-property-schema\` — migrations, RBAC, tenant isolation, staff/manager identities.
2. \`v2/generalized-intake\` — any category, property policies, risk classification, persistent request identity.
3. \`v2/inbound-phone\` — Twilio/ElevenLabs real phone on approved numbers; no voice-only false success.
4. \`v2/vendor-roster\` — approved vendor data and dial policy.
5. \`v2/verified-outreach\` — one real **test** vendor call; status callbacks, quote evidence, inbox/outbox.
6. \`v2/approval-booking\` — specific versioned quote approval, verified vendor acknowledgment, actual appointment.
7. \`v2/notifications\` — tenant confirmation and SMS delivery callbacks.
8. \`v2/durable-followup\` — retries, reminders, reschedules, recovery from worker restart.
9. \`v2/closeout-evals\` — completion verification and fault-injection tests.
10. \`v2/pms-one-pilot\` — one authorized property-management system.

**First real milestone:** a tenant makes a voice call; a real categorized work order is saved; one authorized test vendor receives a real outbound AI call and gives a quote; manager approves; the vendor explicitly commits; the tenant gets a real delivered update. The UI shows provider evidence. No simulated offers.

**Adversarial acceptance:** duplicate callback, worker crash after a call, timeout, vendor voicemail, changed quote after approval, duplicate tenant report, safety escalation, unauthorized manager action, and notification delivery failure. All must preserve one coherent incident and zero unauthorized bookings.

## Market reality and positioning

This is a competitive category. Property Meld/MAX, Latchel and EliseAI already offer maintenance intake/coordination features. Do not pitch “first AI maintenance platform.”

The hypothesis worth testing: **a transparent, policy-controlled, vendor-agnostic coordination layer that integrates with incumbent PMS tools and reliably executes multi-day maintenance handoffs for a specific property-management segment.** Interview managers, on-call coordinators and contractors before adding more features.

Measure: intake success without false claims, safety escalation recall, time to acknowledgment, verified time to booking, manual coordination time, duplicate external effects (target zero), unauthorized commitments (target zero), and confirmation accuracy.

## Constraints / handoff

This document specifies **work to implement**; it does **not** assert that V2 integrations, real calls, durable worker, or customer pilots exist. All code should be built in reviewed branches, with explicit credentials and consent supplied by the authorized operator. The currently running Cloudflare demo tunnel should never be treated as production hosting.

**Do not alter or merge the original hackathon baseline as part of this design PR.**
