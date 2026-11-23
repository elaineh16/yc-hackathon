// Vendor discovery: when a property's directory has no approved vendor for a case's trade, Relay can look for local
// businesses with Fiber AI, check what came back, and put the plausible ones in front of a manager.
//
//   1. coverage check (directory.ts): any approved vendor left for this trade here? If yes, nothing to discover.
//   2. a discovery task on the case: AWAITING_MANAGER (the property asks first) or QUEUED (auto, or a manager asked).
//      One in flight per case and trade (partial unique index). A recent identical search is reused (no new call).
//   3. the job: claim (QUEUED -> RUNNING), budget and balance checks, ONE search call, the raw response saved at once.
//   4. checks on every place: a business? the right trade? inside the service area? contact details? already a vendor?
//      Plausible ones are kept (ranked, capped), with reasons and concerns built only from the source fields.
//   5. a manager rejects, shortlists, verifies (their own check, outside Relay) and finally onboards one: only then is it
//      a Vendor approved at the property, and only then can it be offered work. Nothing found is ever contacted by Relay.
// A missing key, an exhausted balance or a failed call is recorded and explained; the case is never blocked by it.
import type { Prisma } from "@prisma/client";
import { HttpError, prisma } from "wasp/server";
import { vendorDiscoveryJob } from "wasp/server/jobs";
import { caseRef, type Category, CATEGORY_SHORT, isTrade, type Trade, TRADE_NOUN } from "../../shared/domain";
import type { CandidateView, DiscoveryPanel, DiscoveryView, FiberStatus } from "../../shared/views";
import { assertCaseAccess, managedPropertyIds } from "../access";
import { type ActorCtx, addEvent, CASE_INCLUDE, faults, flagForCoordinator, isUuid, type LoadedCase, managerIds, notify, SYSTEM, type Tx, withCase } from "../cases/engine";
import { mark } from "../tracing";
import { casesWaitingFor, coverage } from "./directory";
import { creditsCharged, type FiberPlace, fiberConfig, fiberCredits, fiberSearchPlaces } from "./fiber";

const ACTIVE = ["AWAITING_MANAGER", "QUEUED", "RUNNING"] as const;

// ───────────────────────── the search Relay sends ─────────────────────────

type PropertyLike = { id: string; name: string; address: string; city: string; region: string; latitude: number | null; longitude: number | null; serviceRadiusKm: number; autoDiscovery: boolean };

/** Exactly what goes to the provider: a trade phrase and the building's city. Never a resident's name, unit or words. */
export function discoveryQuery(trade: Trade, p: PropertyLike) {
  const query = TRADE_NOUN[trade];
  const fromAddress = p.address.split(",").slice(-2).map((s) => s.trim()).filter(Boolean).join(", ");
  const location = [p.city, p.region].filter(Boolean).join(", ") || fromAddress;
  return { query, location, cacheKey: `${p.id}|${trade}|${query}|${location}`.toLowerCase() };
}

// ───────────────────────── checks on a returned place ─────────────────────────

