import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { parseDocument } from '../src/core/document';
import type { PlanarDocument } from '../src/core/types';
import { randomId } from './db';

const gz = promisify(gzip);
const gunz = promisify(gunzip);

export type VersionKind = 'auto' | 'named' | 'agent' | 'restore';

export interface VersionMeta {
  id: string;
  fileId: string;
  createdAt: number;
  label: string;
  kind: VersionKind;
  authorId: string | null;
  authorName: string;
  /** Layers in the snapshot. */
  nodes: number;
  /** Size in bytes (gzip on disk). */
  bytes: number;
  /** Hash of the document, to skip snapshots of an unchanged file. */
  hash: string;
}

export const AUTO_KEEP_MS = 30 * 86_400_000;
export const AUTO_KEEP_COUNT = 100;
const FILE_ID = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Snapshots of documents. Each file has a folder with an index.json and one
 * gzip file per snapshot; without a data directory everything stays in memory.
 */
export class VersionStore {
  private index = new Map<string, VersionMeta[]>();
  private memory = new Map<string, string>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string | null) {}

  private folder(fileId: string): string {
    return path.join(this.dir!, fileId);
  }

  private async metas(fileId: string): Promise<VersionMeta[]> {
    const cached = this.index.get(fileId);
    if (cached) return cached;
    let list: VersionMeta[] = [];
    if (this.dir && FILE_ID.test(fileId)) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.folder(fileId), 'index.json'), 'utf8'));
        if (Array.isArray(parsed)) list = parsed as VersionMeta[];
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[planar] could not read versions of ${fileId}:`, e);
      }
    }
    // Another call may have loaded it meanwhile.
    const again = this.index.get(fileId);
    if (again) return again;
    this.index.set(fileId, list);
    return list;
  }

  private persistIndex(fileId: string): void {
    if (!this.dir) return;
    const json = JSON.stringify(this.index.get(fileId) ?? []);
    const file = path.join(this.folder(fileId), 'index.json');
    this.writing = this.writing
      .then(async () => {
        await fs.mkdir(this.folder(fileId), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, json);
        await fs.rename(tmp, file);
      })
      .catch((e) => console.error(`[planar] could not write versions of ${fileId}:`, e));
  }

  /** Newest first. */
  async list(fileId: string): Promise<VersionMeta[]> {
    return [...(await this.metas(fileId))].sort((a, b) => b.createdAt - a.createdAt);
  }

  async latest(fileId: string, kind?: VersionKind): Promise<VersionMeta | null> {
    return (await this.list(fileId)).find((v) => !kind || v.kind === kind) ?? null;
  }

  /**
   * Stores the document as it is now. The JSON is taken before the first
   * await, so edits applied right after do not leak into the snapshot.
   * Returns null if the document equals the newest snapshot (unless `force`).
   */
  async save(
    fileId: string,
    doc: PlanarDocument,
    info: { kind: VersionKind; label: string; authorId: string | null; authorName: string },
    force = false,
  ): Promise<VersionMeta | null> {
    const json = JSON.stringify(doc);
    const nodes = Object.keys(doc.nodes).length;
    const hash = createHash('sha1').update(json).digest('hex');
    const list = await this.metas(fileId);
    const newest = [...list].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!force && newest?.hash === hash) return null;
    const meta: VersionMeta = {
      id: randomId(6),
      fileId,
      createdAt: Date.now(),
      label: info.label.slice(0, 120),
      kind: info.kind,
      authorId: info.authorId,
      authorName: info.authorName.slice(0, 40),
      nodes,
      bytes: json.length,
      hash,
    };
    list.push(meta);
    if (this.dir) {
      const data = await gz(json);
      meta.bytes = data.length;
      const file = path.join(this.folder(fileId), `${meta.id}.json.gz`);
      this.writing = this.writing
        .then(async () => {
          await fs.mkdir(this.folder(fileId), { recursive: true });
          await fs.writeFile(file, data);
        })
        .catch((e) => console.error(`[planar] could not write a version of ${fileId}:`, e));
    } else {
      this.memory.set(`${fileId}/${meta.id}`, json);
    }
    this.prune(fileId, list);
    this.persistIndex(fileId);
    return meta;
  }

  async load(fileId: string, id: string): Promise<{ meta: VersionMeta; doc: PlanarDocument } | null> {
    const meta = (await this.metas(fileId)).find((v) => v.id === id);
    if (!meta) return null;
    try {
      let json: string;
      if (this.dir) {
        await this.writing;
        json = (await gunz(await fs.readFile(path.join(this.folder(fileId), `${id}.json.gz`)))).toString('utf8');
      } else {
        json = this.memory.get(`${fileId}/${id}`) ?? '';
      }
      return { meta, doc: parseDocument(JSON.parse(json)) };
    } catch (e) {
      console.error(`[planar] could not read version ${id} of ${fileId}:`, e);
      return null;
    }
  }

  /** Names or renames a snapshot; a named snapshot is kept for good. */
  async name(fileId: string, id: string, label: string): Promise<VersionMeta | null> {
    const meta = (await this.metas(fileId)).find((v) => v.id === id);
    if (!meta) return null;
    meta.label = label.slice(0, 120);
    if (meta.kind === 'auto') meta.kind = 'named';
    this.persistIndex(fileId);
    return meta;
  }

  /** Drops old automatic snapshots: older than 30 days, or beyond the newest 100. */
  private prune(fileId: string, list: VersionMeta[], now = Date.now()): void {
    const autos = list.filter((v) => v.kind === 'auto').sort((a, b) => b.createdAt - a.createdAt);
    const drop = new Set(autos.filter((v, i) => i >= AUTO_KEEP_COUNT || now - v.createdAt > AUTO_KEEP_MS).map((v) => v.id));
    if (!drop.size) return;
    const keep = list.filter((v) => !drop.has(v.id));
    list.splice(0, list.length, ...keep);
    for (const id of drop) {
      this.memory.delete(`${fileId}/${id}`);
      if (this.dir) {
        this.writing = this.writing.then(() => fs.rm(path.join(this.folder(fileId), `${id}.json.gz`), { force: true })).catch(() => undefined);
      }
    }
  }

  /** Runs the cleanup as of another time (tests). */
  async pruneAt(fileId: string, now: number): Promise<void> {
    this.prune(fileId, await this.metas(fileId), now);
    this.persistIndex(fileId);
  }

  async removeFile(fileId: string): Promise<void> {
    this.index.delete(fileId);
    for (const k of [...this.memory.keys()]) if (k.startsWith(`${fileId}/`)) this.memory.delete(k);
    if (this.dir && FILE_ID.test(fileId)) {
      this.writing = this.writing.then(() => fs.rm(this.folder(fileId), { recursive: true, force: true })).catch(() => undefined);
    }
  }

  async flush(): Promise<void> {
    await this.writing;
  }
}
