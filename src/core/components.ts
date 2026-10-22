import { createNode, getAncestors, newId } from './document';
import { applyConstraints } from './geometry';
import { measureTextNode } from './text';
import { isFrameLike, type ComponentProp, type ComponentPropType, type PlanarDocument, type SceneNode } from './types';

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
  'propValues',
  'propBindings',
]);

/** Properties that make an instance's text need re-measuring. */
const TEXT_FIELDS = ['characters', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'autoWidth', 'autoHeight', 'bindings'];

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
  // A nested instance whose component is chosen by an instance-swap property
  // mirrors the swapped-in component instead of its source's.
  if (!root && source.type === 'instance' && source.propBindings.componentId) {
    const current = target.componentId;
    if (current && current !== source.componentId && doc.nodes[current]?.type === 'component') {
      copyFields(target, source, false);
      target.componentId = current;
      mirror(doc, target, doc.nodes[current], true);
      return;
    }
  }
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
  // A resized instance (or layer in one) places its children by their constraints,
  // starting from the component's layout each time; moved or resized layers stay put.
  if (isFrameLike(target) && (target.width !== source.width || target.height !== source.height)) {
    applyConstraints(doc, target, source.width, source.height, (c) => c.overrides.some((k) => GEOMETRY.has(k)));
  }
}

const GEOMETRY = new Set(['x', 'y', 'width', 'height']);

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

// ---------------------------------------------------------------- properties

export const PROP_FIELDS: Record<string, ComponentPropType> = {
  characters: 'text',
  visible: 'boolean',
  componentId: 'instance',
};

/**
 * The instance or main component that supplies a property to a bound layer,
 * found by walking up from the layer's parent.
 */
export function propOwner(
  doc: PlanarDocument,
  nodeId: string,
  propId: string,
): { owner: SceneNode; host: SceneNode; prop: ComponentProp } | null {
  let cur = doc.nodes[doc.nodes[nodeId]?.parentId ?? ''];
  while (cur) {
    const comp = cur.type === 'instance' ? doc.nodes[cur.componentId] : cur.type === 'component' ? cur : null;
    const host = comp ? propHost(doc, comp) : null;
    const prop = host?.componentProps.find((p) => p.id === propId);
    if (host && prop) return { owner: cur, host, prop };
    cur = doc.nodes[cur.parentId ?? ''];
  }
  return null;
}

/** Where a component's properties live: its component set, or itself. */
export function propHost(doc: PlanarDocument, component: SceneNode): SceneNode {
  const parent = component.parentId ? doc.nodes[component.parentId] : null;
  return parent?.type === 'componentSet' ? parent : component;
}

export function propValue(owner: SceneNode, prop: ComponentProp): string | boolean {
  const v = owner.type === 'instance' && prop.id in owner.propValues ? owner.propValues[prop.id] : prop.defaultValue;
  return prop.type === 'boolean' ? v !== false : String(v);
}

/** Main component containing a layer (not passing through an instance). */
export function containingComponent(doc: PlanarDocument, id: string): SceneNode | null {
  let cur = doc.nodes[doc.nodes[id]?.parentId ?? ''];
  while (cur) {
    if (cur.type === 'instance') return null;
    if (cur.type === 'component') return cur;
    cur = doc.nodes[cur.parentId ?? ''];
  }
  return null;
}

/**
 * Writes component property values into bound layers. Returns true when a
 * swapped instance changed component (instances then need another sync).
 */
export function applyComponentProps(doc: PlanarDocument): boolean {
  let swapped = false;
  for (const node of Object.values(doc.nodes)) {
    const entries = Object.entries(node.propBindings);
    if (!entries.length) continue;
    let textChanged = false;
    for (const [field, propId] of entries) {
      const found = propOwner(doc, node.id, propId);
      if (!found || PROP_FIELDS[field] !== found.prop.type) continue;
      const value = propValue(found.owner, found.prop);
      if (field === 'characters' && node.type === 'text' && node.characters !== value) {
        node.characters = String(value);
        textChanged = true;
      } else if (field === 'visible' && node.visible !== value) {
        node.visible = value === true;
      } else if (field === 'componentId' && node.type === 'instance' && node.componentId !== value) {
        const target = doc.nodes[String(value)];
        if (target?.type === 'component' && !wouldCycle(doc, target.id, node.parentId ?? '')) {
          node.componentId = target.id;
          swapped = true;
        }
      }
    }
    if (textChanged) {
      const size = measureTextNode(node);
      if (node.autoWidth) node.width = size.width;
      node.height = size.height;
    }
  }
  return swapped;
}

