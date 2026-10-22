// Team libraries: a file publishes its components, variables and styles as a
// snapshot; other files import a copy onto a hidden page and update it later.
// Imported things keep their id in the library as `library.key`, so an update
// reuses the same local ids and instances stay connected.

import { detachInstance } from './components';
import { createNode, descendants, getAncestors, newId } from './document';
import type { LibraryLink, PlanarDocument, SceneNode, Style, Variable, VariableMode } from './types';
import { unbindVariable } from './variables';

export interface LibrarySnapshot {
  fileId: string;
  name: string;
  version: number;
  publishedAt: number;
  /** Component and component set roots, in the library file's ids. */
  roots: string[];
  /** The roots' subtrees, roots first. */
  nodes: SceneNode[];
  variables: Variable[];
  modes: VariableMode[];
  styles: Style[];
}

/** Pages that hold imported libraries (hidden from page lists). */
export function libraryPageIds(doc: PlanarDocument): Set<string> {
  return new Set((doc.libraries ?? []).map((l) => l.pageId));
}

/** Pages people work on: every page except library pages. */
export function visiblePageIds(doc: PlanarDocument): string[] {
  const hidden = libraryPageIds(doc);
  return doc.pageIds.filter((id) => !hidden.has(id));
}

/** The library a layer was imported from, if any. */
export function libraryOf(doc: PlanarDocument, id: string): LibraryLink | null {
  const fileId = doc.nodes[id]?.library?.fileId;
  return fileId ? (doc.libraries ?? []).find((l) => l.fileId === fileId) ?? null : null;
}

function rootOf(doc: PlanarDocument, componentId: string): SceneNode | null {
  const comp = doc.nodes[componentId];
  if (!comp) return null;
  const parent = comp.parentId ? doc.nodes[comp.parentId] : null;
  return parent?.type === 'componentSet' ? parent : comp;
}

/** What a file publishes: its own components (and the ones they use), variables and styles. */
export function buildLibrarySnapshot(doc: PlanarDocument, fileId: string, name: string, version: number, publishedAt = Date.now()): LibrarySnapshot {
  const hidden = libraryPageIds(doc);
  const onHidden = (n: SceneNode) => getAncestors(doc, n.id).some((a) => hidden.has(a.id));
  const roots: string[] = [];
  const add = (root: SceneNode | null) => {
    if (root && !roots.includes(root.id)) roots.push(root.id);
  };
  for (const n of Object.values(doc.nodes)) {
    if (onHidden(n)) continue;
    if (n.type === 'componentSet') add(n);
    else if (n.type === 'component' && doc.nodes[n.parentId ?? '']?.type !== 'componentSet') add(n);
  }
  // Components used inside published ones come along, wherever they live.
  for (let i = 0; i < roots.length; i++) {
    for (const id of [roots[i], ...descendants(doc, roots[i])]) {
      const n = doc.nodes[id];
      if (n.type === 'instance') add(rootOf(doc, n.componentId));
      for (const p of n.componentProps) if (p.type === 'instance' && typeof p.defaultValue === 'string') add(rootOf(doc, p.defaultValue));
    }
  }
  const nodes: SceneNode[] = [];
  for (const r of roots) {
    for (const id of [r, ...descendants(doc, r)]) {
      const copy = structuredClone(doc.nodes[id]);
      if (id === r) copy.parentId = null;
      delete copy.library;
      delete copy.link;
      nodes.push(copy);
    }
  }
  const strip = <T extends { library?: unknown }>(x: T): T => {
    const copy = structuredClone(x);
    delete copy.library;
    return copy;
  };
  return {
    fileId,
    name,
    version,
    publishedAt,
    roots,
    nodes,
    variables: doc.variables.map(strip),
    modes: structuredClone(doc.modes),
    styles: (doc.styles ?? []).map(strip),
  };
}

/** Counts for "what changed" summaries. */
export function snapshotSummary(s: Pick<LibrarySnapshot, 'roots' | 'nodes' | 'variables' | 'styles'>): { components: number; variables: number; styles: number } {
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  const components = s.roots.reduce((sum, r) => sum + (byId.get(r)?.type === 'componentSet' ? byId.get(r)!.children.length : 1), 0);
  return { components, variables: s.variables.length, styles: s.styles.length };
}

/**
 * Imports (or updates) a library in the document. Components are copied onto
 * the library's hidden page; variables and styles are added next to the
 * document's own. Things removed from the library are removed here too.
 */
