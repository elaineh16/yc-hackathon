// The language model Relay reasons with. Any OpenAI-compatible chat-completions endpoint works:
//   - local and free (default): Ollama, http://localhost:11434/v1, model qwen2.5:3b
//   - a hosted provider with its own key (Groq, Google AI Studio, OpenRouter, OpenAI...): set LLM_BASE_URL, LLM_MODEL, LLM_API_KEY
// When no model answers, callers get LlmUnavailable and fall back to rules or to a person. Nothing is invented.

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export class LlmUnavailable extends Error {
  constructor(public reason: string) {
    super(`AI model unavailable: ${reason}`);
  }
}

export const llmConfig = () => ({
  baseUrl: (process.env.LLM_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, ""),
  model: process.env.LLM_MODEL || "qwen2.5:3b",
  apiKey: process.env.LLM_API_KEY || "",
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 180_000,
  disabled: process.env.LLM_DISABLED === "true",
});

let health: { at: number; ok: boolean; reason: string } | null = null;

/** Is a model answering right now? Cached for 20 seconds. */
export async function llmStatus(): Promise<{ available: boolean; model: string; reason: string }> {
  const cfg = llmConfig();
  if (cfg.disabled) return { available: false, model: cfg.model, reason: "AI is turned off on this server (LLM_DISABLED=true)." };
  if (health && Date.now() - health.at < 20_000) return { available: health.ok, model: cfg.model, reason: health.reason };
  let ok = false;
  let reason = "";
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, { headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}, signal: AbortSignal.timeout(4000) });
    if (!res.ok) reason = `The model server answered ${res.status}.`;
    else {
      const body = (await res.json().catch(() => ({}))) as { data?: { id: string }[] };
      const ids = (body.data ?? []).map((m) => m.id);
      ok = ids.length === 0 || ids.some((id) => id === cfg.model || id.startsWith(`${cfg.model}:`) || cfg.model.startsWith(id));
      if (!ok) reason = `The model ${cfg.model} is not installed on the model server.`;
    }
  } catch {
    // The address stays in the server log: this reason is shown to every role and recorded on cases.
    reason = "The model server is not reachable.";
    if (!health || health.ok) console.warn(`[llm] no model server is reachable at ${cfg.baseUrl}`);
  }
  health = { at: Date.now(), ok, reason };
  return { available: ok, model: cfg.model, reason };
}

/** One chat-completions call. Throws LlmUnavailable on any transport or server failure. */
export async function chat(messages: ChatMessage[], tools: ToolSpec[], opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {}) {
  const cfg = llmConfig();
  if (cfg.disabled) throw new LlmUnavailable("turned off");
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" } : {}),
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 700,
        stream: false,
      }),
      // A caller with its own deadline (an intake turn) may allow less time than the configured limit, never more.
      signal: AbortSignal.timeout(Math.max(1_000, Math.min(cfg.timeoutMs, opts.timeoutMs ?? cfg.timeoutMs))),
    });
  } catch (e) {
    health = { at: Date.now(), ok: false, reason: "The model server stopped answering." };
    throw new LlmUnavailable((e as Error)?.name === "TimeoutError" ? "timed out" : "unreachable");
  }
  if (!res.ok) throw new LlmUnavailable(`HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] } | null;
  const message = body?.choices?.[0]?.message;
  if (!message) throw new LlmUnavailable("empty response");
  return { content: message.content ?? null, toolCalls: (message.tool_calls ?? []).filter((t) => t?.function?.name) };
}
