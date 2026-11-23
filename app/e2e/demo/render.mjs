// Renders a timeline (built by build-*.mjs) into a video with Chrome's own MediaRecorder: no external video tools.
// Usage (from app/e2e): node demo/render.mjs <workDir> <timeline.json> <output.mp4>
// <workDir> holds the frames, audio and images the timeline refers to; it is served locally for the renderer page.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const [work, timeline, output] = process.argv.slice(2);
if (!work || !timeline || !output) throw new Error("usage: render.mjs <workDir> <timeline.json> <output.mp4>");
const here = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png", ".wav": "audio/wav", ".js": "text/javascript" };

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path === "/render.html" ? join(here, "render.html") : resolve(work, `.${path}`);
  if (!file.startsWith(resolve(work)) && file !== join(here, "render.html")) return res.writeHead(403).end();
  if (!existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true });
page.on("console", (m) => m.type() === "error" && console.error("[page]", m.text()));
let last = "";
const ticker = setInterval(async () => {
  const t = await page.title().catch(() => "");
  if (t !== last) console.log(t);
  last = t;
}, 10_000);
const download = page.waitForEvent("download", { timeout: 60 * 60_000 });
await page.goto(`http://127.0.0.1:${port}/render.html?timeline=${encodeURIComponent(`/${timeline}`)}`);
const d = await download;
await d.saveAs(output);
clearInterval(ticker);
console.log(`saved ${output} (${(statSync(output).size / 1e6).toFixed(1)} MB), ${await page.title()}`);
await browser.close();
server.close();
