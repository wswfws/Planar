import { sanitizeEffects } from './effects';
import type { NodeType, Paint, PlanarDocument, SceneNode, SolidPaint } from './types';

let counter = 0;

export function newId(): string {
  counter = (counter + 1) % 0xffff;
  return Date.now().toString(36) + '-' + counter.toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

export function solid(color: string, opacity = 1): SolidPaint {
  return { type: 'solid', color, opacity, visible: true };
}

const DEFAULT_NAMES: Record<NodeType, string> = {
  page: 'Page',
  frame: 'Frame',
  component: 'Component',
  componentSet: 'Component set',
  instance: 'Instance',
  group: 'Group',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  vector: 'Vector',
  text: 'Text',
};

const DEFAULT_FILLS: Record<NodeType, () => Paint[]> = {
  page: () => [solid('#1e1e24')],
  frame: () => [solid('#ffffff')],
  component: () => [solid('#ffffff')],
  componentSet: () => [],
  instance: () => [solid('#ffffff')],
  group: () => [],
  rectangle: () => [solid('#d9d9d9')],
  ellipse: () => [solid('#d9d9d9')],
  vector: () => [],
  text: () => [solid('#000000')],
};

export function createNode(type: NodeType, props: Partial<SceneNode> = {}): SceneNode {
  return {
    id: newId(),
    type,
    name: DEFAULT_NAMES[type],
    parentId: null,
    children: [],
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fills: DEFAULT_FILLS[type](),
    strokes: type === 'vector' ? [solid('#000000')] : [],
    strokeWidth: type === 'vector' ? 2 : 1,
    effects: [],
    cornerRadius: 0,
    clipContent: type === 'frame' || type === 'component' || type === 'instance',
    characters: '',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 24,
    fontWeight: 400,
    lineHeight: 0,
    textAlign: 'left',
    autoWidth: true,
    autoHeight: true,
    textAlignVertical: 'top',
    points: [],
    closed: false,
    paths: [],
    pathBox: { w: 0, h: 0 },
    layoutMode: 'none',
    itemSpacing: 10,
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    primaryAlign: 'start',
    counterAlign: 'start',
    sizingH: 'fixed',
    sizingV: 'fixed',
    layoutAbsolute: false,
    layoutWrap: false,
    counterSpacing: 10,
    constraintH: 'left',
    constraintV: 'top',
    componentId: '',
    sourceId: '',
    overrides: [],
    bindings: {},
    variableMode: '',
    componentProps: [],
    propBindings: {},
    propValues: {},
    variantProps: {},
    ...props,
  };
}

export function createDocument(name = 'Untitled'): PlanarDocument {
  const page = createNode('page', { name: 'Page 1', width: 0, height: 0 });
  return {
    format: 'planar',
    version: 1,
    name,
    pageIds: [page.id],
    nodes: { [page.id]: page },
    variables: [],
    modes: [{ id: newId(), name: 'Mode 1' }],
  };
}

export function getNode(doc: PlanarDocument, id: string): SceneNode {
  const node = doc.nodes[id];
  if (!node) throw new Error(`Unknown node ${id}`);
  return node;
}

export function getParent(doc: PlanarDocument, id: string): SceneNode | null {
  const pid = doc.nodes[id]?.parentId;
  return pid ? doc.nodes[pid] ?? null : null;
}

/** Ancestors from the page down to (excluding) the node itself. */
export function getAncestors(doc: PlanarDocument, id: string): SceneNode[] {
  const out: SceneNode[] = [];
  let cur = getParent(doc, id);
  while (cur) {
    out.unshift(cur);
    cur = getParent(doc, cur.id);
  }
  return out;
}

export function getPageOf(doc: PlanarDocument, id: string): SceneNode | null {
  let cur: SceneNode | undefined = doc.nodes[id];
  while (cur && cur.type !== 'page') cur = cur.parentId ? doc.nodes[cur.parentId] : undefined;
  return cur ?? null;
}

export function isAncestor(doc: PlanarDocument, ancestorId: string, id: string): boolean {
  let cur = doc.nodes[id]?.parentId;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = doc.nodes[cur]?.parentId;
  }
  return false;
}

