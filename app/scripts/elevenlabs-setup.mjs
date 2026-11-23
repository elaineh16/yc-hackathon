// Creates or updates the ElevenLabs side of Relay through the official API. Safe to re-run (idempotent):
//   1. workspace secret  relay_tool_secret   = RELAY_TOOL_SECRET
//   2. webhook tool      save_work_order     -> POST {public url}/api/relay/intake, header X-Relay-Secret
//   3. agent             "Relay intake (webhook)" with the prompt below, private (server-issued tokens only)
//   4. writes EL_AGENT_INTAKE_ID into .env.server
// It never prints a key or secret, and it never touches any other agent or tool in the workspace.
//
// Usage (from dashboard/):  node scripts/elevenlabs-setup.mjs --public-url https://xxxx.trycloudflare.com
//   --env <path>     env file to read and update (default ./.env.server)
//   --check          only report what exists; change nothing
import { readFileSync, writeFileSync } from "node:fs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const ENV_PATH = arg("--env") ?? ".env.server";
const CHECK = process.argv.includes("--check");
const PUBLIC_URL = (arg("--public-url") ?? "").replace(/\/+$/, "");

const AGENT_NAME = "Relay intake (webhook)";
const TOOL_NAME = "save_work_order";
const SECRET_NAME = "relay_tool_secret";

const envText = readFileSync(ENV_PATH, "utf8");
const env = Object.fromEntries(
  envText.split(/\r?\n/).map((l) => l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]),
);
const fail = (msg) => {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
};
if (!env.ELEVENLABS_API_KEY) fail(`ELEVENLABS_API_KEY is empty in ${ENV_PATH}`);
if (!env.RELAY_TOOL_SECRET) fail(`RELAY_TOOL_SECRET is empty in ${ENV_PATH}`);
if (!CHECK && !/^https:\/\//.test(PUBLIC_URL)) fail("--public-url https://... is required (ElevenLabs must reach the intake endpoint over HTTPS)");

async function el(method, path, body) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    method,
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    // Error bodies describe the request, not the credentials; still strip our secrets to be safe.
    const safe = text.split(env.ELEVENLABS_API_KEY).join("<key>").split(env.RELAY_TOOL_SECRET).join("<secret>").slice(0, 900);
    fail(`${method} ${path} -> ${res.status} ${safe}`);
  }
  return json;
}

const PROMPT = `You are Relay, an AI assistant that helps university residence students report maintenance problems. Always be clear that you are an AI assistant.

Goal: understand one problem, read it back, and save one work order with the save_work_order tool.

Collect these details, asking only for what is missing, in at most three short questions:
1. Which residence, which laundry room, and which machine number.
2. What is wrong.
3. Whether water is on the floor or staying inside the drum, and what code the display shows, if any.

Context that helps you hear students correctly: residences are known by short codes such as "MKV". Washer displays show short error codes such as "OE", "LE", "UE" or "dE". Use the code exactly as the student says it. A code is a reported symptom only: never diagnose the machine or say what part is broken.

Before saving, read back the residence, room and machine, the floor status and the code in one sentence, and let the student correct anything. If they correct something, read the corrected details back once.

Then call save_work_order exactly once. Wait for its result:
- If it returns ok true, say what its "message" tells you to say: the report is saved, leave the washer door closed, residence staff have been asked to help, and check this page for updates.
- If it returns ok false or fails, follow its "message". Never say the report was saved. Apologize and tell the student to report it at the residence front desk.

Safety: if the student mentions water on the floor, smoke, sparks, a burning smell, or that they feel unsafe, tell them to stay away from the machine and contact residence staff right away, then call save_work_order with safety_hazard true and stop the normal flow.

Never promise prices, repair times, contractor names or approvals; the page shows those updates. Keep every turn to one or two short sentences.`;

const FIRST_MESSAGE = "Hi, I'm Relay, an AI assistant for residence maintenance. What's going on?";

const str = (description) => ({ type: "string", description });
const toolConfig = (secretId) => ({
  type: "webhook",
  name: TOOL_NAME,
  description:
    "Save the student's maintenance report as a work order. Call it exactly once, after reading the details back to the student. The report is saved only if the result has ok true.",
  response_timeout_secs: 20,
  api_schema: {
    url: `${PUBLIC_URL}/api/relay/intake`,
    method: "POST",
    request_headers: { "X-Relay-Secret": { secret_id: secretId } },
    request_body_schema: {
      type: "object",
      required: ["demo_session_id", "residence", "room", "washer", "symptom", "floor_status", "safety_hazard"],
      properties: {
        demo_session_id: { type: "string", dynamic_variable: "demo_session_id" },
        conversation_id: { type: "string", dynamic_variable: "system__conversation_id" },
        residence: str("Residence name or code exactly as the student said it, for example MKV"),
        room: str("Room or area, for example main laundry room"),
        washer: str("Machine number, for example 2"),
        symptom: str("What is wrong, in one short sentence in the student's words"),
        floor_status: {
          type: "string",
          description: "dry if the water is staying inside the machine, wet if water is on the floor, unknown if the student does not know",
          enum: ["dry", "wet", "unknown"],
        },
        error_code: str("Code shown on the display exactly as reported, for example OE. Use the word none if there is no code."),
        safety_hazard: {
          type: "boolean",
          description: "true only if the student reports water on the floor, smoke, sparks, a burning smell or feeling unsafe",
        },
        hazard_details: str("One short sentence describing the hazard, or the word none"),
      },
    },
  },
});

