<h1 align="center">JamLink</h1>

<p align="center">Low-latency, browser-only jamming for two guitarists. No install, no audio interface.</p>

JamLink runs in a phone or laptop browser and is hosted for about **$0** on Cloudflare's free plan.

It is for two musicians who want to play together over the internet and need the delay between
them kept as low as possible.

The goal is to keep the one-way delay between the two players **under 60 ms**. On a decent
connection within one country it is usually much lower.

## How it works

```
Phone A                                                     Phone B
mic/USB → AudioWorklet ─PCM─► RTCDataChannel (unordered, 0 retransmits) ─► AudioWorklet → ears/amp AUX
           (SAB ring)                                                (adaptive jitter buffer + PLC)
Signaling only: WebSocket ↔ Cloudflare Worker + Durable Object "Room" (max 2 peers)
```

Standard WebRTC audio tracks (Opus plus the NetEQ jitter buffer, tuned for speech) measure
60 ms at best and 80–180 ms typically. JamLink instead sends **raw 16-bit PCM in short packets
over an unordered, no-retransmit DataChannel**. It plays the audio through its own jitter buffer
in an AudioWorklet (the approach from Sacchetto et al., JAES 2022). WebRTC still provides NAT
traversal and encryption for free.

### Staying under 60 ms

Most of the latency is outside the network: phone audio input and output paths, and Bluetooth.
JamLink measures each part and enforces the budget on the parts it controls:

| Stage | How JamLink handles it |
|---|---|
| Capture | Echo cancellation, noise suppression and AGC are off. Smallest capture buffer requested. The **device loopback test** measures it. |
| Packetization | 128 frames per packet by default. |
| Send queue | A packet is dropped at the source if more than 3 are already queued, so a congested link causes a gap, never a growing delay. |
| Network | Peer-to-peer, direct when possible. TURN relay only when NAT forces it. RTT is measured every 500 ms on the audio channel itself. |
| Jitter buffer | Measures its actual slack each second and trims it to the minimum that avoids late packets (skip/insert quanta, single-sample drift correction). **Capped** so that capture + packet + network + buffer + output stays under 60 ms. Past the cap it accepts a rare concealed glitch instead of adding delay. Toggle "Keep under 60 ms" in Advanced. |
| Output | `AudioContext({latencyHint: 0})`. Bluetooth is detected and warned about (it adds 150–300 ms). |

The **live HUD** shows both directions (partner → you, you → partner), colour-coded:
green < 40 ms, amber < 60 ms, red ≥ 60 ms. If you go over budget, it names the biggest contributor.

> **What can't be guaranteed in software:** a phone whose browser audio path alone takes 40+ ms,
> Bluetooth audio, or a network RTT over ~60 ms. The HUD makes these visible. The escape hatch
> for a slow phone is a laptop running Chrome or Firefox with wired headphones.

Measured on localhost in headless Chromium (Playwright, see below): click capture → partner
playout takes **well under the 60 ms budget** in-app for PCM, and more for Opus. Add the browser-reported output
latency for the total.

## Features

- Rooms: create (6-character code and share link) or join. A third player is turned away.
- Setup: input preset (CODE USB / CODE phones-out / phone mic), device picker, gain, level meter
  with clip light, output picker (`setSinkId` where supported), local monitor toggle.
- Device loopback latency test (clicks out, listen back in).
- Live latency HUD: RTT, jitter buffer, output latency, partner capture, loss/late, direct vs relay, codec.
- Codecs: `pcm16` (≈770 kbps, default), `mulaw8` (≈385 kbps, zero added delay),
  WebCodecs `opus` (≈100 kbps, adds a little more delay, for weak links).
- Synced metronome: start time is shared through a ping-derived clock offset. Each phone clicks
  locally, so the clicks carry no network delay.
- Compatibility mode (standard Opus media track with munged SDP, `jitterBufferTarget = 0`),
  automatic if the DataChannel can't open.
- Hookup guide for the Marshall CODE 50 (in the app under "Hookup guide").
- Installable PWA.

## Hookup summary (no interface)

**Into the phone:**
- **A.** CODE USB → Android OTG cable. Unverified on phones; the app shows "USB Audio" if it appears.
- **B.** CODE PHONES out → TRRS splitter or USB-C headset adapter mic input (~$10). **Start with the amp volume low**, because mic inputs clip.
- **C.** Phone mic near the speaker ($0).

**Out of the phone:** wired headphones, or the phone's headphone out → CODE AUX IN. Avoid Bluetooth.

