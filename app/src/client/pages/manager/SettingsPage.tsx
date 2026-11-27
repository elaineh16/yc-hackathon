// Property policy (approvals, follow-ups, vendor discovery, autopilot), emergency instructions and building notes.
// Vendors live on their own page (VendorsPage).
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { addUnit, getSettings, updateProperty, useQuery } from "wasp/client/operations";
import type { PropertySettings } from "../../../shared/views";
import { PageTitle, Shell } from "../../components/shell";
import { money, toCents, useAction } from "../../lib";
import { Badge, Button, Hint, Input, Label, Notice, Panel, PanelHeader, Spinner, Textarea } from "../../ui";

export function SettingsPage() {
  return <Shell role="MANAGER">{() => <Settings />}</Shell>;
}

function Settings() {
  const { data, isLoading } = useQuery(getSettings);
  if (isLoading || !data) return <Spinner />;
  return (
    <>
      <PageTitle eyebrow="Admin" title="Settings">
        Each property's policy: approvals, follow-ups, vendor discovery, and what Relay's assistants may look up.
      </PageTitle>
      {!data.email.configured && <Notice tone="warn" className="mb-5">Email is not configured on this server: notifications are in-app only.</Notice>}
      {data.email.configured && data.email.capture && <Notice tone="info" className="mb-5">Email goes to a local capture server (Mailpit). Nothing is delivered to anyone, and Relay records it as captured, not delivered.</Notice>}
      <div className="space-y-6">
        {data.properties.map((p) => (
          <PropertyForm key={p.id} p={p} />
        ))}
      </div>
    </>
  );
}

const hours = (m: number) => String(Math.round((m / 60) * 10) / 10);

function Field({ id, label, value, onChange, hint, inputMode = "decimal" }: { id: string; label: string; value: string; onChange: (v: string) => void; hint?: string; inputMode?: "decimal" | "text" }) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode={inputMode} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