const TRADE_MATCH: Record<Trade, RegExp> = {
  PLUMBING: /\b(plumb\w*|drain\w*|sewer|water heater)\b/i,
  APPLIANCE: /\bappliance\w*\b/i,
  HVAC: /\b(hvac|heating|air condition\w*|furnace\w*|cooling|boiler\w*|heat pump\w*|ventilat\w*)\b/i,
  ELECTRICAL: /\belectric\w*\b/i,
  ACCESS: /\b(locksmith\w*|lock\w*|door\w*|key\w*)\b/i,
  ELEVATOR: /\b(elevator\w*|lift\w*)\b/i,
};
const NOT_A_BUSINESS = /\b(park|tourist attraction|transit|station|bus stop|landmark|monument|museum|library|school|university|college|church|place of worship|government office|city hall|playground|trail|parking)\b/i;
const SELLS_ONLY = /\b(supply store|supplier|store|shop|wholesaler|outlet mall)\b/i;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(inc|ltd|llc|co|corp|corporation|company|limited|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").slice(-10);
function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

type KnownVendor = { id: string; name: string; phone: string | null; website: string | null; sourceRef: string | null };
export type Evaluated = {
  place: FiberPlace;
  keep: boolean;
  dropReason: string | null;
  categoryMatch: "strong" | "weak" | "none";
  isBusiness: boolean;
  distanceKm: number | null;
  inServiceArea: boolean | null;
  hasContact: boolean;
  duplicateOf: KnownVendor | null;
  score: number;
  recommendation: "RECOMMENDED" | "POSSIBLE" | "NOT_RECOMMENDED";
  reasons: string[];
  concerns: string[];
  missing: string[];
};

/** Deterministic checks and an assessment that cites only the place's own fields. Exported for unit tests. */
export function evaluatePlace(place: FiberPlace, trade: Trade, p: Pick<PropertyLike, "name" | "latitude" | "longitude" | "serviceRadiusKm">, known: KnownVendor[]): Evaluated {
  const cats = (place.categories ?? []).filter((c) => typeof c === "string");
  const serviceCats = cats.filter((c) => !SELLS_ONLY.test(c));
  const isBusiness = !cats.some((c) => NOT_A_BUSINESS.test(c)) && !!place.name;
  const categoryMatch: Evaluated["categoryMatch"] = serviceCats.some((c) => TRADE_MATCH[trade].test(c)) ? "strong" : TRADE_MATCH[trade].test(place.name) || cats.some((c) => TRADE_MATCH[trade].test(c)) ? "weak" : "none";
  const dist = place.coordinates && p.latitude !== null && p.longitude !== null ? distanceKm({ latitude: p.latitude, longitude: p.longitude }, place.coordinates) : null;
  const inServiceArea = dist === null ? null : dist <= p.serviceRadiusKm;
  const hasContact = !!(place.phoneNumber || place.websiteUrl);
  // The same business, not just a similar one: the same Google Maps listing or the same phone number. A matching name
  // alone is only flagged, since two businesses can share a name. Website hosts are not compared: shared hosts
  // (facebook.com, sites.google.com, a franchise domain) would merge unrelated businesses and send offers to the wrong people.
  const duplicateOf =
    known.find((v) => !!v.sourceRef && v.sourceRef === place.placeId) ?? known.find((v) => digits(v.phone).length === 10 && digits(v.phone) === digits(place.phoneNumber)) ?? null;
  const nameClash = duplicateOf ? null : (known.find((v) => norm(v.name) === norm(place.name)) ?? null);

  let dropReason: string | null = null;
  if (!isBusiness) dropReason = `Not a business (${cats.join(", ") || "no category"})`;
  else if (categoryMatch === "none") dropReason = `Wrong trade for ${CATEGORY_SHORT[trade].toLowerCase()} work (${cats.join(", ") || "no category"})`;

  const rating = typeof place.rating === "number" ? place.rating : null;
  const reviews = typeof place.reviewCount === "number" ? place.reviewCount : null;
  const reasons: string[] = [];
  const concerns: string[] = [];
  if (cats.length) reasons.push(`Listed on Google Maps as ${cats.slice(0, 3).join(", ")}.`);
  if (dist !== null) (inServiceArea ? reasons : concerns).push(`About ${dist.toFixed(1)} km from ${p.name}${inServiceArea ? "" : `, outside the ${p.serviceRadiusKm} km service area`}.`);
  else concerns.push("No map location listed, so the distance is unknown.");
  if (rating !== null && reviews !== null) (rating >= 4 ? reasons : concerns).push(`Rated ${rating} from ${reviews} Google review${reviews === 1 ? "" : "s"}.`);
  else concerns.push("No rating listed.");
  if (reviews !== null && reviews < 20) concerns.push(`Only ${reviews} review${reviews === 1 ? "" : "s"}, so the rating says little.`);
  if (place.phoneNumber && place.websiteUrl) reasons.push("Phone number and website listed.");
  else if (place.phoneNumber) reasons.push("Phone number listed.");
  else if (place.websiteUrl) reasons.push("Website listed (no phone number).");
  else concerns.push("No phone number or website listed.");
  if (categoryMatch === "weak") concerns.push(`Its listing does not clearly say it does ${CATEGORY_SHORT[trade].toLowerCase()} work.`);
  if (duplicateOf) reasons.push(`Already a vendor in Relay as ${duplicateOf.name}: approve that vendor for this property instead of adding a duplicate.`);
  if (nameClash) concerns.push(`Relay already has a vendor called ${nameClash.name}, with a different listing and phone number, so this may be a different business.`);
  if (!place.openingHours?.length) concerns.push("Opening hours not listed.");
  const missing = ["licence", "insurance", "availability", "pricing", ...(place.phoneNumber ? [] : ["phone"]), ...(place.websiteUrl ? [] : ["website"]), "email"];

  const recommendation: Evaluated["recommendation"] =
    inServiceArea === false || (rating !== null && reviews !== null && rating < 3.5 && reviews >= 10)
      ? "NOT_RECOMMENDED"
      : categoryMatch === "strong" && hasContact && (rating ?? 0) >= 4.2 && (reviews ?? 0) >= 20
        ? "RECOMMENDED"
        : "POSSIBLE";
  const score =
    (inServiceArea === false ? -100 : 0) + (categoryMatch === "strong" ? 30 : categoryMatch === "weak" ? 10 : 0) + (hasContact ? 20 : 0) + (rating ?? 0) * 4 + Math.log10(1 + (reviews ?? 0)) * 5 + (recommendation === "RECOMMENDED" ? 10 : 0);
  return { place, keep: dropReason === null, dropReason, categoryMatch, isBusiness, distanceKm: dist, inServiceArea, hasContact, duplicateOf, score, recommendation, reasons, concerns, missing };
}

// ───────────────────────── creating a discovery task ─────────────────────────

const label = (trade: Category) => (isTrade(trade) ? TRADE_NOUN[trade] : CATEGORY_SHORT[trade].toLowerCase());
const aOrAn = (s: string) => (/^[aeiou]/i.test(s) ? `an ${s}` : `a ${s}`);

export type EnsureResult = { needed: boolean; discoveryId?: string; status?: string; created?: boolean; queued?: boolean; reason?: string };

/**
 * In the case's transaction: if no approved vendor can take this case, make sure a discovery task exists.
 * `manual` means a manager asked for it (it is queued straight away); `force` skips the cache (a fresh search).
 */
export async function ensureDiscoveryTx(tx: Tx, c: LoadedCase, actor: ActorCtx, o: { manual?: boolean; force?: boolean } = {}): Promise<EnsureResult> {
  if (!isTrade(c.category)) return { needed: false, reason: `${CATEGORY_SHORT[c.category]} cases do not need a vendor search.` };
  if (c.emergency || c.status === "ESCALATED") return { needed: false, reason: "Emergencies are handled by the manager first." };
  if (!["AWAITING_ASSIGNMENT", "REOPENED", "TRIAGED"].includes(c.status)) return { needed: false, reason: `The case is not looking for a vendor (${c.status}).` };
  const cov = await coverage(tx, c);
  if (cov.usable > 0 && !o.force) return { needed: false, reason: `${cov.usable} approved vendor${cov.usable === 1 ? "" : "s"} can take it.` };
  const trade = c.category;
  const active = await tx.vendorDiscovery.findFirst({ where: { caseId: c.id, trade, status: { in: [...ACTIVE] } } });
  if (active) return { needed: true, discoveryId: active.id, status: active.status, created: false };

  const cfg = fiberConfig();
  const q = discoveryQuery(trade, c.property);
  const who = actor.kind === "MANAGER" ? actor.name : actor.kind;
  const noun = label(trade);
  const managers = await managerIds(tx, c.propertyId);
  const base = { propertyId: c.propertyId, caseId: c.id, trade, query: q.query, location: q.location, cacheKey: q.cacheKey, provider: cfg.mode === "fixture" ? "fixture" : "fiber", mode: cfg.mode, requestedBy: who, requestedById: actor.userId };

  // A recent identical search: reuse it. No new call, no credits.
  if (!o.force) {
    const since = new Date(Date.now() - cfg.cacheDays * 24 * 3600_000);
    const cached = await tx.vendorDiscovery.findFirst({ where: { cacheKey: q.cacheKey, status: "SUCCEEDED", reusedFromId: null, createdAt: { gte: since }, mode: cfg.mode }, orderBy: { createdAt: "desc" } });
    if (cached) {
      const d = await tx.vendorDiscovery.create({
        data: { ...base, provider: cached.provider, mode: cached.mode, status: "SUCCEEDED", reusedFromId: cached.id, placesReturned: cached.placesReturned, candidatesKept: cached.candidatesKept, creditsCharged: 0, startedAt: new Date(), finishedAt: new Date() },
      });
      await addEvent(tx, c.id, SYSTEM, {
        type: "DISCOVERY_REUSED",
        audience: "MANAGEMENT",
        message: `No approved ${noun} can take this at ${c.property.name}. Relay reused the local business search from ${cached.createdAt.toISOString().slice(0, 10)} instead of searching again (no new call, no credits). Review the businesses it found, or add a vendor you trust.`,
      });
      await tx.case.update({ where: { id: c.id }, data: { nextAction: `Find ${aOrAn(noun)}: review the businesses found or add a vendor` } });
      return { needed: true, discoveryId: d.id, status: d.status, created: true };
    }
  }

  if (cfg.mode === "off") {
    const d = await tx.vendorDiscovery.create({ data: { ...base, status: "SKIPPED", errorCode: "not_configured", errorMessage: "Vendor discovery is not configured on this server (no FIBER_API_KEY).", finishedAt: new Date() } });
    await addEvent(tx, c.id, SYSTEM, { type: "DISCOVERY_UNAVAILABLE", audience: "MANAGEMENT", message: `No approved ${noun} can take this at ${c.property.name}, and vendor discovery is not configured. Add a vendor in Settings to continue.` });
    await notify(tx, managers, c.id, `agent-blocked:no-vendor:${d.id}`, { kind: "ACTION", event: "agent.blocked", title: `No approved ${noun} for ${caseRef(c.number)}`, body: `Relay cannot continue without one: vendor discovery is not configured. Add a vendor you trust for ${c.property.name}.` });
    await tx.case.update({ where: { id: c.id }, data: { nextAction: `Add an approved ${noun} for this property` } });
    return { needed: true, discoveryId: d.id, status: d.status, created: true };
  }

  const status = o.manual || c.property.autoDiscovery ? "QUEUED" : "AWAITING_MANAGER";
  let d;
  try {
    d = await tx.vendorDiscovery.create({ data: { ...base, status } });
  } catch (e) {
    // Two triggers raced: the other one created it.
    if ((e as { code?: string })?.code === "P2002") {
      const other = await tx.vendorDiscovery.findFirst({ where: { caseId: c.id, trade, status: { in: [...ACTIVE] } } });
      if (other) return { needed: true, discoveryId: other.id, status: other.status, created: false };
    }
    throw e;
  }
  const cost = cfg.mode === "fixture" ? "a fixture response, no credits" : `about ${cfg.creditsPerSearch} Fiber AI credits`;
  await addEvent(tx, c.id, actor.kind === "MANAGER" ? actor : SYSTEM, {
    type: status === "QUEUED" ? "DISCOVERY_STARTED" : "DISCOVERY_PROPOSED",
    audience: "MANAGEMENT",
    message:
      status === "QUEUED"
        ? `No approved ${noun} can take this at ${c.property.name}. ${o.manual ? `${actor.name} asked Relay to search` : "Relay is searching"} for local businesses with Fiber AI ("${q.query}" near ${q.location}; ${cost}). Nothing found will be contacted or offered work until a manager verifies and approves it.`
        : `No approved ${noun} can take this at ${c.property.name}. Relay can search for local businesses with Fiber AI ("${q.query}" near ${q.location}; ${cost}) once a manager approves the search. You can also add a vendor you trust.`,
  });
  await notify(tx, managers, c.id, `discovery:${d.id}:${status}`, {
    kind: "ACTION",
    event: status === "QUEUED" ? "discovery.started" : "discovery.approval_needed",
    title: status === "QUEUED" ? `Searching for ${aOrAn(noun)}: ${caseRef(c.number)}` : `No approved ${noun} for ${caseRef(c.number)}`,
    body: status === "QUEUED" ? `No approved ${noun} at ${c.property.name}. Relay will list local businesses for you to review.` : `Approve a local business search (${cost}) or add a vendor you trust.`,
  });
  await tx.case.update({ where: { id: c.id }, data: { nextAction: status === "QUEUED" ? `Find ${aOrAn(noun)}: Relay is searching for local businesses` : `Find ${aOrAn(noun)}: approve a vendor search or add one` } });
  return { needed: true, discoveryId: d.id, status, created: true, queued: status === "QUEUED" };
}

/** Queue the job for a discovery (after its transaction committed). Never throws: the sweep re-queues anything lost. */
export async function kickDiscovery(discoveryId: string | undefined | null, delaySeconds = 0) {
  if (!discoveryId) return;
  try {
    await vendorDiscoveryJob.submit({ discoveryId }, delaySeconds > 0 ? ({ startAfter: delaySeconds } as never) : undefined);
  } catch (e) {
    console.warn("[discovery] could not queue the job; the sweep will retry:", (e as Error)?.name);
  }
}

// ───────────────────────── manager actions ─────────────────────────

const need = (actor: ActorCtx) => {
  if (actor.kind !== "MANAGER") throw new HttpError(403, "Your account cannot do that.");
};

/** A manager asks Relay to search (or to search again, ignoring the cache). */
export async function requestDiscovery(actor: ActorCtx, input: { caseId: string; force?: boolean }) {
  need(actor);
  const r = await withCase(input?.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    const res = await ensureDiscoveryTx(tx, c, actor, { manual: true, force: input.force === true });
    if (!res.needed) throw new HttpError(409, res.reason ?? "This case does not need a vendor search.", { code: "discovery_not_needed" });
    if (res.status === "AWAITING_MANAGER" && res.discoveryId) {
      await tx.vendorDiscovery.update({ where: { id: res.discoveryId }, data: { status: "QUEUED", requestedBy: actor.name, requestedById: actor.userId } });
      await addEvent(tx, c.id, actor, { type: "DISCOVERY_STARTED", audience: "MANAGEMENT", message: `${actor.name} approved the local business search.` });
      await tx.case.update({ where: { id: c.id }, data: { nextAction: `Find ${aOrAn(label(c.category))}: Relay is searching for local businesses` } });
      return { ...res, status: "QUEUED", queued: true };
    }
    return res;
  });
  if (r.queued || r.status === "QUEUED") await kickDiscovery(r.discoveryId);
  return { ok: true, discoveryId: r.discoveryId ?? null, status: r.status ?? null, created: r.created ?? false };
}

