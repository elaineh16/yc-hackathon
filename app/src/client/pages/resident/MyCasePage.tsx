import { ArrowLeft, CalendarCheck, CheckCircle2, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { cancelCase, cancelVisit, chooseVisitTime, confirmResolution, declineVisitTimes, getCase, reopenCase, useQuery } from "wasp/client/operations";
import type { CaseDetail } from "../../../shared/views";
import { CaseProgress, NextActionBar, Timeline } from "../../components/case";
import { Shell } from "../../components/shell";
import { IssuePanel } from "../../components/story";
import { useAction, when } from "../../lib";
import { Button, cn, Dialog, DialogContent, DialogTrigger, Notice, Panel, PanelHeader, Spinner, Textarea } from "../../ui";

export function MyCasePage() {
  const { caseId = "" } = useParams();
  return <Shell role="RESIDENT">{() => <Detail caseId={caseId} />}</Shell>;
}

function Detail({ caseId }: { caseId: string }) {
  const { data: c, error, isLoading } = useQuery(getCase, { caseId }, { refetchInterval: 4000 });
  if (isLoading) return <Spinner />;
  if (error || !c) return <Notice tone="danger">This request could not be found.</Notice>;
  return (
    <div className="space-y-5">
      <div>
        <Link to="/my" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft className="size-4" /> My requests
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{c.title}</h1>
        <p className="tnum mt-1 text-sm text-muted">
          {c.ref}, reported {when(c.createdAt)}
        </p>
      </div>
      {c.emergency && c.status !== "RESOLVED" && (
        <Notice tone="danger" icon={<ShieldAlert />} title="If anyone is in danger, call 911">
          {c.emergencyInstructions}
        </Notice>
      )}
      <NextActionBar c={c} viewer="RESIDENT" />
      <CaseProgress status={c.status} />
      <YourMove c={c} />
      {c.appointment && (
        <Panel className="flex items-center gap-3 p-4">
          <CalendarCheck className="size-5 text-ok" />
          <div>
            <p className="font-medium">Visit confirmed: {c.appointment.label}</p>
            <p className="text-sm text-muted">{c.assignment?.vendorName}</p>
          </div>
          {c.can.cancelAppointment && <CancelVisit caseId={c.id} />}
        </Panel>
      )}
      <IssuePanel c={c} />
      <Panel>
        <PanelHeader title="Updates" />
        <div className="p-4">
          <Timeline events={c.events} compact />
        </div>
      </Panel>
      {c.can.cancel && <CancelRequest caseId={c.id} />}
    </div>
  );
}

function YourMove({ c }: { c: CaseDetail }) {
  const a = useAction();
  const [note, setNote] = useState("");
  const slots = c.assignment?.slots.filter((s) => s.status === "PROPOSED" || s.status === "ACCEPTED") ?? [];
  if (c.can.answerSlots) {
    const chosen = slots.find((s) => s.status === "ACCEPTED");
    return (
      <Panel className="border-move">
        <PanelHeader title="Choose a visit time">
          {c.assignment?.vendorName} can come at any of these times.
          {c.status === "AWAITING_APPROVAL" && " Your choice is confirmed as soon as the manager approves the repair."}
        </PanelHeader>
        <div className="space-y-2 p-4">
          {a.error && <Notice tone="danger">{a.error}</Notice>}
          {slots.map((s) => (
            <button
              key={s.id}
              className={cn("flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left text-sm", s.status === "ACCEPTED" ? "border-ink bg-sunk font-medium" : "border-line hover:bg-sunk")}
              disabled={!!a.busy}
              onClick={() => a.run(s.id, () => chooseVisitTime({ slotId: s.id }))}
            >
              {s.label}
              {s.status === "ACCEPTED" ? <CheckCircle2 className="size-4" /> : a.busy === s.id ? <Spinner /> : <span className="text-muted">Choose</span>}
            </button>
          ))}
          {chosen && c.status === "AWAITING_APPROVAL" && <Notice tone="info">You chose {chosen.label}. Waiting for the manager's approval.</Notice>}
          <div className="flex gap-2 pt-2">
            <Textarea className="min-h-9" value={note} onChange={(e) => setNote(e.target.value)} placeholder="None of these work? Say when you are free." aria-label="Availability note" />
            <Button variant="outline" busy={a.busy === "none"} onClick={() => a.run("none", () => declineVisitTimes({ caseId: c.id, note }))}>
              None work
            </Button>
          </div>
        </div>
      </Panel>
    );
  }
  if (c.can.verify) {
    return (
      <Panel className="border-move">
        <PanelHeader title="Is it fixed?">
          {c.assignment?.vendorName ? `${c.assignment.vendorName} says the work is done.` : "The manager says this was handled."} Only you can confirm.
        </PanelHeader>
        <div className="space-y-3 p-4">
          {a.error && <Notice tone="danger">{a.error}</Notice>}
          {c.assignment?.completionNotes && <p className="rounded-md bg-sunk px-3 py-2 text-sm">“{c.assignment.completionNotes}”</p>}
          <Button variant="move" busy={a.busy === "yes"} onClick={() => a.run("yes", () => confirmResolution({ caseId: c.id, resolved: true }))}>
            <CheckCircle2 /> Yes, it's fixed
          </Button>
          <div className="flex gap-2">
            <Textarea className="min-h-9" value={note} onChange={(e) => setNote(e.target.value)} placeholder="If not, what is still wrong?" aria-label="What is still wrong" />
            <Button variant="danger-outline" disabled={note.trim().length < 3} busy={a.busy === "no"} onClick={() => a.run("no", () => confirmResolution({ caseId: c.id, resolved: false, note }))}>
              Not fixed
            </Button>
          </div>
        </div>
      </Panel>
    );
  }
  if (c.can.reopen) {
    return (
      <Panel>
        <PanelHeader title="Problem back?">Reopen this request and the manager will pick it up again.</PanelHeader>
        <div className="flex gap-2 p-4">
          <Textarea className="min-h-9" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is wrong now?" aria-label="Reason" />
          <Button variant="outline" disabled={note.trim().length < 3} busy={a.busy === "reopen"} onClick={() => a.run("reopen", () => reopenCase({ caseId: c.id, reason: note }))}>
            Reopen
          </Button>
        </div>
        {a.error && <Notice tone="danger" className="mx-4 mb-4">{a.error}</Notice>}
      </Panel>
    );
  }
  return null;
}

function CancelVisit({ caseId }: { caseId: string }) {
  const a = useAction();
  const [reason, setReason] = useState("");
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="ml-auto">
          Can't make it
        </Button>
      </DialogTrigger>
      <DialogContent title="Cancel the visit" description="The vendor and manager are told, and new times will be proposed.">
        <div className="space-y-3">
          {a.error && <Notice tone="danger">{a.error}</Notice>}
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why, and when you would be free" />
          <Button disabled={reason.trim().length < 3} busy={!!a.busy} onClick={() => a.run("x", () => cancelVisit({ caseId, reason }))}>
            Cancel visit
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CancelRequest({ caseId }: { caseId: string }) {
  const a = useAction();
  const [reason, setReason] = useState("");
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="link" className="text-muted">
          Cancel this request
        </Button>
      </DialogTrigger>
      <DialogContent title="Cancel this request?" description="Any vendor visit is called off and the manager is told.">
        <div className="space-y-3">
          {a.error && <Notice tone="danger">{a.error}</Notice>}
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" />
          <Button variant="danger" busy={!!a.busy} onClick={() => a.run("x", () => cancelCase({ caseId, reason }))}>
            Cancel request
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
