// Fiber AI, through its official TypeScript SDK (@fiberai/sdk). Relay uses two documented operations:
//   googleMapsSearch2  POST /v1/google-maps/search   body { apiKey, query, location?, nextPageToken? }
//                      -> { output: { places[], nextPageToken }, chargeInfo, warnings, advice }   (2 credits per search)
//   getOrgCredits      GET  /v1/get-org-credits      query { apiKey } -> { output: [{ available, max, used, ... }] } (free)
// Sources: https://api.fiber.ai/llms.txt, https://docs.fiber.ai/build, https://docs.fiber.ai/build/sdks, and the SDK's
// generated types (GoogleMapsSearch2Data / GoogleMapsSearch2Responses / GetOrgCreditsResponses).
//
// The key is read only here, on the server. It is sent in the request body as the SDK requires, and it is never
// logged, stored, returned to a browser or included in an error message.
import { getOrgCredits, googleMapsSearch2 } from "@fiberai/sdk";
import { fixtureFetch } from "./fixtures";

export type FiberMode = "live" | "sandbox" | "fixture" | "off";

export const fiberConfig = () => {
  const key = process.env.FIBER_API_KEY?.trim() || "";
  const forced = process.env.FIBER_MODE?.trim().toLowerCase();
  const mode: FiberMode = forced === "fixture" ? "fixture" : forced === "off" ? "off" : key ? (key.startsWith("sk_test_") ? "sandbox" : "live") : "off";
  const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    mode,
    hasKey: key.length > 0,
    /** Documented price of one sync Google Maps search. Checked against the balance before any paid call. */
    creditsPerSearch: num(process.env.FIBER_CREDITS_PER_SEARCH, 2),
    /** Never spend more than this per UTC day across all searches. */
    dailyCreditBudget: num(process.env.FIBER_DAILY_CREDIT_BUDGET, 6),
    /** Keep at least this many credits in the account: no search if it would go below. */
    minBalance: num(process.env.FIBER_MIN_BALANCE, 10),
    /** Candidates kept per search (the API returns up to 20 places per page for the same price). */
    maxCandidates: Math.max(1, Math.min(num(process.env.FIBER_MAX_CANDIDATES, 3), 10)),
    cacheDays: num(process.env.FIBER_CACHE_DAYS, 14),
    timeoutMs: num(process.env.FIBER_TIMEOUT_MS, 20_000),
    maxAttempts: 3,
  };
};

const apiKey = () => (fiberConfig().mode === "fixture" ? "sk_test_fixture" : process.env.FIBER_API_KEY?.trim() || "");
const transport = () => (fiberConfig().mode === "fixture" ? { fetch: fixtureFetch as unknown as typeof fetch } : {});

export type FiberPlace = {
  placeId: string;
  name: string;
  url: string;
  rating?: number | null;
  reviewCount?: number | null;
  phoneNumber?: string | null;
  websiteUrl?: string | null;
  address?: string | null;
  categories: string[];
  openingHours: { dayOfWeek: string; hours: string }[];
  coordinates?: { latitude: number; longitude: number } | null;
};

export type FiberError = {
  ok: false;
  /** auth | key_limit | credits_exhausted | rate_limited | invalid_request | sandbox_unsupported | provider_error | unreachable | timeout */
  code: string;
  message: string;
  httpStatus: number | null;
  retryable: boolean;
  body?: unknown;
};
export type SearchOk = { ok: true; places: FiberPlace[]; nextPageToken: string | null; chargeInfo: unknown; warnings: unknown; advice: unknown; httpStatus: number; sandbox: boolean };

