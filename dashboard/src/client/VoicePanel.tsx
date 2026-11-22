import { useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { startVoiceSession } from "wasp/client/operations";

/** Live, full-duplex ElevenLabs browser session. The server issues the credential; the API key never reaches the browser. */
export function VoicePanel({ sessionId }: { sessionId: string }) {
  return (
    <ConversationProvider>
      <Voice sessionId={sessionId} />
    </ConversationProvider>
  );
}

function Voice({ sessionId }: { sessionId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const conversation = useConversation({
    onError: (message: string) => setError(message || "The voice connection failed. Try again."),
  });
  const status = preparing ? "connecting" : conversation.status;
  const live = status === "connected";

  async function start() {
    setError(null);
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

  return (
    <section className="card">
      <div className="row between">
        <span className="muted">
          <span className={`dot ${live ? "on" : status === "connecting" ? "wait" : ""}`} />
          {live ? (conversation.isSpeaking ? "Connected · Relay is speaking" : "Connected · listening") : status === "connecting" ? "Connecting…" : "Not connected"}
        </span>
      </div>
      {live ? (
        <button className="big" onClick={() => conversation.endSession()}>
          End call
        </button>
      ) : (
        <button className="big primary" disabled={status === "connecting"} onClick={start}>
          {status === "connecting" ? "Connecting…" : "Talk to Relay"}
        </button>
      )}
      {error && <p className="err">{error}</p>}
    </section>
  );
}
