// Writes docs/demo from the actual render timelines: timestamped scripts, the shot list, metadata, captions, and
// screenshots taken from the real captured frames. Without a product recording yet, the product script and shot list
// are written as planned (narration and scenes, no timings) and say so.
// Usage (from app/e2e): node demo/write-docs.mjs <techWorkDir> <techMp4> [<productWorkDir> <productMp4>] [--release <url>]
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { productNarration, productScenes } from "./narration.mjs";

const args = process.argv.slice(2);
const ri = args.indexOf("--release");
const releaseUrl = ri >= 0 ? args.splice(ri, 2)[1] : null;
const [techWork, techMp4, work, productMp4] = args;
const here = dirname(fileURLToPath(import.meta.url));
const docs = join(here, "..", "..", "..", "docs", "demo");
mkdirSync(join(docs, "captions"), { recursive: true });
const readIn = (dir, p) => JSON.parse(readFileSync(join(dir, p), "utf-8").replace(/^﻿/, ""));
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const sizeMb = (p) => (p && existsSync(p) ? Math.round(statSync(p).size / 1e5) / 10 : null);
const sidecar = (p) => (p && existsSync(`${p}.json`) ? JSON.parse(readFileSync(`${p}.json`, "utf-8")) : null);
const haveProduct = !!work && existsSync(join(work, "timeline.json"));

const SHOTS = {
  "cards/title.png": ["Title card", "Relay, what it is for."],
  "01-resident-chat": ["Resident, phone: chat intake", "Priya types a leak report; Relay (local model) asks follow-up questions; the server files the case and confirms; she opens her case page."],
  "02-manager-workspace": ["Manager: command center and case workspace", "\"Your move\" in the command center; the case: status, next action and reason, Relay's reading, \"What Relay did\" (recorded tool calls), the AI proposal and its policy note; the offer is sent."],
  "03-discovery": ["Manager: vendor discovery (fixture data)", "The discovery search and its candidates (labelled fixture data); a business is verified with a note, approved for the property, and offered the job."],
  "04-contractor-accepts": ["Contractor, phone: the offer", "Sam enters a $320 estimate and accepts; it waits for the manager's approval."],
  "05-manager-approves": ["Manager: money decision", "The estimate is over the approval threshold; Morgan approves with a $350 cap."],
  "06-resident-time": ["Resident, phone: visit time", "Priya picks a proposed time; the visit is confirmed."],
  "07-contractor-completes": ["Contractor, phone: the work", "Sam starts the work, writes what he did and marks it complete."],
  "08-resident-followup": ["Resident, phone: in-app follow-up", "\"Is it fixed?\" and the notification in her inbox."],
  "09-mailpit": ["Local test inbox (Mailpit)", "The follow-up email, captured by Mailpit (recorded by Relay as captured, not delivered)."],
  "10-resident-confirms": ["Resident, phone: confirmation", "\"Yes, resolved\"; the case shows Resolved."],
  "11-timeline": ["Manager: audit trail", "The case timeline labelled by who acted, and the follow-up log with each notification's delivery state."],
  "12-vague": ["Resident, phone: a vague report", "A deliberately vague message and Relay's reply."],
  "13-guard": ["Another contractor, phone: authorization", "Jo opens Sam's job by its address and gets \"could not be found\"."],
  "cards/end.png": ["End card", "What is real in V1.1, and the test evidence."],
};
const realness = (key) => (key.startsWith("cards/") ? "Card (text, not app footage)" : key === "03-discovery" ? "Real app; discovery in fixture mode (fictional businesses), labelled" : key === "09-mailpit" ? "Real Mailpit inbox (local test server)" : "Real app");

function timedTable(tl, narration, start, titleFor) {
  const byId = Object.fromEntries(narration.map((n) => [n.id, n.text.replace(/\s*\|\s*/g, " ")]));
  const rows = tl.clips.map((c) => {
    const a = tl.audio.find((x) => x.at >= c.start - 0.01 && x.at < c.start + c.duration);
    const id = a ? basename(a.src, ".wav") : null;
    return `| ${mmss(c.start + start)} | ${titleFor(c.dir ?? c.image, c)} | ${id ? (byId[id] ?? "") : "(no narration)"} |`;
  });
  return ["| Time | On screen | Narration |", "| --- | --- | --- |", ...rows].join("\n");
}

