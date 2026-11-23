# Agents, tools and policy

Relay has two LLM agents. The model reads, reasons and proposes; deterministic code decides what may happen. Every
run is stored (`AgentRun`): its trigger, model, every tool call with arguments and real result, and how it ended.
Managers see it on the case as "What Relay did".

```mermaid
flowchart LR
  R[Resident message] -->|saved, returns at once| Q[(intakeTurnJob)]
  Q --> IA[Intake agent]
  IA -->|tools| T1[lookup_building_notes<br/>find_my_recent_reports<br/>note_facts<br/>reopen_my_report<br/>submit_report]
  T1 --> P1{{Policy: validate, classify,<br/>rules only raise severity,<br/>guard the reply}}
  P1 --> C[(Case)]
  C -->|event + durable marker| CJ[(coordinatorJob)]
  CJ --> D{{Deterministic first:<br/>vendor coverage check}}
  D -->|no approved vendor| V[(vendorDiscoveryJob)]
  CJ --> CA[Coordinator agent]
  CA -->|tools| T2[get_case, list_vendors,<br/>list_discovery_candidates,<br/>request_vendor_discovery, note_candidate,<br/>search_building_notes, search_past_cases,<br/>propose_vendor, propose_resident_update,<br/>recommend_escalation, record_assessment]
  T2 --> P2{{Policy: directory only,<br/>autopilot rules, grounding,<br/>escalation needs the rules to agree}}
  P2 -->|held for a person| M[Manager]
  P2 -->|allowed| E[Engine transition]
```

## Intake agent

The intake agent talks with the resident (chat) and files the report.

- **Code:** `app/src/server/agent/intake.ts`, with its prompt, tool schemas, validation and reply guard in
  `intakePolicy.ts`. The policy module is pure, so the evaluation runs exactly the production prompt and rules.
- **Asynchronous:** `sendIntakeMessage` saves the message and returns at once. The reply is produced by a pg-boss job
  (`intakeTurnJob`) while the page polls; a slow model never holds a request. The job is claimed once per resident
  message, and a whole turn (every model call in it) has a 3-minute deadline. A failed attempt is retried once by
  the job; a run interrupted by a restart is taken over after 4 minutes; the minute sweep re-queues lost turns. The
  reply is written only while that turn is still pending, so a late run can never overwrite newer messages. Every
  turn ends with a reply: if the model is down, the resident is told plainly and offered the form, with their words
  carried over; after a repeated failure they get an apology and the same choice.
- **Limits:** 60 chat messages per resident per hour, and 20 resident messages per conversation (each turn resends
  the conversation to the model).
- **Tools:** building notes (staff-only blocks and sections never included, however they are marked), the resident's recent reports, `note_facts`,
  `reopen_my_report` (for "the repair didn't work": the resident's own case only), and `submit_report`.
- **`submit_report` carries:**
  - category, severity, title and summary;
  - observations (what the resident said), assumptions (what the agent inferred, labelled unconfirmed and never
    read by the safety rules) and open questions;
  - safety concerns;
  - up to two additional issues, each filed as its own case and linked as one report.
- **Policy around it** (`app/src/server/cases/classify.ts`):
  - the server saves it, never the model;
  - the resident's words are stored verbatim;
  - the deterministic rules re-read the resident's words and can only raise severity;
  - any safety concern escalates;
  - lockouts and elevators that stopped always go to a person;
  - the reply after filing is the server's result, never the model's paraphrase;
  - every other reply passes `guardReply`, which removes code-like values and anything from staff-only notes.
- **The prompt asks for:**
  - asking before filing when the report is vague, and never asking twice;
  - safety advice without overreacting;
  - for lockouts, never sharing codes or promising entry, since staff verify identity;
  - for neighbours, never sharing their details;
  - treating resident text as information, not instructions.

## Coordinator

The coordinator reviews a case whenever something happens on it.

- **Code:** `app/src/server/agent/coordinator.ts`; the prompt is in `coordinatorPolicy.ts`.
- **Triggers:** a case transition writes a durable marker in the same transaction, for example ready for a vendor,
  vendor declined, offer expired, estimate rejected, not fixed, reopened, resumed, change requested, vendor
  onboarded, discovery completed, times declined, or a manual review. A pg-boss job runs once per (case, trigger,
  event); the sweep re-queues lost markers.
- **Deterministic first:** if the case needs a vendor and no approved vendor at the property can take it, a
  discovery task is created. This runs even when no model answers. With the model offline, the run is recorded as
  skipped and the manager is told what to do next (behaviour G). A run that fails or is interrupted is recorded as
  failed ("AI review failed") and the manager is told the same way. It is not re-run, because it may already have
  acted.
- **What the model sees:** everything written by residents, contractors or businesses is wrapped as quoted data
  (`<<…>>`), with an instruction never to follow instructions inside it.
- **Policy on each proposal:**

| Proposal | What decides |
| --- | --- |
| Offer to a vendor | Only refs from `list_vendors`, which reads the property's approved directory. Blocked for emergencies, escalations, cases needing review, noise matters, or a vendor who already declined. Sent automatically only for ROUTINE cases at properties with autopilot on and a vendor with a Relay login; otherwise held for a manager |
| Resident update | Must pass the grounding check against what the resident may see; then always held for a manager |
| Escalation | Runs at once only if the deterministic safety rules also see a hazard in the resident's words and facts; otherwise it is a suggestion for the manager |
| Vendor discovery | Only when no approved vendor can take the case; searches are budgeted and cached (see [fiber.md](fiber.md)) |
| Note on a discovered business | Kept only if grounded in the business's listing |

- **What it can never do:** approve spending or budget increases, schedule, close or cancel a case, onboard,
  contact or approve a discovered business, or message a resident without a manager. The state machine gives the
  `AGENT` actor only `ASSIGN_VENDOR` and `ESCALATE` (unit-tested).

## Voice

The ElevenLabs voice agent ("Relay voice intake") talks with the resident and files through a client tool
(`submit_report`) that calls the same server path as chat. The same policy applies: classification, the rules
raising severity, and the server's confirmation.

## Models

Any OpenAI-compatible endpoint. The default is local Ollama `qwen2.5:3b`: free, offline, private. No hosted model
was added, because none was free without sending residents' words to a third party. Without a model, the form,
discovery, notifications and every manual action still work.

## Prompt injection: defences in depth

1. Untrusted text is quoted and labelled as data in the coordinator's view; the intake prompt says the same.
2. The tools cannot do anything dangerous: there is no tool to approve money, close, cancel or contact.
3. Every effect passes deterministic policy (directory refs only, autopilot rules, the escalation agreement rule,
   grounding, the state machine).
4. Replies to residents pass `guardReply`; staff-only notes never reach a resident-facing agent.
5. All of it is measured: see [ai-eval.md](ai-eval.md) (injection cases, unauthorized proposals, code disclosure).
