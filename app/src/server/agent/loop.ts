// A minimal tool-using agent loop. The model decides which tool to call; the server validates the arguments,
// runs the tool, and feeds back the real result (including errors) until the model answers in plain text.
// Every call is recorded in `steps` exactly as it happened.
import { chat, type ChatMessage, type ToolSpec } from "./llm";

export type ToolResult = { ok: boolean; [key: string]: unknown };
export type Tool<A = Record<string, unknown>> = ToolSpec & {
  /** Returns the validated arguments, or a message the model can act on. */
  validate: (args: Record<string, unknown>) => { ok: true; args: A } | { ok: false; error: string };
  run: (args: A) => Promise<ToolResult>;
  /** Ends the loop after a successful call (for example, the report was submitted). */
  terminal?: boolean;
};
export type Step = { tool: string; args: unknown; ok: boolean; result: unknown };
export type LoopResult = { text: string | null; steps: Step[]; endedBy: "answer" | "terminal_tool" | "step_limit"; terminalResult?: ToolResult };

const parseArgs = (raw: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    // Small models sometimes wrap JSON in prose or code fences.
    const m = /\{[\s\S]*\}/.exec(raw ?? "");
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
};

export async function runLoop(system: string, history: ChatMessage[], tools: Tool<any>[], maxSteps = 6): Promise<LoopResult> {
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...history];
  const steps: Step[] = [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (let i = 0; i < maxSteps; i++) {
    const reply = await chat(messages, tools);
    if (reply.toolCalls.length === 0) return { text: reply.content?.trim() || null, steps, endedBy: "answer" };
    messages.push({ role: "assistant", content: reply.content, tool_calls: reply.toolCalls });
    let terminal: ToolResult | null = null;
    for (const call of reply.toolCalls) {
      const tool = byName.get(call.function.name);
      const args = parseArgs(call.function.arguments);
      let result: ToolResult;
      if (!tool) result = { ok: false, error: `There is no tool called ${call.function.name}.` };
      else if (!args) result = { ok: false, error: "The arguments were not valid JSON. Call the tool again with a JSON object." };
      else {
        const v = tool.validate(args);
        if (!v.ok) result = { ok: false, error: v.error };
        else {
          try {
            result = await tool.run(v.args);
          } catch (e) {
            const status = (e as { statusCode?: number })?.statusCode;
            result = { ok: false, error: status && status < 500 ? (e as Error).message : "The tool failed on the server. Do not claim it worked." };
          }
        }
      }
      steps.push({ tool: call.function.name, args: args ?? call.function.arguments, ok: result.ok, result });
      messages.push({ role: "tool", tool_call_id: call.id || `call_${i}`, content: JSON.stringify(result) });
      if (tool?.terminal && result.ok) terminal = result;
    }
    // The caller words the outcome from the tool's real result, so the model cannot misreport it.
    if (terminal) return { text: reply.content?.trim() || null, steps, endedBy: "terminal_tool", terminalResult: terminal };
  }
  return { text: null, steps, endedBy: "step_limit" };
}

// ───────── small validators ─────────
export const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
export const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => {
  const s = typeof v === "string" ? v.trim().toUpperCase().replace(/[\s-]+/g, "_") : "";
  return (allowed as readonly string[]).includes(s) ? (s as T) : null;
};
export const bool = (v: unknown) => v === true || (typeof v === "string" && /^(true|yes)$/i.test(v.trim()));
/** Facts the agent recorded: short keys, short scalar values, at most 20. */
export function cleanFacts(v: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
    const key = k.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
    if (!key) continue;
    if (typeof raw === "boolean" || (typeof raw === "number" && Number.isFinite(raw))) out[key] = raw;
    else if (typeof raw === "string" && raw.trim()) out[key] = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  return out;
}
