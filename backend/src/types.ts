export type Category = "plumbing" | "electrical" | "hvac" | "appliance" | "locks" | "general";
export type Urgency = "emergency" | "urgent" | "routine";
export type TicketStatus =
  | "new"
  | "dispatching"
  | "booked"
  | "confirmed"
  | "done"
  | "escalated"
  | "needs_human";

export type AgentKind = "intake" | "dispatch" | "confirm" | "escalation";

export interface Tenant {
  id: string;
  name: string;
  phone: string; // E.164
  unit: string;
}

export interface Contractor {
  id: string;
  name: string;
  company: string;
  phone: string; // E.164
  trade: Category;
  priority: number; // lower = called first
  maxBudget: number; // CAD
}

export interface Ticket {
  id: string;
  tenantId: string | null;
  tenantName: string;
  tenantPhone: string;
  unit: string;
  category: Category;
  urgency: Urgency;
  summary: string;
  location: string;
  accessWindows: string;
  status: TicketStatus;
  contractorId: string | null;
  slot: string | null;
  quote: string | null;
  attemptedContractorIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Call {
  id: string;
  ticketId: string | null;
  agent: AgentKind;
  direction: "inbound" | "outbound";
  counterpartName: string;
  counterpartPhone: string;
  contractorId: string | null;
  outcome: string; // e.g. "in_progress", "accepted", "declined", "no_answer", "confirmed", "ticket_created"
  summary: string | null;
  transcript: { role: string; message: string }[];
  conversationId: string | null;
  callSid: string | null;
  recordingUrl: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface DB {
  tenants: Tenant[];
  contractors: Contractor[];
  tickets: Ticket[];
  calls: Call[];
}
