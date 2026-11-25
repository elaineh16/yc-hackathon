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
  /** Email is optional and opt-in. */
  email: string | null;
  emailNotifications: boolean;
  /** Whether the server can send email at all (SMTP configured), and whether it is a capture server. */
  emailChannel: { configured: boolean; capture: boolean };
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
  /** The contractor asked for more money mid-job. Managers and the contractor see it; residents do not. */
  changeRequest: { cents: number; reason: string; status: "PENDING" | "APPROVED" | "REJECTED"; requestedAt: string | null; decidedAt: string | null } | null;
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
  /** Contractor: ask for more than the approved amount. */
  requestMoreBudget: boolean;
  /** Manager: decide a contractor's request for more money. */
  decideBudgetRequest: boolean;
  /** Manager: record that it was handled without a vendor (noise, a lockout let in by staff). */
  handleDirectly: boolean;
  /** Manager: look for local businesses when the directory has no vendor for the trade. */
  searchVendors: boolean;
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
  /** INTAKE: the conversation that filed the case. COORDINATOR: a review after an event. */
  kind: "INTAKE" | "COORDINATOR";
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

/** One notification to one person on one channel, with what really happened to it. Managers only. */
export type FollowUpView = {
  id: string;
  at: string;
  recipient: string;
  role: Role;
  eventType: string;
  channel: "IN_APP" | "EMAIL";
  /** DELIVERED (in the Relay inbox), ACCEPTED (by the mail server, inbox delivery not confirmed), CAPTURED (by a test
   *  mail server, not delivered), PENDING, SENDING, FAILED or SKIPPED (with the reason in statusNote). */
  status: "PENDING" | "SENDING" | "DELIVERED" | "ACCEPTED" | "CAPTURED" | "FAILED" | "SKIPPED";
  statusNote: string | null;
  title: string;
  sentAt: string | null;
  readAt: string | null;
  acknowledgedAt: string | null;
  ackDueAt: string | null;
  attempts: number;
  lastError: string | null;
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
  /** Intake's reading, kept apart: what the resident said, what Relay inferred, what is still unknown. */
  observations: string[];
  assumptions: string[];
  openQuestions: string[];
  /** Other cases filed from the same multi-issue report. */
  related: { id: string; ref: string; title: string; status: CaseStatus }[];
  /** Every notification on this case and what happened to it. Managers only. */
  followUps: FollowUpView[] | null;
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

export type QueueItem = CaseListItem & { why: string };
export type CommandCenter = {
  counts: {
    open: number;
    emergencies: number;
    waitingOnManager: number;
    waitingOnContractors: number;
    waitingOnResidents: number;
    overdue: number;
    resolvedThisWeek: number;
    suggestions: number;
    discovery: number;
    overdueAcks: number;
  };
  /** Measured from the database, not estimated. */
  metrics: {
    resolvedLast30: number;
    medianHoursToResolve: number | null;
    aiProposalsLast30: number;
    aiAcceptedLast30: number;
    aiRejectedLast30: number;
    coordinatorRunsLast24h: number;
    coordinatorFailedLast24h: number;
    emailsLast24h: { captured: number; accepted: number; skipped: number; failed: number; pending: number };
  };
  /** Cases a person has to move now, most urgent first, with the reason. */
  humanQueue: QueueItem[];
  /** Vendor discovery waiting for a manager: searches to approve, failures, businesses to review. */
  discovery: {
    searches: { id: string; status: string; caseId: string | null; caseRef: string | null; caseTitle: string | null; trade: Category; query: string; error: string | null; at: string }[];
    toReview: { trade: Category; status: string; count: number }[];
  };
  /** Notifications that needed someone to act or acknowledge by a deadline that has passed. */
  overdueAcks: { id: string; caseId: string | null; caseRef: string | null; recipient: string; role: Role; title: string; dueAt: string }[];
  /** What Relay's coordinator did recently, as recorded. */
  aiRuns: { id: string; caseId: string; caseRef: string; trigger: string; status: string; durationMs: number | null; at: string; summary: string }[];
  /** Emergencies, escalations and overdue actions, most pressing first. */
  attention: CaseListItem[];
  waitingOnManager: CaseListItem[];
  waitingOnContractors: CaseListItem[];
  waitingOnResidents: CaseListItem[];
  recent: ActivityItem[];
  /** Relay AI suggestions waiting for a manager. */
  suggestions: (AiProposalView & { caseId: string; caseRef: string; caseTitle: string })[];
  /** Chat reports the assistant did not finish, waiting for a manager to file or close (the intake safety net). */
  unfinishedChats: UnfinishedChat[];
  generatedAt: string;
};

export type UnfinishedChat = {
  id: string;
  residentName: string;
  unitLabel: string;
  propertyName: string;
  /** assistant_failed | unfinished */
  reason: string;
  reasonText: string;
  since: string;
  /** The resident's own words, verbatim (Relay's lines are not included). */
  words: string;
  /** The safety rules read the words as urgent or worse. */
  urgent: boolean;
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

export type NotificationView = {
  id: string;
  at: string;
  kind: string;
  eventType: string;
  title: string;
  body: string;
  caseId: string | null;
  read: boolean;
  /** The recipient was asked to act or acknowledge by ackDueAt. Acting on the case acknowledges it. */
  ackRequired: boolean;
  ackDueAt: string | null;
  acknowledged: boolean;
  overdue: boolean;
};
export type Inbox = { items: NotificationView[]; unread: number };

export type VendorSettings = {
  id: string;
  name: string;
  trades: Category[];
  phone: string | null;
  email: string | null;
  website: string | null;
  notes: string | null;
  /** MANUAL or DISCOVERY. */
  source: string;
  logins: string[];
  openJobs: number;
  /** Where this vendor is approved, among the properties this manager runs. */
  approvedAt: { propertyId: string; propertyName: string; approved: boolean; source: string }[];
  /** Also listed at a property this manager does not run: its details are shared, so they cannot edit them. */
  sharedElsewhere: boolean;
};
export type PropertySettings = {
  id: string;
  name: string;
  address: string;
  emergencyInstructions: string;
  /** Building notes the agents search. */
  knowledge: string;
  /** Relay AI may send routine offers without waiting for a manager. */
  autopilotRoutine: boolean;
  /** Search for local businesses automatically when no approved vendor covers a trade (false: ask a manager first). */
  autoDiscovery: boolean;
  city: string;
  region: string;
  serviceRadiusKm: number;
  residentResponseMinutes: number;
  maxReminders: number;
  appointmentReminderMinutes: number;
  approvalThresholdCents: number;
  vendorResponseMinutes: number;
  verificationReminderMinutes: number;
  verificationCloseAfterMinutes: number;
  units: { id: string; label: string; residents: string[] }[];
};
export type Settings = {
  properties: PropertySettings[];
  vendors: VendorSettings[];
  me: { email: string | null; emailNotifications: boolean };
  email: { configured: boolean; capture: boolean };
};

export type VoiceCredential = {
  connectionType: "webrtc" | "websocket";
  conversationToken: string | null;
  signedUrl: string | null;
  /** Passed to the voice agent so it can greet the resident and knows the unit. */
  dynamicVariables: { resident_name: string; property_name: string; unit_label: string };
};

// ───────────────────────── vendor discovery (managers only) ─────────────────────────

export type CandidateStatus = "NEW" | "SHORTLISTED" | "VERIFIED" | "APPROVED" | "REJECTED";
export type CandidateView = {
  id: string;
  name: string;
  trade: Category;
  status: CandidateStatus;
  /** fiber:google-maps for live results, fixture:google-maps for test fixtures. */
  source: string;
  sourceUrl: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  categories: string[];
  rating: number | null;
  reviewCount: number | null;
  distanceKm: number | null;
  /** Deterministic checks on the source data. */
  checks: { categoryMatch: "strong" | "weak" | "none"; inServiceArea: boolean | null; hasContact: boolean; duplicate: boolean };
  /** The existing vendor this business already is, if any. */
  duplicateOf: string | null;
  /** What nobody has confirmed yet (licence, insurance, availability, pricing...). */
  missing: string[];
  recommendation: "RECOMMENDED" | "POSSIBLE" | "NOT_RECOMMENDED";
  /** Built only from the source fields above. */
  reasons: string[];
  concerns: string[];
  /** RULES, or the model that wrote aiNote (kept only after a grounding check). */
  assessedBy: string;
  aiNote: string | null;
  reviewNote: string | null;
  verificationNote: string | null;
  verifiedAt: string | null;
  timesSeen: number;
  /** Older than the cache window: details may be out of date. */
  stale: boolean;
  foundAt: string;
  vendorId: string | null;
};
export type DiscoveryStatus = "AWAITING_MANAGER" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "CANCELLED";
export type DiscoveryView = {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  status: DiscoveryStatus;
  trade: Category;
  /** Exactly what was sent to the provider. */
  query: string;
  location: string;
  provider: string;
  /** live | sandbox | fixture | off */
  mode: string;
  requestedBy: string;
  attempts: number;
  placesReturned: number | null;
  candidatesKept: number | null;
  creditsCharged: number | null;
  creditsBefore: number | null;
  /** The provider's chargeInfo and warnings, verbatim (JSON text). */
  chargeInfo: string | null;
  warnings: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** A cache hit: no new call was made. */
  reused: boolean;
  filtered: { name: string; reason: string }[];
};
export type DiscoveryPanel = {
  trade: Category;
  /** Only trades a vendor can be hired for have discovery. */
  applies: boolean;
  approvedVendors: number;
  usableVendors: number;
  provider: { mode: string; configured: boolean; maxCandidates: number; creditsPerSearch: number };
  discoveries: DiscoveryView[];
  candidates: CandidateView[];
  canSearch: boolean;
};
export type FiberStatus = {
  mode: string;
  configured: boolean;
  balance: { available: number; max: number; used: number; resetsOn: string | null } | null;
  balanceError: string | null;
  creditsPerSearch: number;
  dailyCreditBudget: number;
  minBalance: number;
  maxCandidates: number;
  cacheDays: number;
  spentToday: number;
  searchesToday: number;
  recent: (DiscoveryView & { caseRef: string | null })[];
};
