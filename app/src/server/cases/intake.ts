// Intake: a resident's report becomes a persisted, triaged case. Three ways in, one code path:
//   TEXT  - the fallback form: the category's questions, triaged by deterministic rules (works with no AI at all)
//   CHAT  - a typed conversation with the intake agent, which submits its reading of the problem
//   VOICE - the ElevenLabs voice agent, which submits the same way
// An agent's reading passes through policy: the rules can only raise severity, and any safety concern escalates.
// The function returns only after the transaction commits, so nobody is told "saved" early.
import { HttpError, prisma } from "wasp/server";
import { caseRef, type Category, CATEGORIES, CATEGORY_SHORT, type CaseStatus, type IntakeChannel, type Severity, SEVERITIES } from "../../shared/domain";
import { validateDetails } from "../../shared/intake";
import { triage } from "../../shared/triage";
import { traced } from "../tracing";
import { type AgentReading, type Classification, classifyAgent, clean } from "./classify";

export type { AgentReading };
import { type ActorCtx, addEvent, CASE_INCLUDE, faults, flagForCoordinator, isUuid, managerIds, move, notify, SYSTEM } from "./engine";

export type IntakeInput = {
  unitId: string;
  description: string;
  /** Generated once per submission attempt; a retry with the same value returns the same case. */
  clientRequestId: string;
  channel: IntakeChannel;
  categoryHint?: Category | null;
  details?: unknown;
  agent?: AgentReading;
  title?: string | null;
  permissionToEnter?: boolean;
  accessNotes?: string | null;
  /** Cases filed from one multi-issue report share this id. */
  intakeGroup?: string | null;
  /**
   * A chat report filed without the assistant's reading, from the resident's own words: by the safety net (the rules
   * saw a possible emergency before the assistant filed anything), or by a manager reviewing a chat the assistant did
   * not finish. Classified by the rules alone, and labelled as such.
   */
  filedBy?: { kind: "SAFETY_NET" } | { kind: "MANAGER"; name: string } | null;
};
export type IntakeResult = {
  caseId: string;
  ref: string;
  title: string;
  status: CaseStatus;
  category: Category;
  severity: Severity;
  emergency: boolean;
  needsReview: boolean;
  duplicate: boolean;
  safetyAdvice: string | null;
  /** How many managers actually received an alert. Nothing may claim more than this. */
  managersNotified: number;
  /** What to tell the resident, built from what really happened. */
  message: string;
};

function resultMessage(r: Pick<IntakeResult, "ref" | "emergency" | "needsReview" | "safetyAdvice" | "managersNotified">): string {
  const told = r.managersNotified > 0 ? "The property manager has been alerted in Relay." : "No manager is set up for this property in Relay yet, so contact the property office directly.";
  if (r.emergency) return `Your report is saved as ${r.ref}. ${r.safetyAdvice ?? "If anyone is in danger, call 911."} ${told} It is being handled as an emergency, not as a routine repair.`;
  if (r.needsReview) return `Your report is saved as ${r.ref}. A person will review it and decide who should handle it. ${told}`;
  return `Your report is saved as ${r.ref}. ${r.managersNotified > 0 ? "The property manager has been notified and Relay is lining up a vendor." : told} You can follow progress on this page.`;
}

/** A chat report filed without the assistant (see IntakeInput.filedBy): the rules read the resident's words. */
function classifyFromChat(description: string, by: NonNullable<IntakeInput["filedBy"]>): Classification {
  const t = triage({ description });
  const why =
    by.kind === "SAFETY_NET"
      ? "Filed from the chat by Relay's safety rules, before the assistant had filed it: the resident's words describe a possible emergency."
      : `Filed by ${by.name} from a chat the assistant did not finish.`;
  return { ...t, reasons: [why, ...t.reasons], details: {}, source: "RULES", observations: [], assumptions: [], openQuestions: [] };
}

