// Voice intake with the ElevenLabs agent. The browser gets a short-lived token from our server (the API key stays
// there). The agent files the report through a client tool, which calls our authenticated submitVoiceReport action
// as the signed-in resident, so the report goes through exactly the same checks as every other channel.
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { Mic, PhoneOff } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { startVoiceIntake, submitVoiceReport } from "wasp/client/operations";
import { errorText, requestId } from "../../lib";
import { Button, Notice, Panel } from "../../ui";

type Line = { role: "user" | "agent"; text: string };
const clean = (s: string) => s.replace(/\[[^\]\n]{1,24}\]\s*/g, "").replace(/\s+/g, " ").trim();

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
  const [filed, setFiled] = useState<{ caseId: string; message: string } | null>(null);
  const attempt = useRef(requestId());
  const conversation = useConversation({
    onError: (m: string) => setError(m || "The voice connection failed."),
    onMessage: (m: { message: string; role?: "user" | "agent"; source?: "user" | "ai" }) => {
      const text = clean(m.message ?? "");
      if (text && !/^[.\s…]+$/.test(text)) setLines((p) => [...p, { role: m.role ?? (m.source === "ai" ? "agent" : "user"), text }]);
    },
    clientTools: {
      // Called by the voice agent. The server decides whether the report is saved; its message is what the agent says.
      submit_report: async (params: Record<string, unknown>) => {
        try {
          const r = await submitVoiceReport({ ...params, unitId, clientRequestId: attempt.current });
          setFiled({ caseId: r.caseId, message: r.message });
          return `ok: true. ${r.message}`;
        } catch (e) {
          return `ok: false. The report was NOT saved: ${errorText(e)} Tell the resident it was not saved and suggest the form.`;
        }
      },
    },
  });
  const status = preparing ? "connecting" : conversation.status;
  const live = status === "connected";

  async function start() {
    setError(null);
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
      <div className="mt-4 flex items-center gap-3">
        {live ? (
          <Button variant="danger" onClick={() => conversation.endSession()}>
            <PhoneOff /> End call
          </Button>
        ) : (
          <Button variant="move" busy={status === "connecting"} onClick={start}>
            <Mic /> Start talking
          </Button>
        )}
        <span className="text-sm text-muted">{live ? (conversation.isSpeaking ? "Relay is speaking" : "Listening") : status === "connecting" ? "Connecting" : "Not connected"}</span>
      </div>
    </Panel>
  );
}
