// Shared contract between the Wasp server (src/server) and the pages (src/client). Change only together.
export type StaffStatus = "REQUESTED" | "ACCEPTED" | "RETRIEVED" | "UNAVAILABLE";
export type RepairStatus =
  | "OPTIONS_PENDING"
  | "RECOMMENDED"
  | "PENDING_APPROVAL"
  | "CONFIRMATION_PENDING"
  | "CONFIRMED"
  | "DENIED"
  | "ESCALATED";

export type StaffView = {
  desk: string;
  status: StaffStatus;
  priority: "NORMAL" | "SAFETY";
  assignedTo: "STAFF" | "MANAGER";
  etaMinutes: number | null;
  note: string | null;
  label: string; // what the student sees, e.g. "Staff on the way · 15 minutes"
  requestedAt: string;
  acceptedAt: string | null;
  retrievedAt: string | null;
  unavailableAt: string | null;
}

export type ContractorResultView = {
  contractorKey: string;
  name: string;
  outcome: "QUOTED" | "DIAGNOSTIC_ONLY" | "VOICEMAIL";
  scope: "REPAIR" | "DIAGNOSTIC" | "UNKNOWN";
  availability: string | null;
  priceCents: number | null; // null = unknown
  currency: "CAD";
  priceNote: string | null;
  summary: string;
  simulated: true;
  recommended: boolean;
  receivedAt: string;
}

export type DecisionView = {
  status: "PENDING" | "APPROVED" | "DENIED";
  contractorKey: string;
  contractorName: string;
  estimateCents: number; // before tax
  estimateNote: string;
  autoApproveLimitCents: number;
  approvedCapCents: number | null; // all-in, incl. taxes and fees. Shown separately from the estimate.
  capNote: string | null;
  decidedBy: string | null;
  note: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

export type AppointmentView = {
  contractorName: string;
  arrivalWindow: string;
  arrivalStart: string;
  arrivalEnd: string;
  simulated: true;
  confirmedAt: string;
}

export type TimelineEventView = {
  id: string;
  at: string;
  lane: "INTAKE" | "STAFF" | "REPAIR";
  type: string;
  actor: string;
  message: string;
  simulated: boolean;
}

export type WorkOrderView = {
  id: string;
  number: number;
  createdAt: string;
  location: string; // "MKV · Main Laundry Room · Washer 2"
  residence: string;
  room: string;
  machine: string;
  symptom: string;
  floorStatus: "DRY" | "WET" | "UNKNOWN";
  reportedErrorCode: string | null;
  safetyHazard: boolean;
  hazardDetails: string | null;
  intakeCount: number;
  repairStatus: RepairStatus;
  repairLabel: string;
  recommendation: string | null;
  staff: StaffView | null;
  contractors: ContractorResultView[];
  decision: DecisionView | null;
  appointment: AppointmentView | null;
}

export type OperatorDashboard = {
  workOrder: (WorkOrderView & { timeline: TimelineEventView[] }) | null;
  openWorkOrders: number;
  policy: { autoApproveLimitCents: number; hardCapCents: number; defaultCapCents: number };
  serverTime: string;
}

export type StudentUpdate = {
  at: string;
  message: string;
}
export type StudentStatus = {
  sessionValid: boolean; // false after a demo reset: create a new session
  workOrder:
    | (Pick<
        WorkOrderView,
        "id" | "number" | "location" | "symptom" | "floorStatus" | "reportedErrorCode" | "safetyHazard" | "repairStatus" | "repairLabel" | "recommendation" | "appointment"
      > & {
        staffLabel: string;
        staffStatus: StaffStatus | null;
        etaMinutes: number | null;
        latest: StudentUpdate | null;
        updates: StudentUpdate[]; // newest first
      })
    | null;
}

export type VoiceSessionCredential = {
  connectionType: "webrtc" | "websocket";
  conversationToken: string | null; // webrtc
  signedUrl: string | null; // websocket
  agentId: string;
  dynamicVariables: { demo_session_id: string };
}
