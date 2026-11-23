# Product demo: script (planned, not yet recorded)

The product demo has not been recorded yet. Recording needs the full stack, the local model and about 30 minutes of
CPU (see [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md)). This is the narration it will use, scene by scene.

- **Exact timings:** this file is rewritten with them by `write-docs.mjs` after recording.
- **Sentences that follow the model:** where the model's behaviour can vary (whether the coordinator proposes a
  vendor, how Relay answers the vague report), `narration.mjs` chooses the sentence from what the recording shows.
  The wording below assumes the coordinator proposes a vendor and the vague report gets a question.

| # | Scene | Narration |
| --- | --- | --- |
| 1 | Title card | Property managers get repair requests by phone, text and email. Then they spend hours sorting them, finding the right contractor, getting approvals and chasing updates. Relay is an AI operations coordinator for residential buildings. It turns each request into a tracked case, and coordinates it to a verified fix, with people in control of every decision that matters. |
| 2 | Resident, phone: chat intake | This is the real resident portal, on a phone. Priya reports a leak in her own words, using the text chat. Voice uses the same path, but this recording uses text. Her message is saved at once, and Relay replies from a background job running a local model. The model's thinking time is cut from the recording, and marked. It asks what it needs. When it files, the server saves the case and writes the confirmation, not the model. |
| 3 | Manager: command center and case workspace | Morgan, the property manager, starts in the command center: what needs a person, and why. On the case, Relay's reading keeps what Priya said apart from what it assumed, and the status, the next step and its reason are always explicit. "What Relay did" lists the coordinator's actual tool calls, as recorded. Here it proposed an approved plumber. Autopilot is off at this property, so the offer waited for Morgan, and she sends it. The model proposes. The backend decides. |
| 4 | Manager: vendor discovery (fixture data) | This air-conditioning case has no approved contractor at Maple Court, so Relay started a vendor search. Discovery runs on Fiber AI. In this recording it is in fixture mode, with fictional businesses returned through the real SDK code path, because no Fiber key was available. Each business is only a candidate. Morgan verifies it and approves it for this property, and only then can it be offered work. Relay never contacts it on its own. |
| 5 | Contractor, phone: the offer | Sam, the plumber, gets the offer on his phone. He accepts with an estimate of three hundred and twenty dollars, and proposes visit times. |
| 6 | Manager: money decision | That is over the property's approval threshold, so the money decision goes to Morgan, never to the AI. She approves it, with a cap. |
| 7 | Resident, phone: visit time | Priya picks a time. The visit is confirmed only once everyone required has agreed. |
| 8 | Contractor, phone: the work | Sam starts the work and reports it complete. The same case, the same record, for all three people. |
| 9 | Resident, phone: in-app follow-up | Completion is not resolution. Priya gets an in-app notification asking whether it's fixed. |
| 10 | Local test inbox (Mailpit) | And an email. Here it is in the local test inbox, which Relay records as captured, never as delivered. |
| 11 | Resident, phone: confirmation | She confirms it's resolved. |
| 12 | Manager: audit trail | The timeline records every step, labelled by who did it: the resident, Relay's AI, the system, the manager or the vendor. The follow-up log shows each notification's real delivery state. |
| 13 | Resident, phone: a vague report | When a report is too vague, Relay asks a question instead of guessing. |
| 14 | Another contractor, phone: authorization | And the backend decides who sees what. Another plumber opening a job that isn't his gets nothing. |
| 15 | End card | Relay version one point one: intake by chat, voice or form; a coordinator that proposes while policy decides; vendor discovery that never skips human verification; follow-ups that report delivery honestly; and a complete audit trail. It ships with thirty-four unit tests, eighty-five API tests and sixteen browser tests running in continuous integration, and an AI evaluation with held-out sets, before and after. The code, the evidence and the limitations are on GitHub. |
