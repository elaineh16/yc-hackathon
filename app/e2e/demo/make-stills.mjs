// The README's product screenshots and the video thumbnail, taken from the real recorded frames (nothing is drawn on
// them, except the play button on the thumbnail).
// Usage (from app/e2e): node demo/make-stills.mjs <productWorkDir> <fiberWorkDir> <thumbnailFrame.png>
// <thumbnailFrame.png> is a frame grabbed from the finished video (playback-check.mjs), shown with a play button.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const [work, fiberWork, thumbFrame] = process.argv.slice(2);
if (!work || !fiberWork || !thumbFrame) throw new Error("usage: make-stills.mjs <productWorkDir> <fiberWorkDir> <thumbnailFrame.png>");
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "screenshots", "demo");
mkdirSync(out, { recursive: true });

/** The frame on screen a moment after a named mark (or the last frame of the scene). */
function still(dir, mark, after, name) {
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
  const at = mark ? m.marks.find((x) => x.label === mark) : null;
  if (mark && !at) throw new Error(`no mark "${mark}" in ${dir}`);
  const t = at ? at.t + after : m.ended;
  const frame = [...m.frames].reverse().find((f) => f.t <= t) ?? m.frames[0];
  copyFileSync(join(dir, frame.file), join(out, name));
  console.log(`${name} <- ${dir} @ ${mark ?? "end"}`);
}

still(join(work, "00-intro"), null, 0, "command-center.jpg");
still(join(work, "02-manager-workspace"), "runs", 1.0, "case-workspace.jpg");
still(join(fiberWork, "04-fiber"), "candidate", 1.0, "fiber-live.jpg");
still(join(work, "05-manager-approves"), "approval", 1.0, "spending-approval.jpg");
still(join(work, "01-resident-chat"), "filed", 1.5, "resident-chat.jpg");
still(join(work, "04-contractor-accepts"), "times", 1.0, "contractor-offer.jpg");
still(join(work, "08-resident-followup"), "ask", 1.0, "is-it-fixed.jpg");

// The thumbnail: the video's own opening frame with a play button.
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.setContent(`<!doctype html><html><body style="margin:0;width:1280px;height:720px;position:relative;overflow:hidden;background:#0b0d11">
  <img src="data:image/png;base64,${readFileSync(thumbFrame).toString("base64")}" style="width:1280px;height:720px;object-fit:cover;display:block" />
  <div style="position:absolute;left:50%;top:50%;width:132px;height:132px;margin:-66px 0 0 -66px;border-radius:50%;background:rgba(232,89,12,.94);box-shadow:0 10px 40px rgba(0,0,0,.45);display:grid;place-items:center">
    <div style="width:0;height:0;border-top:28px solid transparent;border-bottom:28px solid transparent;border-left:46px solid #fff;margin-left:12px"></div>
  </div>
</body></html>`);
await page.waitForTimeout(500);
await page.screenshot({ path: join(out, "video-thumbnail.png") });
await browser.close();
console.log("video-thumbnail.png");
