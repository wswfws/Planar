import type { PlanarDocument, SceneNode } from './types';

/** Document-level fields exchanged as a whole. */
export const META_KEYS = ['name', 'pageIds', 'variables', 'modes', 'styles', 'libraries', 'context'] as const;
export type MetaKey = (typeof META_KEYS)[number];

/**
 * A change to a document: a whole layer (null = deleted) or a whole
 * document-level field. Used for undo history and for collaboration.
 */
export type Op = { o: 'node'; id: string; node: SceneNode | null } | { o: 'meta'; key: MetaKey; value: unknown };

/** Applies ops in order, then repairs the layer tree. */
export function applyOps(doc: PlanarDocument, ops: Op[]): void {
  for (const op of ops) {
    if (op.o === 'node') {
      if (op.node) {
        const node = structuredClone({ ...op.node, id: op.id });
        // Layers from older clients predate effects.
        if (!Array.isArray(node.effects)) node.effects = [];
        if (typeof node.context !== 'string') node.context = '';
        doc.nodes[op.id] = node;
      } else delete doc.nodes[op.id];
    } else if ((META_KEYS as readonly string[]).includes(op.key)) {
      (doc as unknown as Record<string, unknown>)[op.key] = structuredClone(op.value);
    }
  }
  repairTree(doc);
}

/**
 * Makes the tree consistent after merging changes from several sources:
 * children lists follow parentId, layers whose parent is gone are removed,
 * and every page is listed exactly once.
 */
export function repairTree(doc: PlanarDocument): void {
  const nodes = doc.nodes;
  // Remove layers whose ancestors no longer exist (repeat for chains).
  let removed = true;
  while (removed) {
    removed = false;
    for (const n of Object.values(nodes)) {
      if (n.type === 'page') {
        n.parentId = null;
        continue;
      }
      if (!n.parentId || !nodes[n.parentId] || n.parentId === n.id) {
        delete nodes[n.id];
        removed = true;
      }
    }
  }
  for (const n of Object.values(nodes)) {
    const seen = new Set<string>();
    n.children = (n.children ?? []).filter((c) => {
      const ok = nodes[c]?.parentId === n.id && !seen.has(c);
      seen.add(c);
      return ok;
    });
  }
  for (const n of Object.values(nodes)) {
    if (n.parentId && !nodes[n.parentId].children.includes(n.id)) nodes[n.parentId].children.push(n.id);
  }
  const pages = new Set(Object.values(nodes).filter((n) => n.type === 'page').map((n) => n.id));
  const listed = (doc.pageIds ?? []).filter((id, i, a) => pages.has(id) && a.indexOf(id) === i);
  for (const id of pages) if (!listed.includes(id)) listed.push(id);
  doc.pageIds = listed;
}

/** Ops that turn `from` into `to`, layer by layer. */
export function diffDocs(from: PlanarDocument, to: PlanarDocument): Op[] {
  const ops: Op[] = [];
  const ids = new Set([...Object.keys(from.nodes), ...Object.keys(to.nodes)]);
  for (const id of ids) {
    const a = from.nodes[id];
    const b = to.nodes[id];
    if (!b) ops.push({ o: 'node', id, node: null });
    else if (!a || JSON.stringify(a) !== JSON.stringify(b)) ops.push({ o: 'node', id, node: structuredClone(b) });
  }
  for (const key of META_KEYS) {
    if (JSON.stringify(from[key]) !== JSON.stringify(to[key])) ops.push({ o: 'meta', key, value: structuredClone(to[key]) });
  }
  return ops;
}

/**
 * Remembers the last state shared for every layer so later changes can be
 * found cheaply (used to send only what changed).
 */
export class ChangeTracker {
  private nodes = new Map<string, string>();
  private meta = new Map<string, string>();

  /** Records the whole document as already shared. */
  reset(doc: PlanarDocument): void {
    this.nodes.clear();
    this.meta.clear();
    for (const [id, n] of Object.entries(doc.nodes)) this.nodes.set(id, JSON.stringify(n));
    for (const key of META_KEYS) this.meta.set(key, JSON.stringify(doc[key]));
  }

  /** Marks ops as shared without sending them (e.g. they came from others). */
  record(ops: Op[]): void {
    for (const op of ops) {
      if (op.o === 'node') {
        if (op.node) this.nodes.set(op.id, JSON.stringify(op.node));
        else this.nodes.delete(op.id);
      } else {
        this.meta.set(op.key, JSON.stringify(op.value));
      }
    }
  }

  /** Changes since the last call (or reset), and records them as shared. */
  collect(doc: PlanarDocument): Op[] {
    const ops: Op[] = [];
    for (const [id, n] of Object.entries(doc.nodes)) {
      const json = JSON.stringify(n);
      if (this.nodes.get(id) !== json) {
        ops.push({ o: 'node', id, node: JSON.parse(json) });
        this.nodes.set(id, json);
      }
    }
    for (const id of [...this.nodes.keys()]) {
      if (!doc.nodes[id]) {
        ops.push({ o: 'node', id, node: null });
        this.nodes.delete(id);
      }
    }
    for (const key of META_KEYS) {
      const json = JSON.stringify(doc[key]);
      if (this.meta.get(key) !== json) {
        ops.push({ o: 'meta', key, value: JSON.parse(json) });
        this.meta.set(key, json);
      }
    }
    return ops;
  }
}
