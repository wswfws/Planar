import type { Editor, FileRole } from '../core/editor';
import type { PlanarDocument } from '../core/types';
import { CollabClient } from './client';

export const PEER_COLORS = ['#e5484d', '#f2a65a', '#4cc38a', '#3e9bf0', '#8e6cf0', '#d65cb7', '#12a594', '#ffb224'];

// ---- account and file API (same origin as the editor) -----------------------

export interface Me {
  id: string;
  username: string;
  displayName: string;
  color: string;
  /** May open /admin. */
  admin?: boolean;
}

export type LinkAccess = 'none' | 'view' | 'edit';

export interface Member extends Me {
  role: 'editor' | 'viewer';
}

export interface FileInfo {
  id: string;
  name: string;
  role: FileRole | null;
  owner: Me | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  linkAccess: LinkAccess;
  members?: Member[];
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsed: number | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the server', 0);
  }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const accounts = {
  me: () => api<{ user: Me | null }>('GET', '/api/me').then((r) => r.user),
  register: (username: string, password: string, displayName: string) => api<{ user: Me }>('POST', '/api/auth/register', { username, password, displayName }).then((r) => r.user),
  login: (username: string, password: string) => api<{ user: Me }>('POST', '/api/auth/login', { username, password }).then((r) => r.user),
  logout: () => api('POST', '/api/auth/logout', {}),
  update: (patch: { displayName?: string; color?: string; oldPassword?: string; newPassword?: string }) => api<{ user: Me }>('PATCH', '/api/me', patch).then((r) => r.user),
  keys: () => api<{ keys: ApiKeyInfo[] }>('GET', '/api/me/keys').then((r) => r.keys),
  createKey: (name: string) => api<{ key: ApiKeyInfo; secret: string }>('POST', '/api/me/keys', { name }),
  deleteKey: (id: string) => api('DELETE', `/api/me/keys/${encodeURIComponent(id)}`),
  apps: () => api<{ apps: { clientId: string; name: string; connectedAt: number; lastUsed: number | null }[] }>('GET', '/api/me/apps').then((r) => r.apps),
  disconnectApp: (clientId: string) => api('DELETE', `/api/me/apps/${encodeURIComponent(clientId)}`),
  findUsers: (q: string) => api<{ users: Omit<Me, 'id'>[] }>('GET', `/api/users?q=${encodeURIComponent(q)}`).then((r) => r.users),
};

export type FileScope = 'mine' | 'shared' | 'trash';

export const files = {
  list: (scope: FileScope) => api<{ files: FileInfo[] }>('GET', `/api/files?scope=${scope}`).then((r) => r.files),
  create: (body: { name?: string; doc?: PlanarDocument } = {}) => api<{ file: FileInfo }>('POST', '/api/files', body).then((r) => r.file),
  get: (id: string) => api<{ file: FileInfo }>('GET', `/api/files/${id}`).then((r) => r.file),
  rename: (id: string, name: string) => api<{ file: FileInfo }>('PATCH', `/api/files/${id}`, { name }).then((r) => r.file),
  setLinkAccess: (id: string, linkAccess: LinkAccess) => api<{ file: FileInfo }>('PATCH', `/api/files/${id}`, { linkAccess }).then((r) => r.file),
  duplicate: (id: string) => api<{ file: FileInfo }>('POST', `/api/files/${id}/duplicate`, {}).then((r) => r.file),
  trash: (id: string) => api('DELETE', `/api/files/${id}`),
  restore: (id: string) => api('POST', `/api/files/${id}/restore`, {}),
  deleteForever: (id: string) => api('DELETE', `/api/files/${id}?forever=1`),
  setMember: (id: string, username: string, role: 'editor' | 'viewer' | null) =>
    api<{ file: FileInfo }>('PUT', `/api/files/${id}/members`, { username, role }).then((r) => r.file),
  transfer: (id: string, username: string) => api<{ file: FileInfo }>('POST', `/api/files/${id}/transfer`, { username }).then((r) => r.file),
  downloadUrl: (id: string) => `/api/files/${id}/download`,
  thumbnailUrl: (id: string, version: number) => `/api/files/${id}/thumbnail.png?v=${version}`,
};

