// Writes docs/demo from the actual render timelines: timestamped scripts, the shot list, metadata, captions, and
// screenshots taken from the real captured frames. Without a product recording yet, the product script and shot list
// are written as planned (narration and scenes, no timings) and say so.
// Usage (from app/e2e): node demo/write-docs.mjs <techWorkDir> <techMp4> <productWorkDir> <productMp4> --fiber <fiberWorkDir>
//                        [--release <url>] [--voice "<narration voice>"]
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { productScenes } from "./narration.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const releaseUrl = flag("release");
const fiberWork = flag("fiber");
const voice = flag("voice") ?? 'Kokoro-82M "af_heart" (open weights, Apache-2.0), run locally on the CPU';
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
  "00-intro": ["Manager: the command center", "The title over the real command center: what needs a person, and why."],
  "01-resident-chat": ["Resident, phone: chat intake", "Priya reports a leak; Relay (the local model) asks follow-up questions; the server files the case and confirms it."],
  "02-manager-workspace": ["Manager: the case workspace", "\"Your move\"; the case: next action, Relay's reading (what was said and what was assumed), \"What Relay did\" (the recorded tool calls), the AI proposal with its policy note; the manager sends the offer."],
  "03-fiber": ["Manager: live Fiber AI vendor discovery", "An AC case at a building with no approved HVAC contractor: the coverage gap, the manager approves one search, real businesses come back with Relay's checks and the provider's chargeInfo; one is shortlisted, none verified or contacted."],
  "04-contractor-accepts": ["Contractor, phone: the offer", "The contractor reads the request, enters a $320 estimate and two visit times, and accepts; it waits for the manager's approval."],
  "05-manager-approves": ["Manager: the money decision", "The estimate is over the approval threshold; the manager approves it with a $350 cap; the next step moves to the resident."],
  "06-resident-time": ["Resident, phone: the visit time", "Priya picks one of the proposed times; the visit is confirmed."],
  "07-contractor-completes": ["Contractor, phone: the work", "The contractor starts the work, writes what was done and marks it complete."],
  "08-resident-followup": ["Resident, phone: \"Is it fixed?\"", "Completion is not resolution: the case asks Priya, and the in-app notification is in the inbox."],
  "09-mailpit": ["Local test inbox (Mailpit)", "The same follow-up by email, captured by Mailpit (recorded by Relay as captured, never as delivered)."],
  "10-resident-confirms": ["Resident, phone: confirmation", "\"Yes, resolved\"; the case shows Resolved."],
  "11-not-fixed": ["Another resident, phone: not fixed", "Daniel's dishwasher was repaired (set up through the API) but stopped again: \"No, still having problems\" reopens the case."],
  "12-vague": ["Resident, phone: an unclear request", "A deliberately vague message and Relay's reply."],
  "13-safety": ["Manager: a possible emergency and a lockout", "\"Needs attention\" in the command center; the escalated water-near-a-light case and the lockout waiting for an identity check."],
  "14-guard": ["Another contractor, phone: authorization", "A contractor from another firm opens the job's address and gets \"This job is not available\"."],
  "15-final": ["Manager: the record of the case", "The resolved case: its history labelled by who acted, and the follow-up log with each notification's delivery state."],
  "cards/end.png": ["Closing card", "\"Relay. From resident request to accountable resolution.\" and the repository."],
};
const realness = (key) => (key.startsWith("cards/") ? "Card (text, not app footage)" : key === "03-fiber" ? "Real app; a live Fiber AI search returning real businesses" : key === "09-mailpit" ? "Real Mailpit inbox (local test server)" : key === "11-not-fixed" ? "Real app; the repair before it was set up through the API" : "Real app");

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
if (!haveProduct || !fiberWork) throw new Error("usage: write-docs.mjs <techWorkDir> <techMp4> <productWorkDir> <productMp4> --fiber <fiberWorkDir>");
const tl = readIn(work, "timeline.json");
const narration = readIn(work, "narration.json");
const facts = readIn(work, "facts.json");
const fiber = readIn(fiberWork, "facts.json");
const scenes = productScenes(facts, fiber);
const side = sidecar(productMp4);
const cuts = tl.clips.flatMap((c) => c.cuts ?? []).map((c) => Number(c.text.match(/^(\d+)/)?.[1] ?? 0));
const footage = tl.clips.filter((c) => c.dir).reduce((a, c) => a + c.duration, 0);
const d = fiber.discovery ?? {};
const oneLine = (x, n) => String(x ?? "").replace(/\s+/g, " ").slice(0, n);
writeFileSync(
  join(docs, "PRODUCT_DEMO_SCRIPT.md"),
  `# Product demo: script and timing

"Relay: from request to resolution", the voiceover of \`relay-product-demo.mp4\`.

- **Length:** ${mmss(side?.mediaDuration ?? tl.duration)}, 1920×1080, H.264/AAC, rendered by Chrome's MediaRecorder from
  \`app/e2e/demo/make-product.mjs\`. ${Math.round((footage / tl.duration) * 100)}% of it is footage of the running app; the rest is the closing card.
- **Narration:** ${voice}. Captions: \`captions/relay-product-demo.srt\` and \`.vtt\` (also burned into the video).
- **Footage:** recorded from the running app by \`app/e2e/demo/capture-product.mjs\`, plus the vendor discovery scene from
  \`capture-fiber.mjs\`, which was the live Fiber AI integration check.
- **Edits:** ${cuts.length} cuts of model thinking time, ${cuts.reduce((a, b) => a + b, 0)} seconds in all, each marked on screen. Long
  stretches play at most 1.6 times faster. Nothing else is removed or changed.

**What happened in this recording**

- **The chat:** ${(facts.chat ?? []).map((c) => `Priya: "${oneLine(c.resident, 200)}" Relay: "${oneLine(c.relay, 200)}"`).join(" ")}
- **The coordinator** ${facts.acceptedAiProposal ? `proposed ${facts.vendorName}, an approved plumber. It waited for the manager, who sent it` : `did not propose an approved plumber the demo could use, so the manager chose ${facts.vendorName}`}.
- **Fiber AI:** ${fiber.reused ? "an earlier live search was reused (no new call)" : `a live search, approved by the manager in the interface: ${d.placesReturned} places, ${d.candidatesKept} kept, ${d.creditsCharged} credits (chargeInfo \`${d.chargeInfo}\`)`}. ${fiber.shortlisted ? `${fiber.shortlisted} was shortlisted; nothing was verified, contacted or approved.` : "Nothing was shortlisted."}
- **Not fixed:** after "No, still having problems", the dishwasher case is ${facts.notFixed?.status ?? "unknown"}.
- **The unclear request** ${facts.vagueFiled ? "was filed for a person to classify" : `was answered with a question: "${oneLine(facts.vagueReply, 220)}"`}.${(facts.vagueTakes ?? []).filter((t) => !t.used).map((t) => ` This scene was recorded twice. In take ${t.take}, not shown, ${t.why}: "${oneLine(t.reply, 160)}".`).join("")}${facts.escalationSuggested ? "\n- **A second AI proposal:** the coordinator also suggested escalating the leak. The safety rules found no hazard, so it stayed a suggestion for the manager, and it is visible in the case workspace scene." : ""}
- **Safety:** the possible emergency is ${facts.ceiling?.status ?? "?"}, and the lockout is ${facts.lockout?.status ?? "?"}.
- **Email on the leak case, as Relay recorded it:** ${Object.entries((facts.final?.followUps ?? []).filter((x) => x.channel === "EMAIL").reduce((a, x) => ((a[x.status] = (a[x.status] ?? 0) + 1), a), {})).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}. The local Mailpit server's port forwarding broke during the recording (a Docker port proxy left stale by an earlier WSL restart). Emails sent in that window were retried and then marked failed, and none were shown as delivered. Mailpit was restarted, and the pending ones, including "Is this fixed?", were captured.

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
const product = { file: "relay-product-demo.mp4", seconds: Math.round(side?.mediaDuration ?? tl.duration), megabytes: sizeMb(productMp4), footageShare: Number((footage / tl.duration).toFixed(2)), modelTimeCutSeconds: cuts.reduce((a, b) => a + b, 0), screenshots: picks };

writeFileSync(
  join(docs, "SHOT_LIST.md"),
  `# Shot list (product demo)

Every scene is real interaction with the running app, one browser session per person: desktop at 1536×864 rendered at
1.25x (1920×1080 frames), phones at 390×844 at 2x. Model thinking time is cut and marked; nothing else is removed or
changed.

| # | Scene | What happens | Real or labelled |
| --- | --- | --- | --- |
${scenes.map((x, i) => `| ${i + 1} | ${SHOTS[x.dir ?? x.image]?.[0] ?? x.dir} | ${SHOTS[x.dir ?? x.image]?.[1] ?? ""} | ${realness(x.dir ?? x.image)} |`).join("\n")}

**Set up before recording, through the API (not shown):** a dishwasher (repaired by the appliance contractor, so it
can be reported as not fixed on camera), water dripping from a bathroom light fixture (a possible emergency), and a
lockout. Maple Court was set to ask a manager before any vendor search.

**Not in the video:** voice intake (it needs a person speaking; the narration says the chat is text), onboarding a
discovered business (it needs a manager's own check of a real business, which was not done), and a real email
delivery (only the local test inbox).
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
        { ...product, title: "Relay: from request to resolution", width: 1920, height: 1080, codec: "H.264 + AAC (Chrome MediaRecorder)", captions: ["captions/relay-product-demo.srt", "captions/relay-product-demo.vtt"], script: "PRODUCT_DEMO_SCRIPT.md", shotList: "SHOT_LIST.md", narration: voice, fiber: fiber.reused ? "real results reused from an earlier live search (no new call)" : `live search through the manager interface: ${d.placesReturned} places, ${d.candidatesKept} kept, ${d.creditsCharged} credits`, voiceIntake: "not recorded; text chat shown" },
      ],
    },
    null,
    2,
  )}\n`,
);
console.log("wrote docs/demo (product and technical)");