## Quick start

Requires Node.js with npm. To run the full app locally, including signaling:

```sh
npm install
npm run preview      # builds, then starts wrangler dev at http://localhost:8787
```

Open the URL in two browser windows (or on two devices), create a room in one, and join it from the other.

## Configuration

JamLink needs no configuration to run. The only settings are optional secrets for TURN.

| Name | Where it is set | Required | Purpose |
|---|---|---|---|
| `TURN_KEY_ID` | `wrangler secret put` | No | Cloudflare Realtime TURN key ID. Enables the relay fallback. |
| `TURN_KEY_API_TOKEN` | `wrangler secret put` | No | API token for the TURN key. Used only by the Worker, never sent to the browser. |

Local development can use a `.dev.vars` file (git-ignored) for the same names.

## Develop

```sh
npm install
npm run dev          # Vite dev server (UI only; signaling needs the Worker)
npm run preview      # build + wrangler dev on http://localhost:8787 (full app)
npm run typecheck && npm test && npm run build
npm run e2e          # build + two headless Chromium players against wrangler dev
```

The e2e suite uses fake media devices, with a generated click track as the microphone. It checks:
- cross-origin isolation and that audio flows both ways;
- non-silent playout and that the HUD shows RTT;
- third-peer rejection;
- the postMessage (no SharedArrayBuffer) path;
- the μ-law and Opus codecs, compatibility mode and metronome sync;
- end-to-end click latency, logged per codec.

## Deploy ($0)

```sh
npx wrangler login
npm run deploy       # builds and runs wrangler deploy → https://jamlink.<you>.workers.dev
```

Optional TURN fallback for strict cellular NATs (Cloudflare Realtime TURN: 1,000 GB/month free,
then $0.05/GB; a one-hour relayed jam is about 0.7 GB). Create a TURN key in the dashboard, then:

```sh
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

Without these, JamLink uses free public STUN only. `/turn` hands out short-lived credentials to
anyone who loads the app. If abuse is a concern, put the Worker behind Cloudflare Access or add a
rate limit.

### Cost

| Item | Cost |
|---|---|
| Workers static assets + requests | free plan |
| Durable Object signaling (SQLite-backed, hibernating) | free plan |
| STUN | free |
| TURN (only when direct fails) | 1,000 GB/month free |
| Hardware | $0 (phone mic) to ~$10 (TRRS splitter / USB-C adapter) |

## Code map

```
worker/index.ts          router: /ws/:room, /turn, static assets + COOP/COEP
worker/room.ts           Room Durable Object (hibernation, max 2 peers, heartbeat)
src/session.ts           wires engine, signaling, peer, link; latency budget; HUD state
src/peer.ts              RTCPeerConnection, audio + control DataChannels
src/signaling.ts         WebSocket client with reconnect
src/net/packet.ts        8-byte header, seq wrap
src/net/link.ts          packetize/send, receive/decode, ping/pong
src/audio/engine.ts      AudioContext graph, worklets, setSinkId, meters
src/audio/sender.worklet.ts    capture worklet
src/audio/receiver.worklet.ts  playout worklet
src/audio/jitter.ts      adaptive jitter buffer, PLC, drift, latency cap
src/audio/ring.ts        SharedArrayBuffer SPSC ring
src/audio/codec.ts       pcm16 / μ-law
src/audio/opus.ts        WebCodecs Opus + rechunker
src/audio/fallback.ts    compatibility mode SDP munging
src/latency.ts           ping/offset math, budget, loopback test
src/metronome.ts         synced metronome
src/devices.ts           device lists, Bluetooth/USB heuristics, presets
src/ui/                  screens, hookup guide
```

## Alternatives

[SonoBus](https://sonobus.net) is a free, open-source native app built on the same ideas (P2P,
optional uncompressed audio, manual jitter buffer). Native audio paths can be lower latency than
any browser. JamLink's edge is zero install plus a guide built around the CODE. If a phone's
browser audio path turns out too slow, SonoBus is a good baseline to compare against.

## Status

Version 0.1.0. The core two-player jam, codecs, latency HUD, metronome and test suite are in place.
Phone USB audio (the CODE USB path) is not yet verified on real hardware. The app shows "USB Audio"
if the device is detected.

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm run typecheck && npm test`
and, for audio or networking changes, `npm run e2e`.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Dime Data.

See [`docs/HANDOFF.md`](docs/HANDOFF.md) for the original research and plan.
