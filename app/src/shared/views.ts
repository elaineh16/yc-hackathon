// What the server returns to the pages. Plain `type` aliases (Wasp serializes them as-is). Dates are ISO strings.
// The UI must render from these shapes only: there is no client-side copy of the rules.
import type { Actor, ApprovalStatus, AssignmentStatus, CaseStatus, Category, EstimateType, Holder, IntakeChannel, Resolution, Role, Severity, SlotStatus, TriageSource } from "./domain";

export type UnitRef = { id: string; label: string; propertyId: string; propertyName: string; address: string };

export type Me = {
  id: number;
  name: string;
  username: string;
  role: Role;
  /** Contractors: the vendor they act for. */
  vendor: { id: string; name: string } | null;
  /** Residents: the units they live in. */
  units: UnitRef[];
  /** Managers: the properties they run. */
  properties: { id: string; name: string }[];
  /** Voice intake is offered only when the server has ElevenLabs configured. */
  voiceAvailable: boolean;
};

export type AiStatus = { available: boolean; model: string; reason: string };

export type CaseListItem = {
  id: string;
  ref: string;
  title: string;
  category: Category;
  severity: Severity;
  status: CaseStatus;
  /** Who holds the next action, and what it is. Never empty for an open case. */
  holder: Holder;
  nextAction: string;
  nextActionDueAt: string | null;
  overdue: boolean;
  emergency: boolean;
  needsReview: boolean;
  propertyName: string;
  unitLabel: string;
  residentName: string;
  /** The vendor currently offered or working the job, if any. */
  vendorName: string | null;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
};

export type EventView = {
  id: number;
  at: string;
  actorRole: Actor;
  actorName: string;
  type: string;
  message: string;
  fromStatus: CaseStatus | null;
  toStatus: CaseStatus | null;
  /** MANAGEMENT and VENDOR events are never sent to residents. */
  audience: "EVERYONE" | "MANAGEMENT" | "VENDOR";
};

export type SlotView = { id: string; startAt: string; endAt: string; status: SlotStatus; label: string };

export type ApprovalView = {
  id: string;
  status: ApprovalStatus;
  amountCents: number | null;
  thresholdCents: number;
  capCents: number | null;
  requestedAt: string;
  decidedAt: string | null;
  note: string | null;
};

export type AssignmentView = {
  id: string;
  vendorId: string;
  vendorName: string;
  vendorPhone: string | null;
  status: AssignmentStatus;
  offeredAt: string;
  respondByAt: string;
  respondedAt: string | null;
  noteToVendor: string | null;
  declineReason: string | null;
  /** Money fields are null for residents: they are not shown costs. */
  estimateType: EstimateType | null;
  estimateCents: number | null;
  estimateNotes: string | null;
  finalCostCents: number | null;
  startedAt: string | null;
  completedAt: string | null;
  completionNotes: string | null;
  approval: ApprovalView | null;
  slots: SlotView[];
};

/** What the current viewer may do right now. The server re-checks every action; this only drives which controls show. */
export type CaseAbilities = {
  reviewTriage: boolean;
  assignVendor: boolean;
  withdrawOffer: boolean;
  decideSpend: boolean;
  escalate: boolean;
  resume: boolean;
  markHandledOutside: boolean;
  closeUnverified: boolean;
  respondToOffer: boolean;
  proposeSlots: boolean;
  startWork: boolean;
  addProgressNote: boolean;
  completeWork: boolean;
  answerSlots: boolean;
  verify: boolean;
  reopen: boolean;
  cancel: boolean;
  cancelAppointment: boolean;
};

export type AiProposalView = {
  id: string;
  kind: "ASSIGN_VENDOR" | "MESSAGE_RESIDENT" | "ESCALATE";
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "EXECUTED" | "FAILED" | "SUPERSEDED";
  /** What it would do, in a sentence. */
  summary: string;
  vendorName: string | null;
  message: string | null;
  rationale: string;
  /** Why policy ran it automatically or held it for a person. */
  policyNote: string;
  outcome: string | null;
  createdAt: string;
  decidedAt: string | null;
};
export type AgentRunView = {
  id: string;
  trigger: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";
  model: string;
  createdAt: string;
  durationMs: number | null;
  error: string | null;
  finalText: string | null;
  /** Each tool call in order, as it actually happened. */
  steps: { tool: string; ok: boolean; summary: string }[];
};
/** The AI layer of a case. Managers only. */
export type CaseAi = {
  assessment: string | null;
  assessedAt: string | null;
  /** A coordinator run is queued or under way. */
  pending: boolean;
  proposals: AiProposalView[];
  runs: AgentRunView[];
};

