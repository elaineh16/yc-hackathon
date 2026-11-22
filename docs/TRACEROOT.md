# TraceRoot integration for Relay

TraceRoot is a required reliability and observability layer for Relay. It records agent runs, model/tool calls, inputs/outputs where configured, timing and cost; detectors and evaluations help identify recurring failures and verify fixes. It is not a replacement for the relational database or ordinary infrastructure logs.

## 1. Setup

Prerequisite: Node.js 20.12 or later.

After the Wasp app exists, run this from the repository root:

```bash
npx -y traceroot-cli@latest setup
```

Complete browser sign-in and create/select the Relay project. Review every generated change before accepting it. The setup flow can add the TypeScript SDK and project environment configuration. The documented SDK package is `@traceroot-ai/traceroot`; the CLI is `traceroot-cli`.

If setup must be performed manually, follow the current TypeScript SDK documentation and initialize the SDK once in the Wasp Node server startup. Do not copy an old setup snippet blindly or initialize the SDK separately on every request.

Server environment:
- `TRACEROOT_API_KEY`: project API key; server only.
- `TRACEROOT_HOST_URL`: normally `https://app.traceroot.ai`.
- `TRACEROOT_PROJECT_ID`: optional CLI project selector where needed.

Never prefix TraceRoot credentials with `VITE_`, `NEXT_PUBLIC_`, or another client-exposed prefix.

## 2. What Relay must trace

Instrument the backend-visible boundaries of one student incident:

| Span / operation | What it should establish |
|---|---|
| `relay.voice_session.create` | A browser voice session was requested and a credential was issued or failed |
| `relay.intake.tool` | Authenticated ElevenLabs tool call arrived, was validated and completed/failed |
| `relay.work_order.persist` | Work order was created or an existing open incident was idempotently updated |
| `relay.safety.classify` | Normal flow continued or a hazard caused escalation |
| `relay.staff_request.create` | Staff assistance request was created |
| `relay.staff_status.update` | Accepted/ETA, retrieved or unavailable transition |
| `relay.contractor_results.seed` | Seeded contractor outcomes were recorded; mark them simulated |
| `relay.recommendation.compute` | Recommendation and its availability/cost/scope rationale |
| `relay.manager_decision` | Manager approved or denied the stated all-in cap |
| `relay.confirmation.guard` | Confirmation was allowed or rejected based on server-side approval state |
| `relay.appointment.simulate_confirm` | Simulated appointment was recorded after approval |
| `relay.student_update.publish` | Student-visible state update was prepared/published |
| `relay.demo.reset` | Demo state reset and stale session invalidation |
| `relay.error` / retry | Error category, retry count and final outcome |

Use the TraceRoot TypeScript SDK's documented instrumentation and supported manual span mechanism. Wrap meaningful agent/tool/workflow functions, not every trivial helper or React render. Initialize once at server startup.

## 3. Correlation and provider boundary

- Carry a stable, non-sensitive `demoSessionId` from the student browser session into the ElevenLabs tool request and Wasp workflow.
- Attach `demoSessionId` and `workOrderId` to the relevant spans using supported TraceRoot/OpenTelemetry attributes. Propagate W3C trace context where the transport supports it; if it does not, use those IDs to correlate the related traces.
- The official native integration list covers several model providers and agent frameworks, but do not assume that ElevenLabs' hosted model internals are automatically instrumented. Trace the events Relay can observe: session creation, tool invocation, validation, persistence, workflow decisions and returned results. Only claim model-level spans/tokens if the provider actually exposes them.
- Contractor results and appointment confirmation are seeded demo outcomes. Mark them simulated in span attributes and UI.

## 4. Data handling and resilience

Allowed trace metadata:
- non-sensitive demoSessionId and workOrderId
- operation name, status, duration, retry count
- simulated=true/false
- safe reason codes such as `missing_location`, `db_unavailable`, `approval_required`, `hazard_escalated`
- approval outcome and amount/currency for the synthetic demo scenario

Do not record:
- audio payloads
- raw or full voice transcripts
- student names, personal phone numbers, emails or authentication credentials
- API keys, tool secrets, session credentials or authorization headers
- any real resident or maintenance data

Use synthetic demo values. Keep normal application logs separate from TraceRoot traces. Trace export must fail open: if TraceRoot is unavailable, the workflow must still enforce its normal database and authorization rules and continue or fail for its actual business reason.

## 5. Detectors and evaluation set

Start with a compact golden set that covers:

1. Happy path: washer, dry floor, reported OE; persisted work order; staff request; simulated offers; manager approval; simulated confirmation.
2. Missing location: Relay asks a clarification and does not persist incomplete data as a completed ticket.
3. Duplicate intake: same open incident updates one work order.
4. Database failure: no “ticket saved” claim.
5. Safety hazard: escalates to residence staff and stops routine contractor recommendation.
6. Staff unavailable: student is updated; clothes are not marked retrieved.
7. Independent lanes: clothes retrieval can complete while repair remains pending.
8. QuickFix scope: diagnostic-only is not represented as a complete repair quote.
9. Metro voicemail: unknown availability and price remain unknown.
10. Manager denial: appointment remains unconfirmed.
11. Approval bypass: a forced/replayed confirmation before approval is rejected server-side.
12. Session isolation: one demo session cannot read another session's work order.

Initial detector targets:
- **False success:** agent claims intake was saved without a successful persistence result.
- **Unsafe continuation:** hazard is detected but routine contractor recommendation/confirmation continues.
- **Approval bypass:** appointment confirmation succeeds without the required manager approval.
- **Duplicate effect:** duplicate tool/action replay creates a second work order, approval or appointment.
- **Unsupported quote:** recommendation invents Metro price/availability or misstates QuickFix diagnostic-only scope.
- **Status mismatch:** student is told staff retrieved clothes or an appointment is confirmed when the persisted state does not support it.

Implement detectors/evaluations using the current TraceRoot product/CLI interfaces after the first real traces exist. Do not fabricate a CLI command or claim a detector is active until it has been created and run.

## 6. Verification

After running the app and one happy-path demo:

```bash
traceroot doctor
traceroot traces list --since 1h
traceroot traces get <trace-id>
```

Inspect the span tree. Confirm the expected workflow operations are present, the correlation IDs match the same demo incident, errors have meaningful status/reason fields, and no secrets or raw transcript/audio appear. Then run the golden evaluation cases and intentionally inject at least the database-failure and approval-bypass cases to prove the detectors/guards work.

A successful CLI login alone is not completion. The acceptance gate is a real Relay run visible in TraceRoot with the expected spans and verified critical failure cases.
