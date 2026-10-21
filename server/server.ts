import { createReadStream, promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseDocument } from '../src/core/document';
import { META_KEYS, type Op } from '../src/core/ops';
import { initCanvas } from '../src/agent/raster';
import { createMcpHandler } from './mcp-http';
import { ROOM_ID, RoomStore, type Room } from './rooms';

export interface ServerOptions {
  port: number;
  host?: string;
  /** Where rooms are stored; null keeps them in memory only (tests). */
  dataDir: string | null;
  /** Built editor to serve over HTTP; null serves only the API. */
  staticDir: string | null;
  /** If set, clients must send this token. */
  token?: string;
  /** Largest accepted message in bytes (documents can embed images). */
  maxMessageBytes?: number;
}

interface Presence {
  pageId: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
}

interface Client {
  id: string;
  socket: WebSocket;
  room: Room | null;
  name: string;
  color: string;
  presence: Presence | null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function clean(s: unknown, max: number, fallback: string): string {
  return typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : fallback;
}

function isOp(op: unknown): op is Op {
  if (!op || typeof op !== 'object') return false;
  const o = op as Record<string, unknown>;
  if (o.o === 'node') return typeof o.id === 'string' && (o.node === null || (typeof o.node === 'object' && o.node !== null));
  if (o.o === 'meta') return (META_KEYS as readonly string[]).includes(o.key as string);
  return false;
}

export async function startServer(opts: ServerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const store = new RoomStore(opts.dataDir);
  await store.init();
  const members = new Map<string, Set<Client>>();
  let nextId = 1;

  const serveStatic = async (req: IncomingMessage, res: ServerResponse) => {
    if (!opts.staticDir) {
      res.writeHead(404).end('Not found');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const root = path.resolve(opts.staticDir);
    let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.isDirectory()) file = path.join(root, 'index.html');
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).on('error', () => res.end()).pipe(res);
  };

  await initCanvas();
  let boundPort = opts.port;
  const mcp = createMcpHandler({ token: opts.token, localServer: () => `http://127.0.0.1:${boundPort}` });

  const http = createServer((req, res) => {
    if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
      mcp.handle(req, res).catch((e) => {
        console.error('[planar] mcp error:', e);
        if (!res.headersSent) res.writeHead(500).end('MCP error');
      });
      return;
    }
    if (req.url?.startsWith('/api/info')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ planar: true, protocol: 1, auth: !!opts.token, mcp: '/mcp' }));
      return;
    }
    if (req.url === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    void serveStatic(req, res);
  });

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: opts.maxMessageBytes ?? 50 * 1024 * 1024 });

  const send = (c: Client, msg: unknown) => {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(msg));
  };
  const broadcast = (room: Room, msg: unknown, except?: Client) => {
    const json = JSON.stringify(msg);
    for (const c of members.get(room.id) ?? []) if (c !== except && c.socket.readyState === c.socket.OPEN) c.socket.send(json);
  };
  const peerInfo = (c: Client) => ({ id: c.id, name: c.name, color: c.color, presence: c.presence });

  wss.on('connection', (socket) => {
    const client: Client = { id: String(nextId++), socket, room: null, name: 'Guest', color: '#7b7bf0', presence: null };
    const fail = (message: string) => {
      send(client, { t: 'error', message, fatal: true });
      socket.close(4000, message.slice(0, 120));
    };

    socket.on('message', async (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return fail('Malformed message');
      }

      if (msg.t === 'hello') {
        if (client.room) return;
        if (opts.token && !safeEqual(String(msg.token ?? ''), opts.token)) return fail('Wrong or missing access token');
        const roomId = String(msg.room ?? '');
        if (!ROOM_ID.test(roomId)) return fail('Invalid room id');
        client.name = clean(msg.name, 40, 'Guest');
        client.color = /^#[0-9a-f]{6}$/i.test(String(msg.color)) ? String(msg.color) : '#7b7bf0';
        let room = await store.get(roomId);
        if (!room && msg.doc) {
          try {
            room = await store.create(roomId, parseDocument(msg.doc));
          } catch (e) {
            return fail(`Invalid document: ${(e as Error).message}`);
          }
        }
        if (!room) return fail('This shared document does not exist on the server');
        client.room = room;
        const set = members.get(room.id) ?? new Set();
        members.set(room.id, set);
        const peers = [...set].map(peerInfo);
        set.add(client);
        send(client, { t: 'welcome', clientId: client.id, doc: room.doc, version: room.version, peers });
        broadcast(room, { t: 'join', peer: peerInfo(client) }, client);
        return;
      }

      const room = client.room;
      if (!room) return fail('Say hello first');

      if (msg.t === 'ops') {
        const ops = Array.isArray(msg.ops) ? msg.ops.filter(isOp) : [];
        const version = ops.length ? room.apply(ops) : room.version;
        send(client, { t: 'ack', seq: msg.seq, version });
        if (ops.length) broadcast(room, { t: 'ops', from: client.id, version, ops }, client);
      } else if (msg.t === 'presence') {
        const cursor = msg.cursor as Presence['cursor'];
        client.presence = {
          pageId: String(msg.pageId ?? ''),
          cursor: cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y) ? { x: cursor.x, y: cursor.y } : null,
          selection: Array.isArray(msg.selection) ? msg.selection.filter((s): s is string => typeof s === 'string').slice(0, 500) : [],
        };
        broadcast(room, { t: 'presence', from: client.id, ...client.presence }, client);
      }
    });

    socket.on('close', () => {
      const room = client.room;
      if (!room) return;
      const set = members.get(room.id);
      set?.delete(client);
      if (set && !set.size) {
        members.delete(room.id);
        void room.save();
      }
      broadcast(room, { t: 'leave', id: client.id });
    });
  });

  // Ping idle sockets so proxies keep them open and dead ones get dropped.
  const alive = new WeakSet<WebSocket>();
  wss.on('connection', (s) => {
    alive.add(s);
    s.on('pong', () => alive.add(s));
  });
  const heartbeat = setInterval(() => {
    for (const s of wss.clients) {
      if (!alive.has(s)) {
        s.terminate();
        continue;
      }
      alive.delete(s);
      s.ping();
    }
  }, 30_000);

  await new Promise<void>((resolve) => http.listen(opts.port, opts.host ?? '0.0.0.0', resolve));
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  boundPort = port;

  return {
    port,
    close: async () => {
      clearInterval(heartbeat);
      mcp.close();
      for (const s of wss.clients) s.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await store.saveAll();
    },
  };
}