// ---- admin --------------------------------------------------------------------

export interface AdminSettings {
  registrationOpen: boolean;
  maxFilesPerUser: number;
  maxFileBytes: number;
}

export interface AdminOverview {
  now: number;
  gauges: {
    users: number;
    blockedUsers: number;
    usersOnline: number;
    sockets: number;
    openFiles: number;
    files: number;
    trashedFiles: number;
    apiKeys: number;
    sessions: number;
    mcpSessions: number;
    dataBytes: number;
    disk: { free: number; total: number } | null;
    rss: number;
    heapUsed: number;
    memTotal: number;
    memFree: number;
    load: number[];
    cpus: number;
    uptime: number;
    node: string;
  };
  counters: Record<string, number>;
  series: { t: number; online: number; ops: number; requests: number; errors: number; rss: number }[];
  days: { day: string; registrations: number; active: number; edits: number; requests: number; errors: number }[];
  events: { t: number; kind: string; text: string }[];
  alerts: { configured: boolean };
  settings: AdminSettings;
}

export interface AdminUser extends Me {
  createdAt: number;
  lastSeenAt: number | null;
  blocked: boolean;
  admin: boolean;
  online: boolean;
  files: number;
  bytes: number;
  keys: number;
}

export interface AdminFile {
  id: string;
  name: string;
  owner: Me | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  linkAccess: LinkAccess;
  members: number;
  online: number;
  bytes: number;
}

export const admin = {
  overview: () => api<AdminOverview>('GET', '/api/admin/overview'),
  users: (q = '') => api<{ users: AdminUser[] }>('GET', `/api/admin/users?q=${encodeURIComponent(q)}`).then((r) => r.users),
  setBlocked: (id: string, blocked: boolean) => api('POST', `/api/admin/users/${id}`, { blocked }),
  signOut: (id: string) => api('POST', `/api/admin/users/${id}/logout`, {}),
  deleteUser: (id: string, files: 'delete' | `transfer:${string}`) => api('DELETE', `/api/admin/users/${id}?files=${encodeURIComponent(files)}`),
  files: (q = '') => api<{ files: AdminFile[] }>('GET', `/api/admin/files?q=${encodeURIComponent(q)}`).then((r) => r.files),
  updateFile: (id: string, patch: { linkAccess?: LinkAccess; ownerUsername?: string }) => api('POST', `/api/admin/files/${id}`, patch),
  deleteFile: (id: string) => api('DELETE', `/api/admin/files/${id}`),
  saveSettings: (s: Partial<AdminSettings>) => api<{ settings: AdminSettings }>('POST', '/api/admin/settings', s).then((r) => r.settings),
  testAlert: () => api('POST', '/api/admin/alerts/test', {}),
};

/** True when this page is served by a Planar server (so accounts and files are available). */
export async function detectServer(): Promise<boolean> {
  try {
    const res = await fetch(new URL('api/info', location.origin), { cache: 'no-store' });
    const info = res.ok ? await res.json() : null;
    return !!info?.planar && !!info.accounts;
  } catch {
    return false;
  }
}

export const fileLink = (id: string): string => `${location.origin}/file/${id}`;

// ---- live session ---------------------------------------------------------

const GUEST_KEY = 'planar:guest';

/** Name shown for people who open a file without signing in. */
export function guestName(): string {
  try {
    let name = localStorage.getItem(GUEST_KEY);
    if (!name) {
      name = `Guest ${100 + Math.floor(Math.random() * 900)}`;
      localStorage.setItem(GUEST_KEY, name);
    }
    return name;
  } catch {
    return 'Guest';
  }
}

let current: CollabClient | null = null;

/** Opens a server file in the editor and keeps it live. Returns a function that disconnects. */
export function openServerFile(editor: Editor, fileId: string): () => void {
  current?.stop();
  const client = new CollabClient(editor, {
    serverUrl: location.origin,
    fileId,
    guestName: guestName(),
    color: PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)],
    shareUrl: fileLink(fileId),
  });
  current = client;
  client.start();
  return () => {
    client.stop();
    if (current === client) current = null;
  };
}
