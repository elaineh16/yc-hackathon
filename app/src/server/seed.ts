// Demo data: two properties, their units, and login accounts for each role. Run with `wasp db seed`.
// Everything here is fictional and exists only so the app can be tried locally. No cases are seeded:
// every case in the app is created through the real intake flow.
import type { PrismaClient } from "@prisma/client";
import { createProviderId, sanitizeAndSerializeProviderData } from "wasp/server/auth";
import type { Category, Role } from "../shared/domain";

/** The one password for every local demo account (documented in the README). */
export const DEMO_PASSWORD = "relay-demo-2026";

// Fictional building notes, editable in Settings. The agents search these instead of guessing.
const MAPLE_NOTES = `Every kitchen and bathroom sink has its own shut-off valve in the cabinet underneath. Turn it clockwise to stop the water.

The main water shut-off for the building is in the basement mechanical room, behind the laundry room. Only staff have the key.

Each unit has an in-suite washer and dryer (stacked, in the hall closet). The dryer vents to the outside wall; lint traps must be cleaned after every load.

Heating is electric baseboard in every room with a wall thermostat. Units 3C and 4B also have a ductless air conditioner in the living room.

Kitchens have a fridge, a four-burner electric stove with oven, a dishwasher and a microwave above the stove. Appliances are owned by the building.

Contractors must sign in at the front desk and may enter a unit only with the resident home or with written permission to enter.

The building has one passenger elevator, serviced under contract. If it stops between floors, staff take it out of service until it is inspected.

Lockouts: residents locked out are let in by staff after their identity is checked against the lease. The front desk does not hand out keys or codes.
STAFF ONLY: the front desk key cabinet code is 4417. Never share it with residents, contractors or anyone by phone.`;
const BIRCH_NOTES = `Birch House is a small heritage building. There is a shared coin laundry room in the basement; residents do not have in-suite laundry.

Heating is hot-water radiators from a gas boiler in the basement. Radiator valves are at the bottom of each radiator. Gas smell: leave the building and call the gas utility.

Water shut-off valves for each unit are under the kitchen sink.`;

type Login = { username: string; displayName: string; role: Role; vendorId?: string; email?: string | null; emailNotifications?: boolean };

async function ensureLogin(prisma: PrismaClient, l: Login): Promise<number> {
  const providerId = createProviderId("username", l.username);
  const existing = await prisma.authIdentity.findUnique({
    where: { providerName_providerUserId: { providerName: providerId.providerName, providerUserId: providerId.providerUserId } },
    include: { auth: true },
  });
  if (existing?.auth.userId) {
    await prisma.user.update({ where: { id: existing.auth.userId }, data: { displayName: l.displayName, role: l.role, vendorId: l.vendorId ?? null, email: l.email ?? null, emailNotifications: l.emailNotifications === true } });
    return existing.auth.userId;
  }
  const providerData = await sanitizeAndSerializeProviderData<"username">({ hashedPassword: DEMO_PASSWORD });
  const user = await prisma.user.create({
    data: {
      displayName: l.displayName,
      role: l.role,
      vendorId: l.vendorId ?? null,
      email: l.email ?? null,
      emailNotifications: l.emailNotifications === true,
      auth: { create: { identities: { create: { providerName: providerId.providerName, providerUserId: providerId.providerUserId, providerData } } } },
    },
  });
  return user.id;
}

async function ensureVendor(prisma: PrismaClient, name: string, trades: Category[], phone: string) {
  return prisma.vendor.upsert({ where: { name }, update: { trades, phone }, create: { name, trades, phone } });
}

