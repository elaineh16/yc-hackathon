import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { searchCases, useQuery } from "wasp/client/operations";
import { CATEGORIES, type Category, CATEGORY_SHORT, type Holder, type Severity } from "../../../shared/domain";
import type { CaseFilters } from "../../../shared/views";
import { SeverityBadge, StatusBadge } from "../../components/case";
import { PageTitle, Shell } from "../../components/shell";
import { dueIn, when } from "../../lib";
import { Button, cn, Empty, Input, Panel, Select, Spinner } from "../../ui";

const VIEWS: { key: string; label: string; filter: Partial<CaseFilters> }[] = [
  { key: "open", label: "Open", filter: { open: true } },
  { key: "mine", label: "Waiting on you", filter: { open: true, holder: ["MANAGER"] } },
  { key: "contractor", label: "With contractors", filter: { open: true, holder: ["CONTRACTOR"] } },
  { key: "resident", label: "With residents", filter: { open: true, holder: ["RESIDENT"] } },
  { key: "closed", label: "Closed", filter: { open: false } },
  { key: "all", label: "All", filter: {} },
];

export function CaseInboxPage() {
  return <Shell role="MANAGER" wide>{() => <Inbox />}</Shell>;
}

function Inbox() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const view = params.get("view") ?? (params.get("holder") === "MANAGER" ? "mine" : params.get("holder") === "CONTRACTOR" ? "contractor" : params.get("holder") === "RESIDENT" ? "resident" : "open");
  const category = (params.get("category") as Category | null) ?? "";
  const severity = (params.get("severity") as Severity | null) ?? "";
  const sort = (params.get("sort") as CaseFilters["sort"]) ?? "updated";
  const page = Number(params.get("page") ?? 1);
  const filters: CaseFilters = useMemo(
    () => ({
      ...VIEWS.find((v) => v.key === view)?.filter,
      ...(category ? { category: [category] } : {}),
      ...(severity ? { severity: [severity] } : {}),
      ...(debounced ? { q: debounced } : {}),
      sort,
      page,
      pageSize: 25,
    }),
    [view, category, severity, debounced, sort, page],
  );
  const { data, isLoading } = useQuery(searchCases, filters, { refetchInterval: 5000 });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== "page") next.delete("page");
    next.delete("holder");
    setParams(next, { replace: true });
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageTitle title="Cases">{data ? `${data.total} case${data.total === 1 ? "" : "s"}` : " "}</PageTitle>
      <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label="Views">
        {VIEWS.map((v) => (
          <button key={v.key} role="tab" aria-selected={view === v.key} onClick={() => set("view", v.key === "open" ? "" : v.key)} className={cn("rounded-full px-3 py-1.5 text-sm", view === v.key ? "bg-ink text-white" : "text-muted hover:bg-sunk hover:text-ink")}>
            {v.label}
          </button>
        ))}
      </div>
      <div className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_10rem_11rem]">
        <label className="relative">
          <span className="sr-only">Search</span>
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-faint" />
          <Input className="pl-9" placeholder="Search by reference, title, unit, resident or vendor" value={q} onChange={(e) => (setQ(e.target.value), set("q", e.target.value))} />
        </label>
        <Select aria-label="Category" value={category} onChange={(e) => set("category", e.target.value)}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_SHORT[c]}
            </option>
          ))}
        </Select>
        <Select aria-label="Severity" value={severity} onChange={(e) => set("severity", e.target.value)}>
          <option value="">All severities</option>
          <option value="EMERGENCY">Emergency</option>
          <option value="URGENT">Urgent</option>
          <option value="ROUTINE">Routine</option>
        </Select>
        <Select aria-label="Sort" value={sort} onChange={(e) => set("sort", e.target.value)}>
          <option value="updated">Recently updated</option>
          <option value="created">Newest first</option>
          <option value="severity">Most severe first</option>
          <option value="due">Next action due</option>
        </Select>
      </div>
      <Panel className="overflow-hidden">
        {isLoading && (
          <div className="p-6">
            <Spinner />
          </div>
        )}
        {data && data.items.length === 0 && <Empty title="No cases match">Try another view or clear the search.</Empty>}
        {data && data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="border-b border-line bg-sunk/60 text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Case</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Severity</th>
                  <th className="px-3 py-2 font-medium">Location</th>
                  <th className="px-3 py-2 font-medium">Assigned</th>
                  <th className="px-3 py-2 font-medium">Next action</th>
                  <th className="px-4 py-2 text-right font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((c) => {
                  const due = dueIn(c.nextActionDueAt);
                  return (
                    <tr key={c.id} className="hover:bg-sunk/60">
                      <td className="px-4 py-3">
                        <Link to={`/ops/cases/${c.id}`} className="block font-medium hover:underline">
                          {c.title}
                        </Link>
                        <span className="tnum text-xs text-muted">
                          {c.ref}, {CATEGORY_SHORT[c.category]}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <StatusBadge status={c.status} />
                      </td>
                      <td className="px-3 py-3">
                        <SeverityBadge severity={c.severity} />
                      </td>
                      <td className="px-3 py-3 text-ink-2">
                        {c.propertyName}
                        <span className="block text-xs text-muted">Unit {c.unitLabel}</span>
                      </td>
                      <td className="px-3 py-3 text-ink-2">{c.vendorName ?? <span className="text-faint">None</span>}</td>
                      <td className="px-3 py-3">
                        <span className={cn(c.holder === "MANAGER" && "font-medium text-[#b8460a]")}>{c.nextAction || "None"}</span>
                        {due && <span className={cn("block text-xs", due.overdue ? "text-danger" : "text-muted")}>{due.text}</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-xs whitespace-nowrap text-muted">{when(c.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {pages > 1 && (
        <div className="mt-4 flex items-center justify-end gap-2 text-sm">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => set("page", String(page - 1))}>
            Previous
          </Button>
          <span className="text-muted">
            Page {page} of {pages}
          </span>
          <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => set("page", String(page + 1))}>
            Next
          </Button>
        </div>
      )}
    </>
  );
}

export type { Holder };
