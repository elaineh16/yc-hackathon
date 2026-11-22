# Relay — Demo Flow

**Concept:** An AI facilities coworker that takes a resident's maintenance call, finds contractors, compares responses, and coordinates an approved booking.

**Setting:** Fictional student residence in Waterloo. All contractors, quotes, and bookings are simulated using consenting stand-ins.

## 1. Student calls Relay

A student dials the Twilio number:

> “The washing machine on my floor won't drain. My clothes are stuck inside.”

ElevenLabs answers. Relay asks only for missing information (maximum three clarifying questions):

| Relay asks | Student replies |
|---|---|
| Which residence, laundry room, and machine? | “I'm in MKV. It's washer 2 in the main laundry room.” |
| Is water leaking onto the floor or staying inside the drum? | “It's all still inside the drum. The floor is dry.” |
| What error code do you see, if any? | “It displays OE.” |

Relay confirms the details, checks for an existing report, and opens or updates the work order. **Dashboard:** new/updated ticket appears. Safety hazards go to a human immediately.

Once Relay knows which washer it is, it pages the residence front desk. It asks for an authorized staff member to meet the student at washer 2 and retrieve the clothes if they can do so safely. Contractor outreach starts in parallel.

> **Relay:** “Please leave the door closed. I've asked residence staff to meet you at the washer. I'll text you when they confirm.”

For the demo, a staff stand-in accepts and gives a 15-minute ETA. Relay texts the student, and staff mark the clothes retrieved once they've helped. If staff are unavailable or can't open the washer safely, Relay updates the student and asks the contractor to handle retrieval at the earliest available visit.

## 2. Relay contacts contractors

The Maritime coordination agent finds approved test contractors and triggers three ElevenLabs/Twilio calls:

| Contractor | Response during demo |
|---|---|
| **Bluejay** | Available tomorrow; **$329 CAD** conditional drain-pump repair estimate, subject to diagnosis |
| **QuickFix** | Available today; **$99 diagnostic visit only**, repair extra |
| **Metro** | Voicemail; no confirmed availability or price |

**Dashboard:** contractor responses appear as calls finish. The `OE` error indicates a drainage issue, not a confirmed failed pump.

## 3. Relay recommends an option

Relay compares **availability, total known cost, and scope**. It recommends Bluejay for a non-emergency because it offers a next-day slot and a conditional repair estimate; QuickFix is faster but only quotes diagnosis.

Relay calls the student back with the repair options and the latest staff update. The student can express a preference, but **cannot authorize building spending**.

## 4. Manager approves; Relay books

Bluejay's **$329 pre-tax estimate exceeds the $250 auto-approval threshold**. Relay asks the residence manager to approve a **maximum $400 CAD including taxes and fees**, conditional on diagnosis.

The manager approves in the dashboard. Relay confirms the appointment with the stand-in contractor, records the confirmed time, and notifies the student.

**Final dashboard:** staff assistance → clothes retrieved. Repair → contractor options → manager approval → confirmed appointment. Do not call a booking confirmed until the contractor actually confirms it.

## What the judges should see

**One student phone call starts a complete multi-party workflow.** ElevenLabs handles natural conversation; Maritime coordinates contractor outreach; the dashboard shows real state changes and the required human approval.

**Stranger bonus:** Ask an actual student outside the hackathon to call the test number, describe an issue naturally, and give feedback. Disclose that this is a prototype, not the university's real maintenance service.