export function descendants(doc: PlanarDocument, id: string): string[] {
  const out: string[] = [];
  const walk = (nid: string) => {
    for (const c of doc.nodes[nid]?.children ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(id);
  return out;
}

export function insertNode(doc: PlanarDocument, node: SceneNode, parentId: string, index?: number): SceneNode {
  const parent = getNode(doc, parentId);
  node.parentId = parentId;
  doc.nodes[node.id] = node;
  const i = index === undefined ? parent.children.length : Math.max(0, Math.min(index, parent.children.length));
  parent.children.splice(i, 0, node.id);
  return node;
}

export function detachNode(doc: PlanarDocument, id: string): void {
  const parent = getParent(doc, id);
  if (parent) parent.children = parent.children.filter((c) => c !== id);
  const node = doc.nodes[id];
  if (node) node.parentId = null;
}

export function removeNode(doc: PlanarDocument, id: string): void {
  if (!doc.nodes[id]) return;
  for (const d of descendants(doc, id)) delete doc.nodes[d];
  detachNode(doc, id);
  delete doc.nodes[id];
  doc.pageIds = doc.pageIds.filter((p) => p !== id);
}

/** Moves a node to a new parent/index without changing its local transform. */
export function moveNode(doc: PlanarDocument, id: string, parentId: string, index?: number): void {
  if (id === parentId || isAncestor(doc, id, parentId)) return;
  const node = getNode(doc, id);
  const oldParent = getParent(doc, id);
  let i = index;
  if (oldParent && oldParent.id === parentId && i !== undefined) {
    const oldIndex = oldParent.children.indexOf(id);
    if (oldIndex < i) i -= 1;
  }
  detachNode(doc, id);
  insertNode(doc, node, parentId, i);
}

/** Deep copies a subtree with fresh ids. Returns the new nodes, root first. */
export function cloneSubtree(source: Record<string, SceneNode>, rootId: string): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (id: string, parentId: string | null): string => {
    const src = source[id];
    const copy: SceneNode = structuredClone(src);
    copy.id = newId();
    copy.parentId = parentId;
    out.push(copy);
    copy.children = src.children.filter((c) => source[c]).map((c) => walk(c, copy.id));
    return copy.id;
  };
  walk(rootId, null);
  return out;
}

/** Inserts nodes produced by cloneSubtree (root first) under parentId. */
export function insertSubtree(doc: PlanarDocument, nodes: SceneNode[], parentId: string, index?: number): SceneNode {
  const [root, ...rest] = nodes;
  for (const n of rest) doc.nodes[n.id] = n;
  return insertNode(doc, root, parentId, index);
}

export function uniquePageName(doc: PlanarDocument): string {
  const names = new Set(doc.pageIds.map((id) => doc.nodes[id]?.name));
  let i = doc.pageIds.length + 1;
  while (names.has(`Page ${i}`)) i++;
  return `Page ${i}`;
}

/** Validates and normalises an untrusted parsed document. Throws on errors. */
export function parseDocument(data: unknown): PlanarDocument {
  if (!data || typeof data !== 'object') throw new Error('Not a JSON object');
  const d = data as Partial<PlanarDocument>;
  if (d.format !== 'planar') throw new Error('Not a Planar document');
  if (d.version !== 1) throw new Error(`Unsupported version ${String(d.version)}`);
  if (!Array.isArray(d.pageIds) || !d.pageIds.length || !d.nodes || typeof d.nodes !== 'object') {
    throw new Error('Document has no pages');
  }
  const nodes: Record<string, SceneNode> = {};
  for (const [id, raw] of Object.entries(d.nodes)) {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string' || !(raw.type in DEFAULT_NAMES)) {
      throw new Error(`Invalid node ${id}`);
    }
    nodes[id] = { ...createNode(raw.type), ...raw, id };
    nodes[id].effects = sanitizeEffects(raw.effects);
    if (!['left', 'right', 'left-right', 'center', 'scale'].includes(nodes[id].constraintH)) nodes[id].constraintH = 'left';
    if (!['top', 'bottom', 'top-bottom', 'center', 'scale'].includes(nodes[id].constraintV)) nodes[id].constraintV = 'top';
  }
  for (const node of Object.values(nodes)) {
    node.children = (Array.isArray(node.children) ? node.children : []).filter((c) => nodes[c]?.parentId === node.id);
  }
  const pageIds = d.pageIds.filter((id) => nodes[id]?.type === 'page');
  if (!pageIds.length) throw new Error('Document has no pages');
  const modes = Array.isArray(d.modes)
    ? d.modes.filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string')
    : [];
  if (!modes.length) modes.push({ id: newId(), name: 'Mode 1' });
  const types = new Set(['color', 'number', 'string', 'boolean']);
  const variables = Array.isArray(d.variables)
    ? d.variables
        .filter((v) => v && typeof v.id === 'string' && typeof v.name === 'string' && types.has(v.type))
        .map((v) => ({ id: v.id, name: v.name, type: v.type, values: v.values && typeof v.values === 'object' ? { ...v.values } : {} }))
    : [];
  return {
    format: 'planar',
    version: 1,
    name: typeof d.name === 'string' ? d.name : 'Untitled',
    pageIds,
    nodes,
    variables,
    modes,
  };
}
