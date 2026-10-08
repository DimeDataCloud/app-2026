/**
 * Compatibility mode: a standard Opus media track for browsers where the
 * DataChannel/AudioWorklet path fails. Munges SDP toward low latency: 10 ms
 * packets, no DTX, in-band FEC, high bitrate. Expect higher latency than PCM.
 */
export const COMPAT_FMTP: Record<string, string> = {
  ptime: '10',
  minptime: '10',
  usedtx: '0',
  useinbandfec: '1',
  maxaveragebitrate: '128000',
  stereo: '0',
};

export function mungeOpusSdp(sdp: string, params: Record<string, string> = COMPAT_FMTP): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const pts = new Set<string>();
  for (const l of lines) {
    const m = l.match(/^a=rtpmap:(\d+) opus\/48000/i);
    if (m) pts.add(m[1]!);
  }
  if (pts.size === 0) return sdp;

  const out: string[] = [];
  const seenFmtp = new Set<string>();
  let inAudio = false;
  let hasPtime = false;
  const flushAudio = () => {
    if (inAudio && !hasPtime) out.push(`a=ptime:${params.ptime ?? '10'}`);
  };
  for (const l of lines) {
    if (l.startsWith('m=')) {
      flushAudio();
      inAudio = l.startsWith('m=audio');
      hasPtime = false;
    }
    if (inAudio && l.startsWith('a=ptime:')) {
      out.push(`a=ptime:${params.ptime ?? '10'}`);
      hasPtime = true;
      continue;
    }
    const f = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (f && pts.has(f[1]!)) {
      const kv = new Map<string, string>();
      for (const part of f[2]!.split(';')) {
        const [k, v] = part.split('=');
        if (k) kv.set(k.trim(), (v ?? '').trim());
      }
      for (const [k, v] of Object.entries(params)) if (k !== 'ptime') kv.set(k, v);
      out.push(`a=fmtp:${f[1]} ${[...kv].map(([k, v]) => `${k}=${v}`).join(';')}`);
      seenFmtp.add(f[1]!);
      continue;
    }
    out.push(l);
    const r = l.match(/^a=rtpmap:(\d+) opus\/48000/i);
    if (r && !lines.some((x) => x.startsWith(`a=fmtp:${r[1]} `))) {
      const kv = Object.entries(params).filter(([k]) => k !== 'ptime');
      out.push(`a=fmtp:${r[1]} ${kv.map(([k, v]) => `${k}=${v}`).join(';')}`);
    }
  }
  // Trailing empty line handling: keep ptime before the final empty element.
  if (inAudio && !hasPtime) {
    const last = out.length && out[out.length - 1] === '' ? out.pop() : undefined;
    out.push(`a=ptime:${params.ptime ?? '10'}`);
    if (last !== undefined) out.push(last);
  }
  return out.join(eol);
}

/** Ask the receiver to hold as little audio as possible. */
export function minimizeJitterBuffer(receiver: RTCRtpReceiver): void {
  const r = receiver as unknown as { jitterBufferTarget?: number | null; playoutDelayHint?: number };
  try {
    if ('jitterBufferTarget' in receiver) r.jitterBufferTarget = 0;
    else r.playoutDelayHint = 0;
  } catch {
    /* unsupported */
  }
}
