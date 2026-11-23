// "Relay: from request to resolution", scene by scene: what the narrator says and what is on screen. The narration is
// written from what the captures actually recorded (facts.json of capture-product.mjs and capture-fiber.mjs): where
// the model's behaviour or the Fiber result can differ from run to run, the sentence follows what happened in this
// recording. "|" marks a short pause.

const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
const words = (n) => ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"][n] ?? String(n);

const NAMES = { sam: "Sam", jo: "Jo" };
const crew = (f) => ({ who: NAMES[f.contractor] ?? "The contractor", firm: f.vendorName ?? "an approved plumber", other: NAMES[f.otherContractor] ?? "Another contractor" });

export function productNarration(f, fiber) {
  const d = fiber.discovery ?? {};
  const c = crew(f);
  const proposal = f.acceptedAiProposal
    ? `Relay proposed ${c.firm}, an approved plumber. Autopilot is off at this property, so the offer waits for Morgan, who reviews it and sends it.`
    : `This time Relay left the choice to Morgan, who offers the job to ${c.firm}, an approved plumber.`;
  const alsoEscalate = f.escalationSuggested ? " It also suggested escalating. The safety rules found no hazard in Priya's words, so that stays a suggestion for Morgan to decide." : "";
  const live = fiber.reused
    ? `These are real results from an earlier live Fiber AI search, reused at no cost: ${words(d.placesReturned)} local businesses came back, and Relay kept the best ${words(d.candidatesKept)}.`
    : `This is a live call to Fiber AI. ${cap(words(d.placesReturned))} real local businesses came back, Relay kept the best ${words(d.candidatesKept)}, and the provider's charge, ${words(d.creditsCharged)} credits, is recorded exactly as returned.`;
  const vague = f.vagueFiled
    ? "When a request is unclear, Relay files it for a person to classify instead of guessing a diagnosis."
    : "When a request is unclear, Relay asks what is going on, instead of guessing a diagnosis.";
  const reopened = /REOPEN/i.test(f.notFixed?.status ?? "") ? "the case reopens for Morgan to follow up." : "it goes back to Morgan to follow up.";
  const failedMail = (f.final?.followUps ?? []).some((x) => x.channel === "EMAIL" && x.status === "FAILED");
  const log = failedMail
    ? " | The follow-up log shows each message's real delivery state. The local test mail server was briefly unreachable during this recording, so some emails are marked failed, not delivered."
    : " | The follow-up log shows each message's real delivery state.";
  return [
    { id: "p00-intro", text: "Residents report problems. Property managers coordinate staff, contractors, approvals and follow-ups. | Relay brings that process into one AI-powered workflow. | This is the manager's command center: what needs a person, and why." },
    { id: "p01-chat", text: "Priya, a resident, reports a leak from a phone, in plain words. This is the text chat. Voice intake uses the same path, but it isn't shown here. | Relay's replies come from a local language model, running as a background job. Its thinking time is cut from the recording, and marked. | It asks what it needs, then files. The case is saved by the server, and the confirmation comes from the database, not from the model." },
    { id: "p02-workspace", text: `Morgan, the property manager, sees Priya's new case at the top of the queue, and opens it. | The case workspace shows what Priya reported, and what Relay understood from it, with its assumptions kept apart from what Priya actually said. | "What Relay did" lists the coordinator's real tool calls, and what policy did with each one.${alsoEscalate} | ${proposal}` },
    { id: "p03-fiber", text: `Separately, an air-conditioning report came in from the same building, where no heating and cooling contractor is approved. | Relay spots the gap. At this building it asks before spending anything, so Morgan approves one search. | ${live} | Discovery is not approval. Nobody has checked a licence or insurance, and Relay never contacts these businesses. Morgan only shortlists one, to check personally.` },
    { id: "p04-accept", text: `Back to the leak. ${c.who}, from ${c.firm}, a fictional test contractor, gets the offer by phone. | ${c.who} reads the request, accepts the job with an estimate of three hundred and twenty dollars, and proposes two visit times.` },
    { id: "p05-approve", text: "Three hundred and twenty dollars is over this building's approval threshold, so the money decision goes to Morgan, never to the AI. | Morgan approves it, with a cap of three hundred and fifty dollars. The next step now belongs to Priya." },
    { id: "p06-time", text: "Priya sees the proposed times, and picks one. The visit is confirmed." },
    { id: "p07-complete", text: `${c.who} starts the work, and reports exactly what was done.` },
    { id: "p08-followup", text: "But finished work isn't the same as a solved problem. Relay asks Priya whether it's really fixed, in the app," },
    { id: "p09-email", text: "and by email. This is Mailpit, a local test inbox. Relay records this email as captured by a test server, never as delivered." },
    { id: "p10-confirm", text: "Priya confirms it's fixed, and the case is resolved." },
    { id: "p11-notfixed", text: `A repair that doesn't hold is handled too. Daniel's dishwasher was repaired, but it stopped again. Daniel says so, and ${reopened}` },
    { id: "p12-vague", text: vague },
    { id: "p13-safety", text: "Possible emergencies and lockouts always go to a person. Water near a light fixture is escalated at once, and a lockout waits for staff to check identity. | The safety rules are a net, not a guarantee. In a held-out test, the system escalated eleven of thirteen emergencies, which is why anything uncertain goes to a person." },
    { id: "p14-guard", text: `And access is enforced by the server: ${c.other}, from another firm, can't open this job.` },
    { id: "p15-final", text: `Back in Morgan's workspace: one report, one coordinated workflow, three people acting on the same case, every step recorded, a follow-up, and a verified outcome.${log}` },
    { id: "p16-end", text: "Relay. From resident request to accountable resolution." },
  ];
}

