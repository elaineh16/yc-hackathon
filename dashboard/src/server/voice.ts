// Server-issued ElevenLabs credential for the student's browser voice session. The API key never leaves the server.
import { HttpError } from "wasp/server";
import type { VoiceSessionCredential } from "../shared/relayTypes.js";
import { requireSession } from "./relay/service.js";

const API = "https://api.elevenlabs.io/v1/convai/conversation";

export const startVoiceSession = async (
  args: { sessionId: string; connectionType?: "webrtc" | "websocket" },
  _ctx: unknown,
): Promise<VoiceSessionCredential> => {
  const key = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.EL_AGENT_INTAKE_ID || process.env.ELEVENLABS_AGENT_ID;
  if (!key || !agentId) throw new HttpError(503, "Voice is not configured on the server yet.");
  if (!(await requireSession(args?.sessionId))) throw new HttpError(404, "This session has expired. Reload the page.");

  const connectionType = args.connectionType === "websocket" ? "websocket" : "webrtc";
  const url =
    connectionType === "webrtc"
      ? `${API}/token?agent_id=${encodeURIComponent(agentId)}`
      : `${API}/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
  let body: { token?: string; signed_url?: string };
  try {
    const r = await fetch(url, { headers: { "xi-api-key": key } });
    if (!r.ok) throw new HttpError(502, `ElevenLabs refused the session (${r.status}).`);
    body = (await r.json()) as typeof body;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "Could not reach ElevenLabs. Try again.");
  }
  return {
    connectionType,
    conversationToken: body.token ?? null,
    signedUrl: body.signed_url ?? null,
    agentId,
    dynamicVariables: { demo_session_id: args.sessionId },
  };
};
