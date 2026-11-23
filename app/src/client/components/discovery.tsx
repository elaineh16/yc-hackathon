// Vendor discovery on the case workspace (managers). Shows each search as it really went (status, exactly what was
// sent, what the provider charged and warned, what was filtered and why) and each business with the checks Relay ran
// on the source data. Discovery is never authorization: a business can be offered work only after a manager verifies
// it and approves it for this property.
import { AlertTriangle, Building2, Check, ChevronDown, ExternalLink, Globe, MapPin, Phone, RefreshCw, Search, ShieldCheck, Star, X } from "lucide-react";
import { useState } from "react";
import { getDiscoveryPanel, onboardCandidate, requestVendorDiscovery, reviewCandidate, useQuery } from "wasp/client/operations";
import { isTrade, TRADE_NOUN } from "../../shared/domain";
import type { CandidateView, DiscoveryView } from "../../shared/views";
import { useAction, when } from "../lib";
import { Badge, Button, cn, Dialog, DialogContent, DialogTrigger, Hint, Input, Label, Notice, Panel, PanelHeader, Spinner, Textarea } from "../ui";
import { Provenance } from "./provenance";

const ACTIVE = ["AWAITING_MANAGER", "QUEUED", "RUNNING"];
const MODE: Record<string, { label: string; tone: "ok" | "info" | "warn" | "outline" }> = {
  live: { label: "Fiber AI, live", tone: "ok" },
  sandbox: { label: "Fiber AI, sandbox", tone: "info" },
  fixture: { label: "Fixture data (fictional businesses)", tone: "warn" },
  off: { label: "Not configured", tone: "outline" },
};

export function DiscoveryPanel({ caseId }: { caseId: string }) {
  const { data: p, isLoading, error } = useQuery(getDiscoveryPanel, { caseId }, { refetchInterval: 3000 });
  const a = useAction();
  if (isLoading) return null;
  if (error || !p) return null;
  if (!p.applies) return null;
  const latest = p.discoveries[0] ?? null;
  const active = latest && ACTIVE.includes(latest.status);
  // Nothing to show while the directory still has vendors for this trade and nothing was ever searched.
  if (!latest && p.usableVendors > 0 && p.candidates.length === 0) return null;
  const noun = isTrade(p.trade) ? TRADE_NOUN[p.trade] : "vendor";
  const mode = MODE[p.provider.mode] ?? MODE.off;
  const cost = p.provider.mode === "live" ? `about ${p.provider.creditsPerSearch} credits` : p.provider.mode === "fixture" ? "no credits (fixture data)" : p.provider.mode === "sandbox" ? "no credits (sandbox)" : "";
  return (
    <Panel id="discovery" className="scroll-mt-6">
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <Building2 className="size-4 text-muted" /> Vendor discovery
          </span>
        }
        action={<Badge tone={mode.tone}>{mode.label}</Badge>}
      >
        {p.usableVendors > 0 ? `${p.usableVendors} approved ${noun}${p.usableVendors === 1 ? "" : "s"} can take this job.` : `No approved ${noun} at this property can take this job.`} Found businesses are never contacted or offered work until you verify and approve one.
      </PanelHeader>
      <div className="space-y-4 p-4">
        {a.error && <Notice tone="danger">{a.error}</Notice>}
        {!latest && p.usableVendors === 0 && (
          <Notice tone="warn" icon={<AlertTriangle />} title={`No approved ${noun} for this property`}>
            {p.provider.configured ? `Relay can search for local businesses (${cost}), or you can add a vendor you trust.` : "Vendor discovery is not configured on this server. Add a vendor you trust in Vendors."}
          </Notice>
        )}
        {latest && <SearchRow d={latest} />}
        {p.discoveries.length > 1 && <EarlierSearches list={p.discoveries.slice(1)} />}
        <div className="flex flex-wrap gap-2">
          {latest?.status === "AWAITING_MANAGER" && (
            <Button variant="move" busy={a.busy === "approve"} onClick={() => a.run("approve", () => requestVendorDiscovery({ caseId }))}>
              <Search /> Approve the search ({cost})
            </Button>
          )}
          {p.canSearch && p.provider.configured && !active && (
            <Button
              variant={latest ? "outline" : "move"}
              busy={a.busy === "search"}
              onClick={() => a.run("search", () => requestVendorDiscovery({ caseId, force: !!latest && latest.status !== "AWAITING_MANAGER" }))}
              title={latest ? "Runs a new search even if a recent one exists" : undefined}
            >
              {latest ? <RefreshCw /> : <Search />} {latest ? "Search again" : "Search local businesses"} {cost ? `(${cost})` : ""}
            </Button>
          )}
        </div>
        {p.candidates.length > 0 ? (
          <ul className="space-y-3" aria-label="Businesses found">
            {p.candidates.map((c) => (
              <li key={c.id}>
                <Candidate c={c} />
              </li>
            ))}
          </ul>
        ) : (
          latest?.status === "SUCCEEDED" && <p className="text-sm text-muted">No suitable businesses came back. Add a vendor you trust in Vendors.</p>
        )}
      </div>
    </Panel>
  );
}

