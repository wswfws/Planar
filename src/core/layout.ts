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

const strokeOf = (n: SceneNode) => (n.strokeWidth > 0 && n.strokes.some((s) => s.visible) ? n.strokeWidth : 0);

/**
 * Size of a node's rotated bounding box in its parent's space; with
 * `strokes`, the stroke (drawn on the edge) adds its width.
 */
function outerSize(n: SceneNode, strokes = false): { w: number; h: number } {
  const sw = strokes ? strokeOf(n) : 0;
  if (!n.rotation) return { w: n.width + sw, h: n.height + sw };
  const r = deg2rad(n.rotation);
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return { w: n.width * c + n.height * s + sw, h: n.width * s + n.height * c + sw };
}

interface Pads {
  t: number;
  r: number;
  b: number;
  l: number;
}

/** A frame's padding; an included stroke adds its inner half. */
function padsOf(frame: SceneNode): Pads {
  const s = frame.strokesIncluded ? strokeOf(frame) / 2 : 0;
  return { t: frame.paddingTop + s, r: frame.paddingRight + s, b: frame.paddingBottom + s, l: frame.paddingLeft + s };
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

/** True when a frame lays its items out in wrapping rows (a hug width never wraps). */
export function wraps(doc: PlanarDocument, frame: SceneNode): boolean {
  return frame.layoutMode === 'horizontal' && !!frame.layoutWrap && effectiveSizing(doc, frame, 'h') !== 'hug';
}

/** Horizontal auto layout that starts a new row when the next item does not fit. */
function layoutWrapped(doc: PlanarDocument, frame: SceneNode, skip: ReadonlySet<string>): void {
  const sizing = (n: SceneNode, a: Axis) => effectiveSizing(doc, n, a === H ? 'h' : 'v');
  const items = layoutItems(doc, frame).filter((it) => !skip.has(it.id));
  const pad = padsOf(frame);
  const outer = (n: SceneNode) => outerSize(n, frame.strokesIncluded);
  const availW = frame.width - pad.l - pad.r;
  const gap = frame.itemSpacing;
  const rowGap = Number.isFinite(frame.counterSpacing) ? frame.counterSpacing : gap;
  // Filling the width means taking a whole row.
  for (const it of items) if (sizing(it, H) === 'fill') setSize(doc, it, H, availW, skip);

  const rows: SceneNode[][] = [];
  let row: SceneNode[] = [];
  let used = 0;
  for (const it of items) {
    const w = outer(it).w;
    if (row.length && used + gap + w > availW + 1e-6) {
      rows.push(row);
      row = [];
      used = 0;
    }
    used += (row.length ? gap : 0) + w;
    row.push(it);
  }
  if (row.length) rows.push(row);

  const heights = rows.map((r) => r.filter((it) => sizing(it, V) !== 'fill').reduce((m, it) => Math.max(m, outer(it).h), 0));
  rows.forEach((r, i) => r.forEach((it) => sizing(it, V) === 'fill' && setSize(doc, it, V, heights[i], skip)));
  if (sizing(frame, V) === 'hug') {
    frame.height = Math.max(0, pad.t + pad.b + heights.reduce((s, h) => s + h, 0) + rowGap * Math.max(0, rows.length - 1));
  }

  let y = pad.t;
  rows.forEach((r, i) => {
    const rh = heights[i];
    const total = r.reduce((s, it) => s + outer(it).w, 0);
    const gaps = gap * (r.length - 1);
    let spacing = gap;
    let x = pad.l;
    if (frame.primaryAlign === 'space-between' && r.length > 1) spacing = Math.max(0, (availW - total) / (r.length - 1));
    else if (frame.primaryAlign === 'center') x += (availW - total - gaps) / 2;
    else if (frame.primaryAlign === 'end') x += availW - total - gaps;
    for (const it of r) {
      const o = outer(it);
      let top = y;
      if (frame.counterAlign === 'center') top += (rh - o.h) / 2;
      else if (frame.counterAlign === 'end') top += rh - o.h;
      it.x = x + o.w / 2 - it.width / 2;
      it.y = top + o.h / 2 - it.height / 2;
      x += o.w + spacing;
    }
    y += rh + rowGap;
  });
}

/** Grid cell of the i-th item: row-major, `columns` per row. */
export function gridCell(i: number, columns: number): { row: number; col: number } {
  const cols = Math.max(1, columns);
  return { row: Math.floor(i / cols), col: i % cols };
}

/**
 * Grid layout: items fill the cells row by row. Columns share the width
 * equally (or fit their widest item when the frame hugs); rows fit their
 * tallest item, or share a fixed height when the row count is set.
 */
function layoutGrid(doc: PlanarDocument, frame: SceneNode, skip: ReadonlySet<string>): void {
  const sizing = (n: SceneNode, a: Axis) => effectiveSizing(doc, n, a === H ? 'h' : 'v');
  const all = layoutItems(doc, frame);
  const items = all.filter((it) => !skip.has(it.id));
  const pad = padsOf(frame);
  const outer = (n: SceneNode) => outerSize(n, frame.strokesIncluded);
  const cols = Math.max(1, frame.gridColumns || 1);
  const rows = Math.max(frame.gridRows || 0, Math.ceil(items.length / cols), 1);
  const colGap = frame.itemSpacing;
  const rowGap = Number.isFinite(frame.counterSpacing) ? frame.counterSpacing : colGap;
  const cell = (i: number) => gridCell(i, cols);

  for (let pass = 0; pass < 2; pass++) {
    // Column widths.
    let colW: number[];
    if (sizing(frame, H) === 'hug') {
      colW = Array.from({ length: cols }, (_, c) => items.filter((it, i) => cell(i).col === c && sizing(it, H) !== 'fill').reduce((m, it) => Math.max(m, outer(it).w), 0));
      frame.width = Math.max(0, pad.l + pad.r + colW.reduce((s, w) => s + w, 0) + colGap * (cols - 1));
    } else {
      const each = Math.max(0, (frame.width - pad.l - pad.r - colGap * (cols - 1)) / cols);
      colW = Array(cols).fill(each);
    }
    items.forEach((it, i) => sizing(it, H) === 'fill' && setSize(doc, it, H, colW[cell(i).col] - (frame.strokesIncluded ? strokeOf(it) : 0), skip));

    // Row heights.
    let rowH: number[];
    if (sizing(frame, V) !== 'hug' && frame.gridRows > 0) {
      const each = Math.max(0, (frame.height - pad.t - pad.b - rowGap * (rows - 1)) / rows);
      rowH = Array(rows).fill(each);
    } else {
      rowH = Array.from({ length: rows }, (_, r) => items.filter((it, i) => cell(i).row === r && sizing(it, V) !== 'fill').reduce((m, it) => Math.max(m, outer(it).h), 0));
      if (sizing(frame, V) === 'hug') frame.height = Math.max(0, pad.t + pad.b + rowH.reduce((s, h) => s + h, 0) + rowGap * (rows - 1));
    }
    items.forEach((it, i) => sizing(it, V) === 'fill' && setSize(doc, it, V, rowH[cell(i).row] - (frame.strokesIncluded ? strokeOf(it) : 0), skip));

    if (pass === 1) {
      const colX = colW.map((_, c) => pad.l + colW.slice(0, c).reduce((s, w) => s + w + colGap, 0));
      const rowY = rowH.map((_, r) => pad.t + rowH.slice(0, r).reduce((s, h) => s + h + rowGap, 0));
      const h = frame.primaryAlign === 'space-between' ? 'start' : frame.primaryAlign;
      items.forEach((it, i) => {
        const { row, col } = cell(i);
        const o = outer(it);
        let left = colX[col];
        let top = rowY[row];
        if (h === 'center') left += (colW[col] - o.w) / 2;
        else if (h === 'end') left += colW[col] - o.w;
        if (frame.counterAlign === 'center') top += (rowH[row] - o.h) / 2;
        else if (frame.counterAlign === 'end') top += rowH[row] - o.h;
        it.x = left + o.w / 2 - it.width / 2;
        it.y = top + o.h / 2 - it.height / 2;
      });
    }
  }
}

function layoutFrame(doc: PlanarDocument, frame: SceneNode, skip: ReadonlySet<string>): void {
  if (frame.layoutMode === 'grid') return layoutGrid(doc, frame, skip);
  if (wraps(doc, frame)) return layoutWrapped(doc, frame, skip);
  const horizontal = frame.layoutMode === 'horizontal';
  const P = horizontal ? H : V;
  const C = horizontal ? V : H;
  const sizing = (n: SceneNode, a: Axis) => effectiveSizing(doc, n, a === H ? 'h' : 'v');
  const pad = padsOf(frame);
  const padP0 = horizontal ? pad.l : pad.t;
  const padP1 = horizontal ? pad.r : pad.b;
  const padC0 = horizontal ? pad.t : pad.l;
  const padC1 = horizontal ? pad.b : pad.r;
  const outer = (n: SceneNode) => outerSize(n, frame.strokesIncluded);
  // A filled item's stroke takes part of the space it fills.
  const own = (n: SceneNode) => (frame.strokesIncluded ? strokeOf(n) : 0);
  const outerP = (n: SceneNode) => (horizontal ? outer(n).w : outer(n).h);
  const outerC = (n: SceneNode) => (horizontal ? outer(n).h : outer(n).w);

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
      for (const it of fills) setSize(doc, it, P, each - own(it), skip);
    }
    if (sizing(frame, C) === 'hug') {
      const content = all.filter((it) => sizing(it, C) !== 'fill').reduce((m, it) => Math.max(m, outerC(it)), 0);
      frame[C.size] = Math.max(0, padC0 + padC1 + content);
    }
    const availC = frame[C.size] - padC0 - padC1;
    for (const it of items) if (sizing(it, C) === 'fill') setSize(doc, it, C, availC - own(it), skip);
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
    const o = outer(it);
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
  const flow = frame.layoutMode === 'grid' || wraps(doc, frame);
  const others = frame.children.filter((c) => !exclude.has(c));
  for (let i = 0; i < others.length; i++) {
    const n = doc.nodes[others[i]];
    if (!n.visible || n.layoutAbsolute) continue;
    const c = centerInParent(n);
    if (flow) {
      // Reading order: rows top to bottom, then left to right within a row.
      const half = outerSize(n).h / 2;
      if (local.y < c.y - half || (local.y <= c.y + half && local.x < c.x)) return i;
    } else if (horizontal ? local.x < c.x : local.y < c.y) return i;
  }
  return others.length;
}