// ───────────────────────── technical walkthrough ─────────────────────────
const techTl = readIn(techWork, "tech-timeline.json");
const techNarration = [...readIn(techWork, "tech-narration.json"), ...readIn(techWork, "tech-extras.json")];
const techSide = sidecar(techMp4);
const TECH = { t00: "Title", t01: "Architecture (diagram)", t02: "Case engine: one pattern for every write (code)", t03: "Event-driven agents", t04: "Policy: the model reasons, the backend decides", t05: "Vendor discovery with Fiber AI", t06: "Follow-ups and delivery states", t07: "Security review and observability", t08: "AI evaluation, before and after", t09: "Tests and CI", "ci-raw": "The real GitHub Actions run (screenshot of the page)", t10: "What is not done", t11: "End" };
writeFileSync(
  join(docs, "TECHNICAL_WALKTHROUGH.md"),
  `# Technical walkthrough: script and timing

The voiceover of \`relay-technical-walkthrough.mp4\`.

- **Length:** ${mmss(techSide?.mediaDuration ?? techTl.duration)}, 1920×1080, H.264/AAC. Rendered by Chrome's
  MediaRecorder from \`app/e2e/demo/make-technical.mjs\`.
- **Narration:** the Windows "Microsoft Mark" voice, generated locally. Captions: \`captions/relay-technical-walkthrough.srt\`
  (also burned into the video).
- **Contents:** slides built from the codebase and \`docs/evidence\` (\`app/e2e/demo/technical.mjs\`), and a screenshot
  of the real GitHub Actions run for this release. When a product recording exists, an excerpt of its real footage
  (the coordinator's recorded tool calls) is added after the agents slide; this render has none.
- **Sync:** audio and captions were measured with \`av-sync-check.mjs\` at two points, and agree within 0.1 s.

${timedTable(techTl, techNarration, techSide?.timelineStart ?? 0, (k, c) => (c.dir ? "Real footage: the coordinator's recorded tool calls" : (TECH[basename(k, ".png")] ?? k)))}

## The architecture shown

- **Browser:** React 19 with TypeScript (Wasp). Resident and contractor portals are phone first; the manager's is for
  desktop.
- **Server:** Wasp on Node. Operations check identity and role; the REST API carries health and local-only test
  hooks; requests are rate limited.
- **Case engine:** each write is a row lock, a state machine check and one transaction holding the change, its event,
  the notifications and a durable AI marker.
- **Data:** PostgreSQL through Prisma, with pg-boss queues in the same database.
- **Jobs:** \`coordinatorJob\`, \`intakeTurnJob\` and \`vendorDiscoveryJob\`, plus a deadline sweep every minute.
- **External services, all optional:** an OpenAI-compatible model (Ollama locally), the Fiber AI SDK, SMTP (Mailpit
  locally), ElevenLabs voice and TraceRoot tracing.
`,
);
for (const f of ["relay-technical-walkthrough.srt", "relay-technical-walkthrough.vtt"]) if (existsSync(join(techWork, f))) copyFileSync(join(techWork, f), join(docs, "captions", f));

