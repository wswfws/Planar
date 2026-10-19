import { localMatrix, worldMatrix } from './geometry';
import { apply, deg2rad, type Vec } from './math';
import { measureTextNode } from './text';
import { isFrameLike, type PlanarDocument, type SceneNode, type Sizing } from './types';

const NONE: ReadonlySet<string> = new Set();

interface Axis {
  size: 'width' | 'height';
  sizing: 'sizingH' | 'sizingV';
}

const H: Axis = { size: 'width', sizing: 'sizingH' };
const V: Axis = { size: 'height', sizing: 'sizingV' };

export function isAutoLayout(node: SceneNode | null | undefined): boolean {
  return isFrameLike(node) && node!.layoutMode !== 'none';
}

/** True when the node is positioned by its parent's auto layout. */
export function isLaidOut(doc: PlanarDocument, node: SceneNode): boolean {
  return !node.layoutAbsolute && isAutoLayout(node.parentId ? doc.nodes[node.parentId] : null);
}

/** Children that take part in a frame's auto layout. */
export function layoutItems(doc: PlanarDocument, frame: SceneNode, skip: ReadonlySet<string> = NONE): SceneNode[] {
  return frame.children
    .map((id) => doc.nodes[id])
    .filter((n) => n && n.visible && !n.layoutAbsolute && !skip.has(n.id));
}

/** Size of a node's rotated bounding box in its parent's space. */
function outerSize(n: SceneNode): { w: number; h: number } {
  if (!n.rotation) return { w: n.width, h: n.height };
  const r = deg2rad(n.rotation);
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return { w: n.width * c + n.height * s, h: n.width * s + n.height * c };
}

/** Effective sizing of a node on an axis, resolving text and invalid modes. */
export function effectiveSizing(doc: PlanarDocument, node: SceneNode, axis: 'h' | 'v'): Sizing {
  const raw = axis === 'h' ? node.sizingH : node.sizingV;
  if (raw === 'fill') return isLaidOut(doc, node) ? 'fill' : 'fixed';
  if (node.type === 'text') return axis === 'h' ? (node.autoWidth ? 'hug' : 'fixed') : node.autoWidth || node.autoHeight ? 'hug' : 'fixed';
  if (raw === 'hug') return isAutoLayout(node) ? 'hug' : 'fixed';
  return 'fixed';
}

function setSize(doc: PlanarDocument, node: SceneNode, axis: Axis, value: number, skip: ReadonlySet<string>): void {
  const v = Math.max(0, value);
  if (Math.abs(node[axis.size] - v) < 1e-9) return;
  node[axis.size] = v;
  if (node.type === 'text') {
    if (axis === H) node.autoHeight = node.autoWidth || node.autoHeight;
    else node.autoHeight = false;
    node.autoWidth = false;
    node.height = measureTextNode(node).height;
  }
  if (isAutoLayout(node)) layoutFrame(doc, node, skip);
}

