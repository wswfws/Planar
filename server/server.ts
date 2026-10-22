import { createReadStream, promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseDocument } from '../src/core/document';
import { META_KEYS, type Op } from '../src/core/ops';
import { initCanvas } from '../src/agent/raster';
import { can, type Role } from './access';
import os from 'node:os';
import { disk, type LiveState } from './admin';
import { Alerts, type AlertOptions } from './alerts';
import { adoptLegacy, authenticate, handleApi } from './api';
import { Metrics } from './metrics';
import { handleOAuth } from './oauth';
import { Db, type FileRecord, type User } from './db';
import { createMcpHandler } from './mcp-http';
import { ROOM_ID, RoomStore, type Room } from './rooms';
import { CommentStore } from './comments';
import { LibraryStore } from './libraries';
import { VersionStore } from './versions';

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
  /** Usernames that may open /admin. */
  admins?: string[];
  /** Telegram notifications for the admin. */
  telegram?: AlertOptions;
  /** Bearer token for /api/metrics (Prometheus); off when empty. */
  metricsToken?: string;
  /** Public address (https://planar.example.com) for OAuth metadata; default: from each request. */
  publicUrl?: string;
  /** Fetches OAuth client metadata documents (tests replace the network). */
  fetchClientMetadata?: (url: string) => Promise<unknown>;
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
  /** Signed in with an API key or OAuth token: an AI agent or script. */
  viaKey: boolean;
}

/** An agent gets a fresh restore point when it starts editing after this long without one. */
const AGENT_GAP_MS = 10 * 60_000;
/** A person's first edit after this much quiet saves the state they found. */
const AUTO_QUIET_MS = 30 * 60_000;
/** While people keep editing, a snapshot at least this often. */
const AUTO_EVERY_MS = 60 * 60_000;

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

