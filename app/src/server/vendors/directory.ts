// The property's vendor directory. A vendor can be offered a property's work only if a manager approved it for that
// property (PropertyVendor) and it covers the trade. Discovered businesses are not vendors until a manager verifies
// and onboards them (see discovery.ts), so nothing found by a search can ever be dispatched directly.
import { HttpError, prisma } from "wasp/server";
import { type Category, CATEGORY_SHORT, isTrade, managerHandled } from "../../shared/domain";
import type { LoadedCase, Tx } from "../cases/engine";

type Db = Tx | typeof prisma;

const DIRECTORY_INCLUDE = {
  vendor: { include: { _count: { select: { users: true } }, assignments: { select: { status: true, caseId: true } } } },
} as const;

/** Vendors approved at this property for this kind of work, with their workload and history. */
export async function approvedVendorsFor(db: Db, propertyId: string, category: Category) {
  if (managerHandled(category)) return [];
  const rows = await db.propertyVendor.findMany({
    where: { propertyId, approved: true, ...(isTrade(category) ? { vendor: { trades: { has: category } } } : {}) },
    include: DIRECTORY_INCLUDE,
    orderBy: { vendor: { name: "asc" } },
  });
  return rows.map((r) => r.vendor);
}

const ALREADY_TRIED = ["DECLINED", "EXPIRED", "REJECTED", "WITHDRAWN"];

/** How many approved vendors could still take this case (excluding any that already declined or lapsed on it). */
export async function coverage(db: Db, c: Pick<LoadedCase, "id" | "propertyId" | "category">) {
  const vendors = await approvedVendorsFor(db, c.propertyId, c.category);
  const usable = vendors.filter((v) => !v.assignments.some((a) => a.caseId === c.id && ALREADY_TRIED.includes(a.status)));
  return { approved: vendors.length, usable: usable.length, vendors: usable };
}

/** Throws unless the vendor is approved at the case's property for the case's trade. */
export async function assertDispatchable(db: Db, c: Pick<LoadedCase, "propertyId" | "category">, vendorId: string) {
  const vendor = await db.vendor.findUnique({ where: { id: vendorId }, include: { properties: { where: { propertyId: c.propertyId } } } });
  if (!vendor) throw new HttpError(400, "Choose a vendor.");
  if (managerHandled(c.category)) throw new HttpError(409, `${CATEGORY_SHORT[c.category]} cases are handled by the manager, not a vendor.`, { code: "manager_handled" });
  const listing = vendor.properties[0];
  if (!listing?.approved) throw new HttpError(400, `${vendor.name} is not an approved vendor for this property.`, { code: "vendor_not_approved" });
  if (isTrade(c.category) && !vendor.trades.includes(c.category)) {
    throw new HttpError(400, `${vendor.name} is not approved for ${CATEGORY_SHORT[c.category].toLowerCase()} work.`, { code: "vendor_wrong_trade" });
  }
  return vendor;
}

/** Cases at a property that are waiting for a vendor of this trade (to resume once one is approved). */
export async function casesWaitingFor(db: Db, propertyId: string, trades: Category[]) {
  return db.case.findMany({ where: { propertyId, category: { in: trades }, status: { in: ["AWAITING_ASSIGNMENT", "REOPENED"] }, emergency: false }, select: { id: true } });
}
