// Builds a render timeline from captured scenes, rendered cards and narration.
// Footage is never altered: a scene can be trimmed, sped up a little, or have the model's thinking time cut (always
// marked on screen with the seconds removed); it otherwise plays as recorded.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p) => JSON.parse(readFileSync(p, "utf-8").replace(/^\uFEFF/, ""));

/**
 * items: [{ kind: "scene", dir, label, device, narration } | { kind: "card", image, narration, minSeconds }]
 * narration: an id in the durations file (audio/<id>.wav) and its text (for captions).
 */
export function buildTimeline({ work, items, durations, texts, output, videoBitsPerSecond, audioDir = "audio" }) {
  const listed = read(join(work, durations));
  const dur = Object.fromEntries((Array.isArray(listed) ? listed : [listed]).map((d) => [d.id, d.seconds]));
  const clips = [];
  const audio = [];
  const captions = [];
  const images = [];
  let t = 0;
  const FADE = 0.45;
  for (const [n, it] of items.entries()) {
    const speech = it.narration ? dur[it.narration] : 0;
    if (it.narration && speech === undefined) throw new Error(`no narration audio for ${it.narration}`);
    const lead = 0.5;
    let clip;
    if (it.kind === "card") {
      images.push(it.image);
      const duration = Math.max(it.minSeconds ?? 3, lead + speech + 1.2);
      clip = { id: `c${n}`, image: it.image, start: t, duration, fadeIn: n ? FADE : 0, quiet: it.quiet === true };
    } else {
      const m = read(join(work, it.dir, "manifest.json"));
      const frames = m.frames.map((f) => ({ file: f.file, t: f.t }));
      const t0 = m.started;
      const end = m.ended - t0;
      // Keep everything except the model's thinking: from each "wait" to just before its "reply".
      const segments = [];
      const cuts = [];
      let from = 0;
      const marks = m.marks;
      for (const w of marks.filter((x) => /^wait-/.test(x.label))) {
        const reply = marks.find((x) => x.label === w.label.replace("wait", "reply"));
        if (!reply) continue;
        const cutFrom = w.t - t0 + 2.2;
        const cutTo = reply.t - t0 - 0.4;
        if (cutTo - cutFrom < 2) continue;
        segments.push({ from, to: cutFrom });
        cuts.push({ source: cutFrom, seconds: Math.round(reply.t - w.t) });
        from = cutTo;
      }
      segments.push({ from, to: end });
      // An excerpt: only the stretch around a named moment of the scene (used to quote real footage elsewhere).
      if (it.range) {
        const at = marks.find((x) => x.label === it.range.mark);
        if (!at) throw new Error(`no mark ${it.range.mark} in ${it.dir}`);
        segments.length = 0;
        cuts.length = 0;
        segments.push({ from: Math.max(0, at.t - t0 - it.range.before), to: Math.min(end, at.t - t0 + it.range.after) });
      }
      let footage = segments.reduce((a, s) => a + (s.to - s.from), 0);
      const target = lead + speech + 1.0;
      // Long footage under short narration plays a little faster (at most 1.6x), never faster than that.
      const rate = footage > target + 4 ? Math.min(1.6, footage / (target + 3)) : 1;
      for (const s of segments) s.rate = rate;
      footage /= rate;
      const duration = Math.max(footage, target);
      // Source time to output time inside the clip.
      const toOut = (src) => {
        let acc = 0;
        for (const s of segments) {
          if (src < s.from) return acc;
          if (src <= s.to) return acc + (src - s.from) / s.rate;
          acc += (s.to - s.from) / s.rate;
        }
        return acc;
      };
      const zooms = [];
      let free = 0;
      for (const f of marks.filter((x) => x.focus)) {
        if (f.t - t0 < segments[0].from || f.t - t0 > segments[segments.length - 1].to) continue;
        const at = toOut(f.t - t0) + 0.25;
        if (at < free) continue;
        const d = Math.min(3.6, duration - at - 0.3);
        if (d < 1.6) continue;
        zooms.push({ at, dur: d, rect: f.focus });
        free = at + d + 0.2;
      }
      clip = {
        id: `s${n}`,
        dir: it.dir,
        frames,
        t0,
        segments,
        device: it.device,
        label: it.label,
        side: it.side,
        title: it.title,
        zooms,
        start: t,
        duration,
        fadeIn: n ? FADE : 0,
        cuts: cuts.map((c) => ({ at: t + toOut(c.source), text: `${c.seconds} s of model time cut` })),
      };
    }
    clips.push(clip);
    if (it.narration) {
      audio.push({ src: `${audioDir}/${it.narration}.wav`, at: t + lead });
      captions.push(...splitCaptions(texts[it.narration], t + lead, speech));
    }
    t += clip.duration;
  }
  // The renderer holds the first frame for this long before the timeline starts (the encoder warms up meanwhile).
  const preroll = 4;
  return { width: 1920, height: 1080, duration: t + 0.5, preroll, output, videoBitsPerSecond, clips, audio, captions, images };
}

/** Sentences (or the parts between "|" pauses), timed in proportion to their length across the narration. */
export function splitCaptions(text, start, seconds) {
  const parts = text
    .split("|")
    .flatMap((p) => p.match(/[^.!?]+[.!?]+["”']?|[^.!?]+$/g) ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  // Long sentences are split at a comma so a caption never runs past two lines.
  const chunks = parts.flatMap((p) => (p.length > 110 && p.includes(", ") ? splitLong(p) : [p]));
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = [];
  let at = start;
  for (const c of chunks) {
    const d = (c.length / total) * seconds;
    out.push({ start: at, end: at + d, text: c });
    at += d;
  }
  return out;
}
function splitLong(s) {
  const mid = s.length / 2;
  let best = -1;
  for (let i = s.indexOf(", "); i >= 0; i = s.indexOf(", ", i + 1)) if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  return best < 0 ? [s] : [s.slice(0, best + 1), s.slice(best + 2)];
}

/** SubRip captions for the published video. */
export function toSrt(captions, offset = 0) {
  const ts = (x) => {
    const ms = Math.round(x * 1000);
    const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
    return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
  };
  return captions.map((c, i) => `${i + 1}\n${ts(c.start + offset)} --> ${ts(c.end + offset)}\n${c.text}\n`).join("\n");
}
export const toVtt = (captions, offset = 0) => `WEBVTT\n\n${toSrt(captions, offset).replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2")}`;
