// Server-issued ElevenLabs credential for the resident's browser voice session. The API key never leaves the
// server. Voice is an enhancement: when it is not configured or ElevenLabs refuses (bad key, used-up allowance),
// the caller gets a clear error and the text form keeps working.
import { HttpError } from "wasp/server";
import type { VoiceCredential } from "../shared/views";
import type { ActorCtx } from "./cases/engine";
import { traced } from "./tracing";

const API = "https://api.elevenlabs.io/v1/convai/conversation";
const agentId = () => process.env.EL_AGENT_INTAKE_ID || "";
export const voiceConfigured = () => Boolean(process.env.ELEVENLABS_API_KEY && agentId());

export function voiceCredential(_actor: ActorCtx): Promise<VoiceCredential> {
  return traced("relay.voice_session.create", {}, async () => {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key || !agentId()) {
      throw new HttpError(503, "Voice intake is not set up on this server. Use the form instead.", { code: "voice_not_configured" });
    }
    let res: Response;
    try {
      res = await fetch(`${API}/token?agent_id=${encodeURIComponent(agentId())}`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new HttpError(502, "The voice service could not be reached. Use the form instead.", { code: "voice_unreachable" });
    }
    if (!res.ok) {
      const why = res.status === 401 || res.status === 403 ? "The voice service rejected this server's key." : res.status === 429 || res.status === 402 ? "The voice allowance is used up." : `The voice service returned ${res.status}.`;
      throw new HttpError(502, `${why} Use the form instead.`, { code: "voice_unavailable", upstreamStatus: res.status });
    }
    const body = (await res.json().catch(() => ({}))) as { token?: string };
    if (!body.token) throw new HttpError(502, "The voice service did not return a session. Use the form instead.", { code: "voice_unavailable" });
    return { connectionType: "webrtc", conversationToken: body.token, signedUrl: null };
  });
}
