// Shared tools for recording the Relay demos from the real running app.
//
// Frames come from Chrome's own screencast (CDP Page.startScreencast): full-resolution JPEGs, timestamped, emitted
// whenever the page repaints. Nothing is drawn or faked; the only addition to the page is a visible cursor (and a
// touch dot on phone screens), because headless Chrome has no on-screen pointer.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

export const WEB = process.env.RELAY_WEB_URL ?? "http://localhost:3000";
export const API = process.env.RELAY_API_URL ?? "http://localhost:3001";
export const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
// Development-only demo accounts from the seed (see the README). Never used outside local demos.
export const PASSWORD = "relay-demo-2026";
const HOOK_HEADERS = { "Content-Type": "application/json", ...(process.env.RELAY_TEST_HOOKS_TOKEN ? { "x-relay-test-token": process.env.RELAY_TEST_HOOKS_TOKEN } : {}) };

// Desktop: a 1536×864 layout rendered at 1.25x, so frames are 1920×1080 with text large enough to read in a video.
export const DESKTOP = { viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 };
// Phone: an iPhone-sized layout at 2x (780×1688 frames), shown inside a phone outline by the renderer.
export const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now() / 1000;

export async function launch() {
  return chromium.launch({ channel: "chrome", headless: process.env.DEMO_HEADED !== "1" });
}

/** A visible pointer: an arrow on desktop, a soft dot on phones, and a ring on each click. Visual aid only. */
const CURSOR = `(() => {
  if (window.__relayCursor) return;
  window.__relayCursor = true;
  const touch = matchMedia("(pointer: coarse)").matches || innerWidth < 600;
  const style = document.createElement("style");
  style.textContent = \`
    #relay-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; transition: opacity .2s; opacity: 0; }
    #relay-cursor svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
    .relay-ring { position: fixed; z-index: 2147483646; pointer-events: none; width: 34px; height: 34px; margin: -17px 0 0 -17px;
      border-radius: 50%; border: 3px solid rgba(232,93,4,.85); animation: relay-ring .55s ease-out forwards; }
    @keyframes relay-ring { from { transform: scale(.4); opacity: 1 } to { transform: scale(1.6); opacity: 0 } }\`;
  const el = document.createElement("div");
  el.id = "relay-cursor";
  el.innerHTML = touch
    ? '<div style="width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;background:rgba(20,20,20,.28);border:2px solid rgba(255,255,255,.9)"></div>'
    : '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15 L19 15 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const mount = () => { document.documentElement.appendChild(style); document.documentElement.appendChild(el); };
  if (document.documentElement) mount(); else addEventListener("DOMContentLoaded", mount);
  addEventListener("mousemove", (e) => { el.style.opacity = "1"; el.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)"; }, true);
  addEventListener("mousedown", (e) => {
    const r = document.createElement("div"); r.className = "relay-ring"; r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
    document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700);
  }, true);
})();`;

/** A signed-in page for one demo user, with the cursor overlay. */
export async function signIn(browser, username, device = DESKTOP) {
  const context = await browser.newContext({ ...device, baseURL: WEB });
  await context.addInitScript(CURSOR);
  const page = await context.newPage();
  await page.goto("/login");
  const field = page.getByLabel("Username");
  await field.waitFor({ timeout: 30_000 }).catch(async () => page.reload());
  await field.fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  page.__mouse = { x: device.viewport.width / 2, y: device.viewport.height / 2 };
  return page;
}

/**
 * Records one scene: Chrome screencast frames of `page` into `dir`, plus markers (named moments) and focus boxes
 * (where the renderer may zoom), all timestamped on the same clock as the frames.
 */
