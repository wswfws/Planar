// Admin API (/api/admin/*) and the Prometheus endpoint (/api/metrics).
// Admins see metadata and can act on accounts and files, but never read documents.

import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HttpError, readJson, str, type ApiContext } from './api';
import type { LinkAccess } from './access';
import type { User } from './db';

/** Connections at this moment. */
export interface LiveState {
  sockets: number;
  /** file id → people with it open */
  files: Map<string, number>;
  /** user ids with at least one open file */
  users: Set<string>;
  mcpSessions: number;
}

// ---- system facts ----------------------------------------------------------

let sizeCache: { at: number; sizes: Map<string, number> } | null = null;

/** Document sizes on disk (cached for a minute). */
export async function fileSizes(ctx: ApiContext): Promise<Map<string, number>> {
  if (sizeCache && Date.now() - sizeCache.at < 60_000) return sizeCache.sizes;
  const sizes = new Map<string, number>();
  if (ctx.dataDir) {
    await Promise.all(
      [...ctx.db.files.keys()].map(async (id) => {
        const st = await fs.stat(path.join(ctx.dataDir!, 'files', `${id}.planar.json`)).catch(() => null);
        sizes.set(id, st?.size ?? 0);
      }),
    );
  }
  sizeCache = { at: Date.now(), sizes };
  return sizes;
}

