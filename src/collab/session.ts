import type { Editor } from '../core/editor';
import { CollabClient } from './client';

const SETTINGS_KEY = 'planar:collab';

export const PEER_COLORS = ['#e5484d', '#f2a65a', '#4cc38a', '#3e9bf0', '#8e6cf0', '#d65cb7', '#12a594', '#ffb224'];

export interface CollabSettings {
  serverUrl: string;
  name: string;
  color: string;
  token: string;
}

export function loadSettings(): CollabSettings {
  const fallback: CollabSettings = {
    serverUrl: '',
    name: '',
    color: PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)],
    token: '',
  };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return fallback;
  }
}

export function saveSettings(s: CollabSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Settings are a convenience only.
  }
}

/** True when this page is served by a Planar collaboration server. */
export async function detectServer(): Promise<string | null> {
  try {
    const res = await fetch(new URL('api/info', location.href), { cache: 'no-store' });
    const info = res.ok ? await res.json() : null;
    return info?.planar ? location.origin : null;
  } catch {
    return null;
  }
}

export function randomRoomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => 'abcdefghijkmnopqrstuvwxyz23456789'[b % 33]).join('');
}

function sameOrigin(serverUrl: string): boolean {
  try {
    return new URL(/^[a-z]+:\/\//i.test(serverUrl) ? serverUrl.replace(/^ws/i, 'http') : `https://${serverUrl}`).origin === location.origin;
  } catch {
    return false;
  }
}

/** Link that opens this editor and joins the room. The token stays in the hash. */
export function shareLink(serverUrl: string, roomId: string, token: string): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', roomId);
  if (!sameOrigin(serverUrl)) url.searchParams.set('server', serverUrl);
  if (token) url.hash = `t=${encodeURIComponent(token)}`;
  return url.toString();
}

/** Room details from the current address, if it is a join link. */
export function parseJoinLink(): { roomId: string; serverUrl: string | null; token: string } | null {
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) return null;
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { roomId, serverUrl: params.get('server'), token: hash.get('t') ?? '' };
}

let current: CollabClient | null = null;

export interface SessionOptions {
  serverUrl: string;
  roomId: string;
  name: string;
  color: string;
  token: string;
  /** Upload the current document as a new room. */
  create: boolean;
}

export function startSession(editor: Editor, opts: SessionOptions): void {
  current?.stop();
  const link = shareLink(opts.serverUrl, opts.roomId, opts.token);
  const client = new CollabClient(editor, {
    serverUrl: opts.serverUrl,
    roomId: opts.roomId,
    name: opts.name || 'Guest',
    color: opts.color,
    token: opts.token || undefined,
    createWith: opts.create ? editor.doc : undefined,
    shareUrl: link,
  });
  current = client;
  client.start();
  // Leaving also removes the room from the address bar.
  const info = editor.collab!;
  info.leave = () => {
    client.stop();
    if (current === client) current = null;
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    history.replaceState(null, '', url);
  };
  history.replaceState(null, '', link);
}