// Fictional buildings in a real city (Waterloo, Ontario), so vendor discovery has a real place to search near.
// The coordinates are the city's, not of any real address.
const PLACES = {
  maple: { city: "Waterloo", region: "ON", latitude: 43.4668, longitude: -80.5164, autoDiscovery: true },
  birch: { city: "Waterloo", region: "ON", latitude: 43.4723, longitude: -80.5449, autoDiscovery: false },
};
const PROPERTY_NAME = { maple: "Maple Court Apartments", birch: "Birch House" } as const;
/** The demo directory: which vendor is approved where. Maple Court has no heating and cooling vendor on purpose. */
const DIRECTORY: Record<keyof typeof PLACES, string[]> = {
  maple: ["Northside Plumbing", "Harbour Plumbing & Drain", "BrightSpark Appliance Repair"],
  birch: ["Northside Plumbing", "Evergreen Heating & Cooling"],
};
const POLICY = { approvalThresholdCents: 25000, vendorResponseMinutes: 1440, verificationReminderMinutes: 1440, verificationCloseAfterMinutes: 4320, residentResponseMinutes: 1440, maxReminders: 2, appointmentReminderMinutes: 1440, serviceRadiusKm: 30, autopilotRoutine: false };
// Email addresses use the reserved .test domain, so they can never reach a real mailbox.
const PREFS: Record<string, { email: string | null; emailNotifications: boolean }> = {
  morgan: { email: "morgan.reyes@relay-demo.test", emailNotifications: true },
  priya: { email: "priya.nair@relay-demo.test", emailNotifications: true },
  daniel: { email: "daniel.osei@relay-demo.test", emailNotifications: false },
  sam: { email: "sam@northside-plumbing.test", emailNotifications: true },
};

async function ensureProperty(prisma: PrismaClient, key: keyof typeof PLACES, address: string, units: string[], knowledge: string) {
  const name = PROPERTY_NAME[key];
  const existing = await prisma.property.findFirst({ where: { name } });
  const data = { knowledge, ...PLACES[key] };
  const property = existing ? await prisma.property.update({ where: { id: existing.id }, data }) : await prisma.property.create({ data: { name, address, ...data } });
  const ids: Record<string, string> = {};
  for (const label of units) {
    const u = await prisma.unit.upsert({ where: { propertyId_label: { propertyId: property.id, label } }, update: {}, create: { propertyId: property.id, label } });
    ids[label] = u.id;
  }
  return { property, units: ids };
}

export async function seedDemo(prisma: PrismaClient) {
  const maple = await ensureProperty(prisma, "maple", "128 Maple Court, Waterloo, ON", ["1A", "2B", "3C", "4B"], MAPLE_NOTES);
  const birch = await ensureProperty(prisma, "birch", "40 Birch Street, Waterloo, ON", ["101", "102"], BIRCH_NOTES);

  const plumbing = await ensureVendor(prisma, "Northside Plumbing", ["PLUMBING"], "519-555-0141");
  const plumbing2 = await ensureVendor(prisma, "Harbour Plumbing & Drain", ["PLUMBING"], "519-555-0162");
  const appliance = await ensureVendor(prisma, "BrightSpark Appliance Repair", ["APPLIANCE"], "519-555-0177");
  const hvac = await ensureVendor(prisma, "Evergreen Heating & Cooling", ["HVAC"], "519-555-0193");

  const morgan = await ensureLogin(prisma, { username: "morgan", displayName: "Morgan Reyes", role: "MANAGER", ...PREFS.morgan });
  const taylor = await ensureLogin(prisma, { username: "taylor", displayName: "Taylor Brooks", role: "MANAGER" });
  const priya = await ensureLogin(prisma, { username: "priya", displayName: "Priya Nair", role: "RESIDENT", ...PREFS.priya });
  const daniel = await ensureLogin(prisma, { username: "daniel", displayName: "Daniel Osei", role: "RESIDENT", ...PREFS.daniel });
  const noor = await ensureLogin(prisma, { username: "noor", displayName: "Noor Haddad", role: "RESIDENT" });
  await ensureLogin(prisma, { username: "sam", displayName: "Sam Okafor", role: "CONTRACTOR", vendorId: plumbing.id, ...PREFS.sam });
  await ensureLogin(prisma, { username: "jo", displayName: "Jo Tremblay", role: "CONTRACTOR", vendorId: plumbing2.id });
  await ensureLogin(prisma, { username: "ana", displayName: "Ana Lima", role: "CONTRACTOR", vendorId: appliance.id });
  await ensureLogin(prisma, { username: "lee", displayName: "Lee Chen", role: "CONTRACTOR", vendorId: hvac.id });

  const member = (userId: number, propertyId: string) => prisma.propertyMembership.upsert({ where: { userId_propertyId: { userId, propertyId } }, update: {}, create: { userId, propertyId } });
  await member(morgan, maple.property.id);
  await member(taylor, birch.property.id);
  const lives = (userId: number, unitId: string) => prisma.residency.upsert({ where: { userId_unitId: { userId, unitId } }, update: { active: true }, create: { userId, unitId } });
  await lives(priya, maple.units["4B"]);
  await lives(daniel, maple.units["2B"]);
  await lives(noor, birch.units["101"]);
  await applyDirectory(prisma);

  console.log("[seed] Demo accounts ready (password for all: relay-demo-2026): morgan, taylor (managers); priya, daniel, noor (residents); sam, jo, ana, lee (contractors).");
}

