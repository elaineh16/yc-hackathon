// The vendor directory for each property, and vendor discovery: provider status, budget, and recent searches.
import { Building2, Plus, Search } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { getFiberStatus, getSettings, saveVendor, setVendorApproved, useQuery } from "wasp/client/operations";
import { type Category, CATEGORY_SHORT, isTrade, TRADE_NOUN, VENDOR_TRADES } from "../../../shared/domain";
import type { Settings, VendorSettings } from "../../../shared/views";
import { Provenance, Ref } from "../../components/provenance";
import { PageTitle, Shell } from "../../components/shell";
import { useAction, when } from "../../lib";
import { Badge, Button, cn, Dialog, DialogContent, DialogTrigger, Empty, Input, Label, Notice, Panel, PanelHeader, Spinner, Textarea } from "../../ui";

export function VendorsPage() {
  return <Shell role="MANAGER" wide>{() => <Vendors />}</Shell>;
}

function Vendors() {
  const { data, isLoading } = useQuery(getSettings);
  if (isLoading || !data) return <Spinner />;
  return (
    <>
      <PageTitle eyebrow="Work" title="Vendors" action={<VendorDialog properties={data.properties} />}>
        Who may be offered work at each property. A vendor is approved per property and per trade; discovered businesses join only after you verify and approve them.
      </PageTitle>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Directory data={data} />
        <DiscoveryStatus />
      </div>
    </>
  );
}

function Directory({ data }: { data: Settings }) {
  const a = useAction();
  const coverage = data.properties.map((p) => ({
    p,
    missing: VENDOR_TRADES.filter((t) => !data.vendors.some((v) => v.trades.includes(t) && v.approvedAt.some((x) => x.propertyId === p.id && x.approved))),
  }));
  return (
    <div className="min-w-0 space-y-5">
      {coverage.map(({ p, missing }) => (
        <Panel key={p.id}>
          <PanelHeader title={p.name}>
            {missing.length ? (
              <>
                No approved vendor yet for: <span className="text-ink-2">{missing.map((t) => CATEGORY_SHORT[t].toLowerCase()).join(", ")}</span>. {p.autoDiscovery ? "Relay searches automatically when a case needs one." : "Relay asks you before searching."}
              </>
            ) : (
              "Every trade has at least one approved vendor."
            )}
          </PanelHeader>
          {a.error && <Notice tone="danger" className="m-4">{a.error}</Notice>}
          <ul className="divide-y divide-line">
            {data.vendors.filter((v) => v.approvedAt.some((x) => x.propertyId === p.id)).length === 0 && <Empty title="No vendors listed" />}
            {data.vendors
              .filter((v) => v.approvedAt.some((x) => x.propertyId === p.id))
              .map((v) => {
                const here = v.approvedAt.find((x) => x.propertyId === p.id)!;
                return (
                  <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {v.name}
                        {!here.approved && <Badge tone="warn">Not approved here</Badge>}
                        {v.sharedElsewhere && <Badge title="Also used by a property you do not manage. Its details can only be changed by a manager of every property that uses it.">Shared with another property</Badge>}
                        {(v.source === "DISCOVERY" || here.source === "DISCOVERY") && <Provenance kind="manager" label="Verified from discovery" />}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {v.trades.map((t) => CATEGORY_SHORT[t]).join(", ")}
                        {v.phone ? ` · ${v.phone}` : ""}
                        {v.email ? ` · ${v.email}` : ""}
                        {` · ${v.openJobs} open job${v.openJobs === 1 ? "" : "s"}`}
                        {` · Relay logins: ${v.logins.length ? v.logins.join(", ") : "none (contact them directly)"}`}
                      </p>
                    </div>
                    {!v.sharedElsewhere && <VendorDialog vendor={v} properties={data.properties} />}
                    <Button size="sm" variant={here.approved ? "outline" : "primary"} busy={a.busy === `${v.id}-${p.id}`} onClick={() => a.run(`${v.id}-${p.id}`, () => setVendorApproved({ vendorId: v.id, approved: !here.approved, propertyId: p.id }))}>
                      {here.approved ? "Remove approval" : "Approve"}
                    </Button>
                  </li>
                );
              })}
          </ul>
        </Panel>
      ))}
    </div>
  );
}

