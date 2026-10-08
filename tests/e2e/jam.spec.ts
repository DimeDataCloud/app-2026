import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Jam = any;

const newRoom = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  // Each player holds an AudioContext and a peer connection; free them between tests.
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});

async function openPlayer(browser: Browser, room: string, query = ''): Promise<Page> {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') console.log(`[${room}] ${m.type()}: ${m.text()}`);
  });
  await page.goto(`/${query}#/r/${room}`);
  await page.click('#start-audio');
  await expect(page.locator('#setup-body')).toBeVisible();
  await page.click('#go-jam');
  return page;
}

const jam = (page: Page, fn: (j: Jam) => unknown) =>
  page.evaluate(`(${fn.toString()})(globalThis.__jam)`) as Promise<any>;

/**
 * End-to-end click latency A → B: A's capture worklet sees each click of the
 * fake microphone, B's playout worklet renders it. Both pages share the
 * machine clock, so the difference is the in-app path; B's reported output
 * latency is added separately.
 */
async function measureClicks(a: Page, b: Page, ms = 6000) {
  const now = 'performance.timeOrigin + performance.now()';
  await a.evaluate(`(() => { const j = globalThis.__jam; j.cap = [];
    j.session.engine.onSenderOnset = () => j.cap.push(${now});
    j.session.engine.detectOnsets('sender', true, 0.3); })()`);
  await b.evaluate(`(() => { const j = globalThis.__jam; j.out = [];
    j.session.engine.onReceiverOnset = () => j.out.push(${now});
    j.session.engine.detectOnsets('receiver', true, 0.3); })()`);
  await a.waitForTimeout(ms);
  const cap: number[] = await jam(a, (j) => j.cap);
  const out: number[] = await jam(b, (j) => j.out);
  const outputMs: number = await jam(b, (j) => j.session.engine.outputLatencyMs());
  const lat: number[] = [];
  for (const t of out) {
    const c = cap.filter((x) => x <= t).at(-1);
    if (c !== undefined && t - c < 400) lat.push(t - c);
  }
  lat.sort((x, y) => x - y);
  const median = lat[lat.length >> 1] ?? Infinity;
  const hud = await jam(b, (j) => j.session.hud());
  const summary =
    `click A→B in-app median ${median.toFixed(1)} ms (max ${(lat.at(-1) ?? NaN).toFixed(1)}, n=${lat.length})` +
    ` + B output ${outputMs.toFixed(1)} ms | HUD inbound ${hud.inbound.total.toFixed(1)} ms,` +
    ` jitter ${hud.inbound.jitterMs.toFixed(1)} ms, rtt ${hud.rttMs?.toFixed(2)} ms, loss ${hud.lossPct.toFixed(2)}%`;
  return { median, outputMs, count: lat.length, summary };
}

test('two players connect and hear each other with low latency; a third is rejected', async ({ browser }) => {
  const room = newRoom();
  const a = await openPlayer(browser, room);
  const b = await openPlayer(browser, room);

  // Cross-origin isolation → SharedArrayBuffer rings are in use.
  expect(await jam(a, (j) => j.isolated && j.session.engine.shared)).toBe(true);

  for (const p of [a, b]) {
    await expect.poll(() => jam(p, (j) => j.session.hud().dcOpen), { timeout: 30_000 }).toBe(true);
  }

  // Audio flows both ways and the receiver worklet renders non-silent output.
  for (const p of [a, b]) {
    await expect.poll(() => jam(p, (j) => j.session.link.stats.received), { timeout: 10_000 }).toBeGreaterThan(500);
    await expect.poll(() => jam(p, (j) => j.session.recv?.peak ?? 0), { timeout: 10_000 }).toBeGreaterThan(0.1);
  }

  // HUD shows a network RTT.
  await expect(a.locator('#h-rtt')).toHaveText(/\d+(\.\d)? ms/, { timeout: 10_000 });
  await expect(a.locator('#in-total')).toHaveText(/\d+ ms/);

  const pcm = await measureClicks(a, b);
  console.log(`pcm16 ${pcm.summary}`);
  expect(pcm.count).toBeGreaterThanOrEqual(6);
  expect(pcm.median + pcm.outputMs).toBeLessThan(30);

  // A third player is turned away.
  const c = await openPlayer(browser, room);
  await expect.poll(() => jam(c, (j) => j.session.phase), { timeout: 10_000 }).toBe('full');
  await expect(c.locator('#status')).toHaveText(/already has two players/);

  // The two players are still connected.
  expect(await jam(a, (j) => j.session.hud().dcOpen)).toBe(true);
});

