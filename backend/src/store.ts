// Tiny JSON-file store. Good enough for a one-day hackathon; swap for Postgres later.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { seed } from "./seed.js";
import type { Call, Contractor, DB, Ticket } from "./types.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

function load(): DB {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8")) as DB;
  } catch {
    return structuredClone(seed);
  }
}

export const db: DB = load();

let saveTimer: NodeJS.Timeout | null = null;
export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  }, 100);
}

const now = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

/** Normalize to digits with leading + so "+1 (519) 555-0101" matches "+15195550101". */
export const normPhone = (p: string) => {
  const digits = (p || "").replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  return digits ? `+${digits}` : "";
};

export const findTenantByPhone = (phone: string) =>
  db.tenants.find((t) => normPhone(t.phone) === normPhone(phone));

export const getTicket = (id: string) => db.tickets.find((t) => t.id === id);
export const getContractor = (id: string) => db.contractors.find((c) => c.id === id);

export function createTicket(fields: Omit<Ticket, "id" | "status" | "contractorId" | "slot" | "quote" | "attemptedContractorIds" | "createdAt" | "updatedAt">): Ticket {
  const t: Ticket = {
    ...fields,
    id: newId("tkt"),
    status: "new",
    contractorId: null,
    slot: null,
    quote: null,
    attemptedContractorIds: [],
    createdAt: now(),
    updatedAt: now(),
  };
  db.tickets.unshift(t);
  save();
  return t;
}

export function updateTicket(id: string, patch: Partial<Ticket>): Ticket | undefined {
  const t = getTicket(id);
  if (!t) return undefined;
  Object.assign(t, patch, { updatedAt: now() });
  save();
  return t;
}

export function addCall(fields: Omit<Call, "id" | "startedAt" | "endedAt" | "transcript" | "summary" | "recordingUrl"> & Partial<Call>): Call {
  const c: Call = {
    summary: null,
    transcript: [],
    recordingUrl: null,
    endedAt: null,
    ...fields,
    id: newId("call"),
    startedAt: now(),
  };
  db.calls.unshift(c);
  save();
  return c;
}

export function updateCall(id: string, patch: Partial<Call>) {
  const c = db.calls.find((x) => x.id === id);
  if (!c) return undefined;
  Object.assign(c, patch);
  save();
  return c;
}

export const findCallByConversationId = (cid: string) => db.calls.find((c) => c.conversationId === cid);

export function nextContractor(ticket: Ticket): Contractor | undefined {
  const pool = db.contractors
    .filter((c) => c.trade === ticket.category)
    .filter((c) => !ticket.attemptedContractorIds.includes(c.id))
    .sort((a, b) => a.priority - b.priority);
  if (pool.length) return pool[0];
  // Fall back to general handymen for categories with nobody left
  return db.contractors
    .filter((c) => c.trade === "general" && !ticket.attemptedContractorIds.includes(c.id))
    .sort((a, b) => a.priority - b.priority)[0];
}
