// ElevenLabs outbound calls + webhook signature check.
// VERIFY against https://elevenlabs.io/docs before relying on it:
//   - outbound call endpoint path and body fields
//   - dynamic variables field name
//   - webhook signature header format
import crypto from "node:crypto";

const API = "https://api.elevenlabs.io/v1";

export const config = {
  apiKey: () => process.env.ELEVENLABS_API_KEY || "",
  phoneNumberId: () => process.env.ELEVENLABS_PHONE_NUMBER_ID || "",
  agents: {
    intake: () => process.env.ELEVENLABS_INTAKE_AGENT_ID || "",
    dispatch: () => process.env.ELEVENLABS_DISPATCH_AGENT_ID || "",
    confirm: () => process.env.ELEVENLABS_CONFIRM_AGENT_ID || "",
  },
};

export const isDryRun = () => !config.apiKey();

export interface OutboundResult {
  conversationId: string | null;
  callSid: string | null;
  dryRun: boolean;
}

/**
 * Place an outbound phone call with an ElevenLabs agent.
 * dynamicVariables fill {{placeholders}} in the agent's prompt, first message and tool bodies.
 */
export async function startOutboundCall(opts: {
  agentId: string;
  toNumber: string;
  dynamicVariables: Record<string, string | number>;
}): Promise<OutboundResult> {
  if (isDryRun()) {
    console.log(`[DRY RUN] would call ${opts.toNumber} with agent ${opts.agentId || "(unset)"}`, opts.dynamicVariables);
    return { conversationId: `dry_${Date.now()}`, callSid: null, dryRun: true };
  }

  const res = await fetch(`${API}/convai/twilio/outbound-call`, {
    method: "POST",
    headers: { "xi-api-key": config.apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: opts.agentId,
      agent_phone_number_id: config.phoneNumberId(),
      to_number: opts.toNumber,
      conversation_initiation_client_data: {
        dynamic_variables: opts.dynamicVariables,
      },
    }),
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`ElevenLabs outbound call failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return {
    conversationId: (body.conversation_id as string) ?? null,
    callSid: (body.callSid as string) ?? (body.call_sid as string) ?? null,
    dryRun: false,
  };
}

/** Header looks like "t=1700000000,v0=<hex hmac sha256 of `${t}.${rawBody}`>". */
export function verifyWebhook(rawBody: string, header: string | undefined): boolean {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return true; // verification off
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = parts.t;
  const sig = parts.v0;
  if (!t || !sig) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}
