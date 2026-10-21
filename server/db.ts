import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LinkAccess, MemberRole } from './access';

export interface User {
  id: string;
  username: string;
  displayName: string;
  color: string;
  passHash: string;
  salt: string;
  createdAt: number;
  /** Last sign-in, request or opened file (updated at most once a minute). */
  lastSeenAt?: number;
  /** Blocked by an admin: cannot sign in, sessions and keys stop working. */
  blocked?: boolean;
}

/** Server-wide settings an admin can change. */
export interface Settings {
  registrationOpen: boolean;
  maxFilesPerUser: number;
  /** Largest document accepted on create/import/duplicate, in bytes. */
  maxFileBytes: number;
}

export const DEFAULT_SETTINGS: Settings = { registrationOpen: true, maxFilesPerUser: 500, maxFileBytes: 50 * 1024 * 1024 };

export interface FileRecord {
  id: string;
  name: string;
  /** null for documents migrated from before accounts existed and not yet claimed. */
  ownerId: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  linkAccess: LinkAccess;
  members: Record<string, MemberRole>;
}

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  hash: string;
  prefix: string;
  createdAt: number;
  lastUsed: number | null;
}

/** An app registered through OAuth dynamic client registration. */
export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

/** An OAuth access or refresh token (stored by hash). */
export interface OAuthToken {
  kind: 'access' | 'refresh';
  userId: string;
  clientId: string;
  clientName: string;
  expires: number;
  createdAt: number;
  lastUsed: number | null;
}

interface Session {
  userId: string;
  expires: number;
}

export const USERNAME = /^[a-z0-9_.-]{3,32}$/;
export const SESSION_DAYS = 30;
const COLORS = ['#e5484d', '#f2a65a', '#4cc38a', '#3e9bf0', '#8e6cf0', '#d65cb7', '#12a594', '#ffb224'];

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const randomId = (bytes = 9): string => randomBytes(bytes).toString('base64url');

