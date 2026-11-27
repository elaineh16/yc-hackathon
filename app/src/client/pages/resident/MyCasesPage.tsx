import { ChevronRight, Wrench } from "lucide-react";
import { Link } from "react-router";
import { getMyCases, useQuery } from "wasp/client/operations";
import { StatusBadge } from "../../components/case";
import { PageTitle, Shell } from "../../components/shell";
import { holderText, when } from "../../lib";
import { Button, cn, Empty, Panel, Spinner } from "../../ui";

export function MyCasesPage() {
  return <Shell role="RESIDENT">{() => <List />}</Shell>;
}

function List() {
  const { data, isLoading } = useQuery(getMyCases, undefined, { refetchInterval: 5000 });
  const open = (data ?? []).filter((c) => c.status !== "RESOLVED" && c.status !== "CANCELLED");
  const closed = (data ?? []).filter((c) => c.status === "RESOLVED" || c.status === "CANCELLED");
  return (
    <>
      <PageTitle
        title="My requests"
        action={
          <Button asChild variant="move">
            <Link to="/my/report">
              <Wrench /> Report a problem
            </Link>
          </Button>
        }
      />
      {isLoading && <Spinner />}
      {data && data.length === 0 && (
        <Panel>
          <Empty title="No requests yet" action={<Button asChild><Link to="/my/report">Report a problem</Link></Button>}>
            When something breaks, tell Relay in your own words. You will see every step here.
          </Empty>
        </Panel>
      )}
      {[
        ["Open", open],
        ["Closed", closed],
      ].map(([label, items]) =>
        (items as typeof open).length ? (
          <section key={label as string} className="mb-6">
            <h2 className="mb-2 text-sm font-medium text-muted">{label as string}</h2>
            <Panel>
              <ul className="divide-y divide-line">
                {(items as typeof open).map((c) => {
                  const h = holderText(c.holder, "RESIDENT");
                  return (
                    <li key={c.id}>
                      <Link to={`/my/cases/${c.id}`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-sunk">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{c.title}</p>
                          <p className={cn("mt-0.5 text-sm", h.mine ? "font-medium text-[#b8460a]" : "text-muted")}>{h.mine ? `Your move: ${c.nextAction.toLowerCase()}` : c.nextAction || (c.status === "RESOLVED" ? "Fixed" : "Cancelled")}</p>
                          <p className="mt-0.5 text-xs text-faint">
                            {c.ref}, updated {when(c.updatedAt)}
                          </p>
                        </div>
                        <StatusBadge status={c.status} />
                        <ChevronRight className="size-4 text-faint" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          </section>
        ) : null,
      )}
    </>
  );
}
