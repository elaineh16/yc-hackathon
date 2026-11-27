// Builds the fake-microphone track for the voice check: 16-bit PCM WAVs (Kokoro, 24 kHz mono) joined with silences,
// upsampled to 48 kHz. Usage: node make-mic.mjs out.wav <silence s> <file.wav> <silence s> <file.wav> ... <silence s>
import { readFileSync, writeFileSync } from "node:fs";

function readWav(path) {
  const b = readFileSync(path);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${path}: not a WAV`);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === "data") data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.bits !== 16 || fmt.channels !== 1) throw new Error(`${path}: need 16-bit mono PCM, got ${JSON.stringify(fmt)}`);
  const s = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
  return { rate: fmt.rate, samples: Int16Array.from(s) };
}

const OUT_RATE = 48000;
const [out, ...parts] = process.argv.slice(2);
const chunks = [];
for (const p of parts) {
  if (/^[\d.]+$/.test(p)) {
    chunks.push(new Int16Array(Math.round(Number(p) * OUT_RATE)));
    continue;
  }
  const { rate, samples } = readWav(p);
  const n = Math.round((samples.length * OUT_RATE) / rate);
  const up = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * rate) / OUT_RATE, i0 = Math.floor(x), f = x - i0;
    const a = samples[Math.min(i0, samples.length - 1)], b2 = samples[Math.min(i0 + 1, samples.length - 1)];
    up[i] = Math.round(a + (b2 - a) * f);
  }
  chunks.push(up);
}
const total = chunks.reduce((s, c) => s + c.length, 0);
const pcm = Buffer.alloc(total * 2);
let o = 0;
for (const c of chunks) for (const v of c) { pcm.writeInt16LE(v, o); o += 2; }
const h = Buffer.alloc(44);
h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(OUT_RATE, 24); h.writeUInt32LE(OUT_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
writeFileSync(out, Buffer.concat([h, pcm]));
console.log(`${out}: ${(total / OUT_RATE).toFixed(1)} s at ${OUT_RATE} Hz`);