function scrypt(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Small JSON-file database: everything lives in memory and is written atomically. */
export class Db {
  users = new Map<string, User>();
  files = new Map<string, FileRecord>();
  keys = new Map<string, ApiKey>();
  /** token hash → session */
  sessions = new Map<string, Session>();
  /** Sign-in attempts per address (see api.ts). */
  attempts = new Map<string, { n: number; reset: number }>();
  settings: Settings = { ...DEFAULT_SETTINGS };
  /** Usage statistics kept by metrics.ts; stored as stats.json. */
  stats: Record<string, unknown> = {};
  oauth: { clients: Record<string, OAuthClient>; tokens: Record<string, OAuthToken> } = { clients: {}, tokens: {} };
  private timers = new Map<string, NodeJS.Timeout>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string | null) {}

  async init(): Promise<void> {
    if (!this.dir) return;
    await fs.mkdir(path.join(this.dir, 'files'), { recursive: true });
    for (const u of await this.load<User>('users')) this.users.set(u.id, u);
    for (const f of await this.load<FileRecord>('files')) this.files.set(f.id, f);
    for (const k of await this.load<ApiKey>('keys')) this.keys.set(k.id, k);
    const now = Date.now();
    for (const [hash, s] of Object.entries(await this.loadObject<Session>('sessions'))) if (s.expires > now) this.sessions.set(hash, s);
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadObject<unknown>('settings')) };
    this.stats = await this.loadObject<unknown>('stats');
    const oauth = await this.loadObject<Record<string, never>>('oauth');
    this.oauth = { clients: oauth.clients ?? {}, tokens: oauth.tokens ?? {} };
    for (const [hash, t] of Object.entries(this.oauth.tokens)) if (t.expires < now) delete this.oauth.tokens[hash];
  }

  private async read(name: string): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir!, `${name}.json`), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[planar] could not read ${name}.json:`, e);
      return null;
    }
  }
  private async load<T>(name: string): Promise<T[]> {
    const v = await this.read(name);
    return Array.isArray(v) ? (v as T[]) : [];
  }
  private async loadObject<T>(name: string): Promise<Record<string, T>> {
    const v = await this.read(name);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {};
  }

  /** Schedules a write of one collection. */
  touch(name: 'users' | 'files' | 'keys' | 'sessions' | 'settings' | 'stats' | 'oauth'): void {
    if (!this.dir || this.timers.has(name)) return;
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        void this.write(name);
      }, 300),
    );
  }

  private write(name: string): Promise<void> {
    const data =
      name === 'users'
        ? [...this.users.values()]
        : name === 'files'
          ? [...this.files.values()]
          : name === 'keys'
            ? [...this.keys.values()]
            : name === 'settings'
              ? this.settings
              : name === 'stats'
                ? this.stats
                : name === 'oauth'
                  ? this.oauth
                : Object.fromEntries(this.sessions);
    const file = path.join(this.dir!, `${name}.json`);
    const json = JSON.stringify(data);
    this.writing = this.writing.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, json, { mode: 0o600 });
      await fs.rename(tmp, file);
    });
    return this.writing.catch((e) => console.error(`[planar] could not save ${name}.json:`, e));
  }

  async flush(): Promise<void> {
    if (!this.dir) return;
    for (const t of this.timers.values()) clearTimeout(t);
    const names = [...this.timers.keys()];
    this.timers.clear();
    await Promise.all(names.map((n) => this.write(n)));
    await this.writing;
  }

  // ---- users -------------------------------------------------------------

  userByName(username: string): User | null {
    const name = username.trim().toLowerCase();
    for (const u of this.users.values()) if (u.username === name) return u;
    return null;
  }

  async createUser(username: string, password: string, displayName: string): Promise<User> {
    const salt = randomBytes(16).toString('hex');
    const user: User = {
      id: randomId(),
      username,
      displayName: displayName || username,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      passHash: (await scrypt(password, salt)).toString('hex'),
      salt,
      createdAt: Date.now(),
    };
    this.users.set(user.id, user);
    this.touch('users');
    return user;
  }

  async checkPassword(user: User, password: string): Promise<boolean> {
    const given = await scrypt(password, user.salt);
    const stored = Buffer.from(user.passHash, 'hex');
    return given.length === stored.length && timingSafeEqual(given, stored);
  }

  /** Burns the same time as a real check, for logins with an unknown username. */
  async dummyHash(password: string): Promise<void> {
    await scrypt(password, 'planar-no-such-user');
  }

  async setPassword(user: User, password: string): Promise<void> {
    user.salt = randomBytes(16).toString('hex');
    user.passHash = (await scrypt(password, user.salt)).toString('hex');
    this.touch('users');
  }

  // ---- sessions and keys -------------------------------------------------

  createSession(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(sha256(token), { userId, expires: Date.now() + SESSION_DAYS * 86_400_000 });
    this.touch('sessions');
    return token;
  }

  sessionUser(token: string): User | null {
    const hash = sha256(token);
    const s = this.sessions.get(hash);
    if (!s) return null;
    if (s.expires < Date.now()) {
      this.sessions.delete(hash);
      return null;
    }
    const user = this.users.get(s.userId);
    return user && !user.blocked ? user : null;
  }

  /** Notes that someone is active (throttled to one write a minute). */
  seen(user: User): void {
    const now = Date.now();
    if (!user.lastSeenAt || now - user.lastSeenAt > 60_000) {
      user.lastSeenAt = now;
      this.touch('users');
    }
  }

  dropSession(token: string): void {
    if (this.sessions.delete(sha256(token))) this.touch('sessions');
  }

  dropUserSessions(userId: string, except?: string): void {
    const keep = except ? sha256(except) : null;
    for (const [hash, s] of this.sessions) if (s.userId === userId && hash !== keep) this.sessions.delete(hash);
    this.touch('sessions');
    // Connected apps (OAuth) are signed out too.
    for (const [hash, t] of Object.entries(this.oauth.tokens)) if (t.userId === userId) delete this.oauth.tokens[hash];
    this.touch('oauth');
  }

  createKey(userId: string, name: string): { key: ApiKey; secret: string } {
    const secret = `plk_${randomBytes(24).toString('base64url')}`;
    const key: ApiKey = { id: randomId(6), userId, name, hash: sha256(secret), prefix: secret.slice(0, 8), createdAt: Date.now(), lastUsed: null };
    this.keys.set(key.id, key);
    this.touch('keys');
    return { key, secret };
  }

  /** The user behind a bearer secret: a personal API key (plk_…) or an OAuth access token (pla_…). */
  keyUser(secret: string): User | null {
    if (secret.startsWith('pla_')) return this.oauthUser(secret);
    if (!secret.startsWith('plk_')) return null;
    const hash = sha256(secret);
    for (const k of this.keys.values()) {
      if (k.hash === hash) {
        if (!k.lastUsed || Date.now() - k.lastUsed > 60_000) {
          k.lastUsed = Date.now();
          this.touch('keys');
        }
        const user = this.users.get(k.userId);
        return user && !user.blocked ? user : null;
      }
    }
    return null;
  }

  issueOAuthToken(kind: OAuthToken['kind'], userId: string, client: { clientId: string; clientName: string }, ttlMs: number): string {
    const secret = `${kind === 'access' ? 'pla' : 'plr'}_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    this.oauth.tokens[sha256(secret)] = { kind, userId, ...client, expires: now + ttlMs, createdAt: now, lastUsed: null };
    this.touch('oauth');
    return secret;
  }

  /** Looks up a token of the given kind; null if unknown, expired or of another kind. */
  oauthToken(secret: string, kind: OAuthToken['kind']): OAuthToken | null {
    const hash = sha256(secret);
    const t = this.oauth.tokens[hash];
    if (!t || t.kind !== kind) return null;
    if (t.expires < Date.now()) {
      delete this.oauth.tokens[hash];
      this.touch('oauth');
      return null;
    }
    return t;
  }

  dropOAuthToken(secret: string): void {
    delete this.oauth.tokens[sha256(secret)];
    this.touch('oauth');
  }

  private oauthUser(secret: string): User | null {
    const t = this.oauthToken(secret, 'access');
    if (!t) return null;
    if (!t.lastUsed || Date.now() - t.lastUsed > 60_000) {
      t.lastUsed = Date.now();
      this.touch('oauth');
    }
    const user = this.users.get(t.userId);
    return user && !user.blocked ? user : null;
  }

  // ---- files -------------------------------------------------------------

  /** Records an edit (and the name, if it changed). */
  fileEdited(id: string, name?: string): void {
    const f = this.files.get(id);
    if (!f) return;
    f.updatedAt = Date.now();
    if (name !== undefined) f.name = name;
    this.touch('files');
  }

  createFile(ownerId: string | null, name: string, id = randomFileId()): FileRecord {
    const now = Date.now();
    const rec: FileRecord = { id, name, ownerId, createdAt: now, updatedAt: now, deletedAt: null, linkAccess: 'none', members: {} };
    this.files.set(id, rec);
    this.touch('files');
    return rec;
  }
}

export function randomFileId(): string {
  const bytes = randomBytes(12);
  return Array.from(bytes, (b) => 'abcdefghijkmnopqrstuvwxyz23456789'[b % 33]).join('');
}
