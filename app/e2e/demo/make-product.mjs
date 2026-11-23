// Turns the captures into the product video: narration, the closing card, the timeline, captions, and the render.
// Usage (from app/e2e): node demo/make-product.mjs <productWorkDir> <fiberWorkDir> <output.mp4>
//   <productWorkDir>: what capture-product.mjs wrote; <fiberWorkDir>: what capture-fiber.mjs wrote (the live search).
// Narration: set DEMO_TTS=kokoro to use tts-kokoro.mjs (a natural local voice; run it on <productWorkDir>/narration.json
// into <productWorkDir>/audio, then run this again). Otherwise the built-in Windows voice is used (tts.ps1).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { productCards, renderCards } from "./cards.mjs";
import { productNarration, productScenes } from "./narration.mjs";
import { buildTimeline, toSrt, toVtt } from "./timeline.mjs";

const [work, fiberWork, output] = process.argv.slice(2);
if (!work || !fiberWork || !output) throw new Error("usage: make-product.mjs <productWorkDir> <fiberWorkDir> <output.mp4>");
const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(p, "utf-8").replace(/^﻿/, ""));
const facts = read(join(work, "facts.json"));
const fiber = read(join(fiberWork, "facts.json"));
// The live vendor discovery scene joins the product footage (one folder for the renderer to serve).
if (!existsSync(join(work, "03-fiber", "manifest.json"))) cpSync(join(fiberWork, "04-fiber"), join(work, "03-fiber"), { recursive: true });

const narration = productNarration(facts, fiber);
writeFileSync(join(work, "narration.json"), JSON.stringify(narration, null, 1));
const audio = join(work, "audio");
const fresh = narration.every((n) => existsSync(join(audio, `${n.id}.wav`)) && existsSync(join(audio, `${n.id}.txt`)) && JSON.parse(readFileSync(join(audio, `${n.id}.txt`), "utf-8")).text === n.text);
if (!fresh) {
  if (process.env.DEMO_TTS === "kokoro") {
    console.log(`The narration changed. Synthesise it, then run this again:\n  KOKORO_DIR=<kokoro folder> node ${join(here, "tts-kokoro.mjs")} ${join(work, "narration.json")} ${audio}`);
    process.exit(3);
  }
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "tts.ps1"), "-Segments", join(work, "narration.json"), "-Out", audio, "-Voice", process.env.DEMO_VOICE ?? "Microsoft Mark"], { stdio: "inherit" });
}
await renderCards(productCards, join(work, "cards"));

const texts = Object.fromEntries(narration.map((n) => [n.id, n.text]));
const tl = buildTimeline({ work, items: productScenes(facts, fiber), durations: "audio/durations.json", texts, output: "relay-product-demo.mp4", videoBitsPerSecond: 5_000_000 });
writeFileSync(join(work, "timeline.json"), JSON.stringify(tl));
const plain = tl.captions.map((c) => ({ ...c, text: c.text.replace(/\|/g, "") }));
console.log(`timeline: ${tl.duration.toFixed(1)} s, ${tl.clips.length} clips, ${tl.captions.length} captions`);
if (process.argv.includes("--timeline-only")) process.exit(0);
execFileSync(process.execPath, [join(here, "render.mjs"), work, "timeline.json", output], { stdio: "inherit" });
// Caption files use where the timeline really starts in the file (measured by the renderer).
const { timelineStart } = read(`${output}.json`);
writeFileSync(join(work, "relay-product-demo.srt"), toSrt(plain, timelineStart));
writeFileSync(join(work, "relay-product-demo.vtt"), toVtt(plain, timelineStart));
