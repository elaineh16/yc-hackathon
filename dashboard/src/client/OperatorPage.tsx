import { useEffect, useState } from "react";
import {
  approveRepair,
  denyRepair,
  getOperatorDashboard,
  resetDemo,
  simulateConfirmation,
  staffAccept,
  staffMarkRetrieved,
  staffMarkUnavailable,
  useQuery,
} from "wasp/client/operations";
import type { OperatorDashboard } from "../shared/relayTypes";
import "./relay.css";

type WorkOrder = NonNullable<OperatorDashboard["workOrder"]>;
type Tab = "work-orders" | "staff" | "contractors" | "approvals";
const TABS: { key: Tab; label: string }[] = [
  { key: "work-orders", label: "Work orders" },
  { key: "staff", label: "Staff" },
  { key: "contractors", label: "Contractors" },
  { key: "approvals", label: "Approvals" },
];

const dollars = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const money = (c: number | null) => (c === null ? "Unknown" : `${dollars(c)} CAD`);
const clock = (iso: string | null | undefined, seconds = false) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) }) : "";
const woCode = (n: number) => `WO-${String(n).padStart(4, "0")}`;
/** "Washer won't drain; clothes stuck inside" -> "Washer won't drain" for the card title. */
const shortTitle = (symptom: string) => {
  const first = symptom.split(/[;,.]|\s+and\s+/)[0].trim();
  return first.length > 3 ? first.charAt(0).toUpperCase() + first.slice(1) : symptom;
};
const trade = (machine: string) => (/washer|dryer|machine/i.test(machine) ? "Appliance" : "General");

const PIN_KEY = "relay.operatorPin";
const pinStore = {
  get: () => {
    try {
      return sessionStorage.getItem(PIN_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) sessionStorage.setItem(PIN_KEY, v);
      else sessionStorage.removeItem(PIN_KEY);
    } catch {
      /* private mode: ask again next time */
    }
  },
};
type Outcome = { ok: boolean; status?: number; message?: string };

const STAFF_CHIP: Record<string, { text: (wo: WorkOrder) => string; tone: string }> = {
  REQUESTED: { text: (wo) => (wo.staff?.priority === "SAFETY" ? "Alerted · safety" : "Pending"), tone: "amber" },
  ACCEPTED: { text: (wo) => `On the way · ${wo.staff?.etaMinutes ?? 15} min`, tone: "blue" },
  RETRIEVED: { text: () => "Retrieved", tone: "green" },
  UNAVAILABLE: { text: () => "Unavailable · manager arranging", tone: "red" },
};
const REPAIR_CHIP: Record<string, { text: string; tone: string }> = {
  OPTIONS_PENDING: { text: "Pending", tone: "amber" },
  RECOMMENDED: { text: "Awaiting approval", tone: "amber" },
  PENDING_APPROVAL: { text: "Awaiting approval", tone: "amber" },
  CONFIRMATION_PENDING: { text: "Approved · confirming", tone: "blue" },
  CONFIRMED: { text: "Booked", tone: "green" },
  DENIED: { text: "Denied", tone: "red" },
  ESCALATED: { text: "Paused · safety", tone: "red" },
};