export async function disk(dataDir: string | null): Promise<{ free: number; total: number } | null> {
  if (!dataDir) return null;
  try {
    const s = await fs.statfs(dataDir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

async function gauges(ctx: ApiContext) {
  const { db } = ctx;
  const live = ctx.live();
  const sizes = await fileSizes(ctx);
  const mem = process.memoryUsage();
  let trashed = 0;
  for (const f of db.files.values()) if (f.deletedAt) trashed++;
  return {
    users: db.users.size,
    blockedUsers: [...db.users.values()].filter((u) => u.blocked).length,
    usersOnline: live.users.size,
    sockets: live.sockets,
    openFiles: live.files.size,
    files: db.files.size - trashed,
    trashedFiles: trashed,
    apiKeys: db.keys.size,
    sessions: db.sessions.size,
    mcpSessions: live.mcpSessions,
    dataBytes: [...sizes.values()].reduce((a, b) => a + b, 0),
    disk: await disk(ctx.dataDir),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    load: os.loadavg(),
    cpus: os.cpus().length,
    uptime: Math.round(process.uptime()),
    node: process.version,
  };
}

// ---- /api/metrics ------------------------------------------------------------

export async function handleMetrics(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<true> {
  const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
  if (!ctx.metricsToken || given !== ctx.metricsToken) {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"Not found"}');
    return true;
  }
  const g = await gauges(ctx);
  const lines: string[] = [];
  const put = (name: string, value: number | undefined, type: 'gauge' | 'counter' = 'gauge') => {
    if (value === undefined || !Number.isFinite(value)) return;
    lines.push(`# TYPE planar_${name} ${type}`, `planar_${name} ${value}`);
  };
  for (const k of ['users', 'blockedUsers', 'usersOnline', 'sockets', 'openFiles', 'files', 'trashedFiles', 'apiKeys', 'sessions', 'mcpSessions', 'dataBytes', 'rss', 'heapUsed', 'memFree', 'uptime'] as const) {
    put(k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), g[k]);
  }
  put('disk_free_bytes', g.disk?.free);
  put('load1', g.load[0]);
  for (const [k, v] of Object.entries(ctx.metrics.counters)) put(`${k}_total`, v, 'counter');
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
  res.end(lines.join('\n') + '\n');
  return true;
}

// ---- /api/admin/* ------------------------------------------------------------

const userRow = (u: User) => ({ id: u.id, username: u.username, displayName: u.displayName, color: u.color });

export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  ctx: ApiContext,
  /** Signed in with a cookie (API keys never get admin rights). */
  user: User | null,
): Promise<true> {
  // Everyone else gets a plain 404, as if there were no admin area.
  if (!user || !ctx.admins.has(user.username)) throw new HttpError(404, 'Not found');
  const { db, store, metrics } = ctx;
  const method = req.method ?? 'GET';
  const json = (body: unknown): true => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return true;
  };
  const audit = (text: string) => metrics.event('admin', `@${user.username}: ${text}`);
  const section = parts[1];
  const id = parts[2];

  if (section === 'overview' && method === 'GET') {
    return json({
      now: Date.now(),
      gauges: await gauges(ctx),
      counters: metrics.counters,
      series: metrics.series,
      days: metrics.days.slice(-30),
      events: metrics.events.slice(-100).reverse(),
      alerts: { configured: ctx.alerts.configured },
      settings: db.settings,
    });
  }

  if (section === 'users') {
    if (!id && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const live = ctx.live();
      const sizes = await fileSizes(ctx);
      const owned = new Map<string, { count: number; bytes: number }>();
      for (const f of db.files.values()) {
        if (!f.ownerId) continue;
        const o = owned.get(f.ownerId) ?? { count: 0, bytes: 0 };
        o.count++;
        o.bytes += sizes.get(f.id) ?? 0;
        owned.set(f.ownerId, o);
      }
      const keys = new Map<string, number>();
      for (const k of db.keys.values()) keys.set(k.userId, (keys.get(k.userId) ?? 0) + 1);
      const users = [...db.users.values()]
        .filter((u) => !q || u.username.includes(q) || u.displayName.toLowerCase().includes(q))
        .sort((a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt))
        .map((u) => ({
          ...userRow(u),
          createdAt: u.createdAt,
          lastSeenAt: u.lastSeenAt ?? null,
          blocked: !!u.blocked,
          admin: ctx.admins.has(u.username),
          online: live.users.has(u.id),
          files: owned.get(u.id)?.count ?? 0,
          bytes: owned.get(u.id)?.bytes ?? 0,
          keys: keys.get(u.id) ?? 0,
        }));
      return json({ users });
    }
    const target = id ? db.users.get(id) : undefined;
    if (!target) throw new HttpError(404, 'No such user');
    const self = target.id === user.id;

    if (!parts[3] && method === 'POST') {
      const body = await readJson(req);
      if (typeof body.blocked === 'boolean') {
        if (self) throw new HttpError(400, 'You cannot block yourself');
        target.blocked = body.blocked || undefined;
        db.touch('users');
        if (body.blocked) {
          db.dropUserSessions(target.id);
          ctx.kickUser(target.id, 'Your account was blocked');
        }
        audit(`${body.blocked ? 'blocked' : 'unblocked'} @${target.username}`);
      }
      return json({ ok: true });
    }

    if (parts[3] === 'logout' && method === 'POST') {
      db.dropUserSessions(target.id);
      ctx.kickUser(target.id, 'You were signed out');
      audit(`signed out @${target.username} everywhere`);
      return json({ ok: true });
    }

    if (!parts[3] && method === 'DELETE') {
      if (self) throw new HttpError(400, 'You cannot delete your own account here');
      const mode = url.searchParams.get('files') ?? 'delete';
      let heir: User | null = null;
      if (mode.startsWith('transfer:')) {
        heir = db.userByName(mode.slice(9));
        if (!heir || heir.id === target.id) throw new HttpError(400, 'Choose another existing user to receive the files');
      } else if (mode !== 'delete') throw new HttpError(400, 'files must be delete or transfer:<username>');

      db.dropUserSessions(target.id);
      ctx.kickUser(target.id, 'Your account was deleted');
      for (const f of [...db.files.values()]) {
        if (f.ownerId === target.id) {
          if (heir) {
            f.ownerId = heir.id;
            delete f.members[heir.id];
          } else {
            db.files.delete(f.id);
            await store.remove(f.id);
          }
        }
        delete f.members[target.id];
        ctx.accessChanged(f.id);
      }
      for (const k of [...db.keys.values()]) if (k.userId === target.id) db.keys.delete(k.id);
      db.users.delete(target.id);
      for (const name of ['users', 'files', 'keys'] as const) db.touch(name);
      audit(`deleted @${target.username}${heir ? `, files given to @${heir.username}` : ' and their files'}`);
      return json({ ok: true });
    }
  }

  if (section === 'files') {
    if (!id && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const sizes = await fileSizes(ctx);
      const live = ctx.live();
      const files = [...db.files.values()]
        .map((f) => {
          const owner = f.ownerId ? db.users.get(f.ownerId) : null;
          return {
            id: f.id,
            name: f.name,
            owner: owner ? userRow(owner) : null,
            createdAt: f.createdAt,
            updatedAt: f.updatedAt,
            deletedAt: f.deletedAt,
            linkAccess: f.linkAccess,
            members: Object.keys(f.members).length,
            online: live.files.get(f.id) ?? 0,
            bytes: sizes.get(f.id) ?? 0,
          };
        })
        .filter((f) => !q || f.name.toLowerCase().includes(q) || f.id.includes(q) || (f.owner?.username.includes(q) ?? false))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return json({ files });
    }
    const rec = id ? db.files.get(id) : undefined;
    if (!rec) throw new HttpError(404, 'No such file');

    if (method === 'POST') {
      const body = await readJson(req);
      if (body.linkAccess !== undefined) {
        if (!['none', 'view', 'edit'].includes(String(body.linkAccess))) throw new HttpError(400, 'Bad linkAccess');
        rec.linkAccess = body.linkAccess as LinkAccess;
        audit(`set link access of "${rec.name}" (${rec.id}) to ${rec.linkAccess}`);
      }
      if (typeof body.ownerUsername === 'string') {
        const owner = db.userByName(str(body.ownerUsername, 64));
        if (!owner) throw new HttpError(404, 'No user with this username');
        if (rec.ownerId && rec.ownerId !== owner.id) rec.members[rec.ownerId] = 'editor';
        delete rec.members[owner.id];
        rec.ownerId = owner.id;
        audit(`gave "${rec.name}" (${rec.id}) to @${owner.username}`);
      }
      db.touch('files');
      ctx.accessChanged(rec.id);
      return json({ ok: true });
    }

    if (method === 'DELETE') {
      db.files.delete(rec.id);
      db.touch('files');
      ctx.accessChanged(rec.id);
      await store.remove(rec.id);
      audit(`deleted file "${rec.name}" (${rec.id})`);
      return json({ ok: true });
    }
  }

  if (section === 'settings') {
    if (method === 'GET') return json({ settings: db.settings });
    if (method === 'POST') {
      const body = await readJson(req);
      const s = db.settings;
      if (typeof body.registrationOpen === 'boolean') s.registrationOpen = body.registrationOpen;
      const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 1;
      if (positive(body.maxFilesPerUser)) s.maxFilesPerUser = Math.floor(body.maxFilesPerUser as number);
      if (positive(body.maxFileBytes)) s.maxFileBytes = Math.floor(body.maxFileBytes as number);
      db.touch('settings');
      audit(`changed settings: registration ${s.registrationOpen ? 'open' : 'closed'}, ${s.maxFilesPerUser} files/user, ${Math.round(s.maxFileBytes / 1048576)} MB/file`);
      return json({ settings: s });
    }
  }

  if (section === 'alerts' && id === 'test' && method === 'POST') {
    if (!ctx.alerts.configured) throw new HttpError(400, 'Telegram is not configured (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)');
    const ok = await ctx.alerts.send('test', `Test message from @${user.username}. Alerts work.`, true);
    if (!ok) throw new HttpError(502, 'Telegram did not accept the message — check the token and chat id');
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
}
