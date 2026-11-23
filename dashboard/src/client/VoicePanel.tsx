import { type ReactNode, useEffect, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { startVoiceSession } from "wasp/client/operations";

type Line = { id: number; role: "user" | "agent"; text: string };

type Props = {
  sessionId: string;
  /** A report already exists for this session: the talk button becomes a quiet secondary action. */
  hasRequest: boolean;
  /** Shown in the call view once the report is saved, e.g. "Report saved · WO-0026". */
  savedLabel: string | null;
  /** Extra footer content (the labelled no-voice fallback). */
  footerExtra?: ReactNode;
  /** What to show when no call is in progress. */
  children: ReactNode;
};

/** Live, full-duplex ElevenLabs browser session. The server issues the credential; the API key never reaches the browser. */
export function VoicePanel(props: Props) {
  return (
    <ConversationProvider>
      <Voice {...props} />
    </ConversationProvider>
  );
}

const BARS = 30;
/** Voice-style tags such as "[happy]" steer the speech model and are not spoken: keep them out of the transcript. */
const clean = (s: string) => s.replace(/\[[^\]\n]{1,24}\]\s*/g, "").replace(/\s+/g, " ").trim();

function Voice({ sessionId, hasRequest, savedLabel, footerExtra, children }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const nextId = useRef(1);
  const chatRef = useRef<HTMLDivElement>(null);

  const conversation = useConversation({
    onError: (message: string) => setError(message || "The voice connection failed. Tap Talk to Relay to try again."),
    onMessage: (m: { message: string; role?: "user" | "agent"; source?: "user" | "ai" }) => {
      const text = clean(m.message ?? "");
      if (!text || /^[.\s…]+$/.test(text)) return; // silence or noise
      const role = m.role ?? (m.source === "ai" ? "agent" : "user");
      setLines((prev) => (prev.at(-1)?.role === role && prev.at(-1)?.text === text ? prev : [...prev, { id: nextId.current++, role, text }]));
    },
  });
  const status = preparing ? "connecting" : conversation.status;
  const live = status === "connected";
  const inCall = live || status === "connecting";

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [lines.length, savedLabel]);

  async function start() {
    setError(null);
    setLines([]);
    setPreparing(true);
    try {
      // Ask for the mic first so a denial shows a clear, retryable message instead of a silent failure.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        setError("Relay needs your microphone. Allow microphone access in your browser, then tap Talk to Relay again.");
        return;
      }
      const cred = await startVoiceSession({ sessionId, connectionType: "webrtc" });
      if (cred.conversationToken) {
        conversation.startSession({ conversationToken: cred.conversationToken, connectionType: "webrtc", dynamicVariables: cred.dynamicVariables });
      } else if (cred.signedUrl) {
        conversation.startSession({ signedUrl: cred.signedUrl, connectionType: "websocket", dynamicVariables: cred.dynamicVariables });
      } else {
        setError("The server did not return a voice credential. Try again.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the voice session. Try again.");
    } finally {
      setPreparing(false);
    }
  }

  const statusText = live ? (conversation.isSpeaking ? "Connected · Relay is speaking" : "Connected · listening") : status === "connecting" ? "Connecting…" : "Not connected";

  return (
    <>
      <div className="s-body">
        {inCall ? (
          <>
            <Waveform conversation={conversation} live={live} />
            <p className="wave-caption">{live ? (conversation.isSpeaking ? "Relay is speaking" : "Listening…") : "Connecting…"}</p>
            <div className="chat" ref={chatRef} aria-live="polite">
              {lines.map((l) =>
                l.role === "user" ? (
                  <div key={l.id} className="bubble user">
                    {l.text}
                  </div>
                ) : (
                  <div key={l.id} className="bubble agent">
                    <span className="label">Relay</span>
                    {l.text}
                  </div>
                ),
              )}
              {savedLabel && <span className="chip green saved-note">✓ {savedLabel}</span>}
            </div>
          </>
        ) : (
          children
        )}
      </div>

      <div className="s-foot">
        {error && <p className="err">{error}</p>}
        {!inCall && footerExtra}
        <div className={`s-status ${live ? "live" : status === "connecting" ? "wait" : ""}`}>
          <i />
          <span>{statusText}</span>
        </div>
        {live ? (
          <button className="btn danger big" onClick={() => conversation.endSession()}>
            End conversation
          </button>
        ) : (
          <button className={hasRequest ? "btn quiet" : "btn primary big"} disabled={status === "connecting"} onClick={start}>
            <MicIcon />
            {status === "connecting" ? "Connecting…" : hasRequest ? "Talk to Relay again" : "Talk to Relay"}
          </button>
        )}
      </div>
    </>
  );
}

type Levels = { isSpeaking: boolean; getInputByteFrequencyData: () => Uint8Array; getOutputByteFrequencyData: () => Uint8Array };

/** Bars follow the real audio: Relay's voice while it speaks, the microphone while it listens. */
function Waveform({ conversation, live }: { conversation: Levels; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(conversation);
  latest.current = conversation;

  useEffect(() => {
    const bars = Array.from(ref.current?.children ?? []) as HTMLElement[];
    if (!live) {
      bars.forEach((b) => (b.style.transform = "scaleY(0.12)"));
      return;
    }
    let raf = 0;
    const tick = () => {
      let data: Uint8Array | undefined;
      try {
        const c = latest.current;
        data = c.isSpeaking ? c.getOutputByteFrequencyData() : c.getInputByteFrequencyData();
      } catch {
        data = undefined; // levels are decoration: never let them break the call
      }
      const usable = data ? Math.min(data.length, 48) : 0;
      for (let i = 0; i < bars.length; i++) {
        const level = usable ? data![Math.floor((i / bars.length) * usable)] / 255 : 0;
        const shape = 0.55 + 0.45 * Math.sin((Math.PI * i) / (bars.length - 1)); // taller in the middle
        bars[i].style.transform = `scaleY(${(0.12 + Math.min(1, level * 1.5) * 0.88 * shape).toFixed(3)})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [live]);

  return (
    <div className={`wave ${live ? "" : "idle"}`} ref={ref} aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
