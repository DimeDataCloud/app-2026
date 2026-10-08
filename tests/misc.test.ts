import { describe, expect, it } from 'vitest';
import { mungeOpusSdp } from '../src/audio/fallback';
import { Rechunker } from '../src/audio/opus';
import { RECV_RING, Ring, createRingBuffer } from '../src/audio/ring';
import { bluetoothWarning, isBluetoothLabel, isUsbAudioLabel } from '../src/devices';
import { newRoomCode, normalizeRoomCode } from '../src/signaling';

describe('device heuristics', () => {
  it('flags Bluetooth outputs', () => {
    for (const l of ['AirPods Pro', 'Galaxy Buds2', 'Bluetooth headset', 'JBL BT speaker', 'Hands-Free HFP']) {
      expect(isBluetoothLabel(l)).toBe(true);
    }
  });
  it('does not flag wired devices', () => {
    for (const l of ['Speakerphone', 'USB-C headset', 'USB Audio', 'Built-in Microphone', 'Default', 'Subtle Mic']) {
      expect(isBluetoothLabel(l)).toBe(false);
    }
  });
  it('warns on high output latency even with no label', () => {
    expect(bluetoothWarning([''], 180)).toBe(true);
    expect(bluetoothWarning(['Speaker'], 20)).toBe(false);
  });
  it('detects a USB / CODE input', () => {
    expect(isUsbAudioLabel('USB Audio Device')).toBe(true);
    expect(isUsbAudioLabel('Marshall CODE')).toBe(true);
    expect(isUsbAudioLabel('Bottom microphone')).toBe(false);
  });
});

const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 0',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:0 PCMU/8000',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=sctp-port:5000',
  '',
].join('\r\n');

describe('SDP munging (compatibility mode)', () => {
  it('sets low-latency Opus parameters and ptime on the audio section only', () => {
    const out = mungeOpusSdp(SDP);
    const lines = out.split('\r\n');
    const fmtp = lines.find((l) => l.startsWith('a=fmtp:111'))!;
    expect(fmtp).toContain('usedtx=0');
    expect(fmtp).toContain('useinbandfec=1');
    expect(fmtp).toContain('maxaveragebitrate=128000');
    expect(fmtp).toContain('minptime=10');
    const audioEnd = lines.findIndex((l) => l.startsWith('m=application'));
    const ptime = lines.indexOf('a=ptime:10');
    expect(ptime).toBeGreaterThan(0);
    expect(ptime).toBeLessThan(audioEnd);
    expect(out.endsWith('\r\n')).toBe(true);
  });
  it('leaves SDP without Opus unchanged', () => {
    const noAudio = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
    expect(mungeOpusSdp(noAudio)).toBe(noAudio);
  });
  it('is idempotent', () => {
    const once = mungeOpusSdp(SDP);
    expect(mungeOpusSdp(once)).toBe(once);
  });
});

describe('Rechunker (Opus 120-frame blocks → 128-frame quanta)', () => {
  it('aligns quanta to the sender timeline and pads gaps', () => {
    const got: { seq: number; first: number; last: number }[] = [];
    const r = new Rechunker((seq, q) => got.push({ seq, first: q[0]!, last: q[127]! }));
    let t = 0;
    for (let i = 0; i < 16; i++) {
      r.push(t, Float32Array.from({ length: 120 }, (_, k) => t + k));
      t += 120;
    }
    expect(got.length).toBe(15);
    got.forEach((g, i) => {
      expect(g.seq).toBe(i);
      expect(g.first).toBe(i * 128);
      expect(g.last).toBe(i * 128 + 127);
    });
    // Two lost blocks: restart aligned to the sender timeline, zero-padding the
    // part of the quantum before the new audio.
    const qs: Float32Array[] = [];
    const r2 = new Rechunker((_, q) => qs.push(q.slice()));
    r2.push(100, new Float32Array(120).fill(1)); // quantum 0, frames 100..219
    expect(qs.length).toBe(1);
    expect(qs[0]![99]).toBe(0);
    expect(qs[0]![100]).toBe(1);
    // Gap: flush partial quantum 1, then quantum 7 (896..1023) starts at 1000.
    r2.push(1000, new Float32Array(120).fill(2));
    expect(qs.length).toBe(3);
    expect(qs[1]![91]).toBe(1);
    expect(qs[1]![92]).toBe(0);
    expect(qs[2]![103]).toBe(0);
    expect(qs[2]![104]).toBe(2);
  });
});

describe('Ring', () => {
  it('is FIFO, reports fullness and drops when full', () => {
    const ring = new Ring(createRingBuffer(RECV_RING, false), RECV_RING);
    const q = new Float32Array(128);
    for (let i = 0; i < RECV_RING.slots - 1; i++) {
      q[0] = i;
      expect(ring.write([i], q)).toBe(true);
    }
    expect(ring.write([999], q)).toBe(false);
    const h = new Float64Array(1);
    const out = new Float32Array(128);
    for (let i = 0; i < 5; i++) {
      expect(ring.read(h, out)).toBe(true);
      expect(h[0]).toBe(i);
      expect(out[0]).toBe(i);
    }
    expect(ring.available()).toBe(RECV_RING.slots - 6);
  });
});

describe('room codes', () => {
  it('generates 6 unambiguous characters', () => {
    for (let i = 0; i < 50; i++) expect(newRoomCode()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });
  it('normalizes user input', () => {
    expect(normalizeRoomCode(' ab-c12 3 ')).toBe('ABC123');
    expect(normalizeRoomCode('abc')).toBeNull();
  });
});
