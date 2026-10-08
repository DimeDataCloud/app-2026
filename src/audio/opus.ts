import { QUANTUM } from '../net/packet';

/**
 * Optional WebCodecs Opus at 2.5 ms frames, for weak links. Adds ~5–7 ms
 * (frame + encoder lookahead), so PCM stays the default.
 */
const SR = 48000;

const BASE_CONFIG = {
  codec: 'opus',
  sampleRate: SR,
  numberOfChannels: 1,
  bitrate: 96000,
};

const CONFIGS: AudioEncoderConfig[] = [
  { ...BASE_CONFIG, opus: { frameDuration: 2500, complexity: 5, application: 'lowdelay', signal: 'music' } } as AudioEncoderConfig,
  { ...BASE_CONFIG, opus: { frameDuration: 2500 } } as AudioEncoderConfig,
];

let supportedConfig: Promise<AudioEncoderConfig | null> | null = null;

export function opusConfig(): Promise<AudioEncoderConfig | null> {
  supportedConfig ??= (async () => {
    if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined') return null;
    for (const c of CONFIGS) {
      try {
        if ((await AudioEncoder.isConfigSupported(c)).supported) return c;
      } catch {
        /* try the next one */
      }
    }
    return null;
  })();
  return supportedConfig;
}

export async function canDecodeOpus(): Promise<boolean> {
  if (typeof AudioDecoder === 'undefined') return false;
  try {
    return (await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: SR, numberOfChannels: 1 })).supported === true;
  } catch {
    return false;
  }
}

export class OpusSender {
  private enc: AudioEncoder;

  constructor(config: AudioEncoderConfig, onPacket: (sampleTime: number, data: Uint8Array) => void) {
    this.enc = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        onPacket(Math.round((chunk.timestamp * SR) / 1e6) >>> 0, data);
      },
      error: (e) => console.warn('opus encoder', e),
    });
    this.enc.configure(config);
  }

  encode(sampleTime: number, samples: Float32Array): void {
    if (this.enc.encodeQueueSize > 8) return; // never let a queue build up
    this.enc.encode(
      new AudioData({
        format: 'f32-planar',
        sampleRate: SR,
        numberOfFrames: samples.length,
        numberOfChannels: 1,
        timestamp: (sampleTime * 1e6) / SR,
        data: samples.slice(),
      }),
    );
  }

  close(): void {
    if (this.enc.state !== 'closed') this.enc.close();
  }
}

/**
 * Regroups decoded audio (Opus emits 120-frame blocks) into 128-frame quanta
 * aligned to the sender's timeline, so seq = sampleTime / 128 for every codec.
 */
export class Rechunker {
  private buf = new Float32Array(QUANTUM);
  private fill = 0;
  private start = -1;

  constructor(private readonly emit: (seq: number, q: Float32Array) => void) {}

  push(sampleTime: number, frames: Float32Array): void {
    if (this.fill > 0 && sampleTime !== this.start + this.fill) this.flush();
    if (this.fill === 0) {
      this.start = Math.floor(sampleTime / QUANTUM) * QUANTUM;
      this.fill = sampleTime - this.start;
      this.buf.fill(0, 0, this.fill);
    }
    let i = 0;
    while (i < frames.length) {
      const n = Math.min(QUANTUM - this.fill, frames.length - i);
      this.buf.set(frames.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === QUANTUM) {
        this.emit((this.start / QUANTUM) & 0xffff, this.buf);
        this.start += QUANTUM;
        this.fill = 0;
        this.buf = new Float32Array(QUANTUM);
      }
    }
  }

  private flush(): void {
    this.buf.fill(0, this.fill);
    this.emit((this.start / QUANTUM) & 0xffff, this.buf);
    this.buf = new Float32Array(QUANTUM);
    this.fill = 0;
  }
}

export class OpusReceiver {
  private dec: AudioDecoder;
  private readonly chunker: Rechunker;
  private pcm = new Float32Array(0);

  constructor(emit: (seq: number, q: Float32Array) => void) {
    this.chunker = new Rechunker(emit);
    this.dec = new AudioDecoder({
      output: (ad) => {
        if (this.pcm.length < ad.numberOfFrames) this.pcm = new Float32Array(ad.numberOfFrames);
        const view = this.pcm.subarray(0, ad.numberOfFrames);
        ad.copyTo(view, { planeIndex: 0, format: 'f32-planar' });
        this.chunker.push(Math.round((ad.timestamp * SR) / 1e6), view);
        ad.close();
      },
      error: (e) => console.warn('opus decoder', e),
    });
    this.dec.configure({ codec: 'opus', sampleRate: SR, numberOfChannels: 1 });
  }

  decode(sampleTime: number, data: Uint8Array): void {
    if (this.dec.decodeQueueSize > 8) return;
    this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: (sampleTime * 1e6) / SR, data }));
  }

  close(): void {
    if (this.dec.state !== 'closed') this.dec.close();
  }
}