function DiscoveryStatus() {
  const { data: s, isLoading } = useQuery(getFiberStatus, undefined, { refetchInterval: 15000 });
  if (isLoading || !s) return <Spinner />;
  const mode = { live: "Fiber AI, live (spends credits)", sandbox: "Fiber AI sandbox (no credits)", fixture: "Fixture data: fictional businesses, no calls", off: "Not configured (no FIBER_API_KEY)" }[s.mode] ?? s.mode;
  return (
    <aside className="space-y-5">
      <Panel>
        <PanelHeader title={<span className="flex items-center gap-2"><Search className="size-4 text-muted" /> Vendor discovery</span>}>Local business search through Fiber AI, used only when a property has no approved vendor for a trade.</PanelHeader>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 text-sm">
          <div className="col-span-2">
            <dt className="eyebrow">Provider</dt>
            <dd className={cn("mt-0.5", s.mode === "off" && "text-warn")}>{mode}</dd>
          </div>
          <div>
            <dt className="eyebrow">Balance</dt>
            <dd className="mt-0.5 font-mono">{s.balance ? `${s.balance.available} credits` : "–"}</dd>
          </div>
          <div>
            <dt className="eyebrow">Cost per search</dt>
            <dd className="mt-0.5 font-mono">{s.mode === "live" ? `${s.creditsPerSearch} credits` : "0"}</dd>
          </div>
          <div>
            <dt className="eyebrow">Spent today</dt>
            <dd className="mt-0.5 font-mono">
              {s.spentToday} / {s.dailyCreditBudget}
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Reserve kept</dt>
            <dd className="mt-0.5 font-mono">{s.minBalance} credits</dd>
          </div>
          <div>
            <dt className="eyebrow">Kept per search</dt>
            <dd className="mt-0.5 font-mono">{s.maxCandidates} businesses</dd>
          </div>
          <div>
            <dt className="eyebrow">Results reused for</dt>
            <dd className="mt-0.5 font-mono">{s.cacheDays} days</dd>
          </div>
        </dl>
        {s.balanceError && s.mode !== "off" && <p className="border-t border-line px-4 py-2 text-xs text-danger">Balance check: {s.balanceError}</p>}
      </Panel>
      <Panel>
        <PanelHeader title={<span className="flex items-center gap-2"><Building2 className="size-4 text-muted" /> Recent searches</span>}>Exactly what was searched for, and how it went.</PanelHeader>
        {s.recent.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted">No searches yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {s.recent.map((d) => (
              <li key={d.id} className="px-4 py-2.5 text-xs">
                <p className="flex flex-wrap items-center gap-2">
                  {d.caseRef && <Ref>{d.caseRef}</Ref>}
                  <Provenance kind={d.status === "SUCCEEDED" ? "system" : d.status === "FAILED" ? "failed" : d.status === "SKIPPED" || d.status === "CANCELLED" ? "skipped" : "waiting"} label={d.reused ? "Reused" : d.status.toLowerCase().replace("_", " ")} />
                  <span className="ml-auto text-faint">{when(d.createdAt)}</span>
                </p>
                <p className="mt-1 text-[13px]">
                  {isTrade(d.trade) ? TRADE_NOUN[d.trade] : d.trade} near {d.location}
                  {d.candidatesKept !== null ? `: ${d.candidatesKept} kept of ${d.placesReturned ?? 0}` : ""}
                  {d.creditsCharged ? `, ${d.creditsCharged} credits` : ""}
                </p>
                {d.errorMessage && <p className="mt-0.5 text-danger">{d.errorMessage}</p>}
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-line px-4 py-2 text-xs text-muted">
          Review businesses on the case that needed them, from the <Link to="/ops" className="underline">command center</Link>.
        </p>
      </Panel>
    </aside>
  );
}

const TRADES: Category[] = [...VENDOR_TRADES];

function VendorDialog({ vendor, properties }: { vendor?: VendorSettings; properties: Settings["properties"] }) {
  const a = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: vendor?.name ?? "", phone: vendor?.phone ?? "", email: vendor?.email ?? "", website: vendor?.website ?? "", notes: vendor?.notes ?? "", trades: vendor?.trades ?? ([] as Category[]) });
  const [where, setWhere] = useState<string[]>(properties.map((p) => p.id));
  const toggle = (t: Category) => setF({ ...f, trades: f.trades.includes(t) ? f.trades.filter((x) => x !== t) : [...f.trades, t] });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={vendor ? "ghost" : "outline"}>
          {vendor ? (
            "Edit"
          ) : (
            <>
              <Plus /> Add vendor
            </>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent title={vendor ? `Edit ${vendor.name}` : "Add a vendor"} description={vendor ? "Contact details are shared by every property that uses this vendor." : "The vendor is approved for the trades you tick, at the properties you choose."}>
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
          {!vendor && properties.length > 1 && (
            <fieldset>
              <legend className="mb-1 text-sm font-medium">Approved at</legend>
              <div className="flex flex-wrap gap-2">
                {properties.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="accent-ink" checked={where.includes(p.id)} onChange={() => setWhere(where.includes(p.id) ? where.filter((x) => x !== p.id) : [...where, p.id])} />
                    {p.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
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
            <Label htmlFor="vw">Website</Label>
            <Input id="vw" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} placeholder="https://" />
          </div>
          <div>
            <Label htmlFor="vo">Notes</Label>
            <Textarea id="vo" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </div>
          <Button busy={a.busy === "save"} onClick={async () => (await a.run("save", () => saveVendor({ id: vendor?.id, ...f, propertyIds: vendor ? undefined : where }))) && setOpen(false)}>
            Save vendor
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
