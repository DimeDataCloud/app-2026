import { DurableObject } from 'cloudflare:workers';

/**
 * Signaling room for exactly two peers. Uses the WebSocket Hibernation API so an
 * idle room costs nothing. The DO only relays offer/answer/ICE; audio never
 * touches Cloudflare (it flows peer-to-peer over WebRTC).
 *
 * Server → client messages:
 *   {type:'joined', polite, peers}   on connect (peers = other peers present)
 *   {type:'peer-joined'}             the other peer arrived
 *   {type:'peer-left'}               the other peer left
 *   {type:'full'}                    room already has 2 peers (socket is then closed)
 * Anything else a client sends is relayed verbatim to the other peer.
 */
export const MAX_PEERS = 2;

function send(ws: WebSocket, m: string | object): void {
  try {
    ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  } catch {
    /* peer went away mid-send */
  }
}

interface Attachment {
  clientId: string;
  joinedAt: number;
  /** Turned away because the room was full; not a participant. */
  rejected?: boolean;
}

/** Clients send "ping" every 5 s; a socket silent for longer than this is a ghost. */
const STALE_MS = 15_000;

export class Room extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object (keeps hibernation free).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const clientId = (url.searchParams.get('client') ?? crypto.randomUUID()).slice(0, 64);

    // A reconnecting client replaces its own stale socket instead of counting twice.
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.clientId === clientId) {
        try {
          ws.close(4000, 'replaced');
        } catch {
          /* already closed */
        }
      }
    }

    // Evict sockets whose client vanished without closing (phone died, network
    // switched), so they can't hold a seat or pair with the newcomer.
    const now = Date.now();
    for (const ws of this.live()) {
      const seen = Math.max(
        this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0,
        this.attachment(ws)?.joinedAt ?? 0,
      );
      if (now - seen > STALE_MS) {
        try {
          ws.close(4002, 'stale');
        } catch {
          /* already closed */
        }
      }
    }

    const others = this.live().filter((ws) => this.attachment(ws)?.clientId !== clientId);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    if (others.length >= MAX_PEERS) {
      // Accepted via the hibernation API too: the runtime then owns its teardown.
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ clientId, joinedAt: Date.now(), rejected: true } satisfies Attachment);
      send(server, { type: 'full' });
      server.close(4001, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ clientId, joinedAt: Date.now() } satisfies Attachment);
    // The newcomer is "polite": it yields on offer glare (perfect negotiation).
    server.send(JSON.stringify({ type: 'joined', polite: others.length > 0, peers: others.length }));
    for (const o of others) send(o, { type: 'peer-joined' });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > 64 * 1024) return;
    for (const o of this.live()) if (o !== ws) send(o, message);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {
      /* already closed */
    }
    this.left(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.left(ws);
  }

  private left(ws: WebSocket): void {
    if (this.attachment(ws)?.rejected) return;
    const id = this.attachment(ws)?.clientId;
    const rest = this.live().filter((o) => o !== ws);
    // A socket replaced by the same client's reconnect is not a departure.
    if (rest.some((o) => this.attachment(o)?.clientId === id)) return;
    for (const o of rest) send(o, { type: 'peer-left' });
  }

  private live(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN && !this.attachment(ws)?.rejected);
  }

  private attachment(ws: WebSocket): Attachment | null {
    return ws.deserializeAttachment() as Attachment | null;
  }
}
