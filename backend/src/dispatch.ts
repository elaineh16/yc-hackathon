// The dispatch loop: call contractors one at a time until one accepts,
// then call the tenant to confirm. Ordering and retries live here, not in prompts.
import { config, startOutboundCall } from "./elevenlabs.js";
import { addCall, db, getContractor, getTicket, nextContractor, updateCall, updateTicket } from "./store.js";
import type { Ticket } from "./types.js";

const timeouts = new Map<string, NodeJS.Timeout>(); // ticketId -> timer for current contractor
const timeoutMs = () => Number(process.env.CONTRACTOR_TIMEOUT_SECONDS || 90) * 1000;

const building = () => ({
  building_name: process.env.BUILDING_NAME || "Maple Court",
  address: process.env.BUILDING_ADDRESS || "",
});

function ticketVars(t: Ticket) {
  return {
    ...building(),
    ticket_id: t.id,
    tenant_name: t.tenantName,
    unit: t.unit,
    category: t.category,
    urgency: t.urgency,
    summary: t.summary,
    location: t.location,
    access_windows: t.accessWindows,
  };
}

/** Kick off (or continue) dispatch for a ticket. Safe to call repeatedly. */
export async function dispatchNext(ticketId: string, reason = "start"): Promise<void> {
  const t = getTicket(ticketId);
  if (!t) return;
  if (!["new", "dispatching", "escalated"].includes(t.status)) return; // already booked / done

  clearTimer(ticketId);
  const c = nextContractor(t);
  if (!c) {
    console.log(`[dispatch] ${t.id}: no contractors left (${reason}) -> needs_human`);
    updateTicket(t.id, { status: "needs_human" });
    return;
  }

  updateTicket(t.id, {
    status: t.status === "escalated" ? "escalated" : "dispatching",
    attemptedContractorIds: [...t.attemptedContractorIds, c.id],
  });

  const call = addCall({
    ticketId: t.id,
    agent: "dispatch",
    direction: "outbound",
    counterpartName: `${c.name} (${c.company})`,
    counterpartPhone: c.phone,
    contractorId: c.id,
    outcome: "in_progress",
    conversationId: null,
    callSid: null,
  });

  console.log(`[dispatch] ${t.id}: calling ${c.name} ${c.phone} (${reason})`);
  try {
    const r = await startOutboundCall({
      agentId: config.agents.dispatch(),
      toNumber: c.phone,
      dynamicVariables: {
        ...ticketVars(t),
        contractor_id: c.id,
        contractor_name: c.name,
        max_budget: c.maxBudget,
      },
    });
    updateCall(call.id, { conversationId: r.conversationId, callSid: r.callSid });
  } catch (err) {
    console.error(`[dispatch] call to ${c.phone} failed`, err);
    updateCall(call.id, { outcome: "failed", endedAt: new Date().toISOString() });
    return dispatchNext(t.id, "previous call failed");
  }

  // If we never hear back, move on.
  timeouts.set(
    t.id,
    setTimeout(() => {
      const open = db.calls.find((x) => x.id === call.id);
      if (open && open.outcome === "in_progress") {
        updateCall(call.id, { outcome: "no_answer", endedAt: new Date().toISOString() });
      }
      dispatchNext(t.id, "timeout");
    }, timeoutMs()),
  );
}

function clearTimer(ticketId: string) {
  const tm = timeouts.get(ticketId);
  if (tm) clearTimeout(tm);
  timeouts.delete(ticketId);
}

/** Called when a contractor gives an answer (from the record_contractor_response tool). */
export async function handleContractorResponse(opts: {
  ticketId: string;
  contractorId: string;
  accepted: boolean;
  slot?: string;
  quote?: string;
  notes?: string;
}) {
  const t = getTicket(opts.ticketId);
  if (!t) throw new Error(`unknown ticket ${opts.ticketId}`);

  const call = db.calls.find(
    (c) => c.ticketId === t.id && c.contractorId === opts.contractorId && c.agent === "dispatch" && c.outcome === "in_progress",
  );
  if (call) updateCall(call.id, { outcome: opts.accepted ? "accepted" : "declined", summary: opts.notes ?? call.summary });

  if (!opts.accepted) {
    // Give the agent a moment to say goodbye before the next phone rings.
    setTimeout(() => dispatchNext(t.id, "declined"), 3000);
    return { next: "calling next contractor" };
  }

  clearTimer(t.id);
  updateTicket(t.id, {
    status: t.status === "escalated" ? "escalated" : "booked",
    contractorId: opts.contractorId,
    slot: opts.slot ?? null,
    quote: opts.quote ?? null,
  });
  // Call the tenant once the contractor call has wrapped up.
  setTimeout(() => startConfirmCall(t.id).catch((e) => console.error("[confirm] failed", e)), 8000);
  return { next: "booked; tenant will be called to confirm" };
}

export async function startConfirmCall(ticketId: string) {
  const t = getTicket(ticketId);
  if (!t || !t.contractorId) return;
  const c = getContractor(t.contractorId);
  const call = addCall({
    ticketId: t.id,
    agent: "confirm",
    direction: "outbound",
    counterpartName: t.tenantName,
    counterpartPhone: t.tenantPhone,
    contractorId: null,
    outcome: "in_progress",
    conversationId: null,
    callSid: null,
  });
  const r = await startOutboundCall({
    agentId: config.agents.confirm(),
    toNumber: t.tenantPhone,
    dynamicVariables: {
      ...ticketVars(t),
      contractor_name: c ? `${c.name} from ${c.company}` : "the contractor",
      slot: t.slot ?? "the agreed time",
      quote: t.quote ?? "",
    },
  });
  updateCall(call.id, { conversationId: r.conversationId, callSid: r.callSid });
}

export async function escalateToManager(ticketId: string, reason: string) {
  const t = getTicket(ticketId);
  const managerPhone = process.env.MANAGER_PHONE;
  if (!t) return;
  updateTicket(t.id, { status: "escalated" });
  if (!managerPhone) {
    console.warn("[escalate] MANAGER_PHONE not set; marked escalated only");
    return;
  }
  const call = addCall({
    ticketId: t.id,
    agent: "escalation",
    direction: "outbound",
    counterpartName: "Manager",
    counterpartPhone: managerPhone,
    contractorId: null,
    outcome: "in_progress",
    conversationId: null,
    callSid: null,
  });
  // Reuses the confirm agent's voice with an emergency briefing; swap for a dedicated agent if time allows.
  const r = await startOutboundCall({
    agentId: config.agents.confirm(),
    toNumber: managerPhone,
    dynamicVariables: {
      ...ticketVars(t),
      tenant_name: "the manager",
      contractor_name: "an emergency",
      slot: `right away: ${reason}`,
      quote: "",
    },
  });
  updateCall(call.id, { conversationId: r.conversationId, callSid: r.callSid });
}