export async function startServer(
  opts: ServerOptions,
): Promise<{ port: number; close: () => Promise<void>; db: Db; alerts: Alerts; metrics: Metrics }> {
  const db = new Db(opts.dataDir);
  await db.init();
  const store = new RoomStore(opts.dataDir ? path.join(opts.dataDir, 'files') : null);
  await store.init();
  const comments = new CommentStore(opts.dataDir);
  await comments.init();
  const versions = new VersionStore(opts.dataDir ? path.join(opts.dataDir, 'versions') : null);
  const libraries = new LibraryStore(opts.dataDir ? path.join(opts.dataDir, 'libraries') : null);
  if (opts.dataDir) await migrateLegacy(opts.dataDir, db);
  if (opts.legacyOwner) {
    const owner = db.userByName(opts.legacyOwner);
    if (owner) adoptLegacy({ db, legacyOwner: opts.legacyOwner }, owner);
  }
  const members = new Map<string, Set<Client>>();
  const metrics = new Metrics(db);
  const alerts = new Alerts(opts.telegram ?? {});
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
    let stat = await fs.stat(file).catch(() => null);
    // Static pages such as /privacy live in a folder with an index.html.
    if (stat?.isDirectory() && url.pathname !== '/') {
      const index = path.join(file, 'index.html');
      const inner = await fs.stat(index).catch(() => null);
      if (inner?.isFile()) {
        file = index;
        stat = inner;
      }
    }
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
  const mcp = createMcpHandler({ db, localServer: () => `http://127.0.0.1:${boundPort}`, publicUrl: opts.publicUrl });
  const oauth = { db, metrics, publicUrl: opts.publicUrl, fetchClientMetadata: opts.fetchClientMetadata };

  const send = (c: Client, msg: unknown) => {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(msg));
  };
  const broadcast = (room: Room, msg: unknown, except?: Client) => {
    const json = JSON.stringify(msg);
    for (const c of members.get(room.id) ?? []) if (c !== except && c.socket.readyState === c.socket.OPEN) c.socket.send(json);
  };
  /**
   * Keeps restore points: before an agent starts editing (so its work can be
   * undone as a whole), and automatically while people work.
   */
  const snapshotBefore = async (room: Room, client: Client): Promise<void> => {
    const now = Date.now();
    try {
      if (client.viaKey) {
        const last = await versions.latest(room.id, 'agent');
        if (!last || now - last.createdAt > AGENT_GAP_MS) {
          await versions.save(room.id, room.doc, { kind: 'agent', label: `Before ${client.name}`, authorId: client.user?.id ?? null, authorName: client.name });
          return;
        }
      }
      const last = await versions.latest(room.id);
      const quiet = room.lastEditAt ? now - room.lastEditAt > AUTO_QUIET_MS : true;
      if (!last || (quiet && now - last.createdAt > AUTO_QUIET_MS) || now - last.createdAt > AUTO_EVERY_MS) {
        await versions.save(room.id, room.doc, { kind: 'auto', label: '', authorId: null, authorName: '' });
      }
    } catch (e) {
      console.error('[planar] could not snapshot', room.id, e);
    }
  };
  const peerInfo = (c: Client) => ({ id: c.id, name: c.name, color: c.color, presence: c.presence });
  const roleOf = (rec: FileRecord | undefined, userId: string | null): Role | null =>
    rec && !rec.deletedAt ? db.roleFor(rec, userId) : null;

  const live = (): LiveState => {
    const files = new Map<string, number>();
    const users = new Set<string>();
    let sockets = 0;
    for (const [id, set] of members) {
      files.set(id, set.size);
      sockets += set.size;
      for (const c of set) if (c.user) users.add(c.user.id);
    }
    return { sockets, files, users, mcpSessions: mcp.count() };
  };

  const api = {
    db,
    store,
    legacyOwner: opts.legacyOwner,
    authLimit: opts.authLimit,
    metrics,
    alerts,
    admins: new Set((opts.admins ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean)),
    live,
    dataDir: opts.dataDir,
    versions,
    comments,
    libraries,
    commentsChanged: (fileId: string) => {
      const set = members.get(fileId);
      if (set) for (const c of set) send(c, { t: 'comments' });
    },
    reset: (room: Room) => {
      broadcast(room, { t: 'reset', doc: room.doc, version: room.version });
      db.fileEdited(room.id, room.doc.name);
    },
    metricsToken: opts.metricsToken || undefined,
    kickUser: (userId: string, reason: string) => {
      for (const set of members.values()) {
        for (const c of [...set]) {
          if (c.user?.id === userId) {
            send(c, { t: 'error', message: reason, fatal: true });
            c.socket.close(4003, reason.slice(0, 120));
          }
        }
      }
    },
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
    const group = req.url?.startsWith('/mcp') ? 'mcp' : req.url?.startsWith('/api/') ? 'api' : 'static';
    if (req.url !== '/healthz') res.on('finish', () => metrics.request(group, res.statusCode));
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
    void (async () => {
      if (await handleOAuth(req, res, oauth)) return;
      if (!(await handleApi(req, res, api))) await serveStatic(req, res);
    })();
  });

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: opts.maxMessageBytes ?? 50 * 1024 * 1024 });

  wss.on('connection', (socket, req) => {
    const client: Client = { id: String(nextId++), socket, room: null, user: null, role: null, name: 'Guest', color: '#7b7bf0', presence: null, viaKey: false };
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

    // Messages of one connection are handled one after another (snapshots and loads are async).
    let chain: Promise<void> = Promise.resolve();
    socket.on('message', (raw) => {
      chain = chain.then(() => handle(raw)).catch((e) => console.error('[planar] message error:', e));
    });
    const handle = async (raw: unknown): Promise<void> => {
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
          client.viaKey = true;
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
        metrics.inc('ws_joins');
        if (client.user) {
          db.seen(client.user);
          metrics.active(client.user.id);
        }
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
        if (ops.length) await snapshotBefore(room, client);
        const version = ops.length ? room.apply(ops) : room.version;
        send(client, { t: 'ack', seq: msg.seq, version });
        if (ops.length) {
          metrics.ops(ops.length);
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
    };

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

  // Every minute: record history, check alert thresholds, send the daily summary.
  let lastSummary = String((db.stats as { lastSummary?: string }).lastSummary ?? '');
  const minuteTick = async () => {
    const m = metrics.tick(live().sockets);
    if (m.errors > 5) void alerts.send('5xx', `${m.errors} server errors in the last minute. Check: docker compose logs planar`);
    if (m.failedLogins5m > 30) void alerts.send('logins', `${m.failedLogins5m} failed sign-ins in 5 minutes — someone may be guessing passwords`);
    const d = await disk(opts.dataDir);
    if (d && (d.free < 1024 ** 3 || d.free / d.total < 0.1)) {
      void alerts.send('disk', `Low disk space: ${(d.free / 1024 ** 3).toFixed(1)} GB free of ${(d.total / 1024 ** 3).toFixed(0)} GB`);
    }
    if (os.freemem() / os.totalmem() < 0.05 || m.rss > os.totalmem() * 0.8) {
      void alerts.send('memory', `Memory is running out: Planar uses ${Math.round(m.rss / 1048576)} MB, ${Math.round(os.freemem() / 1048576)} MB free`);
    }
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() >= 9 && lastSummary !== day) {
      lastSummary = day;
      (db.stats as Record<string, unknown>).lastSummary = day;
      db.touch('stats');
      const y = metrics.days.find((x) => x.day === new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
      const files = [...db.files.values()].filter((f) => !f.deletedAt).length;
      void alerts.send(
        'summary',
        `Yesterday: ${y?.registrations ?? 0} new users, ${y?.active ?? 0} active, ${y?.edits ?? 0} edit batches, ${y?.errors ?? 0} errors.\n` +
          `Total: ${db.users.size} users, ${files} files${d ? `, ${(d.free / 1024 ** 3).toFixed(1)} GB disk free` : ''}.`,
        true,
      );
    }
  };
  const ticker = setInterval(() => void minuteTick().catch((e) => console.error('[planar] metrics tick failed:', e)), 60_000);
  ticker.unref();

  await new Promise<void>((resolve) => http.listen(opts.port, opts.host ?? '0.0.0.0', resolve));
  metrics.event('info', 'Server started');
  void alerts.send('start', `Server started (${db.users.size} users, ${db.files.size} files)`, true);
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  boundPort = port;

  return {
    port,
    db,
    alerts,
    metrics,
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(ticker);
      mcp.close();
      for (const s of wss.clients) s.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await store.saveAll();
      await versions.flush();
      await comments.flush();
      await db.flush();
    },
  };
}
