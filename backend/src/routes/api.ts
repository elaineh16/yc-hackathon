// REST API for the manager dashboard. Poll GET /api/tickets every ~2s for "live" updates.
import { Router } from "express";
import { dispatchNext } from "../dispatch.js";
import { isDryRun } from "../elevenlabs.js";
import { db, getTicket, newId, save } from "../store.js";
import type { Contractor } from "../types.js";

export const api = Router();

const withCalls = (ticketId: string) =>
  db.calls.filter((c) => c.ticketId === ticketId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));

const withContractor = (contractorId: string | null) => db.contractors.find((c) => c.id === contractorId) ?? null;

api.get("/status", (_req, res) => res.json({ ok: true, dryRun: isDryRun() }));

api.get("/tickets", (_req, res) => {
  res.json(db.tickets.map((t) => ({ ...t, contractor: withContractor(t.contractorId), calls: withCalls(t.id) })));
});

api.get("/tickets/:id", (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: "not found" });
  res.json({ ...t, contractor: withContractor(t.contractorId), calls: withCalls(t.id) });
});

/** Manager can re-run dispatch from the dashboard (e.g. for needs_human tickets). */
api.post("/tickets/:id/redispatch", async (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: "not found" });
  t.status = "dispatching";
  t.attemptedContractorIds = [];
  save();
  await dispatchNext(t.id, "manual redispatch");
  res.json({ ok: true });
});

api.get("/contractors", (_req, res) => res.json(db.contractors));

api.post("/contractors", (req, res) => {
  const c: Contractor = { id: newId("c"), priority: 9, maxBudget: 300, ...req.body };
  db.contractors.push(c);
  save();
  res.json(c);
});

api.put("/contractors/:id", (req, res) => {
  const c = db.contractors.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "not found" });
  Object.assign(c, req.body, { id: c.id });
  save();
  res.json(c);
});

api.get("/tenants", (_req, res) => res.json(db.tenants));