/** The video, in order. Phone scenes say who is on screen beside the phone; desktop scenes carry a label. */
export function productScenes(f, fiber) {
  const person = (name, role, note) => ({ name, role, note });
  const c = crew(f);
  const otherFirm = f.otherContractor === "sam" ? "Northside Plumbing" : "Harbour Plumbing";
  return [
    { kind: "scene", dir: "00-intro", device: "desktop", label: "Morgan · property manager · command center", narration: "p00-intro", title: { text: "Relay", sub: "From request to resolution", from: 0.2, to: 7 } },
    { kind: "scene", dir: "01-resident-chat", device: "phone", side: person("Priya", "Resident · Maple Court, 4B", "Reports a leak by text chat with Relay's AI"), narration: "p01-chat" },
    { kind: "scene", dir: "02-manager-workspace", device: "desktop", label: "Morgan · property manager", narration: "p02-workspace" },
    { kind: "scene", dir: "03-fiber", device: "desktop", label: fiber.reused ? "Fiber AI · real businesses, from an earlier live search (no new call)" : "Fiber AI · live search · real local businesses", narration: "p03-fiber" },
    { kind: "scene", dir: "04-contractor-accepts", device: "phone", side: person(c.who, `Contractor · ${c.firm}`, "A fictional test contractor, approved here. Reviews, accepts, estimates, proposes times"), narration: "p04-accept" },
    { kind: "scene", dir: "05-manager-approves", device: "desktop", label: "Morgan · spending approval", narration: "p05-approve" },
    { kind: "scene", dir: "06-resident-time", device: "phone", side: person("Priya", "Resident", "Chooses a visit time"), narration: "p06-time" },
    { kind: "scene", dir: "07-contractor-completes", device: "phone", side: person(c.who, "Contractor", "Starts the work and reports it complete"), narration: "p07-complete" },
    { kind: "scene", dir: "08-resident-followup", device: "phone", side: person("Priya", "Resident", "Asked whether it is really fixed"), narration: "p08-followup" },
    { kind: "scene", dir: "09-mailpit", device: "desktop", label: "Mailpit · local SMTP test inbox · captured, not delivered", narration: "p09-email" },
    { kind: "scene", dir: "10-resident-confirms", device: "phone", side: person("Priya", "Resident", "Confirms the fix"), narration: "p10-confirm" },
    { kind: "scene", dir: "11-not-fixed", device: "phone", side: person("Daniel", "Resident · Maple Court, 2B", "A separate repair that did not hold"), narration: "p11-notfixed" },
    { kind: "scene", dir: "12-vague", device: "phone", side: person("Noor", "Resident · Birch House", "An unclear request"), narration: "p12-vague" },
    { kind: "scene", dir: "13-safety", device: "desktop", label: "Morgan · a possible emergency and a lockout", narration: "p13-safety" },
    { kind: "scene", dir: "14-guard", device: "phone", side: person(c.other, `Contractor · ${otherFirm}`, "Tries to open a job offered to another firm"), narration: "p14-guard" },
    { kind: "scene", dir: "15-final", device: "desktop", label: "Morgan · the record of the case", narration: "p15-final" },
    { kind: "card", image: "cards/end.png", narration: "p16-end", minSeconds: 6, quiet: true },
  ];
}
