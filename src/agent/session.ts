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
  /** Remote endpoint: connect rooms to this server instead of the link's host. */
  localServer?: string;
  /** Token to use for rooms when none is given. */
  token?: string;
  name?: string;
}

export interface RoomTarget {
  serverUrl: string;
  roomId: string;
  token: string;
  link: string;
}

/** Reads a share link like https://host/?room=ID#t=TOKEN (or ?server=…). */
export function parseLink(link: string): RoomTarget {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error(`Not a link: ${link}`);
  }
  const roomId = url.searchParams.get('room');
  if (!roomId) throw new Error('The link has no ?room= — copy it from Share in Planar.');
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  return { serverUrl: url.searchParams.get('server') ?? url.origin, roomId, token: hash.get('t') ?? '', link };
}

export class AgentSession {
  editor: Editor | null = null;
  mode: 'none' | 'file' | 'room' = 'none';
  file: string | null = null;
  private mtime = 0;
  private client: CollabClient | null = null;

  constructor(readonly opts: SessionOptions) {}

  describe(): string {
    if (this.mode === 'file') return `file ${this.file}`;
    if (this.mode === 'room' && this.editor?.collab) return `live room ${this.editor.collab.roomId} on ${this.editor.collab.serverUrl} (${this.editor.collab.status})`;
    return 'nothing open';
  }

  close(): void {
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

  async openRoom(target: RoomTarget): Promise<string> {
    this.close();
    const editor = new Editor(createDocument(), { autosave: false });
    const serverUrl = this.opts.localServer ?? target.serverUrl;
    const client = new CollabClient(editor, {
      serverUrl,
      roomId: target.roomId,
      name: this.opts.name ?? 'Agent',
      color: '#8e6cf0',
      token: target.token || this.opts.token,
      shareUrl: target.link,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    client.start();
    const started = Date.now();
    while (client.status !== 'connected') {
      if (client.status === 'error' || Date.now() - started > 10_000) {
        const reason = editor.collab?.error ?? 'timed out';
        client.stop();
        throw new Error(`Could not join room ${target.roomId}: ${reason}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    this.editor = editor;
    this.client = client;
    this.mode = 'room';
    return `Joined live room ${target.roomId} as "${this.opts.name ?? 'Agent'}" — people in the room see your changes immediately.`;
  }

  /** The open editor, reloading the file first if it changed on disk. */
  async ready(): Promise<Editor> {
    if (!this.editor) throw new Error('No document is open. Call open with a file path or a Planar share link first.');
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
    if (this.mode === 'room') await this.client?.settled(5000).catch(() => undefined);
  }

  private async save(): Promise<void> {
    if (!this.file || !this.editor) return;
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.editor.doc, null, 1));
    await fs.rename(tmp, this.file);
    this.mtime = (await fs.stat(this.file)).mtimeMs;
  }
}