async function loadCandidate(actor: ActorCtx, candidateId: unknown) {
  need(actor);
  if (!isUuid(candidateId)) throw new HttpError(404, "Not found.");
  const cand = await prisma.vendorCandidate.findUnique({ where: { id: candidateId } });
  if (!cand) throw new HttpError(404, "Not found.");
  const mine = await managedPropertyIds(prisma, actor.userId!);
  if (!mine.includes(cand.propertyId)) throw new HttpError(404, "Not found.");
  return cand;
}

const NEXT: Record<string, Record<string, string>> = {
  SHORTLIST: { NEW: "SHORTLISTED" },
  VERIFY: { NEW: "VERIFIED", SHORTLISTED: "VERIFIED" },
  REJECT: { NEW: "REJECTED", SHORTLISTED: "REJECTED", VERIFIED: "REJECTED" },
  REOPEN: { REJECTED: "NEW" },
};

/** Reject, shortlist, mark verified (the manager's own check), or reopen a rejected candidate. */
export async function reviewCandidate(actor: ActorCtx, input: { candidateId: string; decision: "SHORTLIST" | "VERIFY" | "REJECT" | "REOPEN"; note?: string }) {
  const cand = await loadCandidate(actor, input?.candidateId);
  const decision = String(input.decision ?? "").toUpperCase();
  const to = NEXT[decision]?.[cand.status];
  const note = typeof input.note === "string" ? input.note.replace(/\s+/g, " ").trim().slice(0, 400) : "";
  if (!NEXT[decision]) throw new HttpError(400, "Choose shortlist, verify, reject or reopen.");
  if (!to) {
    const same = (decision === "SHORTLIST" && cand.status === "SHORTLISTED") || (decision === "VERIFY" && cand.status === "VERIFIED") || (decision === "REJECT" && cand.status === "REJECTED");
    if (same) return { ok: true, repeated: true, status: cand.status };
    throw new HttpError(409, `This business is ${cand.status.toLowerCase()}; it cannot be ${decision.toLowerCase()}ed now.`, { code: "candidate_state" });
  }
  if (decision === "VERIFY" && note.length < 5) throw new HttpError(400, "Say what you checked (for example: called them, licence and insurance confirmed, available this week).", { code: "verification_note_required" });
  if (decision === "REJECT" && note.length < 3) throw new HttpError(400, "Say briefly why it is rejected.");
  const now = new Date();
  // Compare-and-set on the status, so two managers deciding at once cannot both apply.
  const changed = await prisma.vendorCandidate.updateMany({
    where: { id: cand.id, status: cand.status },
    data: decision === "VERIFY" ? { status: "VERIFIED", verifiedById: actor.userId, verifiedAt: now, verificationNote: note } : { status: to as never, reviewedById: actor.userId, reviewedAt: now, reviewNote: note || null },
  });
  if (changed.count === 0) throw new HttpError(409, "Someone else just changed this business. Reload and try again.", { code: "candidate_state" });
  const d = await prisma.vendorDiscovery.findUnique({ where: { id: cand.lastDiscoveryId ?? cand.discoveryId }, select: { caseId: true } });
  if (d?.caseId) {
    const verb = decision === "VERIFY" ? "verified" : decision === "SHORTLIST" ? "shortlisted" : decision === "REJECT" ? "rejected" : "reopened";
    await withCase(d.caseId, async (tx, c) => {
      await addEvent(tx, c.id, actor, { type: `CANDIDATE_${decision}`, audience: "MANAGEMENT", message: `${actor.name} ${verb} ${cand.name} (found by vendor discovery)${note ? `: ${note}` : "."}` });
    }).catch(() => undefined);
  }
  return { ok: true, repeated: false, status: to };
}

