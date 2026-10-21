// The document an agent works on: a .planar.json file or a live room.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { CollabClient } from '../collab/client';
import { createDocument, parseDocument } from '../core/document';
import { Editor } from '../core/editor';
import { worldCenter } from '../core/geometry';
import { ensureDocumentFonts } from './fonts';

export interface SessionOptions {
  /** Whether tools may read and write local files (false on the remote endpoint). */
  allowFiles: boolean;
  /** Remote endpoint: this very server (files are opened without going through the network name). */
  localServer?: string;
  /** Server for the files tool when no link was given (https://planar.example.com). */
  server?: string;
  /** Personal API key (`plk_…`): the agent acts with this person's rights. */
  key?: string;
  name?: string;
}

export interface RoomTarget {
  serverUrl: string;
  fileId: string;
  link: string;
}

/** Reads a file link like https://host/file/ID (older ?room=ID links work too). */
export function parseLink(link: string): RoomTarget {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error(`Not a link: ${link}`);
  }
  const fileId = /^\/file\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1] ?? url.searchParams.get('room');
  if (!fileId) throw new Error('The link is not a Planar file link (expected https://host/file/<id>) — copy it from Share in Planar.');
  return { serverUrl: url.origin, fileId, link };
}

interface FileRow {
  id: string;
  name: string;
  role: string | null;
  owner: { username: string } | null;
  updatedAt: number;
}

/** How long an agent keeps pointing at what it last changed. */
const AGENT_PRESENCE_MS = 60_000;

export interface RemoteFile extends FileRow {
  link: string;
}

export class AgentSession {
  editor: Editor | null = null;
  mode: 'none' | 'file' | 'room' = 'none';
  file: string | null = null;
  private mtime = 0;
  private client: CollabClient | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly opts: SessionOptions) {}

  describe(): string {
    if (this.mode === 'file') return `file ${this.file}`;
    if (this.mode === 'room' && this.editor?.collab) return `live file ${this.editor.collab.fileId} on ${this.editor.collab.serverUrl} (${this.editor.collab.status})`;
    return 'nothing open';
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.client?.stop();
    this.client = null;
    this.editor = null;
    this.mode = 'none';
    this.file = null;
  }

  async openFile(file: string): Promise<string> {
    if (!this.opts.allowFiles) throw new Error('This server cannot open local files; open a room link instead.');
    this.close();
    const full = path.resolve(file);
    let created = false;
    let doc;
    try {
      doc = parseDocument(JSON.parse(await fs.readFile(full, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot open ${full}: ${(e as Error).message}`);
      doc = createDocument(path.basename(full).replace(/\.planar\.json$|\.json$/, '') || 'Untitled');
      created = true;
    }
    this.editor = new Editor(doc, { autosave: false });
    this.mode = 'file';
    this.file = full;
    if (created) await this.save();
    else this.mtime = (await fs.stat(full)).mtimeMs;
    return created ? `Created ${full}` : `Opened ${full}`;
  }

  private base(): string {
    const base = this.opts.localServer ?? this.opts.server;
    if (!base) throw new Error('No Planar server is set. Start the MCP server with --server https://your-planar-host (or open a file link first).');
    return base.replace(/\/+$/, '');
  }

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    if (!this.opts.key) throw new Error('No API key. Create one in Planar (account menu → API keys) and pass it as --key or PLANAR_KEY.');
    const res = await fetch(`${this.base()}${route}`, {
      method,
      headers: { Authorization: `Bearer ${this.opts.key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
    if (!res.ok) throw new Error(data.error ?? `Server answered ${res.status}`);
    return data;
  }

  private remoteFile(f: FileRow): RemoteFile {
    return { id: f.id, name: f.name, role: f.role, owner: f.owner, updatedAt: f.updatedAt, link: `${this.base()}/file/${f.id}` };
  }

  /** Files of the key's owner: their own, or those shared with them. */
  async listFiles(scope: 'mine' | 'shared' = 'mine'): Promise<RemoteFile[]> {
    const { files } = await this.request<{ files: FileRow[] }>('GET', `/api/files?scope=${scope}`);
    return files.map((f) => this.remoteFile(f));
  }

  async createFile(name?: string): Promise<RemoteFile> {
    const { file } = await this.request<{ file: FileRow }>('POST', '/api/files', { name });
    return this.remoteFile(file);
  }

  async duplicateFile(id: string): Promise<RemoteFile> {
    const { file } = await this.request<{ file: FileRow }>('POST', `/api/files/${encodeURIComponent(id)}/duplicate`, {});
    return this.remoteFile(file);
  }

  async openFileId(id: string): Promise<string> {
    return this.openRoom({ serverUrl: this.base(), fileId: id, link: `${this.base()}/file/${id}` });
  }

  async openRoom(target: RoomTarget): Promise<string> {
    this.close();
    const editor = new Editor(createDocument(), { autosave: false });
    const serverUrl = this.opts.localServer ?? target.serverUrl;
    const client = new CollabClient(editor, {
      serverUrl,
      fileId: target.fileId,
      guestName: this.opts.name ?? 'Agent',
      color: '#8e6cf0',
      key: this.opts.key,
      shareUrl: target.link,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    client.start();
    const started = Date.now();
    while (client.status !== 'connected') {
      if (client.status === 'error' || Date.now() - started > 10_000) {
        const reason = editor.collab?.error ?? 'timed out';
        client.stop();
        throw new Error(`Could not open file ${target.fileId}: ${reason}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    this.editor = editor;
    this.client = client;
    this.mode = 'room';
    const view = editor.readOnly ? ' (view-only: you cannot edit this file)' : '';
    return `Opened live file ${target.fileId}${view} — people in the file see your changes immediately.`;
  }

  /** The open editor, reloading the file first if it changed on disk. */
  async ready(): Promise<Editor> {
    if (!this.editor) throw new Error('No document is open. Call files to list your Planar files, then open one (or open a file link or local path).');
    if (this.mode === 'file' && this.file) {
      const stat = await fs.stat(this.file).catch(() => null);
      if (stat && stat.mtimeMs !== this.mtime) {
        const doc = parseDocument(JSON.parse(await fs.readFile(this.file, 'utf8')));
        const page = this.editor.pageId;
        this.editor.replaceDocument(doc, { keepView: true });
        if (doc.nodes[page]) this.editor.pageId = page;
        this.mtime = stat.mtimeMs;
      }
    }
    return this.editor;
  }

  /** Persists or shares changes and shows people where the agent worked. */
  /** Loads the document's web fonts for rendering and measuring text. */
  async ensureFonts(): Promise<void> {
    if (this.editor && (await ensureDocumentFonts(this.editor.doc))) this.editor.remeasureText();
  }

  async committed(touched: string[]): Promise<void> {
    const editor = this.editor;
    if (!editor) return;
    await this.ensureFonts();
    const visible = touched.filter((id) => editor.doc.nodes[id]);
    if (visible.length) {
      editor.select(visible);
      editor.setPointer(worldCenter(editor.doc, visible[0]));
    }
    if (this.mode === 'file') await this.save();
    if (this.mode === 'room') {
      await this.client?.settled(5000).catch(() => undefined);
      // Point at the work for a while, then step aside so the cursor and outlines do not linger.
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.editor !== editor) return;
        editor.select([]);
        editor.setPointer(null);
      }, AGENT_PRESENCE_MS);
      this.idleTimer.unref?.();
    }
  }

  private async save(): Promise<void> {
    if (!this.file || !this.editor) return;
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.editor.doc, null, 1));
    await fs.rename(tmp, this.file);
    this.mtime = (await fs.stat(this.file)).mtimeMs;
  }
}
