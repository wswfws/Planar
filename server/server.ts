import { createReadStream, promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseDocument } from '../src/core/document';
import { META_KEYS, type Op } from '../src/core/ops';
import { initCanvas } from '../src/agent/raster';
import { can, roleFor, type Role } from './access';
import { adoptLegacy, authenticate, handleApi } from './api';
import { Db, type FileRecord, type User } from './db';
import { createMcpHandler } from './mcp-http';
import { ROOM_ID, RoomStore, type Room } from './rooms';

export interface ServerOptions {
  port: number;
  host?: string;
  /** Where accounts and documents are stored; null keeps everything in memory (tests). */
  dataDir: string | null;
  /** Built editor to serve over HTTP; null serves only the API. */
  staticDir: string | null;
  /** Username that takes over documents created before accounts existed. */
  legacyOwner?: string;
  /** Sign-in attempts per IP per five minutes (default 10). */
  authLimit?: number;
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
  user: User | null;
  role: Role | null;
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

/** Moves documents saved by earlier versions (one file per room, no owner) into the file store. */
async function migrateLegacy(dataDir: string, db: Db): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dataDir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^(.+)\.planar\.json$/.exec(name);
    if (!m || !ROOM_ID.test(m[1])) continue;
    const id = m[1];
    const from = path.join(dataDir, name);
    try {
      const doc = parseDocument(JSON.parse(await fs.readFile(from, 'utf8')));
      if (!db.files.has(id)) {
        // Nobody owns these yet, so the old links keep working until an owner claims them.
        const rec = db.createFile(null, doc.name || 'Untitled', id);
        rec.linkAccess = 'edit';
      }
      await fs.rename(from, path.join(dataDir, 'files', name));
    } catch (e) {
      console.error(`[planar] could not migrate ${name}:`, e);
    }
  }
}