/**
 * Onboard a verified candidate: it becomes a Vendor approved at this property for the trade (or, if it is already a
 * vendor in Relay, that vendor is approved here). Waiting cases at the property resume through the coordinator.
 */
export async function onboardCandidate(actor: ActorCtx, input: { candidateId: string; phone?: string; email?: string; note?: string }) {
  const cand = await loadCandidate(actor, input?.candidateId);
  if (cand.status === "APPROVED") return { ok: true, repeated: true, vendorId: cand.vendorId, resumed: 0 };
  if (cand.status !== "VERIFIED") throw new HttpError(409, "Verify this business first: confirm its licence, insurance and contact details yourself, then mark it verified.", { code: "not_verified" });
  const phone = (typeof input.phone === "string" ? input.phone.trim().slice(0, 40) : "") || cand.phone || "";
  const email = (typeof input.email === "string" ? input.email.trim().slice(0, 120) : "") || "";
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "That email address does not look right.");
  if (!phone && !email) throw new HttpError(400, "Add a phone number or email for this vendor before approving it.", { code: "contact_required" });
  const note = typeof input.note === "string" ? input.note.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const result = await prisma.$transaction(async (tx) => {
    // Lock the candidate row: two managers approving at once onboard it once.
    await tx.$queryRaw`SELECT id FROM "VendorCandidate" WHERE id = ${cand.id} FOR UPDATE`;
    const fresh = await tx.vendorCandidate.findUniqueOrThrow({ where: { id: cand.id } });
    if (fresh.status === "APPROVED") return { vendorId: fresh.vendorId!, repeated: true, resumed: [] as string[], vendorName: fresh.name };
    if (fresh.status !== "VERIFIED") throw new HttpError(409, "This business is no longer verified.", { code: "not_verified" });
    let vendor = fresh.duplicateOfVendorId ? await tx.vendor.findUnique({ where: { id: fresh.duplicateOfVendorId } }) : null;
    vendor ??= fresh.sourceRef ? await tx.vendor.findFirst({ where: { sourceRef: fresh.sourceRef } }) : null;
    if (vendor) {
      // A vendor that a property this manager does not run also uses is shared: approving it here adds it to this
      // property's directory, and never changes its trades or contact details for the other property.
      const mine = await managedPropertyIds(tx, actor.userId!);
      const elsewhere = await tx.propertyVendor.count({ where: { vendorId: vendor.id, propertyId: { notIn: mine } } });
      if (!vendor.trades.includes(fresh.trade)) {
        if (elsewhere > 0) throw new HttpError(409, `${vendor.name} is already a vendor in Relay at another property, where it is not listed for ${CATEGORY_SHORT[fresh.trade].toLowerCase()} work. Adding a trade would change it there too, so only a manager of every property that uses it can do that.`, { code: "vendor_shared" });
        vendor = await tx.vendor.update({ where: { id: vendor.id }, data: { trades: { push: fresh.trade } } });
      }
      if (elsewhere === 0 && !vendor.phone && !vendor.email) vendor = await tx.vendor.update({ where: { id: vendor.id }, data: { phone: phone || null, email: email || null } });
    } else {
      // Same name, but not the same listing or phone: possibly a different business, which is never merged into it.
      const sameName = await tx.vendor.findFirst({ where: { name: { equals: fresh.name.slice(0, 80), mode: "insensitive" } }, select: { name: true } });
      if (sameName) throw new HttpError(409, `Relay already has a vendor called ${sameName.name}, with a different listing and phone number, so this may be a different business. If it is the same one, a manager of a property that uses it can share it with you; otherwise add this business by hand under a name that tells them apart.`, { code: "name_taken" });
      vendor = await tx.vendor.create({
        data: {
          name: fresh.name.slice(0, 80),
          trades: [fresh.trade],
          phone: phone || null,
          email: email || null,
          website: fresh.website,
          address: fresh.address,
          latitude: fresh.latitude,
          longitude: fresh.longitude,
          source: "DISCOVERY",
          sourceRef: fresh.sourceRef,
          notes: `Found by vendor discovery (${fresh.source}); verified by ${actor.name}: ${fresh.verificationNote ?? ""}`.slice(0, 300),
        },
      }).catch((e: unknown) => {
        // Another manager added a vendor with this name a moment ago.
        if ((e as { code?: string })?.code === "P2002") throw new HttpError(409, "A vendor with this name was added a moment ago. Refresh and check whether it is the same business.", { code: "name_taken" });
        throw e;
      });
    }
    await tx.propertyVendor.upsert({
      where: { propertyId_vendorId: { propertyId: fresh.propertyId, vendorId: vendor.id } },
      update: { approved: true, approvedAt: new Date(), approvedById: actor.userId, source: "DISCOVERY", note: note || null },
      create: { propertyId: fresh.propertyId, vendorId: vendor.id, approved: true, approvedAt: new Date(), approvedById: actor.userId, source: "DISCOVERY", note: note || null },
    });
    await tx.vendorCandidate.update({ where: { id: fresh.id }, data: { status: "APPROVED", vendorId: vendor.id, reviewedById: actor.userId, reviewedAt: new Date(), reviewNote: note || fresh.reviewNote } });
    // Every case at this property waiting for this trade can now continue.
    const waiting = await casesWaitingFor(tx, fresh.propertyId, [fresh.trade]);
    for (const w of waiting) {
      const eventId = await addEvent(tx, w.id, actor, {
        type: "VENDOR_ONBOARDED",
        audience: "MANAGEMENT",
        message: `${actor.name} approved ${vendor.name} for this property after verifying it${fresh.verificationNote ? ` (${fresh.verificationNote})` : ""}. It can now be offered this job.`,
        vendorId: vendor.id,
      });
      await flagForCoordinator(tx, w.id, "VENDOR_ONBOARDED", eventId);
      await tx.case.update({ where: { id: w.id }, data: { nextAction: "Assign an approved vendor" } });
    }
    return { vendorId: vendor.id, repeated: false, resumed: waiting.map((w) => w.id), vendorName: vendor.name };
  });
  mark("relay.discovery.onboarded", { candidateId: cand.id, resumed: result.resumed.length });
  return { ok: true, repeated: result.repeated, vendorId: result.vendorId, resumed: result.resumed.length, resumedCaseIds: result.resumed };
}