export function importLibrary(doc: PlanarDocument, snap: LibrarySnapshot): LibraryLink {
  if (!doc.libraries) doc.libraries = [];
  const from = snap.fileId;
  let link = doc.libraries.find((l) => l.fileId === from);
  let page = link ? doc.nodes[link.pageId] : undefined;
  if (!page || page.type !== 'page') {
    page = createNode('page', { name: `Library: ${snap.name}`, width: 0, height: 0 });
    doc.nodes[page.id] = page;
    doc.pageIds.push(page.id);
  }
  page.name = `Library: ${snap.name}`;

  // Library id → local id, reusing what an earlier import created.
  const local = <T extends { id: string; library?: { fileId: string; key: string } }>(items: T[], keys: string[]) => {
    const existing = new Map(items.filter((x) => x.library?.fileId === from).map((x) => [x.library!.key, x.id]));
    return new Map(keys.map((k) => [k, existing.get(k) ?? newId()]));
  };
  const nodeId = local(Object.values(doc.nodes), snap.nodes.map((n) => n.id));
  const varId = local(doc.variables, snap.variables.map((v) => v.id));
  const styleId = local(doc.styles ?? [], snap.styles.map((s) => s.id));
  const map = (m: Map<string, string>, id: string) => m.get(id) ?? id;

  // Variables: values follow the document's modes by name (else the library's first mode).
  const valuesFor = (v: Variable) =>
    Object.fromEntries(
      doc.modes.map((m) => {
        const lm = snap.modes.find((x) => x.name.toLowerCase() === m.name.toLowerCase()) ?? snap.modes[0];
        return [m.id, lm && lm.id in v.values ? v.values[lm.id] : Object.values(v.values)[0]];
      }),
    );
  const keepVars = new Set(varId.values());
  for (const v of doc.variables) if (v.library?.fileId === from && !keepVars.has(v.id)) unbindVariable(doc, v.id);
  doc.variables = [
    ...doc.variables.filter((v) => v.library?.fileId !== from),
    ...snap.variables.map((v) => ({ ...structuredClone(v), id: varId.get(v.id)!, values: valuesFor(v), library: { fileId: from, key: v.id } })),
  ];
  doc.styles = [
    ...(doc.styles ?? []).filter((s) => s.library?.fileId !== from),
    ...snap.styles.map((s) => ({ ...structuredClone(s), id: styleId.get(s.id)!, library: { fileId: from, key: s.id } })),
  ];

  // Layers that left the library go (instances of them keep their look, see removeLibrary).
  const keep = new Set(nodeId.values());
  for (const n of Object.values(doc.nodes)) {
    if (n.library?.fileId === from && !keep.has(n.id)) delete doc.nodes[n.id];
  }
  for (const src of snap.nodes) {
    const n = structuredClone(src);
    n.id = nodeId.get(src.id)!;
    n.parentId = src.parentId ? map(nodeId, src.parentId) : page.id;
    n.children = src.children.filter((c) => nodeId.has(c)).map((c) => nodeId.get(c)!);
    if (n.componentId) n.componentId = map(nodeId, n.componentId);
    if (n.sourceId) n.sourceId = map(nodeId, n.sourceId);
    n.propValues = Object.fromEntries(Object.entries(n.propValues).map(([k, v]) => [k, typeof v === 'string' ? map(nodeId, v) : v]));
    n.componentProps = n.componentProps.map((p) => (p.type === 'instance' && typeof p.defaultValue === 'string' ? { ...p, defaultValue: map(nodeId, p.defaultValue) } : p));
    n.bindings = Object.fromEntries(Object.entries(n.bindings).map(([k, v]) => [k, map(varId, v)]));
    for (const paints of [n.fills, n.strokes]) for (const p of paints) if (p.type === 'solid' && p.variableId) p.variableId = map(varId, p.variableId);
    if (n.textStyleId) n.textStyleId = map(styleId, n.textStyleId);
    if (n.effectStyleId) n.effectStyleId = map(styleId, n.effectStyleId);
    n.library = { fileId: from, key: src.id };
    doc.nodes[n.id] = n;
  }
  page.children = snap.roots.filter((r) => nodeId.has(r)).map((r) => nodeId.get(r)!);
  // Lay the components out in a column so thumbnails and "go to" have room.
  let y = 0;
  for (const id of page.children) {
    const n = doc.nodes[id];
    n.x = 0;
    n.y = y;
    y += n.height + 40;
  }

  if (link) Object.assign(link, { name: snap.name, version: snap.version, pageId: page.id });
  else {
    link = { fileId: from, name: snap.name, version: snap.version, pageId: page.id };
    doc.libraries.push(link);
  }
  return link;
}

/**
 * Stops using a library: its instances become ordinary layers (keeping their
 * look), its variables and styles are dropped from layers that used them.
 */
export function removeLibrary(doc: PlanarDocument, fileId: string): void {
  const link = (doc.libraries ?? []).find((l) => l.fileId === fileId);
  if (!link) return;
  const fromLib = (id: string) => doc.nodes[id]?.library?.fileId === fileId;
  for (const n of Object.values(doc.nodes)) {
    if (n.type === 'instance' && !fromLib(n.id) && fromLib(n.componentId) && doc.nodes[n.id]) detachInstance(doc, n.id);
  }
  for (const v of doc.variables) if (v.library?.fileId === fileId) unbindVariable(doc, v.id);
  doc.variables = doc.variables.filter((v) => v.library?.fileId !== fileId);
  const styles = new Set((doc.styles ?? []).filter((s) => s.library?.fileId === fileId).map((s) => s.id));
  for (const n of Object.values(doc.nodes)) {
    if (styles.has(n.textStyleId)) n.textStyleId = '';
    if (styles.has(n.effectStyleId)) n.effectStyleId = '';
  }
  doc.styles = (doc.styles ?? []).filter((s) => !styles.has(s.id));
  for (const id of [link.pageId, ...descendants(doc, link.pageId)]) delete doc.nodes[id];
  doc.pageIds = doc.pageIds.filter((p) => p !== link.pageId);
  doc.libraries = doc.libraries.filter((l) => l.fileId !== fileId);
}