/** Sets each property's approved vendors to exactly the demo directory. */
async function applyDirectory(prisma: PrismaClient) {
  for (const key of Object.keys(DIRECTORY) as (keyof typeof PLACES)[]) {
    const property = await prisma.property.findFirst({ where: { name: PROPERTY_NAME[key] } });
    if (!property) continue;
    const vendors = await prisma.vendor.findMany({ where: { name: { in: DIRECTORY[key] } }, select: { id: true } });
    await prisma.propertyVendor.deleteMany({ where: { propertyId: property.id, vendorId: { notIn: vendors.map((v) => v.id) } } });
    for (const v of vendors) {
      await prisma.propertyVendor.upsert({
        where: { propertyId_vendorId: { propertyId: property.id, vendorId: v.id } },
        update: { approved: true, source: "MANUAL" },
        create: { propertyId: property.id, vendorId: v.id, approved: true, approvedAt: new Date(), source: "MANUAL" },
      });
    }
  }
}

/** Discovery modes that called the real provider (fiber.ts). Their rows are kept by a reset. */
const REAL_DISCOVERY_MODES = ["live", "sandbox"];

/**
 * Removes every case and restores the demo policy, directory and preferences. Test hooks only; never in normal use.
 * Searches that reached the real Fiber AI API are kept: they are the record of credits spent that the daily budget is
 * counted from, and the cache that stops a repeated run from paying for the same search again. Their businesses are
 * kept too, with the managers' decisions on them cleared. Fixture searches are deleted.
 */
export async function resetCases(prisma: PrismaClient) {
  await prisma.notification.deleteMany({});
  await prisma.intakeConversation.deleteMany({});
  // A real search still waiting or running loses its case below: it is cancelled, so it can never run (and spend) without one.
  await prisma.vendorDiscovery.updateMany({ where: { mode: { in: REAL_DISCOVERY_MODES }, status: { in: ["AWAITING_MANAGER", "QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", errorCode: "reset", errorMessage: "Cancelled by a test reset before it ran.", finishedAt: new Date() } });
  await prisma.vendorDiscovery.deleteMany({ where: { mode: { notIn: REAL_DISCOVERY_MODES } } });
  await prisma.vendorCandidate.updateMany({ data: { status: "NEW", reviewedById: null, reviewedAt: null, reviewNote: null, verifiedById: null, verifiedAt: null, verificationNote: null, vendorId: null, aiNote: null, assessedBy: "RULES" } });
  await prisma.case.deleteMany({});
  await prisma.agentRun.deleteMany({});
  // Vendors created by tests or by onboarding a discovered business (never one with a contractor login).
  await prisma.vendor.deleteMany({ where: { OR: [{ source: "DISCOVERY" }, { name: { startsWith: "Test vendor " } }], users: { none: {} } } });
  const vendorIds = (await prisma.vendor.findMany({ select: { id: true } })).map((v) => v.id);
  await prisma.vendorCandidate.updateMany({ where: { duplicateOfVendorId: { notIn: vendorIds } }, data: { duplicateOfVendorId: null } });
  for (const key of Object.keys(PLACES) as (keyof typeof PLACES)[]) {
    await prisma.property.updateMany({ where: { name: PROPERTY_NAME[key] }, data: { ...POLICY, ...PLACES[key] } });
  }
  await applyDirectory(prisma);
  await prisma.user.updateMany({ data: { email: null, emailNotifications: false } });
  for (const [username, p] of Object.entries(PREFS)) {
    const id = await prisma.authIdentity.findFirst({ where: { providerName: "username", providerUserId: username }, include: { auth: true } });
    if (id?.auth.userId) await prisma.user.update({ where: { id: id.auth.userId }, data: p });
  }
}