// ───────────────────────── the job ─────────────────────────

const retryDelaySeconds = (attempt: number) => (Number(process.env.FIBER_RETRY_SECONDS) || 60) * attempt;

// One paid search at a time in this server process (see runDiscovery). With several processes, each has its own
// queue, so the daily budget could be overshot by one search per extra process.
let searchQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = searchQueue.then(fn, fn);
  searchQueue = run.catch(() => undefined);
  return run;
}
const startOfUtcDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/** pg-boss entry point. */
export const vendorDiscoveryJobFn = async (args: { discoveryId: string }, _ctx: unknown) => runDiscovery(String(args?.discoveryId ?? ""));

export async function runDiscovery(discoveryId: string): Promise<{ status: string }> {
  if (!isUuid(discoveryId)) return { status: "invalid" };
  // Claim: only one worker runs a queued discovery, however many times the job was submitted.
  const claimed = await prisma.$queryRaw<{ id: string }[]>`UPDATE "VendorDiscovery" SET "status" = 'RUNNING', "attempts" = "attempts" + 1, "startedAt" = now(), "updatedAt" = now() WHERE "id" = ${discoveryId} AND "status" = 'QUEUED' RETURNING "id"`;
  if (claimed.length === 0) return { status: "not_queued" };
  const d = await prisma.vendorDiscovery.findUniqueOrThrow({ where: { id: discoveryId }, include: { property: true } });
  const cfg = fiberConfig();
  const finish = (data: Prisma.VendorDiscoveryUpdateInput) => prisma.vendorDiscovery.update({ where: { id: d.id }, data: { finishedAt: new Date(), ...data } });

  // Still needed? A manager may have added a vendor or closed the case while this waited.
  if (d.caseId && !d.response) {
    const still = await prisma.case.findUnique({ where: { id: d.caseId }, include: CASE_INCLUDE });
    const blocker = !still
      ? "The case no longer exists."
      : !["AWAITING_ASSIGNMENT", "REOPENED", "TRIAGED"].includes(still.status) || still.emergency
        ? `The case moved on (${still.status}) before the search ran.`
        : (await coverage(prisma, still)).usable > 0
          ? "An approved vendor became available before the search ran."
          : null;
    if (blocker) {
      await finish({ status: "CANCELLED", errorCode: "not_needed", errorMessage: blocker });
      return { status: "cancelled" };
    }
  }

  let response = d.response as { places?: FiberPlace[] } | null;
  if (!response) {
    if (cfg.mode === "off") {
      await finish({ status: "SKIPPED", errorCode: "not_configured", errorMessage: "Vendor discovery is not configured on this server (no FIBER_API_KEY)." });
      await tellManagers(d, "skipped", "Vendor discovery is not configured. Add a vendor in Settings.");
      return { status: "skipped" };
    }
    // Cost controls before any call that can spend credits. The checks, the search and recording its charge run one at
    // a time in this process, so two discoveries can never both pass the budget before either has recorded its cost.
    const searched = await oneAtATime(async (): Promise<{ status: string } | { places: FiberPlace[] }> => {
      const credits = await fiberCredits();
      if (!credits.ok) {
        return failOrRetry(d, credits, "checking the credit balance");
      }
      const spentToday = cfg.mode === "fixture" ? 0 : ((await prisma.vendorDiscovery.aggregate({ _sum: { creditsCharged: true }, where: { mode: { in: ["live", "sandbox"] }, createdAt: { gte: startOfUtcDay() } } }))._sum.creditsCharged ?? 0);
      const estimate = cfg.mode === "sandbox" || cfg.mode === "fixture" ? 0 : cfg.creditsPerSearch;
      let skip: { code: string; message: string } | null = null;
      if (credits.available <= 0) skip = { code: "credits_exhausted", message: "The Fiber AI account has no credits left. No search was made." };
      else if (estimate > 0 && credits.available - estimate < cfg.minBalance) skip = { code: "budget", message: `The Fiber AI balance is ${credits.available} credits and Relay keeps at least ${cfg.minBalance} in reserve, so it did not search.` };
      else if (estimate > 0 && spentToday + estimate > cfg.dailyCreditBudget) skip = { code: "daily_budget", message: `Today's discovery budget (${cfg.dailyCreditBudget} credits) is used up (${spentToday} spent). No search was made.` };
      if (skip) {
        await finish({ status: "SKIPPED", errorCode: skip.code, errorMessage: skip.message, creditsBefore: credits.available });
        await tellManagers(d, "skipped", `${skip.message} Add a vendor you trust, or search again later.`);
        return { status: "skipped" };
      }
      const res = await fiberSearchPlaces(d.query, d.location);
      if (!res.ok) return failOrRetry(d, res, "searching", credits.available);
      // Save what came back at once, with the charge, before any processing: a crash after this resumes without paying again.
      const places = res.places.map(({ placeId, name, url, rating, reviewCount, phoneNumber, websiteUrl, address, categories, openingHours, coordinates }) => ({ placeId, name, url, rating, reviewCount, phoneNumber, websiteUrl, address, categories, openingHours, coordinates }));
      await prisma.vendorDiscovery.update({
        where: { id: d.id },
        data: {
          response: { places, nextPageToken: res.nextPageToken, httpStatus: res.httpStatus, sandbox: res.sandbox } as object,
          chargeInfo: (res.chargeInfo ?? undefined) as object | undefined,
          warnings: (res.warnings ?? undefined) as object | undefined,
          advice: (res.advice ?? undefined) as object | undefined,
          creditsCharged: creditsCharged(res.chargeInfo),
          creditsBefore: credits.available,
          placesReturned: places.length,
          errorCode: null,
          errorMessage: null,
        },
      });
      mark("relay.discovery.searched", { discoveryId: d.id, mode: cfg.mode, places: places.length, credits: creditsCharged(res.chargeInfo) });
      return { places: places as FiberPlace[] };
    });
    if (!("places" in searched)) return searched;
    response = { places: searched.places };
  }
  // Test-only fault point: a crash after the response is saved (a resumed run uses the saved response, no new call).
  faults.hit("discovery.beforeCandidates");

  const outcome = await saveCandidates(d, response.places ?? []);
  await finish({ status: "SUCCEEDED", candidatesKept: outcome.kept, filtered: outcome.filtered as object, errorCode: null, errorMessage: null });
  await tellManagers(d, outcome.kept > 0 ? "done" : "empty", outcome.kept > 0 ? `${outcome.kept} local business${outcome.kept === 1 ? "" : "es"} to review${outcome.duplicates ? ` (${outcome.duplicates} already in Relay)` : ""}.` : "No suitable local businesses were found. Add a vendor you trust.");
  return { status: "succeeded" };
}

