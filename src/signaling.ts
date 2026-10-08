export type ServerMsg =
  | { type: 'joined'; polite: boolean; peers: number }
  | { type: 'peer-joined' }
  | { type: 'peer-left' }
  | { type: 'full' }
  | { type: 'sdp'; description: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit | null };

/** WebSocket signaling client with automatic reconnect (exponential backoff). */
export class Signaling {
  onMessage: ((m: ServerMsg) => void) | null = null;
  onStatus: ((s: 'connecting' | 'open' | 'closed' | 'full') => void) | null = null;
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly room: string,
    readonly clientId: string,
    private readonly base = location.origin.replace(/^http/, 'ws'),
  ) {}

  connect(): void {
    if (this.closed) return;
    this.onStatus?.('connecting');
    const ws = new WebSocket(`${this.base}/ws/${this.room}?client=${encodeURIComponent(this.clientId)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus?.('open');
      // Heartbeat, answered by the Durable Object runtime without waking it.
      this.heartbeat = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 5000);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      let m: ServerMsg;
      try {
        m = JSON.parse(e.data as string);
      } catch {
        return;
      }
      if (m.type === 'full') {
        this.closed = true;
        this.onStatus?.('full');
        ws.close(1000);
      }
      this.onMessage?.(m);
    };
    ws.onclose = (e) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed || e.code === 4001) {
        this.onStatus?.(e.code === 4001 ? 'full' : 'closed');
        return;
      }
      this.onStatus?.('closed');
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  send(m: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close(1000);
    this.ws = null;
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function newRoomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

export function normalizeRoomCode(input: string): string | null {
  const c = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{6}$/.test(c) ? c : null;
}
