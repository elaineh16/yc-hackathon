// TraceRoot spans for the Relay workflow (docs/TRACEROOT.md). Fail open: with no TRACEROOT_API_KEY, or if the
// SDK throws anywhere, the workflow runs exactly the same. Only synthetic ids, outcomes and reason codes are
// recorded: never audio, transcripts, secrets, credentials or authorization headers.
import type { Span } from "@traceroot-ai/traceroot";

type Sdk = typeof import("@traceroot-ai/traceroot");
let sdk: Sdk | null = null;

export type Attrs = Record<string, string | number | boolean | null | undefined>;

/** Called once from the Wasp server setupFn. */
export async function initTracing() {
  const apiKey = process.env.TRACEROOT_API_KEY;
  if (!apiKey) {
    console.log("[traceroot] TRACEROOT_API_KEY not set: tracing disabled");
    return;
  }
  try {
    const mod = await import("@traceroot-ai/traceroot");
    mod.initialize({ apiKey, baseUrl: process.env.TRACEROOT_HOST_URL || undefined, instrumentModules: {} });
    sdk = mod;
    console.log("[traceroot] tracing enabled");
  } catch (e) {
    console.warn("[traceroot] init failed; continuing without tracing:", e instanceof Error ? e.message : e);
  }
}

const clean = (a: Attrs) => {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(a)) if (v !== null && v !== undefined) out[`relay.${k}`] = v;
  return out;
};
const quiet = (f: () => unknown) => {
  try {
    f();
  } catch {
    /* tracing must never break the workflow */
  }
};
/** A safe reason code for a failure: an HTTP status or an error code, never a message with user data. */
const reason = (e: unknown) => {
  const x = e as { statusCode?: number; status?: number; code?: string };
  return String(x?.statusCode ?? x?.status ?? x?.code ?? "error");
};

/** Runs fn inside a span. The span records ok/error; fn's result and errors pass through untouched. */
export async function traced<T>(name: string, attrs: Attrs, fn: () => Promise<T>, done?: (r: T) => Attrs): Promise<T> {
  let span: Span | null = null;
  if (sdk) {
    try {
      span = sdk.startSpan({ name, type: name === "relay.intake.tool" ? "tool" : "span", sessionId: attrs.demoSessionId ? String(attrs.demoSessionId) : undefined, attributes: clean(attrs) });
    } catch {
      span = null;
    }
  }
  if (!span || !sdk) return fn();
  const s = span;
  try {
    const r = await sdk.usingSpan(s, fn);
    quiet(() => s.update({ attributes: clean({ outcome: "ok", ...(done ? done(r) : {}) }) }));
    return r;
  } catch (e) {
    quiet(() => s.setError(e));
    quiet(() => s.update({ attributes: clean({ outcome: "error", reason: reason(e) }) }));
    throw e;
  } finally {
    quiet(() => s.end());
  }
}

/** A point-in-time span for a decision that has no work of its own (e.g. a guard or a classification). */
export function mark(name: string, attrs: Attrs) {
  if (!sdk) return;
  quiet(() => sdk!.startSpan({ name, sessionId: attrs.demoSessionId ? String(attrs.demoSessionId) : undefined, attributes: clean(attrs) }).end());
}