async function failOrRetry(d: { id: string; attempts: number; caseId: string | null; trade: Category; propertyId: string }, err: { code: string; message: string; retryable: boolean; body?: unknown }, step: string, creditsBefore?: number) {
  const cfg = fiberConfig();
  // The claim already counted this attempt.
  const attempts = d.attempts;
  if (err.retryable && attempts < cfg.maxAttempts) {
    await prisma.vendorDiscovery.update({ where: { id: d.id }, data: { status: "QUEUED", errorCode: err.code, errorMessage: `${err.message} (while ${step}; attempt ${attempts} of ${cfg.maxAttempts}, retrying)`, creditsBefore } });
    await kickDiscovery(d.id, retryDelaySeconds(attempts));
    return { status: "retrying" };
  }
  const alert = (err.body as { outOfCreditsAlert?: unknown } | undefined)?.outOfCreditsAlert;
  await prisma.vendorDiscovery.update({
    where: { id: d.id },
    data: { status: "FAILED", errorCode: err.code, errorMessage: `${err.message} (while ${step}${err.retryable ? `, after ${attempts} attempts` : ""})`, finishedAt: new Date(), creditsBefore, ...(alert ? { warnings: { outOfCreditsAlert: alert } as object } : {}) },
  });
  await tellManagers(d, "failed", `${err.message} Add a vendor you trust, or try the search again later.`);
  return { status: "failed" };
}

