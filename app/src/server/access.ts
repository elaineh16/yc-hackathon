// Who may do what. Every operation starts here: there is no path to case data that skips these checks.
import type { AuthUser } from "wasp/auth";
import { HttpError, prisma } from "wasp/server";
import type { Role } from "../shared/domain";
import { type ActorCtx, type LoadedCase, notFound, type Tx } from "./cases/engine";

export type Ctx = { user?: AuthUser | null };

/** The signed-in user as an actor. 401 when nobody is signed in. */
export function actorOf(ctx: Ctx): ActorCtx & { userId: number; kind: Role } {
  const u = ctx.user;
  if (!u) throw new HttpError(401, "Sign in to continue.");
  return { kind: u.role as Role, userId: u.id, name: u.displayName, vendorId: u.vendorId ?? null };
}

/** 403 unless the signed-in user has one of these roles. */
export function requireRole(ctx: Ctx, ...roles: Role[]) {
  const actor = actorOf(ctx);
  if (!roles.includes(actor.kind)) throw new HttpError(403, "Your account cannot do that.");
  return actor;
}

type Db = Tx | typeof prisma;

export async function managedPropertyIds(db: Db, userId: number): Promise<string[]> {
  const rows = await db.propertyMembership.findMany({ where: { userId }, select: { propertyId: true } });
  return rows.map((r) => r.propertyId);
}

/**
 * Object-level check for one loaded case. Managers: only their properties. Residents: only cases they reported.
 * Contractors: only cases their vendor has been offered, has accepted or has completed.
 * Anyone else gets the same "not found" as a missing case.
 */
export async function assertCaseAccess(db: Db, actor: ActorCtx, c: LoadedCase): Promise<void> {
  if (actor.kind === "MANAGER" && actor.userId !== null) {
    const member = await db.propertyMembership.findUnique({ where: { userId_propertyId: { userId: actor.userId, propertyId: c.propertyId } } });
    if (member) return;
  } else if (actor.kind === "RESIDENT") {
    if (c.residentId === actor.userId) return;
  } else if (actor.kind === "CONTRACTOR" && actor.vendorId) {
    if (c.assignments.some((a) => a.vendorId === actor.vendorId && (a.status === "OFFERED" || a.status === "ACCEPTED" || a.status === "COMPLETED"))) return;
  }
  throw notFound();
}

/** The Prisma filter for "cases this user may list". Mirrors assertCaseAccess. */
export async function visibleCasesWhere(db: Db, actor: ActorCtx) {
  if (actor.kind === "MANAGER" && actor.userId !== null) return { propertyId: { in: await managedPropertyIds(db, actor.userId) } };
  if (actor.kind === "RESIDENT" && actor.userId !== null) return { residentId: actor.userId };
  if (actor.kind === "CONTRACTOR" && actor.vendorId) {
    return { assignments: { some: { vendorId: actor.vendorId, status: { in: ["OFFERED", "ACCEPTED", "COMPLETED"] as ("OFFERED" | "ACCEPTED" | "COMPLETED")[] } } } };
  }
  return { id: "none" };
}
