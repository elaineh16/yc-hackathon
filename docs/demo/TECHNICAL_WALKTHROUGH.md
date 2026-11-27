# Technical walkthrough: script and timing

The voiceover of `relay-technical-walkthrough.mp4`.

- **Length:** 04:49, 1920×1080, H.264/AAC. Rendered by Chrome's
  MediaRecorder from `app/e2e/demo/make-technical.mjs`.
- **Narration:** the Windows "Microsoft Mark" voice, generated locally. Captions: `captions/relay-technical-walkthrough.srt`
  (also burned into the video).
- **Contents:** slides built from the codebase and `docs/evidence` (`app/e2e/demo/technical.mjs`), and a screenshot
  of the real GitHub Actions run for this release. When a product recording exists, an excerpt of its real footage
  (the coordinator's recorded tool calls) is added after the agents slide; this render has none.
- **Sync:** audio and captions were measured with `av-sync-check.mjs` at two points, and agree within 0.1 s.

| Time | On screen | Narration |
| --- | --- | --- |
| 00:00 | Title | This is a technical walkthrough of Relay version one point one: how it is built, why the model reasons but the backend decides, and how it was tested. |
| 00:11 | Architecture (diagram) | Relay is a Wasp application: React and TypeScript in the browser, Node on the server, and Prisma over PostgreSQL. Every action is a server operation that checks who you are and what you may do, then hands over to the case engine. Background work runs as pg-boss jobs inside the same Postgres: the coordinator, chat replies, vendor discovery, and a deadline sweep every minute. The model is any OpenAI-compatible endpoint, here a small local one. Fiber AI, email, voice and tracing are optional, and the app works without them. |
| 00:47 | Case engine: one pattern for every write (code) | Every write follows one pattern. Lock the case row, check the transition against a shared state machine, and write the change, its event and any follow-ups in one transaction. Each status has an owner and a next action. Idempotency keys and partial unique indexes make retries and double clicks harmless. |
| 01:07 | Event-driven agents | The agents are event driven. When a transition matters, the same transaction writes a durable marker on the case, and after the commit a job is queued. The job claims that exact trigger once, runs a deterministic step first, then a bounded tool loop with the model, and clears the marker. Nothing runs between events. If a job is lost, the minute sweep finds the marker and queues it again. If a review fails, it is recorded and the manager is told. |
| 01:37 | Policy: the model reasons, the backend decides | The model reads and proposes. Code decides. Offers go only to vendors in the property's approved directory. Messages to residents must pass a grounding check and a manager. An escalation runs at once only if the deterministic safety rules agree. And no tool can approve money, schedule a visit, close a case, or contact a business. |
| 02:01 | Vendor discovery with Fiber AI | When a property has no approved vendor for a trade, the coordinator opens a discovery task. It sends Fiber only the trade and the city, checks the balance, a reserve and a daily budget, saves the paid response before processing, and keeps at most three businesses, each with reasons that cite only its listing. A manager must verify and approve a business before any work. No Fiber key was available, so no live call was made: discovery was tested on Fiber-shaped fixtures, through the real SDK. |
| 02:34 | Follow-ups and delivery states | Follow-ups are rows, one per person, event and channel. In-app is always on. Email is opt-in, sent after the commit, claimed without duplicates, and retried. Delivery states are honest: a local test inbox is captured, a real mail server only accepted. The minute sweep enforces deadlines with bounded reminders, and resolution always needs the resident. |
| 03:00 | Security review and observability | A security review found one high and eight medium issues, all fixed or documented, with regression tests. TraceRoot spans cover intake, transitions, agent runs, discovery, email and the sweep, with only ids, enums and counts. Export was verified in version one; the new spans were not re-verified. |
| 03:23 | AI evaluation, before and after | The AI evaluation uses ninety-nine intake and fourteen coordinator cases, plus two held-out sets written independently. On held-out phrasing, the rules alone now miss six of thirteen hard emergencies, down from eleven. Run live, with the model reading the same words, the whole system escalated 11 of those 13. Live, the intake agent cut missed escalations from three in ten to one, and invented facts from five cases to one, but its false escalations rose from one to five of twenty-four. In both versions, policy blocked every forbidden action the coordinator attempted. |
| 04:01 | Tests and CI | Thirty-four unit tests, eighty-five API tests over HTTP and sixteen browser tests in real Chrome run in GitHub Actions on every push, against PostgreSQL and Mailpit, along with the evaluation's safety gate. |
| 04:16 | The real GitHub Actions run (screenshot of the page) | And this is the actual GitHub Actions run for this release. |
| 04:22 | What is not done | What is not done: no live Fiber call, a small local model that over-escalates, rules that still miss indirect phrasing, and no real mail server, microphone test or deployment. Each is documented, with the next step. |
| 04:38 | End | The model reasons, the backend decides, and people approve. The code, the tests, the evaluation and the limits are on GitHub. |

## The architecture shown

- **Browser:** React 19 with TypeScript (Wasp). Resident and contractor portals are phone first; the manager's is for
  desktop.
- **Server:** Wasp on Node. Operations check identity and role; the REST API carries health and local-only test
  hooks; requests are rate limited.
- **Case engine:** each write is a row lock, a state machine check and one transaction holding the change, its event,
  the notifications and a durable AI marker.
- **Data:** PostgreSQL through Prisma, with pg-boss queues in the same database.
- **Jobs:** `coordinatorJob`, `intakeTurnJob` and `vendorDiscoveryJob`, plus a deadline sweep every minute.
- **External services, all optional:** an OpenAI-compatible model (Ollama locally), the Fiber AI SDK, SMTP (Mailpit
  locally), ElevenLabs voice and TraceRoot tracing.
