import { createNode, getAncestors, newId } from './document';
import { measureTextNode } from './text';
import type { PlanarDocument, SceneNode } from './types';

/** Fields a layer never takes from the component layer it mirrors. */
const NEVER_SYNCED = new Set<keyof SceneNode>(['id', 'parentId', 'children', 'sourceId', 'overrides']);

/** Fields an instance root keeps for itself. */
const ROOT_OWN = new Set<keyof SceneNode>([
  'type',
  'name',
  'x',
  'y',
  'rotation',
  'visible',
  'locked',
  'opacity',
  'layoutAbsolute',
  'componentId',
  'variableMode',
]);

/** Properties that make an instance's text need re-measuring. */
const TEXT_FIELDS = ['characters', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'autoWidth', 'bindings'];

/** True when the node sits inside an instance (not the instance itself). */
export function isInInstance(doc: PlanarDocument, id: string): boolean {
  return getAncestors(doc, id).some((a) => a.type === 'instance');
}

/** Nearest enclosing instance of a node, or the node if it is one. */
export function owningInstance(doc: PlanarDocument, id: string): SceneNode | null {
  const node = doc.nodes[id];
  if (node?.type === 'instance') return node;
  const ancestors = getAncestors(doc, id);
  for (let i = ancestors.length - 1; i >= 0; i--) if (ancestors[i].type === 'instance') return ancestors[i];
  return null;
}

/** Instance layers that track a component get their changes recorded. */
export function tracksOverrides(node: SceneNode): boolean {
  return node.type === 'instance' || !!node.sourceId;
}

export function markOverrides(node: SceneNode, keys: Iterable<string>): void {
  if (!tracksOverrides(node)) return;
  const set = new Set(node.overrides);
  for (const k of keys) if (k !== 'overrides') set.add(k);
  node.overrides = [...set];
}

function copyFields(target: SceneNode, source: SceneNode, root: boolean): void {
  const overridden = new Set(target.overrides);
  for (const key of Object.keys(source) as (keyof SceneNode)[]) {
    if (NEVER_SYNCED.has(key) || overridden.has(key) || (root && ROOT_OWN.has(key))) continue;
    const value = source[key];
    const next = typeof value === 'object' && value !== null ? structuredClone(value) : value;
    (target as unknown as Record<string, unknown>)[key] = next;
  }
}

function removeSubtree(doc: PlanarDocument, id: string): void {
  for (const c of doc.nodes[id]?.children ?? []) removeSubtree(doc, c);
  delete doc.nodes[id];
}

/** Makes `target`'s subtree mirror `source`'s, keeping overrides. */
function mirror(doc: PlanarDocument, target: SceneNode, source: SceneNode, root: boolean): void {
  copyFields(target, source, root);
  const bySource = new Map<string, string>();
  for (const c of target.children) {
    const child = doc.nodes[c];
    if (child?.sourceId) bySource.set(child.sourceId, c);
  }
  const next: string[] = [];
  for (const sc of source.children) {
    const src = doc.nodes[sc];
    if (!src) continue;
    let tid = bySource.get(sc);
    if (!tid) {
      const created = createNode(src.type, { id: newId(), sourceId: sc, parentId: target.id });
      doc.nodes[created.id] = created;
      tid = created.id;
    }
    bySource.delete(sc);
    next.push(tid);
    mirror(doc, doc.nodes[tid], src, false);
    const node = doc.nodes[tid];
    node.parentId = target.id;
    if (node.type === 'text' && node.overrides.some((k) => TEXT_FIELDS.includes(k))) {
      const size = measureTextNode(node);
      if (node.autoWidth) node.width = size.width;
      node.height = size.height;
    }
  }
  for (const stale of bySource.values()) removeSubtree(doc, stale);
  // Children without a source (should not happen) are dropped too.
  for (const c of target.children) if (!next.includes(c) && doc.nodes[c] && !doc.nodes[c].sourceId) removeSubtree(doc, c);
  target.children = next;
}

/** Instances not nested inside another instance, innermost components first. */
function topLevelInstances(doc: PlanarDocument): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (id: string) => {
    const n = doc.nodes[id];
    if (!n) return;
    if (n.type === 'instance') {
      out.push(n);
      return;
    }
    n.children.forEach(walk);
  };
  doc.pageIds.forEach(walk);
  return out;
}

/** Brings every instance up to date with its main component. */
export function syncInstances(doc: PlanarDocument): void {
  const instances = topLevelInstances(doc);
  if (!instances.length) return;
  // A component may contain instances of other components; extra passes
  // settle chains of nesting (cycles are prevented when instances are made).
  const nested = instances.some((i) => getAncestors(doc, i.id).some((a) => a.type === 'component'));
  for (let pass = 0; pass < (nested ? 3 : 1); pass++) {
    for (const inst of instances) {
      const comp = doc.nodes[inst.componentId];
      if (!comp || comp.type !== 'component') continue;
      mirror(doc, inst, comp, true);
    }
  }
}

/** Whether placing an instance of `componentId` under `parentId` would nest it in itself. */
export function wouldCycle(doc: PlanarDocument, componentId: string, parentId: string): boolean {
  if (parentId === componentId) return true;
  const chain = [doc.nodes[parentId], ...getAncestors(doc, parentId)];
  return chain.some((n) => n && (n.id === componentId || (n.type === 'instance' && n.componentId === componentId)));
}

/** Creates (but does not insert) an instance node for a component. */
export function createInstanceNode(doc: PlanarDocument, componentId: string): SceneNode {
  const comp = doc.nodes[componentId];
  return createNode('instance', {
    name: comp.name,
    componentId,
    width: comp.width,
    height: comp.height,
  });
}

/** Turns an instance into a plain frame; nested instances stay linked. */
export function detachInstance(doc: PlanarDocument, id: string): void {
  const inst = doc.nodes[id];
  if (!inst || inst.type !== 'instance') return;
  const walk = (nid: string, insideNested: boolean) => {
    for (const c of doc.nodes[nid].children) {
      const n = doc.nodes[c];
      if (insideNested) {
        // Point at the nested component's layer instead of the outer one's.
        n.sourceId = doc.nodes[n.sourceId]?.sourceId ?? '';
        walk(c, true);
      } else if (n.type === 'instance') {
        n.sourceId = '';
        walk(c, true);
      } else {
        n.sourceId = '';
        n.overrides = [];
        walk(c, false);
      }
    }
  };
  walk(id, false);
  inst.type = 'frame';
  inst.componentId = '';
  inst.overrides = [];
}

/** Clears overrides in an instance subtree so it matches its component again. */
export function resetOverrides(doc: PlanarDocument, id: string): void {
  const walk = (nid: string) => {
    const n = doc.nodes[nid];
    if (!n) return;
    n.overrides = [];
    n.children.forEach(walk);
  };
  walk(id);
}

export function hasOverrides(doc: PlanarDocument, id: string): boolean {
  const n = doc.nodes[id];
  if (!n) return false;
  const own = n.overrides.filter((k) => !(n.type === 'instance' && ROOT_OWN.has(k as keyof SceneNode)));
  return own.length > 0 || n.children.some((c) => hasOverrides(doc, c));
}

export function listComponents(doc: PlanarDocument): SceneNode[] {
  return Object.values(doc.nodes).filter((n) => n.type === 'component');
}
