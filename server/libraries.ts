import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { LibrarySnapshot } from '../src/core/library';

const gz = promisify(gzip);
const gunz = promisify(gunzip);
const FILE_ID = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Published team libraries: the latest snapshot of each library file, as one
 * gzip file per library; without a data directory they stay in memory.
 */
export class LibraryStore {
  private memory = new Map<string, LibrarySnapshot>();

  constructor(private readonly dir: string | null) {}

  private file(fileId: string): string {
    return path.join(this.dir!, `${fileId}.json.gz`);
  }

  async save(snapshot: LibrarySnapshot): Promise<void> {
    this.memory.set(snapshot.fileId, snapshot);
    if (!this.dir || !FILE_ID.test(snapshot.fileId)) return;
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.file(snapshot.fileId);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, await gz(JSON.stringify(snapshot)));
    await fs.rename(tmp, target);
  }

  async load(fileId: string): Promise<LibrarySnapshot | null> {
    const cached = this.memory.get(fileId);
    if (cached) return cached;
    if (!this.dir || !FILE_ID.test(fileId)) return null;
    try {
      const snapshot = JSON.parse((await gunz(await fs.readFile(this.file(fileId)))).toString('utf8')) as LibrarySnapshot;
      this.memory.set(fileId, snapshot);
      return snapshot;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[planar] could not read library ${fileId}:`, e);
      return null;
    }
  }

  async remove(fileId: string): Promise<void> {
    this.memory.delete(fileId);
    if (!this.dir || !FILE_ID.test(fileId)) return;
    await fs.rm(this.file(fileId), { force: true });
  }
}
