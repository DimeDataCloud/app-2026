import { PRESETS, isIOS, listDevices, suggestPreset, type InputPreset } from '../devices';
import { QUANTUM_MS, grade, loadDeviceRoundTrip, runLoopbackTest, saveDeviceRoundTrip } from '../latency';
import type { CodecName } from '../net/link';
import type { Hud, Session } from '../session';
import { newRoomCode, normalizeRoomCode } from '../signaling';
import { GUIDE_HTML } from './guide';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Screen = 'home' | 'setup' | 'jam' | 'guide';

const fmt = (ms: number | null | undefined, digits = 0) =>
  ms === null || ms === undefined || !Number.isFinite(ms) ? '–' : `${ms.toFixed(digits)} ms`;

export class App {
  private screen: Screen = 'home';
  private room: string | null = null;
  private meterRaf = 0;
  private readonly meterBuf = new Float32Array(512);
  private clipUntil = 0;

  constructor(private readonly s: Session) {}

  mount(): void {
    $('guide').innerHTML = GUIDE_HTML;
    for (let i = 1; i <= 16; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${i} × 2.7 ms = ${(i * QUANTUM_MS).toFixed(1)} ms`;
      $('jitter').append(o);
    }
    this.bindHome();
    this.bindSetup();
    this.bindJam();
    this.s.onHud = (h) => this.renderHud(h);
    this.s.onPhase = () => this.renderStatus();
    this.s.onMetronome = (on, bpm) => {
      $('metro-toggle').textContent = on ? 'Stop' : 'Start';
      if (on) ($('bpm') as HTMLInputElement).value = String(bpm);
    };
    window.addEventListener('hashchange', () => this.route());
    this.route();
  }

  // ---------- routing ----------
  private route(): void {
    const hash = location.hash;
    if (hash.startsWith('#/guide')) return this.show('guide');
    const m = hash.match(/^#\/r\/([A-Za-z0-9]{6})/);
    const room = m ? normalizeRoomCode(m[1]!) : null;
    if (room) {
      this.room = room;
      document.querySelectorAll('[data-room]').forEach((el) => (el.textContent = room));
      if (this.screen !== 'jam') this.show('setup');
      return;
    }
    this.show('home');
  }

  private show(screen: Screen): void {
    this.screen = screen;
    for (const id of ['home', 'setup', 'jam', 'guide'] as const) $(id).hidden = id !== screen;
    if (screen === 'setup') this.startMeter();
  }

  private go(hash: string): void {
    if (location.hash === hash) this.route();
    else location.hash = hash;
  }

  // ---------- home ----------
  private bindHome(): void {
    $('create').onclick = () => this.go(`#/r/${newRoomCode()}`);
    $('join-form').onsubmit = (e) => {
      e.preventDefault();
      const code = normalizeRoomCode(($('join-code') as HTMLInputElement).value);
      const err = $('home-error');
      if (!code) {
        err.textContent = 'Room codes are 6 letters or digits.';
        err.hidden = false;
        return;
      }
      err.hidden = true;
      this.go(`#/r/${code}`);
    };
  }

  // ---------- setup ----------
  private bindSetup(): void {
    const preset = $('preset') as HTMLSelectElement;
    const inputSel = $('input-device') as HTMLSelectElement;
    const outputSel = $('output-device') as HTMLSelectElement;
    const gain = $('gain') as HTMLInputElement;

    $('start-audio').onclick = async () => {
      const err = $('setup-error');
      err.hidden = true;
      try {
        const engine = await this.s.startAudio();
        await engine.setInput();
        await this.refreshDevices(true);
        $('start-card').hidden = true;
        $('setup-body').hidden = false;
        $('ios-note').hidden = !isIOS();
        $('sink-row').hidden = !engine.canSetSink();
        this.renderTestResult();
      } catch (e) {
        err.textContent = `Could not start audio: ${(e as Error).message}. Allow microphone access and try again.`;
        err.hidden = false;
      }
    };

    preset.onchange = () => {
      const p = PRESETS[preset.value as InputPreset];
      $('preset-hint').textContent = p.hint;
      gain.value = String(p.gain);
      this.s.engine?.setInputGain(p.gain);
      if (preset.value === 'code-usb') {
        const usb = [...inputSel.options].find((o) => /usb|marshall|code/i.test(o.text));
        if (usb && usb.value !== inputSel.value) {
          inputSel.value = usb.value;
          inputSel.dispatchEvent(new Event('change'));
        }
      }
    };
    inputSel.onchange = async () => {
      await this.s.engine?.setInput({ deviceId: inputSel.value });
      this.s.inputLabels = [inputSel.selectedOptions[0]?.text ?? ''];
    };
    outputSel.onchange = async () => {
      await this.s.engine?.setSink(outputSel.value).catch(() => {});
      this.s.inputLabels = [inputSel.selectedOptions[0]?.text ?? '', outputSel.selectedOptions[0]?.text ?? ''];
      this.renderBt();
    };
    gain.oninput = () => this.s.engine?.setInputGain(Number(gain.value));
    ($('monitor') as HTMLInputElement).onchange = (e) =>
      this.s.engine?.setMonitor((e.target as HTMLInputElement).checked);

    $('run-test').onclick = async () => {
      const btn = $('run-test') as HTMLButtonElement;
      const engine = this.s.engine;
      if (!engine) return;
      btn.disabled = true;
      $('test-result').textContent = 'Listening…';
      const rt = await runLoopbackTest(engine);
      btn.disabled = false;
      if (rt === null) {
        $('test-result').textContent = 'No clicks heard. Raise the volume or move the phone closer to its speaker, then retry.';
        return;
      }
      saveDeviceRoundTrip(rt);
      this.renderTestResult();
    };

    $('go-jam').onclick = () => {
      if (!this.room) return;
      this.stopMeter();
      this.show('jam');
      if (this.s.room !== this.room) this.s.join(this.room);
      this.renderStatus();
    };
  }

  private async refreshDevices(first = false): Promise<void> {
    const { inputs, outputs } = await listDevices();
    const fill = (sel: HTMLSelectElement, list: MediaDeviceInfo[], fallback: string) => {
      const keep = sel.value;
      sel.replaceChildren(
        ...list.map((d, i) => {
          const o = document.createElement('option');
          o.value = d.deviceId;
          o.textContent = d.label || `${fallback} ${i + 1}`;
          return o;
        }),
      );
      if (keep) sel.value = keep;
    };
    const inputSel = $('input-device') as HTMLSelectElement;
    fill(inputSel, inputs, 'Input');
    fill($('output-device') as HTMLSelectElement, outputs, 'Output');
    const current = this.s.engine?.stream?.getAudioTracks()[0]?.getSettings().deviceId;
    if (current) inputSel.value = current;
    if (first) {
      const sug = suggestPreset(inputs);
      const preset = $('preset') as HTMLSelectElement;
      preset.value = sug.preset;
      preset.dispatchEvent(new Event('change'));
    }
    this.s.inputLabels = [inputSel.selectedOptions[0]?.text ?? ''];
    this.renderBt();
  }

  private renderBt(): void {
    const h = this.s.hud();
    $('bt-warning').hidden = !h.btWarning;
  }

  private renderTestResult(): void {
    const rt = loadDeviceRoundTrip();
    const engine = this.s.engine;
    if (rt === null || !engine) {
      $('test-result').textContent = 'Not measured yet. JamLink assumes ~10 ms capture until you run it.';
      return;
    }
    const capture = this.s.captureMs();
    $('test-result').textContent =
      `Device round trip ${rt.toFixed(1)} ms (output ≈ ${engine.outputLatencyMs().toFixed(1)} ms, capture ≈ ${capture.toFixed(1)} ms).` +
      (rt > 50 ? ' This phone is slow. Consider a laptop as your endpoint.' : '');
  }

  private startMeter(): void {
    cancelAnimationFrame(this.meterRaf);
    const loop = () => {
      const e = this.s.engine;
      if (e && this.screen === 'setup') {
        const { peak } = e.levels(e.inputAnalyser, this.meterBuf);
        $('meter-bar').style.width = `${Math.min(100, peak * 100)}%`;
        const now = performance.now();
        if (peak >= 0.99) this.clipUntil = now + 1500;
        $('clip').classList.toggle('on', now < this.clipUntil);
      }
      if (this.screen === 'setup') this.meterRaf = requestAnimationFrame(loop);
    };
    this.meterRaf = requestAnimationFrame(loop);
  }

  private stopMeter(): void {
    cancelAnimationFrame(this.meterRaf);
  }

  // ---------- jam ----------
  private bindJam(): void {
    $('share').onclick = async () => {
      const url = `${location.origin}/#/r/${this.room}`;
      try {
        if (navigator.share) await navigator.share({ title: 'JamLink', text: `Jam with me: room ${this.room}`, url });
        else {
          await navigator.clipboard.writeText(url);
          $('share').textContent = 'Copied!';
          setTimeout(() => ($('share').textContent = 'Share link'), 1500);
        }
      } catch {
        /* cancelled */
      }
    };
    ($('remote-vol') as HTMLInputElement).oninput = (e) =>
      this.s.engine?.setRemoteVolume(Number((e.target as HTMLInputElement).value));
    $('metro-toggle').onclick = () => {
      if (this.s.metronome?.running) this.s.stopMetronome();
      else this.s.startMetronome(Math.max(40, Math.min(240, Number(($('bpm') as HTMLInputElement).value) || 100)));
    };
    ($('guard') as HTMLInputElement).onchange = (e) => this.s.setGuard((e.target as HTMLInputElement).checked);
    ($('jitter') as HTMLSelectElement).onchange = (e) => {
      const v = (e.target as HTMLSelectElement).value;
      this.s.setJitter(v === 'auto' ? 'auto' : Number(v));
    };
    ($('codec') as HTMLSelectElement).onchange = async (e) => {
      const sel = e.target as HTMLSelectElement;
      try {
        await this.s.setCodec(sel.value as CodecName);
      } catch (err) {
        alert((err as Error).message);
        sel.value = this.s.link?.codec ?? 'pcm16';
      }
    };
    ($('ppq') as HTMLSelectElement).onchange = (e) => this.s.setQuantaPerPacket(Number((e.target as HTMLSelectElement).value));
    ($('compat') as HTMLInputElement).onchange = (e) => this.s.setCompat((e.target as HTMLInputElement).checked);
    $('back-setup').onclick = () => this.show('setup');
    $('leave').onclick = () => {
      this.s.leave();
      this.go('#/');
    };
    let lastBeat = -1;
    const beatEl = $('beat');
    const wire = () => {
      if (!this.s.metronome) return setTimeout(wire, 500);
      this.s.metronome.onBeat = (i) => {
        if (i === lastBeat) return;
        lastBeat = i;
        beatEl.className = `beat ${i % 4 === 0 ? 'accent' : 'on'}`;
        setTimeout(() => (beatEl.className = 'beat'), 100);
      };
    };
    wire();
  }

  private renderStatus(): void {
    const st = $('status');
    const text: Record<string, string> = {
      idle: 'Not connected.',
      waiting: 'Waiting for your partner… share the link.',
      connecting: 'Connecting…',
      connected: 'Live: you are connected peer-to-peer.',
      full: 'This room already has two players.',
      error: 'Something went wrong.',
    };
    st.textContent = text[this.s.phase] ?? '';
    st.classList.toggle('live', this.s.phase === 'connected');
  }

  private renderHud(h: Hud): void {
    if (this.screen !== 'jam') return;
    const live = h.phase === 'connected';
    const setTotal = (id: string, ms: number | null) => {
      const el = $(id);
      el.textContent = ms === null || !live ? '–' : `${Math.round(ms)} ms`;
      el.className = `big-ms ${ms === null || !live ? '' : grade(ms)}`;
    };
    setTotal('in-total', h.inbound.total);
    setTotal('out-total', h.outbound?.total ?? null);
    const worst = Math.max(h.inbound.total, h.outbound?.total ?? 0);
    const bar = $('budget-bar');
    bar.style.width = live ? `${Math.min(100, (worst / (h.budgetMs * 1.5)) * 100)}%` : '0';
    bar.style.background = `var(--${grade(worst)})`;

    $('h-rtt').textContent = fmt(h.rttMs, 1);
    $('h-jitter').textContent = h.recv
      ? `${fmt(h.inbound.jitterMs, 1)} (cap ${(h.maxDepth * QUANTUM_MS).toFixed(0)})`
      : fmt(h.inbound.jitterMs, 1);
    $('h-output').textContent = fmt(h.outputMs, 1);
    $('h-pcap').textContent = fmt(h.inbound.captureMs, 1);
    $('h-packet').textContent = `${fmt(h.inbound.packetMs, 1)} · ${h.rxRate}/s in · ${h.txRate}/s out`;
    $('h-loss').textContent = h.recv ? `${h.lossPct.toFixed(1)}% · ${h.recv.late} late` : '–';
    $('h-route').textContent = h.conn
      ? `${h.conn.relay ? 'TURN relay' : 'direct'} (${h.conn.localType}/${h.conn.protocol})`
      : '–';
    $('h-codec').textContent = h.compat ? 'compatibility (Opus track)' : `${h.codec} · ${Math.round(h.kbpsOut)} kbps`;

    const warn: string[] = [];
    if (h.btWarning) warn.push('Bluetooth adds ~150–300 ms. Use wired for tight playing.');
    if (live && worst >= h.budgetMs) {
      const big = Object.entries({
        'your output path': h.outputMs,
        network: h.inbound.networkMs,
        "partner's capture": h.inbound.captureMs,
      }).sort((a, b) => b[1] - a[1])[0]!;
      warn.push(`Over the ${h.budgetMs} ms budget. Biggest part: ${big[0]} (${big[1].toFixed(0)} ms).`);
    }
    if (h.compat) warn.push('Compatibility mode: standard WebRTC audio, higher latency.');
    if (h.conn?.relay) warn.push('Relayed via TURN (direct connection blocked). Expect a few extra ms.');
    const w = $('hud-warn');
    w.hidden = warn.length === 0;
    w.textContent = warn.join(' ');

    if (h.recv) {
      $('out-meter').style.width = `${Math.min(100, h.recv.peak * 100)}%`;
    }
    ($('compat') as HTMLInputElement).checked = h.compat;
    this.renderStatus();
  }
}
