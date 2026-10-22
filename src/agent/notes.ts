// How agents see annotation layers: notes around a layer, requests that
// mention them (@ai) and where to put the notes they write.

import { descendants, getAncestors, getPageOf } from '../core/document';
import { worldBounds } from '../core/geometry';
import { rectsIntersect, type Rect } from '../core/math';
import { visiblePageIds } from '../core/library';
import { noteSummary } from '../core/notes';
import type { NoteMessage, PlanarDocument, SceneNode } from '../core/types';

/** Words that address an agent in a note or chat. */
export const MENTION = /(^|[^\w@])@(ai|agent|claude)\b/i;

const quote = (s: string) => JSON.stringify(s.replace(/\s+/g, ' ').trim());

function time(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

/** The layer directly on the page that contains a layer (or the layer itself). */
function topLevel(doc: PlanarDocument, id: string): SceneNode | null {
  const chain = [...getAncestors(doc, id), doc.nodes[id]].filter(Boolean);
  return chain.find((n) => n.type !== 'page') ?? null;
}

const inflate = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 });

/**
 * Notes about a layer: callouts pointing into its screen (the top-level
 * layer it belongs to) and notes lying on or next to that screen.
 */
export function relatedNotes(doc: PlanarDocument, id: string): SceneNode[] {
  const node = doc.nodes[id];
  if (!node || node.type === 'note' || node.type === 'page') return [];
  const top = topLevel(doc, id);
  const page = getPageOf(doc, id);
  if (!top || !page) return [];
  const inScreen = new Set([top.id, ...descendants(doc, top.id)]);
  const area = inflate(worldBounds(doc, top.id), 200);
  const out: SceneNode[] = [];
  for (const nid of [page.id, ...descendants(doc, page.id)]) {
    const n = doc.nodes[nid];
    if (n?.type !== 'note') continue;
    const target = n.note?.targetId;
    if (n.note?.kind === 'callout' ? !!target && inScreen.has(target) : inScreen.has(n.id) || rectsIntersect(worldBounds(doc, n.id), area)) out.push(n);
  }
  return out;
}

function messageLine(m: NoteMessage): string {
  return `${m.author}${m.agent ? ' (AI)' : ''} [${time(m.at)}]: ${m.text}`;
}

/** A note as markdown for agents. */
export function formatNote(doc: PlanarDocument, n: SceneNode, maxMessages = 20): string {
  const kind = n.note?.kind ?? 'sticky';
  const head = `## Note: ${kind} ${quote(n.name)} #${n.id}`;
  if (kind === 'chat') {
    const live = (n.note?.messages ?? []).filter((m) => !m.deleted);
    const shown = live.slice(-maxMessages);
    const lines = [`${head} — chat ${quote(n.characters || 'Chat')}, ${live.length} message${live.length === 1 ? '' : 's'}`];
    if (live.length > shown.length) lines.push(`(${live.length - shown.length} earlier messages not shown)`);
    lines.push(...shown.map(messageLine));
    return lines.join('\n');
  }
  if (kind === 'checklist') {
    const items = n.note?.items ?? [];
    return [`${head} — checklist ${quote(n.characters || 'Checklist')}`, ...items.map((i, k) => `${k + 1}. [${i.done ? 'x' : ' '}] ${i.text}  (item ${i.id})`)].join('\n');
  }
  const lines = [head];
  if (n.note?.author) lines.push(`by ${n.note.author}`);
  if (kind === 'callout') {
    const t = n.note?.targetId ? doc.nodes[n.note.targetId] : undefined;
    lines.push(t ? `points at ${t.type} ${quote(t.name)} #${t.id}` : 'points at nothing');
  }
  lines.push(n.characters);
  return lines.join('\n');
}

export interface InboxEntry {
  note: SceneNode;
  pageName: string;
  /** The chat message asking, when the request is in a chat. */
  message?: NoteMessage;
}

