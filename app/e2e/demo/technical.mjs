// The technical walkthrough: slides (explanations built from the codebase and the measured results) and narration.
// Numbers here are the measured ones in docs/evidence; `results` is read from those files at render time.
import { page } from "./cards.mjs";

const brand = `<div class="brand"><div class="logo">R</div>Relay <span style="color:#6b7783;font-weight:500;margin-left:10px">technical walkthrough</span></div>`;
const foot = (s) => `<span>${s}</span><span class="mono">github.com/elaineh16/yc-hackathon</span>`;
const box = (title, body, tone = "") => `<div class="card" style="${tone}"><h3>${title}</h3><p>${body}</p></div>`;

export function technicalSlides(r) {
  return [
    {
      id: "t00",
      html: page(
        `${brand}<div style="margin-top:160px"><div class="eyebrow">Technical walkthrough · V1.1</div><h1 style="margin-top:22px">How Relay is built,<br/>and why the model never holds the keys</h1>
        <p class="lead" style="margin-top:36px">Architecture, the case engine, event-driven agents, policy, vendor discovery, follow-ups, security, evaluation and tests: all from the code and the measured results.</p></div>`,
        foot("Wasp · React · TypeScript · Node · Prisma · PostgreSQL · pg-boss"),
      ),
    },
    {
      id: "t01",
      html: page(
        `${brand}<h2 style="margin-top:44px">Architecture</h2>
        <svg width="1680" height="600" viewBox="0 0 1680 600" style="margin-top:30px;font-family:'IBM Plex Sans'">
          <defs><marker id="a" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#6b7783"/></marker></defs>
          <style>.b{fill:rgba(255,255,255,.05);stroke:#2f3b48;stroke-width:2;rx:16}.t{fill:#e9edf1;font-size:26px;font-weight:600}.s{fill:#9aa6b2;font-size:20px}.l{stroke:#6b7783;stroke-width:2.5;fill:none;marker-end:url(#a)}.o{fill:rgba(232,89,12,.08);stroke:#6b3a1c;stroke-width:2;rx:16}.i{fill:rgba(143,159,224,.08);stroke:#3a4a8c;stroke-width:2;rx:16}</style>
          <rect class="b" x="0" y="20" width="330" height="230"/><text class="t" x="24" y="64">Browser</text><text class="s" x="24" y="100">React 19 + TypeScript (Wasp)</text><text class="s" x="24" y="132">Resident · phone</text><text class="s" x="24" y="162">Manager · desktop</text><text class="s" x="24" y="192">Contractor · phone</text><text class="s" x="24" y="222">Voice: ElevenLabs agent</text>
          <path class="l" d="M330,135 L420,135"/>
          <rect class="b" x="420" y="20" width="420" height="230"/><text class="t" x="444" y="64">Wasp server (Node)</text><text class="s" x="444" y="100">Operations: who you are, what you may do</text><text class="s" x="444" y="132">Username auth · sessions</text><text class="s" x="444" y="162">REST: health, test hooks (local only)</text><text class="s" x="444" y="192">Rate limits · sign-in throttle</text>
          <path class="l" d="M630,250 L630,320"/>
          <rect class="o" x="420" y="320" width="420" height="250"/><text class="t" x="444" y="364">Case engine</text><text class="s" x="444" y="400">Row lock → state machine →</text><text class="s" x="444" y="428">one transaction: change, event,</text><text class="s" x="444" y="456">notifications, durable AI marker</text><text class="s" x="444" y="496">Policy gates every AI proposal</text><text class="s" x="444" y="528">Idempotency keys · partial indexes</text>
          <path class="l" d="M840,445 L930,445"/>
          <rect class="b" x="930" y="320" width="330" height="250"/><text class="t" x="954" y="364">PostgreSQL</text><text class="s" x="954" y="400">Prisma models: cases, events,</text><text class="s" x="954" y="428">offers, slots, notifications,</text><text class="s" x="954" y="456">discoveries, agent runs, proposals</text><text class="s" x="954" y="496">pg-boss queues live here too</text>
          <path class="l" d="M1095,320 L1095,250"/>
          <rect class="i" x="930" y="20" width="330" height="230"/><text class="t" x="954" y="64">Jobs (pg-boss)</text><text class="s" x="954" y="100">coordinatorJob</text><text class="s" x="954" y="132">intakeTurnJob</text><text class="s" x="954" y="162">vendorDiscoveryJob</text><text class="s" x="954" y="192">deadline sweep · every minute</text>
          <path class="l" d="M1260,80 L1350,80"/><path class="l" d="M1260,160 L1350,190"/><path class="l" d="M1260,230 L1350,300"/>
          <rect class="b" x="1350" y="20" width="330" height="110"/><text class="t" x="1374" y="62">LLM</text><text class="s" x="1374" y="98">OpenAI-compatible · Ollama 3B</text>
          <rect class="b" x="1350" y="150" width="330" height="100"/><text class="t" x="1374" y="190">Fiber AI SDK</text><text class="s" x="1374" y="224">googleMapsSearch2 · credits</text>
          <rect class="b" x="1350" y="270" width="330" height="100"/><text class="t" x="1374" y="310">SMTP</text><text class="s" x="1374" y="344">Mailpit locally · nodemailer</text>
          <rect class="b" x="1350" y="390" width="330" height="100"/><text class="t" x="1374" y="430">TraceRoot</text><text class="s" x="1374" y="464">spans: ids, enums, counts</text>
        </svg>`,
        foot("Optional services fail open: without a model, Fiber, SMTP or tracing, every manual path still works"),
      ),
    },
    {
      id: "t02",
      html: page(
        `${brand}<h2 style="margin-top:44px">One pattern for every write</h2>
        <div class="cols" style="grid-template-columns:1.25fr 1fr;margin-top:34px;align-items:start">
<pre><span class="c">// app/src/server/cases/engine.ts</span>
<span class="k">export function</span> withCase(caseId, fn) {
  <span class="k">return</span> prisma.$transaction(<span class="k">async</span> (tx) =>
    fn(tx, <span class="k">await</span> lockCase(tx, caseId)));   <span class="c">// SELECT … FOR UPDATE</span>
}

<span class="k">export async function</span> move(tx, c, action, actor, o) {
  to = assertTransition(action, c.status, actor.kind);
  own = ownership(to, …);        <span class="c">// holder + next action</span>
  eventId = <span class="k">await</span> addEvent(tx, c.id, actor, …);
  trigger = actor.kind === <span class="s">"AGENT"</span> ? undefined
          : COORDINATOR_TRIGGERS[action];
  <span class="k">await</span> tx.case.update({ status: to, holder, nextAction,
    …(trigger ? { agentPendingSince: now, agentPendingTrigger } : {}) });
}</pre>
          <div class="cols" style="gap:20px">
            ${box("Exactly once", "Row lock and one transaction per action. Idempotency keys make retries and double clicks harmless.")}
            ${box("Always an owner", "Every status has a holder and a next action, computed by the shared state machine (unit tested).")}
            ${box("Invariants in the database", "Partial unique indexes: one live offer per case, one confirmed visit per job, one active discovery per case and trade.")}
          </div>
        </div>`,
        foot("The AI is just another actor: the state machine gives it only ASSIGN_VENDOR and ESCALATE"),
      ),
    },
    {
      id: "t03",
      html: page(
        `${brand}<h2 style="margin-top:44px">Agents wake on events, and only on events</h2>
        <div class="cols" style="grid-template-columns:repeat(5,1fr);margin-top:40px;gap:18px">
          ${box("1 · A transition", "A resident files, a vendor declines, an offer expires. In the same transaction the engine writes a durable marker on the case.")}
          ${box("2 · After commit", "A coordinatorJob is queued. If that is lost, the minute sweep finds the marker and queues it again.")}
          ${box("3 · Claim once", "The job claims the exact (case, trigger, event) key. A duplicate or retried job does nothing.")}
          ${box("4 · Reason, bounded", "A deterministic step first (vendor coverage, discovery), then a tool loop with the model, step-limited.", "border-color:#3a4a8c")}
          ${box("5 · Stop", "Every tool call is recorded. The marker is cleared. Nothing runs until the next event. A failed run is reported to the manager.")}
        </div>
        <p class="lead" style="margin-top:44px">The model is never a long-running process: each event is one bounded, recorded review. Chat replies work the same way, one job per resident message, with a deadline per turn.</p>`,
        foot("app/src/server/agent/coordinator.ts · intake.ts · cases/sweep.ts"),
      ),
    },
    {
      id: "t04",
      html: page(
        `${brand}<h2 style="margin-top:44px">The model reasons. The backend decides.</h2>
        <table style="margin-top:34px">
          <tr><th>The AI proposes</th><th>What decides</th></tr>
          <tr><td>Offer the job to a vendor</td><td>Only refs from the property's approved directory. Sent automatically only for routine cases under autopilot; otherwise held for a manager</td></tr>
          <tr><td>Message the resident</td><td>Must pass a grounding check against what the resident may see, then always a manager</td></tr>
          <tr><td>Escalate</td><td>Runs at once only if the deterministic safety rules also see a hazard; otherwise a suggestion</td></tr>
          <tr><td>Search for local businesses</td><td>Only when no approved vendor can take the case; budgeted and cached</td></tr>
          <tr><td>Approve money, schedule, close, contact a business</td><td><b style="color:#e8590c">No tool exists.</b> People only</td></tr>
        </table>`,
        foot("Untrusted text (resident, vendor, business) reaches the model quoted as data, never as instructions"),
      ),
    },
    {
      id: "t05",
      html: page(
        `${brand}<h2 style="margin-top:44px">Vendor discovery with Fiber AI</h2>
        <div class="cols" style="grid-template-columns:repeat(4,1fr);margin-top:36px;gap:18px">
          ${box("No coverage", "The coordinator's deterministic step finds no approved vendor for the trade and opens a discovery task on the case.")}
          ${box("Budgeted search", "Only the trade and the city are sent. Balance, reserve and daily budget are checked first; the paid response is saved before processing.")}
          ${box("Checked, not trusted", "Each place: business? right trade? in the area? contact? already a vendor? Reasons cite only the listing. At most 3 kept, cached 14 days.")}
          ${box("A person approves", "Reject, shortlist, verify with a note, approve for the property. Only then can it be offered work. Relay never contacts it.", "border-color:#6b3a1c")}
        </div>
        <p class="lead" style="margin-top:44px">Verified honestly: no Fiber key was available, so <b style="color:#e9edf1">no live call was made and no credits were used</b>. The integration runs the real SDK path against Fiber-shaped fixtures of fictional businesses, including outages, exhausted credits and rate limits.</p>`,
        foot("app/src/server/vendors/fiber.ts · discovery.ts · scripts/fiber-live-check.ts (one capped live search, once a key is set)"),
      ),
    },
    {
      id: "t06",
      html: page(
        `${brand}<h2 style="margin-top:44px">Follow-ups, with honest delivery states</h2>
        <div class="cols" style="grid-template-columns:1fr 1fr;margin-top:34px;gap:24px">
          ${box("Rows, not fire-and-forget", "One notification per person, event and channel, with a dedupe key. In-app always; email opt-in, sent after the commit, claimed with SKIP LOCKED, retried after 1 and 5 minutes, capped per hour.")}
          ${box("What really happened", "DELIVERED in-app · CAPTURED by a local test inbox · ACCEPTED by a real SMTP server (mailbox not confirmed) · SKIPPED with the reason · FAILED after 3 attempts.")}
          ${box("Deadlines that act", "The minute sweep expires offers, sends bounded reminders, tells the manager once when reminders run out, and re-raises an unacknowledged emergency once.")}
          ${box("Resolution needs the resident", "Completion is not resolution: the resident confirms the fix, or says it is still broken and the case reopens with the coordinator awake.")}
        </div>`,
        foot("app/src/server/notify · cases/sweep.ts"),
      ),
    },
    {
      id: "t07",
      html: page(
        `${brand}<h2 style="margin-top:44px">Security review and observability</h2>
        <div class="cols" style="grid-template-columns:1fr 1fr;margin-top:34px;gap:24px">
          <div class="card"><h3>Review: 1 high, 8 medium, fixed or documented</h3><ul>
            <li>Shared vendors cannot be changed from one property</li><li>Staff-only notes never reach the resident's agent; codes are redacted however written</li>
            <li>Contractors see only their own work</li><li>Test hooks: local only, never in production</li><li>Rate limits and a sign-in throttle on paid paths</li><li>Failed AI turns retried; failed reviews reported</li></ul></div>
          <div class="card"><h3>Tracing (TraceRoot)</h3><ul>
            <li>Spans: intake, every transition, agent runs, discovery, email, the sweep</li><li>Attributes are ids, enums and counts: never text, keys or contact details</li>
            <li>Export verified against TraceRoot in V1; the V1.1 spans were not re-verified</li></ul></div>
        </div>`,
        foot("docs/security.md · app/src/server/tracing.ts"),
      ),
    },
    {
      id: "t08",
      html: page(
        `${brand}<h2 style="margin-top:44px">Evaluating the AI, before and after</h2>
        <p class="lead" style="margin-top:18px;font-size:28px">99 intake and 14 coordinator cases with expected and prohibited behaviour, plus two held-out sets written independently. Same code scores V1 and V1.1.</p>
        <table style="margin-top:26px">
          <tr><th>Measure</th><th class="n">V1</th><th class="n">V1.1</th></tr>
          <tr><td>Rules alone, held-out v2: hard emergencies missed</td><td class="n">11 / 13</td><td class="n">6 / 13</td></tr>
          <tr><td>Live intake agent: missed escalations</td><td class="n">3 / 10</td><td class="n">1 / 10</td></tr>
          <tr><td>Live intake agent: false escalations</td><td class="n">1 / 24</td><td class="n">5 / 24</td></tr>
          <tr><td>Live intake agent: cases with an invented fact</td><td class="n">5 / 34</td><td class="n">1 / 34</td></tr>
          <tr><td>Live coordinator: forbidden attempts that went through</td><td class="n">0 of 8</td><td class="n">0 of 8</td></tr>
          <tr><td>Live coordinator: false escalations executed</td><td class="n">1 / 13</td><td class="n">0 / 13</td></tr>
          ${r.heldoutLive ? `<tr><td>Whole system, live, held-out v2 emergencies escalated</td><td class="n">–</td><td class="n">${r.heldoutLive}</td></tr>` : ""}
        </table>`,
        foot("qwen2.5:3b on CPU · docs/ai-eval.md has every number, the method and the limits"),
      ),
    },
    {
      id: "t09",
      html: page(
        `${brand}<h2 style="margin-top:44px">Tests and continuous integration</h2>
        <div class="cols" style="grid-template-columns:repeat(3,1fr);margin-top:36px;gap:24px">
          <div class="card"><h3><span class="mono" style="color:#e8590c">34</span> unit</h3><p>State machine, safety rules, intake validation, approval and overlap rules, staff-only notes, the reply guard.</p></div>
          <div class="card"><h3><span class="mono" style="color:#e8590c">85</span> API over HTTP</h3><p>Journeys, authorization, races, deadlines, injected faults, discovery outages and exhausted credits, SMTP failures, every security finding.</p></div>
          <div class="card"><h3><span class="mono" style="color:#e8590c">16</span> browser</h3><p>Real Chrome, three users in separate sessions: existing vendor, missing vendor with discovery, ambiguity, follow-up and reopen, failures.</p></div>
        </div>
        <p class="lead" style="margin-top:44px">GitHub Actions runs the type-check, all of the above and the AI evaluation's safety gate against PostgreSQL and Mailpit on every push: <b style="color:#5fbf7a">green</b>.</p>`,
        foot("STATUS.md · docs/evidence · .github/workflows/ci.yml"),
      ),
    },
    {
      id: "t10",
      html: page(
        `${brand}<h2 style="margin-top:44px">What is not done</h2>
        <div class="cols" style="grid-template-columns:1fr 1fr;margin-top:34px;gap:24px">
          ${box("No live Fiber call", "No key was available. One command makes a capped live search once there is one.")}
          ${box("A small local model", "It over-escalates and rarely uses its reopen tools. Next: an emergency only the model sees becomes urgent with immediate review.")}
          ${box("Rules miss indirect phrasing", "Out of sample they still miss some hard emergencies; the model's reading and human review cover the rest, and that is measured.")}
          ${box("Not exercised", "A real SMTP server, a live microphone for voice, deployment. In-memory rate limits are per process.")}
        </div>`,
        foot("Every limitation is in STATUS.md and docs/ai-eval.md"),
      ),
    },
    {
      id: "t11",
      html: page(
        `${brand}<div style="margin-top:200px"><h1>The model reasons.<br/>The backend decides.<br/>People approve.</h1>
        <p class="lead" style="margin-top:40px">Code, tests, evaluation and limits: github.com/elaineh16/yc-hackathon</p></div>`,
        foot("Relay started at the YC Startups × ElevenLabs hackathon, November 2026"),
      ),
    },
  ];
}

