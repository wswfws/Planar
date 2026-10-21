import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDocument, parseDocument } from '../src/core/document';
import { canRender, renderPng } from '../src/agent/raster';
import type { PlanarDocument } from '../src/core/types';
import { can, roleFor, type LinkAccess, type MemberRole, type Role } from './access';
import { Db, SESSION_DAYS, USERNAME, type FileRecord, type User } from './db';
import { handleAdmin, handleMetrics, type LiveState } from './admin';
import type { Alerts } from './alerts';
import type { Metrics } from './metrics';
import type { Room, RoomStore } from './rooms';

const COOKIE = 'planar_session';
const MAX_BODY = 60 * 1024 * 1024;

/** What the API needs from the running server. */
export interface ApiContext {
  db: Db;
  store: RoomStore;
  /** Username that adopts documents created before accounts existed. */
  legacyOwner?: string;
  /** Sign-in and registration attempts allowed per IP in five minutes (default 10). */
  authLimit?: number;
  /** Called after sharing, trash or deletion changed who may use a file. */
  accessChanged: (fileId: string) => void;
  /** Renames a file everywhere, including open editors. */
  rename: (room: Room, name: string) => void;
  metrics: Metrics;
  alerts: Alerts;
  /** Usernames allowed into /admin. */
  admins: Set<string>;
  /** Who is connected right now. */
  live: () => LiveState;
  /** Closes every open connection of a user (after blocking or deleting). */
  kickUser: (userId: string, reason: string) => void;
  dataDir: string | null;
  /** Bearer token for /api/metrics (Prometheus); the endpoint is off without it. */
  metricsToken?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // ignore a malformed cookie
      }
    }
  }
  return out;
}

/** The signed-in user of a request: session cookie, or `Authorization: Bearer plk_…`. */
export function authenticate(req: IncomingMessage, db: Db): { user: User | null; viaKey: boolean; session: string | null } {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) {
    const user = db.keyUser(auth.slice(7).trim());
    if (user) return { user, viaKey: true, session: null };
  }
  const token = parseCookies(req.headers.cookie)[COOKIE] ?? null;
  return { user: token ? db.sessionUser(token) : null, viaKey: false, session: token };
}

function isHttps(req: IncomingMessage): boolean {
  return (req.socket as { encrypted?: boolean }).encrypted === true || req.headers['x-forwarded-proto'] === 'https';
}

function clientIp(req: IncomingMessage): string {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '?';
}

export function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function throttle(attempts: Db['attempts'], req: IncomingMessage, limit = 10, windowMs = 5 * 60_000): void {
  const ip = clientIp(req);
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || a.reset < now) a = { n: 0, reset: now + windowMs };
  a.n++;
  attempts.set(ip, a);
  if (attempts.size > 5000) for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
  if (a.n > limit) throw new HttpError(429, 'Too many attempts, try again in a few minutes');
}

const publicUser = (u: User) => ({ id: u.id, username: u.username, displayName: u.displayName, color: u.color });

