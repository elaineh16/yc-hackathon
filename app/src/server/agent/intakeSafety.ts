// The chat intake's safety net: what must reach a person whatever the assistant does. Deterministic and pure, so the
// evaluation (tests/eval/safety-screen.ts) measures exactly this code.
//
//   1. Every resident message is screened by the same safety rules that classify a filed report. A possible
//      emergency is filed at once by the server, without waiting for the model (see sendIntakeMessage).
//   2. A conversation the assistant could not answer, or that the resident left without anything being filed, is put
//      in front of the property's managers for review (see flagForReview and the minute sweep).
import { triage } from "../../shared/triage";

export type Screen = { emergency: boolean; severity: string; category: string; title: string; reasons: string[]; advice: string | null };

/** The safety rules, run on everything the resident has said so far in the conversation (their words only). */
export function safetyScreen(residentWords: string): Screen {
  const t = triage({ description: residentWords });
  return { emergency: t.emergency, severity: t.severity, category: t.category, title: t.title, reasons: t.reasons, advice: t.safetyAdvice };
}

/** Why an unfinished conversation is in front of a person. */
export const REVIEW_REASONS = {
  assistant_failed: "Relay's assistant could not reply",
  unfinished: "The resident stopped replying before anything was filed",
} as const;
export type ReviewReason = keyof typeof REVIEW_REASONS;

/** Minutes without activity after which an open, unfiled conversation goes to a person. */
export const idleMinutes = () => Math.max(5, Number(process.env.INTAKE_IDLE_MINUTES) || 30);

type ConvLike = { status: string; caseId: string | null; reviewSince: Date | null; pendingSince: Date | null; updatedAt: Date; messages: unknown };

/** The resident's own words in a conversation (the assistant's lines are never screened or forwarded as theirs). */
export const residentWordsOf = (messages: unknown) =>
  (Array.isArray(messages) ? (messages as { role?: string; text?: string }[]) : [])
    .filter((m) => m?.role === "resident" && typeof m.text === "string")
    .map((m) => m.text as string)
    .join("\n");

/** An open conversation with something the resident said, nothing filed, no reply pending and no activity for a while. */
export function idleReviewDue(c: ConvLike, now: Date, minutes = idleMinutes()): boolean {
  return c.status === "OPEN" && c.caseId === null && c.reviewSince === null && c.pendingSince === null && residentWordsOf(c.messages).trim().length > 0 && now.getTime() - c.updatedAt.getTime() >= minutes * 60_000;
}
