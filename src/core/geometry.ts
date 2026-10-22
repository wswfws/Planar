import {
  apply,
  deg2rad,
  distanceToSegment,
  IDENTITY,
  invert,
  matrixAngle,
  multiply,
  pointInPolygon,
  rectFromPoints,
  rectsIntersect,
  rectUnion,
  rotation,
  translation,
  type Mat,
  type Rect,
  type Vec,
} from './math';
import { getAncestors, getNode, getParent } from './document';
import { measureTextNode } from './text';
import { isFrameLike, type PlanarDocument, type SceneNode } from './types';

export function localMatrix(node: SceneNode): Mat {
  if (node.type === 'page') return [...IDENTITY];
  const hw = node.width / 2;
  const hh = node.height / 2;
  return multiply(
    multiply(translation(node.x + hw, node.y + hh), rotation(deg2rad(node.rotation))),
    translation(-hw, -hh),
  );
}

export function worldMatrix(doc: PlanarDocument, id: string): Mat {
  let m: Mat = [...IDENTITY];
  for (const a of getAncestors(doc, id)) m = multiply(m, localMatrix(a));
  return multiply(m, localMatrix(getNode(doc, id)));
}

export function parentWorldMatrix(doc: PlanarDocument, id: string): Mat {
  const parent = getParent(doc, id);
  return parent ? worldMatrix(doc, parent.id) : [...IDENTITY];
}

export function worldCorners(doc: PlanarDocument, id: string): Vec[] {
  const node = getNode(doc, id);
  const m = worldMatrix(doc, id);
  return [
    { x: 0, y: 0 },
    { x: node.width, y: 0 },
    { x: node.width, y: node.height },
    { x: 0, y: node.height },
  ].map((p) => apply(m, p));
}

export function worldBounds(doc: PlanarDocument, id: string): Rect {
  return rectFromPoints(worldCorners(doc, id));
}

export function selectionBounds(doc: PlanarDocument, ids: string[]): Rect | null {
  return rectUnion(ids.filter((id) => doc.nodes[id]).map((id) => worldBounds(doc, id)));
}

export function worldCenter(doc: PlanarDocument, id: string): Vec {
  const n = getNode(doc, id);
  return apply(worldMatrix(doc, id), { x: n.width / 2, y: n.height / 2 });
}

export function worldRotation(doc: PlanarDocument, id: string): number {
  return matrixAngle(worldMatrix(doc, id));
}

/**
 * Sets a node's local x/y/rotation so that its centre lands on `center`
 * (world space) with the given world rotation, keeping width/height.
 */
export function placeNode(doc: PlanarDocument, id: string, center: Vec, worldRot: number): void {
  const node = getNode(doc, id);
  const pm = parentWorldMatrix(doc, id);
  const lc = apply(invert(pm), center);
  node.x = lc.x - node.width / 2;
  node.y = lc.y - node.height / 2;
  let r = worldRot - matrixAngle(pm);
  r = ((r % 360) + 540) % 360 - 180;
  node.rotation = Math.abs(r) < 1e-9 ? 0 : r;
}

/** Re-parents a node while keeping its position on the canvas. */
export function reparentKeepWorld(doc: PlanarDocument, id: string, parentId: string, index?: number): void {
  const center = worldCenter(doc, id);
  const rot = worldRotation(doc, id);
  const node = getNode(doc, id);
  const oldParent = getParent(doc, id);
  if (oldParent) oldParent.children = oldParent.children.filter((c) => c !== id);
  const parent = getNode(doc, parentId);
  node.parentId = parentId;
  const i = index === undefined ? parent.children.length : index;
  parent.children.splice(i, 0, id);
  placeNode(doc, id, center, rot);
}

/** Vertex positions of a vector node in its local box space. */
export function vectorPoints(node: SceneNode): Vec[] {
  return node.points.map((p) => ({ x: p.x * node.width, y: p.y * node.height }));
}

function hitsShape(node: SceneNode, p: Vec, tolerance: number): boolean {
  const { width: w, height: h } = node;
  const strokeTol = (node.strokes.some((s) => s.visible) ? node.strokeWidth / 2 : 0) + tolerance;
  switch (node.type) {
    case 'ellipse': {
      const rx = w / 2 + strokeTol;
      const ry = h / 2 + strokeTol;
      const dx = p.x - w / 2;
      const dy = p.y - h / 2;
      return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
    }
    case 'vector': {
      if (node.paths.length) return p.x >= -tolerance && p.y >= -tolerance && p.x <= w + tolerance && p.y <= h + tolerance;
      const pts = vectorPoints(node);
      if (node.closed && pointInPolygon(p, pts)) return true;
      const segs = node.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segs; i++) {
        if (distanceToSegment(p, pts[i], pts[(i + 1) % pts.length]) <= strokeTol) return true;
      }
      return false;
    }
    default:
      return p.x >= -tolerance && p.y >= -tolerance && p.x <= w + tolerance && p.y <= h + tolerance;
  }
}

