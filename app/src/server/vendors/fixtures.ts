// Fixture responses for Fiber AI's POST /v1/google-maps/search, used by automated tests and by demos without a key.
// They follow the response shape in the official SDK's types (@fiberai/sdk, GoogleMapsSearch2Responses) exactly, but
// every business here is FICTIONAL: invented names, 555 phone numbers, .example websites. They are labelled as
// fixtures everywhere they surface (mode "fixture", chargeInfo method "free" with a message saying no call was made).
// A live response is never stored here.
//
// Scenarios (set with FIBER_FIXTURE_SCENARIO or the test hook): normal, empty, down, exhausted, exhausted_mid,
// rate_limited, server_error, invalid_key, slow.

type Place = {
  placeId: string;
  name: string;
  url: string;
  rating?: number | null;
  reviewCount?: number | null;
  phoneNumber?: string | null;
  websiteUrl?: string | null;
  address?: string | null;
  categories: string[];
  openingHours: { dayOfWeek: "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday"; hours: string }[];
  coordinates?: { latitude: number; longitude: number } | null;
  thumbnailUrl?: string | null;
};

const weekdays = (hours: string): Place["openingHours"] => (["monday", "tuesday", "wednesday", "thursday", "friday"] as const).map((dayOfWeek) => ({ dayOfWeek, hours }));
const p = (id: string, name: string, o: Partial<Place>): Place => ({
  placeId: `fixture:${id}`,
  name,
  url: `https://maps.example/place/fixture-${id}`,
  rating: null,
  reviewCount: null,
  phoneNumber: null,
  websiteUrl: null,
  address: null,
  categories: [],
  openingHours: [],
  coordinates: null,
  thumbnailUrl: null,
  ...o,
});

// Keyed by a word in the query Relay sends (see TRADE_NOUN in shared/domain.ts).
const PLACES: Record<string, Place[]> = {
  heating: [
    p("hvac-1", "Grand River Heating & Air", { rating: 4.7, reviewCount: 212, phoneNumber: "+15195550111", websiteUrl: "https://grandriverheating.example", address: "410 King St N, Waterloo, ON", categories: ["HVAC contractor", "Air conditioning contractor"], openingHours: weekdays("7 AM–6 PM"), coordinates: { latitude: 43.4801, longitude: -80.5262 } }),
    p("hvac-2", "Evergreen Heating & Cooling", { rating: 4.5, reviewCount: 96, phoneNumber: "+15195550193", address: "88 Erb St W, Waterloo, ON", categories: ["Heating contractor", "Air conditioning repair service"], openingHours: weekdays("8 AM–5 PM"), coordinates: { latitude: 43.4634, longitude: -80.5301 } }),
    p("hvac-3", "Laurier Climate Services", { rating: 4.4, reviewCount: 88, phoneNumber: "+15195550127", address: "250 Columbia St W, Waterloo, ON", categories: ["Heating contractor", "Furnace repair service"], openingHours: weekdays("8 AM–4:30 PM"), coordinates: { latitude: 43.4795, longitude: -80.5551 } }),
    p("hvac-4", "Kitchener Comfort Pros", { rating: 3.9, reviewCount: 14, address: "1 Victoria St S, Kitchener, ON", categories: ["Air conditioning repair service"], coordinates: { latitude: 43.4497, longitude: -80.4951 } }),
    p("hvac-5", "Waterloo Park", { rating: 4.8, reviewCount: 5120, address: "50 Young St W, Waterloo, ON", categories: ["Park", "Tourist attraction"], coordinates: { latitude: 43.4664, longitude: -80.5281 } }),
    p("hvac-6", "Lakeshore Mechanical Air", { rating: 4.6, reviewCount: 340, phoneNumber: "+14165550188", websiteUrl: "https://lakeshoremechanical.example", address: "1200 Queen St E, Toronto, ON", categories: ["HVAC contractor"], openingHours: weekdays("24 hours"), coordinates: { latitude: 43.6629, longitude: -79.3317 } }),
    p("hvac-7", "Bright Plumbing Supply", { rating: 4.2, reviewCount: 61, phoneNumber: "+15195550170", address: "75 Bridgeport Rd E, Waterloo, ON", categories: ["Plumbing supply store"], coordinates: { latitude: 43.4692, longitude: -80.5176 } }),
  ],
  electrician: [
    p("elec-1", "Uptown Electric Co.", { rating: 4.8, reviewCount: 154, phoneNumber: "+15195550142", websiteUrl: "https://uptownelectric.example", address: "15 Regina St N, Waterloo, ON", categories: ["Electrician"], openingHours: weekdays("7:30 AM–5 PM"), coordinates: { latitude: 43.4668, longitude: -80.5221 } }),
    p("elec-2", "Spark & Wire Services", { rating: 4.3, reviewCount: 41, phoneNumber: "+15195550158", address: "330 Phillip St, Waterloo, ON", categories: ["Electrician", "Lighting contractor"], openingHours: weekdays("8 AM–6 PM"), coordinates: { latitude: 43.4774, longitude: -80.5466 } }),
    p("elec-3", "Conestoga Electrical Contractors", { rating: 4.6, reviewCount: 77, websiteUrl: "https://conestogaelectrical.example", address: "550 Weber St N, Waterloo, ON", categories: ["Electrical installation service"], coordinates: { latitude: 43.4905, longitude: -80.5268 } }),
  ],
  locksmith: [
    p("lock-1", "Keyline Locksmiths", { rating: 4.9, reviewCount: 203, phoneNumber: "+15195550133", websiteUrl: "https://keyline.example", address: "22 King St S, Waterloo, ON", categories: ["Locksmith"], openingHours: weekdays("24 hours"), coordinates: { latitude: 43.4635, longitude: -80.5224 } }),
    p("lock-2", "Twin City Lock & Door", { rating: 4.1, reviewCount: 35, phoneNumber: "+15195550161", address: "400 Weber St E, Kitchener, ON", categories: ["Locksmith", "Door supplier"], coordinates: { latitude: 43.4581, longitude: -80.4785 } }),
  ],
  elevator: [
    p("elev-1", "Regional Elevator Service", { rating: 4.4, reviewCount: 19, phoneNumber: "+15195550104", websiteUrl: "https://regionalelevator.example", address: "180 Northfield Dr W, Waterloo, ON", categories: ["Elevator service"], openingHours: weekdays("24 hours"), coordinates: { latitude: 43.5003, longitude: -80.5367 } }),
  ],
  plumber: [
    p("plumb-1", "Northside Plumbing", { rating: 4.6, reviewCount: 120, phoneNumber: "+15195550141", address: "12 Northfield Dr, Waterloo, ON", categories: ["Plumber"], coordinates: { latitude: 43.4998, longitude: -80.5302 } }),
    p("plumb-2", "Riverbend Plumbing & Drain", { rating: 4.5, reviewCount: 66, phoneNumber: "+15195550186", websiteUrl: "https://riverbendplumbing.example", address: "60 Bridgeport Rd W, Waterloo, ON", categories: ["Plumber", "Drainage service"], coordinates: { latitude: 43.4701, longitude: -80.5248 } }),
  ],
  appliance: [
    p("appl-1", "Maple Leaf Appliance Repair", { rating: 4.7, reviewCount: 98, phoneNumber: "+15195550119", websiteUrl: "https://mapleleafappliance.example", address: "70 University Ave E, Waterloo, ON", categories: ["Appliance repair service"], coordinates: { latitude: 43.4748, longitude: -80.5197 } }),
  ],
};

