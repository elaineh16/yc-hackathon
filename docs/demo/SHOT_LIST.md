# Shot list (product demo)

Every scene is real interaction with the running app, one browser session per person: desktop at 1536×864 rendered at
1.25x, phones at 390×844 at 2x. Model thinking time is cut and marked; nothing else is removed or changed.

**Status:** planned; not yet recorded (see DEMO_RUNBOOK.md).

| # | Scene | What happens | Real or labelled |
| --- | --- | --- | --- |
| 1 | Title card | Relay, what it is for. | Card (text, not app footage) |
| 2 | Resident, phone: chat intake | Priya types a leak report; Relay (local model) asks follow-up questions; the server files the case and confirms; she opens her case page. | Real app |
| 3 | Manager: command center and case workspace | "Your move" in the command center; the case: status, next action and reason, Relay's reading, "What Relay did" (recorded tool calls), the AI proposal and its policy note; the offer is sent. | Real app |
| 4 | Manager: vendor discovery (fixture data) | The discovery search and its candidates (labelled fixture data); a business is verified with a note, approved for the property, and offered the job. | Real app; discovery in fixture mode (fictional businesses), labelled |
| 5 | Contractor, phone: the offer | Sam enters a $320 estimate and accepts; it waits for the manager's approval. | Real app |
| 6 | Manager: money decision | The estimate is over the approval threshold; Morgan approves with a $350 cap. | Real app |
| 7 | Resident, phone: visit time | Priya picks a proposed time; the visit is confirmed. | Real app |
| 8 | Contractor, phone: the work | Sam starts the work, writes what he did and marks it complete. | Real app |
| 9 | Resident, phone: in-app follow-up | "Is it fixed?" and the notification in her inbox. | Real app |
| 10 | Local test inbox (Mailpit) | The follow-up email, captured by Mailpit (recorded by Relay as captured, not delivered). | Real Mailpit inbox (local test server) |
| 11 | Resident, phone: confirmation | "Yes, resolved"; the case shows Resolved. | Real app |
| 12 | Manager: audit trail | The case timeline labelled by who acted, and the follow-up log with each notification's delivery state. | Real app |
| 13 | Resident, phone: a vague report | A deliberately vague message and Relay's reply. | Real app |
| 14 | Another contractor, phone: authorization | Jo opens Sam's job by its address and gets "could not be found". | Real app |
| 15 | End card | What is real in V1.1, and the test evidence. | Card (text, not app footage) |

**Not in the video:**

- **Voice intake:** it needs a person speaking; the narration says the recording uses text.
- **A live Fiber search:** no key was available.
- **The background reports:** created through the API before recording. They are a dishwasher, an air conditioner
  at a property with no heating and cooling vendor, and a possible emergency.