function statusChip(d: DiscoveryView) {
  if (d.reused) return <Provenance kind="system" label="Reused a recent search (no new call)" />;
  switch (d.status) {
    case "AWAITING_MANAGER":
      return <Provenance kind="waiting" label="Waiting for your approval" />;
    case "QUEUED":
      return <Provenance kind="waiting" label={d.attempts ? `Retrying (attempt ${d.attempts + 1})` : "Queued"} />;
    case "RUNNING":
      return <Provenance kind="waiting" label="Searching now" />;
    case "SUCCEEDED":
      return <Provenance kind="system" label="Search finished" />;
    case "FAILED":
      return <Provenance kind="failed" label="Search failed" />;
    case "SKIPPED":
      return <Provenance kind="skipped" label="Not run" />;
    default:
      return <Provenance kind="skipped" label="Cancelled" />;
  }
}

const parse = (s: string | null) => {
  try {
    return s ? (JSON.parse(s) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

function SearchRow({ d }: { d: DiscoveryView }) {
  const [open, setOpen] = useState(false);
  const charge = parse(d.chargeInfo);
  const warnings = parse(d.warnings);
  return (
    <div className="rounded-md border border-line bg-sunk/50 p-3 text-[13px]" data-testid="discovery-search">
      <div className="flex flex-wrap items-center gap-2">
        {statusChip(d)}
        <span className="text-ink-2">
          “{d.query}” near {d.location}
        </span>
        <span className="ml-auto text-xs text-faint">
          {d.requestedBy === "SYSTEM" || d.requestedBy === "AGENT" ? "started by Relay" : `by ${d.requestedBy}`}, {when(d.createdAt)}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-faint">Places returned</dt>
          <dd className="font-mono">{d.placesReturned ?? "–"}</dd>
        </div>
        <div>
          <dt className="text-faint">Kept for review</dt>
          <dd className="font-mono">{d.candidatesKept ?? "–"}</dd>
        </div>
        <div>
          <dt className="text-faint">Credits charged</dt>
          <dd className="font-mono">{d.creditsCharged ?? "–"}</dd>
        </div>
        <div>
          <dt className="text-faint">Charge method</dt>
          <dd className="font-mono">{String(charge?.method ?? "–")}</dd>
        </div>
      </dl>
      {d.errorMessage && <p className={cn("mt-2 text-xs", d.status === "FAILED" ? "text-danger" : "text-warn")}>{d.errorMessage}</p>}
      {(d.filtered.length > 0 || charge || warnings) && (
        <button className="mt-2 flex items-center gap-1 text-xs text-muted hover:text-ink" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} /> Details: {d.filtered.length} filtered out, provider response
        </button>
      )}
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          {d.filtered.length > 0 && (
            <ul className="space-y-0.5">
              {d.filtered.map((f, i) => (
                <li key={i}>
                  <span className="font-medium">{f.name}</span>: <span className="text-muted">{f.reason}</span>
                </li>
              ))}
            </ul>
          )}
          {charge && <pre className="overflow-x-auto rounded bg-surface p-2 font-mono text-[11px] whitespace-pre-wrap text-ink-2">chargeInfo: {JSON.stringify(charge, null, 1)}</pre>}
          {warnings && <pre className="overflow-x-auto rounded bg-surface p-2 font-mono text-[11px] whitespace-pre-wrap text-warn">warnings: {JSON.stringify(warnings, null, 1)}</pre>}
        </div>
      )}
    </div>
  );
}