export async function scene(page, dir, name) {
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const marks = [];
  const scale = page.__device?.deviceScaleFactor ?? 1;
  cdp.on("Page.screencastFrame", async (f) => {
    const file = `f${String(frames.length).padStart(6, "0")}.jpg`;
    writeFileSync(join(dir, file), Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp ?? now() });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
  });
  const vp = page.viewportSize();
  const dpr = await page.evaluate(() => devicePixelRatio);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: Math.round(vp.width * dpr), maxHeight: Math.round(vp.height * dpr), everyNthFrame: 1 });
  const started = now();
  // Nudge a repaint so the scene has a first frame even if nothing moves.
  await page.evaluate(() => document.body.style.setProperty("--relay-nudge", String(Math.random())));
  return {
    name,
    mark: (label, extra = {}) => marks.push({ label, t: now(), ...extra }),
    /** Remembers where an element is (in frame pixels) so the renderer can zoom to it. */
    focus: async (label, locator, pad = 24) => {
      const b = await locator.boundingBox().catch(() => null);
      if (b) marks.push({ label, t: now(), focus: { x: (b.x - pad) * dpr, y: (b.y - pad) * dpr, w: (b.width + 2 * pad) * dpr, h: (b.height + 2 * pad) * dpr } });
    },
    stop: async () => {
      await sleep(400);
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      await cdp.detach().catch(() => undefined);
      const manifest = { name, started, ended: now(), size: { width: Math.round(vp.width * dpr), height: Math.round(vp.height * dpr) }, dpr, scale, frames, marks };
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
      return manifest;
    },
  };
}

/** Moves the visible pointer smoothly to an element, then clicks it. */
export async function glide(page, locator, { click = true, steps = 22, pause = 180 } = {}) {
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  const b = await locator.boundingBox();
  if (!b) throw new Error("element not visible");
  const x = b.x + b.width / 2;
  const y = b.y + Math.min(b.height / 2, 18);
  await page.mouse.move(x, y, { steps });
  page.__mouse = { x, y };
  await sleep(pause);
  if (click) await page.mouse.click(x, y);
}

/** Types like a person (visible keystrokes) into a field after gliding to it. */
export async function type(page, locator, text, delay = 28) {
  await glide(page, locator);
  await locator.pressSequentially(text, { delay });
}

/** Scrolls smoothly so an element sits in the upper part of the screen. */
export async function scrollTo(page, locator, offset = 120) {
  const top = await locator.evaluate((el, off) => el.getBoundingClientRect().top + window.scrollY - off, offset);
  await page.evaluate(async (target) => {
    const start = window.scrollY;
    const dist = target - start;
    const n = 30;
    for (let i = 1; i <= n; i++) {
      window.scrollTo(0, start + (dist * (1 - Math.cos((Math.PI * i) / n))) / 2);
      await new Promise((r) => setTimeout(r, 16));
    }
  }, top);
}

// ───────────────────────── API helpers (setup the recording does not need to show) ─────────────────────────

const sessions = new Map();
export async function api(username, op, args = {}) {
  if (!sessions.has(username)) {
    const login = await (await fetch(`${API}/auth/username/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }) })).json();
    sessions.set(username, login.sessionId);
  }
  const res = await fetch(`${API}/operations/${op.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessions.get(username)}` }, body: JSON.stringify({ json: args }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${op} -> ${res.status}: ${body?.message ?? ""}`);
  return body.json;
}
export async function hook(name, body = {}) {
  const res = await fetch(`${API}/api/test/${name}`, { method: "POST", headers: HOOK_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`test hook ${name} -> ${res.status}`);
  return res.json();
}
export async function waitFor(fn, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(1500);
  }
}
/** Waits until Relay AI has finished reviewing a case (no coordinator run in progress, none pending). */
export async function coordinatorIdle(caseId, timeoutMs = 600_000) {
  return waitFor(
    async () => {
      const c = await api("morgan", "getCase", { caseId });
      const runs = c.ai?.runs ?? [];
      return runs.length > 0 && runs.every((r) => r.status !== "RUNNING") && !c.ai?.pending ? c : null;
    },
    timeoutMs,
    "Relay AI to finish its review",
  );
}
