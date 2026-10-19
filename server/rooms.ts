import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDocument } from '../src/core/document';
import { applyOps, type Op } from '../src/core/ops';
import type { PlanarDocument } from '../src/core/types';

export const ROOM_ID = /^[A-Za-z0-9_-]{6,64}$/;

/** One shared document and the version of its latest change. */
export class Room {
  version = 0;
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    readonly id: string,
    public doc: PlanarDocument,
    private readonly file: string | null,
  ) {}

  apply(ops: Op[]): number {
    applyOps(this.doc, ops);
    this.version++;
    this.scheduleSave();
    return this.version;
  }

  scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 1000);
  }

  /** Writes the document atomically (temp file + rename). */
  save(): Promise<void> {
    if (!this.file) return Promise.resolve();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const file = this.file;
    const json = JSON.stringify(this.doc);
    this.saving = this.saving.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, json);
      await fs.rename(tmp, file);
    });
    return this.saving.catch((e) => console.error(`[planar] could not save room ${this.id}:`, e));
  }
}

/** Loads rooms from disk on demand and keeps them in memory. */
export class RoomStore {
  private rooms = new Map<string, Room>();

  constructor(private readonly dir: string | null) {}

  private fileFor(id: string): string | null {
    return this.dir ? path.join(this.dir, `${id}.planar.json`) : null;
  }

  async init(): Promise<void> {
    if (this.dir) await fs.mkdir(this.dir, { recursive: true });
  }

  async get(id: string): Promise<Room | null> {
    const cached = this.rooms.get(id);
    if (cached) return cached;
    const file = this.fileFor(id);
    if (!file) return null;
    try {
      const doc = parseDocument(JSON.parse(await fs.readFile(file, 'utf8')));
      const room = this.rooms.get(id) ?? new Room(id, doc, file);
      this.rooms.set(id, room);
      return room;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[planar] could not load room ${id}:`, e);
      return null;
    }
  }

  async create(id: string, doc: PlanarDocument): Promise<Room> {
    const existing = await this.get(id);
    if (existing) return existing;
    const room = new Room(id, doc, this.fileFor(id));
    this.rooms.set(id, room);
    await room.save();
    return room;
  }

  async saveAll(): Promise<void> {
    await Promise.all([...this.rooms.values()].map((r) => r.save()));
  }
}
