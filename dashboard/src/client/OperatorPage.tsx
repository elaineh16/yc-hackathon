import { useState } from "react";
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
import "./relay.css";

const money = (c: number | null) => (c === null ? "Unknown" : `$${(c / 100).toFixed(c % 100 ? 2 : 0)} CAD`);
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "");
const PIN_KEY = "relay.operatorPin";
const getPin = () => {
  try {
    return sessionStorage.getItem(PIN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export function OperatorPage() {
  const { data, error, isLoading } = useQuery(getOperatorDashboard, undefined, { refetchInterval: 2000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [eta, setEta] = useState(15);
  const [cap, setCap] = useState(400);

  /** Runs one server action; the server validates every transition and returns 409 on an invalid one. */
  async function run(label: string, fn: (pin?: string) => Promise<unknown>) {
    setBusy(label);
    setActionError(null);
    try {
      await fn(getPin());
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      if (err.statusCode === 401) {
        const pin = window.prompt("Operator PIN");
        if (pin) {
          try {
            sessionStorage.setItem(PIN_KEY, pin);
          } catch {}
          try {
            await fn(pin);
          } catch (e2) {
            setActionError((e2 as Error).message);
          }
        }
      } else setActionError(err.message ?? "Action failed");
    } finally {
      setBusy(null);
    }
  }

  const wo = data?.workOrder ?? null;
  const id = wo?.id ?? "";
  const staff = wo?.staff;
  const d = wo?.decision;

  return (
    <main className="wrap">
      <div className="row between">
        <h1>Relay operator dashboard</h1>
        <div className="row">
          <span className="muted">
            <span className={`dot ${error ? "" : "on"}`} />
            {error ? "Server unreachable" : `Live · ${time(data?.serverTime ?? null)}`}
          </span>
          <button
            className="danger"
            disabled={!!busy}
            onClick={() => window.confirm("Reset the demo? This clears every work order and student session.") && run("reset", (pin) => resetDemo({ operatorPin: pin }))}
          >
            Reset demo
          </button>
        </div>
      </div>
      {actionError && <p className="err">{actionError}</p>}
      {isLoading && <p className="muted">Loading…</p>}
      {!isLoading && !wo && (
        <div className="card">
          <p>No work order yet. Open the student page and tap Talk to Relay.</p>
        </div>
      )}

      {wo && (
        <div className="grid">
          <section className="card">
            <div className="row between">
              <h2>Issue · work order #{wo.number}</h2>
              {wo.safetyHazard && <span className="pill bad">safety</span>}
            </div>
            <p className="headline">{wo.location}</p>
            <p>{wo.symptom}</p>
            <p className="muted">
              Floor: {wo.floorStatus.toLowerCase()}
              {wo.reportedErrorCode && <> · Display shows <strong>{wo.reportedErrorCode}</strong> (reported symptom, not a diagnosis)</>}
              {wo.intakeCount > 1 && <> · {wo.intakeCount} reports merged</>}
            </p>
            {wo.hazardDetails && <p className="err">{wo.hazardDetails}</p>}
          </section>

          <section className="card">
            <div className="row between">
              <h2>Front desk · {staff?.desk}</h2>
              <span className={`pill ${staff?.status === "RETRIEVED" ? "ok" : staff?.status === "UNAVAILABLE" ? "bad" : "warn"}`}>{staff?.status}</span>
            </div>
            <p className="headline">{staff?.label}</p>
            <p className="muted">
              Requested {time(staff?.requestedAt ?? null)}
              {staff?.acceptedAt && <> · accepted {time(staff.acceptedAt)}</>}
              {staff?.retrievedAt && <> · retrieved {time(staff.retrievedAt)}</>}
              {staff?.assignedTo === "MANAGER" && <> · retrieval referred to the manager</>}
            </p>
            <div className="row">
              <label className="muted">
                ETA (min) <input type="number" min={1} max={240} value={eta} onChange={(e) => setEta(Number(e.target.value))} />
              </label>
              <button className="primary" disabled={!!busy || staff?.status !== "REQUESTED"} onClick={() => run("accept", (pin) => staffAccept({ workOrderId: id, etaMinutes: eta, operatorPin: pin }))}>
                Accept
              </button>
              <button
                disabled={!!busy || !(staff?.status === "ACCEPTED" || staff?.status === "UNAVAILABLE")}
                onClick={() => run("retrieved", (pin) => staffMarkRetrieved({ workOrderId: id, operatorPin: pin }))}
              >
                Clothes retrieved
              </button>
              <button
                className="danger"
                disabled={!!busy || !(staff?.status === "REQUESTED" || staff?.status === "ACCEPTED")}
                onClick={() => {
                  const reason = window.prompt("Why can't staff help?", "No staff available to retrieve safely");
                  if (reason !== null) void run("unavailable", (pin) => staffMarkUnavailable({ workOrderId: id, reason, operatorPin: pin }));
                }}
              >
                Unavailable
              </button>
            </div>
          </section>

          <section className="card" style={{ gridColumn: "1 / -1" }}>
            <div className="row between">
              <h2>Repair options</h2>
              <span className="pill sim">simulated contractor responses</span>
            </div>
            {wo.contractors.length === 0 && <p className="muted">Contacting Bluejay, QuickFix and Metro (simulated)…</p>}
            {wo.contractors.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Contractor</th>
                    <th>Availability</th>
                    <th>Price</th>
                    <th>Scope</th>
                  </tr>
                </thead>
                <tbody>
                  {wo.contractors.map((c) => (
                    <tr key={c.contractorKey} className={c.recommended ? "rec" : ""}>
                      <td>
                        <strong>{c.name}</strong> {c.recommended && <span className="pill ok">recommended</span>} <span className="pill sim">simulated</span>
                      </td>
                      <td>{c.availability ?? "Unknown"}</td>
                      <td className="money">{money(c.priceCents)}</td>
                      <td>{c.outcome === "VOICEMAIL" ? "Voicemail, no details" : c.priceNote}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {wo.recommendation && <p>{wo.recommendation}</p>}
          </section>

          <section className="card">
            <div className="row between">
              <h2>Manager approval</h2>
              {d && <span className={`pill ${d.status === "APPROVED" ? "ok" : d.status === "DENIED" ? "bad" : "warn"}`}>{d.status}</span>}
            </div>
            {!d && <p className="muted">Waiting for a recommendation.</p>}
            {d && (
              <>
                <p>
                  {d.contractorName} estimate <span className="money">{money(d.estimateCents)}</span> before tax · {d.estimateNote}
                </p>
                <p className="muted">Auto-approval threshold {money(d.autoApproveLimitCents)}. This estimate exceeds it, so a manager must approve.</p>
                {d.status === "APPROVED" && (
                  <p>
                    Approved cap <span className="money">{money(d.approvedCapCents)}</span> {d.capNote} · by {d.decidedBy} at {time(d.decidedAt)}
                  </p>
                )}
                {d.status === "DENIED" && <p className="err">Denied by {d.decidedBy}{d.note ? `: ${d.note}` : ""}. No appointment will be confirmed.</p>}
                {d.status === "PENDING" && (
                  <div className="row">
                    <label className="muted">
                      All-in cap (CAD, incl. taxes and fees) <input type="number" min={1} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
                    </label>
                    <button
                      className="primary"
                      disabled={!!busy}
                      onClick={() => run("approve", (pin) => approveRepair({ workOrderId: id, capCents: Math.round(cap * 100), approver: "Manager", note: "Conditional on diagnosis", operatorPin: pin }))}
                    >
                      Approve up to {money(Math.round(cap * 100))}
                    </button>
                    <button className="danger" disabled={!!busy} onClick={() => run("deny", (pin) => denyRepair({ workOrderId: id, approver: "Manager", operatorPin: pin }))}>
                      Deny
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="card">
            <div className="row between">
              <h2>Appointment</h2>
              <span className="pill sim">simulated</span>
            </div>
            {wo.appointment ? (
              <p className="headline">
                {wo.appointment.contractorName} · {wo.appointment.arrivalWindow}
              </p>
            ) : (
              <p className="muted">{wo.repairLabel}</p>
            )}
            {/* Enabled only after approval; the server refuses it otherwise. */}
            <button
              disabled={!!busy || !!wo.appointment || wo.repairStatus !== "CONFIRMATION_PENDING"}
              onClick={() => run("confirm", (pin) => simulateConfirmation({ workOrderId: id, operatorPin: pin }))}
            >
              Simulate confirmation
            </button>
          </section>

          <section className="card" style={{ gridColumn: "1 / -1" }}>
            <h2>Timeline</h2>
            <ul className="timeline">
              {wo.timeline.map((e) => (
                <li key={e.id}>
                  <time>{time(e.at)}</time>
                  <span>
                    <span className="pill">{e.actor.toLowerCase()}</span> {e.message} {e.simulated && <span className="pill sim">simulated</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </main>
  );
}
