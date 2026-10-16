> **For the next Claude session**
> - Goal: build **JamLink** as described below, starting at **milestone 1** of the build order.
> - Develop on a fresh `claude/*` branch, verify each milestone with the Verification steps, and open a draft PR.
> - These decisions are already made: Cloudflare hosting, 2 players, and raw PCM over an unordered WebRTC DataChannel. Don't re-litigate them. If you find new evidence against one, flag it to the user instead.

# JamLink: a $0, low-latency 2-player guitar jam web app

## Context
Two guitarists in the same country want to jam remotely and hear each other as close to real time as possible. One player uses a **Marshall CODE 50**. The app runs in a phone browser, with no native install and no audio interface required. It accepts input from the amp's output or the phone mic, and plays back through the speaker, headphones, the amp's AUX, or Bluetooth (with a warning).

Repo `jamlink` (originally `app-2026`) started empty, so this was a greenfield build.

User decisions: Cloudflare hosting, 2 players with peer-to-peer audio, same country (~15–35 ms network one-way). The follow-up ask was to find the **cheapest approach that doesn't compromise latency** and to learn from existing tools.

## What others have done (research summary)
| Tool | Approach | Takeaway for us |
|---|---|---|
| **SonoBus** (free, OSS, native iOS/Android/desktop) | P2P, optional **uncompressed PCM**, manual jitter buffer, **no echo cancellation**, headphones required | The closest model. Copy its P2P design, PCM option, user-tunable jitter buffer and "measure, don't trust" latency readout. It also proves a $0 baseline exists, so our edge is zero install plus a hookup guide built around the CODE. |
| **Jamulus / NINJAM** | Central server mixes everyone (Jamulus); NINJAM deliberately delays a full bar | A server hop adds latency. Not needed for 2 players. NINJAM's "delay by a bar" idea is a fallback only for long distances. |
| **JackTrip** | Uncompressed multichannel, native | Native code gets 5–10 ms local audio paths that browsers can't match. |
| **JackTrip WebRTC research** (Sacchetto et al., JAES 2022) | Browser: **16-bit PCM over an RTCDataChannel + AudioWorklets + SharedArrayBuffer** | **The key finding.** Standard WebRTC audio tracks measured **60 ms at best, 80–180 ms typical** on a LAN (Meet and Jitsi about 120 ms), because Opus plus the NetEQ jitter buffer are tuned for speech. PCM over an unordered DataChannel with AudioWorklets reached **15–40 ms** mouth-to-ear on a LAN, including a ~21 ms de-jitter buffer. Firefox beat Chrome, and macOS beat Windows. |
| JamKazam / FarPlay / Jamstud.io / OpenStudio | Paid, native, or a browser UI that needs a local helper app | "Browser-only" low-latency claims usually hide a native bridge. We stay truly browser-only and say what latency to expect. |

**Conclusion:** using normal WebRTC audio tracks (the obvious approach) would waste 30–100 ms. The cheapest path that doesn't compromise latency is **raw PCM over a WebRTC DataChannel, with AudioWorklets and our own small jitter buffer**. Standard WebRTC still handles connection setup, encryption and NAT traversal for free.

## Cost: about $0
- **Hosting**: Cloudflare Workers free plan serves static assets plus a SQLite-backed Durable Object for signaling (included on free). It uses a few requests per session.
- **NAT traversal**: free Google STUN. When direct connection fails (strict cellular NAT), fall back to Cloudflare TURN, which has **1,000 GB/month free**. A 1-hour relayed jam at ~0.8 Mbps each way is about 0.7 GB.
- **Hardware**: $0 using the phone mic, or about $10 for a TRRS splitter or USB-C headset adapter. Optionally try the CODE's USB port direct to Android via OTG ($0–8 cable; unverified, so the app auto-detects it).
- No paid SDKs, SFU or media server.

## Realistic latency budget (one-way, same country)
| Stage | Good case | Typical phone |
|---|---|---|
| Phone input capture (browser) | 5–10 ms | 10–25 ms |
| Packetization (128-sample blocks @48 kHz) | 2.7 ms | 5.3 ms |
| Network | 15 ms | 25–35 ms (+ Wi-Fi jitter) |
| Our jitter buffer | 5 ms | 10–20 ms |
| Phone output (browser) | 5–10 ms | 10–40 ms (**Bluetooth +150–300 ms**) |
| **Total** | **~35 ms** | **~60–120 ms** |

Under ~30–40 ms feels "together", and 40–60 ms is playable for loose grooves. The app **measures and shows** each stage. Tips to reach the good case: wired headphones, 5 GHz Wi-Fi near the router, Chrome on Android (or Firefox or Chrome on a laptop as an endpoint), and no Bluetooth.

