import { Room } from './room';

export { Room };

export interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace<Room>;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const ROOM_RE = /^[A-Z0-9]{6}$/;

/** Free public STUN servers; TURN is only added when credentials are configured. */
const DEFAULT_ICE: RTCIceServerLike[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];

interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** COOP/COEP make the page cross-origin isolated so SharedArrayBuffer is available. */
function withIsolation(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  out.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  out.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return out;
}

async function turnServers(env: Env): Promise<RTCIceServerLike[]> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return DEFAULT_ICE;
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 3600 }),
      },
    );
    if (!r.ok) return DEFAULT_ICE;
    const body = (await r.json()) as { iceServers: RTCIceServerLike | RTCIceServerLike[] };
    const list = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
    // Port 53 is blocked by browsers and would only cause timeouts.
    for (const s of list) {
      if (Array.isArray(s.urls)) s.urls = s.urls.filter((u) => !/:53\b/.test(u));
    }
    return [...DEFAULT_ICE, ...list];
  } catch {
    return DEFAULT_ICE;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const ws = url.pathname.match(/^\/ws\/([^/]+)$/);
    if (ws) {
      const room = ws[1]!.toUpperCase();
      if (!ROOM_RE.test(room)) return new Response('bad room code', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request);
    }

    if (url.pathname === '/turn') {
      // TURN credentials cost bandwidth, so only hand them to this app's own pages
      // and only for a well-formed room code (the app has no accounts to check).
      const site = request.headers.get('Sec-Fetch-Site');
      const origin = request.headers.get('Origin');
      const sameOrigin = site ? site === 'same-origin' : !origin || origin === url.origin;
      const room = (url.searchParams.get('room') ?? '').toUpperCase();
      if (!sameOrigin || !ROOM_RE.test(room)) {
        return new Response('forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } });
      }
      const iceServers = await turnServers(env);
      return withIsolation(
        Response.json({ iceServers }, { headers: { 'Cache-Control': 'no-store' } }),
      );
    }

    return withIsolation(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;