function EarlierSearches({ list }: { list: DiscoveryView[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="flex items-center gap-1 text-xs text-muted hover:text-ink" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} /> {list.length} earlier search{list.length === 1 ? "" : "es"}
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {list.map((d) => (
            <li key={d.id}>
              <SearchRow d={d} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const REC = { RECOMMENDED: { label: "Looks suitable", tone: "ok" as const }, POSSIBLE: { label: "Possible", tone: "info" as const }, NOT_RECOMMENDED: { label: "Not recommended", tone: "danger" as const } };
const STATUS = { NEW: "New", SHORTLISTED: "Shortlisted", VERIFIED: "Verified by you", APPROVED: "Approved for this property", REJECTED: "Rejected" };

function Candidate({ c }: { c: CandidateView }) {
  const a = useAction();
  const rec = REC[c.recommendation];
  const closed = c.status === "APPROVED" || c.status === "REJECTED";
  return (
    <div className={cn("rounded-md border p-3", c.status === "APPROVED" ? "border-[#c3e2cb] bg-ok-soft/40" : c.status === "REJECTED" ? "border-line opacity-70" : "border-line bg-surface")} data-testid="candidate">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{c.name}</span>
            <Badge tone={rec.tone}>{rec.label}</Badge>
            <Badge tone={c.status === "APPROVED" ? "ok" : c.status === "VERIFIED" ? "info" : "outline"}>{STATUS[c.status]}</Badge>
            {c.duplicateOf && <Badge tone="warn">Already in Relay as {c.duplicateOf}</Badge>}
          </p>
          <p className="mt-0.5 text-xs text-muted">{c.categories.join(" · ") || "No category listed"}</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-ink-2">
          {c.rating !== null && (
            <span className="flex items-center gap-1">
              <Star className="size-3.5 text-warn" /> <span className="font-mono">{c.rating}</span> <span className="text-faint">({c.reviewCount ?? 0})</span>
            </span>
          )}
          {c.distanceKm !== null && (
            <span className={cn("flex items-center gap-1", c.checks.inServiceArea === false && "text-danger")}>
              <MapPin className="size-3.5" /> <span className="font-mono">{c.distanceKm} km</span>
            </span>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {c.phone ? (
          <span className="flex items-center gap-1">
            <Phone className="size-3.5 text-faint" /> {c.phone}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-faint">
            <Phone className="size-3.5" /> No phone listed
          </span>
        )}
        {c.website ? (
          <a className="flex items-center gap-1 underline-offset-2 hover:underline" href={c.website} target="_blank" rel="noreferrer noopener">
            <Globe className="size-3.5 text-faint" /> {c.website.replace(/^https?:\/\//, "")}
          </a>
        ) : (
          <span className="flex items-center gap-1 text-faint">
            <Globe className="size-3.5" /> No website listed
          </span>
        )}
        {c.address && <span className="text-muted">{c.address}</span>}
        {c.sourceUrl && (
          <a className="flex items-center gap-1 text-muted underline-offset-2 hover:underline" href={c.sourceUrl} target="_blank" rel="noreferrer noopener">
            <ExternalLink className="size-3.5" /> Source ({c.source.startsWith("fixture") ? "fixture" : "Google Maps via Fiber AI"})
          </a>
        )}
      </div>
      <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
        <ul className="space-y-0.5">
          {c.reasons.map((r, i) => (
            <li key={i} className="flex gap-1.5">
              <Check className="mt-0.5 size-3.5 shrink-0 text-ok" /> {r}
            </li>
          ))}
        </ul>
        <ul className="space-y-0.5">
          {c.concerns.map((r, i) => (
            <li key={i} className="flex gap-1.5 text-warn">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {r}
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-2 text-xs text-muted">
        <span className="font-medium text-ink-2">Not confirmed by anyone yet:</span> {c.missing.join(", ")}.
      </p>
      {c.aiNote && (
        <p className="mt-2 rounded border border-[#d5daf0] bg-ai-soft px-2 py-1.5 text-xs text-ink-2">
          <Provenance kind="ai-proposal" label="AI note, checked against the listing" className="mr-1.5" />
          {c.aiNote}
        </p>
      )}
      {c.stale && <p className="mt-2 text-xs text-warn">Found {when(c.foundAt)}: details may be out of date. Search again for fresh results.</p>}
      {c.verificationNote && (
        <p className="mt-2 flex items-start gap-1.5 text-xs">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-ok" /> Verified {when(c.verifiedAt)}: {c.verificationNote}
        </p>
      )}
      {c.reviewNote && c.status === "REJECTED" && <p className="mt-1 text-xs text-muted">Rejected: {c.reviewNote}</p>}
      {a.error && <Notice tone="danger" className="mt-2">{a.error}</Notice>}
      {!closed && (
        <div className="mt-3 flex flex-wrap gap-2">
          {c.status === "NEW" && (
            <Button size="sm" variant="outline" busy={a.busy === "short"} onClick={() => a.run("short", () => reviewCandidate({ candidateId: c.id, decision: "SHORTLIST" }))}>
              Shortlist
            </Button>
          )}
          {c.status !== "VERIFIED" && <VerifyDialog c={c} />}
          {c.status === "VERIFIED" && <OnboardDialog c={c} />}
          <RejectDialog c={c} />
        </div>
      )}
      {c.status === "REJECTED" && (
        <div className="mt-2">
          <Button size="sm" variant="ghost" busy={a.busy === "reopen"} onClick={() => a.run("reopen", () => reviewCandidate({ candidateId: c.id, decision: "REOPEN" }))}>
            Reconsider
          </Button>
        </div>
      )}
    </div>
  );
}

function VerifyDialog({ c }: { c: CandidateView }) {
  const a = useAction();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <ShieldCheck /> Mark verified
        </Button>
      </DialogTrigger>
      <DialogContent title={`Verify ${c.name}`} description="Record what you checked yourself, outside Relay. Relay has not contacted this business and does not know its licence, insurance, availability or prices.">
        <div className="space-y-3">
          {a.error && <Notice tone="danger">{a.error}</Notice>}
          <div>
            <Label htmlFor={`vn-${c.id}`}>What you checked</Label>
            <Textarea id={`vn-${c.id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: called the office, licence and insurance confirmed, can come this week." />
          </div>
          <Button disabled={note.trim().length < 5} busy={a.busy === "v"} onClick={async () => (await a.run("v", () => reviewCandidate({ candidateId: c.id, decision: "VERIFY", note }))) && setOpen(false)}>
            Mark verified
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ c }: { c: CandidateView }) {
  const a = useAction();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <X /> Reject
        </Button>
      </DialogTrigger>
      <DialogContent title={`Reject ${c.name}`} description="It stays on record as rejected, with your reason, and is not suggested again unless you reconsider it.">
        <div className="space-y-3">
          {a.error && <Notice tone="danger">{a.error}</Notice>}
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason" aria-label="Reason" />
          <Button variant="danger-outline" disabled={note.trim().length < 3} busy={a.busy === "r"} onClick={async () => (await a.run("r", () => reviewCandidate({ candidateId: c.id, decision: "REJECT", note }))) && setOpen(false)}>
            Reject
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OnboardDialog({ c }: { c: CandidateView }) {
  const a = useAction();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(c.phone ?? "");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="move">
          <Check /> Approve for this property
        </Button>
      </DialogTrigger>
      <DialogContent title={`Approve ${c.name}`} description={c.duplicateOf ? `This business is already in Relay as ${c.duplicateOf}. Approving adds that vendor to this property's directory; no duplicate is created.` : "It becomes an approved vendor for this property and this trade. You can then offer it the job. Relay will not contact it on its own."}>
        <div className="space-y-3">
          {a.error && <Notice tone="danger">{a.error}</Notice>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor={`op-${c.id}`}>Phone</Label>
              <Input id={`op-${c.id}`} value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div>
              <Label htmlFor={`oe-${c.id}`}>Email (optional)</Label>
              <Input id={`oe-${c.id}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          <Hint>At least one way to reach them is required.</Hint>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note" />
          <Button variant="move" busy={a.busy === "o"} onClick={async () => (await a.run("o", () => onboardCandidate({ candidateId: c.id, phone, email, note }))) && setOpen(false)}>
            Approve and add to vendors
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function DiscoveryLoading() {
  return <Spinner />;
}
