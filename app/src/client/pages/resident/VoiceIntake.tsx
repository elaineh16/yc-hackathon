// Voice intake with the ElevenLabs agent. The browser gets a short-lived token from our server (the API key stays
// there). The agent files the report through a client tool, which calls our authenticated submitVoiceReport action
// as the signed-in resident, so the report goes through exactly the same checks as every other channel.
//
// The call itself runs between this browser and ElevenLabs, so the browser also forwards it to Relay as it happens
// (recordVoiceEvent: connected, each line of the transcript, ended). That keeps what the resident said even if the
// call drops before the agent files anything, and puts it under the same safety net as a chat: a possible emergency
// in the resident's words is filed at once by Relay's rules, and a call that ends with nothing filed goes to a person.
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { Mic, PhoneOff } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { recordVoiceEvent, startVoiceIntake, submitVoiceReport } from "wasp/client/operations";
import { errorText, requestId } from "../../lib";
import { Button, Notice, Panel } from "../../ui";

type Line = { role: "user" | "agent"; text: string };
type Filed = { caseId: string; message: string };
const clean = (s: string) => s.replace(/\[[^\]\n]{1,24}\]\s*/g, "").replace(/\s+/g, " ").trim();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function VoiceIntake({ unitId }: { unitId: string }) {
  return (
    <ConversationProvider>
      <Voice unitId={unitId} />
    </ConversationProvider>
  );
}

function Voice({ unitId }: { unitId: string }) {
  const navigate = useNavigate();
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [filed, setFiled] = useState<Filed | null>(null);
  const [passed, setPassed] = useState(false);
  // One id per report: the call's record in Relay, and the request id its submit_report sends, so whoever files first
  // (the agent or the safety rules) there is one case. A call that ended with nothing filed keeps the id, so calling
  // back continues the same report; after a filing, the next call is a new report.
  const attempt = useRef(requestId());
  const filedRef = useRef(false);
  // Everything sent to Relay about the call goes one at a time, in order: a line is recorded before the next, and the
  // end of the call is never processed before a filing the agent asked for just before it.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const serial = <T,>(task: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(task, task);
    queue.current = next.catch(() => undefined);
    return next;
  };
  const markFiled = (f: Filed) => {
    filedRef.current = true;
    setPassed(false);
    setFiled((prev) => prev ?? f);
  };
  const record = (kind: "connected" | "resident" | "relay" | "ended", extra: { text?: string; callId?: string } = {}) => {
    const attemptId = attempt.current;
    void serial(async () => {
      for (let i = 0; i < 3; i++) {
        try {
          const r = await recordVoiceEvent({ unitId, attemptId, kind, ...extra });
          if (r.filed) markFiled({ caseId: r.filed.caseId, message: r.filed.message });
          else if (kind === "ended" && r.passed) setPassed(true);
          return;
        } catch (e) {
          if (i === 2) console.warn("[voice] Relay did not record this part of the call:", errorText(e));
          else await wait(800 * (i + 1));
        }
      }
    });
  };

  const conversation = useConversation({
    onConnect: ({ conversationId }: { conversationId: string }) => record("connected", { callId: conversationId }),
    onDisconnect: () => record("ended"),
    onError: (m: string) => setError(m || "The voice connection failed."),
    onMessage: (m: { message: string; role?: "user" | "agent"; source?: "user" | "ai" }) => {
      const text = clean(m.message ?? "");
      if (!text || /^[.\s…]+$/.test(text)) return;
      const role = m.role ?? (m.source === "ai" ? "agent" : "user");
      setLines((p) => [...p, { role, text }]);
      record(role === "user" ? "resident" : "relay", { text });
    },
    clientTools: {
      // Called by the voice agent. The server decides whether the report is saved; its message is what the agent says.
      submit_report: (params: Record<string, unknown>) =>
        serial(async () => {
          try {
            const r = await submitVoiceReport({ ...params, unitId, clientRequestId: attempt.current });
            markFiled({ caseId: r.caseId, message: r.message });
            return `ok: true. ${r.message}`;
          } catch (e) {
            return `ok: false. The report was NOT saved: ${errorText(e)} Tell the resident it was not saved and suggest the form.`;
          }
        }),
    },
  });
  const status = preparing ? "connecting" : conversation.status;
  const live = status === "connected";

  async function start() {
    setError(null);
    setPassed(false);
    if (filedRef.current) {
      attempt.current = requestId();
      filedRef.current = false;
      setFiled(null);
      setLines([]);
    }
    setPreparing(true);
    try {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
      } catch {
        setError("Relay needs your microphone. Allow microphone access, or use the chat or form instead.");
        return;
      }
      const cred = await startVoiceIntake({ unitId });
      if (!cred.conversationToken) throw new Error("No voice session was issued.");
      conversation.startSession({ conversationToken: cred.conversationToken, connectionType: "webrtc", dynamicVariables: cred.dynamicVariables });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPreparing(false);
    }
  }

  return (
    <Panel className="p-4">
      <div className="max-h-[50dvh] min-h-40 space-y-2 overflow-y-auto" aria-live="polite">
        {lines.length === 0 && <p className="text-sm text-muted">Tap Start and describe the problem. Relay will ask what it needs and file the report.</p>}
        {lines.map((l, i) => (
          <p key={i} className={l.role === "user" ? "ml-auto max-w-[85%] rounded-lg bg-ink px-3 py-2 text-sm text-white" : "max-w-[85%] rounded-lg bg-sunk px-3 py-2 text-sm"}>
            {l.text}
          </p>
        ))}
      </div>
      {error && <Notice tone="danger" className="mt-3">{error}</Notice>}
      {filed && (
        <Notice tone="ok" className="mt-3">
          {filed.message}{" "}
          <button className="underline" onClick={() => navigate(`/my/cases/${filed.caseId}`)}>
            Follow it
          </button>
        </Notice>
      )}
      {passed && !filed && !live && (
        <Notice tone="warn" className="mt-3">
          The call ended before a report was filed. What you said is saved, and it has been passed to your property manager so a person reads it. You can call again, or use the chat or the form.
        </Notice>
      )}
      <div className="mt-4 flex items-center gap-3">
        {live ? (
          <Button variant="danger" onClick={() => conversation.endSession()}>
            <PhoneOff /> End call
          </Button>
        ) : (
          <Button variant="move" busy={status === "connecting"} onClick={start}>
            <Mic /> {passed && !filed ? "Call again" : "Start talking"}
          </Button>
        )}
        <span className="text-sm text-muted">{live ? (conversation.isSpeaking ? "Relay is speaking" : "Listening") : status === "connecting" ? "Connecting" : "Not connected"}</span>
      </div>
    </Panel>
  );
}
