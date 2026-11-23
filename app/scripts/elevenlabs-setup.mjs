// Configures the ElevenLabs voice agent for Relay through the official API. Safe to re-run (idempotent).
//   1. client tool "submit_report": runs in the resident's signed-in browser, which calls Relay's
//      submitVoiceReport action. No public URL or shared webhook secret is needed.
//   2. agent "Relay voice intake": private (only server-issued tokens can start a session), with the prompt below
//      and the resident's name, property and unit passed in as dynamic variables.
//   3. writes EL_AGENT_INTAKE_ID into .env.server.
// It never prints a key, and it never touches other agents or tools in the workspace.
//
// Usage (from app/):  node scripts/elevenlabs-setup.mjs            (or --check to only report)
import { readFileSync, writeFileSync } from "node:fs";

const ENV_PATH = process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : ".env.server";
const CHECK = process.argv.includes("--check");
const AGENT_NAMES = ["Relay voice intake", "Relay intake (webhook)"]; // the second is the hackathon name, renamed on update
const TOOL_NAME = "submit_report";

const envText = readFileSync(ENV_PATH, "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim().replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2")]),
);
if (!env.ELEVENLABS_API_KEY) {
  console.error(`ERROR: ELEVENLABS_API_KEY is empty in ${ENV_PATH}`);
  process.exit(1);
}

async function el(method, path, body) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    method,
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`ERROR: ${method} ${path} -> ${res.status} ${text.split(env.ELEVENLABS_API_KEY).join("<key>").slice(0, 800)}`);
    process.exit(1);
  }
  return text ? JSON.parse(text) : {};
}
async function listAll(path, key) {
  const all = [];
  for (let cursor = null; ; ) {
    const page = await el("GET", `${path}${path.includes("?") ? "&" : "?"}page_size=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    all.push(...(page[key] ?? []));
    if (!page.has_more || !page.next_cursor) return all;
    cursor = page.next_cursor;
  }
}

const PROMPT = `You are Relay, an AI assistant that helps residents report maintenance problems at {{property_name}}. You are talking with {{resident_name}}, who lives in unit {{unit_label}}. Always be clear that you are an AI assistant.

Goal: understand one problem well enough for the property manager to act, then file it with the submit_report tool.

How to work:
- Listen to the resident's own description. Ask only for what is still unknown, one or two short questions at a time. Do not run through a fixed list.
- What usually matters: where exactly the problem is, what it is doing, since when, and whether it is getting worse. For water: is it leaking now, is it spreading, is it near anything electrical. For appliances: which one, what it does, any error code. For heating and cooling: is it out completely, and is anyone at home at particular risk from the temperature.
- Always check for danger: gas smell, smoke, sparks, burning, water near electrics, flooding. If there is danger, tell them to get to safety and call 911 if anyone is at risk, then file the report straight away and list each danger in safety_concerns.
- Before filing a non-emergency, read the key details back in one sentence and get their confirmation.
- Put the resident's own description in "description", in their words.
- Call submit_report once. Then say exactly what its result says. If the result says the report was NOT saved, say so and suggest the form on the page. Never say a report is saved unless the tool result says so.
- Never diagnose the cause, and never promise a time, price, vendor or approval. Keep each turn to one or two short sentences.`;

const FIRST_MESSAGE = "Hi {{resident_name}}, I'm Relay, an AI assistant for {{property_name}}. What's going on?";

const s = (description, extra = {}) => ({ type: "string", description, ...extra });
const TOOL = {
  type: "client",
  name: TOOL_NAME,
  description: "File the resident's maintenance report with the property manager. Call it once, after confirming the details (or at once for an emergency). The result says whether it was saved.",
  expects_response: true,
  response_timeout_secs: 30,
  parameters: {
    type: "object",
    required: ["description", "category", "severity", "title", "summary", "rationale"],
    properties: {
      description: s("The resident's own description of the problem, in their words"),
      category: s("PLUMBING, APPLIANCE, HVAC, or OTHER if it fits none of them", { enum: ["PLUMBING", "APPLIANCE", "HVAC", "OTHER"] }),
      severity: s("EMERGENCY if anyone or the building may be in danger now; URGENT if it is getting worse or blocks daily life; otherwise ROUTINE", { enum: ["EMERGENCY", "URGENT", "ROUTINE"] }),
      title: s("A short title, at most eight words"),
      summary: s("Two or three sentences with everything you learned"),
      rationale: s("One sentence: why this category and severity"),
      safety_concerns: { type: "array", description: "Each danger the resident mentioned; leave empty if none", items: { type: "string", description: "One danger" } },
      needs_human_review: { type: "boolean", description: "true if you are unsure what this is or who should handle it" },
      permission_to_enter: { type: "boolean", description: "Whether the resident allows entry when they are not home" },
      access_notes: s("Pets, times to avoid, entry instructions; leave empty if none"),
    },
  },
};

const tools = await listAll("/v1/convai/tools", "tools");
let tool = tools.find((t) => t.tool_config?.type === "client" && t.tool_config?.name === TOOL_NAME);
const agents = await listAll("/v1/convai/agents", "agents");
let agent = AGENT_NAMES.map((n) => agents.find((a) => a.name === n)).find(Boolean);

if (CHECK) {
  console.log(`client tool ${TOOL_NAME}: ${tool ? `exists (${tool.id})` : "missing"}`);
  console.log(`agent: ${agent ? `${agent.name} (${agent.agent_id})` : "missing"}`);
  console.log(`EL_AGENT_INTAKE_ID in ${ENV_PATH}: ${env.EL_AGENT_INTAKE_ID ? (env.EL_AGENT_INTAKE_ID === agent?.agent_id ? "matches" : "DIFFERENT") : "empty"}`);
  process.exit(0);
}

if (tool) {
  await el("PATCH", `/v1/convai/tools/${tool.id}`, { tool_config: TOOL });
  console.log(`client tool ${TOOL_NAME}: updated`);
} else {
  tool = await el("POST", "/v1/convai/tools", { tool_config: TOOL });
  console.log(`client tool ${TOOL_NAME}: created`);
}

const body = {
  name: "Relay voice intake",
  conversation_config: {
    agent: {
      first_message: FIRST_MESSAGE,
      language: "en",
      dynamic_variables: { dynamic_variable_placeholders: { resident_name: "there", property_name: "your building", unit_label: "your unit" } },
      prompt: { prompt: PROMPT, llm: "claude-sonnet-4-6", temperature: 0, tool_ids: [tool.id] },
    },
    asr: { keywords: ["Relay", "washer", "dryer", "dishwasher", "radiator", "thermostat", "furnace"] },
  },
  platform_settings: { auth: { enable_auth: true } },
};
if (agent) {
  await el("PATCH", `/v1/convai/agents/${agent.agent_id}`, body);
  console.log(`agent: updated (${agent.agent_id})`);
} else {
  agent = await el("POST", "/v1/convai/agents/create", body);
  console.log(`agent: created (${agent.agent_id})`);
}

if (env.EL_AGENT_INTAKE_ID !== agent.agent_id) {
  const line = `EL_AGENT_INTAKE_ID=${agent.agent_id}`;
  writeFileSync(ENV_PATH, /^EL_AGENT_INTAKE_ID=.*$/m.test(envText) ? envText.replace(/^EL_AGENT_INTAKE_ID=.*$/m, line) : `${envText.replace(/\n*$/, "\n")}${line}\n`);
  console.log(`EL_AGENT_INTAKE_ID written to ${ENV_PATH} (restart the server to load it)`);
} else {
  console.log("EL_AGENT_INTAKE_ID already set");
}