/** Handles /api/* requests. Returns false if the path is not an API route. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;
  const { db, store } = ctx;
  const method = req.method ?? 'GET';

  const json = (status: number, body: unknown, headers: Record<string, string | string[]> = {}): true => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
    return true;
  };

  try {
    if (url.pathname === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ planar: true, protocol: 2, accounts: true, mcp: '/mcp' }));
      return true;
    }
    if (url.pathname === '/api/metrics') return handleMetrics(req, res, ctx);

    const { user, viaKey, session } = authenticate(req, db);
    if (user) {
      db.seen(user);
      ctx.metrics.active(user.id);
    }

    // Cookie-authenticated writes must come from our own pages.
    if (method !== 'GET' && method !== 'HEAD' && !viaKey) {
      const origin = req.headers.origin;
      if (origin) {
        let host = '';
        try {
          host = new URL(origin).host;
        } catch {
          // rejected below
        }
        if (host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');
      }
    }

    const meView = (u: User) => ({ ...publicUser(u), admin: ctx.admins.has(u.username) });
    const need = (): User => {
      if (!user) throw new HttpError(401, 'Sign in first');
      return user;
    };
    const parts = url.pathname.split('/').slice(2).map(decodeURIComponent); // after /api

    if (parts[0] === 'admin') return await handleAdmin(req, res, parts, url, ctx, viaKey ? null : user);

    // ---- auth ----------------------------------------------------------
    if (parts[0] === 'auth') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (parts[1] === 'logout') {
        if (session) db.dropSession(session);
        return json(200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
      }
      if (parts[1] === 'register' || parts[1] === 'login') {
        throttle(db.attempts, req, ctx.authLimit);
        const body = await readJson(req);
        const username = str(body.username, 64).toLowerCase();
        const password = typeof body.password === 'string' ? body.password : '';
        let account: User | null;
        if (parts[1] === 'register') {
          if (!db.settings.registrationOpen) throw new HttpError(403, 'Registration is closed on this server');
          if (!USERNAME.test(username)) throw new HttpError(400, 'Username: 3–32 characters, letters, digits, . _ -');
          if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters');
          if (db.userByName(username)) throw new HttpError(409, 'This username is taken');
          account = await db.createUser(username, password, str(body.displayName, 40));
          ctx.metrics.registration();
          ctx.metrics.event('signup', `@${username} registered`);
          void ctx.alerts.send(`signup:${username}`, `New user @${username} (${db.users.size} in total)`);
        } else {
          account = db.userByName(username);
          // Hash even for unknown users so the timing does not reveal which usernames exist.
          const ok = account ? await db.checkPassword(account, password) : (await db.dummyHash(password), false);
          if (!account || !ok) {
            ctx.metrics.failedLogin();
            throw new HttpError(401, 'Wrong username or password');
          }
          if (account.blocked) throw new HttpError(403, 'This account is blocked');
          ctx.metrics.inc('logins');
        }
        db.seen(account);
        ctx.metrics.active(account.id);
        adoptLegacy(ctx, account);
        const token = db.createSession(account.id);
        const cookie = `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`;
        return json(200, { user: meView(account) }, { 'Set-Cookie': cookie });
      }
      throw new HttpError(404, 'Not found');
    }

    // ---- account -------------------------------------------------------
    if (parts[0] === 'me') {
      if (!parts[1]) {
        if (method === 'GET') return json(200, { user: user ? (viaKey ? publicUser(user) : meView(user)) : null });
        if (method === 'PATCH') {
          const me = need();
          const body = await readJson(req);
          if (typeof body.displayName === 'string') me.displayName = str(body.displayName, 40) || me.username;
          if (typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color)) me.color = body.color;
          if (typeof body.newPassword === 'string') {
            throttle(db.attempts, req, ctx.authLimit);
            if (!(await db.checkPassword(me, String(body.oldPassword ?? '')))) throw new HttpError(403, 'Current password is wrong');
            if (body.newPassword.length < 8 || body.newPassword.length > 200) throw new HttpError(400, 'Password must be at least 8 characters');
            await db.setPassword(me, body.newPassword);
            db.dropUserSessions(me.id, session ?? undefined);
          }
          db.touch('users');
          return json(200, { user: meView(me) });
        }
      }
      if (parts[1] === 'apps') {
        // Apps connected with OAuth, grouped by client.
        const me = need();
        if (method === 'GET') {
          const apps = new Map<string, { clientId: string; name: string; connectedAt: number; lastUsed: number | null }>();
          for (const t of Object.values(db.oauth.tokens)) {
            if (t.userId !== me.id) continue;
            const a = apps.get(t.clientId) ?? { clientId: t.clientId, name: t.clientName, connectedAt: t.createdAt, lastUsed: null };
            a.connectedAt = Math.min(a.connectedAt, t.createdAt);
            if (t.lastUsed && (!a.lastUsed || t.lastUsed > a.lastUsed)) a.lastUsed = t.lastUsed;
            apps.set(t.clientId, a);
          }
          return json(200, { apps: [...apps.values()] });
        }
        if (method === 'DELETE' && parts[2]) {
          for (const [hash, t] of Object.entries(db.oauth.tokens)) if (t.userId === me.id && t.clientId === parts[2]) delete db.oauth.tokens[hash];
          db.touch('oauth');
          return json(200, { ok: true });
        }
      }
      if (parts[1] === 'keys') {
        const me = need();
        if (method === 'GET' && !parts[2]) {
          const keys = [...db.keys.values()].filter((k) => k.userId === me.id).map(({ id, name, prefix, createdAt, lastUsed }) => ({ id, name, prefix, createdAt, lastUsed }));
          return json(200, { keys });
        }
        if (method === 'POST' && !parts[2]) {
          const body = await readJson(req);
          const count = [...db.keys.values()].filter((k) => k.userId === me.id).length;
          if (count >= 20) throw new HttpError(400, 'Too many keys, revoke some first');
          const { key, secret } = db.createKey(me.id, str(body.name, 60) || 'Agent');
          return json(200, { key: { id: key.id, name: key.name, prefix: key.prefix, createdAt: key.createdAt, lastUsed: null }, secret });
        }
        if (method === 'DELETE' && parts[2]) {
          const k = db.keys.get(parts[2]);
          if (!k || k.userId !== me.id) throw new HttpError(404, 'No such key');
          db.keys.delete(k.id);
          db.touch('keys');
          return json(200, { ok: true });
        }
      }
      throw new HttpError(404, 'Not found');
    }

    // ---- user search -----------------------------------------------------
    if (parts[0] === 'users' && method === 'GET') {
      const me = need();
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (!q) return json(200, { users: [] });
      const users = [...db.users.values()]
        .filter((u) => u.id !== me.id && (u.username.startsWith(q) || u.displayName.toLowerCase().startsWith(q)))
        .sort((a, b) => a.username.localeCompare(b.username))
        .slice(0, 8)
        .map((u) => ({ username: u.username, displayName: u.displayName, color: u.color }));
      return json(200, { users });
    }

    // ---- files -----------------------------------------------------------
    if (parts[0] === 'files') {
      const view = (f: FileRecord, role: Role | null, detailed: boolean) => {
        const owner = f.ownerId ? db.users.get(f.ownerId) : null;
        const base = {
          id: f.id,
          name: f.name,
          role,
          owner: owner ? publicUser(owner) : null,
          createdAt: f.createdAt,
          updatedAt: f.updatedAt,
          deletedAt: f.deletedAt,
          linkAccess: f.linkAccess,
        };
        if (!detailed) return base;
        const members = can(role, 'share')
          ? Object.entries(f.members).flatMap(([uid, r]) => {
              const u = db.users.get(uid);
              return u ? [{ ...publicUser(u), role: r }] : [];
            })
          : [];
        return { ...base, members };
      };

      if (!parts[1]) {
        if (method === 'GET') {
          const me = need();
          const scope = url.searchParams.get('scope') ?? 'mine';
          const list: unknown[] = [];
          for (const f of [...db.files.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
            const mine = f.ownerId === me.id;
            const show = scope === 'trash' ? mine && !!f.deletedAt : scope === 'shared' ? !mine && !!f.members[me.id] && !f.deletedAt : mine && !f.deletedAt;
            if (show) list.push(view(f, roleFor(f, me.id), false));
          }
          return json(200, { files: list });
        }
        if (method === 'POST') {
          const me = need();
          const body = await readJson(req);
          let doc: PlanarDocument;
          try {
            doc = body.doc ? parseDocument(body.doc) : createDocument(str(body.name, 120) || 'Untitled');
          } catch (e) {
            throw new HttpError(400, `Invalid document: ${(e as Error).message}`);
          }
          const name = str(body.name, 120) || doc.name || 'Untitled';
          doc.name = name;
          checkLimits(db, me, doc);
          const rec = db.createFile(me.id, name);
          await store.create(rec.id, doc);
          return json(200, { file: view(rec, 'owner', true) });
        }
        throw new HttpError(405, 'Method not allowed');
      }

      const rec = db.files.get(parts[1]);
      const role = rec ? roleFor(rec, user?.id ?? null) : null;
      // Trashed files are visible to their owner only; unknown and forbidden files look the same.
      if (!rec || !can(role, 'view') || (rec.deletedAt && role !== 'owner')) {
        throw new HttpError(user ? 404 : 401, user ? 'No such file' : 'Sign in to open this file');
      }
      const sub = parts[2];

      if (!sub) {
        if (method === 'GET') return json(200, { file: view(rec, role, true) });
        if (method === 'PATCH') {
          const body = await readJson(req);
          if (typeof body.name === 'string') {
            if (!can(role, 'edit')) throw new HttpError(403, 'View-only access');
            const room = await store.get(rec.id);
            const name = str(body.name, 120) || 'Untitled';
            if (room) ctx.rename(room, name);
            else {
              rec.name = name;
              db.touch('files');
            }
          }
          if (body.linkAccess !== undefined) {
            need();
            if (!can(role, 'share')) throw new HttpError(403, 'You cannot change sharing');
            if (!['none', 'view', 'edit'].includes(String(body.linkAccess))) throw new HttpError(400, 'Bad linkAccess');
            rec.linkAccess = body.linkAccess as LinkAccess;
            db.touch('files');
            ctx.accessChanged(rec.id);
          }
          return json(200, { file: view(rec, roleFor(rec, user?.id ?? null), true) });
        }
        if (method === 'DELETE') {
          need();
          if (!can(role, 'delete')) throw new HttpError(403, 'Only the owner can delete a file');
          if (url.searchParams.get('forever')) {
            db.files.delete(rec.id);
            db.touch('files');
            ctx.accessChanged(rec.id);
            await store.remove(rec.id);
            thumbs.delete(rec.id);
          } else {
            rec.deletedAt = Date.now();
            db.touch('files');
            ctx.accessChanged(rec.id);
          }
          return json(200, { ok: true });
        }
        throw new HttpError(405, 'Method not allowed');
      }

      if (sub === 'restore' && method === 'POST') {
        need();
        if (!can(role, 'delete')) throw new HttpError(403, 'Only the owner can restore a file');
        rec.deletedAt = null;
        db.touch('files');
        return json(200, { file: view(rec, role, true) });
      }

      if (sub === 'duplicate' && method === 'POST') {
        const me = need();
        const room = await store.get(rec.id);
        if (!room) throw new HttpError(404, 'The document is missing on the server');
        const body = await readJson(req);
        const copy = structuredClone(room.doc);
        const name = str(body.name, 120) || `${rec.name} (copy)`;
        copy.name = name;
        checkLimits(db, me, copy);
        const created = db.createFile(me.id, name);
        await store.create(created.id, copy);
        return json(200, { file: view(created, 'owner', true) });
      }

      if (sub === 'members' && method === 'PUT') {
        const me = need();
        const body = await readJson(req);
        const target = db.userByName(str(body.username, 64));
        if (!target) throw new HttpError(404, 'No user with this username');
        const next = body.role === null ? null : (String(body.role) as MemberRole);
        if (next !== null && next !== 'editor' && next !== 'viewer') throw new HttpError(400, 'Role must be editor, viewer or null');
        const leaving = target.id === me.id && next === null;
        if (!leaving && !can(role, 'share')) throw new HttpError(403, 'You cannot change who has access');
        if (target.id === rec.ownerId) throw new HttpError(400, 'The owner always has full access');
        if (next === null) delete rec.members[target.id];
        else rec.members[target.id] = next;
        db.touch('files');
        ctx.accessChanged(rec.id);
        return json(200, { file: view(rec, roleFor(rec, me.id), true) });
      }

      if (sub === 'transfer' && method === 'POST') {
        const me = need();
        if (!can(role, 'transfer')) throw new HttpError(403, 'Only the owner can transfer a file');
        const body = await readJson(req);
        const target = db.userByName(str(body.username, 64));
        if (!target) throw new HttpError(404, 'No user with this username');
        if (target.id !== me.id) {
          delete rec.members[target.id];
          rec.ownerId = target.id;
          rec.members[me.id] = 'editor';
          db.touch('files');
          ctx.accessChanged(rec.id);
        }
        return json(200, { file: view(rec, roleFor(rec, me.id), true) });
      }

      if (sub === 'download' && method === 'GET') {
        const room = await store.get(rec.id);
        if (!room) throw new HttpError(404, 'The document is missing on the server');
        const filename = `${rec.name.replace(/[^\w.-]+/g, '_') || 'file'}.planar.json`;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(room.doc));
        return true;
      }

      if (sub === 'thumbnail.png' && method === 'GET') {
        const png = await thumbnail(ctx, rec.id);
        if (!png) {
          res.writeHead(204).end();
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=30' });
        res.end(png);
        return true;
      }
    }

    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 429) ctx.metrics.inc('rate_limited');
      json(e.status, { error: e.message });
    } else {
      console.error('[planar] api error:', e);
      ctx.metrics.inc('server_errors');
      ctx.metrics.event('error', `${method} ${url.pathname}: ${(e as Error).message}`);
      if (!res.headersSent) json(500, { error: 'Server error' });
    }
    return true;
  }
}

/** Per-user limits set by the admin. */
function checkLimits(db: Db, user: User, doc: PlanarDocument): void {
  let owned = 0;
  for (const f of db.files.values()) if (f.ownerId === user.id && !f.deletedAt) owned++;
  if (owned >= db.settings.maxFilesPerUser) throw new HttpError(403, `File limit reached (${db.settings.maxFilesPerUser}); delete some files first`);
  if (JSON.stringify(doc).length > db.settings.maxFileBytes) throw new HttpError(413, 'The document is larger than this server allows');
}

/** Gives documents from before accounts existed to their configured owner. */
export function adoptLegacy(ctx: Pick<ApiContext, 'db' | 'legacyOwner'>, user: User): void {
  if (!ctx.legacyOwner || user.username !== ctx.legacyOwner.trim().toLowerCase()) return;
  let changed = false;
  for (const f of ctx.db.files.values()) {
    if (f.ownerId === null) {
      f.ownerId = user.id;
      changed = true;
    }
  }
  if (changed) ctx.db.touch('files');
}

const thumbs = new Map<string, { version: number; png: Buffer | null }>();

async function thumbnail(ctx: ApiContext, id: string): Promise<Buffer | null> {
  if (!canRender()) return null;
  const room = await ctx.store.get(id);
  if (!room) return null;
  const cached = thumbs.get(id);
  if (cached && cached.version === room.version) return cached.png;
  let png: Buffer | null = null;
  try {
    const page = room.doc.nodes[room.doc.pageIds[0]];
    png = await renderPng(room.doc, page ? [...page.children] : [], { maxSize: 480, background: '#ffffff' });
  } catch {
    png = null; // an empty page has nothing to show
  }
  thumbs.set(id, { version: room.version, png });
  return png;
}
