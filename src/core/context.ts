// Context: free-form notes (markdown) that people and agents keep on the file
// and on any layer, so whoever edits the design knows what it is for.

import { variantSet } from './components';
import { getAncestors, getPageOf } from './document';
import type { PlanarDocument, SceneNode } from './types';

/** Longest context kept on one layer or the file. */
export const CONTEXT_MAX = 20000;

export function sanitizeContext(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, CONTEXT_MAX) : '';
}

export type ContextSource = 'file' | 'page' | 'parent' | 'component' | 'layer';

export interface ContextEntry {
  source: ContextSource;
  /** Layer the text belongs to ('' for the file). */
  id: string;
  name: string;
  text: string;
}

/** The main component an instance (or a layer inside one) documents itself with. */
function documentingComponents(doc: PlanarDocument, node: SceneNode): SceneNode[] {
  const out: SceneNode[] = [];
  if (node.type === 'instance') {
    const comp = doc.nodes[node.componentId];
    if (comp) {
      const set = variantSet(doc, comp.id);
      if (set) out.push(set);
      out.push(comp);
    }
  } else if (node.sourceId && doc.nodes[node.sourceId]) {
    out.push(doc.nodes[node.sourceId]);
  }
  return out;
}

/**
 * Everything written about a layer, from the broadest to the most specific:
 * the file brief, its page, the layers around it, its main component and the
 * layer itself. Empty texts are left out.
 */
export function contextChain(doc: PlanarDocument, id: string): ContextEntry[] {
  const node = doc.nodes[id];
  const out: ContextEntry[] = [];
  const add = (source: ContextSource, n: SceneNode) => {
    if (n.context?.trim()) out.push({ source, id: n.id, name: n.name, text: n.context.trim() });
  };
  if (doc.context?.trim()) out.push({ source: 'file', id: '', name: doc.name, text: doc.context.trim() });
  if (!node) return out;
  const page = getPageOf(doc, id);
  if (page && page.id !== id) add('page', page);
  for (const a of getAncestors(doc, id)) if (a.type !== 'page') add('parent', a);
  for (const c of documentingComponents(doc, node)) add('component', c);
  add(node.type === 'page' ? 'page' : 'layer', node);
  return out;
}

const LABELS: Record<ContextSource, string> = {
  file: 'File',
  page: 'Page',
  parent: 'Inside',
  component: 'Component',
  layer: 'Layer',
};

/** The chain as markdown sections, for agents and the code export. */
export function formatContext(entries: ContextEntry[]): string {
  return entries.map((e) => `## ${LABELS[e.source]} "${e.name}"${e.id ? ` #${e.id}` : ''}\n${e.text}`).join('\n\n');
}
