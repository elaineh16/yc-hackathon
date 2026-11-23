// Turns a product capture into the final video: narration (Windows voice), cards, timeline, captions, render.
// Usage (from app/e2e): node demo/make-product.mjs <workDir> <output.mp4>
// <workDir> is the folder capture-product.mjs wrote (scene folders and facts.json).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { productCards, renderCards } from "./cards.mjs";
import { productNarration, productScenes } from "./narration.mjs";
import { buildTimeline, toSrt, toVtt } from "./timeline.mjs";

const [work, output] = process.argv.slice(2);
if (!work || !output) throw new Error("usage: make-product.mjs <workDir> <output.mp4>");
const here = dirname(fileURLToPath(import.meta.url));
const facts = JSON.parse(readFileSync(join(work, "facts.json"), "utf-8"));

const narration = productNarration(facts);
writeFileSync(join(work, "narration.json"), JSON.stringify(narration, null, 1));
execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "tts.ps1"), "-Segments", join(work, "narration.json"), "-Out", join(work, "audio"), "-Voice", process.env.DEMO_VOICE ?? "Microsoft Mark"], { stdio: "inherit" });
await renderCards(productCards, join(work, "cards"));

const texts = Object.fromEntries(narration.map((n) => [n.id, n.text]));
const tl = buildTimeline({ work, items: productScenes, durations: "audio/durations.json", texts, output: "relay-product-demo.mp4", videoBitsPerSecond: 4_500_000 });
writeFileSync(join(work, "timeline.json"), JSON.stringify(tl));
const plain = tl.captions.map((c) => ({ ...c, text: c.text.replace(/\|/g, "") }));
// Caption times in the published files include the renderer's still pre-roll at the start.
writeFileSync(join(work, "relay-product-demo.srt"), toSrt(plain, tl.preroll));
writeFileSync(join(work, "relay-product-demo.vtt"), toVtt(plain, tl.preroll));
console.log(`timeline: ${tl.duration.toFixed(1)} s, ${tl.clips.length} clips, ${tl.captions.length} captions`);
execFileSync(process.execPath, [join(here, "render.mjs"), work, "timeline.json", output], { stdio: "inherit" });
