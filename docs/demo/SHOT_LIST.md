# Shot list (product demo)

Every scene is real interaction with the running app, one browser session per person: desktop at 1536×864 rendered at
1.25x (1920×1080 frames), phones at 390×844 at 2x. Model thinking time is cut and marked; nothing else is removed or
changed.

| # | Scene | What happens | Real or labelled |
| --- | --- | --- | --- |
| 1 | Manager: the command center | The title over the real command center: what needs a person, and why. | Real app |
| 2 | Resident, phone: chat intake | Priya reports a leak; Relay (the local model) asks follow-up questions; the server files the case and confirms it. | Real app |
| 3 | Manager: the case workspace | "Your move"; the case: next action, Relay's reading (what was said and what was assumed), "What Relay did" (the recorded tool calls), the AI proposal with its policy note; the manager sends the offer. | Real app |
| 4 | Manager: live Fiber AI vendor discovery | An AC case at a building with no approved HVAC contractor: the coverage gap, the manager approves one search, real businesses come back with Relay's checks and the provider's chargeInfo; one is shortlisted, none verified or contacted. | Real app; a live Fiber AI search returning real businesses |
| 5 | Contractor, phone: the offer | The contractor reads the request, enters a $320 estimate and two visit times, and accepts; it waits for the manager's approval. | Real app |
| 6 | Manager: the money decision | The estimate is over the approval threshold; the manager approves it with a $350 cap; the next step moves to the resident. | Real app |
| 7 | Resident, phone: the visit time | Priya picks one of the proposed times; the visit is confirmed. | Real app |
| 8 | Contractor, phone: the work | The contractor starts the work, writes what was done and marks it complete. | Real app |
| 9 | Resident, phone: "Is it fixed?" | Completion is not resolution: the case asks Priya, and the in-app notification is in the inbox. | Real app |
| 10 | Local test inbox (Mailpit) | The same follow-up by email, captured by Mailpit (recorded by Relay as captured, never as delivered). | Real Mailpit inbox (local test server) |
| 11 | Resident, phone: confirmation | "Yes, resolved"; the case shows Resolved. | Real app |
| 12 | Another resident, phone: not fixed | Daniel's dishwasher was repaired (set up through the API) but stopped again: "No, still having problems" reopens the case. | Real app; the repair before it was set up through the API |
| 13 | Resident, phone: an unclear request | A deliberately vague message and Relay's reply. | Real app |
| 14 | Manager: a possible emergency and a lockout | "Needs attention" in the command center; the escalated water-near-a-light case and the lockout waiting for an identity check. | Real app |
| 15 | Another contractor, phone: authorization | A contractor from another firm opens the job's address and gets "This job is not available". | Real app |
| 16 | Manager: the record of the case | The resolved case: its history labelled by who acted, and the follow-up log with each notification's delivery state. | Real app |
| 17 | Closing card | "Relay. From resident request to accountable resolution." and the repository. | Card (text, not app footage) |

**Set up before recording, through the API (not shown):** a dishwasher (repaired by the appliance contractor, so it
can be reported as not fixed on camera), water dripping from a bathroom light fixture (a possible emergency), and a
lockout. Maple Court was set to ask a manager before any vendor search.

**Not in the video:** voice intake (it needs a person speaking; the narration says the chat is text), onboarding a
discovered business (it needs a manager's own check of a real business, which was not done), and a real email
delivery (only the local test inbox).