## Architecture
```
Phone A                                                    Phone B
mic/USB → AudioWorklet(Sender) ─PCM packets─► RTCDataChannel ─► AudioWorklet(Receiver) → speaker/headphones/amp AUX
            ▲ (SharedArrayBuffer ring)   {ordered:false, maxRetransmits:0}     (adaptive jitter ring + PLC)
            └──── the same path runs in the reverse direction ─────────────────┘
Signaling only: WebSocket ↔ Cloudflare Worker + Durable Object "Room" (max 2 peers)
```
- **Transport**: `RTCPeerConnection` with **no media tracks**, only a DataChannel `{ordered:false, maxRetransmits:0}`. This is UDP-like, encrypted and NAT-traversed. A second, reliable DataChannel carries control traffic (metronome, ping, settings).
- **Capture**: `getUserMedia({audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1, sampleRate:48000}})` → `MediaStreamAudioSourceNode` → `AudioWorkletNode('jam-sender')`. The guitar is mono, which halves bandwidth.
- **Sender worklet**: copies each 128-frame render quantum into a SharedArrayBuffer ring. The worklet pings the main thread through its MessagePort for each quantum (no copying). The main thread then reads the ring and calls `dc.send()`. Chrome can't transfer DataChannels to workers, so sending stays on a lean main thread with no framework re-renders on the hot path. The packet is a header (`seq u16`, `sampleTime u32`, `codec u8`) plus N quanta. N=1 (2.7 ms) by default, N=2 if packet rate struggles.
- **Payload codecs** (selectable, with zero algorithmic delay first):
  1. `pcm16` mono 48 kHz, about 770 kbps. The default.
  2. `mulaw8` mono 48 kHz, about 385 kbps. For weak uplinks. Still zero added latency, with slight hiss.
  3. `opus` via WebCodecs `AudioEncoder` at `frameDuration:2500` and 96 kbps. Used only if `isConfigSupported` passes. Adds about 5–7 ms, and is for cellular or bad links.
- **Receiver worklet**: an adaptive jitter ring keyed by `seq`. Target depth = user slider (Auto | 1–16 quanta). Auto tracks inter-arrival jitter (an EWMA of the p95). Late packets are dropped. Loss concealment repeats the last quantum with a fade, and fades to silence after 3 missing quanta. Mild drift correction drops or duplicates one sample when buffer depth drifts, to absorb clock skew between the two phones.
- **Cross-origin isolation**: the Worker serves `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` so SharedArrayBuffer is available. If isolation is unavailable, it falls back to `port.postMessage`, which is slightly slower.
- **Compatibility fallback**: when DataChannel or AudioWorklet fail (rare), use a standard Opus media track with munged SDP (`ptime=10; usedtx=0; useinbandfec=1; maxaveragebitrate=128000`) and `jitterBufferTarget=0`. The UI labels this "compatibility mode (higher latency)".

## Features (MVP)
1. **Room**: create (6-char code + share link) or join. One tap connects.
2. **Setup**: input picker plus gain, a level meter with a clip light, and an input-source preset (CODE USB / CODE phones-out / phone mic). Output picker via `setSinkId` where supported. On iOS, a note says to route via Control Center. Remote volume, and a local-monitor toggle (off by default, because the amp already monitors).
3. **Device latency test**: the phone plays clicks and records them back (a speaker→mic loop, or a cable loop), measures the device's round-trip time, and stores it. Modeled on the Superpowered latency test idea.
4. **Live latency HUD**: network RTT (DataChannel ping every 500 ms), jitter-buffer depth, `baseLatency + outputLatency`, device-test result, and an estimated one-way total. Green under 40 ms, amber 40–70, red over 70. Also shows loss %, connection type (direct vs TURN relay) and codec.
5. **Bluetooth warning**: if the device label matches /bluetooth|airpods|buds|bt|headset/i, or `outputLatency` is over 100 ms, show "Bluetooth adds ~150–300 ms — use wired for tight playing." Bluetooth still works.
6. **Synced metronome**: one player sets BPM and start. Start time travels over the control channel with an RTT/2 clock offset, and each phone generates its own click locally, so both players play to the same grid. This is the strongest practical help against residual delay.
7. **Hookup guide** (in-app page): illustrated, interface-free wiring options (below).

## Hookup guide (no audio interface)
**Guitar/amp → phone**
- **A. CODE USB → Android (try first, $0–8)**: USB-B/mini-USB to USB-C OTG cable. The CODE works as a driverless USB audio input on computers (user reports). On phones it's unverified, so the app lists "USB Audio" if it appears.
- **B. CODE PHONES out → phone mic input (~$10)**: 3.5 mm cable → TRRS splitter (CTIA) or a USB-C headset adapter with mic input. Keep the amp volume low, or add a cheap inline attenuator, because mic inputs clip easily. The guide notes this risk explicitly.
- **C. Phone mic near the speaker ($0)**: works anywhere. Processing stays off so the tone stays natural.

**Phone → ears**
- Wired headphones are best. Or phone headphone out → the **CODE AUX IN**, so the partner plays through the amp. Phone speaker is fine. CODE Bluetooth streaming and BT headphones work but add 150–300 ms, with a warning.
- Feedback caveat: if the remote audio plays through the amp while using option C, use headphones or option A/B instead.