export type CaseDetail = CaseListItem & {
  viewerRole: Role;
  channel: IntakeChannel;
  /** The resident's own words. */
  description: string;
  summary: string;
  triageSource: TriageSource;
  triageReasons: string[];
  /** The category questions and the answers given. */
  answers: { key: string; question: string; answer: string; safety: boolean }[];
  permissionToEnter: boolean;
  accessNotes: string | null;
  propertyAddress: string;
  emergencyInstructions: string;
  /** The offer or job in flight, or the most recent one. Contractors only ever see their own. */
  assignment: AssignmentView | null;
  /** Earlier offers on this case (declined, expired, withdrawn...). Managers only. */
  previousAssignments: AssignmentView[];
  /** The confirmed visit, if there is one. */
  appointment: SlotView | null;
  events: EventView[];
  resolution: Resolution | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  verification: { requestedAt: string | null; reminders: number; managerMayCloseAt: string | null };
  policy: { approvalThresholdCents: number };
  can: CaseAbilities;
  ai: CaseAi | null;
};

export type VendorOption = {
  id: string;
  name: string;
  trades: Category[];
  phone: string | null;
  /** Jobs this vendor currently has offered or accepted. */
  openJobs: number;
  /** Has at least one Relay login, so somebody will actually see the offer. */
  hasLogin: boolean;
  /** Already declined, timed out on or was withdrawn from this case. */
  previouslyOnCase: boolean;
};

export type ActivityItem = EventView & { caseId: string; caseRef: string; caseTitle: string };

export type CommandCenter = {
  counts: { open: number; emergencies: number; waitingOnManager: number; waitingOnContractors: number; waitingOnResidents: number; overdue: number; resolvedThisWeek: number; suggestions: number };
  /** Emergencies, escalations and overdue actions, most pressing first. */
  attention: CaseListItem[];
  waitingOnManager: CaseListItem[];
  waitingOnContractors: CaseListItem[];
  waitingOnResidents: CaseListItem[];
  recent: ActivityItem[];
  /** Relay AI suggestions waiting for a manager. */
  suggestions: (AiProposalView & { caseId: string; caseRef: string; caseTitle: string })[];
  generatedAt: string;
};

export type CaseFilters = {
  q?: string;
  status?: CaseStatus[];
  category?: Category[];
  severity?: Severity[];
  holder?: Holder[];
  /** true = open cases only, false = closed only, undefined = all. */
  open?: boolean;
  sort?: "updated" | "created" | "severity" | "due";
  page?: number;
  pageSize?: number;
};
export type CasePage = { items: CaseListItem[]; total: number; page: number; pageSize: number };

export type JobItem = CaseListItem & {
  assignmentId: string;
  assignmentStatus: AssignmentStatus;
  respondByAt: string;
  estimateCents: number | null;
  approvalStatus: ApprovalStatus | null;
  appointment: SlotView | null;
  propertyAddress: string;
};
export type JobBoard = { offers: JobItem[]; active: JobItem[]; done: JobItem[] };

export type NotificationView = { id: string; at: string; kind: string; title: string; body: string; caseId: string | null; read: boolean };
export type Inbox = { items: NotificationView[]; unread: number };

export type VendorSettings = { id: string; name: string; trades: Category[]; phone: string | null; email: string | null; approved: boolean; notes: string | null; logins: string[]; openJobs: number };
export type PropertySettings = {
  id: string;
  name: string;
  address: string;
  emergencyInstructions: string;
  approvalThresholdCents: number;
  vendorResponseMinutes: number;
  verificationReminderMinutes: number;
  verificationCloseAfterMinutes: number;
  units: { id: string; label: string; residents: string[] }[];
};
export type Settings = { properties: PropertySettings[]; vendors: VendorSettings[] };

export type VoiceCredential = {
  connectionType: "webrtc" | "websocket";
  conversationToken: string | null;
  signedUrl: string | null;
};
