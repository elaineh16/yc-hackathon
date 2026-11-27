// Property configuration, the vendor directory and approval policy (managers), and notification preferences (anyone).
// Vendors are shared across the portfolio, but approval is per property: a manager only sees, edits and approves
// vendors listed at the properties they run.
import { HttpError, prisma } from "wasp/server";
import { CATEGORIES, type Category, isTrade } from "../shared/domain";
import type { Settings } from "../shared/views";
import { managedPropertyIds } from "./access";
import { type ActorCtx, addEvent, flagForCoordinator, isUuid } from "./cases/engine";
import { emailConfig } from "./notify/config";
import { casesWaitingFor } from "./vendors/directory";

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

export async function getSettings(actor: ActorCtx): Promise<Settings> {
  const propertyIds = await managedPropertyIds(prisma, actor.userId!);
  const [properties, vendors, me] = await Promise.all([
    prisma.property.findMany({
      where: { id: { in: propertyIds } },
      orderBy: { name: "asc" },
      include: { units: { orderBy: { label: "asc" }, include: { residencies: { where: { active: true }, include: { user: { select: { displayName: true } } } } } } },
    }),
    prisma.vendor.findMany({
      where: { properties: { some: { propertyId: { in: propertyIds } } } },
      orderBy: { name: "asc" },
      include: {
        users: { select: { displayName: true } },
        assignments: { where: { status: { in: ["OFFERED", "ACCEPTED"] }, case: { propertyId: { in: propertyIds } } }, select: { id: true } },
        properties: { where: { propertyId: { in: propertyIds } }, include: { property: { select: { name: true } } } },
        _count: { select: { properties: { where: { propertyId: { notIn: propertyIds } } } } },
      },
    }),
    prisma.user.findUniqueOrThrow({ where: { id: actor.userId! }, select: { email: true, emailNotifications: true } }),
  ]);
  const ec = emailConfig();
  return {
    properties: properties.map((p) => ({
      id: p.id,
      name: p.name,
      address: p.address,
      emergencyInstructions: p.emergencyInstructions,
      knowledge: p.knowledge,
      autopilotRoutine: p.autopilotRoutine,
      autoDiscovery: p.autoDiscovery,
      city: p.city,
      region: p.region,
      serviceRadiusKm: p.serviceRadiusKm,
      residentResponseMinutes: p.residentResponseMinutes,
      maxReminders: p.maxReminders,
      appointmentReminderMinutes: p.appointmentReminderMinutes,
      approvalThresholdCents: p.approvalThresholdCents,
      vendorResponseMinutes: p.vendorResponseMinutes,
      verificationReminderMinutes: p.verificationReminderMinutes,
      verificationCloseAfterMinutes: p.verificationCloseAfterMinutes,
      units: p.units.map((u) => ({ id: u.id, label: u.label, residents: u.residencies.map((r) => r.user.displayName) })),
    })),
    vendors: vendors.map((v) => ({
      id: v.id,
      name: v.name,
      trades: v.trades,
      phone: v.phone,
      email: v.email,
      website: v.website,
      notes: v.notes,
      source: v.source,
      logins: v.users.map((u) => u.displayName),
      openJobs: v.assignments.length,
      approvedAt: v.properties.map((pv) => ({ propertyId: pv.propertyId, propertyName: pv.property.name, approved: pv.approved, source: pv.source })),
      sharedElsewhere: v._count.properties > 0,
    })),
    me,
    email: { configured: ec.enabled, capture: ec.capture },
  };
}

async function assertManages(actor: ActorCtx, propertyId: unknown) {
  if (!isUuid(propertyId)) throw new HttpError(404, "Property not found.");
  const member = await prisma.propertyMembership.findUnique({ where: { userId_propertyId: { userId: actor.userId!, propertyId } } });
  if (!member) throw new HttpError(404, "Property not found.");
  return propertyId;
}

export type PropertyUpdate = {
  propertyId: string;
  name?: string;
  address?: string;
  emergencyInstructions?: string;
  knowledge?: string;
  autopilotRoutine?: boolean;
  autoDiscovery?: boolean;
  city?: string;
  region?: string;
  serviceRadiusKm?: number;
  residentResponseMinutes?: number;
  maxReminders?: number;
  appointmentReminderMinutes?: number;
  approvalThresholdCents?: number;
  vendorResponseMinutes?: number;
  verificationReminderMinutes?: number;
  verificationCloseAfterMinutes?: number;
};
const within = (v: unknown, min: number, max: number, label: string): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `${label} must be a whole number between ${min} and ${max}.`);
  return v;
};
const flag = (v: unknown) => (v === undefined ? undefined : v === true);