const agentBody = (toolId) => ({
  name: AGENT_NAME,
  conversation_config: {
    agent: {
      first_message: FIRST_MESSAGE,
      language: "en",
      // The student page passes the real value when it starts the session; this is only the dashboard test default.
      dynamic_variables: { dynamic_variable_placeholders: { demo_session_id: "dashboard-test-session" } },
      prompt: { prompt: PROMPT, llm: process.env.EL_LLM || "claude-sonnet-4-6", temperature: 0, tool_ids: [toolId] },
    },
    asr: { keywords: ["MKV", "OE", "washer", "laundry room"] },
  },
  // Private agent: a conversation can start only with a token issued by our server.
  platform_settings: { auth: { enable_auth: true } },
});

// ---------- 1. secret ----------
const secrets = (await el("GET", "/v1/convai/secrets")).secrets ?? [];
let secret = secrets.find((s) => s.name === SECRET_NAME);
// ---------- 2. tool ----------
const tools = (await el("GET", "/v1/convai/tools")).tools ?? [];
let tool = tools.find((t) => t.tool_config?.type === "webhook" && t.tool_config?.name === TOOL_NAME);
// ---------- 3. agent ----------
const agents = (await el("GET", "/v1/convai/agents?page_size=100")).agents ?? [];
let agent = agents.find((a) => a.name === AGENT_NAME);

if (CHECK) {
  console.log(`secret ${SECRET_NAME}: ${secret ? `exists (${secret.secret_id})` : "missing"}`);
  console.log(`tool ${TOOL_NAME}: ${tool ? `exists (${tool.id}) -> ${tool.tool_config.api_schema?.url}` : "missing"}`);
  console.log(`agent "${AGENT_NAME}": ${agent ? `exists (${agent.agent_id})` : "missing"}`);
  console.log(`other agents in the workspace (left untouched): ${agents.filter((a) => a.name !== AGENT_NAME).map((a) => a.name).join(", ") || "none"}`);
  console.log(`EL_AGENT_INTAKE_ID in ${ENV_PATH}: ${env.EL_AGENT_INTAKE_ID ? (env.EL_AGENT_INTAKE_ID === agent?.agent_id ? "matches" : "DIFFERENT from the agent above") : "empty"}`);
  process.exit(0);
}

if (secret) {
  await el("PATCH", `/v1/convai/secrets/${secret.secret_id}`, { type: "update", name: SECRET_NAME, value: env.RELAY_TOOL_SECRET });
  console.log(`secret ${SECRET_NAME}: updated to match RELAY_TOOL_SECRET`);
} else {
  secret = await el("POST", "/v1/convai/secrets", { type: "new", name: SECRET_NAME, value: env.RELAY_TOOL_SECRET });
  console.log(`secret ${SECRET_NAME}: created`);
}

if (tool) {
  await el("PATCH", `/v1/convai/tools/${tool.id}`, { tool_config: toolConfig(secret.secret_id) });
  console.log(`tool ${TOOL_NAME}: updated -> ${PUBLIC_URL}/api/relay/intake`);
} else {
  tool = await el("POST", "/v1/convai/tools", { tool_config: toolConfig(secret.secret_id) });
  console.log(`tool ${TOOL_NAME}: created -> ${PUBLIC_URL}/api/relay/intake`);
}

if (agent) {
  const { name, ...rest } = agentBody(tool.id);
  await el("PATCH", `/v1/convai/agents/${agent.agent_id}`, { name, ...rest });
  console.log(`agent "${AGENT_NAME}": updated (${agent.agent_id})`);
} else {
  agent = await el("POST", "/v1/convai/agents/create", agentBody(tool.id));
  console.log(`agent "${AGENT_NAME}": created (${agent.agent_id})`);
}

// ---------- 4. env file ----------
if (env.EL_AGENT_INTAKE_ID !== agent.agent_id) {
  const line = `EL_AGENT_INTAKE_ID=${agent.agent_id}`;
  const next = /^EL_AGENT_INTAKE_ID=.*$/m.test(envText) ? envText.replace(/^EL_AGENT_INTAKE_ID=.*$/m, line) : `${envText.replace(/\n*$/, "\n")}${line}\n`;
  writeFileSync(ENV_PATH, next);
  console.log(`EL_AGENT_INTAKE_ID written to ${ENV_PATH} (restart the server to load it)`);
} else {
  console.log("EL_AGENT_INTAKE_ID already set");
}
