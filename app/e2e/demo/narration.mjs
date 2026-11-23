// What the narrator says, scene by scene. It is written from what the capture actually recorded (facts.json):
// where the model's behaviour can differ from run to run, the sentence follows what happened in this recording.
// "|" marks a short pause.

export function productNarration(f) {
  const proposal = f.acceptedAiProposal
    ? "Here it proposed an approved plumber. Autopilot is off at this property, so the offer waited for Morgan, and she sends it."
    : "This time it left the choice to Morgan, who offers the job to an approved plumber.";
  const vague = f.vagueFiled
    ? "Even with a vague report, Relay filed it for a person to classify rather than guessing a trade."
    : "When a report is too vague, Relay asks a question instead of guessing.";
  return [
    { id: "p00-title", text: "Property managers get repair requests by phone, text and email. | Then they spend hours sorting them, finding the right contractor, getting approvals and chasing updates. | Relay is an AI operations coordinator for residential buildings. It turns each request into a tracked case, and coordinates it to a verified fix, with people in control of every decision that matters." },
    { id: "p01-chat", text: "This is the real resident portal, on a phone. Priya reports a leak in her own words, using the text chat. Voice uses the same path, but this recording uses text. | Her message is saved at once, and Relay replies from a background job running a local model. The model's thinking time is cut from the recording, and marked. | It asks what it needs. When it files, the server saves the case and writes the confirmation, not the model." },
    { id: "p02-workspace", text: `Morgan, the property manager, starts in the command center: what needs a person, and why. | On the case, Relay's reading keeps what Priya said apart from what it assumed, and the status, the next step and its reason are always explicit. | "What Relay did" lists the coordinator's actual tool calls, as recorded. ${proposal} | The model proposes. The backend decides.` },
    { id: "p03-discovery", text: "This air-conditioning case has no approved contractor at Maple Court, so Relay started a vendor search. | Discovery runs on Fiber AI. In this recording it is in fixture mode, with fictional businesses returned through the real SDK code path, because no Fiber key was available. | Each business is only a candidate. Morgan verifies it and approves it for this property, and only then can it be offered work. Relay never contacts it on its own." },
    { id: "p04-accept", text: "Sam, the plumber, gets the offer on his phone. He accepts with an estimate of three hundred and twenty dollars, and proposes visit times." },
    { id: "p05-approve", text: "That is over the property's approval threshold, so the money decision goes to Morgan, never to the AI. She approves it, with a cap." },
    { id: "p06-time", text: "Priya picks a time. The visit is confirmed only once everyone required has agreed." },
    { id: "p07-complete", text: "Sam starts the work and reports it complete. The same case, the same record, for all three people." },
    { id: "p08-followup", text: "Completion is not resolution. Priya gets an in-app notification asking whether it's fixed." },
    { id: "p09-email", text: "And an email. Here it is in the local test inbox, which Relay records as captured, never as delivered." },
    { id: "p10-confirm", text: "She confirms it's resolved." },
    { id: "p11-timeline", text: "The timeline records every step, labelled by who did it: the resident, Relay's AI, the system, the manager or the vendor. | The follow-up log shows each notification's real delivery state." },
    { id: "p12-vague", text: vague },
    { id: "p13-guard", text: "And the backend decides who sees what. Another plumber opening a job that isn't his gets nothing." },
    { id: "p14-end", text: "Relay version one point one: intake by chat, voice or form; a coordinator that proposes while policy decides; vendor discovery that never skips human verification; follow-ups that report delivery honestly; and a complete audit trail. | It ships with thirty-four unit tests, eighty-five API tests and sixteen browser tests running in continuous integration, and an AI evaluation with held-out sets, before and after. | The code, the evidence and the limitations are on GitHub." },
  ];
}

/** Scenes in order, matched to their narration. */
export const productScenes = [
  { kind: "card", image: "cards/title.png", narration: "p00-title" },
  { kind: "scene", dir: "01-resident-chat", device: "phone", label: "Priya · resident · phone", narration: "p01-chat" },
  { kind: "scene", dir: "02-manager-workspace", device: "desktop", label: "Morgan · property manager", narration: "p02-workspace" },
  { kind: "scene", dir: "03-discovery", device: "desktop", label: "Morgan · vendor discovery (fixture data)", narration: "p03-discovery" },
  { kind: "scene", dir: "04-contractor-accepts", device: "phone", label: "Sam · contractor · phone", narration: "p04-accept" },
  { kind: "scene", dir: "05-manager-approves", device: "desktop", label: "Morgan · property manager", narration: "p05-approve" },
  { kind: "scene", dir: "06-resident-time", device: "phone", label: "Priya · resident · phone", narration: "p06-time" },
  { kind: "scene", dir: "07-contractor-completes", device: "phone", label: "Sam · contractor · phone", narration: "p07-complete" },
  { kind: "scene", dir: "08-resident-followup", device: "phone", label: "Priya · resident · phone", narration: "p08-followup" },
  { kind: "scene", dir: "09-mailpit", device: "desktop", label: "Local test inbox (Mailpit)", narration: "p09-email" },
  { kind: "scene", dir: "10-resident-confirms", device: "phone", label: "Priya · resident · phone", narration: "p10-confirm" },
  { kind: "scene", dir: "11-timeline", device: "desktop", label: "Morgan · the audit trail", narration: "p11-timeline" },
  { kind: "scene", dir: "12-vague", device: "phone", label: "Priya · a vague report", narration: "p12-vague" },
  { kind: "scene", dir: "13-guard", device: "phone", label: "Jo · another contractor", narration: "p13-guard" },
  { kind: "card", image: "cards/end.png", narration: "p14-end", minSeconds: 6 },
];
