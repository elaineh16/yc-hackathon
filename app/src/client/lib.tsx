// Client helpers: formatting, status presentation, and a small hook for running server actions.
import { useState } from "react";
import { type Actor, type CaseStatus, CATEGORY_SHORT, type Category, type Holder, type Role, type Severity, STATUS_LABEL } from "../shared/domain";

export const TZ = "America/Toronto";
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, ...o });

export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff >= 0 && diff < 45) return "just now";
  if (diff >= 0 && diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff >= 0 && diff < 6 * 3600) return `${Math.round(diff / 3600)} h ago`;
  return fmt({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}
export const clock = (iso: string) => fmt({ hour: "numeric", minute: "2-digit" }).format(new Date(iso));
export const dayTime = (iso: string) => fmt({ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
export const dueIn = (iso: string | null) => {
  if (!iso) return null;
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (mins < 0) return { text: `overdue by ${span(-mins)}`, overdue: true };
  return { text: `due in ${span(mins)}`, overdue: false };
};
const span = (mins: number) => (mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`);
export const money = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);
export const toCents = (dollars: string) => {
  const n = Number(dollars.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

export type Tone = "neutral" | "danger" | "warn" | "info" | "ok" | "move" | "ai" | "outline";
export const STATUS_TONE: Record<CaseStatus, Tone> = {
  NEW: "neutral",
  TRIAGED: "warn",
  AWAITING_ASSIGNMENT: "warn",
  AWAITING_VENDOR: "info",
  AWAITING_APPROVAL: "warn",
  SCHEDULING: "info",
  SCHEDULED: "info",
  IN_PROGRESS: "info",
  AWAITING_VERIFICATION: "info",
  RESOLVED: "ok",
  ESCALATED: "danger",
  CANCELLED: "outline",
  REOPENED: "warn",
};
export const SEVERITY_TONE: Record<Severity, Tone> = { EMERGENCY: "danger", URGENT: "warn", ROUTINE: "neutral" };
export const statusLabel = (s: CaseStatus) => STATUS_LABEL[s];
export const categoryLabel = (c: Category) => CATEGORY_SHORT[c];

/** "Waiting on you" when the viewer holds the case. */
export function holderText(holder: Holder, viewer: Role): { text: string; mine: boolean } {
  if (holder === "NONE") return { text: "Closed", mine: false };
  if (holder === viewer) return { text: "Your move", mine: true };
  const who: Record<Holder, string> = { SYSTEM: "Relay", RESIDENT: "the resident", MANAGER: "the manager", CONTRACTOR: "the contractor", NONE: "" };
  return { text: `Waiting on ${who[holder]}`, mine: false };
}
export const actorLabel = (role: Actor) => ({ RESIDENT: "Resident", MANAGER: "Manager", CONTRACTOR: "Contractor", SYSTEM: "Relay", AGENT: "Relay AI" })[role];

/** Runs a server action with a busy flag and the server's error message. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, setError, run };
}
export function errorText(e: unknown): string {
  const err = e as { message?: string; statusCode?: number };
  if (err?.statusCode === 401) return "Your session ended. Sign in again.";
  return err?.message || "Something went wrong. Try again.";
}
/** A random id generated once per submission attempt, so a retry is recognised as the same request. */
export const requestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
