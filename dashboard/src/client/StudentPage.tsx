import { useEffect, useState } from "react";
import { createDemoSession, getStudentStatus, submitTestReport, useQuery } from "wasp/client/operations";
import type { StudentStatus } from "../shared/relayTypes";
import { VoicePanel } from "./VoicePanel";
import "./relay.css";

type Request = NonNullable<StudentStatus["workOrder"]>;

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
export const woCode = (n: number) => `WO-${String(n).padStart(4, "0")}`;

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

  const fallback =
    sessionId && showTestReport && !wo ? (
      <>
        <button
          className="btn quiet"
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
      </>
    ) : null;

  return (
    <main className="student">
      <div className="phone">
        <header className="s-head">
          <div className="s-brand">Relay</div>
          <p className="s-sub">AI assistant for residence maintenance</p>
        </header>
        {error && (
          <div className="s-foot">
            <p className="err">{error}</p>
            <button className="btn" onClick={renew}>
              Try again
            </button>
          </div>
        )}
        {sessionId ? (
          <VoicePanel sessionId={sessionId} hasRequest={!!wo} savedLabel={wo ? `Report saved · ${woCode(wo.number)}` : null} footerExtra={fallback}>
            {wo ? <RequestView wo={wo} /> : <Intro />}
          </VoicePanel>
        ) : (
          <div className="s-body">{!error && <p className="s-intro">Starting…</p>}</div>
        )}
      </div>
    </main>
  );
}

function Intro() {
  return (
    <div className="s-intro">
      <strong>Something broken in residence?</strong>
      Tap the button and tell Relay what's wrong. It saves your report, asks staff to help, and posts updates on this page.
    </div>
  );
}

/** The headline follows what matters most to the student right now. Staff help and the repair are separate tracks. */
function headline(wo: Request): { text: string; danger?: boolean } {
  if (wo.safetyHazard) return { text: "Stay away from the machine.", danger: true };
  if (wo.repairStatus === "CONFIRMED") return { text: "Repair booked." };
  if (wo.staffStatus === "RETRIEVED") return { text: "Your clothes are back." };
  if (wo.staffStatus === "ACCEPTED") return { text: "Help is on the way." };
  if (wo.staffStatus === "UNAVAILABLE") return { text: "We're arranging help." };
  return { text: "We're on it." };
}

const REPAIR_WORD: Record<string, { text: string; tone: "pending" | "ok" | "bad" }> = {
  OPTIONS_PENDING: { text: "Pending", tone: "pending" },
  RECOMMENDED: { text: "Awaiting manager approval", tone: "pending" },
  PENDING_APPROVAL: { text: "Awaiting manager approval", tone: "pending" },
  CONFIRMATION_PENDING: { text: "Approved · confirming", tone: "pending" },
  CONFIRMED: { text: "Booked", tone: "ok" },
  DENIED: { text: "Not approved", tone: "bad" },
  ESCALATED: { text: "Paused · safety first", tone: "bad" },
};

function updateKind(message: string) {
  if (/stay away|safety/i.test(message)) return "alert";
  if (/retrieved|arriving|approved the repair/i.test(message)) return "done";
  if (/staff|clothes/i.test(message)) return "staff";
  if (/repair|recommend|manager|option/i.test(message)) return "repair";
  return "";
}
/** Keeps cards short: the recommendation's first sentence, and "(simulated)" becomes a chip. */
function present(message: string) {
  const simulated = /\(simulated\)/i.test(message);
  let text = message.replace(/\s*\(simulated\)\.?/gi, "").trim();
  if (/^Relay recommends/.test(text)) text = text.split(/(?<=\.)\s/)[0];
  return { text, simulated };
}

function RequestView({ wo }: { wo: Request }) {
  const h = headline(wo);
  const [residence, room, machine] = wo.location.split(" · ");
  const repair = REPAIR_WORD[wo.repairStatus] ?? { text: wo.repairStatus, tone: "pending" as const };
  return (
    <>
      <p className="label req-kicker">Your request · {woCode(wo.number)}</p>
      <h1 className={`req-headline ${h.danger ? "danger" : ""}`}>{h.text}</h1>
      <p className="req-where">{machine && room ? `${machine} · ${residence} ${room}` : wo.location}</p>
      <ul className="updates" aria-live="polite">
        {wo.updates.map((u, i) => {
          const p = present(u.message);
          return (
            <li key={`${u.at}-${i}`} className={`update ${updateKind(u.message)}`}>
              <time>{new Date(u.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
              <p>{p.text}</p>
              {p.simulated && <span className="chip purple">Simulated</span>}
            </li>
          );
        })}
      </ul>
      <div className="req-foot">
        Repair: <b className={repair.tone}>{repair.text}</b>
        {wo.repairStatus === "CONFIRMED" && <span className="chip purple">Simulated</span>}
      </div>
    </>
  );
}