## File layout
```
package.json, tsconfig.json, vite.config.ts, wrangler.toml (assets + DO binding, COOP/COEP headers)
worker/index.ts         – router: /ws/:room, /turn (CF TURN creds if TURN_KEY set), static assets + isolation headers
worker/room.ts          – Room Durable Object (WebSocket hibernation, max 2 peers, relays offer/answer/ICE)
src/main.ts             – bootstrap + screen routing (home / setup / jam / guide)
src/signaling.ts        – WS client with reconnect
src/peer.ts             – RTCPeerConnection, audio + control DataChannels, ICE config, TURN fetch
src/audio/engine.ts     – AudioContext({latencyHint:0, sampleRate:48000}), graph, setSinkId, meters
src/audio/sender.worklet.ts / receiver.worklet.ts – capture/playout, jitter ring, PLC, drift
src/audio/ring.ts       – SharedArrayBuffer SPSC ring (shared by worklets + worker)
src/audio/codec.ts      – pcm16 / mulaw8 pack-unpack, WebCodecs Opus wrapper
src/audio/fallback.ts   – media-track compatibility mode + SDP munging
src/net/packet.ts       – header encode/decode, seq wrap handling
src/latency.ts          – ping RTT, HUD aggregation, device loopback test
src/metronome.ts        – clock offset + scheduled clicks
src/devices.ts          – enumerateDevices, Bluetooth/USB heuristics
src/ui/*.ts, styles.css, public/manifest.webmanifest
tests/*.test.ts         – Vitest unit tests
README.md               – deploy (`npx wrangler deploy`), cost notes, hookup summary
```

## Verification
- `npm run typecheck && npm test && npm run build`. Unit tests cover the packet codec (seq wrap), μ-law round-trip error, a jitter ring under simulated reorder/loss/jitter (asserting bounded depth and PLC), clock-offset math, the Bluetooth heuristic and SDP munging.
- `npx wrangler dev`, then two Playwright Chromium contexts with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (Chromium at `/opt/pw-browsers`) join the same room. Assert `crossOriginIsolated === true`, the DataChannel opens, received packet count rises, the receiver worklet outputs non-silent audio, and the HUD shows RTT. A third peer is rejected.
- Loopback latency check: inject a click into the fake input in context A, detect it in B's output via an AnalyserNode, and log end-to-end ms on localhost (expect under 30 ms).
- Manual: deploy to workers.dev and test two phones on different networks. Compare DataChannel PCM against compatibility mode on the HUD, and try hookups A/B/C.

## Build order (milestones)
1. **Scaffold**: Vite + TS, `wrangler.toml` with assets, DO binding and COOP/COEP headers. Room DO and signaling. Two tabs exchange offer and answer.
2. **Audio path**: sender and receiver worklets, SAB ring, `pcm16` over the unordered DataChannel, fixed jitter depth. Fake-media Playwright test proves audio flows.
3. **Adaptive jitter + PLC + drift**, plus the Vitest simulation tests.
4. **Latency HUD + device loopback test**.
5. **Setup screen**: devices, `setSinkId`, Bluetooth and USB heuristics, gain and meters.
6. **Codecs**: `mulaw8`, then WebCodecs Opus at 2.5 ms (feature-detected). Then compatibility mode.
7. **Metronome**, **hookup guide**, PWA manifest, README with deploy steps.
8. Deploy to workers.dev and test on real phones.

## Open risks / things to verify early
- **Phone browser audio I/O latency** is the biggest unknown and varies a lot by device. Run the loopback test on both players' actual phones in milestone 4, before polishing. If one phone is bad, a laptop running Firefox or Chrome is the escape hatch, since the app works there too.
- **CODE USB → phone** is unverified (only computer use is reported). Hookup B is the guaranteed ~$10 path.
- **SharedArrayBuffer on iOS Safari** needs cross-origin isolation, which is supported. Keep the postMessage fallback.
- **Chrome DataChannel at 375 packets/s**: if the send loop stutters, switch to N=2 quanta per packet (5.3 ms).
- **Phone mic inputs clip** with amp line levels. The guide needs a clear "start with the amp volume low" step.
- A ready-made $0 alternative exists today: **SonoBus** (native app). Mention it in the README as a comparison baseline.

## Sources
- Sacchetto, Servetti, Chafe et al., "Web-Based Networked Music Performances via WebRTC: A Low-Latency PCM Audio Solution", JAES 70(11), 2022: https://iris.polito.it/bitstream/11583/2974022/1/JackTrip_WebRTC_Journal.post-print.pdf
- SonoBus user guide: https://sonobus.net/sonobus_userguide.html
- MDN `RTCRtpReceiver.jitterBufferTarget`: https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget
- MDN `AudioEncoder.configure` (Opus `frameDuration`): https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder/configure
- W3C Opus WebCodecs registration: https://www.w3.org/TR/webcodecs-opus-codec-registration/
- Cloudflare Realtime/TURN pricing (1,000 GB free, then $0.05/GB): https://developers.cloudflare.com/realtime/pricing/
- Marshall CODE USB recording (user report): https://my.marshall.com/forum/question/2322/marshall-code-50-,-audio-interface-and-daw
- WebRTC jitter buffer (NetEQ) background: https://webrtchacks.com/how-webrtcs-neteq-jitter-buffer-provides-smooth-audio/
- Native-vs-browser argument (jamrtc): https://github.com/lminiero/jamrtc