function PropertyForm({ p }: { p: PropertySettings }) {
  const a = useAction();
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState({
    name: p.name,
    address: p.address,
    city: p.city,
    region: p.region,
    emergencyInstructions: p.emergencyInstructions,
    knowledge: p.knowledge,
    autopilotRoutine: p.autopilotRoutine,
    autoDiscovery: p.autoDiscovery,
    radius: String(p.serviceRadiusKm),
    threshold: String(p.approvalThresholdCents / 100),
    respond: hours(p.vendorResponseMinutes),
    residentRespond: hours(p.residentResponseMinutes),
    remind: hours(p.verificationReminderMinutes),
    close: hours(p.verificationCloseAfterMinutes),
    reminders: String(p.maxReminders),
    visitLead: hours(p.appointmentReminderMinutes),
  });
  useEffect(() => {
    setSaved(false);
  }, [f]);
  const [unit, setUnit] = useState("");
  const minutes = (h: string) => Math.round(Number(h) * 60);
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const save = async () => {
    const r = await a.run("save", () =>
      updateProperty({
        propertyId: p.id,
        name: f.name,
        address: f.address,
        city: f.city,
        region: f.region,
        emergencyInstructions: f.emergencyInstructions,
        knowledge: f.knowledge,
        autopilotRoutine: f.autopilotRoutine,
        autoDiscovery: f.autoDiscovery,
        serviceRadiusKm: Math.round(Number(f.radius)),
        approvalThresholdCents: toCents(f.threshold) ?? 0,
        vendorResponseMinutes: minutes(f.respond),
        residentResponseMinutes: minutes(f.residentRespond),
        verificationReminderMinutes: minutes(f.remind),
        verificationCloseAfterMinutes: minutes(f.close),
        maxReminders: Math.round(Number(f.reminders)),
        appointmentReminderMinutes: minutes(f.visitLead),
      }),
    );
    if (r) setSaved(true);
  };
  return (
    <Panel>
      <PanelHeader title={p.name}>{p.address}</PanelHeader>
      <div className="grid gap-8 p-4 lg:grid-cols-2">
        <div className="space-y-6">
          <section className="space-y-3">
            <p className="eyebrow">Approvals</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={`t-${p.id}`} label="Approval threshold (CAD)" value={f.threshold} onChange={set("threshold")} hint={`Fixed estimates at or below this are approved by policy. Currently ${money(p.approvalThresholdCents)}.`} />
              <Field id={`r-${p.id}`} label="Vendor must respond within (hours)" value={f.respond} onChange={set("respond")} hint="After this the offer expires and the case returns to you." />
            </div>
            <label className="flex items-start gap-3 rounded-md border border-line p-3 text-sm">
              <input type="checkbox" className="mt-1 accent-ink" checked={f.autopilotRoutine} onChange={(e) => setF({ ...f, autopilotRoutine: e.target.checked })} />
              <span>
                <span className="font-medium">Autopilot for routine cases</span>
                <span className="block text-muted">Relay AI may send the job offer to the approved vendor it recommends without waiting for you, for routine cases only. Spending, scheduling, closing and cancelling always stay with people.</span>
              </span>
            </label>
          </section>
          <section className="space-y-3">
            <p className="eyebrow">Follow-ups</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={`rr-${p.id}`} label="Resident has to choose a visit time within (hours)" value={f.residentRespond} onChange={set("residentRespond")} />
              <Field id={`mr-${p.id}`} label="Reminders before you are told instead" value={f.reminders} onChange={set("reminders")} hint="Nobody is reminded forever: after this many, a manager is told once." />
              <Field id={`m-${p.id}`} label="Ask the resident to confirm every (hours)" value={f.remind} onChange={set("remind")} />
              <Field id={`c-${p.id}`} label="Allow closing unverified after (hours)" value={f.close} onChange={set("close")} />
              <Field id={`vl-${p.id}`} label="Visit reminder this far ahead (hours)" value={f.visitLead} onChange={set("visitLead")} />
            </div>
          </section>
          <section className="space-y-3">
            <p className="eyebrow">Vendor discovery</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field id={`ci-${p.id}`} label="City" value={f.city} onChange={set("city")} inputMode="text" />
              <Field id={`rg-${p.id}`} label="Province or state" value={f.region} onChange={set("region")} inputMode="text" />
              <Field id={`sr-${p.id}`} label="Service radius (km)" value={f.radius} onChange={set("radius")} />
            </div>
            <Hint>Only the trade and the city are sent to the search provider, never a resident's name, unit or words.</Hint>
            <label className="flex items-start gap-3 rounded-md border border-line p-3 text-sm">
              <input type="checkbox" className="mt-1 accent-ink" checked={f.autoDiscovery} onChange={(e) => setF({ ...f, autoDiscovery: e.target.checked })} />
              <span>
                <span className="font-medium">Search automatically when no approved vendor covers a trade</span>
                <span className="block text-muted">Off: Relay asks you before each search. Either way, results are cached, a daily credit budget applies, and nothing found is contacted or offered work until you verify and approve it.</span>
              </span>
            </label>
          </section>
          <div>
            <Label htmlFor={`e-${p.id}`}>Emergency instructions shown to residents</Label>
            <Textarea id={`e-${p.id}`} value={f.emergencyInstructions} onChange={(e) => setF({ ...f, emergencyInstructions: e.target.value })} />
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <Label htmlFor={`k-${p.id}`}>Building notes for Relay's assistants</Label>
            <Textarea id={`k-${p.id}`} className="min-h-64" value={f.knowledge} onChange={(e) => setF({ ...f, knowledge: e.target.value })} placeholder="Shut-off valves, provided appliances, heating system, access rules..." />
            <Hint>The assistants search these notes instead of guessing. One topic per paragraph works best. Lines starting with "STAFF ONLY:" are never shown to a resident-facing assistant, and codes from them are removed from any reply.</Hint>
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
