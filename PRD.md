# Relay hackathon demo PRD

Build the single washer incident in [DEMO.md](DEMO.md). The student talks to Relay live in their phone browser. Staff and manager actions happen in the Wasp dashboard. Contractor outcomes are simulated and labeled. The demo ends when staff have retrieved the clothes and the dashboard shows a simulated repair appointment confirmed after manager approval.

## What the judges see

| Beat | Student view | Operator dashboard |
| --- | --- | --- |
| 1. Report the issue | Tap **Talk to Relay**, allow microphone access, and talk with ElevenLabs. Relay asks up to three questions, reads back MKV, the main laundry room and washer 2, and records that the floor is dry and the washer displays `OE`. Tap **End call** when done. | One work order with the washer details and a pending staff request. A repeat intake for the same open washer updates the existing order. |
| 2. Get the clothes back | The latest update shows **Staff on the way · 15 minutes** when the staff stand-in accepts. It changes to **Clothes retrieved** after staff mark it done. | The front-desk card shows requested → accepted with ETA → retrieved. The simulated contractor outreach runs alongside the staff request. |
| 3. See the repair options | An update summarizes why Relay recommends Bluejay and shows the latest staff status. | Simulated results appear for Bluejay ($329 CAD before tax for a next-day repair, conditional on diagnosis), QuickFix ($99 CAD for a same-day diagnostic, repair extra), and Metro (voicemail). |
| 4. Approve spending | The repair update shows that manager approval is pending. | The $329 estimate exceeds the $250 auto-approval threshold. The manager approves a cap of $400 CAD including taxes and fees, conditional on diagnosis. |
| 5. Confirm the appointment | The latest update shows Bluejay's simulated arrival window after confirmation. | After approval, the operator can record the seeded Bluejay confirmation using **Simulate confirmation**. The appointment and staff outcome remain visible on the same work order. |

Relay introduces itself as an AI assistant, tells the student to leave the washer door closed, and directs them to check this page for updates. Treat `OE` as a reported drainage symptom. Bluejay's repair estimate remains conditional on diagnosis. If the student reports a safety hazard, direct them to the designated residence staff and stop the normal flow.

## Build

- **Student page.** Make a minimal, mobile-friendly Wasp page with **Talk to Relay**, a connection status, **End call** during the session, and the latest work-order update. One tap starts a full-duplex voice session. Use the ElevenLabs React SDK and the browser mic and speaker. Serve the page over HTTPS. Show a retryable message if the mic permission or connection fails.
- **Voice intake.** Configure one ElevenLabs intake agent and one server tool to save the report. Wasp starts the browser session with a server-issued connection credential. Pass a demo session ID to the agent and its tool so the work order and updates land on the student's page. Keep the ElevenLabs API key on the server. The agent tells the student the report was saved after the tool succeeds.
- **Coordination.** Run the Wasp Node.js server on Maritime. Saving intake starts the staff request and a short progression of seeded Bluejay, QuickFix, and Metro results. Label contractor rows and the appointment as simulated. The server compares availability, known price, and scope and stores the Bluejay recommendation. The student page polls for staff and repair updates.
- **Approval and confirmation.** Show the $329 estimate and the $400 all-in cap as separate values. The manager approves from the dashboard. Enforce approval on the server before accepting the simulated confirmation. Publish the appointment with its arrival window after confirmation is saved. On denial, show the outcome and keep the appointment unconfirmed.
- **Operator dashboard.** Show the issue, staff card, three contractor rows, recommendation, approval, appointment, and a timestamped timeline. Staff can accept with an ETA, mark the clothes retrieved, or report that help is unavailable. If staff can't help, show that in the student update and refer retrieval to the manager. Poll about every two seconds and include a demo reset.

## Minimum data and API

Use Prisma and PostgreSQL for the demo session, work order, staff request, seeded contractor results, manager decision, appointment, and timeline. Keep staff and repair status separate. Repeated saves and actions must preserve a single result per step.

| Surface | Contract |
| --- | --- |
| Student page | Start a demo voice session and load the status of the work order associated with that session. |
| ElevenLabs intake tool | Wasp custom POST API validates the shared tool secret, demo session ID, location, washer number, symptoms, and reported error code. It saves the work order and returns its ID. |
| Operator dashboard | Load the active work order and timeline. Server actions update staff status, record manager approval or denial, record simulated confirmation, and reset the demo. Validate each transition on the server. |
| Maritime | Expose `GET /health` and the public Wasp intake endpoint for ElevenLabs. Configure the Postgres connection, ElevenLabs key, intake agent ID, and tool secret in the server environment. |