/**
 * Open requests for agents: chat messages mentioning @ai with no agent
 * reply after them, and other notes whose text mentions @ai.
 */
export function inbox(doc: PlanarDocument): InboxEntry[] {
  const out: InboxEntry[] = [];
  for (const pid of visiblePageIds(doc)) {
    const pageName = doc.nodes[pid].name;
    for (const id of descendants(doc, pid)) {
      const n = doc.nodes[id];
      if (n?.type !== 'note') continue;
      if (n.note?.kind === 'chat') {
        const live = (n.note.messages ?? []).filter((m) => !m.deleted);
        const lastAgent = live.map((m) => !!m.agent).lastIndexOf(true);
        for (const m of live.slice(lastAgent + 1)) if (!m.agent && MENTION.test(m.text)) out.push({ note: n, pageName, message: m });
      } else {
        const text = [n.characters, ...(n.note?.items ?? []).filter((i) => !i.done).map((i) => i.text)].join('\n');
        if (MENTION.test(text)) out.push({ note: n, pageName });
      }
    }
  }
  return out;
}

export function formatInbox(doc: PlanarDocument, entries: InboxEntry[]): string {
  if (!entries.length) return 'No open requests: nobody has mentioned @ai in a chat or note (or every chat request has an agent reply).';
  const lines = [`${entries.length} open request${entries.length === 1 ? '' : 's'} (reply in a chat with notes post; for other notes, do the work and update or delete the note):`];
  for (const e of entries) {
    const where = `${e.note.note?.kind ?? 'note'} ${quote(e.note.name)} #${e.note.id} on page ${quote(e.pageName)}`;
    const around = relatedTo(doc, e.note);
    if (e.message) lines.push(`- ${where}: ${messageLine(e.message)}${around}`);
    else lines.push(`- ${where}: ${noteSummary(e.note).replace(/\s+/g, ' ').slice(0, 300)}${around}`);
  }
  return lines.join('\n');
}

/** " (about Login #id)": the screen a note sits on or points at. */
function relatedTo(doc: PlanarDocument, note: SceneNode): string {
  const target = note.note?.targetId ? doc.nodes[note.note.targetId] : undefined;
  if (target) return ` (points at ${quote(target.name)} #${target.id})`;
  const page = getPageOf(doc, note.id);
  if (!page) return '';
  const b = worldBounds(doc, note.id);
  const screen = page.children.map((c) => doc.nodes[c]).find((n) => n && n.type !== 'note' && rectsIntersect(inflate(worldBounds(doc, n.id), 200), b));
  return screen ? ` (next to ${quote(screen.name)} #${screen.id})` : '';
}

/**
 * Page position for a new note: right of the given layer's screen, or right
 * of everything on the page, moved down past notes already there.
 */
export function freeSpot(doc: PlanarDocument, pageId: string, size: { width: number; height: number }, nearId?: string): { x: number; y: number } {
  const page = doc.nodes[pageId];
  const top = nearId ? topLevel(doc, nearId) : null;
  let x: number;
  let y: number;
  if (top) {
    const b = worldBounds(doc, top.id);
    x = b.x + b.width + 60;
    y = b.y;
  } else {
    const content = page.children.map((c) => doc.nodes[c]).filter((n) => n && n.type !== 'note');
    const boxes = content.map((n) => worldBounds(doc, n.id));
    x = boxes.length ? Math.max(...boxes.map((b) => b.x + b.width)) + 80 : 0;
    y = boxes.length ? Math.min(...boxes.map((b) => b.y)) : 0;
  }
  const notes = page.children.map((c) => doc.nodes[c]).filter((n) => n?.type === 'note').map((n) => worldBounds(doc, n.id));
  for (let i = 0; i < 100; i++) {
    const hit = notes.find((b) => rectsIntersect(b, { x, y, width: size.width, height: size.height }));
    if (!hit) break;
    y = hit.y + hit.height + 24;
  }
  return { x: Math.round(x), y: Math.round(y) };
}
