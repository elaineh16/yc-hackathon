# Relay hackathon demo PRD

Build the single washer incident in [DEMO.md](DEMO.md). Use that script for dialogue and stand-in roles. The demo is complete when the student gets their clothes back with help from residence staff, and a contractor confirms a separate repair appointment after the manager approves the spend.

## What the judges see

| Beat | What Relay does | What appears on the dashboard |
| --- | --- | --- |
| 1. Student calls | The student reports a washer that won't drain with clothes stuck inside. Relay asks up to three questions for missing details, reads back MKV, the main laundry room and washer 2, and records that the floor is dry and the washer displays `OE`. | One work order with the location, machine, symptom and error code. Another report about the same open washer updates the existing order. |
| 2. Staff assist while contractors are dialed | Relay asks the front desk to send an authorized person to retrieve the clothes if it can be done safely. A staff stand-in accepts with a 15-minute ETA. Relay texts the student once staff accept. Staff mark the clothes retrieved when done. | Staff requested → accepted with ETA → clothes retrieved. The three contractor calls start without waiting for the staff response. |
| 3. Relay compares options | Bluejay offers tomorrow and a $329 CAD pre-tax repair estimate conditional on diagnosis. QuickFix offers a $99 CAD diagnostic today, with repair extra. Metro goes to voicemail. Relay recommends Bluejay for the non-emergency repair and calls the student back with the options and the latest staff status. | Three contractor rows with call outcomes, timing, price and scope. The recommendation explains that Bluejay offers a next-day slot and a repair estimate, while QuickFix offers an earlier diagnosis only. |
| 4. Manager approves | After the student callback, Relay asks the manager to approve a maximum of $400 CAD including taxes and fees, conditional on diagnosis. The $329 estimate exceeds the $250 auto-approval threshold. The manager approves from the dashboard. | Pending approval → approved, with the approved vendor, scope and cap. |
| 5. Contractor confirms | After approval, Relay calls Bluejay to confirm the appointment and captures the agreed arrival window. Relay texts the student once Bluejay confirms. | Confirming → confirmed with the arrival window. The staff and repair outcomes remain visible on the same work order. |

Treat `OE` as a reported drainage symptom. Bluejay's pump repair is conditional on diagnosis. During intake, Relay tells the student to leave the door closed and promises an update after staff respond. If the call reports a safety hazard, hand off to the designated human and stop the normal demo flow.

## Build

- **Voice.** Use ElevenLabs over Twilio for the student's inbound call, three outbound contractor calls, student callback and Bluejay confirmation call. Use one contractor agent for the quote calls and reuse it with confirmation context if practical. Capture quote details and confirmation through server tools. Use the signed post-call webhook to record call outcomes such as voicemail. Disclose AI and recording on calls.
- **Coordination.** Run the Wasp Node.js server on Maritime. Seed Bluejay, QuickFix and Metro with consenting stand-in numbers. Enforce a server-side outbound allowlist for calls and texts. Start the staff request and contractor fan-out from the saved work order. Advance the repair flow when the three calls resolve, with a bounded timeout so one missing result cannot stall the demo.
- **Decision and approval.** Use a small TypeScript rule for this scenario. Recommend the available repair estimate for the non-emergency case and show the diagnostic-only option with its limited scope. Show the $329 estimate and the $400 all-in cap as separate values. Only the manager's dashboard action can approve the request. Require approval for this scenario on the server before placing the booking call. Require a positive contractor confirmation before recording the appointment and sending the booked text. If approval is denied or Bluejay can't confirm, show the outcome and leave the appointment unconfirmed.
- **Dashboard.** Build one Wasp React work-order screen in `dashboard/`. Show the issue, staff card, three contractor rows, recommendation, approval, confirmed slot and a short timestamped timeline. Poll the snapshot about every two seconds. Give the staff stand-in controls to accept with an ETA, mark clothes retrieved, or report that help is unavailable. Use that staff card as the demo front-desk inbox. If staff can't help, update the student and route retrieval to the earliest available contractor through the manager, with any charge subject to approval.
- **Notifications.** Use Twilio SMS for the staff ETA and the confirmed appointment. Log send results in the timeline. If SMS delivery fails during the demo, show the actual failure and the message body on the dashboard.

## Minimum data and API

Use Prisma and PostgreSQL for an active work order, staff request, contractor call results, manager approval, appointment and timeline events. Keep staff and repair status separate. Save the provider conversation ID and work order ID on each call. Replayed tool calls or webhooks must not create duplicate results, approval requests, confirmation calls or texts.

| Surface | Contract |
| --- | --- |
| ElevenLabs tools | Wasp custom POST APIs to save intake, submit a contractor response, record the student's preference, and record Bluejay's confirmation. Pass work order and contractor IDs in call context. Validate requests and check the shared tool secret. |
| ElevenLabs webhook | `POST /webhooks/elevenlabs/post_call` verifies the signature and records terminal call outcomes. |
| Wasp dashboard | Load the active order and timeline. Expose server actions for staff status, manager approval or denial, and demo reset. Check state before accepting each action. Keep these actions out of the voice agents' tools. |
| Maritime | Expose `GET /health` and the public Wasp APIs for ElevenLabs. Configure the Postgres connection, provider keys, tool and webhook secrets, agent IDs and stand-in allowlist in the server environment. |

## Build order and rehearsal

1. **Connect the dashboard first.** Seed stand-in contractors, run a work order through the two lanes with sample events, and verify the approval and confirmation checks. Add a reset for the rehearsal work order.
2. **Run one real intake.** Get the Twilio number and public Maritime endpoints working. Read back the washer location and show the ticket and staff request on screen.
3. **Close the loop on test phones.** Run the three vendor calls, record both offers and Metro's voicemail, call the student back, click manager approval, confirm with Bluejay and deliver the texts.
4. **Rehearse and record.** Assign a student, staff operator, manager, Bluejay, QuickFix and Metro voicemail. Teammates can double up where calls don't overlap. Use a demo label and consenting stand-ins. Save one full backup recording once the live loop works.

### Ready to show when

- [ ] A single call creates or updates the washer ticket with `OE`, the correct location and the dry-floor report.
- [ ] Staff accept with a 15-minute ETA, the student gets that update, and the dashboard can show clothes retrieved while repair is still pending. In the rehearsal, advance the staff action as a demo time jump.
- [ ] Three approved stand-in numbers ring. The two offers and Metro voicemail appear, and the callback accurately explains the recommendation and latest staff status.
- [ ] The student callback cannot advance booking. The manager sees the $400 cap, and the Bluejay confirmation call starts only after approval.
- [ ] A confirmed arrival window and the booked text appear only after Bluejay confirms.
- [ ] Reset clears the demo work order, and the team can run the same script again.