/** Maps a failed SDK call to a plain error. Never includes the request (it carries the key). */
function failure(res: { error?: unknown; response?: Response }): FiberError {
  const status = res.response?.status ?? null;
  const body = (res.error && typeof res.error === "object" ? res.error : {}) as { error?: string; message?: string };
  const tag = String(body.error ?? "");
  // Fiber's own wording is kept for managers, but anything that looks like a key or a token is removed first.
  const said = String(body.message ?? "")
    .replace(/\bsk_(live|test)_\S+/gi, "[key removed]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [removed]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[removed]")
    .slice(0, 200);
  if (status === null) {
    const name = (res.error as Error)?.name ?? "";
    const timeout = name === "TimeoutError" || name === "AbortError";
    return { ok: false, code: timeout ? "timeout" : "unreachable", message: timeout ? "Fiber AI did not answer in time." : "Fiber AI could not be reached.", httpStatus: null, retryable: true };
  }
  if (status === 402) return { ok: false, code: "credits_exhausted", message: said || "Fiber AI reports insufficient credits.", httpStatus: status, retryable: false, body: res.error };
  if (status === 403 && /CREDIT_LIMIT/.test(tag)) return { ok: false, code: "key_limit", message: said || "This API key reached its credit limit.", httpStatus: status, retryable: false };
  if (status === 401 || status === 403) return { ok: false, code: "auth", message: said || "Fiber AI rejected the API key.", httpStatus: status, retryable: false };
  if (status === 429) return { ok: false, code: "rate_limited", message: "Fiber AI rate limit reached.", httpStatus: status, retryable: true };
  if (status === 501) return { ok: false, code: "sandbox_unsupported", message: said || "This operation is not available in sandbox mode.", httpStatus: status, retryable: false };
  if (status === 400 || status === 413 || status === 422 || status === 404 || status === 409) return { ok: false, code: "invalid_request", message: said || `Fiber AI rejected the request (${status}).`, httpStatus: status, retryable: false };
  return { ok: false, code: "provider_error", message: said || `Fiber AI returned ${status}.`, httpStatus: status, retryable: status === 500 || status === 503 };
}

/** The account's remaining credits (free call). */
export async function fiberCredits(): Promise<{ ok: true; available: number; max: number; used: number; resetsOn: string | null } | FiberError> {
  const cfg = fiberConfig();
  if (cfg.mode === "off") return { ok: false, code: "not_configured", message: "No FIBER_API_KEY is set.", httpStatus: null, retryable: false };
  const res = await googleCall(() => getOrgCredits({ query: { apiKey: apiKey() }, signal: AbortSignal.timeout(cfg.timeoutMs), ...transport() } as never));
  if (!res.data) return failure(res);
  const out = ((res.data as { output?: unknown }).output ?? []) as { available?: number; max?: number; used?: number; usagePeriodResetsOn?: string }[];
  const sum = (k: "available" | "max" | "used") => out.reduce((n, s) => n + (Number(s[k]) || 0), 0);
  return { ok: true, available: sum("available"), max: sum("max"), used: sum("used"), resetsOn: out[0]?.usagePeriodResetsOn ?? null };
}

/** One page of Google Maps results for a query near a location. */
export async function fiberSearchPlaces(query: string, location: string): Promise<SearchOk | FiberError> {
  const cfg = fiberConfig();
  if (cfg.mode === "off") return { ok: false, code: "not_configured", message: "No FIBER_API_KEY is set.", httpStatus: null, retryable: false };
  const res = await googleCall(() => googleMapsSearch2({ body: { apiKey: apiKey(), query, location }, signal: AbortSignal.timeout(cfg.timeoutMs), ...transport() } as never));
  if (!res.data) return failure(res);
  const d = res.data as { output?: { places?: FiberPlace[]; nextPageToken?: string | null }; chargeInfo?: unknown; warnings?: unknown; advice?: unknown };
  return {
    ok: true,
    places: Array.isArray(d.output?.places) ? d.output!.places! : [],
    nextPageToken: d.output?.nextPageToken ?? null,
    chargeInfo: d.chargeInfo ?? null,
    warnings: d.warnings ?? null,
    advice: d.advice ?? null,
    httpStatus: res.response?.status ?? 200,
    sandbox: res.response?.headers.get("x-fiber-sandbox") === "true",
  };
}

/** The SDK returns { data, error, response } and only throws on programming errors; normalise both. */
async function googleCall(fn: () => Promise<unknown>): Promise<{ data?: unknown; error?: unknown; response?: Response }> {
  try {
    return (await fn()) as { data?: unknown; error?: unknown; response?: Response };
  } catch (e) {
    return { error: e };
  }
}

/** Credits a response says were charged, from its chargeInfo (0 for free or refunded calls). */
export function creditsCharged(chargeInfo: unknown): number {
  const c = (chargeInfo ?? {}) as { method?: string; creditsCharged?: number; creditsRefunded?: number };
  if (c.method === "charged-now" || c.method === "charged-for-async-process") return Number(c.creditsCharged) || 0;
  if (c.method === "credits-refunded") return -(Number(c.creditsRefunded) || 0);
  return 0;
}
