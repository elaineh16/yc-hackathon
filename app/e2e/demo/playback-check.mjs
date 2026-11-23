// Plays a rendered video from the start in real time (as a viewer would) and screenshots it at given media times.
// Usage (from app/e2e): node demo/playback-check.mjs <video.mp4> <outDir> t1 t2 ...
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [video, out, ...times] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const data = readFileSync(video);
const server = createServer((req, res) => {
  if (req.url === "/v.mp4") {
    const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    const a = range ? Number(range[1]) : 0;
    const b = range && range[2] ? Number(range[2]) : data.length - 1;
    res.writeHead(range ? 206 : 200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": b - a + 1, ...(range ? { "Content-Range": `bytes ${a}-${b}/${data.length}` } : {}) });
    return res.end(data.subarray(a, b + 1));
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<body style="margin:0;background:#000"><video id="v" src="/v.mp4" muted playsinline style="width:1920px;height:1080px"></video></body>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.evaluate(() => document.getElementById("v").play());
for (const t of times.map(Number)) {
  await page.waitForFunction((s) => document.getElementById("v").currentTime >= s, t, { timeout: 15 * 60_000, polling: 20 });
  const at = await page.evaluate(() => document.getElementById("v").currentTime);
  await page.screenshot({ path: join(out, `play-${String(t).padStart(6, "0")}.png`) });
  console.log(`screenshot at media time ${at.toFixed(2)} s`);
}
await browser.close();
server.close();