/** Records the outcome on the case and tells its managers. Behaviour G when nothing usable came back. */
async function tellManagers(d: { id: string; caseId: string | null; trade: Category; propertyId: string }, kind: "done" | "empty" | "failed" | "skipped", body: string) {
  if (!d.caseId) return;
  const noun = label(d.trade);
  await withCase(d.caseId, async (tx, c) => {
    const eventId = await addEvent(tx, c.id, SYSTEM, {
      type: kind === "done" || kind === "empty" ? "DISCOVERY_COMPLETED" : kind === "failed" ? "DISCOVERY_FAILED" : "DISCOVERY_SKIPPED",
      audience: "MANAGEMENT",
      message: kind === "done" || kind === "empty" ? `Vendor discovery finished: ${body}` : `Vendor discovery ${kind === "failed" ? "failed" : "did not run"}: ${body}`,
    });
    await notify(tx, await managerIds(tx, c.propertyId), c.id, `discovery:${d.id}:${kind}`, {
      kind: "ACTION",
      event: kind === "done" ? "discovery.completed" : "agent.blocked",
      title: kind === "done" ? `Businesses found for ${caseRef(c.number)}` : kind === "empty" ? `No businesses found for ${caseRef(c.number)}` : `Vendor search ${kind === "failed" ? "failed" : "not run"}: ${caseRef(c.number)}`,
      body,
    });
    if (["AWAITING_ASSIGNMENT", "REOPENED"].includes(c.status)) {
      await tx.case.update({ where: { id: c.id }, data: { nextAction: kind === "done" ? `Find ${aOrAn(noun)}: review the businesses found or add a vendor` : `Add an approved ${noun} for this property` } });
      if (kind === "done") await flagForCoordinator(tx, c.id, "DISCOVERY_COMPLETED", eventId);
    }
  }).catch((e) => console.warn("[discovery] could not record the outcome on the case:", (e as Error)?.name));
}

async function saveCandidates(d: { id: string; propertyId: string; trade: Category; property: PropertyLike }, places: FiberPlace[]) {
  if (!isTrade(d.trade)) return { kept: 0, duplicates: 0, filtered: [] };
  const trade = d.trade;
  const cfg = fiberConfig();
  const known = await prisma.vendor.findMany({ select: { id: true, name: true, phone: true, website: true, sourceRef: true } });
  const all = places.filter((p) => p && typeof p.placeId === "string" && typeof p.name === "string").map((p) => evaluatePlace(p, trade, d.property, known));
  const valid = all.filter((e) => e.keep).sort((a, b) => b.score - a.score);
  const kept = valid.slice(0, cfg.maxCandidates);
  const filtered = [
    ...all.filter((e) => !e.keep).map((e) => ({ name: e.place.name, reason: e.dropReason })),
    ...valid.slice(cfg.maxCandidates).map((e) => ({ name: e.place.name, reason: `Lower ranked: Relay keeps the best ${cfg.maxCandidates}` })),
  ];
  const source = cfg.mode === "fixture" ? "fixture:google-maps" : "fiber:google-maps";
  for (const e of kept) {
    const pl = e.place;
    const fields = {
      sourceUrl: pl.url ?? null,
      name: pl.name.slice(0, 120),
      phone: pl.phoneNumber ?? null,
      website: pl.websiteUrl ?? null,
      address: pl.address ?? null,
      categories: (pl.categories ?? []).slice(0, 8),
      rating: typeof pl.rating === "number" ? pl.rating : null,
      reviewCount: typeof pl.reviewCount === "number" ? pl.reviewCount : null,
      latitude: pl.coordinates?.latitude ?? null,
      longitude: pl.coordinates?.longitude ?? null,
      distanceKm: e.distanceKm === null ? null : Math.round(e.distanceKm * 10) / 10,
      openingHours: (pl.openingHours ?? []) as object,
      checks: { categoryMatch: e.categoryMatch, inServiceArea: e.inServiceArea, hasContact: e.hasContact, isBusiness: e.isBusiness, duplicate: !!e.duplicateOf } as object,
      missing: e.missing,
      duplicateOfVendorId: e.duplicateOf?.id ?? null,
      recommendation: e.recommendation,
      reasons: e.reasons,
      concerns: e.concerns,
      assessedBy: "RULES",
    };
    // Deduplicate against earlier results: the same business found again updates the existing row (and keeps the
    // manager's review), it never creates a second one.
    await prisma.vendorCandidate.upsert({
      where: { propertyId_trade_sourceRef: { propertyId: d.propertyId, trade, sourceRef: pl.placeId } },
      create: { propertyId: d.propertyId, discoveryId: d.id, lastDiscoveryId: d.id, trade, source, sourceRef: pl.placeId, ...fields },
      update: { lastDiscoveryId: d.id, timesSeen: { increment: 1 }, ...fields },
    });
  }
  return { kept: kept.length, duplicates: kept.filter((e) => e.duplicateOf).length, filtered };
}

// ───────────────────────── read side ─────────────────────────

function candidateView(c: Prisma.VendorCandidateGetPayload<{}>, vendorNames: Map<string, string>, now: Date, discoveredAt: Date | null): CandidateView {
  const checks = (c.checks ?? {}) as { categoryMatch?: string; inServiceArea?: boolean | null; hasContact?: boolean; duplicate?: boolean };
  const ageDays = discoveredAt ? Math.floor((now.getTime() - discoveredAt.getTime()) / 86_400_000) : 0;
  return {
    id: c.id,
    name: c.name,
    trade: c.trade,
    status: c.status,
    source: c.source,
    sourceUrl: c.sourceUrl,
    phone: c.phone,
    website: c.website,
    address: c.address,
    categories: c.categories,
    rating: c.rating,
    reviewCount: c.reviewCount,
    distanceKm: c.distanceKm,
    checks: { categoryMatch: (checks.categoryMatch as CandidateView["checks"]["categoryMatch"]) ?? "none", inServiceArea: checks.inServiceArea ?? null, hasContact: !!checks.hasContact, duplicate: !!checks.duplicate },
    duplicateOf: c.duplicateOfVendorId ? (vendorNames.get(c.duplicateOfVendorId) ?? "an existing vendor") : null,
    missing: c.missing,
    recommendation: c.recommendation as CandidateView["recommendation"],
    reasons: c.reasons,
    concerns: c.concerns,
    assessedBy: c.assessedBy,
    aiNote: c.aiNote,
    reviewNote: c.reviewNote,
    verificationNote: c.verificationNote,
    verifiedAt: c.verifiedAt?.toISOString() ?? null,
    timesSeen: c.timesSeen,
    stale: ageDays > fiberConfig().cacheDays,
    foundAt: (discoveredAt ?? c.createdAt).toISOString(),
    vendorId: c.vendorId,
  };
}

