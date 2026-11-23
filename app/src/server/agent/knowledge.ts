// Retrieval for the agents: the property's own notes and its past cases. Plain keyword scoring over
// rows the caller is allowed to see; no embeddings service is needed.
import { prisma } from "wasp/server";
import { caseRef, CATEGORY_SHORT } from "../../shared/domain";

const STOP = new Set("a an and are at be but by for from has have i in is it its my of on or our so that the their there this to was we with you your not no do does did can will just me".split(" "));
const terms = (s: string) =>
  [...new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, "")))];

/** The most relevant paragraphs of the property's notes for a query. */
export async function searchKnowledge(propertyId: string, query: string, limit = 3) {
  const p = await prisma.property.findUnique({ where: { id: propertyId }, select: { name: true, knowledge: true, emergencyInstructions: true } });
  if (!p) return { ok: false as const, error: "Property not found." };
  const chunks = p.knowledge
    .split(/\n\s*\n|\n(?=\s*[-*•])/)
    .map((c) => c.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
  const q = terms(query);
  const ranked = chunks
    .map((text) => {
      const t = new Set(terms(text));
      return { text, score: q.filter((w) => t.has(w)).length };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return {
    ok: true as const,
    property: p.name,
    emergencyInstructions: p.emergencyInstructions,
    notes: ranked.map((r) => r.text),
    note: ranked.length ? undefined : "The property's notes have nothing on this. Do not guess.",
  };
}

/** Earlier cases at the same property that look similar: what happened and who did the work. */
export async function searchPastCases(propertyId: string, query: string, excludeCaseId?: string, limit = 4) {
  const words = terms(query).slice(0, 6);
  if (words.length === 0) return { ok: true as const, cases: [] };
  const rows = await prisma.case.findMany({
    where: {
      propertyId,
      ...(excludeCaseId ? { id: { not: excludeCaseId } } : {}),
      OR: words.flatMap((w) => [{ title: { contains: w, mode: "insensitive" as const } }, { description: { contains: w, mode: "insensitive" as const } }]),
    },
    include: { unit: { select: { label: true } }, assignments: { where: { status: { in: ["ACCEPTED", "COMPLETED"] } }, include: { vendor: { select: { name: true } } }, orderBy: { offeredAt: "desc" }, take: 1 } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return {
    ok: true as const,
    cases: rows.map((c) => ({
      ref: caseRef(c.number),
      title: c.title,
      category: CATEGORY_SHORT[c.category],
      unit: c.unit.label,
      status: c.status,
      vendor: c.assignments[0]?.vendor.name ?? null,
      reported: c.createdAt.toISOString().slice(0, 10),
      resolution: c.resolution,
    })),
  };
}
