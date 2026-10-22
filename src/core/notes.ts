// Annotation layers: sticky notes, text descriptions, chats, checklists and
// callouts. They live in the document like any layer (synced, versioned,
// visible to agents) but are left out of exports, code and presentations.

import { createNode, newId } from './document';
import type { ChecklistItem, NoteData, NoteKind, NoteMessage, PlanarDocument, SceneNode } from './types';

export const NOTE_KINDS: NoteKind[] = ['sticky', 'doc', 'chat', 'checklist', 'callout'];

export const NOTE_LABELS: Record<NoteKind, string> = {
  sticky: 'Sticky note',
  doc: 'Text description',
  chat: 'Chat',
  checklist: 'Checklist',
  callout: 'Callout',
};

export const STICKY_COLORS = ['#FFE58F', '#FFC069', '#FFADD2', '#D3ADF7', '#91D5FF', '#B7EB8F'];

/** Messages kept per chat (older ones are dropped). */
export const MAX_MESSAGES = 500;
export const MAX_ITEMS = 200;

const DEFAULTS: Record<NoteKind, { width: number; height: number; fill: string; text: string }> = {
  sticky: { width: 200, height: 200, fill: STICKY_COLORS[0], text: '' },
  doc: { width: 360, height: 280, fill: '#FFFFFF', text: '# Description\n\nWhat this screen does, who it is for, edge cases…' },
  chat: { width: 300, height: 360, fill: '#FFFFFF', text: 'Chat' },
  checklist: { width: 280, height: 220, fill: '#FFFFFF', text: 'To do' },
  callout: { width: 200, height: 48, fill: '#5B5BD6', text: 'Note' },
};

export function isNote(node: SceneNode | null | undefined): boolean {
  return node?.type === 'note';
}

/** A new annotation layer of the given kind (not yet in a document). */
export function createNote(kind: NoteKind, props: Partial<SceneNode> = {}): SceneNode {
  const d = DEFAULTS[kind];
  const data: NoteData = { kind };
  if (kind === 'chat') data.messages = [];
  if (kind === 'checklist') data.items = [];
  if (kind === 'callout') data.targetId = '';
  return createNode('note', {
    name: NOTE_LABELS[kind],
    width: d.width,
    height: d.height,
    fills: [{ type: 'solid', color: d.fill, opacity: 1, visible: true }],
    characters: d.text,
    fontSize: kind === 'sticky' ? 16 : 14,
    cornerRadius: kind === 'sticky' ? 2 : 8,
    clipContent: true,
    // Annotations never take part in auto layout.
    layoutAbsolute: true,
    note: data,
    ...props,
  });
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

function sanitizeMessages(value: unknown): NoteMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m) => m && typeof m.id === 'string')
    .map((m) => ({
      id: m.id,
      author: str(m.author, 80) || 'Someone',
      text: m.deleted ? '' : str(m.text, 4000),
      at: Number(m.at) || 0,
      ...(m.agent ? { agent: true } : {}),
      ...(m.deleted ? { deleted: true } : {}),
    }))
    .slice(-MAX_MESSAGES);
}

function sanitizeItems(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((i) => i && typeof i.id === 'string')
    .map((i) => ({ id: i.id, text: str(i.text, 1000), done: i.done === true }))
    .slice(0, MAX_ITEMS);
}

/** Valid note data for an untrusted value; undefined when it is not a note. */
export function sanitizeNote(value: unknown): NoteData | undefined {
  const v = value as Partial<NoteData> | undefined;
  const kind = NOTE_KINDS.includes(v?.kind as NoteKind) ? (v!.kind as NoteKind) : 'sticky';
  const out: NoteData = { kind };
  if (v?.author) out.author = str(v.author, 80);
  if (kind === 'chat') out.messages = sanitizeMessages(v?.messages);
  if (kind === 'checklist') out.items = sanitizeItems(v?.items);
  if (kind === 'callout') out.targetId = str(v?.targetId, 100);
  return out;
}