export type FixtureScenario = "normal" | "empty" | "down" | "exhausted" | "exhausted_mid" | "rate_limited" | "server_error" | "invalid_key" | "slow";
export const FIXTURE_SCENARIOS: readonly FixtureScenario[] = ["normal", "empty", "down", "exhausted", "exhausted_mid", "rate_limited", "server_error", "invalid_key", "slow"];

let scenario: FixtureScenario | null = null;
export const setFixtureScenario = (s: FixtureScenario | null) => {
  scenario = s;
};
export const fixtureScenario = (): FixtureScenario => scenario ?? ((process.env.FIBER_FIXTURE_SCENARIO as FixtureScenario) || "normal");

/** How many calls the fixture "server" received, by path (tests assert that cached results make no new call). */
export const fixtureCalls: Record<string, number> = {};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const FREE = { method: "free", message: "Fixture response: no call was made to Fiber AI and no credits were used." };

/** A fetch implementation that answers like the documented API, for the SDK to call in fixture mode. */
export async function fixtureFetch(input: Request | string | URL): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input));
  const path = new URL(req.url).pathname;
  fixtureCalls[path] = (fixtureCalls[path] ?? 0) + 1;
  const s = fixtureScenario();
  if (s === "down") throw new TypeError("fetch failed (fixture: the API is down)");
  if (s === "invalid_key") return json(403, { statusCode: 403, error: "Forbidden", message: "Invalid API key provided!" });
  if (path === "/v1/get-org-credits") {
    const available = s === "exhausted" ? 0 : 480;
    return json(200, { output: [{ organizationId: "fixture-org", subscriptionId: "fixture-sub", max: 500, used: 500 - available, available, usagePeriodResetsOn: "2026-12-01T00:00:00.000Z" }], chargeInfo: FREE });
  }
  if (path !== "/v1/google-maps/search") return json(404, { statusCode: 404, error: "Not Found", message: "Unknown fixture path." });
  if (s === "rate_limited") return json(429, { statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded. Please try again later." }, { "Retry-After": "30" });
  if (s === "server_error") return json(503, { statusCode: 503, error: "Service Unavailable", message: "The service is temporarily unavailable." });
  if (s === "exhausted" || s === "exhausted_mid") {
    return json(402, {
      statusCode: 402,
      error: "INSUFFICIENT_CREDITS",
      message: "Insufficient credits. Please top up your account.",
      outOfCreditsAlert: { getMoreCreditsUrl: "https://fiber.example/credits", message: "You are out of credits.", availableCredits: 0 },
    });
  }
  if (s === "slow") await new Promise((r) => setTimeout(r, 2500));
  const body = (await req.json().catch(() => ({}))) as { query?: string };
  const q = String(body.query ?? "").toLowerCase();
  const key = Object.keys(PLACES).find((k) => q.includes(k));
  const places = s === "empty" || !key ? [] : PLACES[key];
  return json(200, { output: { places, nextPageToken: null }, chargeInfo: FREE, warnings: null, advice: null });
}