function layoutFrame(doc: PlanarDocument, frame: SceneNode, skip: ReadonlySet<string>): void {
  const horizontal = frame.layoutMode === 'horizontal';
  const P = horizontal ? H : V;
  const C = horizontal ? V : H;
  const sizing = (n: SceneNode, a: Axis) => effectiveSizing(doc, n, a === H ? 'h' : 'v');
  const padP0 = horizontal ? frame.paddingLeft : frame.paddingTop;
  const padP1 = horizontal ? frame.paddingRight : frame.paddingBottom;
  const padC0 = horizontal ? frame.paddingTop : frame.paddingLeft;
  const padC1 = horizontal ? frame.paddingBottom : frame.paddingRight;
  const outerP = (n: SceneNode) => (horizontal ? outerSize(n).w : outerSize(n).h);
  const outerC = (n: SceneNode) => (horizontal ? outerSize(n).h : outerSize(n).w);

  // Layers being dragged out keep their space while hugging, so the frame
  // does not shrink under the pointer mid-drag.
  const all = layoutItems(doc, frame);
  const items = all.filter((it) => !skip.has(it.id));
  const n = items.length;
  const gaps = n > 1 ? frame.itemSpacing * (n - 1) : 0;
  const hugGaps = all.length > 1 ? frame.itemSpacing * (all.length - 1) : 0;

  // Sizes depend on each other (e.g. a text's width decides its height), so
  // resolve hug and fill twice.
  for (let pass = 0; pass < 2; pass++) {
    if (sizing(frame, P) === 'hug') {
      frame[P.size] = Math.max(0, padP0 + padP1 + hugGaps + all.reduce((s, it) => s + outerP(it), 0));
    }
    const availP = frame[P.size] - padP0 - padP1;
    const fills = items.filter((it) => sizing(it, P) === 'fill');
    if (fills.length && sizing(frame, P) !== 'hug') {
      const fixed = items.filter((it) => sizing(it, P) !== 'fill').reduce((s, it) => s + outerP(it), 0);
      const each = (availP - fixed - gaps) / fills.length;
      for (const it of fills) setSize(doc, it, P, each, skip);
    }
    if (sizing(frame, C) === 'hug') {
      const content = all.filter((it) => sizing(it, C) !== 'fill').reduce((m, it) => Math.max(m, outerC(it)), 0);
      frame[C.size] = Math.max(0, padC0 + padC1 + content);
    }
    const availC = frame[C.size] - padC0 - padC1;
    for (const it of items) if (sizing(it, C) === 'fill') setSize(doc, it, C, availC, skip);
  }

  const availP = frame[P.size] - padP0 - padP1;
  const availC = frame[C.size] - padC0 - padC1;
  const total = items.reduce((s, it) => s + outerP(it), 0);
  let spacing = frame.itemSpacing;
  let pos = padP0;
  if (frame.primaryAlign === 'space-between' && n > 1) spacing = Math.max(0, (availP - total) / (n - 1));
  else if (frame.primaryAlign === 'center') pos += (availP - total - gaps) / 2;
  else if (frame.primaryAlign === 'end') pos += availP - total - gaps;

  for (const it of items) {
    const o = outerSize(it);
    const along = horizontal ? o.w : o.h;
    const across = horizontal ? o.h : o.w;
    let cross = padC0;
    if (frame.counterAlign === 'center') cross += (availC - across) / 2;
    else if (frame.counterAlign === 'end') cross += availC - across;
    const left = horizontal ? pos : cross;
    const top = horizontal ? cross : pos;
    it.x = left + o.w / 2 - it.width / 2;
    it.y = top + o.h / 2 - it.height / 2;
    pos += along + spacing;
  }
}

/** Lays out every auto-layout frame under rootId, innermost first. */
export function applyAutoLayout(doc: PlanarDocument, rootId: string, skip: ReadonlySet<string> = NONE): void {
  const node = doc.nodes[rootId];
  if (!node) return;
  for (const c of node.children) applyAutoLayout(doc, c, skip);
  if (isAutoLayout(node)) layoutFrame(doc, node, skip);
}

function centerInParent(n: SceneNode): Vec {
  return apply(localMatrix(n), { x: n.width / 2, y: n.height / 2 });
}

/**
 * Where layers dropped at `local` (frame space) would be inserted: an index
 * into the frame's children with `exclude` removed.
 */
export function insertionIndex(doc: PlanarDocument, frame: SceneNode, local: Vec, exclude: ReadonlySet<string>): number {
  const horizontal = frame.layoutMode === 'horizontal';
  const others = frame.children.filter((c) => !exclude.has(c));
  for (let i = 0; i < others.length; i++) {
    const n = doc.nodes[others[i]];
    if (!n.visible || n.layoutAbsolute) continue;
    const c = centerInParent(n);
    if (horizontal ? local.x < c.x : local.y < c.y) return i;
  }
  return others.length;
}

/** World-space segment marking an insertion index (see insertionIndex). */
export function insertionLine(doc: PlanarDocument, frame: SceneNode, index: number, exclude: ReadonlySet<string>): [Vec, Vec] {
  const horizontal = frame.layoutMode === 'horizontal';
  const others = frame.children.filter((c) => !exclude.has(c));
  const items = others.map((id) => doc.nodes[id]).filter((n) => n.visible && !n.layoutAbsolute);
  const next = others.slice(index).map((id) => doc.nodes[id]).find((n) => n.visible && !n.layoutAbsolute);
  const half = frame.itemSpacing / 2;
  const startOf = (n: SceneNode) => {
    const o = outerSize(n);
    const c = centerInParent(n);
    return horizontal ? c.x - o.w / 2 : c.y - o.h / 2;
  };
  const endOf = (n: SceneNode) => {
    const o = outerSize(n);
    const c = centerInParent(n);
    return horizontal ? c.x + o.w / 2 : c.y + o.h / 2;
  };
  let along: number;
  if (next) along = startOf(next) - (next === items[0] ? 0 : half);
  else if (items.length) along = endOf(items[items.length - 1]) + half;
  else along = horizontal ? frame.paddingLeft : frame.paddingTop;
  const c0 = horizontal ? frame.paddingTop : frame.paddingLeft;
  const c1 = horizontal ? frame.height - frame.paddingBottom : frame.width - frame.paddingRight;
  const m = worldMatrix(doc, frame.id);
  const pt = (a: number, c: number) => apply(m, horizontal ? { x: a, y: c } : { x: c, y: a });
  return [pt(along, c0), pt(along, c1)];
}