/**
 * Two versions of a chat merged: every message either side has, in time
 * order, a deletion winning. Applied whenever a chat layer is replaced, so
 * people posting at the same moment do not lose each other's messages.
 */
export function mergeMessages(a: NoteMessage[] = [], b: NoteMessage[] = []): NoteMessage[] {
  const byId = new Map<string, NoteMessage>();
  for (const m of [...a, ...b]) {
    const prev = byId.get(m.id);
    byId.set(m.id, prev?.deleted ? prev : m.deleted ? { ...m, text: '' } : m);
  }
  return [...byId.values()].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1)).slice(-MAX_MESSAGES);
}

/** Keeps messages from `prev` when a chat layer is replaced by `next`. */
export function mergeNoteInto(prev: SceneNode | undefined, next: SceneNode): void {
  if (prev?.note?.kind === 'chat' && next.note?.kind === 'chat') next.note.messages = mergeMessages(prev.note.messages, next.note.messages);
}

export function newMessage(author: string, text: string, agent = false): NoteMessage {
  return { id: newId(), author, text, at: Date.now(), ...(agent ? { agent: true } : {}) };
}

export function newItem(text: string, done = false): ChecklistItem {
  return { id: newId(), text, done };
}

/** Ids of annotation layers on a page (anywhere in its tree). */
export function noteIds(doc: PlanarDocument, pageId: string): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    const n = doc.nodes[id];
    if (!n) return;
    if (n.type === 'note') out.add(id);
    n.children.forEach(walk);
  };
  walk(pageId);
  return out;
}

export type MarkdownBlock = { kind: 'h1' | 'h2' | 'h3' | 'p' | 'bullet' | 'quote' | 'code' | 'todo' | 'done' | 'blank'; text: string };

/** Line-level markdown: headings, bullets, task items, quotes and code fences. Inline marks are removed. */
export function markdownBlocks(text: string): MarkdownBlock[] {
  const out: MarkdownBlock[] = [];
  let code = false;
  const inline = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      code = !code;
      continue;
    }
    if (code) out.push({ kind: 'code', text: line });
    else if (!line.trim()) out.push({ kind: 'blank', text: '' });
    else if (/^#\s/.test(line)) out.push({ kind: 'h1', text: inline(line.slice(2).trim()) });
    else if (/^##\s/.test(line)) out.push({ kind: 'h2', text: inline(line.slice(3).trim()) });
    else if (/^#{3,6}\s/.test(line)) out.push({ kind: 'h3', text: inline(line.replace(/^#+\s/, '').trim()) });
    else if (/^\s*[-*]\s\[[ ]\]\s/.test(line)) out.push({ kind: 'todo', text: inline(line.replace(/^\s*[-*]\s\[[ ]\]\s/, '')) });
    else if (/^\s*[-*]\s\[[xX]\]\s/.test(line)) out.push({ kind: 'done', text: inline(line.replace(/^\s*[-*]\s\[[xX]\]\s/, '')) });
    else if (/^\s*([-*]|\d+\.)\s/.test(line)) out.push({ kind: 'bullet', text: inline(line.replace(/^\s*([-*]|\d+\.)\s/, '')) });
    else if (/^>\s?/.test(line)) out.push({ kind: 'quote', text: inline(line.replace(/^>\s?/, '')) });
    else out.push({ kind: 'p', text: inline(line) });
  }
  return out;
}

/** Plain-text summary of a note for agents and lists. */
export function noteSummary(node: SceneNode): string {
  const n = node.note;
  if (!n) return node.characters;
  if (n.kind === 'chat') {
    const live = (n.messages ?? []).filter((m) => !m.deleted);
    return `${live.length} message${live.length === 1 ? '' : 's'}${live.length ? `, last: ${live[live.length - 1].author}: ${live[live.length - 1].text}` : ''}`;
  }
  if (n.kind === 'checklist') {
    const items = n.items ?? [];
    return `${node.characters} (${items.filter((i) => i.done).length}/${items.length} done)`;
  }
  return node.characters;
}