/** World-space segment marking an insertion index (see insertionIndex). */
export function insertionLine(doc: PlanarDocument, frame: SceneNode, index: number, exclude: ReadonlySet<string>): [Vec, Vec] {
  if (frame.layoutMode === 'grid' || wraps(doc, frame)) return flowInsertionLine(doc, frame, index, exclude);
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

/** Grids and wrapped rows: a vertical bar before the item at `index` (or after the last one). */
function flowInsertionLine(doc: PlanarDocument, frame: SceneNode, index: number, exclude: ReadonlySet<string>): [Vec, Vec] {
  const others = frame.children.filter((c) => !exclude.has(c));
  const items = others.map((id) => doc.nodes[id]).filter((n) => n.visible && !n.layoutAbsolute);
  const next = others.slice(index).map((id) => doc.nodes[id]).find((n) => n.visible && !n.layoutAbsolute);
  const ref = next ?? items[items.length - 1];
  const m = worldMatrix(doc, frame.id);
  if (!ref) return [apply(m, { x: frame.paddingLeft, y: frame.paddingTop }), apply(m, { x: frame.paddingLeft, y: frame.height - frame.paddingBottom })];
  const o = outerSize(ref);
  const c = centerInParent(ref);
  const x = next ? c.x - o.w / 2 - frame.itemSpacing / 2 : c.x + o.w / 2 + frame.itemSpacing / 2;
  return [apply(m, { x, y: c.y - o.h / 2 }), apply(m, { x, y: c.y + o.h / 2 })];
}
