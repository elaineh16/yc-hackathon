import { useEffect, useState } from "react";
import { createDemoSession, getStudentStatus, submitTestReport, useQuery } from "wasp/client/operations";
import { VoicePanel } from "./VoicePanel";
import "./relay.css";

const KEY = "relay.sessionId";
const read = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const write = (v: string | null) => {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: session lives only in memory */
  }
};

/** One demo session per browser; replaced automatically after a demo reset. */
function useDemoSession() {
  const [sessionId, setSessionId] = useState<string | null>(read);
  const [error, setError] = useState<string | null>(null);
  const renew = async () => {
    setError(null);
    try {
      const { sessionId: id } = await createDemoSession();
      write(id);
      setSessionId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start a session.");
    }
  };
  useEffect(() => {
    if (!sessionId) void renew();
  }, [sessionId]);
  return { sessionId, error, renew };
}

export function StudentPage() {
  const { sessionId, error, renew } = useDemoSession();
  const status = useQuery(getStudentStatus, { sessionId: sessionId ?? "" }, { enabled: !!sessionId, refetchInterval: 2000 });

  // After a demo reset the old session is gone: start a fresh one.
  useEffect(() => {
    if (status.data && !status.data.sessionValid) {
      write(null);
      void renew();
    }
  }, [status.data?.sessionValid]);

  const wo = status.data?.workOrder ?? null;
  // No-voice fallback for rehearsal or if voice fails on stage: open /?test=1 (server must allow ALLOW_TEST_REPORT).
  const showTestReport = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("test");
  const [testError, setTestError] = useState<string | null>(null);
  return (
    <main className="wrap narrow">
      <h1>Relay</h1>
      <p className="muted">Relay is an AI assistant for residence maintenance. Tap below and tell it what's wrong.</p>

      {error && (
        <div className="card">
          <p className="err">{error}</p>
          <button onClick={renew}>Try again</button>
        </div>
      )}
      {sessionId && <VoicePanel sessionId={sessionId} />}
      {sessionId && showTestReport && !wo && (
        <section className="card">
          <p className="muted">No voice? Send DEMO.md's washer report as a labelled test report.</p>
          <button
            onClick={async () => {
              setTestError(null);
              try {
                await submitTestReport({ sessionId });
              } catch (e) {
                setTestError(e instanceof Error ? e.message : "Could not send the test report.");
              }
            }}
          >
            Send test report (no voice)
          </button>
          {testError && <p className="err">{testError}</p>}
        </section>
      )}

      <section className="card" aria-live="polite">
        <h2>Latest update</h2>
        {!wo && <p className="muted">No report yet. Your updates will appear here.</p>}
        {wo && (
          <>
            <p className="headline">{wo.latest?.message ?? "Your report is saved."}</p>
            <p className="muted">
              Work order #{wo.number} · {wo.location}
            </p>
            {wo.safetyHazard && <p className="err">Stay away from the machine. Residence staff have been alerted.</p>}
          </>
        )}
      </section>

      {wo && (
        <>
          <section className="card">
            <h2>Your clothes</h2>
            <p className="headline">{wo.staffLabel}</p>
          </section>
          <section className="card">
            <div className="row between">
              <h2>Washer repair</h2>
              {(wo.repairStatus === "CONFIRMED" || wo.repairStatus === "OPTIONS_PENDING") && <span className="pill sim">simulated</span>}
            </div>
            <p className="headline">{wo.repairLabel}</p>
            {wo.recommendation && <p className="muted">{wo.recommendation}</p>}
            {wo.appointment && (
              <p>
                <strong>{wo.appointment.contractorName}</strong> · {wo.appointment.arrivalWindow} <span className="pill sim">simulated</span>
              </p>
            )}
          </section>
          <section className="card">
            <h2>All updates</h2>
            <ul className="timeline">
              {wo.updates.map((u, i) => (
                <li key={i}>
                  <time>{new Date(u.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                  <span>{u.message}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
