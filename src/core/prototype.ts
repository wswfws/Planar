import { hitTest } from './geometry';
import type { PlanarDocument, SceneNode } from './types';

export type Transition = 'instant' | 'slide' | 'dissolve';
export const TRANSITIONS: Transition[] = ['instant', 'slide', 'dissolve'];

const SCREEN_TYPES = new Set(['frame', 'component']);

/** Screens of a page: its top-level frames, in layer order. */
export function screensOf(doc: PlanarDocument, pageId: string): string[] {
  const page = doc.nodes[pageId];
  return (page?.children ?? []).filter((id) => doc.nodes[id] && doc.nodes[id].visible && SCREEN_TYPES.has(doc.nodes[id].type));
}

/** The top-level frame a layer lives in (itself if it is one); null on the page itself. */
export function screenOf(doc: PlanarDocument, id: string): string | null {
  let node: SceneNode | undefined = doc.nodes[id];
  while (node?.parentId) {
    const parent: SceneNode | undefined = doc.nodes[node.parentId];
    if (parent?.type === 'page') return node.id;
    node = parent;
  }
  return null;
}

/**
 * What a click does on a screen: the link of the layer under the point, or of
 * the nearest ancestor that has one. `point` is in world coordinates.
 */
export function linkAt(doc: PlanarDocument, screenId: string, point: { x: number; y: number }, tolerance = 0): { to: string; transition: Transition; from: string } | null {
  let id: string | null = hitTest(doc, screenId, point, tolerance) ?? screenId;
  while (id) {
    const node: SceneNode | undefined = doc.nodes[id];
    if (!node) return null;
    if (node.link?.to && doc.nodes[node.link.to]) return { to: node.link.to, transition: node.link.transition ?? 'instant', from: id };
    if (id === screenId) return null;
    id = node.parentId;
  }
  return null;
}

/** Where a click leads, or null when nothing there links anywhere. */
export function nextScreen(doc: PlanarDocument, current: string, point: { x: number; y: number }) {
  const hit = linkAt(doc, current, point);
  if (!hit) return null;
  const to = screenOf(doc, hit.to) ?? hit.to;
  return { to, transition: hit.transition };
}

/** The screen before or after `current` on its page (arrow keys). */
export function stepScreen(doc: PlanarDocument, pageId: string, current: string, delta: 1 | -1): string | null {
  const list = screensOf(doc, pageId);
  const i = list.indexOf(current);
  return list[i + delta] ?? null;
}

/** All links on a page as [layer, target screen] pairs (for arrows in the editor). */
export function linksOnPage(doc: PlanarDocument, pageId: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  const walk = (id: string) => {
    const n = doc.nodes[id];
    if (!n) return;
    if (n.link?.to && doc.nodes[n.link.to]) out.push({ from: id, to: n.link.to });
    n.children.forEach(walk);
  };
  doc.nodes[pageId]?.children.forEach(walk);
  return out;
}
