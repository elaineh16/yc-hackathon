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
    id: "title",
    html: page(
      `${brand}
      <div style="margin-top:150px">
        <div class="eyebrow">Product demo · V1.1</div>
        <h1 style="margin-top:22px">An AI operations coordinator<br/>for residential buildings</h1>
        <p class="lead" style="margin-top:36px">Residents report problems in their own words. Relay turns each one into a tracked case and coordinates it to a verified fix, with people in control of every decision that matters.</p>
      </div>`,
      `<span>Recorded from the running app · resident, manager and contractor</span><span class="mono">github.com/elaineh16/yc-hackathon</span>`,
    ),
  },
  {
    id: "end",
    html: page(
      `${brand}
      <h2 style="margin-top:70px">What is real in Relay V1.1</h2>
      <div class="cols" style="grid-template-columns:repeat(3,1fr);margin-top:46px">
        <div class="card"><h3>Intake</h3><p>Chat, voice and a form that needs no AI. Asks before filing vague reports; the server, not the model, saves the case.</p></div>
        <div class="card"><h3>Coordination</h3><p>An event-driven coordinator proposes; deterministic policy decides. Money, scheduling and closing stay with people.</p></div>
        <div class="card"><h3>Discovery</h3><p>Fiber AI vendor search when a building has no approved trade. Every business is verified by a manager before any work.</p></div>
        <div class="card"><h3>Follow-up</h3><p>In-app and opt-in email, with honest delivery states: captured is never "delivered".</p></div>
        <div class="card"><h3>Trust</h3><p>Row locks, a state machine, idempotent actions, durable jobs, a full audit trail, and a security review.</p></div>
        <div class="card"><h3>Evidence</h3><p><span class="mono">34</span> unit · <span class="mono">85</span> API · <span class="mono">16</span> browser tests in CI, and an AI evaluation with held-out sets, before and after.</p></div>
      </div>`,
      `<span>Not deployed · Fiber shown in fixture mode (no key) · local 3B model on CPU</span><span class="mono">github.com/elaineh16/yc-hackathon</span>`,
    ),
  },
];
