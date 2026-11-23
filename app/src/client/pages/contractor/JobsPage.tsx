import { CalendarCheck, ChevronRight, Clock } from "lucide-react";
import { Link } from "react-router";
import { getMyJobs, useQuery } from "wasp/client/operations";
import type { JobItem } from "../../../shared/views";
import { SeverityBadge, StatusBadge } from "../../components/case";
import { PageTitle, Shell } from "../../components/shell";
import { dayTime, dueIn, money } from "../../lib";
import { cn, Empty, Panel, Spinner } from "../../ui";

export function JobsPage() {
  return <Shell role="CONTRACTOR">{(me) => <Board vendor={me.vendor?.name ?? ""} />}</Shell>;
}

function Board({ vendor }: { vendor: string }) {
  const { data, isLoading } = useQuery(getMyJobs, undefined, { refetchInterval: 5000 });
  if (isLoading || !data) return <Spinner />;
  const section = (title: string, items: JobItem[], empty: string) => (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-medium text-muted">
        {title} <span className="tnum">({items.length})</span>
      </h2>
      <Panel>{items.length ? <ul className="divide-y divide-line">{items.map((j) => <Job key={j.assignmentId} j={j} />)}</ul> : <p className="px-4 py-5 text-sm text-muted">{empty}</p>}</Panel>
    </section>
  );
  return (
    <>
      <PageTitle title="My jobs">{vendor}</PageTitle>
      {section("New offers", data.offers, "No offers waiting.")}
      {section("Active", data.active, "Nothing active.")}
      {section("Completed", data.done, "Nothing completed yet.")}
      {data.offers.length + data.active.length + data.done.length === 0 && <Empty title="No jobs yet">Offers from property managers appear here.</Empty>}
    </>
  );
}

function Job({ j }: { j: JobItem }) {
  const due = j.assignmentStatus === "OFFERED" ? dueIn(j.respondByAt) : null;
  const mine = j.holder === "CONTRACTOR";
  return (
    <li>
      <Link to={`/jobs/${j.id}`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-sunk">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{j.title}</span>
            {j.severity !== "ROUTINE" && <SeverityBadge severity={j.severity} />}
          </p>
          <p className="mt-0.5 text-sm text-muted">
            {j.propertyAddress}, unit {j.unitLabel}
          </p>
          <p className={cn("mt-1 flex items-center gap-1.5 text-xs", mine ? "font-medium text-[#b8460a]" : "text-muted")}>
            {j.appointment ? (
              <>
                <CalendarCheck className="size-3.5" /> {j.appointment.label}
              </>
            ) : due ? (
              <>
                <Clock className="size-3.5" /> Respond {due.text}
              </>
            ) : (
              j.nextAction
            )}
            {j.estimateCents !== null && <span className="text-muted">, estimate {money(j.estimateCents)}</span>}
          </p>
        </div>
        <StatusBadge status={j.status} />
        <ChevronRight className="size-4 text-faint" />
      </Link>
    </li>
  );
}

export { dayTime };
