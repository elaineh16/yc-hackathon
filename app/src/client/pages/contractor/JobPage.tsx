import { ArrowLeft, CalendarCheck, MapPin, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { addProgressNote, cancelVisit, completeWork, getCase, proposeVisitTimes, respondToOffer, startWork, useQuery } from "wasp/client/operations";
import type { CaseDetail } from "../../../shared/views";
import { NextActionBar, SeverityBadge, Timeline } from "../../components/case";
import { Shell } from "../../components/shell";
import { IssuePanel } from "../../components/story";
import { dayTime, money, toCents, useAction } from "../../lib";
import { Badge, Button, Dialog, DialogContent, DialogTrigger, Hint, Input, Label, Notice, Panel, PanelHeader, Spinner, Textarea } from "../../ui";

export function JobPage() {
  const { caseId = "" } = useParams();
  return <Shell role="CONTRACTOR">{() => <Detail caseId={caseId} />}</Shell>;
}

function Detail({ caseId }: { caseId: string }) {
  const { data: c, error, isLoading } = useQuery(getCase, { caseId }, { refetchInterval: 4000 });
  if (isLoading) return <Spinner />;
  if (error || !c) return <Notice tone="danger">This job is not available. It may have been withdrawn or given to another vendor.</Notice>;
  return (
    <div className="space-y-5">
      <div>
        <Link to="/jobs" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft className="size-4" /> My jobs
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{c.title}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span className="tnum">{c.ref}</span>
          <SeverityBadge severity={c.severity} />
          <span className="flex items-center gap-1">
            <MapPin className="size-3.5" /> {c.propertyAddress}, unit {c.unitLabel}
          </span>
        </p>
      </div>
      <NextActionBar c={c} viewer="CONTRACTOR" />
      <Work c={c} />
      {c.appointment && (
        <Panel className="flex items-center gap-3 p-4">
          <CalendarCheck className="size-5 text-ok" />
          <p className="font-medium">Visit: {c.appointment.label}</p>
          {c.can.cancelAppointment && <CancelVisit caseId={c.id} />}
        </Panel>
      )}
      <IssuePanel c={c} />
      <Panel>
        <PanelHeader title="Job history" />
        <div className="p-4">
          <Timeline events={c.events} compact />
        </div>
      </Panel>
    </div>
  );
}

type SlotDraft = { date: string; from: string; to: string };
const tomorrow = () => {
  const d = new Date(Date.now() + 24 * 3600_000);
  return d.toISOString().slice(0, 10);
};
const toSlot = (s: SlotDraft) => ({ startAt: new Date(`${s.date}T${s.from}`).toISOString(), endAt: new Date(`${s.date}T${s.to}`).toISOString() });

function SlotEditor({ slots, setSlots }: { slots: SlotDraft[]; setSlots: (s: SlotDraft[]) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">When can you come?</legend>
      {slots.map((s, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_6rem_auto]">
          <Input type="date" className="col-span-3 sm:col-span-1" aria-label={`Visit ${i + 1} date`} value={s.date} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
          <Input type="time" aria-label={`Visit ${i + 1} from`} value={s.from} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
          <Input type="time" aria-label={`Visit ${i + 1} to`} value={s.to} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
          <Button type="button" size="icon" variant="ghost" aria-label="Remove this time" disabled={slots.length === 1} onClick={() => setSlots(slots.filter((_, j) => j !== i))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      {slots.length < 5 && (
        <Button type="button" size="sm" variant="outline" onClick={() => setSlots([...slots, { date: tomorrow(), from: "13:00", to: "15:00" }])}>
          <Plus /> Add another time
        </Button>
      )}
    </fieldset>
  );
}

function Work({ c }: { c: CaseDetail }) {
  const a = useAction();
  const asg = c.assignment;
  const [estimateType, setEstimateType] = useState<"FIXED" | "INSPECTION_REQUIRED">("FIXED");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [slots, setSlots] = useState<SlotDraft[]>([{ date: tomorrow(), from: "09:00", to: "11:00" }]);
  const [declineReason, setDeclineReason] = useState("");
  const [update, setUpdate] = useState("");
  const [finalCost, setFinalCost] = useState("");
  const [completion, setCompletion] = useState("");
  const err = a.error && <Notice tone="danger">{a.error}</Notice>;

  if (c.can.respondToOffer && asg) {
    const cents = toCents(amount);
    return (
      <Panel className="border-move">
        <PanelHeader title="New job offer">
          Respond by {dayTime(asg.respondByAt).replace(/.$/, "")}.{asg.noteToVendor ? ` Note from the manager: ${asg.noteToVendor}` : ""}
        </PanelHeader>
        <div className="space-y-4 p-4">
          {err}
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Your price</legend>
            <div className="flex flex-wrap gap-2 text-sm">
              {(
                [
                  ["FIXED", "I can quote now"],
                  ["INSPECTION_REQUIRED", "I need to inspect first"],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 ${estimateType === k ? "border-ink bg-sunk" : "border-line"}`}>
                  <input type="radio" name="etype" className="accent-ink" checked={estimateType === k} onChange={() => setEstimateType(k)} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="amt">{estimateType === "FIXED" ? "Estimate (CAD, all in)" : "Inspection fee (CAD, optional)"}</Label>
              <Input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={estimateType === "FIXED" ? "320" : "0"} />
              {estimateType === "FIXED" && <Hint>Over the property's approval threshold, the manager must approve before the visit is confirmed.</Hint>}
            </div>
            <div>
              <Label htmlFor="enotes">What it covers</Label>
              <Input id="enotes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Parts and labour, what you expect to do" />
            </div>
          </div>
          <SlotEditor slots={slots} setSlots={setSlots} />
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            <Button
              variant="move"
              busy={a.busy === "accept"}
              disabled={estimateType === "FIXED" && !cents}
              onClick={() => a.run("accept", () => respondToOffer({ assignmentId: asg.id, accept: true, estimateType, estimateCents: estimateType === "FIXED" ? cents : toCents(amount), estimateNotes: notes, slots: slots.map(toSlot) }))}
            >
              Accept the job
            </Button>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Decline</Button>
              </DialogTrigger>
              <DialogContent title="Decline this job" description="The manager is told and will offer it to someone else.">
                <div className="space-y-3">
                  {err}
                  <Textarea value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder="For example: fully booked this week" />
                  <Button variant="danger" disabled={declineReason.trim().length < 3} busy={a.busy === "decline"} onClick={() => a.run("decline", () => respondToOffer({ assignmentId: asg.id, accept: false, declineReason }))}>
                    Decline job
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </Panel>
    );
  }
  if (c.can.proposeSlots && asg) {
    const open = asg.slots.filter((s) => s.status === "PROPOSED" || s.status === "ACCEPTED");
    return (
      <Panel className={open.length ? undefined : "border-move"}>
        <PanelHeader title={open.length ? "Waiting for the resident" : "Propose new times"}>
          {c.status === "AWAITING_APPROVAL" ? `Your estimate of ${money(asg.estimateCents)} is waiting for the manager's approval.` : open.length ? "The resident is choosing from your times." : "The resident could not make your times."}
        </PanelHeader>
        <div className="space-y-3 p-4">
          {err}
          <ul className="space-y-1 text-sm">
            {asg.slots.map((s) => (
              <li key={s.id} className="flex justify-between gap-3">
                <span>{s.label}</span>
                <Badge tone={s.status === "ACCEPTED" ? "ok" : s.status === "PROPOSED" ? "info" : "outline"}>{s.status === "ACCEPTED" ? "chosen" : s.status.toLowerCase()}</Badge>
              </li>
            ))}
          </ul>
          <SlotEditor slots={slots} setSlots={setSlots} />
          <Button variant="outline" busy={a.busy === "slots"} onClick={() => a.run("slots", () => proposeVisitTimes({ caseId: c.id, slots: slots.map(toSlot) }))}>
            Propose these times
          </Button>
        </div>
      </Panel>
    );
  }
  if (c.can.startWork) {
    return (
      <Panel className="border-move">
        <PanelHeader title="Ready for the visit">When you arrive, start the job so the resident and manager can see it.</PanelHeader>
        <div className="p-4">
          {err}
          <Button variant="move" busy={a.busy === "start"} onClick={() => a.run("start", () => startWork({ caseId: c.id }))}>
            Start work
          </Button>
        </div>
      </Panel>
    );
  }
  if (c.can.completeWork) {
    const cost = finalCost.trim() ? toCents(finalCost) : null;
    return (
      <Panel className="border-move">
        <PanelHeader title="Work in progress">
          Approved up to {money(asg?.approval?.capCents ?? asg?.estimateCents ?? null) || "the agreed amount"}.
        </PanelHeader>
        <div className="space-y-4 p-4">
          {err}
          <div className="flex gap-2">
            <Input value={update} onChange={(e) => setUpdate(e.target.value)} placeholder="Post an update (for example: waiting on a part)" aria-label="Progress update" />
            <Button variant="outline" disabled={update.trim().length < 3} busy={a.busy === "note"} onClick={async () => (await a.run("note", () => addProgressNote({ caseId: c.id, note: update }))) && setUpdate("")}>
              Post
            </Button>
          </div>
          <div className="space-y-3 border-t border-line pt-4">
            <div>
              <Label htmlFor="done">What did you do?</Label>
              <Textarea id="done" value={completion} onChange={(e) => setCompletion(e.target.value)} placeholder="The repair, parts used, anything the resident should know" />
            </div>
            <div className="max-w-48">
              <Label htmlFor="cost">Final cost (CAD, optional)</Label>
              <Input id="cost" inputMode="decimal" value={finalCost} onChange={(e) => setFinalCost(e.target.value)} />
            </div>
            <Button variant="move" disabled={completion.trim().length < 5} busy={a.busy === "complete"} onClick={() => a.run("complete", () => completeWork({ caseId: c.id, notes: completion, finalCostCents: cost }))}>
              Mark work complete
            </Button>
            <Hint>The resident confirms whether it is fixed. The case is not resolved until they do.</Hint>
          </div>
        </div>
      </Panel>
    );
  }
  if (c.status === "AWAITING_VERIFICATION" || c.status === "RESOLVED") {
    return <Notice tone={c.status === "RESOLVED" ? "ok" : "info"}>{c.status === "RESOLVED" ? "The resident confirmed the fix. Job closed." : "Waiting for the resident to confirm the fix."}</Notice>;
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
      <DialogContent title="Cancel the visit" description="The resident and manager are told. Propose new times afterwards.">
        <div className="space-y-3">
          {a.error && <Notice tone="danger">{a.error}</Notice>}
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why" />
          <Button disabled={reason.trim().length < 3} busy={!!a.busy} onClick={() => a.run("x", () => cancelVisit({ caseId, reason }))}>
            Cancel visit
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