/** Components an instance-swap property inside `componentId` may offer. */
export function swapCandidates(doc: PlanarDocument, componentId: string): SceneNode[] {
  return listComponents(doc).filter((c) => {
    if (c.id === componentId) return false;
    const nests = (id: string, seen: Set<string>): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      for (const n of [doc.nodes[id], ...descendantsOf(doc, id)]) {
        if (n?.type === 'instance' && (n.componentId === componentId || nests(n.componentId, seen))) return true;
      }
      return false;
    };
    return !nests(c.id, new Set());
  });
}

function descendantsOf(doc: PlanarDocument, id: string): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (nid: string) => {
    for (const c of doc.nodes[nid]?.children ?? []) {
      out.push(doc.nodes[c]);
      walk(c);
    }
  };
  walk(id);
  return out;
}

// ---------------------------------------------------------------- variants

/** The component set a variant belongs to, if any. */
export function variantSet(doc: PlanarDocument, componentId: string): SceneNode | null {
  const comp = doc.nodes[componentId];
  const parent = comp?.parentId ? doc.nodes[comp.parentId] : null;
  return comp?.type === 'component' && parent?.type === 'componentSet' ? parent : null;
}

export function variantsOf(doc: PlanarDocument, setId: string): SceneNode[] {
  return (doc.nodes[setId]?.children ?? []).map((id) => doc.nodes[id]).filter((n) => n?.type === 'component');
}

/** Variant property names of a set, in order of first use. */
export function variantAxes(doc: PlanarDocument, setId: string): string[] {
  const axes: string[] = [];
  for (const v of variantsOf(doc, setId)) for (const k of Object.keys(v.variantProps)) if (!axes.includes(k)) axes.push(k);
  return axes;
}

/** Every value used for an axis across a set's variants. */
export function axisValues(doc: PlanarDocument, setId: string, axis: string): string[] {
  const out: string[] = [];
  for (const v of variantsOf(doc, setId)) {
    const val = v.variantProps[axis];
    if (val !== undefined && !out.includes(val)) out.push(val);
  }
  return out;
}

export function variantName(props: Record<string, string>): string {
  return Object.entries(props)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

/**
 * The variant matching `wanted` on every axis, or the one with the most
 * matching values among those that match `mustMatch`.
 */
export function pickVariant(doc: PlanarDocument, setId: string, wanted: Record<string, string>, mustMatch?: string): SceneNode | null {
  let best: SceneNode | null = null;
  let bestScore = -1;
  for (const v of variantsOf(doc, setId)) {
    if (mustMatch && v.variantProps[mustMatch] !== wanted[mustMatch]) continue;
    const score = Object.entries(wanted).filter(([k, val]) => v.variantProps[k] === val).length;
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

/** Names from a component down to one of its layers, e.g. "Icon/Shape". */
function namePath(doc: PlanarDocument, rootId: string, id: string): string | null {
  const names: string[] = [];
  let cur = doc.nodes[id];
  while (cur && cur.id !== rootId) {
    names.unshift(cur.name);
    cur = doc.nodes[cur.parentId ?? ''];
  }
  return cur ? names.join('/') : null;
}

/**
 * Points an instance at another component, re-linking its layers by name so
 * overrides on layers that exist in both survive.
 */
export function switchComponent(doc: PlanarDocument, instanceId: string, componentId: string): void {
  const inst = doc.nodes[instanceId];
  const next = doc.nodes[componentId];
  if (!inst || inst.type !== 'instance' || !next || next.type !== 'component' || inst.componentId === componentId) return;
  const oldId = inst.componentId;
  const byPath = new Map<string, string>();
  const index = (id: string) => {
    for (const c of doc.nodes[id]?.children ?? []) {
      const path = namePath(doc, componentId, c);
      if (path !== null && !byPath.has(path)) byPath.set(path, c);
      index(c);
    }
  };
  index(componentId);
  const relink = (id: string) => {
    for (const c of doc.nodes[id]?.children ?? []) {
      const n = doc.nodes[c];
      const path = n.sourceId && doc.nodes[n.sourceId] ? namePath(doc, oldId, n.sourceId) : null;
      n.sourceId = (path !== null && byPath.get(path)) || '';
      relink(c);
    }
  };
  relink(instanceId);
  inst.componentId = componentId;
  inst.width = next.width;
  inst.height = next.height;
  inst.overrides = inst.overrides.filter((k) => k !== 'width' && k !== 'height');
}