function insideBox(node: SceneNode, p: Vec): boolean {
  return p.x >= 0 && p.y >= 0 && p.x <= node.width && p.y <= node.height;
}

/**
 * Returns the deepest visible, unlocked node under a world point, honouring
 * frame clipping. `tolerance` is in world units.
 */
export function hitTest(
  doc: PlanarDocument,
  parentId: string,
  point: Vec,
  tolerance: number,
  exclude: ReadonlySet<string> = new Set(),
): string | null {
  const parent = doc.nodes[parentId];
  if (!parent) return null;
  for (let i = parent.children.length - 1; i >= 0; i--) {
    const id = parent.children[i];
    const node = doc.nodes[id];
    if (!node || !node.visible || exclude.has(id)) continue;
    const local = apply(invert(worldMatrix(doc, id)), point);
    if (node.type === 'group') {
      const hit = hitTest(doc, id, point, tolerance, exclude);
      if (hit) return hit;
      continue;
    }
    if (isFrameLike(node)) {
      const inside = insideBox(node, local);
      if (inside || !node.clipContent) {
        const hit = hitTest(doc, id, point, tolerance, exclude);
        if (hit) return hit;
      }
      if (inside && !node.locked) return id;
      continue;
    }
    if (!node.locked && hitsShape(node, local, tolerance)) return id;
  }
  return null;
}

/** Every visible layer under a world point, top-most first. */
export function nodesAt(doc: PlanarDocument, parentId: string, point: Vec, tolerance: number): string[] {
  const out: string[] = [];
  const walk = (pid: string) => {
    const parent = doc.nodes[pid];
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const id = parent.children[i];
      const node = doc.nodes[id];
      if (!node || !node.visible) continue;
      const local = apply(invert(worldMatrix(doc, id)), point);
      const container = isFrameLike(node) || node.type === 'group';
      // Same tolerance as clicking, so the clicked layer is always listed.
      const inside = hitsShape(node, local, tolerance);
      if (container && (inside || !(isFrameLike(node) && node.clipContent))) walk(id);
      if (inside) out.push(id);
    }
  };
  walk(parentId);
  return out;
}

/** Deepest visible frame (or the page) containing a world point. */
export function frameAt(doc: PlanarDocument, pageId: string, point: Vec, exclude: ReadonlySet<string>): string {
  const walk = (parentId: string): string | null => {
    const parent = doc.nodes[parentId];
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const id = parent.children[i];
      const node = doc.nodes[id];
      if (!node || !node.visible || exclude.has(id)) continue;
      if (!isFrameLike(node) && node.type !== 'group') continue;
      const local = apply(invert(worldMatrix(doc, id)), point);
      // Nothing can be dropped into an instance; it hides what is below it.
      if (node.type === 'instance') {
        if (insideBox(node, local)) return null;
        continue;
      }
      if (node.type === 'group') {
        const inner = walk(id);
        if (inner) return inner;
        continue;
      }
      if (insideBox(node, local)) return walk(id) ?? id;
    }
    return null;
  };
  return walk(pageId) ?? pageId;
}

/** Children of `parentId` whose world bounds intersect the rect. */
export function nodesInRect(doc: PlanarDocument, parentId: string, rect: Rect): string[] {
  const parent = doc.nodes[parentId];
  if (!parent) return [];
  return parent.children.filter((id) => {
    const n = doc.nodes[id];
    return n && n.visible && !n.locked && rectsIntersect(worldBounds(doc, id), rect);
  });
}

/**
 * Shrinks/grows every group so it tightly wraps its children (bottom-up) and
 * removes empty groups. Children keep their canvas position.
 */
export function fitGroups(doc: PlanarDocument, rootId: string): void {
  const node = doc.nodes[rootId];
  if (!node) return;
  for (const c of [...node.children]) fitGroups(doc, c);
  if (node.type !== 'group') return;
  if (!node.children.length) {
    const parent = getParent(doc, rootId);
    if (parent) parent.children = parent.children.filter((c) => c !== rootId);
    delete doc.nodes[rootId];
    return;
  }
  fitToChildren(doc, node, 0);
}

/**
 * Resizes a container to wrap its children plus padding; children keep
 * their canvas position.
 */
