// Deterministic triage. No model is involved: every classification can be explained by the rule that produced it,
// and anything the rules cannot place confidently goes to a person. Conservative by design: a possible hazard is
// escalated to a manager, never dispatched as routine work.
import { CATEGORY_SHORT, type Category, type Severity } from "./domain";
import { type Details, optionLabel, QUESTIONS } from "./intake";

export type TriageInput = {
  description: string;
  /** The category the resident (or the voice agent) chose, if any. */
  categoryHint?: Category | null;
  details?: Details;
  title?: string | null;
};
export type TriageResult = {
  category: Category;
  severity: Severity;
  emergency: boolean;
  /** A person must look at it: unsupported category, uncertain classification, or an unanswered safety question. */
  needsReview: boolean;
  /** Plain-language reasons, shown to the manager. */
  reasons: string[];
  /** What the resident is told to do right now, when there may be danger. */
  safetyAdvice: string | null;
  title: string;
  summary: string;
};

type Hazard = {
  pattern: RegExp;
  reason: string;
  advice: string;
  /** The match is not a hazard in this context: `before`/`after` are up to 60 characters either side of it. */
  unless?: (match: string, before: string, after: string) => boolean;
  /** The whole report must also mention this (for rules that need two things together, like no heat and a baby). */
  requires?: RegExp;
  /** The whole report explains the match away (for example a burning-dust smell the first time the heat comes on). */
  unlessText?: (text: string) => boolean;
};

