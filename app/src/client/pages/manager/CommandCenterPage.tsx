import { Bot, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { getCommandCenter, useQuery } from "wasp/client/operations";
import type { CaseListItem } from "../../../shared/views";
import { SeverityBadge, StatusBadge } from "../../components/case";
import { PageTitle, Shell } from "../../components/shell";
import { dueIn, when } from "../../lib";
import { Badge, cn, Empty, Panel, PanelHeader, Spinner } from "../../ui";

export function CommandCenterPage() {
  return <Shell role="MANAGER">{(me) => <Command name={me.name.split(" ")[0]} />}</Shell>;
}

function Command({ name }: { name: string }) {
  const { data: d, isLoading } = useQuery(getCommandCenter, undefined, { refetchInterval: 5000 });
  if (isLoading || !d) return <Spinner />;
  const stat = (label: string, value: number, to: string, tone?: "move" | "danger") => (
    <Link to={to} className="group rounded-lg border border-line bg-surface px-4 py-3 hover:border-line-strong">
      <p className={cn("tnum text-2xl font-semibold", value > 0 && tone === "danger" && "text-danger", value > 0 && tone === "move" && "text-[#b8460a]")}>{value}</p>
      <p className="text-sm text-muted group-hover:text-ink">{label}</p>
    </Link>
  );
  return (
    <>
      <PageTitle title={`Good to see you, ${name}`}>Live view of every open case at your properties. Numbers are counted from the cases themselves.</PageTitle>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stat("Open cases", d.counts.open, "/ops/cases")}
        {stat("Waiting on you", d.counts.waitingOnManager, "/ops/cases?holder=MANAGER", "move")}
        {stat("Emergencies", d.counts.emergencies, "/ops/cases?severity=EMERGENCY", "danger")}
        {stat("Overdue", d.counts.overdue, "/ops/cases?sort=due", "danger")}
        {stat("With contractors", d.counts.waitingOnContractors, "/ops/cases?holder=CONTRACTOR")}
        {stat("With residents", d.counts.waitingOnResidents, "/ops/cases?holder=RESIDENT")}
      </div>
      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-5">
          {d.attention.length > 0 && (
            <Panel className="border-[#f0c4be]">
              <PanelHeader title="Needs attention">Emergencies, escalations and overdue actions.</PanelHeader>
              <CaseRows items={d.attention} />
            </Panel>
          )}
          <Panel>
            <PanelHeader title="Your move">Cases waiting on a manager, oldest first.</PanelHeader>
            {d.waitingOnManager.length ? <CaseRows items={d.waitingOnManager} /> : <Empty title="Nothing waiting on you">New reports and decisions will appear here.</Empty>}
          </Panel>
          <div className="grid gap-5 md:grid-cols-2">
            <Panel>
              <PanelHeader title="With contractors" />
              {d.waitingOnContractors.length ? <CaseRows items={d.waitingOnContractors} compact /> : <Empty title="None" />}
            </Panel>
            <Panel>
              <PanelHeader title="With residents" />
              {d.waitingOnResidents.length ? <CaseRows items={d.waitingOnResidents} compact /> : <Empty title="None" />}
            </Panel>
          </div>
        </div>
        <div className="space-y-5">
          <Panel className="border-[#d5daf0]">
            <PanelHeader
              title={
                <span className="flex items-center gap-2">
                  <Sparkles className="size-4 text-ai" /> Relay suggestions
                </span>
              }
            >
              Proposals from the AI coordinator waiting for your decision.
            </PanelHeader>
            {d.suggestions.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted">No suggestions waiting.</p>
            ) : (
              <ul className="divide-y divide-line">
                {d.suggestions.map((s) => (
                  <li key={s.id}>
                    <Link to={`/ops/cases/${s.caseId}`} className="block px-4 py-3 hover:bg-sunk">
                      <p className="text-sm font-medium">{s.summary}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted">{s.rationale}</p>
                      <p className="mt-1 text-xs text-faint">
                        {s.caseRef}, {s.caseTitle}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel>
            <PanelHeader title="Recent activity" />
            <ul className="divide-y divide-line">
              {d.recent.length === 0 && <li className="px-4 py-5 text-sm text-muted">No activity yet.</li>}
              {d.recent.map((e) => (
                <li key={e.id}>
                  <Link to={`/ops/cases/${e.caseId}`} className="block px-4 py-2.5 hover:bg-sunk">
                    <p className="flex items-center gap-1.5 text-xs text-muted">
                      <span className="tnum font-medium text-ink-2">{e.caseRef}</span>
                      {e.actorRole === "AGENT" && <Bot className="size-3.5 text-ai" aria-label="Relay AI" />}
                      {e.actorName}, {when(e.at)}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-sm">{e.message}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}

export function CaseRows({ items, compact }: { items: CaseListItem[]; compact?: boolean }): ReactNode {
  return (
    <ul className="divide-y divide-line">
      {items.map((c) => {
        const due = dueIn(c.nextActionDueAt);
        return (
          <li key={c.id}>
            <Link to={`/ops/cases/${c.id}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-sunk sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="tnum text-xs text-muted">{c.ref}</span>
                  <span className="truncate font-medium">{c.title}</span>
                  {c.severity !== "ROUTINE" && <SeverityBadge severity={c.severity} />}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted">
                  {c.propertyName}, unit {c.unitLabel}. Next: {c.nextAction.toLowerCase()}
                </p>
              </div>
              {!compact && <StatusBadge status={c.status} />}
              <span className={cn("text-xs whitespace-nowrap", due?.overdue ? "font-medium text-danger" : "text-muted")}>{due ? due.text : when(c.statusChangedAt)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export const AiBadge = () => (
  <Badge tone="ai">
    <Bot /> AI
  </Badge>
);