## Build order and rehearsal

1. **Wire up intake.** Tap **Talk to Relay** on a phone and say “It displays OE.” Verify the ticket and staff request appear on the dashboard.
2. **Close the workflow.** Add the three seeded results, student updates, staff actions, approval, and simulated confirmation. Verify that confirmation is blocked before approval.
3. **Rehearse and record.** Use a phone browser for the student and a laptop for the operator dashboard. Assign a student, a staff operator, and a manager. One teammate can play both dashboard roles. Rehearse the 15-minute staff time jump and record one backup run.

### Ready to show when

- [ ] The live browser conversation captures the right washer, the dry-floor report, and `OE`.
- [ ] Staff can accept with a 15-minute ETA and mark clothes retrieved while repair is pending. The student's page updates both times.
- [ ] The dashboard shows both seeded offers and Metro's voicemail, clearly labeled simulated, and explains the recommendation.
- [ ] The manager sees the $400 cap. The simulated confirmation only works after approval, and the student's arrival window appears after confirmation.
- [ ] Reset clears the demo and a fresh student session can run the same script again.


## Required observability: TraceRoot

TraceRoot is a required part of the demo, not a later optional add-on. Instrument the Node.js/Wasp server and the complete agent/tool workflow so a run can be inspected from voice-session creation through intake persistence, work-order orchestration, staff and contractor decisions, manager approval, simulated confirmation, and student updates.

- Use the TraceRoot TypeScript SDK in the server runtime. Initialize it once during server startup, before request handlers and workflow functions run. Use the TraceRoot CLI setup flow to generate the framework-appropriate instrumentation rather than guessing SDK APIs.
- Add explicit TraceRoot/OTel spans around Relay's own workflow boundaries: voice-session credential creation, authenticated ElevenLabs intake tool, work-order create/update, duplicate/idempotency handling, safety escalation, staff request/status changes, contractor-result ingestion, recommendation, manager approve/deny, confirmation guard, simulated appointment confirmation, student update, reset, and error/retry paths.
- Correlate spans with a non-sensitive demo session ID and work-order ID. Propagate trace context where the browser/tool transport supports it; otherwise attach the same correlation identifiers as safe span attributes. Record outcome, duration, simulation flag, and rejection/error category.
- TraceRoot does not automatically expose ElevenLabs' hosted model internals just because the browser SDK is connected. Instrument the server-visible tool calls and lifecycle events explicitly. Do not claim to have traced hidden provider reasoning or model tokens unless the provider actually exposes them.
- Keep the TraceRoot project API key server-side. Never put it in a `NEXT_PUBLIC_*` variable, browser bundle, HTML, client-side SDK config, or Git. Do not capture raw audio, full transcripts, phone numbers, student names, or credentials in trace attributes. Use synthetic demo data and redacted/minimal inputs.
- Trace export must be fail-open: TraceRoot downtime or export errors must not break intake, staff workflows, approval enforcement, or the demo. Application/database state remains the source of truth.
- Add a small Relay evaluation dataset and detectors for false intake-success claims, unsafe dispatch, duplicate work orders, approval bypass, misrepresented contractor scope, invented Metro availability/price, and incorrect student updates.

### TraceRoot acceptance gate

- [ ] A clean happy-path run produces a TraceRoot trace with the expected Relay workflow spans and a usable session/work-order correlation ID.
- [ ] A failed intake produces an error trace and Relay does not tell the student the report was saved.
- [ ] Duplicate intake is visible as an idempotent update, not a second work order.
- [ ] A safety hazard records escalation and does not continue the routine repair path.
- [ ] A confirmation attempt before manager approval records a rejected transition and creates no appointment.
- [ ] Manager denial leaves the appointment unconfirmed.
- [ ] TraceRoot outage does not break the user-facing workflow.
- [ ] At least the initial Relay golden cases run through TraceRoot evaluations, and the critical detectors can flag intentionally injected failures.

See [`docs/TRACEROOT.md`](docs/TRACEROOT.md) for setup, span design, data handling and verification.
