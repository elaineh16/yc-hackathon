// The case workspace (managers): the resident's words and Relay's reading, the state and who holds it, what the AI
// proposed and what actually ran, vendors and discovery, approvals, the visit, every follow-up and its delivery, and
// the full history. Proposals, executions, acceptances, confirmations, waiting and failures are always told apart.
import { ArrowLeft, Bot, CalendarCheck, CheckCircle2, ChevronDown, CircleAlert, HandCoins, Plus, RefreshCw, Search, ShieldAlert, Sparkles, Wrench } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  askRelayToReassess,
  assignVendor,
  cancelCase,
  cancelVisit,
  closeUnverified,
  decideBudgetRequest,
  decideSpend,
  decideSuggestion,
  escalateCase,
  getAiStatus,
  getCase,
  getEligibleVendors,
  markHandledOutside,
  reopenCase,
  resumeCase,
  reviewTriage,
  saveVendor,
  useQuery,
  withdrawOffer,
} from "wasp/client/operations";
import { CATEGORIES, type Category, CATEGORY_SHORT, isTrade, SEVERITIES, type Severity, TRADE_NOUN } from "../../../shared/domain";
import type { AiProposalView, CaseDetail } from "../../../shared/views";
import { CaseMeta, CaseProgress, NextActionBar, Timeline } from "../../components/case";
import { DiscoveryPanel } from "../../components/discovery";
import { FollowUpsPanel } from "../../components/followups";
import { Provenance } from "../../components/provenance";
import { Shell } from "../../components/shell";
import { IssuePanel } from "../../components/story";
import { dayTime, money, toCents, useAction, when } from "../../lib";
import { Badge, Button, cn, Dialog, DialogContent, DialogTrigger, Hint, Input, Label, Notice, Panel, PanelHeader, Select, Spinner, Textarea } from "../../ui";

export function CaseDetailPage() {
  const { caseId = "" } = useParams();
  return (
    <Shell role="MANAGER" wide>
      {() => <Detail caseId={caseId} />}
    </Shell>
  );
}