export function fitToChildren(doc: PlanarDocument, node: SceneNode, pad: number): void {
  if (!node.children.length) return;
  const pts: Vec[] = [];
  for (const c of node.children) {
    const child = doc.nodes[c];
    const m = localMatrix(child);
    for (const p of [
      { x: 0, y: 0 },
      { x: child.width, y: 0 },
      { x: child.width, y: child.height },
      { x: 0, y: child.height },
    ]) {
      pts.push(apply(m, p));
    }
  }
  const content = rectFromPoints(pts);
  const b = { x: content.x - pad, y: content.y - pad, width: content.width + pad * 2, height: content.height + pad * 2 };
  if (Math.abs(b.x) < 1e-6 && Math.abs(b.y) < 1e-6 && Math.abs(b.width - node.width) < 1e-6 && Math.abs(b.height - node.height) < 1e-6) {
    return;
  }
  const newCenterInParent = apply(localMatrix(node), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  for (const c of node.children) {
    doc.nodes[c].x -= b.x;
    doc.nodes[c].y -= b.y;
  }
  node.width = b.width;
  node.height = b.height;
  node.x = newCenterInParent.x - b.width / 2;
  node.y = newCenterInParent.y - b.height / 2;
}

/**
 * A frame made only of vector layers without auto layout — typically an
 * imported icon. Resizing it scales the drawing (and its stroke widths).
 */
export function isIconFrame(doc: PlanarDocument, n: SceneNode): boolean {
  return (
    isFrameLike(n) &&
    n.type !== 'instance' &&
    n.layoutMode === 'none' &&
    n.children.length > 0 &&
    n.children.every((c) => doc.nodes[c]?.type === 'vector')
  );
}

/**
 * Updates what a resized container holds (sx, sy = new size / old size):
 * groups and icon frames scale their drawing; other frames move and stretch
 * their children by the children's constraints.
 */
export function scaleContents(doc: PlanarDocument, n: SceneNode, sx: number, sy: number): void {
  if (n.type === 'group') scaleChildren(doc, n.id, sx, sy);
  else if (isIconFrame(doc, n)) {
    scaleChildren(doc, n.id, sx, sy);
    const k = Math.min(Math.abs(sx), Math.abs(sy));
    for (const c of n.children) doc.nodes[c].strokeWidth = Math.round(doc.nodes[c].strokeWidth * k * 100) / 100;
  } else if (isFrameLike(n) && sx && sy) {
    applyConstraints(doc, n, n.width / sx, n.height / sy);
  }
}

/**
 * Moves and resizes a frame's children by their constraints after the frame
 * changed from oldW × oldH to its current size. Children placed by auto layout
 * are left to it; `keep` skips children whose geometry must not move (e.g.
 * overridden layers inside an instance).
 */
export function applyConstraints(doc: PlanarDocument, frame: SceneNode, oldW: number, oldH: number, keep?: (child: SceneNode) => boolean): void {
  const dw = frame.width - oldW;
  const dh = frame.height - oldH;
  if (Math.abs(dw) < 1e-9 && Math.abs(dh) < 1e-9) return;
  const auto = frame.layoutMode !== 'none';
  for (const c of frame.children) {
    const child = doc.nodes[c];
    if (!child || (auto && !child.layoutAbsolute) || keep?.(child)) continue;
    const w0 = child.width;
    const h0 = child.height;
    const along = (pos: number, size: number, mode: string, d: number, old: number): [number, number] => {
      switch (mode) {
        case 'right':
        case 'bottom':
          return [pos + d, size];
        case 'center':
          return [pos + d / 2, size];
        case 'left-right':
        case 'top-bottom':
          return [pos, Math.max(0, size + d)];
        case 'scale': {
          const k = old > 0 ? (old + d) / old : 1;
          return [pos * k, size * k];
        }
        default:
          return [pos, size];
      }
    };
    [child.x, child.width] = along(child.x, child.width, child.constraintH, dw, oldW);
    [child.y, child.height] = along(child.y, child.height, child.constraintV, dh, oldH);
    if (child.type === 'text' && (child.width !== w0 || child.height !== h0)) {
      if (child.width !== w0) {
        child.autoHeight = child.autoWidth || child.autoHeight;
        child.autoWidth = false;
      }
      if (child.height !== h0 && child.width === w0) child.autoHeight = false;
      if (child.autoHeight) child.height = measureTextNode(child).height;
    } else if ((child.width !== w0 || child.height !== h0) && w0 > 0 && h0 > 0) {
      scaleContents(doc, child, child.width / w0, child.height / h0);
    }
  }
}

/** Scales the subtree under a container by sx/sy in its local space. */
export function scaleChildren(doc: PlanarDocument, id: string, sx: number, sy: number): void {
  for (const c of doc.nodes[id]?.children ?? []) {
    const child = doc.nodes[c];
    child.x *= sx;
    child.y *= sy;
    child.width *= Math.abs(sx);
    child.height *= Math.abs(sy);
    if (child.type === 'text') {
      child.fontSize = Math.max(1, child.fontSize * Math.min(Math.abs(sx), Math.abs(sy)));
      // Scaled text no longer matches its style.
      if (sx !== 1 || sy !== 1) child.textStyleId = '';
    }
    scaleChildren(doc, c, sx, sy);
  }
}

/** Selection with any node removed whose ancestor is also selected. */
export function topLevelSelection(doc: PlanarDocument, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => doc.nodes[id] && !getAncestors(doc, id).some((a) => set.has(a.id)));
}
