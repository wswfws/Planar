import { parseDocument } from '../core/document';
import type { CollabInfo, Editor, RemotePeer } from '../core/editor';
import { ChangeTracker, type Op } from '../core/ops';
import type { PlanarDocument } from '../core/types';

export interface CollabOptions {
  /** Server address, e.g. https://planar.example.com (ws/wss also accepted). */
  serverUrl: string;
  roomId: string;
  name: string;
  color: string;
  token?: string;
  /** Upload this document if the room does not exist yet. */
  createWith?: PlanarDocument;
  /** Link others can open to join. */
  shareUrl: string;
  /** WebSocket implementation (defaults to the global one). */
  WebSocketImpl?: typeof WebSocket;
}

const FLUSH_MS = 40;
const PRESENCE_MS = 50;

/** Turns a server address into its WebSocket endpoint. */
export function socketUrl(serverUrl: string): string {
  let url = serverUrl.trim().replace(/\/+$/, '');
  if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/^http(s?):/i, 'ws$1:');
  return url.endsWith('/ws') ? url : `${url}/ws`;
}

function opKey(op: Op): string {
  return op.o === 'node' ? `n:${op.id}` : `m:${op.key}`;
}

/**
 * Keeps an editor in sync with a room on a Planar server.
 *
 * Local changes are found by diffing against what was last shared and sent
 * in small batches. Layers with unacknowledged local changes are "pending":
 * remote ops for them are ignored, because the local op reaches the server
 * later and wins there as well, so all clients converge.
 */
export class CollabClient {
  private ws: WebSocket | null = null;
  private tracker = new ChangeTracker();
  private seq = 0;
  private pending = new Map<string, number>();
  private unacked = new Map<number, Op[]>();
  private joined = false;
  private closed = false;
  private retries = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPresence = '';
  private unsubscribe: (() => void)[] = [];
  private peers = new Map<string, RemotePeer>();
  private info: CollabInfo;

  constructor(
    private readonly editor: Editor,
    private readonly opts: CollabOptions,
  ) {
    this.info = {
      status: 'connecting',
      roomId: opts.roomId,
      shareUrl: opts.shareUrl,
      serverUrl: opts.serverUrl,
      peers: [],
      error: null,
      leave: () => this.stop(),
    };
  }

  start(): void {
    this.editor.collab = this.info;
    this.editor.emit();
    this.unsubscribe.push(
      this.editor.subscribe(() => {
        this.scheduleFlush();
        this.schedulePresence();
      }),
      this.editor.onPointer(() => this.schedulePresence()),
    );
    this.connect();
  }

  /** Leaves the room; the editor keeps a local copy of the document. */
  stop(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this.unsubscribe.forEach((u) => u());
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.ws?.close();
    this.editor.collab = null;
    this.editor.setAutosave(true);
    this.editor.emit();
  }

  /** Waits until every local change has been acknowledged (tests, leaving). */
  async settled(timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.flush();
      if (this.joined && !this.unacked.size) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Collaboration did not settle in time');
  }

  get status(): CollabInfo['status'] {
    return this.info.status;
  }

  // ---------------------------------------------------------------- socket

  private setStatus(status: CollabInfo['status'], error: string | null = null): void {
    this.info = { ...this.info, status, error, peers: [...this.peers.values()] };
    if (!this.closed) {
      this.editor.collab = this.info;
      this.editor.emit();
    }
  }

