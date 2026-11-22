# ElevenLabs agents (owner: Person 1 — Voice)

Three agents, one shared voice. Create each in the ElevenLabs dashboard (Agents → New agent), paste the
system prompt and first message from the files here, and add the server tools listed below.

| Agent | File | Phone number | Env var for its id |
| --- | --- | --- | --- |
| Intake (inbound) | `intake.md` | Assign the imported number to this agent for inbound calls | `ELEVENLABS_INTAKE_AGENT_ID` |
| Dispatch (outbound to contractors) | `dispatch.md` | Outbound via API | `ELEVENLABS_DISPATCH_AGENT_ID` |
| Confirm (outbound to tenant) | `confirm.md` | Outbound via API | `ELEVENLABS_CONFIRM_AGENT_ID` |

## Setup order

1. Import the Twilio number into ElevenLabs (Agents → Phone Numbers). Copy its **phone number id** into
   `ELEVENLABS_PHONE_NUMBER_ID`.
2. Create the Intake agent and assign the number to it. Call it. It should talk before any tools exist.
3. Get the backend's public URL from Person 2 (Maritime deploy or a tunnel), then add the tools.
4. Turn on the post-call webhook (workspace settings → Webhooks → post-call transcription) pointing at
   `{PUBLIC_URL}/webhooks/post-call`.
5. Create Dispatch and Confirm agents. Test with `npm run dev` on the backend with real keys in `.env`.

## Dynamic variables

The backend passes ticket details to outbound agents as dynamic variables. Use them as `{{name}}` in prompts,
first messages and tool body values:

`building_name, address, ticket_id, tenant_name, unit, category, urgency, summary, location, access_windows`
plus `contractor_id, contractor_name, max_budget` (Dispatch) and `contractor_name, slot, quote` (Confirm).

ElevenLabs also provides system variables such as `{{system__caller_id}}` and `{{system__conversation_id}}`
(check the exact names in the docs). Use them in the Intake tools so the backend knows who is calling.

## Server tools (Webhook tools, method POST)

Base URL: `{PUBLIC_URL}/tools/`. Body params are JSON. "LLM" = the agent fills it from the conversation;
"var" = set the value to a dynamic variable.

### Intake agent
| Tool | URL | Body params |
| --- | --- | --- |
| `lookup_tenant` | `/tools/lookup_tenant` | `caller_phone` (var: `{{system__caller_id}}`) |
| `create_ticket` | `/tools/create_ticket` | `caller_phone` (var), `conversation_id` (var: `{{system__conversation_id}}`), `tenant_name` (LLM), `unit` (LLM), `category` (LLM, enum: plumbing, electrical, hvac, appliance, locks, general), `urgency` (LLM, enum: emergency, urgent, routine), `summary` (LLM, one sentence), `location` (LLM), `access_windows` (LLM) |
| `escalate_emergency` | `/tools/escalate_emergency` | `caller_phone` (var), `reason` (LLM), `category` (LLM), `ticket_id` (LLM, optional) |

### Dispatch agent
| Tool | URL | Body params |
| --- | --- | --- |
| `record_contractor_response` | `/tools/record_contractor_response` | `ticket_id` (var), `contractor_id` (var), `accepted` (LLM, boolean), `slot` (LLM), `quote` (LLM), `notes` (LLM) |

### Confirm agent
| Tool | URL | Body params |
| --- | --- | --- |
| `confirm_booking` | `/tools/confirm_booking` | `ticket_id` (var), `confirmed` (LLM, boolean), `notes` (LLM) |

`get_ticket` (`ticket_id`) is available to any agent if it needs fresh details mid-call.
