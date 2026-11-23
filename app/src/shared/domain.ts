// Relay's vocabulary. Plain string unions (mirroring the Prisma enums) so the browser and the server share them.

export const ROLES = ["RESIDENT", "MANAGER", "CONTRACTOR"] as const;
export type Role = (typeof ROLES)[number];

export const CATEGORIES = ["PLUMBING", "APPLIANCE", "HVAC", "OTHER"] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ["EMERGENCY", "URGENT", "ROUTINE"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CASE_STATUSES = [
  "NEW",
  "TRIAGED",
  "AWAITING_ASSIGNMENT",
  "AWAITING_VENDOR",
  "AWAITING_APPROVAL",
  "SCHEDULING",
  "SCHEDULED",
  "IN_PROGRESS",
  "AWAITING_VERIFICATION",
  "RESOLVED",
  "ESCALATED",
  "CANCELLED",
  "REOPENED",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const HOLDERS = ["SYSTEM", "RESIDENT", "MANAGER", "CONTRACTOR", "NONE"] as const;
export type Holder = (typeof HOLDERS)[number];

/** SYSTEM = deterministic automation (rules, deadlines). AGENT = Relay's AI coordinator, acting under policy. */
export type Actor = Role | "SYSTEM" | "AGENT";
export type IntakeChannel = "TEXT" | "CHAT" | "VOICE";
export type AssignmentStatus = "OFFERED" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "WITHDRAWN" | "REJECTED" | "CANCELLED" | "COMPLETED";
export type EstimateType = "FIXED" | "INSPECTION_REQUIRED";
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "AUTO_APPROVED" | "VOID";
export type SlotStatus = "PROPOSED" | "ACCEPTED" | "CONFIRMED" | "DECLINED" | "WITHDRAWN" | "SUPERSEDED" | "CANCELLED" | "UNAVAILABLE";
export type Resolution = "VERIFIED_BY_RESIDENT" | "CLOSED_UNVERIFIED";
export type TriageSource = "RULES" | "AGENT" | "VOICE_AGENT" | "MANAGER";

export const CATEGORY_LABEL: Record<Category, string> = {
  PLUMBING: "Plumbing and water",
  APPLIANCE: "Appliances and laundry",
  HVAC: "Heating and cooling",
  OTHER: "Something else",
};
export const CATEGORY_SHORT: Record<Category, string> = { PLUMBING: "Plumbing", APPLIANCE: "Appliance", HVAC: "Heating and cooling", OTHER: "Other" };
export const SEVERITY_LABEL: Record<Severity, string> = { EMERGENCY: "Emergency", URGENT: "Urgent", ROUTINE: "Routine" };
export const STATUS_LABEL: Record<CaseStatus, string> = {
  NEW: "New",
  TRIAGED: "Needs review",
  AWAITING_ASSIGNMENT: "Needs a vendor",
  AWAITING_VENDOR: "Offer sent",
  AWAITING_APPROVAL: "Needs approval",
  SCHEDULING: "Scheduling",
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "In progress",
  AWAITING_VERIFICATION: "Awaiting confirmation",
  RESOLVED: "Resolved",
  ESCALATED: "Escalated",
  CANCELLED: "Cancelled",
  REOPENED: "Reopened",
};
export const HOLDER_LABEL: Record<Holder, string> = { SYSTEM: "Relay", RESIDENT: "Resident", MANAGER: "Manager", CONTRACTOR: "Contractor", NONE: "No one" };

/** Human reference for a case, e.g. RLY-0042. */
export const caseRef = (n: number) => `RLY-${String(n).padStart(4, "0")}`;
export const formatMoney = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

export const isOpen = (s: CaseStatus) => s !== "RESOLVED" && s !== "CANCELLED";