  private connect(): void {
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new WS(socketUrl(this.opts.serverUrl));
    } catch (e) {
      this.setStatus('error', `Cannot connect: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      ws.send(
        JSON.stringify({
          t: 'hello',
          room: this.opts.roomId,
          name: this.opts.name,
          color: this.opts.color,
          token: this.opts.token,
          doc: this.joined ? undefined : this.opts.createWith,
        }),
      );
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)));
    ws.onclose = () => {
      if (this.closed || this.info.status === 'error') return;
      this.ws = null;
      this.setStatus('reconnecting');
      const delay = Math.min(10_000, 500 * 2 ** this.retries++);
      setTimeout(() => !this.closed && this.connect(), delay);
    };
    ws.onerror = () => {
      if (!this.joined && this.retries > 2) {
        this.setStatus('error', 'Cannot reach the collaboration server');
        ws.close();
      }
    };
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: Record<string, unknown>): void {
    switch (msg.t) {
      case 'welcome':
        this.onWelcome(msg);
        break;
      case 'ack': {
        const seq = Number(msg.seq);
        this.unacked.delete(seq);
        for (const [k, s] of this.pending) if (s <= seq) this.pending.delete(k);
        break;
      }
      case 'ops':
        this.onRemoteOps(msg.ops as Op[]);
        break;
      case 'presence': {
        const peer = this.peers.get(String(msg.from));
        if (peer) {
          peer.presence = {
            pageId: String(msg.pageId),
            cursor: (msg.cursor as { x: number; y: number } | null) ?? null,
            selection: (msg.selection as string[]) ?? [],
          };
          this.editor.collab = { ...this.info, peers: [...this.peers.values()] };
          this.info = this.editor.collab;
          this.editor.requestRedraw();
        }
        break;
      }
      case 'join': {
        const p = msg.peer as RemotePeer;
        this.peers.set(p.id, { ...p, presence: p.presence ?? null });
        this.setStatus(this.info.status);
        break;
      }
      case 'leave':
        this.peers.delete(String(msg.id));
        this.setStatus(this.info.status);
        break;
      case 'error':
        if (msg.fatal) {
          this.setStatus('error', String(msg.message));
          this.closed = true;
          this.ws?.close();
        } else {
          this.editor.notify(String(msg.message));
        }
        break;
    }
  }

  private onWelcome(msg: Record<string, unknown>): void {
    // Changes made while disconnected: unacknowledged batches plus anything
    // never sent. They are re-applied on top of the server's version.
    const replay: Op[] = [];
    if (this.joined) {
      for (const ops of this.unacked.values()) replay.push(...ops);
      replay.push(...this.tracker.collect(this.editor.doc));
    }
    this.unacked.clear();
    this.pending.clear();

    const doc = parseDocument(msg.doc);
    this.editor.setAutosave(false);
    this.editor.replaceDocument(doc, { keepView: this.joined || !!this.opts.createWith });
    this.tracker.reset(this.editor.doc);
    this.peers = new Map((msg.peers as RemotePeer[]).map((p) => [p.id, { ...p, presence: p.presence ?? null }]));
    this.joined = true;
    this.setStatus('connected');
    if (replay.length) {
      // Latest value per layer wins.
      const latest = new Map(replay.map((op) => [opKey(op), op]));
      this.editor.applyRemote([...latest.values()]);
      this.flush();
    }
    this.lastPresence = '';
    this.sendPresence();
  }

  private onRemoteOps(ops: Op[]): void {
    // Send local changes first so they become pending and are protected.
    this.flush();
    const accepted = ops.filter((op) => !this.pending.has(opKey(op)));
    if (!accepted.length) return;
    this.editor.applyRemote(accepted);
    // Values derived locally from the remote change (layout, instances…)
    // are computed by every client, so they are not sent back.
    this.tracker.reset(this.editor.doc);
  }

  // ---------------------------------------------------------------- outgoing

  private scheduleFlush(): void {
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Sends local changes since the last flush. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.joined || this.closed || this.ws?.readyState !== 1) return;
    const ops = this.tracker.collect(this.editor.doc);
    if (!ops.length) return;
    const seq = ++this.seq;
    this.unacked.set(seq, ops);
    for (const op of ops) this.pending.set(opKey(op), seq);
    this.send({ t: 'ops', seq, ops });
  }

  private schedulePresence(): void {
    if (!this.presenceTimer) {
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = null;
        this.sendPresence();
      }, PRESENCE_MS);
    }
  }

  private sendPresence(): void {
    if (!this.joined) return;
    const { pointer, selection, pageId } = this.editor;
    const presence = {
      pageId,
      cursor: pointer ? { x: Math.round(pointer.x * 10) / 10, y: Math.round(pointer.y * 10) / 10 } : null,
      selection,
    };
    const json = JSON.stringify(presence);
    if (json === this.lastPresence) return;
    this.lastPresence = json;
    this.send({ t: 'presence', ...presence });
  }
}