export async function updateProperty(actor: ActorCtx, input: PropertyUpdate) {
  const propertyId = await assertManages(actor, input?.propertyId);
  const name = input.name === undefined ? undefined : text(input.name, 80);
  const address = input.address === undefined ? undefined : text(input.address, 160);
  const emergencyInstructions = input.emergencyInstructions === undefined ? undefined : text(input.emergencyInstructions, 300);
  if (name !== undefined && name.length < 2) throw new HttpError(400, "Give the property a name.");
  if (address !== undefined && address.length < 4) throw new HttpError(400, "Enter the property's address.");
  if (emergencyInstructions !== undefined && emergencyInstructions.length < 4) throw new HttpError(400, "Emergency instructions cannot be empty.");
  const reminder = within(input.verificationReminderMinutes, 30, 20160, "The reminder interval (minutes)");
  const closeAfter = within(input.verificationCloseAfterMinutes, 60, 43200, "The waiting period before closing (minutes)");
  const current = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
  if ((closeAfter ?? current.verificationCloseAfterMinutes) <= (reminder ?? current.verificationReminderMinutes)) {
    throw new HttpError(400, "The waiting period before closing must be longer than the reminder interval.");
  }
  await prisma.property.update({
    where: { id: propertyId },
    data: {
      name,
      address,
      emergencyInstructions,
      knowledge: input.knowledge === undefined ? undefined : String(input.knowledge).split(String.fromCharCode(13)).join("").trim().slice(0, 6000),
      autopilotRoutine: flag(input.autopilotRoutine),
      autoDiscovery: flag(input.autoDiscovery),
      city: input.city === undefined ? undefined : text(input.city, 60),
      region: input.region === undefined ? undefined : text(input.region, 60),
      serviceRadiusKm: within(input.serviceRadiusKm, 1, 200, "The service radius (km)"),
      residentResponseMinutes: within(input.residentResponseMinutes, 30, 20160, "The time residents have to answer (minutes)"),
      maxReminders: within(input.maxReminders, 0, 5, "The number of reminders"),
      appointmentReminderMinutes: within(input.appointmentReminderMinutes, 30, 4320, "The visit reminder lead time (minutes)"),
      // Estimates at or below this are approved by policy (with autopilot, without a person), so it is capped at $5,000.
      approvalThresholdCents: within(input.approvalThresholdCents, 0, 500_000, "The approval threshold (cents)"),
      vendorResponseMinutes: within(input.vendorResponseMinutes, 5, 20160, "The vendor response time (minutes)"),
      verificationReminderMinutes: reminder,
      verificationCloseAfterMinutes: closeAfter,
    },
  });
  // Policy that lets money or offers move without a person is logged with who changed it.
  const policy = (["autopilotRoutine", "approvalThresholdCents", "autoDiscovery"] as const).filter((k) => input[k] !== undefined);
  if (policy.length) console.info(`[settings] property ${propertyId}: ${policy.map((k) => `${k}=${String(input[k])}`).join(", ")} set by user ${actor.userId}`);
  return { ok: true };
}

export async function addUnit(actor: ActorCtx, input: { propertyId: string; label: string }) {
  const propertyId = await assertManages(actor, input?.propertyId);
  const label = text(input.label, 20);
  if (!label) throw new HttpError(400, "Enter a unit label, for example 4B.");
  const existing = await prisma.unit.findUnique({ where: { propertyId_label: { propertyId, label } } });
  if (existing) throw new HttpError(409, `Unit ${label} already exists.`);
  const unit = await prisma.unit.create({ data: { propertyId, label } });
  return { ok: true, unitId: unit.id };
}

export type VendorInput = { id?: string; name: string; trades: Category[]; phone?: string; email?: string; website?: string; notes?: string; propertyIds?: string[] };

/**
 * A vendor in this manager's directory (listed at one of their properties); anything else is "not found". Its name,
 * trades and contacts are shared by every property that lists it, so changing them (`edit`) also requires managing
 * every one of those properties. Approval is per property and needs only the first check.
 */
async function vendorInMyDirectory(actor: ActorCtx, vendorId: unknown, mine: string[], o: { edit?: boolean } = {}) {
  if (!isUuid(vendorId)) throw new HttpError(404, "Vendor not found.");
  const v = await prisma.vendor.findFirst({ where: { id: vendorId, properties: { some: { propertyId: { in: mine } } } } });
  if (!v) throw new HttpError(404, "Vendor not found.");
  if (o.edit && (await prisma.propertyVendor.count({ where: { vendorId: v.id, propertyId: { notIn: mine } } })) > 0) {
    throw new HttpError(403, `${v.name} is also used by a property you do not manage, so only a manager of every property that uses it can change its details. You can still approve it or remove its approval for your properties.`, { code: "vendor_shared" });
  }
  return v;
}

