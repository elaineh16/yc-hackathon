// The manager's command center. Every number is counted from the database on each refresh; nothing is estimated.
import { AlarmClock, ArrowUpRight, Bot, Building2, CircleAlert, MessageSquareWarning, Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useNavigate } from "react-router";
import { closeUnfinishedChat, fileUnfinishedChat, getCommandCenter, useQuery } from "wasp/client/operations";
import { CATEGORY_SHORT, isTrade, TRADE_NOUN } from "../../../shared/domain";
import type { CaseListItem, CommandCenter, UnfinishedChat } from "../../../shared/views";
import { SeverityBadge, StatusBadge } from "../../components/case";
import { eventKind, eventLabel, Provenance, Ref } from "../../components/provenance";
import { PageTitle, Shell } from "../../components/shell";
import { clock, dueIn, useAction, when } from "../../lib";
import { Badge, Button, cn, Empty, Input, Notice, Panel, PanelHeader, Spinner } from "../../ui";

export function CommandCenterPage() {
  return <Shell role="MANAGER" wide>{(me) => <Command name={me.name.split(" ")[0]} />}</Shell>;
}

function Kpi({ label, value, to, tone, hint }: { label: string; value: ReactNode; to?: string; tone?: "move" | "danger"; hint?: ReactNode }) {
  const body = (
    <>
      <p className={cn("font-mono text-[26px] leading-none font-medium tracking-tight tnum", tone === "danger" && "text-danger", tone === "move" && "text-[#b8460a]")}>{value}</p>
      <p className="mt-2 text-[12px] text-muted group-hover:text-ink">{label}</p>
      {hint && <p className="mt-0.5 text-[11px] text-faint">{hint}</p>}
    </>
  );
  const cls = "group block rounded-lg border border-line bg-surface px-4 py-3.5 transition-colors hover:border-line-strong";
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Command({ name }: { name: string }) {
  const { data: d, isLoading } = useQuery(getCommandCenter, undefined, { refetchInterval: 5000 });
  if (isLoading || !d) return <Spinner />;
  const c = d.counts;
  const m = d.metrics;
  const hours = (h: number | null) => (h === null ? "–" : h < 48 ? `${h}h` : `${Math.round(h / 24)}d`);
  const emails = m.emailsLast24h;
  return (
    <>
      <PageTitle eyebrow="Command center" title={`Good to see you, ${name}`} action={<p className="text-xs text-faint">Counted from the database at {clock(d.generatedAt)}; refreshes every 5 s</p>}>
        What is waiting on whom across your properties, and what Relay's AI did about it.
      </PageTitle>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Open cases" value={c.open} to="/ops/cases" />
        <Kpi label="Waiting on you" value={c.waitingOnManager} to="/ops/cases?holder=MANAGER" tone={c.waitingOnManager ? "move" : undefined} />
        <Kpi label="Emergencies" value={c.emergencies} to="/ops/cases?severity=EMERGENCY" tone={c.emergencies ? "danger" : undefined} />
        <Kpi label="Overdue" value={c.overdue} to="/ops/cases?sort=due" tone={c.overdue ? "danger" : undefined} />
        <Kpi label="With contractors" value={c.waitingOnContractors} to="/ops/cases?holder=CONTRACTOR" />
        <Kpi label="With residents" value={c.waitingOnResidents} to="/ops/cases?holder=RESIDENT" />
        <Kpi label="Resolved, 7 days" value={c.resolvedThisWeek} to="/ops/cases?status=RESOLVED" />
        <Kpi label="Median time to resolve" value={hours(m.medianHoursToResolve)} hint={`${m.resolvedLast30} resolved in 30 days`} />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-line bg-surface px-4 py-2.5 text-[12px] text-muted">
        <span>
          <span className="eyebrow mr-1.5">AI proposals, 30 d</span>
          <span className="font-mono text-ink">{m.aiProposalsLast30}</span> made, <span className="font-mono text-ink">{m.aiAcceptedLast30}</span> carried out, <span className="font-mono text-ink">{m.aiRejectedLast30}</span> rejected
        </span>
        <span>
          <span className="eyebrow mr-1.5">Coordinator, 24 h</span>
          <span className="font-mono text-ink">{m.coordinatorRunsLast24h}</span> reviews{m.coordinatorFailedLast24h ? <span className="text-danger">, {m.coordinatorFailedLast24h} failed</span> : null}
        </span>
        <span>
          <span className="eyebrow mr-1.5">Email, 24 h</span>
          <span className="font-mono text-ink">{emails.accepted}</span> accepted by a mail server, <span className="font-mono text-ink">{emails.captured}</span> captured (test), <span className="font-mono text-ink">{emails.skipped}</span> not sent
          {emails.failed ? <span className="text-danger">, {emails.failed} failed</span> : null}
          {emails.pending ? `, ${emails.pending} queued` : ""}
        </span>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="min-w-0 space-y-5">
          {d.attention.length > 0 && (
            <Panel className="border-[#f0c4be]">
              <PanelHeader title={<span className="flex items-center gap-2"><CircleAlert className="size-4 text-danger" /> Needs attention</span>}>Emergencies, escalations and anything past its deadline, whoever holds it.</PanelHeader>
              <CaseRows items={d.attention} />
            </Panel>
          )}
          {d.unfinishedChats.length > 0 && <UnfinishedChats items={d.unfinishedChats} />}
          <Panel>
            <PanelHeader title="Your move" action={<Link to="/ops/cases?holder=MANAGER" className="flex items-center gap-1 text-xs text-muted hover:text-ink">All <ArrowUpRight className="size-3.5" /></Link>}>
              Human intervention queue: what needs a person now, most urgent first, and why.
            </PanelHeader>
            {d.humanQueue.length ? (
              <ul className="divide-y divide-line">
                {d.humanQueue.map((q) => (
                  <li key={q.id}>
                    <Row c={q} reason={q.why} />
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="Nothing waiting on you">New reports and decisions will appear here.</Empty>
            )}
          </Panel>
          <div className="grid gap-5 xl:grid-cols-2">
            <DiscoveryQueue d={d} />
            <AiWorkflows d={d} />
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            <Panel>
              <PanelHeader title="With contractors">Offers, visits and work in progress.</PanelHeader>
              {d.waitingOnContractors.length ? <CaseRows items={d.waitingOnContractors} compact /> : <Empty title="None" />}
            </Panel>
            <Panel>
              <PanelHeader title="With residents">Visit times and confirmations they owe.</PanelHeader>
              {d.waitingOnResidents.length ? <CaseRows items={d.waitingOnResidents} compact /> : <Empty title="None" />}
            </Panel>
          </div>
        </div>
        <aside className="space-y-5">
          <Panel className="border-[#d5daf0]">
            <PanelHeader title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-ai" /> Relay suggestions</span>}>Proposals from the AI coordinator. Nothing here has happened yet.</PanelHeader>
            {d.suggestions.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted">No suggestions waiting.</p>
            ) : (
              <ul className="divide-y divide-line">
                {d.suggestions.map((s) => (
                  <li key={s.id}>
                    <Link to={`/ops/cases/${s.caseId}`} className="block px-4 py-3 hover:bg-sunk">
                      <p className="flex items-center gap-2">
                        <Provenance kind="ai-proposal" />
                        <Ref>{s.caseRef}</Ref>
                      </p>
                      <p className="mt-1.5 text-sm font-medium">{s.summary}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted">{s.rationale ? `AI's reason (not checked): ${s.rationale}` : null}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel>
            <PanelHeader title={<span className="flex items-center gap-2"><AlarmClock className="size-4 text-muted" /> Overdue acknowledgements</span>}>People asked to act by a deadline that has passed.</PanelHeader>
            {d.overdueAcks.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted">Nobody is overdue.</p>
            ) : (
              <ul className="divide-y divide-line">
                {d.overdueAcks.map((n) => (
                  <li key={n.id}>
                    <Link to={n.caseId ? `/ops/cases/${n.caseId}` : "/ops"} className="block px-4 py-2.5 hover:bg-sunk">
                      <p className="flex flex-wrap items-center gap-2 text-xs">
                        {n.caseRef && <Ref>{n.caseRef}</Ref>}
                        <span className="font-medium text-ink-2">{n.recipient}</span>
                        <Badge tone="outline">{n.role.toLowerCase()}</Badge>
                        <span className="ml-auto text-danger">{dueIn(n.dueAt)?.text}</span>
                      </p>
                      <p className="mt-0.5 line-clamp-1 text-sm">{n.title}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel>
            <PanelHeader title="Recent activity">Everything that happened, labelled by who did it.</PanelHeader>
            <ul className="divide-y divide-line">
              {d.recent.length === 0 && <li className="px-4 py-5 text-sm text-muted">No activity yet.</li>}
              {d.recent.map((e) => (
                <li key={e.id}>
                  <Link to={`/ops/cases/${e.caseId}`} className="block px-4 py-2.5 hover:bg-sunk">
                    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      <Ref className="text-ink-2">{e.caseRef}</Ref>
                      <Provenance kind={eventKind(e)} label={eventLabel(e)} />
                      <span className="ml-auto text-faint">{when(e.at)}</span>
                    </p>
                    <p className="mt-1 line-clamp-2 text-[13px]">{e.message}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </aside>
      </div>
    </>
  );
}

function DiscoveryQueue({ d }: { d: CommandCenter }) {
  const label = (s: string) => ({ AWAITING_MANAGER: "Needs your approval", QUEUED: "Queued", RUNNING: "Searching", FAILED: "Failed", SKIPPED: "Not run" })[s] ?? s;
  return (
    <Panel>
      <PanelHeader title={<span className="flex items-center gap-2"><Building2 className="size-4 text-muted" /> Vendor discovery</span>} action={<Link to="/ops/vendors" className="flex items-center gap-1 text-xs text-muted hover:text-ink">Vendors <ArrowUpRight className="size-3.5" /></Link>}>
        Trades with no approved vendor. Found businesses are never contacted or offered work until you verify and approve one.
      </PanelHeader>
      {d.discovery.searches.length === 0 && d.discovery.toReview.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted">Every open case has an approved vendor to go to.</p>
      ) : (
        <ul className="divide-y divide-line">
          {d.discovery.searches.map((s) => (
            <li key={s.id}>
              <Link to={s.caseId ? `/ops/cases/${s.caseId}#discovery` : "/ops/vendors"} className="block px-4 py-2.5 hover:bg-sunk">
                <p className="flex flex-wrap items-center gap-2 text-xs">
                  {s.caseRef && <Ref>{s.caseRef}</Ref>}
                  <Provenance kind={s.status === "FAILED" ? "failed" : s.status === "SKIPPED" ? "skipped" : "waiting"} label={label(s.status)} />
                  <span className="ml-auto text-faint">{when(s.at)}</span>
                </p>
                <p className="mt-1 text-[13px]">
                  {isTrade(s.trade) ? TRADE_NOUN[s.trade] : CATEGORY_SHORT[s.trade]} for {s.caseTitle}
                </p>
                {s.error && <p className="mt-0.5 line-clamp-1 text-xs text-danger">{s.error}</p>}
              </Link>
            </li>
          ))}
          {d.discovery.toReview.map((g) => (
            <li key={`${g.trade}-${g.status}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
              <span>
                {g.count} {isTrade(g.trade) ? TRADE_NOUN[g.trade] : CATEGORY_SHORT[g.trade]}
                {g.count === 1 ? "" : "s"} {g.status === "VERIFIED" ? "verified, ready to approve" : g.status === "SHORTLISTED" ? "shortlisted" : "to review"}
              </span>
              <Link to="/ops/vendors" className="text-xs text-muted hover:text-ink">
                Review
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Consecutive reviews skipped for the same reason are shown once, with the cases they covered. */
function groupRuns(runs: CommandCenter["aiRuns"]) {
  const out: (CommandCenter["aiRuns"][number] & { refs: string[] })[] = [];
  for (const r of runs) {
    const last = out.at(-1);
    if (last && r.status === "SKIPPED" && last.status === "SKIPPED" && last.summary === r.summary) last.refs.push(r.caseRef);
    else out.push({ ...r, refs: [r.caseRef] });
  }
  return out;
}

function AiWorkflows({ d }: { d: CommandCenter }) {
  const runs = groupRuns(d.aiRuns);
  return (
    <Panel>
      <PanelHeader title={<span className="flex items-center gap-2"><Bot className="size-4 text-ai" /> Relay AI workflows</span>}>The coordinator's recent reviews, as recorded: what woke it and what it did.</PanelHeader>
      {d.aiRuns.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted">No reviews in the last 24 hours.</p>
      ) : (
        <ul className="divide-y divide-line">
          {runs.map((r) => (
            <li key={r.id}>
              <Link to={`/ops/cases/${r.caseId}`} className="block px-4 py-2.5 hover:bg-sunk">
                <p className="flex flex-wrap items-center gap-2 text-xs">
                  <Ref>{r.refs.length > 1 ? `${r.refs.length} cases (${r.refs.slice(0, 3).join(", ")}${r.refs.length > 3 ? ", …" : ""})` : r.caseRef}</Ref>
                  <Provenance kind={r.status === "SUCCEEDED" ? "ai-action" : r.status === "RUNNING" ? "waiting" : r.status === "SKIPPED" ? "skipped" : "failed"} label={r.status === "SUCCEEDED" ? "Reviewed" : r.status.toLowerCase()} />
                  <span className="text-faint">after {r.trigger.toLowerCase().replace(/_/g, " ")}</span>
                  <span className="ml-auto text-faint">{r.durationMs ? `${Math.round(r.durationMs / 1000)} s · ` : ""}{when(r.at)}</span>
                </p>
                <p className="mt-1 line-clamp-2 text-[13px] text-ink-2">{r.summary}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Row({ c, reason, compact }: { c: CaseListItem; reason?: string; compact?: boolean }) {
  const due = dueIn(c.nextActionDueAt);
  return (
    <Link to={`/ops/cases/${c.id}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-sunk sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <Ref>{c.ref}</Ref>
          <span className="truncate font-medium">{c.title}</span>
          {c.severity !== "ROUTINE" && <SeverityBadge severity={c.severity} />}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted">
          {c.propertyName}, unit {c.unitLabel}. {reason ? <span className="text-ink-2">{reason}</span> : <>Next: {c.nextAction.toLowerCase()}</>}
        </p>
      </div>
      {!compact && <StatusBadge status={c.status} category={c.category} />}
      <span className={cn("font-mono text-[11px] whitespace-nowrap", due?.overdue ? "font-medium text-danger" : "text-muted")}>{due ? due.text : when(c.statusChangedAt)}</span>
    </Link>
  );
}

export function CaseRows({ items, compact }: { items: CaseListItem[]; compact?: boolean }): ReactNode {
  return (
    <ul className="divide-y divide-line">
      {items.map((c) => (
        <li key={c.id}>
          <Row c={c} compact={compact} />
        </li>
      ))}
    </ul>
  );
}

export const AiBadge = () => <Provenance kind="ai-action" label="AI" />;

/** The intake safety net: chats and calls the assistant did not finish. A person files each one as a case, or closes it. */
function UnfinishedChats({ items }: { items: UnfinishedChat[] }) {
  return (
    <Panel className="border-[#f3d19c]" data-testid="unfinished-chats">
      <PanelHeader title={<span className="flex items-center gap-2"><MessageSquareWarning className="size-4 text-warn" /> Unfinished reports</span>}>
        Residents told Relay's assistant about a problem, by chat or on a call, but nothing was filed. Read what they said, then file it or close it.
      </PanelHeader>
      <ul className="divide-y divide-line">
        {items.map((c) => (
          <li key={c.id}>
            <UnfinishedRow c={c} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function UnfinishedRow({ c }: { c: UnfinishedChat }) {
  const a = useAction();
  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="px-4 py-3">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{c.residentName}</span>
        <span className="text-muted">
          {c.propertyName}, unit {c.unitLabel}
        </span>
        <Badge tone="outline">{c.channel === "VOICE" ? "Voice call" : "Chat"}</Badge>
        {c.urgent && <Badge tone="danger">Urgent by the safety rules</Badge>}
        <Badge tone="outline">{c.reasonText}</Badge>
        <span className="ml-auto text-xs text-faint">{when(c.since)}</span>
      </p>
      <blockquote className="mt-2 line-clamp-4 border-l-2 border-line pl-3 text-sm whitespace-pre-line text-ink-2">{c.words}</blockquote>
      {a.error && <Notice tone="danger" className="mt-2">{a.error}</Notice>}
      {closing ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input className="min-w-64 flex-1" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why no report is needed (for example: called them, it's a duplicate)" aria-label="Why no report is needed" />
          <Button size="sm" variant="outline" disabled={note.trim().length < 3} busy={a.busy === "close"} onClick={() => a.run("close", () => closeUnfinishedChat({ conversationId: c.id, note }))}>
            Close it
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setClosing(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="move"
            busy={a.busy === "file"}
            onClick={async () => {
              const r = await a.run("file", () => fileUnfinishedChat({ conversationId: c.id }));
              if (r?.caseId) navigate(`/ops/cases/${r.caseId}`);
            }}
          >
            File it as a case
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setClosing(true)}>
            Close without a case
          </Button>
        </div>
      )}
    </div>
  );
}
