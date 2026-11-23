// Narration with Kokoro-82M (open weights, Apache-2.0) run locally on the CPU through kokoro-js: a natural voice with no
// account and no per-character cost. It is optional (about 200 MB with the ONNX runtime), so it is installed outside
// the repository:
//   mkdir -p ~/kokoro && cd ~/kokoro && npm init -y && npm i kokoro-js@1.2.1 --onnxruntime-node-install-cuda=skip
// The first run downloads the model (onnx-community/Kokoro-82M-v1.0-ONNX, q8, about 90 MB) from Hugging Face.
// Usage: KOKORO_DIR=~/kokoro node tts-kokoro.mjs <segments.json> <outDir> [--voice af_heart] [--speed 1]
// Writes <id>.wav (16-bit PCM, 24 kHz, mono) per segment and durations.json in the same shape as tts.ps1, so the
// timeline does not care which voice made it. "|" in the text is a short pause. A segment whose text, voice and speed
// did not change since the last run is not synthesised again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const [segmentsFile, outDir] = args;
if (!segmentsFile || !outDir) throw new Error("usage: tts-kokoro.mjs <segments.json> <outDir> [--voice af_heart] [--speed 1]");
const opt = (name, d) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : d);
const voice = opt("voice", "af_heart");
const speed = Number(opt("speed", "1"));
const PAUSE = 0.38;

const dir = resolve(process.env.KOKORO_DIR ?? process.cwd());
const entry = join(dir, "node_modules", "kokoro-js", "dist", "kokoro.js");
if (!existsSync(entry)) throw new Error(`kokoro-js is not installed in ${dir} (see the comment at the top of this file), or use tts.ps1.`);
const { KokoroTTS } = await import(pathToFileURL(entry).href);

const segments = JSON.parse(readFileSync(segmentsFile, "utf-8").replace(/^﻿/, ""));
mkdirSync(outDir, { recursive: true });
let tts = null;
const durations = [];
for (const s of segments) {
  const wav = join(outDir, `${s.id}.wav`);
  const stamp = join(outDir, `${s.id}.txt`);
  const key = JSON.stringify({ text: s.text, voice, speed });
  if (!(existsSync(wav) && existsSync(stamp) && readFileSync(stamp, "utf-8") === key)) {
    tts ??= await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
    const parts = s.text.split("|").map((p) => p.trim()).filter(Boolean);
    const chunks = [];
    let rate = 24000;
    for (const [i, p] of parts.entries()) {
      const a = await tts.generate(p, { voice, speed });
      rate = a.sampling_rate;
      chunks.push(a.audio);
      if (i < parts.length - 1) chunks.push(new Float32Array(Math.round(PAUSE * rate)));
    }
    writeFileSync(wav, pcm16(chunks, rate));
    writeFileSync(stamp, key);
    console.log(`${s.id}: synthesised`);
  }
  const b = readFileSync(wav);
  durations.push({ id: s.id, file: `${s.id}.wav`, seconds: Number(((b.length - 44) / 2 / b.readUInt32LE(24)).toFixed(3)) });
}
writeFileSync(join(outDir, "durations.json"), JSON.stringify(durations, null, 1));
console.log(durations.map((d) => `${d.id} ${d.seconds}s`).join("\n"));

function pcm16(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const out = Buffer.alloc(44 + n * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + n * 2, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(n * 2, 40);
  let o = 44;
  for (const c of chunks) for (const x of c) (out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x * 32767))), o), (o += 2));
  return out;
}
