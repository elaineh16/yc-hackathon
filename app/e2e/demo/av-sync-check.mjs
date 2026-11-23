// Measures audio/video sync in a rendered video around a known moment: when the narration audio starts versus when a
// caption box appears on screen (both measured in media time while the video plays).
// Usage (from app/e2e): node demo/av-sync-check.mjs <video.mp4> <fromSeconds> <toSeconds>
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";

const [video, from, to] = process.argv.slice(2);
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
  res.end(`<body style="margin:0"><video id="v" src="/v.mp4" playsinline crossorigin="anonymous" style="width:960px;height:540px"></video></body>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
const result = await page.evaluate(
  async ([a, b]) => {
    const v = document.getElementById("v");
    await new Promise((r) => (v.readyState >= 1 ? r() : v.addEventListener("loadedmetadata", r, { once: true })));
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(v);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    an.connect(ctx.destination);
    const buf = new Float32Array(an.fftSize);
    const c = document.createElement("canvas");
    c.width = 96;
    c.height = 54;
    const g = c.getContext("2d", { willReadFrequently: true });
    v.currentTime = a;
    await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
    await ctx.resume();
    await v.play();
    // Onsets only count after a quiet / caption-free moment has been seen (so a narration or caption already running
    // at the start of the window is not mistaken for the one being measured).
    let audioOn = null, captionOn = null, quiet = false, clear = false;
    await new Promise((resolve) => {
      const step = (_now, meta) => {
        const t = meta.mediaTime;
        an.getFloatTimeDomainData(buf);
        let rms = 0;
        for (const x of buf) rms += x * x;
        rms = Math.sqrt(rms / buf.length);
        if (rms < 0.002) quiet = true;
        else if (quiet && audioOn === null && rms > 0.01) audioOn = t;
        // The caption box: a dark band centred near the bottom of the frame.
        g.drawImage(v, 0, 0, 96, 54);
        const px = g.getImageData(48, 50, 1, 1).data;
        const around = g.getImageData(4, 50, 1, 1).data;
        const on = Math.abs(px[0] - around[0]) + Math.abs(px[1] - around[1]) + Math.abs(px[2] - around[2]) > 6;
        if (!on) clear = true;
        else if (clear && captionOn === null) captionOn = t;
        if (t >= b) return resolve();
        v.requestVideoFrameCallback(step);
      };
      v.requestVideoFrameCallback(step);
    });
    v.pause();
    return { audioOn, captionOn };
  },
  [Number(from), Number(to)],
);
console.log(JSON.stringify(result), result.audioOn !== null && result.captionOn !== null ? `audio - caption = ${(result.audioOn - result.captionOn).toFixed(2)} s` : "");
await browser.close();
server.close();
