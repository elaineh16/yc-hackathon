// Title cards and explanatory slides, rendered from HTML to 1920×1080 PNGs in Relay's own visual style.
// These are explanations (text and diagrams), never pictures of the app: app footage only comes from capture.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

export const STYLE = `
@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap");
:root { --night:#10171f; --night2:#1a232d; --line:#26313c; --move:#e8590c; --ai:#8f9fe0; --ok:#5fbf7a; --ink:#e9edf1; --muted:#9aa6b2; --faint:#6b7783; }
* { box-sizing: border-box; margin: 0; }
html, body { width: 1920px; height: 1080px; background: radial-gradient(1200px 700px at 85% -10%, #1d2a38 0%, var(--night) 55%) , var(--night); color: var(--ink); font-family: "IBM Plex Sans", "Segoe UI", sans-serif; overflow: hidden; }
.frame { position: absolute; inset: 0; padding: 96px 120px 168px; display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 16px; font-weight: 600; font-size: 28px; color: var(--ink); }
.logo { width: 52px; height: 52px; border-radius: 14px; background: var(--move); display: grid; place-items: center; font-weight: 700; font-size: 28px; color: #fff; }
.eyebrow { font: 600 22px "IBM Plex Mono", monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--move); }
h1 { font-size: 84px; line-height: 1.05; font-weight: 700; letter-spacing: -.02em; }
h2 { font-size: 60px; line-height: 1.1; font-weight: 700; letter-spacing: -.015em; }
p.lead { font-size: 34px; line-height: 1.4; color: var(--muted); max-width: 1450px; }
.cols { display: grid; gap: 28px; }
.card { background: rgba(255,255,255,.04); border: 1px solid var(--line); border-radius: 18px; padding: 28px 32px; }
.card h3 { font-size: 30px; font-weight: 600; margin-bottom: 10px; }
.card p, .card li { font-size: 24px; line-height: 1.45; color: var(--muted); }
.card ul { padding-left: 26px; }
.mono { font-family: "IBM Plex Mono", monospace; }
.pill { display: inline-block; padding: 6px 16px; border-radius: 999px; font: 600 20px "IBM Plex Mono", monospace; border: 1px solid var(--line); color: var(--muted); }
.pill.ai { color: var(--ai); border-color: #3a4a8c; } .pill.move { color: var(--move); border-color: #6b3a1c; } .pill.ok { color: var(--ok); border-color: #285c38; }
.foot { margin-top: auto; display: flex; justify-content: space-between; align-items: center; color: var(--faint); font-size: 22px; }
table { border-collapse: collapse; width: 100%; font-size: 24px; }
th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid var(--line); }
th { color: var(--faint); font-weight: 500; font-size: 20px; text-transform: uppercase; letter-spacing: .04em; }
td.n { font-family: "IBM Plex Mono", monospace; text-align: right; } th.n { text-align: right; }
code, pre { font-family: "IBM Plex Mono", monospace; }
pre { background: #0b1016; border: 1px solid var(--line); border-radius: 14px; padding: 24px 28px; font-size: 21px; line-height: 1.5; color: #cfd6de; white-space: pre; overflow: hidden; }
pre .c { color: #6b7783; } pre .k { color: #e8a76c; } pre .s { color: #9fc79f; }
`;

export const page = (body, foot = "") => `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body><div class="frame">${body}${foot ? `<div class="foot">${foot}</div>` : ""}</div></body></html>`;

export async function renderCards(cards, outDir) {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const c of cards) {
    await p.setContent(c.html, { waitUntil: "networkidle" });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: join(outDir, `${c.id}.png`) });
  }
  await browser.close();
}

const brand = `<div class="brand"><div class="logo">R</div>Relay</div>`;

export const productCards = [
  {
    id: "end",
    html: page(
      `${brand}
      <div style="margin-top:170px">
        <h1 style="font-size:96px">Relay.</h1>
        <p class="lead" style="margin-top:28px;font-size:46px;color:#d6dde4;max-width:1500px">From resident request to accountable resolution.</p>
        <p style="margin-top:70px;font:500 34px 'IBM Plex Mono',monospace;color:#e8590c">github.com/elaineh16/yc-hackathon</p>
      </div>`,
      `<span>Recorded from the running app: real chat with a local model, a live Fiber AI search, one shared case</span><span>Demo accounts are local and fictional</span>`,
    ),
  },
];
