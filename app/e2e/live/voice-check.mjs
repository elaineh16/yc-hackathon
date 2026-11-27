// Live check of the voice intake, end to end, with no person at the microphone: real Chrome, the real ElevenLabs
// agent, the real Relay server. Chrome's fake microphone plays a prepared recording (make-mic.mjs builds one from
// synthetic speech), so speech recognition, the agent's model, the submit_report client tool and Relay's filing all
// run for real. It is NOT a substitute for a person speaking: it proves the wiring, not the experience.
//
// It opens a real, billable ElevenLabs session (each run uses about as many seconds of the plan's allowance as the
// recording is long), so it is never part of the test suites and runs only by hand:
//   cd app/e2e && node live/voice-check.mjs connect <silent.wav> <out.json>   # connect, hear the greeting, hang up
//   cd app/e2e && node live/voice-check.mjs report  <speech.wav> <out.json>   # say a report, wait for it to be filed
// Needs the app running (client :3000, server :3001) with ELEVENLABS_API_KEY and EL_AGENT_INTAKE_ID set.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [mode, micFile, outFile] = process.argv.slice(2);
if (!["connect", "report"].includes(mode) || !micFile || !outFile) throw new Error("usage: voice-check.mjs connect|report <mic.wav> <out.json>");
const WEB = process.env.RELAY_WEB_URL ?? "http://localhost:3000";
const API = process.env.RELAY_API_URL ?? "http://localhost:3001";
const PASSWORD = "relay-demo-2026";
const RESIDENT = process.env.VOICE_CHECK_USER ?? "priya";

async function op(sessionId, name, args) {
  const kebab = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const res = await fetch(`${API}/operations/${kebab}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionId}` }, body: JSON.stringify({ json: args ?? null }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${name} -> ${res.status} ${body?.message ?? ""}`);
  return body.json;
}
async function session(username) {
  const res = await fetch(`${API}/auth/username/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }) });
  if (!res.ok) throw new Error(`login ${username}: ${res.status}`);
  return (await res.json()).sessionId;
}

const health = await (await fetch(`${API}/health`)).json();
if (!health.voiceConfigured) throw new Error("The server has no voice configuration (ELEVENLABS_API_KEY and EL_AGENT_INTAKE_ID).");
const resident = await session(RESIDENT);
const manager = await session("morgan");
const before = new Set((await op(resident, "getMyCases")).map((c) => c.id));

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${resolve(micFile)}%noloop`, "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: { width: 430, height: 900 }, permissions: ["microphone"] });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)));
const t = { start: Date.now() };
const at = () => Math.round((Date.now() - t.start) / 100) / 10;
const result = { mode, startedAt: new Date().toISOString(), steps: [], transcript: [], consoleErrors };
const step = (what, extra = {}) => {
  result.steps.push({ at: at(), what, ...extra });
  console.log(`${String(at()).padStart(5)} s  ${what}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ""}`);
};

try {
  await page.goto(`${WEB}/login`);
  await page.getByLabel("Username").fill(RESIDENT);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.goto(`${WEB}/my/report`);
  await page.getByRole("tab", { name: "Talk to Relay" }).click();
  step("voice tab open");
  t.start = Date.now();
  await page.getByRole("button", { name: "Start talking" }).click();
  await page.getByText(/^(Listening|Relay is speaking)$/).waitFor({ timeout: 30_000 });
  step("connected");
  const bubbles = page.locator('[aria-live="polite"] p.rounded-lg');
  await bubbles.first().waitFor({ timeout: 30_000 });
  step("first agent line", { text: await bubbles.first().innerText() });

  if (mode === "connect") {
    await page.waitForTimeout(4000);
  } else {
    const saved = page.getByText(/Your report is saved as RLY-\d{4}/);
    await saved.waitFor({ timeout: 120_000 });
    step("filed", { notice: (await saved.innerText()).slice(0, 300) });
    await page.waitForTimeout(8000); // the agent reads the result out
  }
  result.transcript = await bubbles.evaluateAll((els) => els.map((e) => ({ who: e.className.includes("ml-auto") ? "resident" : "relay", text: e.textContent })));
  const end = page.getByRole("button", { name: "End call" });
  if (await end.isVisible()) await end.click();
  await page.getByText("Not connected").waitFor({ timeout: 15_000 });
  step("call ended");
  await page.waitForTimeout(1500); // the end event reaches Relay
  await page.screenshot({ path: outFile.replace(/\.json$/, ".png"), fullPage: true });

  // What Relay recorded, from the server's side.
  const after = (await op(resident, "getMyCases")).filter((c) => !before.has(c.id));
  result.newCases = after.map((c) => ({ ref: c.ref, category: c.category, severity: c.severity, status: c.status, title: c.title }));
  if (after[0]) {
    const k = await op(manager, "getCase", { caseId: after[0].id });
    result.case = { ref: k.ref, channel: k.channel, description: k.description, category: k.category, severity: k.severity, emergency: k.emergency, status: k.status, triageSource: k.triageSource, reported: k.events.find((e) => e.type === "REPORTED")?.message };
  }
  const cc = await op(manager, "getCommandCenter");
  result.unfinishedVoice = cc.unfinishedChats.filter((u) => u.channel === "VOICE").map((u) => ({ resident: u.residentName, reason: u.reason, words: u.words.slice(0, 200) }));
  step("checked Relay", { newCases: result.newCases.length, unfinishedVoice: result.unfinishedVoice.length });
  result.ok = mode === "connect" ? result.newCases.length === 0 : result.newCases.length === 1 && result.case?.channel === "VOICE";
} catch (e) {
  result.ok = false;
  result.error = String(e?.message ?? e).slice(0, 500);
  step("failed", { error: result.error });
  await page.screenshot({ path: outFile.replace(/\.json$/, ".png"), fullPage: true }).catch(() => {});
} finally {
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  await browser.close();
}
console.log(result.ok ? "OK" : "NOT OK");
process.exit(result.ok ? 0 : 1);
