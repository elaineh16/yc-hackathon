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

Contractors must sign in at the front desk and may enter a unit only with the resident home or with written permission to enter.`;
const BIRCH_NOTES = `Birch House is a small heritage building. There is a shared coin laundry room in the basement; residents do not have in-suite laundry.

Heating is hot-water radiators from a gas boiler in the basement. Radiator valves are at the bottom of each radiator. Gas smell: leave the building and call the gas utility.

Water shut-off valves for each unit are under the kitchen sink.`;

type Login = { username: string; displayName: string; role: Role; vendorId?: string };

async function ensureLogin(prisma: PrismaClient, l: Login): Promise<number> {
  const providerId = createProviderId("username", l.username);
  const existing = await prisma.authIdentity.findUnique({
    where: { providerName_providerUserId: { providerName: providerId.providerName, providerUserId: providerId.providerUserId } },
    include: { auth: true },
  });
  if (existing?.auth.userId) {
    await prisma.user.update({ where: { id: existing.auth.userId }, data: { displayName: l.displayName, role: l.role, vendorId: l.vendorId ?? null } });
    return existing.auth.userId;
  }
  const providerData = await sanitizeAndSerializeProviderData<"username">({ hashedPassword: DEMO_PASSWORD });
  const user = await prisma.user.create({
    data: {
      displayName: l.displayName,
      role: l.role,
      vendorId: l.vendorId ?? null,
      auth: { create: { identities: { create: { providerName: providerId.providerName, providerUserId: providerId.providerUserId, providerData } } } },
    },
  });
  return user.id;
}

async function ensureVendor(prisma: PrismaClient, name: string, trades: Category[], phone: string) {
  return prisma.vendor.upsert({ where: { name }, update: { trades, phone, approved: true }, create: { name, trades, phone } });
}

async function ensureProperty(prisma: PrismaClient, name: string, address: string, units: string[], knowledge: string) {
  const existing = await prisma.property.findFirst({ where: { name } });
  const property = existing ? await prisma.property.update({ where: { id: existing.id }, data: { knowledge } }) : await prisma.property.create({ data: { name, address, knowledge } });
  const ids: Record<string, string> = {};
  for (const label of units) {
    const u = await prisma.unit.upsert({ where: { propertyId_label: { propertyId: property.id, label } }, update: {}, create: { propertyId: property.id, label } });
    ids[label] = u.id;
  }
  return { property, units: ids };
}

export async function seedDemo(prisma: PrismaClient) {
  const maple = await ensureProperty(prisma, "Maple Court Apartments", "128 Maple Court, Waterloo, ON", ["1A", "2B", "3C", "4B"], MAPLE_NOTES);
  const birch = await ensureProperty(prisma, "Birch House", "40 Birch Street, Waterloo, ON", ["101", "102"], BIRCH_NOTES);

  const plumbing = await ensureVendor(prisma, "Northside Plumbing", ["PLUMBING"], "519-555-0141");
  const plumbing2 = await ensureVendor(prisma, "Harbour Plumbing & Drain", ["PLUMBING"], "519-555-0162");
  const appliance = await ensureVendor(prisma, "BrightSpark Appliance Repair", ["APPLIANCE"], "519-555-0177");
  const hvac = await ensureVendor(prisma, "Evergreen Heating & Cooling", ["HVAC"], "519-555-0193");

  const morgan = await ensureLogin(prisma, { username: "morgan", displayName: "Morgan Reyes", role: "MANAGER" });
  const taylor = await ensureLogin(prisma, { username: "taylor", displayName: "Taylor Brooks", role: "MANAGER" });
  const priya = await ensureLogin(prisma, { username: "priya", displayName: "Priya Nair", role: "RESIDENT" });
  const daniel = await ensureLogin(prisma, { username: "daniel", displayName: "Daniel Osei", role: "RESIDENT" });
  const noor = await ensureLogin(prisma, { username: "noor", displayName: "Noor Haddad", role: "RESIDENT" });
  await ensureLogin(prisma, { username: "sam", displayName: "Sam Okafor", role: "CONTRACTOR", vendorId: plumbing.id });
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

  console.log("[seed] Demo accounts ready (password for all: relay-demo-2026): morgan, taylor (managers); priya, daniel, noor (residents); sam, jo, ana, lee (contractors).");
}

/** Removes every case and restores the default policy. Used by the test hooks; never called in normal operation. */
export async function resetCases(prisma: PrismaClient) {
  await prisma.notification.deleteMany({});
  await prisma.case.deleteMany({});
  await prisma.property.updateMany({ data: { approvalThresholdCents: 25000, vendorResponseMinutes: 1440, verificationReminderMinutes: 1440, verificationCloseAfterMinutes: 4320 } });
  await prisma.vendor.updateMany({ data: { approved: true } });
}