// ───────────────────────── product demo ─────────────────────────
let product = null;
if (haveProduct) {
  const tl = readIn(work, "timeline.json");
  const narration = readIn(work, "narration.json");
  const facts = readIn(work, "facts.json");
  const side = sidecar(productMp4);
  const cuts = tl.clips.flatMap((c) => c.cuts ?? []).map((c) => Number(c.text.match(/^(\d+)/)?.[1] ?? 0));
  writeFileSync(
    join(docs, "PRODUCT_DEMO_SCRIPT.md"),
    `# Product demo: script and timing

The voiceover of \`relay-product-demo.mp4\`. Narration: the Windows "Microsoft Mark" voice, generated locally.
Captions: \`captions/relay-product-demo.srt\` (also burned into the video).

- **Length:** ${mmss(side?.mediaDuration ?? tl.duration)}, 1920×1080, H.264/AAC.
- **Footage:** recorded from the running app by \`app/e2e/demo/capture-product.mjs\`.
- **Edits:** ${cuts.length} cuts of model thinking time, ${cuts.reduce((a, b) => a + b, 0)} seconds in all, each marked on screen.
- **What the model did in this recording:**
  - the coordinator ${facts.acceptedAiProposal ? "proposed an approved plumber, held for the manager, who sent it" : "did not propose a vendor, so the manager chose one"};
  - the vague report ${facts.vagueFiled ? "was filed for a person to classify" : "was answered with a question"}.

${timedTable(tl, narration, side?.timelineStart ?? 0, (k) => SHOTS[k]?.[0] ?? k)}
`,
  );
  for (const f of ["relay-product-demo.srt", "relay-product-demo.vtt"]) if (existsSync(join(work, f))) copyFileSync(join(work, f), join(docs, "captions", f));
  mkdirSync(join(docs, "screenshots"), { recursive: true });
  const picks = [];
  for (const c of tl.clips.filter((x) => x.dir)) {
    const m = readIn(work, join(c.dir, "manifest.json"));
    for (const f of m.marks.filter((x) => x.focus).slice(0, 2)) {
      const frame = [...m.frames].reverse().find((x) => x.t <= f.t + 1.2) ?? m.frames[0];
      const name = `${c.dir}-${f.label}.jpg`;
      copyFileSync(join(work, c.dir, frame.file), join(docs, "screenshots", name));
      picks.push(`screenshots/${name}`);
    }
  }
  product = { file: "relay-product-demo.mp4", seconds: Math.round(side?.mediaDuration ?? tl.duration), megabytes: sizeMb(productMp4), modelTimeCutSeconds: cuts.reduce((a, b) => a + b, 0), screenshots: picks, facts };
} else {
  const narration = productNarration({ acceptedAiProposal: true, vagueFiled: false });
  writeFileSync(
    join(docs, "PRODUCT_DEMO_SCRIPT.md"),
    `# Product demo: script (planned, not yet recorded)

The product demo has not been recorded yet. Recording needs the full stack, the local model and about 30 minutes of
CPU (see [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md)). This is the narration it will use, scene by scene.

- **Exact timings:** this file is rewritten with them by \`write-docs.mjs\` after recording.
- **Sentences that follow the model:** where the model's behaviour can vary (whether the coordinator proposes a
  vendor, how Relay answers the vague report), \`narration.mjs\` chooses the sentence from what the recording shows.
  The wording below assumes the coordinator proposes a vendor and the vague report gets a question.

| # | Scene | Narration |
| --- | --- | --- |
${productScenes.map((s, i) => `| ${i + 1} | ${SHOTS[s.dir ?? s.image]?.[0] ?? s.dir} | ${narration.find((n) => n.id === s.narration)?.text.replace(/\s*\|\s*/g, " ") ?? ""} |`).join("\n")}
`,
  );
}

writeFileSync(
  join(docs, "SHOT_LIST.md"),
  `# Shot list (product demo)

Every scene is real interaction with the running app, one browser session per person: desktop at 1536×864 rendered at
1.25x, phones at 390×844 at 2x. Model thinking time is cut and marked; nothing else is removed or changed.
${haveProduct ? "" : "\n**Status:** planned; not yet recorded (see DEMO_RUNBOOK.md).\n"}
| # | Scene | What happens | Real or labelled |
| --- | --- | --- | --- |
${productScenes.map((s, i) => `| ${i + 1} | ${SHOTS[s.dir ?? s.image]?.[0] ?? s.dir} | ${SHOTS[s.dir ?? s.image]?.[1] ?? ""} | ${realness(s.dir ?? s.image)} |`).join("\n")}

**Not in the video:**

- **Voice intake:** it needs a person speaking; the narration says the recording uses text.
- **A live Fiber search:** no key was available.
- **The background reports:** created through the API before recording. They are a dishwasher, an air conditioner
  at a property with no heating and cooling vendor, and a possible emergency.
`,
);

writeFileSync(
  join(docs, "metadata.json"),
  `${JSON.stringify(
    {
      generated: new Date().toISOString(),
      release: releaseUrl,
      videos: [
        { file: "relay-technical-walkthrough.mp4", seconds: Math.round(techSide?.mediaDuration ?? techTl.duration), width: 1920, height: 1080, codec: "H.264 + AAC (Chrome MediaRecorder)", megabytes: sizeMb(techMp4), captions: "captions/relay-technical-walkthrough.srt", script: "TECHNICAL_WALKTHROUGH.md", narration: "Windows OneCore voice 'Microsoft Mark', local", avSyncMeasured: "audio vs captions within 0.1 s at two points (av-sync-check.mjs)" },
        product ? { ...product, width: 1920, height: 1080, codec: "H.264 + AAC (Chrome MediaRecorder)", captions: "captions/relay-product-demo.srt", script: "PRODUCT_DEMO_SCRIPT.md", fiber: "fixture mode (fictional businesses), labelled on screen and in narration", voiceIntake: "not recorded; text chat shown" } : { file: "relay-product-demo.mp4", status: "not yet recorded: needs the full stack and the model; see DEMO_RUNBOOK.md" },
      ],
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote docs/demo (${haveProduct ? "product and technical" : "technical; product planned"})`);
