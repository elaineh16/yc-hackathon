// TraceRoot spans for the Relay workflow. Fail open: with no TRACEROOT_API_KEY, or if the SDK throws anywhere,
// the application behaves exactly the same. Only ids, enum values, counts and reason codes are recorded:
// never report text, names, credentials, tokens or error messages.
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
    console.warn("[traceroot] init failed; continuing without tracing:", e instanceof Error ? e.name : "error");
  }
}

// Attribute values are ids, enum values and numbers. Anything else (free text a user typed) is not recorded.
const SAFE = /^[\w.,:-]{1,80}$/;
const clean = (a: Attrs) => {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(a)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && !SAFE.test(v)) continue;
    out[`relay.${k}`] = v;
  }
  return out;
};
const quiet = (f: () => unknown) => {
  try {
    f();
  } catch {
    /* tracing must never break the workflow */
  }
};
/** A failure reduced to a reason code: an HTTP status or an error code. */
const reason = (e: unknown) => {
  const x = e as { statusCode?: number; status?: number; code?: string };
  return String(x?.statusCode ?? x?.status ?? x?.code ?? "error");
};
/** The error as class name plus reason code; its message and stack stay out of the trace. */
const safeError = (e: unknown) => {
  const x = new Error(reason(e));
  x.name = e instanceof Error ? e.name : "Error";
  x.stack = undefined;
  return x;
};

/** Runs fn inside a span. The span records ok or the reason code; fn's result and errors pass through untouched. */
export async function traced<T>(name: string, attrs: Attrs, fn: () => Promise<T>, done?: (r: T) => Attrs): Promise<T> {
  let span: Span | null = null;
  if (sdk) {
    try {
      span = sdk.startSpan({ name, type: "span", attributes: clean(attrs) });
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
    quiet(() => s.setError(safeError(e)));
    quiet(() => s.update({ attributes: clean({ outcome: "error", reason: reason(e) }) }));
    throw e;
  } finally {
    quiet(() => s.end());
  }
}

/** A point-in-time span for a decision that has no work of its own (a transition, a guard). */
export function mark(name: string, attrs: Attrs) {
  if (!sdk) return;
  quiet(() => sdk!.startSpan({ name, attributes: clean(attrs) }).end());
}