function Detail({ caseId }: { caseId: string }) {
  const { data: c, error, isLoading } = useQuery(getCase, { caseId }, { refetchInterval: 4000 });
  if (isLoading) return <Spinner />;
  if (error || !c) return <Notice tone="danger">This case could not be loaded. It may not exist, or it belongs to a property you do not manage.</Notice>;
  return (
    <div className="space-y-5">
      <div>
        <Link to="/ops/cases" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft className="size-4" /> Cases
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{c.title}</h1>
            <div className="mt-1.5">
              <CaseMeta c={c} />
            </div>
          </div>
          <CaseMenu c={c} />
        </div>
      </div>
      <NextActionBar c={c} viewer="MANAGER" />
      <CaseProgress status={c.status} />
      {/* One action panel, placed by the grid: first on a phone (before the long story), top of the side column on a desktop. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_25rem] lg:grid-rows-[auto_1fr]">
        <div className="lg:col-start-2 lg:row-start-1">
          <ActionPanel c={c} />
        </div>
        <div className="min-w-0 space-y-5 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <IssuePanel c={c} />
          {isTrade(c.category) && <DiscoveryPanel caseId={c.id} />}
          <AiPanel c={c} />
          <Panel>
            <PanelHeader title="History">Everything that happened on this case, in order, labelled by who or what did it.</PanelHeader>
            <div className="p-4">
              <Timeline events={c.events} provenance />
            </div>
          </Panel>
        </div>
        <aside className="space-y-5 lg:col-start-2 lg:row-start-2 lg:self-start">
          <VendorPanel c={c} />
          {c.followUps && <FollowUpsPanel items={c.followUps} />}
        </aside>
      </div>
    </div>
  );
}

// ───────── what the manager can do now ─────────
function ActionPanel({ c }: { c: CaseDetail }) {
  const a = useAction();
  const err = a.error && <Notice tone="danger">{a.error}</Notice>;
  if (c.can.reviewTriage && c.status === "TRIAGED") return <ReviewTriage c={c} />;
  if (c.status === "ESCALATED") return <Escalated c={c} />;
  if (c.can.decideBudgetRequest) return <BudgetDecision c={c} />;
  if (c.category === "NOISE" && c.can.handleDirectly) return <HandleDirectly c={c} title="Handle it directly" intro="Noise and neighbour matters are handled by management, not by a vendor. Record what you did; the resident confirms whether it is sorted." />;
  if (c.can.assignVendor) return <AssignVendor c={c} />;
  if (c.can.decideSpend && c.assignment?.approval) return <DecideSpend c={c} />;
  if (c.status === "AWAITING_VENDOR" && c.assignment) {
    return (
      <Panel>
        <PanelHeader title="Offer sent">
          {c.assignment.vendorName} has until {dayTime(c.assignment.respondByAt)} to respond.
        </PanelHeader>
        <div className="space-y-3 p-4">
          {err}
          <p className="flex items-center gap-2 text-sm">
            <Provenance kind="waiting" label="Waiting on the vendor" />
          </p>
          <p className="text-sm text-muted">If they do not respond in time the offer expires automatically and the case comes back to you.</p>
          <Button variant="outline" busy={a.busy === "withdraw"} onClick={() => a.run("withdraw", () => withdrawOffer({ caseId: c.id, reason: "Withdrawn by the manager" }))}>
            Withdraw offer
          </Button>
        </div>
      </Panel>
    );
  }
  if (c.status === "AWAITING_VERIFICATION") {
    const closeAt = c.verification.managerMayCloseAt;
    return (
      <Panel>
        <PanelHeader title="Waiting for the resident">Only the resident can confirm the problem is fixed.</PanelHeader>
        <div className="space-y-3 p-4 text-sm">
          {err}
          <p className="flex flex-wrap items-center gap-2">
            <Provenance kind="waiting" label="Waiting on the resident" /> Asked {when(c.verification.requestedAt)}. Reminders sent: {c.verification.reminders}.
          </p>
          {c.can.closeUnverified ? (
            <Button variant="outline" busy={a.busy === "close"} onClick={() => a.run("close", () => closeUnverified({ caseId: c.id, note: "No response from the resident" }))}>
              Close without confirmation
            </Button>
          ) : (
            closeAt && <p className="text-muted">If they do not answer, you can close it as unverified after {dayTime(closeAt)}.</p>
          )}
        </div>
      </Panel>
    );
  }
  if (c.status === "RESOLVED" || c.status === "CANCELLED") {
    return (
      <Panel>
        <PanelHeader title={c.status === "RESOLVED" ? "Resolved" : "Cancelled"}>
          {c.status === "RESOLVED" ? (c.resolution === "VERIFIED_BY_RESIDENT" ? `Confirmed fixed by the resident ${when(c.resolvedAt)}.` : `Closed without the resident's confirmation ${when(c.resolvedAt)}.`) : c.cancelReason || "Cancelled."}
        </PanelHeader>
        {c.can.reopen && <ReopenForm caseId={c.id} />}
      </Panel>
    );
  }
  return (
    <Panel>
      <PanelHeader title="Nothing for you right now">{c.nextAction ? `Next: ${c.nextAction.toLowerCase()}.` : null}</PanelHeader>
      <div className="p-4 text-sm text-muted">This page updates by itself as the resident and contractor act.</div>
    </Panel>
  );
}

function ReviewTriage({ c }: { c: CaseDetail }) {
  const a = useAction();
  const [category, setCategory] = useState<Category>(c.category);
  const [severity, setSeverity] = useState<Severity>(c.severity);
  const [note, setNote] = useState("");
  return (
    <div className="space-y-5">
      <Panel className="border-move">
        <PanelHeader title="Review the report">Relay did not route this on its own. Set the category and severity.</PanelHeader>
        <div className="space-y-3 p-4">
          {a.error && <Notice tone="danger">{a.error}</Notice>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cat">Category</Label>
              <Select id="cat" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                {CATEGORIES.map((k) => (
                  <option key={k} value={k}>
                    {CATEGORY_SHORT[k]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="sev">Severity</Label>
              <Select id="sev" value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
                {SEVERITIES.map((k) => (
                  <option key={k} value={k}>
                    {k.charAt(0) + k.slice(1).toLowerCase()}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="note">Note (optional)</Label>
            <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this classification" />
          </div>
          <Button variant="move" className="w-full" busy={a.busy === "review"} onClick={() => a.run("review", () => reviewTriage({ caseId: c.id, category, severity, note }))}>
            {severity === "EMERGENCY" ? "Escalate as an emergency" : category === "NOISE" ? "Save: handle it directly" : "Save and route for a vendor"}
          </Button>
        </div>
      </Panel>
      {c.can.handleDirectly && (
        <HandleDirectly c={c} title="Or handle it directly" intro={c.category === "ACCESS" ? "Lockouts: check the person's identity against the lease before anyone is let in. Never share a door or lockbox code." : "If you dealt with it yourself, record what you did; the resident confirms whether it is sorted."} />
      )}
    </div>
  );
}

function HandleDirectly({ c, title, intro }: { c: CaseDetail; title: string; intro: string }) {
  const a = useAction();
  const [note, setNote] = useState("");
  return (
    <Panel className={c.category === "NOISE" ? "border-move" : undefined}>
      <PanelHeader title={title}>{intro}</PanelHeader>
      <div className="space-y-3 p-4">
        {a.error && <Notice tone="danger">{a.error}</Notice>}
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={c.category === "ACCESS" ? "For example: identity checked against the lease, let in by the superintendent at 7:40 pm." : "For example: spoke with the upstairs tenant about quiet hours."} aria-label="What was done" />
        <Button className="w-full" disabled={note.trim().length < 3} busy={a.busy === "h"} onClick={() => a.run("h", () => markHandledOutside({ caseId: c.id, note }))}>
          Record it and ask the resident to confirm
        </Button>
      </div>
    </Panel>
  );
}

function AssignVendor({ c }: { c: CaseDetail }) {
  const { data: vendors, isLoading } = useQuery(getEligibleVendors, { caseId: c.id });
  const suggestion = c.ai?.proposals.find((p) => p.kind === "ASSIGN_VENDOR" && p.status === "PENDING");
  const [vendorId, setVendorId] = useState<string>("");
  const [note, setNote] = useState("");
  const a = useAction();
  const chosen = vendorId || vendors?.find((v) => v.name === suggestion?.vendorName)?.id || "";
  const noun = isTrade(c.category) ? TRADE_NOUN[c.category] : "vendor";
  return (
    <Panel className="border-move">
      <PanelHeader title={c.status === "REOPENED" ? "Assign a vendor again" : "Assign a vendor"}>Vendors approved at this property for {CATEGORY_SHORT[c.category].toLowerCase()} work.</PanelHeader>
      <div className="space-y-3 p-4">
        {a.error && <Notice tone="danger">{a.error}</Notice>}
        {isLoading && <Spinner />}
        {vendors && vendors.length === 0 && (
          <Notice tone="warn" title={`No approved ${noun} for this property`}>
            <span className="mt-1 flex flex-wrap gap-2">
              {c.can.searchVendors && (
                <a href="#discovery" className="inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-sunk">
                  <Search className="size-3.5" /> See vendor discovery
                </a>
              )}
              <AddVendorDialog c={c} />
            </span>
          </Notice>
        )}
        <fieldset className="space-y-2">
          <legend className="sr-only">Vendor</legend>
          {vendors?.map((v) => (
            <label key={v.id} className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm", chosen === v.id ? "border-ink bg-sunk" : "border-line hover:bg-sunk")}>
              <input type="radio" name="vendor" className="mt-1 accent-ink" checked={chosen === v.id} onChange={() => setVendorId(v.id)} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {v.name}
                  {suggestion?.vendorName === v.name && <Provenance kind="ai-proposal" label="Relay suggests" />}
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  {v.openJobs} open job{v.openJobs === 1 ? "" : "s"}
                  {v.phone ? `, ${v.phone}` : ""}
                  {!v.hasLogin && ", no Relay login (contact them directly)"}
                  {v.previouslyOnCase && ", already declined or missed this case"}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {vendors && vendors.length > 0 && (
          <>
            <div>
              <Label htmlFor="vnote">Note to the vendor (optional)</Label>
              <Input id="vnote" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Access, timing, anything they should know" />
            </div>
            <Button variant="move" className="w-full" disabled={!chosen} busy={a.busy === "assign"} onClick={() => a.run("assign", () => assignVendor({ caseId: c.id, vendorId: chosen, note }))}>
              <Wrench /> Send the job offer
            </Button>
          </>
        )}
      </div>
    </Panel>
  );
}

/** Managers can always add a vendor they trust by hand: discovery is optional and never blocks a case. */
function AddVendorDialog({ c }: { c: CaseDetail }) {
  const a = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", phone: "", email: "" });
  if (!isTrade(c.category)) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-sunk">
          <Plus className="size-3.5" /> Add a vendor you trust
        </button>
      </DialogTrigger>
      <DialogContent title={`Add ${TRADE_NOUN[c.category as keyof typeof TRADE_NOUN]}`} description={`It is approved for ${CATEGORY_SHORT[c.category].toLowerCase()} work at ${c.propertyName}. You can then offer it this job.`}>
        <div className="space-y-3">
          {a.error && <Notice tone="danger">{a.error}</Notice>}
          <div>
            <Label htmlFor="avn">Name</Label>
            <Input id="avn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="avp">Phone</Label>
              <Input id="avp" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="ave">Email</Label>
              <Input id="ave" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </div>
          </div>
          <Button disabled={f.name.trim().length < 2} busy={a.busy === "add"} onClick={async () => (await a.run("add", () => saveVendor({ name: f.name, phone: f.phone, email: f.email, trades: [c.category] }))) && setOpen(false)}>
            Add and approve
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DecideSpend({ c }: { c: CaseDetail }) {
  const asg = c.assignment!;
  const ap = asg.approval!;
  const a = useAction();
  const [cap, setCap] = useState(ap.amountCents ? String(Math.ceil((ap.amountCents * 1.1) / 100)) : "");
  const [note, setNote] = useState("");
  const capCents = toCents(cap);
  return (
    <Panel className="border-move">
      <PanelHeader title="Approve the estimate">
        {asg.estimateType === "FIXED" ? (
          <>
            {asg.vendorName} quoted <strong className="text-ink">{money(asg.estimateCents)}</strong>, over this property's {money(ap.thresholdCents)} approval threshold.
          </>
        ) : (
          <>{asg.vendorName} needs to inspect before giving a price. Approve a maximum for the visit and repair.</>
        )}
      </PanelHeader>
      <div className="space-y-3 p-4">
        {a.error && <Notice tone="danger">{a.error}</Notice>}
        {asg.estimateNotes && <p className="rounded-md bg-sunk px-3 py-2 text-sm">“{asg.estimateNotes}”</p>}
        <div>
          <Label htmlFor="cap">Approve up to (CAD)</Label>
          <Input id="cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="350" />
          <Hint>The vendor is told this maximum. A final cost above it is flagged for you. Relay's AI can never approve spending.</Hint>
        </div>
        <div>
          <Label htmlFor="dnote">Note (optional)</Label>
          <Input id="dnote" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button variant="move" className="flex-1" disabled={!capCents} busy={a.busy === "approve"} onClick={() => a.run("approve", () => decideSpend({ caseId: c.id, approve: true, capCents: capCents ?? undefined, note }))}>
            <CheckCircle2 /> Approve {capCents ? money(capCents) : ""}
          </Button>
          <Button variant="danger-outline" busy={a.busy === "reject"} onClick={() => a.run("reject", () => decideSpend({ caseId: c.id, approve: false, note: note || "Estimate not approved" }))}>
            Reject
          </Button>
        </div>
        {asg.slots.some((s) => s.status === "ACCEPTED") && <Notice tone="info">The resident has already chosen a visit time. Approving confirms it.</Notice>}
      </div>
    </Panel>
  );
}

function BudgetDecision({ c }: { c: CaseDetail }) {
  const asg = c.assignment!;
  const cr = asg.changeRequest!;
  const cap = asg.approval?.capCents ?? asg.approval?.amountCents ?? 0;
  const a = useAction();
  const [note, setNote] = useState("");
  return (
    <Panel className="border-move">
      <PanelHeader title={<span className="flex items-center gap-2"><HandCoins className="size-4 text-[#b8460a]" /> More money requested</span>}>
        {asg.vendorName} asks for <strong className="text-ink">{money(cr.cents)}</strong> more than the approved {money(cap)} (new total {money(cap + cr.cents)}).
      </PanelHeader>
      <div className="space-y-3 p-4">
        {a.error && <Notice tone="danger">{a.error}</Notice>}
        <p className="rounded-md bg-sunk px-3 py-2 text-sm">“{cr.reason}”</p>
        <p className="text-xs text-muted">Only you can decide. Nothing above {money(cap)} is authorised until you do. Relay's AI can summarise this but never approve it.</p>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to the vendor (optional)" aria-label="Note to the vendor" />
        <div className="flex gap-2">
          <Button variant="move" className="flex-1" busy={a.busy === "y"} onClick={() => a.run("y", () => decideBudgetRequest({ caseId: c.id, approve: true, note }))}>
            <CheckCircle2 /> Approve {money(cr.cents)} more
          </Button>
          <Button variant="danger-outline" busy={a.busy === "n"} onClick={() => a.run("n", () => decideBudgetRequest({ caseId: c.id, approve: false, note }))}>
            Decline
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function Escalated({ c }: { c: CaseDetail }) {
  const a = useAction();
  const [note, setNote] = useState("");
  return (
    <Panel className="border-danger">
      <PanelHeader title="Escalated">
        <span className="text-danger">Routine dispatch is blocked. Decide how this is handled.</span>
      </PanelHeader>
      <div className="space-y-3 p-4">
        {a.error && <Notice tone="danger">{a.error}</Notice>}
        <div>
          <Label htmlFor="enote">What was done</Label>
          <Textarea id="enote" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: on-call staff shut off the water and confirmed the area is safe." />
        </div>
        <Button className="w-full" disabled={note.trim().length < 3} busy={a.busy === "resume"} onClick={() => a.run("resume", () => resumeCase({ caseId: c.id, note }))}>
          Safe now: continue with a vendor
        </Button>
        <Button variant="outline" className="w-full" disabled={note.trim().length < 3} busy={a.busy === "handled"} onClick={() => a.run("handled", () => markHandledOutside({ caseId: c.id, note }))}>
          Fixed outside Relay: ask the resident to confirm
        </Button>
      </div>
    </Panel>
  );
}

function ReopenForm({ caseId }: { caseId: string }) {
  const a = useAction();
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-2 p-4">
      {a.error && <Notice tone="danger">{a.error}</Notice>}
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it needs more work" aria-label="Reason to reopen" />
      <Button variant="outline" disabled={reason.trim().length < 3} busy={a.busy === "reopen"} onClick={() => a.run("reopen", () => reopenCase({ caseId, reason }))}>
        Reopen case
      </Button>
    </div>
  );
}

function CaseMenu({ c }: { c: CaseDetail }) {
  const a = useAction();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState<"escalate" | "cancel" | "visit" | null>(null);
  if (!c.can.escalate && !c.can.cancel && !c.can.cancelAppointment) return null;
  const go = async (kind: "escalate" | "cancel" | "visit") => {
    const done = await a.run(kind, () => (kind === "escalate" ? escalateCase({ caseId: c.id, reason }) : kind === "cancel" ? cancelCase({ caseId: c.id, reason }) : cancelVisit({ caseId: c.id, reason })));
    if (done) {
      setOpen(null);
      setReason("");
    }
  };
  const dialog = (kind: "escalate" | "cancel" | "visit", label: string, title: string, desc: string, variant: "danger-outline" | "outline") => (
    <Dialog open={open === kind} onOpenChange={(o) => setOpen(o ? kind : null)}>
      <DialogTrigger asChild>
        <Button variant={variant} size="sm">
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent title={title} description={desc}>
        <div className="space-y-3">
          {a.error && <Notice tone="danger">{a.error}</Notice>}
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (shared in the case history)" />
          <Button variant={kind === "escalate" ? "danger" : "primary"} disabled={reason.trim().length < 3} busy={a.busy === kind} onClick={() => go(kind)}>
            {label}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
  return (
    <div className="flex flex-wrap gap-2">
      {c.can.cancelAppointment && dialog("visit", "Cancel visit", "Cancel the confirmed visit", "The case goes back to scheduling and everyone is notified.", "outline")}
      {c.can.escalate && dialog("escalate", "Escalate", "Escalate this case", "Any open offer is withdrawn and routine dispatch stops until you resume it.", "danger-outline")}
      {c.can.cancel && dialog("cancel", "Cancel case", "Cancel this case", "Any vendor offer or visit is cancelled and the resident is told.", "outline")}
    </div>
  );
}

// ───────── vendor, estimate, budget and visit ─────────
function VendorPanel({ c }: { c: CaseDetail }) {
  const asg = c.assignment;
  if (!asg && c.previousAssignments.length === 0) return null;
  const accepted = asg && (asg.status === "ACCEPTED" || asg.status === "COMPLETED");
  return (
    <Panel>
      <PanelHeader title="Vendor and visit" />
      <div className="space-y-4 p-4 text-sm">
        {asg && (
          <div className="space-y-2">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{asg.vendorName}</span>
              {asg.status === "OFFERED" && <Provenance kind="waiting" label="Offer sent, no answer yet" />}
              {asg.status === "ACCEPTED" && <Provenance kind="vendor" label="Vendor accepted" />}
              {asg.status === "COMPLETED" && <Provenance kind="vendor" label="Vendor says the work is done" />}
              {!["OFFERED", "ACCEPTED", "COMPLETED"].includes(asg.status) && <Badge tone="outline">{asg.status.toLowerCase()}</Badge>}
            </p>
            {asg.estimateType && (
              <p>
                Estimate: <strong>{asg.estimateType === "FIXED" ? money(asg.estimateCents) : `inspection first${asg.estimateCents ? ` (${money(asg.estimateCents)})` : ""}`}</strong>
                {asg.approval && (
                  <span className="text-muted">
                    {" "}
                    {asg.approval.status === "AUTO_APPROVED" ? "approved by policy (under the threshold)" : asg.approval.status === "APPROVED" ? `approved by a manager up to ${money(asg.approval.capCents)}` : asg.approval.status.toLowerCase()}
                  </span>
                )}
              </p>
            )}
            {asg.changeRequest && (
              <p className="text-xs">
                <span className="text-muted">Budget request: </span>
                {money(asg.changeRequest.cents)} more, <Badge tone={asg.changeRequest.status === "APPROVED" ? "ok" : asg.changeRequest.status === "REJECTED" ? "outline" : "move"}>{asg.changeRequest.status.toLowerCase()}</Badge>
              </p>
            )}
            {c.appointment ? (
              <p className="flex items-center gap-2 font-medium text-ok">
                <CalendarCheck className="size-4" /> {c.appointment.label}
              </p>
            ) : (
              accepted &&
              asg.slots.length > 0 && (
                <ul className="space-y-1">
                  {asg.slots.map((s) => (
                    <li key={s.id} className="flex justify-between gap-2 text-xs">
                      <span>{s.label}</span>
                      <span className="text-muted">{s.status === "ACCEPTED" ? "chosen by resident" : s.status.toLowerCase()}</span>
                    </li>
                  ))}
                </ul>
              )
            )}
            {asg.completionNotes && (
              <p className="rounded-md bg-sunk px-3 py-2">
                Completion: {asg.completionNotes}
                {asg.finalCostCents !== null ? ` (final ${money(asg.finalCostCents)})` : ""}
              </p>
            )}
          </div>
        )}
        {c.previousAssignments.length > 0 && (
          <div>
            <p className="eyebrow">Earlier offers</p>
            <ul className="mt-1 space-y-1 text-xs">
              {c.previousAssignments.map((p) => (
                <li key={p.id}>
                  {p.vendorName}: {p.status.toLowerCase()}
                  {p.declineReason ? ` (${p.declineReason})` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ───────── Relay AI ─────────
const OUTCOME: Record<AiProposalView["status"], { kind: Parameters<typeof Provenance>[0]["kind"]; label: string }> = {
  PENDING: { kind: "ai-proposal", label: "AI proposal, waiting for you" },
  ACCEPTED: { kind: "manager", label: "Accepted" },
  EXECUTED: { kind: "system", label: "Carried out" },
  REJECTED: { kind: "skipped", label: "Rejected by a manager" },
  FAILED: { kind: "failed", label: "Could not be carried out" },
  SUPERSEDED: { kind: "skipped", label: "Replaced by a newer one" },
};

function AiPanel({ c }: { c: CaseDetail }) {
  const ai = c.ai;
  const { data: status } = useQuery(getAiStatus, undefined, { refetchInterval: 30000 });
  const a = useAction();
  const [showRuns, setShowRuns] = useState(false);
  if (!ai) return null;
  const pending = ai.proposals.filter((p) => p.status === "PENDING");
  const past = ai.proposals.filter((p) => p.status !== "PENDING");
  return (
    <Panel className="border-[#d5daf0]">
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <Bot className="size-4 text-ai" /> Relay AI coordinator
          </span>
        }
        action={
          c.status !== "RESOLVED" &&
          c.status !== "CANCELLED" && (
            <Button size="sm" variant="ghost" disabled={ai.pending} busy={a.busy === "again"} onClick={() => a.run("again", () => askRelayToReassess({ caseId: c.id }))}>
              <RefreshCw /> {ai.pending ? "Review queued" : "Review again"}
            </Button>
          )
        }
      >
        {status ? (status.available ? `Model: ${status.model}. It proposes; this property's policy decides what may run.` : `Unavailable: ${status.reason} The case continues manually.`) : null}
      </PanelHeader>
      <div className="space-y-4 p-4">
        {a.error && <Notice tone="danger">{a.error}</Notice>}
        {ai.assessment ? (
          <div>
            <p className="flex items-center gap-2 text-xs text-muted">
              <Provenance kind="ai-proposal" label="AI assessment" /> {when(ai.assessedAt)}
            </p>
            <p className="mt-1.5 text-sm">{ai.assessment}</p>
          </div>
        ) : (
          <p className="text-sm text-muted">{ai.pending ? "A review is queued or running for this case." : "No assessment yet."}</p>
        )}
        {pending.map((p) => (
          <Suggestion key={p.id} p={p} />
        ))}
        {past.length > 0 && (
          <div>
            <p className="eyebrow">Earlier proposals</p>
            <ul className="mt-1.5 space-y-1.5 text-xs">
              {past.slice(0, 6).map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2">
                  <Provenance kind={OUTCOME[p.status].kind} label={OUTCOME[p.status].label} />
                  <span className="font-medium text-ink-2">{p.summary}</span>
                  {p.outcome && <span className="text-muted">{p.outcome}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {ai.runs.length > 0 && (
          <div>
            <button className="flex items-center gap-1 text-xs font-medium text-muted hover:text-ink" onClick={() => setShowRuns(!showRuns)} aria-expanded={showRuns}>
              <ChevronDown className={cn("size-3.5 transition-transform", showRuns && "rotate-180")} /> What Relay did ({ai.runs.length} review{ai.runs.length === 1 ? "" : "s"}, every tool call as recorded)
            </button>
            {showRuns && (
              <ol className="mt-2 space-y-3">
                {ai.runs.map((r) => (
                  <li key={r.id} className="rounded-md border border-line p-3 text-xs">
                    <p className="flex flex-wrap items-center gap-2">
                      <Provenance kind={r.status === "SUCCEEDED" ? "ai-action" : r.status === "RUNNING" ? "waiting" : r.status === "SKIPPED" ? "skipped" : "failed"} label={r.status.toLowerCase()} />
                      <span className="font-medium">{r.kind === "INTAKE" ? "Intake conversation" : `After: ${r.trigger.toLowerCase().replace(/_/g, " ")}`}</span>
                      <span className="text-muted">
                        {when(r.createdAt)}
                        {r.durationMs ? `, ${Math.round(r.durationMs / 1000)} s` : ""}, <span className="font-mono">{r.model}</span>
                      </span>
                    </p>
                    {r.error && <p className="mt-1 text-warn">{r.error}</p>}
                    <ol className="mt-2 space-y-1">
                      {r.steps.map((s, i) => (
                        <li key={i} className={cn("flex gap-2", !s.ok && "text-warn")}>
                          <span className="w-40 shrink-0 truncate font-mono text-[11px] text-faint">{s.tool}</span>
                          <span>{s.summary}</span>
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Suggestion({ p }: { p: AiProposalView }) {
  const a = useAction();
  const [text, setText] = useState(p.message ?? "");
  return (
    <div className="rounded-md border border-[#d5daf0] bg-ai-soft p-3" data-testid="ai-suggestion">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ai">
        <Provenance kind="ai-proposal" label="AI proposal, not done yet" />
        <Sparkles className="size-4" /> {p.summary}
      </p>
      {p.rationale && (
        <p className="mt-1 text-sm text-ink-2">
          {/* The model's own wording: only drafts to residents and notes on businesses are checked against the facts. */}
          <span className="text-muted">Relay AI's reason, in its own words (not checked): </span>
          {p.rationale}
        </p>
      )}
      {p.kind === "MESSAGE_RESIDENT" && (
        <>
          <Textarea className="mt-2 bg-surface" value={text} onChange={(e) => setText(e.target.value)} aria-label="Message to the resident" />
          <p className="mt-1 text-[11px] text-muted">Drafted by Relay AI and checked against the case facts. It is sent only if you approve it, and recorded as approved by you.</p>
        </>
      )}
      <p className="mt-2 flex items-start gap-1.5 text-xs text-muted">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> {p.policyNote}
      </p>
      {a.error && <Notice tone="danger" className="mt-2">{a.error}</Notice>}
      <div className="mt-3 flex gap-2">
        <Button size="sm" busy={a.busy === "yes"} onClick={() => a.run("yes", () => decideSuggestion({ proposalId: p.id, accept: true, message: p.kind === "MESSAGE_RESIDENT" ? text : undefined }))}>
          {p.kind === "ASSIGN_VENDOR" ? "Send this offer" : p.kind === "ESCALATE" ? "Escalate" : "Approve and send"}
        </Button>
        <Button size="sm" variant="outline" busy={a.busy === "no"} onClick={() => a.run("no", () => decideSuggestion({ proposalId: p.id, accept: false }))}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

export const EmergencyIcon = ShieldAlert;