export function technicalNarration(r) {
  return [
    { id: "t00", text: "This is a technical walkthrough of Relay version one point one: how it is built, why the model reasons but the backend decides, and how it was tested." },
    { id: "t01", text: "Relay is a Wasp application: React and TypeScript in the browser, Node on the server, and Prisma over PostgreSQL. | Every action is a server operation that checks who you are and what you may do, then hands over to the case engine. | Background work runs as pg-boss jobs inside the same Postgres: the coordinator, chat replies, vendor discovery, and a deadline sweep every minute. | The model is any OpenAI-compatible endpoint, here a small local one. Fiber AI, email, voice and tracing are optional, and the app works without them." },
    { id: "t02", text: "Every write follows one pattern. Lock the case row, check the transition against a shared state machine, and write the change, its event and any follow-ups in one transaction. | Each status has an owner and a next action. Idempotency keys and partial unique indexes make retries and double clicks harmless." },
    { id: "t03", text: "The agents are event driven. When a transition matters, the same transaction writes a durable marker on the case, and after the commit a job is queued. | The job claims that exact trigger once, runs a deterministic step first, then a bounded tool loop with the model, and clears the marker. | Nothing runs between events. If a job is lost, the minute sweep finds the marker and queues it again. If a review fails, it is recorded and the manager is told." },
    { id: "t04", text: "The model reads and proposes. Code decides. | Offers go only to vendors in the property's approved directory. Messages to residents must pass a grounding check and a manager. An escalation runs at once only if the deterministic safety rules agree. | And no tool can approve money, schedule a visit, close a case, or contact a business." },
    { id: "t05", text: "When a property has no approved vendor for a trade, the coordinator opens a discovery task. | It sends Fiber only the trade and the city, checks the balance, a reserve and a daily budget, saves the paid response before processing, and keeps at most three businesses, each with reasons that cite only its listing. | A manager must verify and approve a business before any work. No Fiber key was available, so no live call was made: discovery was tested on Fiber-shaped fixtures, through the real SDK." },
    { id: "t06", text: "Follow-ups are rows, one per person, event and channel. In-app is always on. Email is opt-in, sent after the commit, claimed without duplicates, and retried. | Delivery states are honest: a local test inbox is captured, a real mail server only accepted. | The minute sweep enforces deadlines with bounded reminders, and resolution always needs the resident." },
    { id: "t07", text: "A security review found one high and eight medium issues, all fixed or documented, with regression tests. | TraceRoot spans cover intake, transitions, agent runs, discovery, email and the sweep, with only ids, enums and counts. Export was verified in version one; the new spans were not re-verified." },
    { id: "t08", text: `The AI evaluation uses ninety-nine intake and fourteen coordinator cases, plus two held-out sets written independently. | On held-out phrasing, the rules alone now miss six of thirteen hard emergencies, down from eleven. ${r.heldoutLiveSentence ?? ""} | Live, the intake agent cut missed escalations from three in ten to one, and invented facts from five cases to one, but its false escalations rose from one to five of twenty-four. In both versions, policy blocked every forbidden action the coordinator attempted.` },
    { id: "t09", text: "Thirty-four unit tests, eighty-five API tests over HTTP and sixteen browser tests in real Chrome run in GitHub Actions on every push, against PostgreSQL and Mailpit, along with the evaluation's safety gate." },
    { id: "t10", text: "What is not done: no live Fiber call, a small local model that over-escalates, rules that still miss indirect phrasing, and no real mail server, microphone test or deployment. Each is documented, with the next step." },
    { id: "t11", text: "The model reasons, the backend decides, and people approve. The code, the tests, the evaluation and the limits are on GitHub." },
  ];
}
