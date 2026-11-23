// Property configuration, vendor management and approval policy. Managers only.
import { HttpError, prisma } from "wasp/server";
import { CATEGORIES, type Category } from "../shared/domain";
import type { Settings } from "../shared/views";
import { managedPropertyIds } from "./access";
import { type ActorCtx, isUuid } from "./cases/engine";

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

export async function getSettings(actor: ActorCtx): Promise<Settings> {
  const propertyIds = await managedPropertyIds(prisma, actor.userId!);
  const [properties, vendors] = await Promise.all([
    prisma.property.findMany({
      where: { id: { in: propertyIds } },
      orderBy: { name: "asc" },
      include: { units: { orderBy: { label: "asc" }, include: { residencies: { where: { active: true }, include: { user: { select: { displayName: true } } } } } } },
    }),
    prisma.vendor.findMany({
      orderBy: { name: "asc" },
      include: { users: { select: { displayName: true } }, assignments: { where: { status: { in: ["OFFERED", "ACCEPTED"] } }, select: { id: true } } },
    }),
  ]);
  return {
    properties: properties.map((p) => ({
      id: p.id,
      name: p.name,
      address: p.address,
      emergencyInstructions: p.emergencyInstructions,
      knowledge: p.knowledge,
      autopilotRoutine: p.autopilotRoutine,
      approvalThresholdCents: p.approvalThresholdCents,
      vendorResponseMinutes: p.vendorResponseMinutes,
      verificationReminderMinutes: p.verificationReminderMinutes,
      verificationCloseAfterMinutes: p.verificationCloseAfterMinutes,
      units: p.units.map((u) => ({ id: u.id, label: u.label, residents: u.residencies.map((r) => r.user.displayName) })),
    })),
    vendors: vendors.map((v) => ({ id: v.id, name: v.name, trades: v.trades, phone: v.phone, email: v.email, approved: v.approved, notes: v.notes, logins: v.users.map((u) => u.displayName), openJobs: v.assignments.length })),
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
      autopilotRoutine: input.autopilotRoutine === undefined ? undefined : input.autopilotRoutine === true,
      approvalThresholdCents: within(input.approvalThresholdCents, 0, 10_000_000, "The approval threshold (cents)"),
      vendorResponseMinutes: within(input.vendorResponseMinutes, 5, 20160, "The vendor response time (minutes)"),
      verificationReminderMinutes: reminder,
      verificationCloseAfterMinutes: closeAfter,
    },
  });
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

export type VendorInput = { id?: string; name: string; trades: Category[]; phone?: string; email?: string; notes?: string; approved?: boolean };

export async function saveVendor(_actor: ActorCtx, input: VendorInput) {
  const name = text(input?.name, 80);
  if (name.length < 2) throw new HttpError(400, "Give the vendor a name.");
  const trades = [...new Set((Array.isArray(input.trades) ? input.trades : []).filter((t) => (CATEGORIES as readonly string[]).includes(t) && t !== "OTHER"))];
  if (trades.length === 0) throw new HttpError(400, "Choose at least one trade this vendor is approved for.");
  const email = text(input.email, 120) || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "That email address does not look right.");
  const data = { name, trades, phone: text(input.phone, 40) || null, email, notes: text(input.notes, 300) || null, approved: input.approved !== false };
  const clash = await prisma.vendor.findUnique({ where: { name } });
  if (clash && clash.id !== input.id) throw new HttpError(409, `A vendor called ${name} already exists.`);
  if (input.id) {
    if (!isUuid(input.id) || !(await prisma.vendor.findUnique({ where: { id: input.id } }))) throw new HttpError(404, "Vendor not found.");
    await prisma.vendor.update({ where: { id: input.id }, data });
    return { ok: true, vendorId: input.id };
  }
  const v = await prisma.vendor.create({ data });
  return { ok: true, vendorId: v.id };
}

/** Removing approval stops new offers. Work already offered or accepted is left to run or be withdrawn by hand. */
export async function setVendorApproved(_actor: ActorCtx, input: { vendorId: string; approved: boolean }) {
  if (!isUuid(input?.vendorId) || !(await prisma.vendor.findUnique({ where: { id: input.vendorId } }))) throw new HttpError(404, "Vendor not found.");
  await prisma.vendor.update({ where: { id: input.vendorId }, data: { approved: input.approved === true } });
  return { ok: true };
}
