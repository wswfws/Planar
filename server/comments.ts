import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomId } from './db';

export interface Comment {
  id: string;
  fileId: string;
  /** Id of the first comment of the thread; null on that first comment itself. */
  threadId: string | null;
  pageId: string;
  /** Layer the pin is attached to (it moves with it); null = free on the page. */
  nodeId: string | null;
  /** Position: inside the layer when attached, on the page otherwise. */
  x: number;
  y: number;
  authorId: string;
  authorName: string;
  /** Written by an AI agent acting for the author. */
  agent: boolean;
  text: string;
  createdAt: number;
  editedAt: number | null;
  /** Set on the first comment of a resolved thread. */
  resolvedAt: number | null;
  /** User ids named with @username. */
  mentions: string[];
}

interface Saved {
  comments: Comment[];
  /** `${userId}:${fileId}` → when that person last looked at the comments. */
  reads: Record<string, number>;
}

/** Comments on files, kept in comments.json next to the other server data. */
export class CommentStore {
  private comments = new Map<string, Comment>();
  private reads: Record<string, number> = {};
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string | null) {}

  async init(): Promise<void> {
    if (!this.dir) return;
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.dir, 'comments.json'), 'utf8')) as Partial<Saved>;
      for (const c of saved.comments ?? []) this.comments.set(c.id, c);
      this.reads = saved.reads ?? {};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[planar] could not read comments.json:', e);
    }
  }

  private touch(): void {
    if (!this.dir || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.write();
    }, 300);
  }

  private write(): Promise<void> {
    const file = path.join(this.dir!, 'comments.json');
    const json = JSON.stringify({ comments: [...this.comments.values()], reads: this.reads } satisfies Saved);
    this.writing = this.writing
      .then(async () => {
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, json);
        await fs.rename(tmp, file);
      })
      .catch((e) => console.error('[planar] could not save comments.json:', e));
    return this.writing;
  }

  async flush(): Promise<void> {
    if (!this.dir) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.write();
    }
    await this.writing;
  }

  /** Oldest first. */
  list(fileId: string): Comment[] {
    return [...this.comments.values()].filter((c) => c.fileId === fileId).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Comment | undefined {
    return this.comments.get(id);
  }

  add(c: Omit<Comment, 'id' | 'createdAt' | 'editedAt' | 'resolvedAt'>): Comment {
    const comment: Comment = { ...c, id: randomId(8), createdAt: Date.now(), editedAt: null, resolvedAt: null };
    this.comments.set(comment.id, comment);
    this.touch();
    return comment;
  }

  update(c: Comment): void {
    this.comments.set(c.id, c);
    this.touch();
  }

  /** Removes a comment, and the replies too when it starts a thread. */
  remove(c: Comment): void {
    this.comments.delete(c.id);
    if (!c.threadId) for (const o of [...this.comments.values()]) if (o.threadId === c.id) this.comments.delete(o.id);
    this.touch();
  }

  removeFile(fileId: string): void {
    for (const c of [...this.comments.values()]) if (c.fileId === fileId) this.comments.delete(c.id);
    for (const k of Object.keys(this.reads)) if (k.endsWith(`:${fileId}`)) delete this.reads[k];
    this.touch();
  }

  markRead(userId: string, fileId: string): void {
    this.reads[`${userId}:${fileId}`] = Date.now();
    this.touch();
  }

  /** Comments by other people since this person last looked. */
  unread(userId: string, fileId: string): number {
    const since = this.reads[`${userId}:${fileId}`] ?? 0;
    let n = 0;
    for (const c of this.comments.values()) if (c.fileId === fileId && c.authorId !== userId && c.createdAt > since) n++;
    return n;
  }
}
