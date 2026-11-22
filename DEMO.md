# Relay — Demo Flow

**Concept.** A student talks to an AI facilities coordinator through their phone browser. Relay opens a work order, coordinates staff help, and shows the repair options and approved appointment.

**Setup.** Open the student page on a phone and the operator dashboard on a laptop. The student conversation is live. Teammates act as residence staff and manager in Wasp. Contractor responses and the appointment are labeled simulated.

## 1. Student talks to Relay

The student taps **Talk to Relay**, allows microphone access, and says:

> “The washing machine on my floor won't drain. My clothes are stuck inside.”

ElevenLabs answers. Relay asks only for missing information, up to three questions:

| Relay asks | Student replies |
|---|---|
| Which residence, laundry room, and machine? | “I'm in MKV. It's washer 2 in the main laundry room.” |
| Is water leaking onto the floor or staying inside the drum? | “It's all still inside the drum. The floor is dry.” |
| What error code do you see, if any? | “It displays OE.” |

Relay reads back the location, saves the work order, and requests help from the residence front desk. Show the new ticket and staff request on the laptop.

> **Relay:** “Please leave the door closed. I've asked residence staff to help. Check this page for their update.”

The student taps **End call** and keeps the page open.

## 2. Residence staff help while repair options come in

The staff stand-in accepts the request on the dashboard and enters a **15-minute ETA**. The student's page updates to **Staff on the way · 15 minutes**. Advance demo time and have staff mark **Clothes retrieved** while the repair is still pending. If staff can't help safely, the student's page shows that update and the manager takes over the retrieval request.

At the same time, the dashboard shows the three seeded contractor outcomes:

| Contractor | Simulated response |
|---|---|
| **Bluejay** | Available tomorrow. **$329 CAD** pre-tax drain-pump repair estimate, conditional on diagnosis. |
| **QuickFix** | Available today. **$99 CAD** for a diagnostic visit, with repair extra. |
| **Metro** | Voicemail. Availability and price are unknown. |

## 3. Relay recommends Bluejay

Relay compares availability, known cost, and scope. Bluejay has a next-day slot and a conditional repair estimate. QuickFix can come sooner for diagnosis. The student sees the recommendation and latest staff status on their page. Point out that staff can retrieve the clothes while the machine repair is still pending.

## 4. Manager approves and the demo shows confirmation

Bluejay's **$329 pre-tax estimate** exceeds the **$250 auto-approval threshold**. The manager approves **up to $400 CAD including taxes and fees**, conditional on diagnosis, from the dashboard.

Once approved, click **Simulate confirmation** to record Bluejay's seeded arrival window. Show the final appointment update on the student's phone and the approval and simulated confirmation in the dashboard timeline.

**Closing beat.** The student reported the washer by voice, got a staff ETA, and got their clothes back. The manager approved the repair, and the student can see when Bluejay is expected.
