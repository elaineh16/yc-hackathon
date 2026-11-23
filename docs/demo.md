# Demo walkthrough (about 6 minutes)

## Before you start

1. Start everything as in the [README](../README.md): Postgres, `wasp start`, Mailpit on :8025, and optionally
   Ollama.
2. For a populated workspace, run `npx tsx scripts/demo-data.ts` from `app/` (it resets cases). For a live story,
   start from an empty one instead.
3. Open three browser windows:
   - `priya` (resident), at phone width;
   - `morgan` (manager);
   - `jo` or `ana` (contractor), at phone width.

   The password for all of them is `relay-demo-2026`. Also open Mailpit at http://localhost:8025.

## The story

**1. The point (20 s).** Every case has a state, an owner, a next action and a traceable outcome. The AI reads and
proposes; deterministic code decides what can happen.

**2. A resident reports (60 s).** As `priya`: Report a problem, then Chat with Relay. Type "the AC in my living room
is blowing warm air". Point out:

- the message is saved at once and Relay replies from a background job;
- it asks before filing, then files.

No model running? Use the form, which works without AI. Show the in-app "Report received" and the captured email in
Mailpit, which Relay records as captured, not delivered.

**3. The manager's command center (45 s).** As `morgan`, point out:

- the numbers are counted from the database;
- "Your move" lists what needs a person and why;
- the vendor discovery queue;
- Relay AI workflows show what each review did;
- overdue acknowledgements.

**4. A missing vendor, found and onboarded (90 s).** Open the AC case. Maple Court has no approved heating and
cooling vendor, so discovery ran. Show:

- the exact query ("heating and cooling contractor" near "Waterloo, ON"), with no resident data;
- places returned and kept, credits and `chargeInfo`, and what was filtered and why;
- each business: rating, distance, contact details, and what nobody has confirmed (licence, insurance, availability);
- the duplicate flagged as already in Relay.

Mark one verified with a note, approve it for this property, then send the offer. Discovery never authorized anything:
a person did.

**5. Money stays with people (45 s).** Open the case where the contractor asked for $350 more. Only the manager can
decide; the AI's proposals show the policy note for each. Approve, and the cap rises.

**6. Follow-up and the resident's word (45 s).** As the resident, open a completed job and answer "No, still having
problems". The case reopens, the manager is told, and the coordinator wakes. Show the follow-ups panel: each
notification per person and channel, with its real state (in inbox, acknowledged, captured, not sent with the
reason).

**7. Safety (30 s).** As the resident, report "I smell gas near the stove" with the form. It is escalated with advice
to leave and call from outside, and routine dispatch is blocked.

**8. Evidence (30 s).** Close with:

- [ai-eval.md](ai-eval.md): 99 + 14 cases, held out, before and after, live-model numbers;
- [STATUS.md](../STATUS.md): every suite and its result.
