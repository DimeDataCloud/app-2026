// Generates a 2 s, 48 kHz mono WAV with a sharp click every 500 ms, used as the
// fake microphone in the end-to-end test.
import { writeFileSync } from 'node:fs';

const sr = 48000;
const n = sr * 2;
const data = Buffer.alloc(n * 2);
for (let c = 0; c < 4; c++) {
  const start = Math.round((c * 0.5 + 0.25) * sr);
  for (let i = 0; i < 96; i++) {
    const v = Math.round((i % 4 < 2 ? 0.8 : -0.8) * (1 - i / 96) * 32767);
    data.writeInt16LE(v, (start + i) * 2);
  }
}
const h = Buffer.alloc(44);
h.write('RIFF', 0);
h.writeUInt32LE(36 + data.length, 4);
h.write('WAVE', 8);
h.write('fmt ', 12);
h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20);
h.writeUInt16LE(1, 22);
h.writeUInt32LE(sr, 24);
h.writeUInt32LE(sr * 2, 28);
h.writeUInt16LE(2, 32);
h.writeUInt16LE(16, 34);
h.write('data', 36);
h.writeUInt32LE(data.length, 40);
writeFileSync(process.argv[2] ?? 'clicks.wav', Buffer.concat([h, data]));
