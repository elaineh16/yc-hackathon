// One capped, explicit live validation of the Fiber AI integration. Spends at most one search (2 credits, documented
// price) and only when you pass --yes. Steps:
//   1. the free balance check (GET /v1/get-org-credits): refuses if the balance minus the search would go below the
//      reserve (FIBER_MIN_BALANCE, default 10);
//   2. exactly one POST /v1/google-maps/search for "heating and cooling contractor" near "Waterloo, ON" (no resident data);
//   3. records the response's chargeInfo, warnings and advice verbatim, and keeps at most 3 businesses (name,
//      categories, whether a phone or website is listed) in ../docs/evidence/fiber-live-check.json.
// The key is read from the environment (app/.env.server via the shell) and is never printed or written anywhere.
// Run from app/: set -a; . ./.env.server; set +a; npx tsx scripts/fiber-live-check.ts [--yes]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { creditsCharged, fiberConfig, fiberCredits, fiberSearchPlaces } from "../src/server/vendors/fiber";

const cfg = fiberConfig();
if (cfg.mode !== "live" && cfg.mode !== "sandbox") {
  console.error(`Fiber is in "${cfg.mode}" mode. Set FIBER_API_KEY (and unset FIBER_MODE) to run the live check.`);
  process.exit(2);
}
const before = await fiberCredits();
if (!before.ok) {
  console.error(`Balance check failed: ${before.code}: ${before.message}`);
  process.exit(1);
}
const cost = cfg.mode === "sandbox" ? 0 : cfg.creditsPerSearch;
console.log(`Mode: ${cfg.mode}. Available credits: ${before.available} (of ${before.max}). This check spends at most ${cost}. Reserve kept: ${cfg.minBalance}.`);
if (cost > 0 && before.available - cost < cfg.minBalance) {
  console.error("Not enough credits above the reserve. No search was made.");
  process.exit(1);
}
if (!process.argv.includes("--yes")) {
  console.log("Dry run: pass --yes to make the one search.");
  process.exit(0);
}
const query = "heating and cooling contractor";
const location = "Waterloo, ON";
const started = Date.now();
const res = await fiberSearchPlaces(query, location);
const after = await fiberCredits();
const out = res.ok
  ? {
      at: new Date().toISOString(),
      mode: cfg.mode,
      request: { endpoint: "POST /v1/google-maps/search (SDK googleMapsSearch2)", query, location },
      httpStatus: res.httpStatus,
      sandbox: res.sandbox,
      durationMs: Date.now() - started,
      chargeInfo: res.chargeInfo,
      creditsCharged: creditsCharged(res.chargeInfo),
      warnings: res.warnings,
      advice: res.advice,
      placesReturned: res.places.length,
      keptForEvidence: res.places.slice(0, 3).map((p) => ({ name: p.name, categories: p.categories, phoneListed: !!p.phoneNumber, websiteListed: !!p.websiteUrl, hasCoordinates: !!p.coordinates })),
      balanceBefore: before.available,
      balanceAfter: after.ok ? after.available : null,
    }
  : { at: new Date().toISOString(), mode: cfg.mode, request: { query, location }, error: { code: res.code, message: res.message, httpStatus: res.httpStatus } };
const file = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "docs", "evidence", "fiber-live-check.json");
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
