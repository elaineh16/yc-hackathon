// Checks a rendered video in Chrome: duration, size, that audio decodes, and frame grabs at given times.
// Usage (from app/e2e): node demo/inspect-video.mjs <video.mp4> <outDir> [t1 t2 ...]
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { chromium } from "@playwright/test";

const [video, out, ...times] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const server = createServer((req, res) => {
  if (req.url === "/v.mp4") {
    const data = readFileSync(video);
    const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const a = Number(range[1]);
      const b = range[2] ? Number(range[2]) : data.length - 1;
      res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": `bytes ${a}-${b}/${data.length}`, "Accept-Ranges": "bytes", "Content-Length": b - a + 1 });
      return res.end(data.subarray(a, b + 1));
    }
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": data.length, "Accept-Ranges": "bytes" });
    return res.end(data);
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<body style="margin:0;background:#000"><video id="v" src="/v.mp4" muted playsinline style="width:1920px;height:1080px"></video></body>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`http://127.0.0.1:${server.address().port}/`);
const info = await page.evaluate(async () => {
  const v = document.getElementById("v");
  await new Promise((r) => (v.readyState >= 1 ? r() : v.addEventListener("loadedmetadata", r, { once: true })));
  // Play a little with sound decoding to confirm there is an audio track.
  v.muted = false;
  v.volume = 0.01;
  await v.play().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));
  v.pause();
  return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, audioBytes: v.webkitAudioDecodedByteCount ?? null, videoBytes: v.webkitVideoDecodedByteCount ?? null };
});
console.log(basename(video), JSON.stringify(info));
for (const t of times) {
  await page.evaluate(async (s) => {
    const v = document.getElementById("v");
    v.muted = true;
    // Seek, then wait until that frame has actually been presented before the screenshot.
    const presented = new Promise((r) => v.requestVideoFrameCallback(() => r()));
    v.currentTime = s;
    await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
    await presented;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, Number(t));
  await page.screenshot({ path: join(out, `frame-${String(t).padStart(6, "0")}.png`) });
}
await browser.close();
server.close();