const NEGATION_INSIDE = /\b(no|not|isn'?t|aren'?t|wasn'?t|nowhere|never|without)\b/i;
// "before it floods", "it could catch fire": a worry about the future is not a report of a hazard happening now.
const HYPOTHETICAL_BEFORE = /\b(before it|before they|could|might|may|worried( that)?( it)?|afraid( that)?( it)?|in case( it)?|would|going to|gonna|or it will|so it doesn'?t|if it)\b[\w\s']{0,14}$/i;
const PERSON_AT_RISK = /\b(baby|babies|babys|baby's|infant|newborn|toddler|\d+[- ]?(month|week|year|yr)s?[- ]?old|little one|elderly|senior|grand(mother|father|ma|pa|parent)s?|pregnant|disabled|oxygen|unwell|sick|medical condition)\b/i;

const HAZARDS: Hazard[] = [
  {
    pattern: /\b(smell(s|ing)?( of| like)? gas|gas (smell|leak|odou?r)|rotten eggs?)\b/i,
    reason: "The report mentions a gas smell.",
    advice: "Leave the unit now. Do not use switches or flames. Call your gas utility's emergency line or 911 from outside.",
    unless: (m, before) => HYPOTHETICAL_BEFORE.test(before),
  },
  {
    // "smoke" alone, but not the name of the device: a chirping smoke detector is a battery, not a fire.
    pattern:
      /\b(fire(?! (alarm|detector|extinguisher|door|escape|exit|code|drill|department|hall|truck))|flames?|smoke(?! (detector|alarm))|smoking|smoulder\w*|smolder\w*|spark(s|ed|ing|y)?|burning smell|burn(ing|t) (plastic|rubber|wire|wires|wiring|electrical|electric)( smell)?|smells? (like |of )?(burn(ing|t)|smoke|melting|melted)|smell(s|ing)? (it|something|stuff|them|that) (burn(ing|t)|smoking|melting)|scorch(ed|ing)?|melt(ing|ed) (plastic|wire|cord|plug|outlet))\b/i,
    reason: "The report mentions fire, smoke, sparks or a burning smell.",
    advice: "If there is fire or smoke, get everyone out and call 911. Do not use the appliance or the outlet.",
    // The first heating of the season burns off dust: a "burnt dust" smell with no smoke, flames or sparks is not a fire.
    unlessText: (t) => /\b(burn(ed|t|ing)?( off)?( the)? dust|dust\w*( is| was)? burn\w*)\b/i.test(t) && !/\b(flames?|fire|sparks?|smoke|smoking)\b/i.test(t.replace(/\b(no|not|without|isn'?t|nothing|never)\b[\w\s',]{0,24}\b(flames?|fire|sparks?|smoke|smoking)\b/gi, " ")),
    unless: (m, before, after) => {
      if (HYPOTHETICAL_BEFORE.test(before)) return true;
      if (!/^smok/i.test(m)) return false;
      // A neighbour smoking, or cigarette smoke drifting in, is a conduct matter for the manager, not a fire.
      const around = `${before}${m}${after}`;
      return /\b(cigarettes?|cigars?|weed|pot|marijuana|cannabis|vap(e|ing)|tobacco|joints?|hookah)\b/i.test(around) || /\b(neighbou?rs?|someone|somebody|people|they|he|she|guy|tenants?|residents?|smokers?|next door)\b[\w\s']{0,20}\bsmok/i.test(around);
    },
  },
  {
    // A lithium battery (e-bike, scooter, power bank, laptop, phone) swelling, hissing or popping can burst into fire.
    pattern:
      /\b(lithium|batter(y|ies)|power ?banks?|(e-?bike|e-?scooter|scooter|hoverboard|vape|laptop|phone) (is )?(charg\w*|batter\w*))\b[^.!?]{0,60}\b(puff(y|ed|ing)?|swell(ing|ed|s)?|swollen|bulg(e|ed|es|ing)|hiss\w*|popping|crackl\w*|smok(e|es|ed|ing|y)(?! (detector|alarm))|overheat\w*|too hot to touch)\b|\b(puffed up|swollen|bulging|hissing|overheating)\b[^.!?]{0,30}\b(lithium|batter(y|ies)|power ?banks?)\b/i,
    reason: "A battery may be overheating and could catch fire.",
    advice: "Keep away from it, get everyone out of the room, close the door if you can, and call 911. Do not touch, move or unplug it.",
    unless: (m, before) => NEGATION_INSIDE.test(m) || HYPOTHETICAL_BEFORE.test(before),
  },
  {
    pattern: /\b(smoke|fire|co|carbon monoxide) (alarm|detector)s? (is |are |keeps|kept |has been |have been |was |were |been |started |won'?t stop )?(going off|sounding|ringing|blaring|screaming|beeping (nonstop|non-stop|constantly|continuously|loudly))\b/i,
    reason: "An alarm is going off.",
    advice: "If an alarm is sounding, get everyone out and call 911 from outside.",
  },
  {
    pattern: /\b(carbon monoxide|co (alarm|detector))\b/i,
    reason: "The report mentions carbon monoxide.",
    advice: "Get everyone into fresh air now and call 911.",
    // A CO detector chirping for a battery is urgent maintenance; an alarm going off is caught by the rule above.
    unless: (_m, before, after) => {
      const around = `${before} ${after}`;
      return /\b(chirp\w*|low battery|battery|beeps? (once|every))\b/i.test(around) && !/\b(going off|sounding|headache|dizzy|nause\w*)\b/i.test(around);
    },
  },
  {
    pattern: /\b(electric(al)? shock|got (a |an )?(little |small |big |electric(al)? )?shock|(gave|giving|gives) (me|him|her|us) (a )?(little |small )?shock|shocked (me|him|her|us|my)|got shocked|electrocut\w*)\b/i,
    reason: "The report mentions an electric shock.",
    advice: "Stay away from the fixture and anything wet near it. Call 911 if anyone is hurt.",
  },
  {
    pattern:
      /\b(flood(s|ed|ing)?|burst pipe|pipe (has |just )?burst|water (is )?(pouring|gushing)|(pipe|line|valve|fitting|hose|joint)s?\b[^.!?,;]{0,45}\b(spray(s|ing|ed)?|gush(es|ing|ed)?)|water (is )?(spraying|shooting) (out|everywhere|all over|from)|ceiling\b[^.!?]{0,40}\b(collaps(e|es|ed|ing)|caving|sagg(ing|ed|y)|bulg(e|es|ed|ing)))\b/i,
    reason: "The report describes major water or structural damage.",
    advice: "If it is safe, turn the water off at the shut-off valve and keep away from water near outlets.",
    unless: (m, before) => HYPOTHETICAL_BEFORE.test(before) || NEGATED.test(before) || NEGATION_INSIDE.test(m),
  },
  {
    // A ceiling bulging or bubbling with water can give way: "a bubble on the ceiling, soft and wet, getting bigger".
    pattern: /\b(bubbl(e|es|ed|ing|y)|balloon(s|ing|ed)?|bulg(e|es|ed|ing)|sagg(ing|ed|y)|droop(s|ing|ed|y)?)\b/i,
    requires: /\bceiling\b[\s\S]*\b(wet|water|drip\w*|leak\w*|soggy|soaked|damp)\b|\b(wet|water|drip\w*|leak\w*|soggy|soaked|damp)\b[\s\S]*\bceiling\b/i,
    reason: "Water may be collecting in the ceiling, which can give way.",
    advice: "Move away from under it and keep others away. If water is near lights or outlets, turn off that breaker if it is safe.",
    unless: (m, before, after) =>
      !/\b(ceiling|paint|plaster|drywall)\b/i.test(`${before} ${after}`) ||
      HYPOTHETICAL_BEFORE.test(before) ||
      /\b(no|not|isn'?t|without|never)\b[\w\s']{0,20}\b(wet|leak\w*|water|drip\w*|damp)\b/i.test(`${before} ${after}`) ||
      /\b(steam|condensation|shower)\b/i.test(`${before} ${after}`),
  },
  {
    // Sewage backing up is a health hazard; a sewer smell from a drain is urgent plumbing, not an emergency.
    pattern:
      /\b(sewage|sewer water|toilet water|waste water)\b[^.!?]{0,30}\b(backing up|backed up|overflowing|overflowed|coming out|coming over|all over|on the floor|onto the floor|everywhere|spilling|pouring)\b|\b(backing up|backed up|overflowing|overflowed)\b[^.!?]{0,20}\b(with )?(sewage|sewer water|waste water)\b|\b(raw sewage|sewage backup|sewer backup|sewage back-up)\b/i,
    reason: "The report describes sewage backing up.",
    advice: "Keep everyone, especially children and pets, away from the sewage, and do not use the sinks, toilets or shower until it is checked.",
    unless: (m, before) => NEGATION_INSIDE.test(m) || /\bsmell\w*\s+(like|of)\s+$/i.test(before),
  },
  {
    // Water and electricity together, in either order: "water dripping from the ceiling light", "the outlet is wet".
    // Same clause only (no comma or semicolon between them), joined by a word that relates them.
    pattern:
      /\b(water|drip\w*|leak\w*|pool(s|ed|ing)?|puddl\w*)\b[^.!?,;]{0,30}\b(from|through|into|onto|on|near|behind|around|above|over|out of|reaching|touching|in|under)\b[^.!?,;]{0,20}\b(light fixtures?|ceiling lights?|lights?|outlets?|sockets?|plugs?|power ?bars?|power strips?|extension cords?|cords?|(electrical |breaker )?panel|breakers?|wiring|switch(es)?)\b|\b(light fixtures?|ceiling lights?|outlets?|sockets?|plugs?|power ?bars?|(electrical |breaker )?panel|wiring|switch(es)?)\b[^.!?,;]{0,25}\b(wet|soaked|dripping|leaking|full of water|has water|under water|in water)\b/i,
    reason: "Water may be reaching electrics.",
    advice: "Keep away from the wet area and do not touch switches or outlets near it. If it is safe, turn off the breaker for that area.",
    unless: (m, before) => NEGATION_INSIDE.test(m) || HYPOTHETICAL_BEFORE.test(before),
  },
  {
    pattern: /\b(trapped|stuck) (in|inside) (the |an |our )?(elevator|lift)\b|\b(elevator|lift)\b[^.!?]{0,40}\b(with|someone|people|person|my \w+)\b[^.!?]{0,20}\b(in|inside|trapped)\b/i,
    reason: "Someone may be trapped in the elevator.",
    advice: "Press the elevator's alarm or call button and call 911. Do not try to force the doors or climb out.",
    unless: (m) => NEGATION_INSIDE.test(m) || /\b(earlier|yesterday|this morning|last night|got out|nobody|no one)\b/i.test(m),
  },
  {
    // A lockout is urgent; it is an emergency when someone who needs help is inside, or something is left on.
    pattern:
      /\blocked (myself |ourselves |us |me |him |her |them )?out\b[^.!?]{0,80}\b(bab(y|ies|ys|y's)|infant|newborn|toddler|child|kid|kids|son|daughter|\d+[- ]?(month|week|year|yr)s?[- ]?old|little one|grand\w+|mom|dad|mother|father|elderly)\b[^.!?]{0,30}\b(inside|in there|in the (unit|apartment|room)|alone|locked in|asleep)\b|\blocked (myself |ourselves |us |me |him |her |them )?out\b[^.!?]{0,80}\b(stove|oven|burner|bath|tub|iron|tap|water)\b[^.!?]{0,20}\b(on|running|left on)\b|\b(bab(y|ies|ys|y's)|infant|newborn|toddler|child|kid|son|daughter|\d+[- ]?(month|week|year|yr)s?[- ]?old|little one)\b[^.!?]{0,40}\b(inside|in there|locked in)\b/i,
    reason: "Someone who needs help may be inside, or something may have been left on.",
    advice: "If anyone inside is in danger or a stove or bath is left on, call 911 now. Staff will verify who you are before letting anyone in.",
    unless: (m) => NEGATION_INSIDE.test(m),
  },
  {
    // No heat at all, with someone at particular risk at home (the same rule the form applies to its answers).
    pattern: /\b(no heat(ing)?|heat(ing|er)? (is |has |has been )?(completely |totally )?(off|out|gone|dead|not working|stopped|broken|died)|furnace (is |has )?(off|out|broken|stopped|died)|boiler (is |has )?(off|out|broken|stopped|died)|radiat\w* (are |is |r |been |have been |has been |still |are still )?(stone |ice |icy |freezing )?(cold|freezing)|(freezing|freezin|ice cold) (in here|inside|in the unit|in my (unit|apartment|place))|(place|apartment|unit|house|home|room|suite)( is|'s)? (freezing|freezin|ice cold))\b/i,
    requires: PERSON_AT_RISK,
    reason: "No heat, with someone at particular risk at home.",
    advice: "If anyone is unwell from the cold, call 911. Keep them warm; the property manager has been alerted.",
    unless: (m) => NEGATION_INSIDE.test(m),
  },
  {
    pattern:
      /\b(screaming|yelling|shouting|calling|crying|screams?|yells?|shouts?|cries)\W{1,4}(out\W{1,3})?(for\W{1,3})?['"]?help\b|\bsounds? (like|of) (a |someone )?(fight|fighting|being (hit|hurt|attacked|beaten))\b|\b(being (hit|attacked|beaten|assaulted))\b|\bgunshots?\b|\bthreaten(ed|ing)? (to|me)\b|\bviolent\b/i,
    reason: "Someone may be in danger.",
    advice: "If anyone may be in danger, call 911 now. Do not intervene yourself.",
    unless: (m, before) => /^gunshots?$/i.test(m) && /\b(like|sounds? like|as loud as|as if|as though)\s+(a\s+|the\s+)?$/i.test(before),
  },
];

// "no smoke", "not flooding", "isn't sparking": a negated mention is not a hazard report.
const NEGATED = /\b(no|not|isn'?t|aren'?t|wasn'?t|without|never|don'?t|doesn'?t|didn'?t|nothing|nobody|none|neither|nor)\b[\w\s']{0,24}$/i;

// Nouns name the thing that is broken and weigh more than symptom words that fit several trades:
// "the washing machine will not drain" is an appliance problem, even though "drain" is a plumbing word.
const KEYWORDS: Record<Exclude<Category, "OTHER">, { nouns: RegExp; symptoms?: RegExp }> = {
  PLUMBING: {
    nouns: /\b(sink|faucet|tap|toilet|pipe|pipes|shower|bath ?tub|tub|water-heater-unit|hot water|water pressure|plumb\w*|sewer|garbage disposal)\b/gi,
    symptoms: /\b(drain(s|ing|ed)?|clog(s|ged)?|leak(s|ing|ed|y)?|drip(s|ping)?)\b/gi,
  },
  APPLIANCE: { nouns: /\b(washer|washing machine|dryer|fridge|refrigerator|freezer|stove|oven|range|cooktop|dishwasher|microwave|laundry|appliance)\b/gi },
  HVAC: { nouns: /\b(heat(ing|er)?|furnace|radiator|thermostat|boiler|a\/?c|air[- ]?con(ditioning|ditioner)?|cooling|hvac|vent(s|ilation)?|baseboard|exhaust fans?|bathroom fans?|range hood|fans?)\b/gi },
  ELECTRICAL: {
    nouns: /\b(outlets?|sockets?|breakers?|electrical panel|breaker panel|fuses?|wiring|wires?|light ?bulbs?|light fixtures?|ceiling lights?|lights|(?:the|hallway|hall|kitchen|bathroom|bedroom|porch|stairwell|ceiling|closet|entry|front|back) light(?:'s)?|light switch(es)?|switch(es)?|electricity|electrical|power)\b/gi,
    // "plug" weighs like a symptom: "water pooling around the washer's plug" is an appliance problem.
    symptoms: /\b(flicker\w*|trip(s|ped|ping)?|dead|no power|power (is )?out|outage|plugs?)\b/gi,
  },
  ACCESS: {
    nouns: /\b(lock(s)?|locked out|lockout|keys?|fobs?|deadbolt|door code|keypad|buzzer|intercom|entry door|front door|lobby door|garage door|garage gate|mailbox key)\b/gi,
    symptoms: /\b(locked|jammed|won'?t (open|close|lock|unlock))\b/gi,
  },
  ELEVATOR: { nouns: /\b(elevators?|lifts?)\b/gi },
  NOISE: {
    nouns: /\b(neighbou?rs?|music|party|parties|partying|stomping|bark(s|ing|ed)?|dogs?|next door|upstairs( unit)?|downstairs( unit)?|(above|below) (me|us)|footsteps|noise complaint)\b/gi,
    symptoms: /\b(noise|noisy|loud|yelling|shouting|bass|thump\w*|stomp\w*)\b/gi,
  },
};
const RULED: Exclude<Category, "OTHER">[] = ["PLUMBING", "APPLIANCE", "HVAC", "ELECTRICAL", "ACCESS", "ELEVATOR", "NOISE"];
// Their symptom words are too generic to classify on their own ("won't close" fits a window, "dead" fits anything).
const NOUN_REQUIRED = new Set<Category>(["ELECTRICAL", "ACCESS", "NOISE"]);

const sentence = (s: string) => {
  const first = s.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  const cut = first.length > 80 ? `${first.slice(0, 77).trimEnd()}…` : first;
  return cut.replace(/[.!?]+$/, "");
};

function ruleCategory(description: string): { category: Category; hits: number; runnerUp: number; tie: boolean } {
  // "water heater" is plumbing even though it contains "heater".
  const text = description.replace(/water heater/gi, "water-heater-unit");
  // Distinct keywords, ignoring negated mentions ("nothing near any outlets" says nothing about electrics),
  // and where the first one appears (the thing named first is usually the subject of the report).
  const count = (re?: RegExp) => {
    if (!re) return { n: 0, first: Infinity };
    const seen = new Set<string>();
    let first = Infinity;
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      if (NEGATED.test(text.slice(Math.max(0, at - 40), at))) continue;
      seen.add(m[0].toLowerCase());
      first = Math.min(first, at);
    }
    return { n: seen.size, first };
  };
  const scores = RULED.map((k) => {
    const nouns = count(KEYWORDS[k].nouns);
    const symptoms = count(KEYWORDS[k].symptoms);
    const score = NOUN_REQUIRED.has(k) && nouns.n === 0 ? 0 : 2 * nouns.n + symptoms.n;
    return { k, score, first: Math.min(nouns.first, symptoms.first) };
  });
  scores.sort((a, b) => b.score - a.score || a.first - b.first);
  if (scores[0].score === 0) return { category: "OTHER", hits: 0, runnerUp: 0, tie: false };
  return { category: scores[0].k, hits: scores[0].score, runnerUp: scores[1].score, tie: scores[0].score === scores[1].score };
}

/**
 * The text the safety rules read for a case: the resident's own words and observations, plus the facts recorded for it.
 * A fact that is false ("gas smell: no") is left out rather than rendered as words the rules could misread; a true one
 * contributes its name ("burning or sparks"). The agents' assumptions are never included.
 */
export function hazardText(description: string, observations: string[] = [], facts: Record<string, unknown> = {}) {
  const parts = Object.entries(facts ?? {})
    .filter(([, v]) => v !== false && v !== null && v !== undefined && !(typeof v === "string" && /^(no|false|none|n\/a)$/i.test(v.trim())))
    .map(([k, v]) => (v === true ? k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase() : `${k.replace(/_/g, " ")}: ${String(v)}`));
  return [description, ...observations, ...parts].filter(Boolean).join(". ");
}

/** Every hazard rule that fires on this text, with its advice. Used by intake and by the coordinator's policy. */
export function findHazards(description: string): { reason: string; advice: string }[] {
  const text = description.replace(/\s+/g, " ").trim();
  const out: { reason: string; advice: string }[] = [];
  for (const h of HAZARDS) {
    const re = new RegExp(h.pattern.source, h.pattern.flags.includes("g") ? h.pattern.flags : `${h.pattern.flags}g`);
    let fired = false;
    if (h.requires && !h.requires.test(text)) continue;
    if (h.unlessText?.(text)) continue;
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      if (NEGATED.test(text.slice(0, at))) continue;
      const before = text.slice(Math.max(0, at - 60), at);
      const after = text.slice(at + m[0].length, at + m[0].length + 60);
      if (h.unless?.(m[0], before, after)) continue;
      fired = true;
      break;
    }
    if (fired) out.push({ reason: h.reason, advice: h.advice });
  }
  return out;
}

export function triage(input: TriageInput): TriageResult {
  const description = input.description.replace(/\s+/g, " ").trim();
  const details = input.details ?? {};
  const reasons: string[] = [];
  let needsReview = false;

  // 1. Category: the resident's choice wins; the rules fill in when there is none and flag disagreements.
  const ruled = ruleCategory(description);
  let category: Category;
  if (input.categoryHint && input.categoryHint !== "OTHER") {
    category = input.categoryHint;
    reasons.push(`Reported as ${CATEGORY_SHORT[category].toLowerCase()}.`);
    if (ruled.category !== "OTHER" && ruled.category !== category && ruled.hits >= 2 && !ruled.tie) {
      needsReview = true;
      reasons.push(`The description reads more like ${CATEGORY_SHORT[ruled.category].toLowerCase()}: please check the category.`);
    }
  } else if (input.categoryHint === "OTHER") {
    // The resident chose "something else": keep their choice and let a person route it, with what the wording suggests.
    category = "OTHER";
    needsReview = true;
    reasons.push(ruled.category !== "OTHER" ? `Reported as something else; the wording suggests ${CATEGORY_SHORT[ruled.category].toLowerCase()}, so a person should check.` : "Reported as something else, so a person routes it.");
  } else if (ruled.category !== "OTHER") {
    category = ruled.category;
    reasons.push(
      ruled.tie
        ? `Classified as ${CATEGORY_SHORT[category].toLowerCase()} from the first thing the report names (the wording also fits another category).`
        : `Classified as ${CATEGORY_SHORT[category].toLowerCase()} from the wording of the report.`,
    );
  } else {
    category = "OTHER";
    needsReview = true;
    reasons.push(ruled.hits === 0 ? "Relay has no playbook for this kind of problem, so a person needs to route it." : "The description fits more than one category, so a person needs to classify it.");
  }

  // 2. Hazards: from the resident's words and from the safety questions.
  let emergency = false;
  let safetyAdvice: string | null = null;
  for (const h of findHazards(description)) {
    emergency = true;
    reasons.push(h.reason);
    safetyAdvice ??= h.advice;
  }
  for (const q of QUESTIONS[category]) {
    if (!q.safety) continue;
    if (details[q.key] === true) {
      emergency = true;
      reasons.push(`Answered yes to "${q.label}"`);
      safetyAdvice ??=
        q.key === "gasSmell" || q.key === "burningOrGasSmell"
          ? "If you smell gas, leave the unit and call your gas utility's emergency line or 911 from outside. If something is burning, get out and call 911."
          : q.key === "burningOrSparks"
            ? "Stop using it and stay away from it. If there is fire or smoke, get out and call 911."
            : q.key === "someoneTrapped"
              ? "Press the elevator's alarm or call button and call 911. Do not try to force the doors or climb out."
              : q.key === "someoneAtRisk" || q.key === "someoneInDanger" || q.key === "danger"
                ? "If anyone may be in danger, call 911 now."
                : "Keep away from the water, especially near outlets. If it is safe, turn the water off at the shut-off valve.";
    } else if (details[q.key] === null) {
      needsReview = true;
      reasons.push(`Not sure about "${q.label}"`);
    }
  }
  if (category === "HVAC" && details.completelyOut === true && details.vulnerableOccupant === true) {
    emergency = true;
    reasons.push("No heating or cooling at all, with someone at particular risk at home.");
    safetyAdvice ??= "If anyone is unwell from the heat or cold, call 911. Otherwise keep them as comfortable as you can; the property manager has been alerted.";
  }

  // 3. Category policy: who must look at it, whatever the wording.
  const lockout =
    category === "ACCESS" &&
    (details.issue === "locked_out" || /\b(locked (myself |me )?out|lockout|can'?t get (in|into)|lost (my |the |our )?(house |apartment |unit |door |front door )?keys?|let me in|door code|lockbox|no key)\b/i.test(description));
  if (lockout && !emergency) {
    needsReview = true;
    reasons.push("Lockouts are handled by staff, who verify who you are before anyone is let in. Relay never shares door or lockbox codes.");
  }
  const elevatorStopped =
    category === "ELEVATOR" &&
    (details.problem === "stuck_between_floors" || /\b(between floors|stopped between|stuck between|stuck (on|at) (the )?\d+\w* floor|dropp(ed|ing|s)|jerk(ed|ing|s|y)?|fell|free ?fall\w*|stopped (suddenly|mid-?way|halfway|abruptly))\b/i.test(description));
  if (elevatorStopped && !emergency) {
    needsReview = true;
    reasons.push("An elevator that stops between floors is a safety issue: a manager decides whether to take it out of service.");
  }
  // Someone who depends on the elevator: a person arranges help while it is out, beyond the repair itself.
  if (category === "ELEVATOR" && !emergency && /\b(crutch(es)?|wheelchair|walker|mobility|disabilit\w*|can'?t (do|use|climb|manage) (the )?stairs|stairs (are|is) (hard|difficult|impossible))\b/i.test(description)) {
    needsReview = true;
    reasons.push("Someone with limited mobility depends on the elevator: a person should arrange help while it is out.");
  }

  // 4. Severity.
  let severity: Severity = "ROUTINE";
  if (emergency) severity = "EMERGENCY";
  else if (
    details.activeLeak === true ||
    details.completelyOut === true ||
    (category === "APPLIANCE" && details.appliance === "refrigerator" && details.problem === "not_heating_cooling") ||
    (category === "PLUMBING" && details.fixture === "toilet") ||
    (category === "ELECTRICAL" && (details.what === "whole_unit" || details.what === "breaker_panel" || /\b(no power|power (is )?out|half (of )?(the|my) outlets|outlets? (are|is) dead)\b/i.test(description))) ||
    category === "ELEVATOR" ||
    lockout ||
    needsReview
  ) {
    severity = "URGENT";
    if (details.activeLeak === true) reasons.push("Water is leaking now.");
    if (details.completelyOut === true) reasons.push("The system is not working at all.");
  }

  // 5. Title and summary, built only from what was actually reported.
  const label = (key: string) => optionLabel(category, key, details[key] ?? null).toLowerCase();
  // An answer of "other" ("Somewhere else", "Something else") says nothing a title can use: the resident's own first
  // sentence names it instead ("Leak at the somewhere else" was the old result).
  const known = (key: string) => details[key] !== undefined && details[key] !== null && details[key] !== "other";
  let title = input.title?.replace(/\s+/g, " ").trim().slice(0, 80) || "";
  if (!title) {
    if (category === "PLUMBING" && known("fixture")) title = `${details.activeLeak === true ? "Leak" : "Problem"} at the ${label("fixture")}`;
    else if (category === "APPLIANCE" && known("appliance")) title = `${optionLabel(category, "appliance", details.appliance)}: ${known("problem") ? label("problem") : "not working"}`;
    else if (category === "HVAC" && known("system")) title = `${optionLabel(category, "system", details.system)} ${details.completelyOut === true ? "not working" : "problem"}`;
    else if (category === "ELECTRICAL" && known("what")) title = `Electrical: ${label("what")}`;
    else if (category === "ACCESS" && known("issue")) title = optionLabel(category, "issue", details.issue);
    else if (category === "ELEVATOR" && known("problem")) title = `Elevator: ${label("problem")}`;
    else title = sentence(description) || "Maintenance request";
  }
  const facts = QUESTIONS[category]
    .filter((q) => details[q.key] !== undefined)
    .map((q) => `${q.label.replace(/\?$/, "")}: ${optionLabel(category, q.key, details[q.key])}`);
  const summary = [`${CATEGORY_SHORT[category]} report`, ...facts].join(". ") + ".";

  return { category, severity, emergency, needsReview, reasons, safetyAdvice, title, summary };
}

/** A fixed estimate at or under the property's threshold is approved by policy. Anything else needs a manager. */
export function approvalRequired(estimateType: "FIXED" | "INSPECTION_REQUIRED", estimateCents: number | null, thresholdCents: number): boolean {
  if (estimateType !== "FIXED" || estimateCents === null) return true;
  return estimateCents > thresholdCents;
}

/** Two half-open time ranges [start, end) overlap. */
export const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && bStart < aEnd;