/** The form path: the category's questions, validated, triaged by rules. */
function classifyForm(description: string, raw: IntakeInput): Classification {
  const hint = raw.categoryHint && (CATEGORIES as readonly string[]).includes(raw.categoryHint) ? raw.categoryHint : null;
  const first = triage({ description, categoryHint: hint });
  // Validate the answers to the questions the resident was actually shown: those of the category they chose.
  const asked = hint ?? first.category;
  const checked = validateDetails(asked, raw.details);
  if (!checked.ok) {
    throw new HttpError(400, `Some answers are missing or not understood: ${[...checked.missing, ...checked.invalid].join(", ")}.`, { code: "invalid_details", category: asked, missing: checked.missing, invalid: checked.invalid });
  }
  const t = triage({ description, categoryHint: hint, details: checked.details, title: clean(raw.title, 80) || null });
  return { ...t, details: checked.details, source: "RULES", observations: [], assumptions: [], openQuestions: [] };
}

export async function createCase(actor: ActorCtx, raw: IntakeInput): Promise<IntakeResult> {
  if (actor.kind !== "RESIDENT" || actor.userId === null) throw new HttpError(403, "Only residents can report an issue.");
  const residentId = actor.userId;
  const description = clean(raw?.description, 2000);
  const clientRequestId = clean(raw?.clientRequestId, 80);
  const channel: IntakeChannel = raw?.channel === "VOICE" ? "VOICE" : raw?.channel === "CHAT" ? "CHAT" : "TEXT";
  const problems: string[] = [];
  if (description.length < 8) problems.push("description");
  if (clientRequestId.length < 8) problems.push("clientRequestId");
  if (!isUuid(raw?.unitId)) problems.push("unitId");
  if (channel !== "TEXT" && !raw?.agent && !raw?.filedBy) problems.push("agent");
  if (problems.length) throw new HttpError(400, `The report is missing: ${problems.join(", ")}.`, { code: "invalid_report", fields: problems });

  return traced("relay.intake", { channel, residentId }, async () => {
    // A retry of a request that was already saved returns the same case and changes nothing.
    const existing = await prisma.case.findUnique({ where: { residentId_clientRequestId: { residentId, clientRequestId } } });
    if (existing) return toResult(existing, true, null, await countAlerts(existing.id));

    const residency = await prisma.residency.findFirst({ where: { userId: residentId, unitId: raw.unitId, active: true }, include: { unit: true } });
    if (!residency) throw new HttpError(403, "You can only report issues for a unit you live in.");

    const t = raw.filedBy ? classifyFromChat(description, raw.filedBy) : channel === "TEXT" ? classifyForm(description, raw) : classifyAgent(description, raw.agent!, channel);

    try {
      return await prisma.$transaction(async (tx) => {
        const created = await tx.case.create({
          data: {
            propertyId: residency.unit.propertyId,
            unitId: residency.unitId,
            residentId,
            channel,
            clientRequestId,
            title: t.title,
            description,
            category: t.category,
            severity: t.severity,
            emergency: t.emergency,
            needsReview: t.needsReview,
            triageSource: t.source,
            triageReasons: t.reasons,
            summary: t.summary,
            details: t.details as object,
            permissionToEnter: raw.permissionToEnter === true,
            accessNotes: clean(raw.accessNotes, 300) || null,
            observations: t.observations,
            assumptions: t.assumptions,
            openQuestions: t.openQuestions,
            intakeGroup: clean(raw.intakeGroup, 80) || null,
            status: "NEW",
            holder: "SYSTEM",
            nextAction: "Triage the report",
          },
          include: CASE_INCLUDE,
        });
        const ref = caseRef(created.number);
        const via =
          raw.filedBy?.kind === "SAFETY_NET"
            ? "chat with Relay's assistant, filed by the safety rules"
            : raw.filedBy?.kind === "MANAGER"
              ? `chat with Relay's assistant, filed by ${raw.filedBy.name} after the assistant did not finish`
              : channel === "VOICE"
                ? "voice assistant"
                : channel === "CHAT"
                  ? "chat with Relay's assistant"
                  : "text form";
        const reportedId = await addEvent(tx, created.id, actor, {
          type: "REPORTED",
          toStatus: "NEW",
          message: `${actor.name} reported: "${description.length > 160 ? `${description.slice(0, 157)}…` : description}" (${via}).`,
        });
        faults.hit("intake.afterCreate");

        await move(tx, created, "TRIAGE", SYSTEM, {
          message: `Triaged as ${CATEGORY_SHORT[t.category].toLowerCase()}, ${t.severity.toLowerCase()}. ${t.reasons.join(" ")}`,
          data: { category: t.category, severity: t.severity, source: t.source },
        });
        const managers = await managerIds(tx, created.propertyId);
        let managersNotified = 0;
        if (t.emergency) {
          await move(tx, created, "ESCALATE", SYSTEM, { message: "Possible emergency: escalated to the property manager. No routine dispatch." });
          managersNotified = await notify(tx, managers, created.id, "emergency", { kind: "EMERGENCY", title: `Emergency reported: ${t.title}`, body: `${ref} at ${residency.unit.label}. ${t.reasons.join(" ")}` });
        } else if (t.needsReview) {
          managersNotified = await notify(tx, managers, created.id, "review", { kind: "REVIEW_NEEDED", title: `Needs your review: ${t.title}`, body: `${ref} at ${residency.unit.label}.` });
          // The coordinator can still read the case and leave an assessment for the reviewer.
          await flagForCoordinator(tx, created.id, "NEEDS_REVIEW", reportedId);
        } else {
          await move(tx, created, "ROUTE", SYSTEM, { message: "Ready for a vendor to be assigned." });
          managersNotified = await notify(tx, managers, created.id, "new", { kind: "NEW_CASE", title: `New report: ${t.title}`, body: `${ref} at ${residency.unit.label}.` });
        }
        await addEvent(tx, created.id, SYSTEM, {
          type: "MANAGERS_NOTIFIED",
          audience: "MANAGEMENT",
          message: managersNotified > 0 ? `${managersNotified} manager${managersNotified === 1 ? "" : "s"} notified in Relay.` : "No manager is assigned to this property, so nobody was notified.",
        });
        // Follow-up A: the resident gets a record that the report was received, and what happens next.
        await notify(tx, [residentId], created.id, "received", {
          kind: "UPDATE",
          email: true,
          title: `Report received: ${ref}`,
          body: t.emergency
            ? `${t.safetyAdvice ?? "If anyone is in danger, call 911."} Your report "${t.title}" is being handled as an emergency by your property manager.`
            : t.needsReview
              ? `We received "${t.title}". A person will review it and decide who should handle it. You can follow it in Relay.`
              : `We received "${t.title}". Your property manager has it and Relay is lining up the next step. You can follow it in Relay.`,
        });
        return toResult({ ...created }, false, t.safetyAdvice, managersNotified);
      });
    } catch (e) {
      // Two identical submissions raced: the loser returns the winner's case.
      if ((e as { code?: string })?.code === "P2002") {
        const winner = await prisma.case.findUnique({ where: { residentId_clientRequestId: { residentId, clientRequestId } } });
        if (winner) return toResult(winner, true, null, await countAlerts(winner.id));
      }
      throw e;
    }
  });
}

async function countAlerts(caseId: string) {
  return prisma.notification.count({ where: { caseId, kind: { in: ["EMERGENCY", "REVIEW_NEEDED", "NEW_CASE"] } } });
}

function toResult(
  c: { id: string; number: number; title: string; status: CaseStatus; category: Category; severity: Severity; emergency: boolean; needsReview: boolean },
  duplicate: boolean,
  advice: string | null,
  managersNotified: number,
): IntakeResult {
  const safetyAdvice = c.emergency ? (advice ?? "Keep away from the hazard. If anyone is in danger, call 911.") : null;
  const base = { caseId: c.id, ref: caseRef(c.number), title: c.title, status: c.status, category: c.category, severity: c.severity, emergency: c.emergency, needsReview: c.needsReview, duplicate, safetyAdvice, managersNotified };
  return { ...base, message: resultMessage(base) };
}