function discoveryView(d: Prisma.VendorDiscoveryGetPayload<{}>): DiscoveryView {
  const filtered = (Array.isArray(d.filtered) ? d.filtered : []) as { name: string; reason: string }[];
  return {
    id: d.id,
    createdAt: d.createdAt.toISOString(),
    finishedAt: d.finishedAt?.toISOString() ?? null,
    status: d.status,
    trade: d.trade,
    query: d.query,
    location: d.location,
    provider: d.provider,
    mode: d.mode,
    requestedBy: d.requestedBy,
    attempts: d.attempts,
    placesReturned: d.placesReturned,
    candidatesKept: d.candidatesKept,
    creditsCharged: d.creditsCharged,
    creditsBefore: d.creditsBefore,
    chargeInfo: d.chargeInfo ? JSON.stringify(d.chargeInfo) : null,
    warnings: d.warnings ? JSON.stringify(d.warnings) : null,
    errorCode: d.errorCode,
    errorMessage: d.errorMessage,
    reused: !!d.reusedFromId,
    filtered,
  };
}

/** Everything the case page needs about vendor discovery for this case's trade. Managers only. */
export async function discoveryPanel(actor: ActorCtx, caseId: unknown): Promise<DiscoveryPanel> {
  need(actor);
  if (!isUuid(caseId)) throw new HttpError(404, "Case not found.");
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: CASE_INCLUDE });
  if (!c) throw new HttpError(404, "Case not found.");
  await assertCaseAccess(prisma, actor, c);
  const cfg = fiberConfig();
  const trade = c.category;
  const [discoveries, cov] = await Promise.all([prisma.vendorDiscovery.findMany({ where: { caseId: c.id }, orderBy: { createdAt: "desc" }, take: 6 }), coverage(prisma, c)]);
  const candidates = isTrade(trade) ? await prisma.vendorCandidate.findMany({ where: { propertyId: c.propertyId, trade }, orderBy: [{ updatedAt: "desc" }], take: 20, include: { discovery: { select: { createdAt: true } } } }) : [];
  const vendorIds = [...new Set(candidates.map((x) => x.duplicateOfVendorId).filter((x): x is string => !!x))];
  const names = new Map((await prisma.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, name: true } })).map((v) => [v.id, v.name] as const));
  const now = new Date();
  const order = { RECOMMENDED: 0, POSSIBLE: 1, NOT_RECOMMENDED: 2 } as Record<string, number>;
  const statusOrder = { VERIFIED: 0, SHORTLISTED: 1, NEW: 2, APPROVED: 3, REJECTED: 4 } as Record<string, number>;
  return {
    trade,
    applies: isTrade(trade),
    approvedVendors: cov.approved,
    usableVendors: cov.usable,
    provider: { mode: cfg.mode, configured: cfg.mode !== "off", maxCandidates: cfg.maxCandidates, creditsPerSearch: cfg.creditsPerSearch },
    discoveries: discoveries.map(discoveryView),
    candidates: candidates
      .map((x) => candidateView(x, names, now, x.discovery.createdAt))
      .sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) || (order[a.recommendation] ?? 9) - (order[b.recommendation] ?? 9)),
    canSearch: isTrade(trade) && ["AWAITING_ASSIGNMENT", "REOPENED", "TRIAGED"].includes(c.status) && !c.emergency,
  };
}

/** Provider status for Settings: mode, budget, today's spend and (live only) the balance from Fiber's free endpoint. */
let balanceCache: { at: number; value: Awaited<ReturnType<typeof fiberCredits>> } | null = null;
export async function fiberStatus(actor: ActorCtx): Promise<FiberStatus> {
  need(actor);
  const cfg = fiberConfig();
  const propertyIds = await managedPropertyIds(prisma, actor.userId!);
  if (!balanceCache || Date.now() - balanceCache.at > 5 * 60_000) balanceCache = { at: Date.now(), value: cfg.mode === "off" ? { ok: false, code: "not_configured", message: "No FIBER_API_KEY is set.", httpStatus: null, retryable: false } : await fiberCredits() };
  const b = balanceCache.value;
  const spent = await prisma.vendorDiscovery.aggregate({ _sum: { creditsCharged: true }, _count: true, where: { mode: { in: ["live", "sandbox"] }, createdAt: { gte: startOfUtcDay() } } });
  const recent = await prisma.vendorDiscovery.findMany({ where: { propertyId: { in: propertyIds } }, orderBy: { createdAt: "desc" }, take: 8, include: { case: { select: { number: true } } } });
  return {
    mode: cfg.mode,
    configured: cfg.mode !== "off",
    balance: b.ok ? { available: b.available, max: b.max, used: b.used, resetsOn: b.resetsOn } : null,
    balanceError: b.ok ? null : b.message,
    creditsPerSearch: cfg.creditsPerSearch,
    dailyCreditBudget: cfg.dailyCreditBudget,
    minBalance: cfg.minBalance,
    maxCandidates: cfg.maxCandidates,
    cacheDays: cfg.cacheDays,
    spentToday: spent._sum.creditsCharged ?? 0,
    searchesToday: spent._count,
    recent: recent.map((d) => ({ ...discoveryView(d), caseRef: d.case ? caseRef(d.case.number) : null })),
  };
}

/** For the command center: searches waiting for a manager, failures, and businesses waiting for a decision. */
export async function discoveryQueue(propertyIds: string[]) {
  const [waiting, failed, candidates] = await Promise.all([
    prisma.vendorDiscovery.findMany({ where: { propertyId: { in: propertyIds }, status: { in: ["AWAITING_MANAGER", "QUEUED", "RUNNING"] } }, include: { case: { select: { id: true, number: true, title: true } } }, orderBy: { createdAt: "asc" }, take: 10 }),
    prisma.vendorDiscovery.findMany({ where: { propertyId: { in: propertyIds }, status: { in: ["FAILED", "SKIPPED"] }, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) }, case: { status: { in: ["AWAITING_ASSIGNMENT", "REOPENED", "TRIAGED"] } } }, include: { case: { select: { id: true, number: true, title: true } } }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.vendorCandidate.groupBy({ by: ["propertyId", "trade", "status"], where: { propertyId: { in: propertyIds }, status: { in: ["NEW", "SHORTLISTED", "VERIFIED"] } }, _count: true }),
  ]);
  return { waiting, failed, candidates };
}