test('audio also flows without SharedArrayBuffer (postMessage fallback)', async ({ browser }) => {
  const room = newRoom();
  const a = await openPlayer(browser, room, '?noshared');
  const b = await openPlayer(browser, room, '?noshared');
  expect(await jam(a, (j) => j.session.engine.shared)).toBe(false);
  for (const p of [a, b]) {
    await expect.poll(() => jam(p, (j) => j.session.recv?.peak ?? 0), { timeout: 30_000 }).toBeGreaterThan(0.1)
      .catch(async (e) => {
        for (const q of [a, b]) {
          console.log('DIAG', JSON.stringify(await jam(q, (j) => ({ phase: j.session.phase, sig: j.session.sigStatus,
            pc: j.session.peer?.pc.connectionState, ice: j.session.peer?.pc.iceConnectionState,
            sigState: j.session.peer?.pc.signalingState, polite: j.session.peer?.polite, dc: j.session.peer?.audio.readyState, trace: j.session.trace }))));
        }
        throw e;
      });
  }
});

async function connectedPair(browser: Browser): Promise<[Page, Page]> {
  const room = newRoom();
  const a = await openPlayer(browser, room);
  const b = await openPlayer(browser, room);
  for (const p of [a, b]) {
    await expect.poll(() => jam(p, (j) => j.session.hud().dcOpen), { timeout: 30_000 }).toBe(true);
  }
  return [a, b];
}

/** Peak level at the receiving page's speaker output (any path). */
const outPeak = (p: Page) =>
  jam(p, (j) => j.session.engine.levels(j.session.engine.outAnalyser, new Float32Array(4096)).peak);

test('mu-law and WebCodecs Opus (2.5 ms frames) carry audio with low latency', async ({ browser }) => {
  const [a, b] = await connectedPair(browser);
  await a.waitForTimeout(500); // hello exchange tells A whether B decodes Opus
  const supported = await a.evaluate(`globalThis.__jam.session.setCodec('opus').then(() => true, () => false)`);
  test.skip(!supported, 'WebCodecs Opus unavailable in this browser build');
  for (const c of ['mulaw8', 'opus'] as const) {
    await a.evaluate(`globalThis.__jam.session.setCodec('${c}')`);
    await a.waitForTimeout(1000);
    const r = await measureClicks(a, b, 4000);
    console.log(`${c} ${r.summary}`);
    expect(r.count).toBeGreaterThanOrEqual(4);
    expect(r.median + r.outputMs).toBeLessThan(c === 'opus' ? 40 : 30);
  }
  const before: number = await jam(b, (j) => j.session.link.stats.received);
  await expect.poll(() => jam(b, (j) => j.session.link.stats.received), { timeout: 10_000 }).toBeGreaterThan(before + 300);
  await expect(a.locator('#h-codec')).toHaveText(/opus/);
  await b.waitForTimeout(600); // let a stats window pass that is all Opus
  await expect.poll(() => jam(b, (j) => j.session.recv?.peak ?? 0), { timeout: 10_000 }).toBeGreaterThan(0.1);
});

test('compatibility mode switches both sides to a standard media track', async ({ browser }) => {
  const [a, b] = await connectedPair(browser);
  await a.click('details.card summary');
  await a.check('#compat');
  await expect.poll(() => jam(b, (j) => j.session.compat), { timeout: 10_000 }).toBe(true);
  // DataChannel audio stops; sound keeps arriving over the RTP track.
  await expect.poll(() => jam(b, (j) => j.session.peer.pc.getReceivers().some((r: any) => r.track?.kind === 'audio')),
    { timeout: 15_000 }).toBe(true);
  await expect.poll(() => outPeak(b), { timeout: 15_000, intervals: [50] }).toBeGreaterThan(0.05);
  await expect(b.locator('#h-codec')).toHaveText(/compatibility/);
});

test('metronome start time is shared over the control channel', async ({ browser }) => {
  const room = newRoom();
  const a = await openPlayer(browser, room);
  const b = await openPlayer(browser, room);
  for (const p of [a, b]) {
    await expect.poll(() => jam(p, (j) => j.session.hud().dcOpen), { timeout: 30_000 }).toBe(true);
  }
  await a.waitForTimeout(1500); // a few pings for the clock offset
  await a.fill('#bpm', '120');
  await a.click('#metro-toggle');
  await expect.poll(() => jam(b, (j) => j.session.metronome.running)).toBe(true);
  await expect(b.locator('#bpm')).toHaveValue('120');
  await a.click('#metro-toggle');
  await expect.poll(() => jam(b, (j) => j.session.metronome.running)).toBe(false);
});

test('serves the hookup guide and manifest', async ({ page }) => {
  await page.goto('/#/guide');
  await expect(page.locator('#guide')).toContainText('CODE USB');
  const r = await page.request.get('/manifest.webmanifest');
  expect(r.ok()).toBe(true);
  expect(r.headers()['cross-origin-embedder-policy']).toBe('require-corp');
});
