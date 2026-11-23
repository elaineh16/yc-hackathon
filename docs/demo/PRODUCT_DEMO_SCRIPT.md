# Product demo: script and timing

"Relay: from request to resolution", the voiceover of `relay-product-demo.mp4`.

- **Length:** 05:26, 1920×1080, H.264/AAC, rendered by Chrome's MediaRecorder from
  `app/e2e/demo/make-product.mjs`. 98% of it is footage of the running app; the rest is the closing card.
- **Narration:** Kokoro-82M "af_heart" (open weights, Apache-2.0), run locally on the CPU. Captions: `captions/relay-product-demo.srt` and `.vtt` (also burned into the video).
- **Footage:** recorded from the running app by `app/e2e/demo/capture-product.mjs`, plus the vendor discovery scene from
  `capture-fiber.mjs`, which was the live Fiber AI integration check.
- **Edits:** 5 cuts of model thinking time, 306 seconds in all, each marked on screen. Long
  stretches play at most 1.6 times faster. Nothing else is removed or changed.

**What happened in this recording**

- **The chat:** Priya: "Hi, water is leaking under my kitchen sink." Relay: "I see water is leaking under your kitchen sink. Is this happening right now?" Priya: "Yes, it's still dripping slowly into the cabinet. It's a steady drip from the pipe under the sink into the cabinet, with a small puddle. I closed the valve, but it still drips a little." Relay: "Got it, the drip is still happening. Is anyone in the apartment right now?" Priya: "No, everyone's fine. It's just the leak." Relay: "Got it. Is there anything dangerous, like a gas smell or smoke?" Priya: "That's everything I know. Please file it now." Relay: "Your report is saved as RLY-0403. The property manager has been notified and Relay is lining up a vendor. You can follow progress on this page."
- **The coordinator** proposed Harbour Plumbing & Drain, an approved plumber. It waited for the manager, who sent it.
- **Fiber AI:** a live search, approved by the manager in the interface: 20 places, 3 kept, 2 credits (chargeInfo `{"method":"charged-now","creditsCharged":2}`). Dunn Heating and Air Conditioning was shortlisted; nothing was verified, contacted or approved.
- **Not fixed:** after "No, still having problems", the dishwasher case is REOPENED.
- **The unclear request** was answered with a question: "I see you noticed something is wrong since yesterday. Can you tell me more about what you're hearing or feeling? Is it a dripping sound or something else?". This scene was recorded twice. In take 1, not shown, the model added a room the resident never mentioned ("your living room"): "Something is wrong in your living room. Can you tell me more about what you noticed?".
- **A second AI proposal:** the coordinator also suggested escalating the leak. The safety rules found no hazard, so it stayed a suggestion for the manager, and it is visible in the case workspace scene.
- **Safety:** the possible emergency is ESCALATED, and the lockout is TRIAGED.
- **Email on the leak case, as Relay recorded it:** 6 CAPTURED, 2 SKIPPED, 4 FAILED. The local Mailpit server's port forwarding broke during the recording (a Docker port proxy left stale by an earlier WSL restart). Emails sent in that window were retried and then marked failed, and none were shown as delivered. Mailpit was restarted, and the pending ones, including "Is this fixed?", were captured.

| Time | On screen | Narration |
| --- | --- | --- |
| 00:00 | Manager: the command center | Residents report problems. Property managers coordinate staff, contractors, approvals and follow-ups. Relay brings that process into one AI-powered workflow. This is the manager's command center: what needs a person, and why. |
| 00:19 | Resident, phone: chat intake | Priya, a resident, reports a leak from a phone, in plain words. This is the text chat. Voice intake uses the same path, but it isn't shown here. Relay's replies come from a local language model, running as a background job. Its thinking time is cut from the recording, and marked. It asks what it needs, then files. The case is saved by the server, and the confirmation comes from the database, not from the model. |
| 00:56 | Manager: the case workspace | Morgan, the property manager, sees Priya's new case at the top of the queue, and opens it. The case workspace shows what Priya reported, and what Relay understood from it, with its assumptions kept apart from what Priya actually said. "What Relay did" lists the coordinator's real tool calls, and what policy did with each one. It also suggested escalating. The safety rules found no hazard in Priya's words, so that stays a suggestion for Morgan to decide. Relay proposed Harbour Plumbing & Drain, an approved plumber. Autopilot is off at this property, so the offer waits for Morgan, who reviews it and sends it. |
| 01:41 | Manager: live Fiber AI vendor discovery | Separately, an air-conditioning report came in from the same building, where no heating and cooling contractor is approved. Relay spots the gap. At this building it asks before spending anything, so Morgan approves one search. This is a live call to Fiber AI. Twenty real local businesses came back, Relay kept the best three, and the provider's charge, two credits, is recorded exactly as returned. Discovery is not approval. Nobody has checked a licence or insurance, and Relay never contacts these businesses. Morgan only shortlists one, to check personally. |
| 02:25 | Contractor, phone: the offer | Back to the leak. Jo, from Harbour Plumbing & Drain, a fictional test contractor, gets the offer by phone. Jo reads the request, accepts the job with an estimate of three hundred and twenty dollars, and proposes two visit times. |
| 02:45 | Manager: the money decision | Three hundred and twenty dollars is over this building's approval threshold, so the money decision goes to Morgan, never to the AI. Morgan approves it, with a cap of three hundred and fifty dollars. The next step now belongs to Priya. |
| 03:05 | Resident, phone: the visit time | Priya sees the proposed times, and picks one. The visit is confirmed. |
| 03:15 | Contractor, phone: the work | Jo starts the work, and reports exactly what was done. |
| 03:24 | Resident, phone: "Is it fixed?" | But finished work isn't the same as a solved problem. Relay asks Priya whether it's really fixed, in the app, |
| 03:35 | Local test inbox (Mailpit) | and by email. This is Mailpit, a local test inbox. Relay records this email as captured by a test server, never as delivered. |
| 03:46 | Resident, phone: confirmation | Priya confirms it's fixed, and the case is resolved. |
| 03:54 | Another resident, phone: not fixed | A repair that doesn't hold is handled too. Daniel's dishwasher was repaired, but it stopped again. Daniel says so, and the case reopens for Morgan to follow up. |
| 04:09 | Resident, phone: an unclear request | When a request is unclear, Relay asks what is going on, instead of guessing a diagnosis. |
| 04:20 | Manager: a possible emergency and a lockout | Possible emergencies and lockouts always go to a person. Water near a light fixture is escalated at once, and a lockout waits for staff to check identity. The safety rules are a net, not a guarantee. In a held-out test, the system escalated eleven of thirteen emergencies, which is why anything uncertain goes to a person. |
| 04:44 | Another contractor, phone: authorization | And access is enforced by the server: Sam, from another firm, can't open this job. |
| 04:54 | Manager: the record of the case | Back in Morgan's workspace: one report, one coordinated workflow, three people acting on the same case, every step recorded, a follow-up, and a verified outcome. The follow-up log shows each message's real delivery state. The local test mail server was briefly unreachable during this recording, so some emails are marked failed, not delivered. |
| 05:19 | Closing card | Relay. From resident request to accountable resolution. |
