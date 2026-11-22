// Server tools the ElevenLabs agents call DURING a conversation.
// Configure each one in the ElevenLabs agent as a "Webhook" tool: POST {PUBLIC_URL}/tools/<name>
// with the JSON body params listed in agents/tools.md.
import { Router } from "express";
import { dispatchNext, escalateToManager, handleContractorResponse } from "../dispatch.js";
import { addCall, createTicket, db, findTenantByPhone, getContractor, getTicket, normPhone, updateCall, updateTicket } from "../store.js";
import type { Category, Urgency } from "../types.js";

export const tools = Router();

const CATEGORIES: Category[] = ["plumbing", "electrical", "hvac", "appliance", "locks", "general"];
const URGENCIES: Urgency[] = ["emergency", "urgent", "routine"];
const asCategory = (v: unknown): Category => (CATEGORIES.includes(v as Category) ? (v as Category) : "general");
const asUrgency = (v: unknown): Urgency => (URGENCIES.includes(v as Urgency) ? (v as Urgency) : "routine");
const str = (v: unknown, d = "") => (typeof v === "string" ? v : v == null ? d : String(v));
const bool = (v: unknown) => v === true || v === "true" || v === "yes";

tools.use((req, _res, next) => {
  console.log(`[tool] ${req.path}`, JSON.stringify(req.body));
  next();
});

/** Intake: who is calling? body: { caller_phone } */
tools.post("/lookup_tenant", (req, res) => {
  const tenant = findTenantByPhone(str(req.body.caller_phone));
  if (!tenant) return res.json({ found: false, message: "Unknown caller. Ask for their name and unit." });
  res.json({ found: true, tenant_name: tenant.name, unit: tenant.unit });
});

/**
 * Intake: save the issue and start calling contractors.
 * body: { caller_phone, tenant_name?, unit?, category, urgency, summary, location, access_windows, conversation_id? }
 */
tools.post("/create_ticket", (req, res) => {
  const b = req.body;
  const phone = normPhone(str(b.caller_phone));
  const tenant = findTenantByPhone(phone);
  const ticket = createTicket({
    tenantId: tenant?.id ?? null,
    tenantName: str(b.tenant_name) || tenant?.name || "Tenant",
    tenantPhone: phone || tenant?.phone || "",
    unit: str(b.unit) || tenant?.unit || "unknown",
    category: asCategory(b.category),
    urgency: asUrgency(b.urgency),
    summary: str(b.summary, "Issue reported by phone"),
    location: str(b.location),
    accessWindows: str(b.access_windows, "anytime"),
  });

  // Link the in-progress intake call to this ticket (or create the record).
  const convId = str(b.conversation_id) || null;
  const existing = convId ? db.calls.find((c) => c.conversationId === convId) : undefined;
  if (existing) updateCall(existing.id, { ticketId: ticket.id, outcome: "ticket_created" });
  else
    addCall({
      ticketId: ticket.id,
      agent: "intake",
      direction: "inbound",
      counterpartName: ticket.tenantName,
      counterpartPhone: ticket.tenantPhone,
      contractorId: null,
      outcome: "ticket_created",
      conversationId: convId,
      callSid: null,
    });

  // Don't block the tenant's call on outbound dialing.
  setTimeout(() => dispatchNext(ticket.id, "ticket created").catch(console.error), 2000);
  res.json({ ticket_id: ticket.id, message: "Ticket created. Tell the tenant you are calling contractors now and will call back with a time." });
});

/** Intake: danger detected. body: { ticket_id?, caller_phone?, reason } */
tools.post("/escalate_emergency", async (req, res) => {
  let ticketId = str(req.body.ticket_id);
  if (!ticketId || !getTicket(ticketId)) {
    const phone = normPhone(str(req.body.caller_phone));
    const tenant = findTenantByPhone(phone);
    ticketId = createTicket({
      tenantId: tenant?.id ?? null,
      tenantName: tenant?.name ?? "Tenant",
      tenantPhone: phone,
      unit: tenant?.unit ?? "unknown",
      category: asCategory(req.body.category),
      urgency: "emergency",
      summary: str(req.body.reason, "Emergency reported"),
      location: "",
      accessWindows: "now",
    }).id;
    setTimeout(() => dispatchNext(ticketId, "emergency").catch(console.error), 2000);
  }
  escalateToManager(ticketId, str(req.body.reason, "emergency")).catch(console.error);
  res.json({
    ticket_id: ticketId,
    message: "The manager is being called now. Tell the tenant help is on the way and give safety advice (leave the unit if gas, shut off water if possible, call 911 if anyone is in danger).",
  });
});

/** Dispatch / Confirm: read ticket details. body: { ticket_id } */
tools.post("/get_ticket", (req, res) => {
  const t = getTicket(str(req.body.ticket_id));
  if (!t) return res.status(404).json({ error: "ticket not found" });
  const c = t.contractorId ? getContractor(t.contractorId) : undefined;
  res.json({ ...t, contractor_name: c?.name ?? null, contractor_company: c?.company ?? null });
});

/** Dispatch: contractor's answer. body: { ticket_id, contractor_id, accepted, slot?, quote?, notes? } */
tools.post("/record_contractor_response", async (req, res) => {
  try {
    const r = await handleContractorResponse({
      ticketId: str(req.body.ticket_id),
      contractorId: str(req.body.contractor_id),
      accepted: bool(req.body.accepted),
      slot: str(req.body.slot) || undefined,
      quote: str(req.body.quote) || undefined,
      notes: str(req.body.notes) || undefined,
    });
    res.json({ ok: true, ...r, message: "Recorded. Thank the contractor and end the call." });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

/** Confirm: tenant's answer. body: { ticket_id, confirmed, notes? } */
tools.post("/confirm_booking", (req, res) => {
  const t = getTicket(str(req.body.ticket_id));
  if (!t) return res.status(404).json({ error: "ticket not found" });
  const confirmed = bool(req.body.confirmed);
  if (t.status !== "escalated") updateTicket(t.id, { status: confirmed ? "confirmed" : "needs_human" });
  const call = db.calls.find((c) => c.ticketId === t.id && c.agent === "confirm" && c.outcome === "in_progress");
  if (call) updateCall(call.id, { outcome: confirmed ? "confirmed" : "reschedule_requested", summary: str(req.body.notes) || null });
  res.json({ ok: true, message: confirmed ? "Confirmed. Say goodbye." : "Noted. Tell the tenant the manager will follow up." });
});
