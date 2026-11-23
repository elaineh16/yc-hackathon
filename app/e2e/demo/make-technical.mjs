// The technical walkthrough video: slides from the codebase and measured results, one excerpt of real recorded
// footage (the coordinator's tool calls), and a screenshot of the CI run, with narration and captions.
// Usage (from app/e2e): node demo/make-technical.mjs <productWorkDir> <output.mp4> [ciRunUrl]
// <productWorkDir> is the product capture (for the footage excerpt); evidence numbers come from docs/evidence.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { renderCards } from "./cards.mjs";
import { technicalNarration, technicalSlides } from "./technical.mjs";
import { buildTimeline, toSrt, toVtt } from "./timeline.mjs";

const [work, output, ciUrl] = process.argv.slice(2);
if (!work || !output) throw new Error("usage: make-technical.mjs <productWorkDir> <output.mp4> [ciRunUrl]");
const here = dirname(fileURLToPath(import.meta.url));
const evidence = join(here, "..", "..", "..", "docs", "evidence");

// The whole-system held-out result, if that run exists.
const r = {};
const live = join(evidence, "eval-live-heldout-v2-emergencies-v1.1.json");
if (existsSync(live)) {
  const rows = JSON.parse(readFileSync(live, "utf-8")).rows.filter((x) => !x.error);
  const caught = rows.filter((x) => !x.missedEscalation).length;
  r.heldoutLive = `${caught} / ${rows.length}`;
  r.heldoutLiveSentence = `Run live, with the model reading the same words, the whole system escalated ${caught} of those ${rows.length}.`;
}

const narration = technicalNarration(r);
writeFileSync(join(work, "tech-narration.json"), JSON.stringify(narration, null, 1));
execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "tts.ps1"), "-Segments", join(work, "tech-narration.json"), "-Out", join(work, "tech-audio"), "-Voice", process.env.DEMO_VOICE ?? "Microsoft Mark"], { stdio: "inherit" });
await renderCards(technicalSlides(r), join(work, "tech-cards"));

// Extra narration for the two real items, synthesised with the rest.
const extras = [
  { id: "x-footage", text: "Here is a real review from the product demo: the coordinator's tool calls, exactly as recorded, with what policy did with each proposal." },
  { id: "x-ci", text: "And this is the actual GitHub Actions run for this release." },
];
writeFileSync(join(work, "tech-extras.json"), JSON.stringify(extras, null, 1));
execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "tts.ps1"), "-Segments", join(work, "tech-extras.json"), "-Out", join(work, "tech-audio-x"), "-Voice", process.env.DEMO_VOICE ?? "Microsoft Mark"], { stdio: "inherit" });
const durations = [...JSON.parse(readFileSync(join(work, "tech-audio", "durations.json"), "utf-8").replace(/^﻿/, "")), ...JSON.parse(readFileSync(join(work, "tech-audio-x", "durations.json"), "utf-8").replace(/^﻿/, ""))];
for (const x of extras) copyFileSync(join(work, "tech-audio-x", `${x.id}.wav`), join(work, "tech-audio", `${x.id}.wav`));
writeFileSync(join(work, "tech-audio", "all-durations.json"), JSON.stringify(durations));

// A screenshot of the real CI run, framed as a slide (the page itself is GitHub's, unedited).
const items = [];
let ci = false;
if (ciUrl) {
  try {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const p = await browser.newPage({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
    await p.goto(ciUrl, { waitUntil: "networkidle", timeout: 60_000 });
    await p.screenshot({ path: join(work, "tech-cards", "ci-raw.png") });
    await browser.close();
    ci = true;
  } catch (e) {
    console.warn("CI screenshot skipped:", e.message);
  }
}

const texts = Object.fromEntries([...narration, ...extras].map((n) => [n.id, n.text]));
const card = (id) => ({ kind: "card", image: `tech-cards/${id}.png`, narration: id });
items.push(card("t00"), card("t01"), card("t02"), card("t03"));
items.push({ kind: "scene", dir: "02-manager-workspace", device: "desktop", label: "Recorded: the coordinator's tool calls", narration: "x-footage", range: { mark: "runs", before: 1.5, after: 8 } });
items.push(card("t04"), card("t05"), card("t06"), card("t07"), card("t08"), card("t09"));
if (ci) items.push({ kind: "card", image: "tech-cards/ci-raw.png", narration: "x-ci" });
items.push(card("t10"), card("t11"));

const tl = buildTimeline({ work, items, durations: "tech-audio/all-durations.json", texts, output: "relay-technical-walkthrough.mp4", videoBitsPerSecond: 4_000_000, audioDir: "tech-audio" });
writeFileSync(join(work, "tech-timeline.json"), JSON.stringify(tl));
const plain = tl.captions.map((c) => ({ ...c, text: c.text.replace(/\|/g, "") }));
writeFileSync(join(work, "relay-technical-walkthrough.srt"), toSrt(plain, tl.preroll));
writeFileSync(join(work, "relay-technical-walkthrough.vtt"), toVtt(plain, tl.preroll));
console.log(`timeline: ${tl.duration.toFixed(1)} s, ${tl.clips.length} clips, ${tl.captions.length} captions`);
execFileSync(process.execPath, [join(here, "render.mjs"), work, "tech-timeline.json", output], { stdio: "inherit" });