export async function startServer(opts: ServerOptions): Promise<{ port: number; close: () => Promise<void>; db: Db }> {
  const db = new Db(opts.dataDir);
  await db.init();
  const store = new RoomStore(opts.dataDir ? path.join(opts.dataDir, 'files') : null);
  await store.init();
  if (opts.dataDir) await migrateLegacy(opts.dataDir, db);
  if (opts.legacyOwner) {
    const owner = db.userByName(opts.legacyOwner);
    if (owner) adoptLegacy({ db, legacyOwner: opts.legacyOwner }, owner);
  }
  const members = new Map<string, Set<Client>>();
  let nextId = 1;
  let guests = 0;

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
    if (!stat || stat.isDirectory()) {
      // Pages such as /file/<id> are client routes: serve the editor, with a base so assets still resolve.
      const index = path.join(root, 'index.html');
      const html = await fs.readFile(index, 'utf8').catch(() => null);
      if (html === null) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(html.replace('<head>', '<head><base href="/">'));
      return;
    }
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).on('error', () => res.end()).pipe(res);
  };

  await initCanvas();
  let boundPort = opts.port;
  const mcp = createMcpHandler({ db, localServer: () => `http://127.0.0.1:${boundPort}` });

  const send = (c: Client, msg: unknown) => {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(msg));
  };
  const broadcast = (room: Room, msg: unknown, except?: Client) => {
    const json = JSON.stringify(msg);
    for (const c of members.get(room.id) ?? []) if (c !== except && c.socket.readyState === c.socket.OPEN) c.socket.send(json);
  };
  const peerInfo = (c: Client) => ({ id: c.id, name: c.name, color: c.color, presence: c.presence });
  const roleOf = (rec: FileRecord | undefined, userId: string | null): Role | null =>
    rec && !rec.deletedAt ? roleFor(rec, userId) : null;

  const api = {
    db,
    store,
    legacyOwner: opts.legacyOwner,
    authLimit: opts.authLimit,
    accessChanged: (fileId: string) => {
      const rec = db.files.get(fileId);
      for (const c of [...(members.get(fileId) ?? [])]) {
        const role = roleOf(rec, c.user?.id ?? null);
        if (!can(role, 'view')) {
          send(c, { t: 'error', message: 'Access to this file was closed', fatal: true });
          c.socket.close(4003, 'Access closed');
        } else if (role !== c.role) {
          c.role = role;
          send(c, { t: 'role', role });
        }
      }
    },
    rename: (room: Room, name: string) => {
      const ops: Op[] = [{ o: 'meta', key: 'name', value: name }];
      const version = room.apply(ops);
      db.fileEdited(room.id, name);
      broadcast(room, { t: 'ops', from: 'server', version, ops });
    },
  };

  const http = createServer((req, res) => {
    if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
      mcp.handle(req, res).catch((e) => {
        console.error('[planar] mcp error:', e);
        if (!res.headersSent) res.writeHead(500).end('MCP error');
      });
      return;
    }
    if (req.url === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    void handleApi(req, res, api).then((handled) => {
      if (!handled) void serveStatic(req, res);
    });
  });

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: opts.maxMessageBytes ?? 50 * 1024 * 1024 });

  wss.on('connection', (socket, req) => {
    const client: Client = { id: String(nextId++), socket, room: null, user: null, role: null, name: 'Guest', color: '#7b7bf0', presence: null };
    const fail = (message: string) => {
      send(client, { t: 'error', message, fatal: true });
      socket.close(4000, message.slice(0, 120));
    };

    // Browsers send an Origin; refuse pages from other sites so cookies cannot be borrowed.
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        // rejected below
      }
      if (host !== req.headers.host) {
        socket.close(4003, 'Cross-origin connection refused');
        return;
      }
    }
    const auth = authenticate(req, db);
    client.user = auth.user;

    socket.on('message', async (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return fail('Malformed message');
      }

      if (msg.t === 'hello') {
        if (client.room) return;
        let viaKey = false;
        if (typeof msg.key === 'string' && msg.key) {
          const keyUser = db.keyUser(msg.key);
          if (!keyUser) return fail('Unknown or revoked API key');
          client.user = keyUser;
          viaKey = true;
        }
        const fileId = String(msg.file ?? '');
        if (!ROOM_ID.test(fileId)) return fail('Invalid file id');
        const rec = db.files.get(fileId);
        const role = roleOf(rec, client.user?.id ?? null);
        if (!rec || !can(role, 'view')) {
          return fail(client.user ? 'This file does not exist or is not shared with you' : 'Sign in to open this file');
        }
        const room = await store.get(fileId);
        if (!room) return fail('The document is missing on the server');
        client.role = role;
        if (client.user && !viaKey) {
          client.name = client.user.displayName;
          client.color = client.user.color;
        } else {
          // Guests and agents (API keys) choose what others see; permissions still come from the account.
          client.name = clean(msg.guestName, 40, viaKey ? 'Agent' : `Guest ${++guests}`);
          client.color = /^#[0-9a-f]{6}$/i.test(String(msg.color)) ? String(msg.color) : '#7b7bf0';
        }
        client.room = room;
        const set = members.get(room.id) ?? new Set();
        members.set(room.id, set);
        const peers = [...set].map(peerInfo);
        set.add(client);
        send(client, {
          t: 'welcome',
          clientId: client.id,
          doc: room.doc,
          version: room.version,
          peers,
          role,
          you: { userId: client.user?.id ?? null, name: client.name, color: client.color },
        });
        broadcast(room, { t: 'join', peer: peerInfo(client) }, client);
        return;
      }

      const room = client.room;
      if (!room) return fail('Say hello first');

      if (msg.t === 'ops') {
        const rec = db.files.get(room.id);
        const role = roleOf(rec, client.user?.id ?? null);
        if (role !== client.role) {
          if (!can(role, 'view')) return fail('Access to this file was closed');
          client.role = role;
          send(client, { t: 'role', role });
        }
        if (!can(client.role, 'edit')) {
          send(client, { t: 'error', message: 'This file is view-only for you', fatal: false });
          send(client, { t: 'ack', seq: msg.seq, version: room.version });
          return;
        }
        const ops = Array.isArray(msg.ops) ? msg.ops.filter(isOp) : [];
        const version = ops.length ? room.apply(ops) : room.version;
        send(client, { t: 'ack', seq: msg.seq, version });
        if (ops.length) {
          broadcast(room, { t: 'ops', from: client.id, version, ops }, client);
          db.fileEdited(room.id, ops.some((o) => o.o === 'meta' && o.key === 'name') ? room.doc.name : undefined);
        }
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
    db,
    close: async () => {
      clearInterval(heartbeat);
      mcp.close();
      for (const s of wss.clients) s.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await store.saveAll();
      await db.flush();
    },
  };
}
