import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { addUnit, getSettings, saveVendor, setVendorApproved, updateProperty, useQuery } from "wasp/client/operations";
import { type Category, CATEGORY_SHORT } from "../../../shared/domain";
import type { PropertySettings, VendorSettings } from "../../../shared/views";
import { PageTitle, Shell } from "../../components/shell";
import { money, toCents, useAction } from "../../lib";
import { Badge, Button, cn, Dialog, DialogContent, DialogTrigger, Hint, Input, Label, Notice, Panel, PanelHeader, Spinner, Textarea } from "../../ui";

export function SettingsPage() {
  return <Shell role="MANAGER">{() => <Settings />}</Shell>;
}

function Settings() {
  const { data, isLoading } = useQuery(getSettings);
  if (isLoading || !data) return <Spinner />;
  return (
    <>
      <PageTitle title="Settings">Property policy, building notes for Relay's assistants, and the vendors you work with.</PageTitle>
      <div className="space-y-6">
        {data.properties.map((p) => (
          <PropertyForm key={p.id} p={p} />
        ))}
        <Vendors vendors={data.vendors} />
      </div>
    </>
  );
}

const hours = (m: number) => String(Math.round((m / 60) * 10) / 10);

function PropertyForm({ p }: { p: PropertySettings }) {
  const a = useAction();
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState({
    name: p.name,
    address: p.address,
    emergencyInstructions: p.emergencyInstructions,
    knowledge: p.knowledge,
    autopilotRoutine: p.autopilotRoutine,
    threshold: String(p.approvalThresholdCents / 100),
    respond: hours(p.vendorResponseMinutes),
    remind: hours(p.verificationReminderMinutes),
    close: hours(p.verificationCloseAfterMinutes),
  });
  useEffect(() => {
    setSaved(false);
  }, [f]);
  const [unit, setUnit] = useState("");
  const minutes = (h: string) => Math.round(Number(h) * 60);
  const save = async () => {
    const r = await a.run("save", () =>
      updateProperty({
        propertyId: p.id,
        name: f.name,
        address: f.address,
        emergencyInstructions: f.emergencyInstructions,
        knowledge: f.knowledge,
        autopilotRoutine: f.autopilotRoutine,
        approvalThresholdCents: toCents(f.threshold) ?? 0,
        vendorResponseMinutes: minutes(f.respond),
        verificationReminderMinutes: minutes(f.remind),
        verificationCloseAfterMinutes: minutes(f.close),
      }),
    );
    if (r) setSaved(true);
  };
  return (
    <Panel>
      <PanelHeader title={p.name}>{p.address}</PanelHeader>
      <div className="grid gap-6 p-4 lg:grid-cols-2">
        <div className="space-y-4">
          <h3 className="text-sm font-semibold">Approval and follow-up policy</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor={`t-${p.id}`}>Approval threshold (CAD)</Label>
              <Input id={`t-${p.id}`} inputMode="decimal" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} />
              <Hint>Fixed estimates at or below this are approved by policy. Currently {money(p.approvalThresholdCents)}.</Hint>
            </div>
            <div>
              <Label htmlFor={`r-${p.id}`}>Vendor must respond within (hours)</Label>
              <Input id={`r-${p.id}`} inputMode="decimal" value={f.respond} onChange={(e) => setF({ ...f, respond: e.target.value })} />
              <Hint>After this the offer expires and the case returns to you.</Hint>
            </div>
            <div>
              <Label htmlFor={`m-${p.id}`}>Remind resident every (hours)</Label>
              <Input id={`m-${p.id}`} inputMode="decimal" value={f.remind} onChange={(e) => setF({ ...f, remind: e.target.value })} />
            </div>
            <div>
              <Label htmlFor={`c-${p.id}`}>Allow closing unverified after (hours)</Label>
              <Input id={`c-${p.id}`} inputMode="decimal" value={f.close} onChange={(e) => setF({ ...f, close: e.target.value })} />
            </div>
          </div>
          <label className="flex items-start gap-3 rounded-md border border-line p-3 text-sm">
            <input type="checkbox" className="mt-1 accent-ink" checked={f.autopilotRoutine} onChange={(e) => setF({ ...f, autopilotRoutine: e.target.checked })} />
            <span>
              <span className="font-medium">Autopilot for routine cases</span>
              <span className="block text-muted">Relay AI may send the job offer to the vendor it recommends without waiting for you, for routine cases only. Spending, scheduling, closing and cancelling always stay with people.</span>
            </span>
          </label>
          <div>
            <Label htmlFor={`e-${p.id}`}>Emergency instructions shown to residents</Label>
            <Textarea id={`e-${p.id}`} value={f.emergencyInstructions} onChange={(e) => setF({ ...f, emergencyInstructions: e.target.value })} />
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <Label htmlFor={`k-${p.id}`}>Building notes for Relay's assistants</Label>
            <Textarea id={`k-${p.id}`} className="min-h-56" value={f.knowledge} onChange={(e) => setF({ ...f, knowledge: e.target.value })} placeholder="Shut-off valves, provided appliances, heating system, access rules..." />
            <Hint>The intake assistant and the coordinator search these notes instead of guessing. One topic per paragraph works best.</Hint>
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">Units</p>
            <ul className="flex flex-wrap gap-1.5">
              {p.units.map((u) => (
                <li key={u.id}>
                  <Badge tone="outline" title={u.residents.join(", ") || "No resident"}>
                    {u.label}
                    {u.residents.length ? `: ${u.residents.join(", ")}` : ""}
                  </Badge>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <Input className="max-w-32" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="New unit" aria-label="New unit label" />
              <Button size="md" variant="outline" disabled={!unit.trim()} busy={a.busy === "unit"} onClick={async () => (await a.run("unit", () => addUnit({ propertyId: p.id, label: unit }))) && setUnit("")}>
                <Plus /> Add unit
              </Button>
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-line px-4 py-3">
        {a.error && <p className="mr-auto text-sm text-danger">{a.error}</p>}
        {saved && <span className="text-sm text-ok">Saved</span>}
        <Button busy={a.busy === "save"} onClick={save}>
          Save {p.name}
        </Button>
      </div>
    </Panel>
  );
}

const TRADES: Category[] = ["PLUMBING", "APPLIANCE", "HVAC"];

function Vendors({ vendors }: { vendors: VendorSettings[] }) {
  const a = useAction();
  return (
    <Panel>
      <PanelHeader title="Vendors" action={<VendorDialog />}>
        Only approved vendors can be offered work, and only for their trades.
      </PanelHeader>
      {a.error && <Notice tone="danger" className="m-4">{a.error}</Notice>}
      <ul className="divide-y divide-line">
        {vendors.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {v.name}
                {!v.approved && <Badge tone="warn">Not approved</Badge>}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {v.trades.map((t) => CATEGORY_SHORT[t]).join(", ")}
                {v.phone ? `. ${v.phone}` : ""}
                {`. ${v.openJobs} open job${v.openJobs === 1 ? "" : "s"}`}
                {`. Relay logins: ${v.logins.length ? v.logins.join(", ") : "none"}`}
              </p>
            </div>
            <VendorDialog vendor={v} />
            <Button size="sm" variant={v.approved ? "outline" : "primary"} busy={a.busy === v.id} onClick={() => a.run(v.id, () => setVendorApproved({ vendorId: v.id, approved: !v.approved }))}>
              {v.approved ? "Remove approval" : "Approve"}
            </Button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function VendorDialog({ vendor }: { vendor?: VendorSettings }) {
  const a = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: vendor?.name ?? "", phone: vendor?.phone ?? "", email: vendor?.email ?? "", notes: vendor?.notes ?? "", trades: vendor?.trades ?? ([] as Category[]) });
  const toggle = (t: Category) => setF({ ...f, trades: f.trades.includes(t) ? f.trades.filter((x) => x !== t) : [...f.trades, t] });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={vendor ? "ghost" : "outline"}>
          {vendor ? "Edit" : (
            <>
              <Plus /> Add vendor
            </>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent title={vendor ? `Edit ${vendor.name}` : "Add a vendor"} description="New vendors are approved for the trades you tick.">
        <div className="space-y-3">
          {a.error && <Notice tone="danger">{a.error}</Notice>}
          <div>
            <Label htmlFor="vn">Name</Label>
            <Input id="vn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Trades</legend>
            <div className="flex flex-wrap gap-2">
              {TRADES.map((t) => (
                <label key={t} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm", f.trades.includes(t) ? "border-ink bg-sunk" : "border-line")}>
                  <input type="checkbox" className="accent-ink" checked={f.trades.includes(t)} onChange={() => toggle(t)} />
                  {CATEGORY_SHORT[t]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="vp">Phone</Label>
              <Input id="vp" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="ve">Email</Label>
              <Input id="ve" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </div>
          </div>
          <div>
            <Label htmlFor="vo">Notes</Label>
            <Textarea id="vo" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </div>
          <Button busy={a.busy === "save"} onClick={async () => (await a.run("save", () => saveVendor({ id: vendor?.id, ...f, approved: vendor?.approved ?? true }))) && setOpen(false)}>
            Save vendor
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