/** Adds a vendor approved at the chosen properties (default: all of this manager's), or edits one in their directory. */
export async function saveVendor(actor: ActorCtx, input: VendorInput) {
  const mine = await managedPropertyIds(prisma, actor.userId!);
  const name = text(input?.name, 80);
  if (name.length < 2) throw new HttpError(400, "Give the vendor a name.");
  const trades = [...new Set((Array.isArray(input.trades) ? input.trades : []).filter((t) => (CATEGORIES as readonly string[]).includes(t) && isTrade(t)))];
  if (trades.length === 0) throw new HttpError(400, "Choose at least one trade this vendor is approved for.");
  const email = text(input.email, 120) || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "That email address does not look right.");
  const website = text(input.website, 200) || null;
  if (website && !/^https?:\/\/\S+$/i.test(website)) throw new HttpError(400, "The website must start with http:// or https://.");
  const data = { name, trades, phone: text(input.phone, 40) || null, email, website, notes: text(input.notes, 300) || null };
  const clash = await prisma.vendor.findUnique({ where: { name } });
  if (input.id) {
    const v = await vendorInMyDirectory(actor, input.id, mine, { edit: true });
    if (clash && clash.id !== v.id) throw new HttpError(409, `A vendor called ${name} already exists.`);
    await prisma.vendor.update({ where: { id: v.id }, data });
    const listed = (await prisma.propertyVendor.findMany({ where: { vendorId: v.id, approved: true, propertyId: { in: mine } }, select: { propertyId: true } })).map((x) => x.propertyId);
    return { ok: true, vendorId: v.id, resumed: await resumeWaiting(actor, v.id, listed, trades) };
  }
  if (clash) throw new HttpError(409, `A vendor called ${name} already exists in Relay. Use a different name, or ask the manager of a property that uses it to share it.`);
  const targets = Array.isArray(input.propertyIds) && input.propertyIds.length ? input.propertyIds.filter((id) => mine.includes(id)) : mine;
  if (targets.length === 0) throw new HttpError(400, "Choose a property you manage.");
  const v = await prisma.vendor.create({ data: { ...data, source: "MANUAL", properties: { create: targets.map((propertyId) => ({ propertyId, approved: true, approvedAt: new Date(), approvedById: actor.userId, source: "MANUAL" })) } } });
  return { ok: true, vendorId: v.id, resumed: await resumeWaiting(actor, v.id, targets, trades) };
}

/**
 * Approve or remove approval of a vendor at one property. Removing approval stops new offers; work already offered or
 * accepted is left to run or be withdrawn by hand.
 */
export async function setVendorApproved(actor: ActorCtx, input: { vendorId: string; approved: boolean; propertyId?: string }) {
  const mine = await managedPropertyIds(prisma, actor.userId!);
  const v = await vendorInMyDirectory(actor, input?.vendorId, mine);
  const targets = input.propertyId ? [await assertManages(actor, input.propertyId)] : mine;
  for (const propertyId of targets) {
    await prisma.propertyVendor.upsert({
      where: { propertyId_vendorId: { propertyId, vendorId: v.id } },
      update: { approved: input.approved === true, approvedAt: input.approved === true ? new Date() : null, approvedById: actor.userId },
      create: { propertyId, vendorId: v.id, approved: input.approved === true, approvedAt: input.approved === true ? new Date() : null, approvedById: actor.userId, source: "MANUAL" },
    });
  }
  return { ok: true, resumed: input.approved === true ? await resumeWaiting(actor, v.id, targets, v.trades) : [] };
}

/** A vendor became available for these trades: cases waiting for one at these properties wake the coordinator. */
async function resumeWaiting(actor: ActorCtx, vendorId: string, propertyIds: string[], trades: Category[]): Promise<string[]> {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { name: true } });
  const resumed: string[] = [];
  for (const propertyId of propertyIds) {
    const waiting = await casesWaitingFor(prisma, propertyId, trades.filter(isTrade));
    for (const w of waiting) {
      await prisma.$transaction(async (tx) => {
        const eventId = await addEvent(tx, w.id, actor, { type: "VENDOR_ADDED", audience: "MANAGEMENT", message: `${actor.name} added ${vendor?.name ?? "a vendor"} to this property's approved vendors.`, vendorId });
        await flagForCoordinator(tx, w.id, "VENDOR_ONBOARDED", eventId);
      });
      resumed.push(w.id);
    }
  }
  return resumed;
}

/** Anyone: an email address for notifications, and whether to receive them by email (opt-in). */
export async function updateMyNotifications(actor: ActorCtx, input: { email?: string | null; emailNotifications?: boolean }) {
  const email = input?.email === undefined ? undefined : text(input.email, 120) || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "That email address does not look right.");
  const current = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId! }, select: { email: true } });
  const on = input?.emailNotifications === undefined ? undefined : input.emailNotifications === true;
  if (on && !(email !== undefined ? email : current.email)) throw new HttpError(400, "Add an email address first.");
  await prisma.user.update({ where: { id: actor.userId! }, data: { email, emailNotifications: on } });
  return { ok: true };
}