export function OperatorPage() {
  const { data, error, isLoading } = useQuery(getOperatorDashboard, undefined, { refetchInterval: 2000 });
  const [tab, setTab] = useState<Tab>(() => {
    const h = typeof window === "undefined" ? "" : window.location.hash.slice(1);
    return TABS.some((t) => t.key === h) ? (h as Tab) : "work-orders";
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [eta, setEta] = useState(15);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    window.history.replaceState(null, "", `#${tab}`);
  }, [tab]);

  const wo = data?.workOrder ?? null;
  const id = wo?.id ?? "";
  const decision = wo?.decision ?? null;
  // The "blocked" notice belongs to one pending approval: clear it when that changes.
  useEffect(() => setBlocked(false), [id, decision?.status]);

  /** Runs one server action. The server validates every transition; a missing or wrong PIN asks once and retries. */
  async function run(label: string, fn: (pin?: string) => Promise<unknown>): Promise<Outcome> {
    setBusy(label);
    setActionError(null);
    try {
      await fn(pinStore.get());
      return { ok: true };
    } catch (first) {
      let err = first as { statusCode?: number; message?: string };
      if (err.statusCode === 401) {
        const pin = window.prompt("Operator PIN");
        if (!pin) return { ok: false, status: 401, message: "Operator PIN required." };
        pinStore.set(pin);
        try {
          await fn(pin);
          return { ok: true };
        } catch (second) {
          err = second as typeof err;
          if (err.statusCode === 401) pinStore.set(null);
        }
      }
      return { ok: false, status: err.statusCode, message: err.statusCode === 401 ? "That PIN was not accepted." : (err.message ?? "Action failed.") };
    } finally {
      setBusy(null);
    }
  }
  const act = async (label: string, fn: (pin?: string) => Promise<unknown>) => {
    const r = await run(label, fn);
    if (!r.ok) setActionError(r.message ?? "Action failed.");
  };

  const needsStaff = wo?.staff?.status === "REQUESTED";
  const needsManager = decision?.status === "PENDING" || wo?.repairStatus === "CONFIRMATION_PENDING";

  return (
    <div className="ops">
      <aside className="ops-side">
        <div>
          <div className="ops-brand">RELAY</div>
          <div className="ops-brand-sub">{wo?.residence ?? "MKV"} Residence ops</div>
        </div>
        <nav className="ops-nav" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.key} className={`ops-tab ${tab === t.key ? "on" : ""}`} aria-current={tab === t.key ? "page" : undefined} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === "staff" && needsStaff && <span className="dot" title="Waiting for staff" />}
              {t.key === "approvals" && needsManager && <span className="dot" title="Waiting for the manager" />}
              {t.key === "contractors" && wo && wo.contractors.length > 0 && <span className="count">{wo.contractors.length}</span>}
            </button>
          ))}
        </nav>
        <div className="ops-foot">
          <div className={`ops-live ${error ? "off" : ""}`}>
            <i />
            <span>{error ? "Server unreachable" : `Live · ${clock(data?.serverTime, true)}`}</span>
          </div>
          <button
            className="ops-reset"
            disabled={!!busy}
            onClick={() => window.confirm("Reset the demo? This clears every work order and student session.") && act("reset", (pin) => resetDemo({ operatorPin: pin }))}
          >
            Reset demo
          </button>
        </div>
      </aside>

      <main className="ops-main">
        <div className="ops-inner">
          <h1>{TABS.find((t) => t.key === tab)?.label}</h1>
          {actionError && (
            <div className="banner red" role="alert">
              {actionError}
            </div>
          )}
          {isLoading && <p className="muted">Loading…</p>}
          {!isLoading && !wo && (
            <section className="card empty">
              <strong>No work order yet</strong>
              Open the student page <code>{typeof window === "undefined" ? "/" : `${window.location.origin}/`}</code> and tap Talk to Relay. The report appears here as soon as Relay saves it.
            </section>
          )}

          {wo && tab === "work-orders" && (
            <>
              <WorkOrderCard wo={wo} />
              <Timeline wo={wo} />
            </>
          )}

          {wo && tab === "staff" && (
            <>
              <WorkOrderCard wo={wo} />
              <StaffActions
                wo={wo}
                eta={eta}
                setEta={setEta}
                busy={!!busy}
                onAccept={() => act("accept", (pin) => staffAccept({ workOrderId: id, etaMinutes: eta, operatorPin: pin }))}
                onRetrieved={() => act("retrieved", (pin) => staffMarkRetrieved({ workOrderId: id, operatorPin: pin }))}
                onUnavailable={() => {
                  const reason = window.prompt("Why can't staff help?", "No staff available to retrieve safely");
                  if (reason !== null) void act("unavailable", (pin) => staffMarkUnavailable({ workOrderId: id, reason, operatorPin: pin }));
                }}
              />
            </>
          )}

          {wo && tab === "contractors" && <Contractors wo={wo} />}

          {wo && tab === "approvals" && (
            <>
              <Approval
                wo={wo}
                capCents={data?.policy.defaultCapCents ?? 40_000}
                busy={!!busy}
                blocked={blocked}
                onApprove={(capCents) =>
                  act("approve", (pin) => approveRepair({ workOrderId: id, capCents, approver: "Manager", note: "Conditional on diagnosis", operatorPin: pin }))
                }
                onDeny={() => window.confirm("Deny this repair? No appointment will be confirmed.") && act("deny", (pin) => denyRepair({ workOrderId: id, approver: "Manager", operatorPin: pin }))}
                onConfirm={async () => {
                  const r = await run("confirm", (pin) => simulateConfirmation({ workOrderId: id, operatorPin: pin }));
                  // 409 = the server refused because there is no manager approval: show it as the guard working.
                  if (!r.ok && r.status === 409 && decision?.status === "PENDING") setBlocked(true);
                  else if (!r.ok) setActionError(r.message ?? "Action failed.");
                }}
              />
              <Timeline wo={wo} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function WorkOrderCard({ wo }: { wo: WorkOrder }) {
  const staff = STAFF_CHIP[wo.staff?.status ?? "REQUESTED"] ?? STAFF_CHIP.REQUESTED;
  const repair = REPAIR_CHIP[wo.repairStatus] ?? { text: wo.repairStatus, tone: "" };
  const viaTest = wo.timeline.some((e) => e.type === "intake.saved" && /test report/i.test(e.message));
  return (
    <section className="card wo">
      <div className="wo-top">
        <h2>
          {woCode(wo.number)} · {shortTitle(wo.symptom)}
        </h2>
        {wo.safetyHazard ? <span className="chip red">Safety</span> : wo.repairStatus === "CONFIRMED" ? <span className="chip green">Booked</span> : <span className="chip amber">New</span>}
        <span className="wo-via">
          {viaTest ? "via test report" : "via voice"} · {clock(wo.createdAt)}
        </span>
      </div>
      {wo.safetyHazard && (
        <div className="banner red" role="status">
          Safety hazard reported{wo.hazardDetails ? `: ${wo.hazardDetails}` : wo.floorStatus === "WET" ? ": water on the floor." : "."} Residence staff attend first. Contractor outreach is paused.
        </div>
      )}
      <dl className="fields">
        <Field label="Residence" value={wo.residence} />
        <Field label="Location" value={wo.room} />
        <Field label="Machine" value={wo.machine} />
        <Field label="Error code" value={wo.reportedErrorCode ? `${wo.reportedErrorCode} (reported)` : "None"} />
        <Field label="Floor" value={wo.floorStatus === "DRY" ? "Dry" : wo.floorStatus === "WET" ? "Wet" : "Unknown"} />
        <Field label="Trade" value={trade(wo.machine)} />
        <div className="wide">
          <dt className="label">Reported{wo.intakeCount > 1 ? ` · ${wo.intakeCount} reports merged` : ""}</dt>
          <dd>{wo.symptom}</dd>
        </div>
      </dl>
      <div className="lanes">
        <div className="lane">
          <span className="label">Staff request · {wo.safetyHazard ? "attend now" : "retrieve clothes"}</span>
          <span className={`chip ${wo.staff?.priority === "SAFETY" && wo.staff.status === "REQUESTED" ? "red" : staff.tone}`}>{staff.text(wo)}</span>
        </div>
        <div className="lane">
          <span className="label">Repair</span>
          <span className={`chip ${repair.tone}`}>{repair.text}</span>
        </div>
      </div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function StaffActions(p: { wo: WorkOrder; eta: number; setEta: (n: number) => void; busy: boolean; onAccept: () => void; onRetrieved: () => void; onUnavailable: () => void }) {
  const s = p.wo.staff;
  if (!s) return null;
  const requested = s.status === "REQUESTED";
  const canRetrieve = s.status === "ACCEPTED" || s.status === "UNAVAILABLE";
  return (
    <>
      <section className="card row-card">
        <div className="grow">
          {s.desk} · on shift
          <small>
            Requested {clock(s.requestedAt)}
            {s.acceptedAt && ` · accepted ${clock(s.acceptedAt)}`}
            {s.retrievedAt && ` · retrieved ${clock(s.retrievedAt)}`}
          </small>
        </div>
        <label className="eta-wrap">
          ETA
          <input className="eta" type="number" min={1} max={240} value={requested ? p.eta : (s.etaMinutes ?? p.eta)} disabled={!requested} onChange={(e) => p.setEta(Number(e.target.value))} aria-label="ETA in minutes" />
          min
        </label>
        {requested ? (
          <button className="btn primary" disabled={p.busy} onClick={p.onAccept}>
            Send ETA
          </button>
        ) : (
          <button className="btn success" disabled>
            {s.status === "UNAVAILABLE" ? "Unavailable" : "Sent ✓"}
          </button>
        )}
      </section>
      {s.status !== "RETRIEVED" && (
        <section className="card row-card">
          <div className="grow">
            {s.assignedTo === "MANAGER" ? "Retrieval is with the manager" : "Clothes"}
            <small>{s.assignedTo === "MANAGER" ? (s.note ?? "Staff could not help.") : "Mark this when the student has their clothes. The repair continues separately."}</small>
          </div>
          <button className="btn" disabled={p.busy || !canRetrieve} onClick={p.onRetrieved}>
            Clothes retrieved
          </button>
          <button className="btn ghost-danger" disabled={p.busy || !(requested || s.status === "ACCEPTED")} onClick={p.onUnavailable}>
            Can't help
          </button>
        </section>
      )}
    </>
  );
}

function Contractors({ wo }: { wo: WorkOrder }) {
  if (wo.repairStatus === "ESCALATED") {
    return <div className="banner red">Contractor outreach is paused. This work order was escalated for safety, so residence staff attend first.</div>;
  }
  const rec = wo.contractors.find((c) => c.recommended);
  const why = wo.recommendation?.replace(/^Relay recommends [^:]+:\s*/, "");
  return (
    <>
      <div className="banner purple">
        <span className="chip purple">Simulated</span>
        Contractor responses in this demo are simulated. No real contractors were called.
      </div>
      <section className="card table-card">
        <table className="grid">
          <thead>
            <tr>
              <th className="label">Contractor</th>
              <th className="label">Available</th>
              <th className="label">Quote</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {wo.contractors.map((c) => (
              <tr key={c.contractorKey} className={c.recommended ? "rec" : ""}>
                <td className="name">{c.name}</td>
                <td>{c.outcome === "VOICEMAIL" ? "Voicemail" : (c.availability ?? "Unknown")}</td>
                <td>{c.priceCents === null ? "Unknown" : `${money(c.priceCents)}${c.priceNote ? ` · ${c.priceNote}` : ""}`}</td>
                <td className="tags">
                  {c.recommended && <span className="chip solid-blue">★ Recommended</span>}
                  <span className="chip purple">Simulated</span>
                </td>
              </tr>
            ))}
            {wo.contractors.length < 3 && wo.repairStatus === "OPTIONS_PENDING" && (
              <tr>
                <td colSpan={4} className="muted">
                  {wo.contractors.length === 0 ? "Reaching out to Bluejay, QuickFix and Metro…" : "Waiting for the remaining responses…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {rec && why && (
          <p className="why">
            <strong>Why {rec.name}:</strong> {why.charAt(0).toUpperCase() + why.slice(1)}
          </p>
        )}
      </section>
    </>
  );
}

function Approval(p: { wo: WorkOrder; capCents: number; busy: boolean; blocked: boolean; onApprove: (capCents: number) => void; onDeny: () => void; onConfirm: () => void }) {
  const { wo } = p;
  const d = wo.decision;
  if (wo.repairStatus === "ESCALATED") {
    return <div className="banner red">Nothing to approve. Repairs are paused while a safety hazard is open on this work order.</div>;
  }
  if (!d) {
    return (
      <section className="card empty">
        <strong>Nothing to approve yet</strong>
        Relay is collecting contractor responses. If the recommended estimate is over the auto-approve limit, the request appears here.
      </section>
    );
  }
  const offer = wo.contractors.find((c) => c.contractorKey === d.contractorKey);
  const cap = d.approvedCapCents ?? p.capCents;
  return (
    <>
      <section className="card approval">
        {d.status === "PENDING" && (
          <div className="banner amber">
            ⚠ Approval needed: {dollars(d.estimateCents)} is over the {dollars(d.autoApproveLimitCents)} auto-approve limit
          </div>
        )}
        {d.status === "APPROVED" && (
          <div className="banner green">
            ✓ Approved by {d.decidedBy === "POLICY" ? "policy" : "manager"} · up to {money(cap)} all-in{d.decidedBy === "POLICY" ? "" : ", taxes and fees included"}
          </div>
        )}
        {d.status === "DENIED" && <div className="banner red">✕ Denied by {d.decidedBy === "SYSTEM" ? "the system" : "manager"}{d.note ? `: ${d.note}` : ""}. No appointment will be confirmed.</div>}

        <div className="approval-line">
          <strong>{d.contractorName}</strong>
          <span className="muted">
            {wo.appointment ? wo.appointment.arrivalWindow : (offer?.availability ?? "Availability unknown")} · {money(d.estimateCents)} before tax · {d.estimateNote.replace(/^pre-tax\s*/i, "")}
          </span>
          <span className="chip purple">Simulated</span>
        </div>

        <div className="approval-actions">
          {!wo.appointment && d.status !== "DENIED" && (
            <button className={`btn ${d.status === "APPROVED" ? "primary" : ""}`} disabled={p.busy} onClick={p.onConfirm}>
              Simulate confirmation
            </button>
          )}
          {d.status === "PENDING" && (
            <>
              <button className="btn primary" disabled={p.busy} onClick={() => p.onApprove(p.capCents)}>
                Approve up to {money(p.capCents)} all-in
              </button>
              <button className="btn ghost-danger" disabled={p.busy} onClick={p.onDeny}>
                Deny
              </button>
            </>
          )}
          {p.blocked && d.status === "PENDING" && (
            <span className="chip red" role="status">
              Blocked: needs approval
            </span>
          )}
          <span className="approval-status">
            Status:
            <span className={`chip ${d.status === "APPROVED" ? "green" : d.status === "DENIED" ? "red" : "amber"}`}>
              {d.status === "APPROVED" ? "Approved" : d.status === "DENIED" ? "Denied" : "Awaiting approval"}
            </span>
          </span>
        </div>
      </section>
      {wo.appointment && (
        <section className="card confirmed">
          ✓ Confirmed:
          <span className="what">
            {wo.appointment.contractorName} · {wo.appointment.arrivalWindow}
          </span>
          <span className="chip purple">Simulated</span>
        </section>
      )}
    </>
  );
}

function Timeline({ wo }: { wo: WorkOrder }) {
  return (
    <section className="card timeline-card">
      <span className="label">Timeline</span>
      <ul className="timeline">
        {wo.timeline.map((e) => (
          <li key={e.id}>
            <time>{clock(e.at, true)}</time>
            <span className="who">{e.actor.toLowerCase()}</span>
            <span>
              {e.message.replace(/\s*\(simulated\)/gi, "")}
              {e.simulated && <span className="chip purple">Simulated</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
