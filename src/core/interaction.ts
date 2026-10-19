import { isInInstance, markOverrides } from './components';
import { createNode, descendants, getAncestors, getParent, insertNode, solid } from './document';
import type { Editor } from './editor';
import {
  frameAt,
  hitTest,
  parentWorldMatrix,
  placeNode,
  reparentKeepWorld,
  scaleChildren,
  selectionBounds,
  topLevelSelection,
  worldBounds,
  worldCenter,
  worldMatrix,
  worldRotation,
} from './geometry';
import {
  apply,
  applyLinear,
  deg2rad,
  dist,
  invert,
  rad2deg,
  rectCenter,
  rectFromPoints,
  rectsIntersect,
  rotateAround,
  translation,
  type Mat,
  type Rect,
  type Vec,
} from './math';
import { insertionIndex, insertionLine, isAutoLayout, isLaidOut } from './layout';
import { isFrameLike, type NodeType, type PlanarDocument, type SceneNode } from './types';

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const HANDLES: { handle: Handle; u: number; v: number }[] = [
  { handle: 'nw', u: 0, v: 0 },
  { handle: 'n', u: 0.5, v: 0 },
  { handle: 'ne', u: 1, v: 0 },
  { handle: 'e', u: 1, v: 0.5 },
  { handle: 'se', u: 1, v: 1 },
  { handle: 's', u: 0.5, v: 1 },
  { handle: 'sw', u: 0, v: 1 },
  { handle: 'w', u: 0, v: 0.5 },
];

const RESIZE_CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
const HANDLE_ANGLE: Record<Handle, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M6 14a7 7 0 1 1 3 5.7" fill="none" stroke="white" stroke-width="4"/><path d="M6 14a7 7 0 1 1 3 5.7" fill="none" stroke="black" stroke-width="1.6"/><path d="M2.5 12.5 6 17l3.5-4.5z" fill="black" stroke="white"/></svg>',
)}") 12 12, crosshair`;

export interface PointerInput {
  screen: Vec;
  button: number;
  shift: boolean;
  alt: boolean;
  mod: boolean;
}

/** The box handles are drawn on: one node's own box, or the AABB of many. */
export interface SelectionFrame {
  matrix: Mat;
  width: number;
  height: number;
  single: string | null;
}

export function selectionFrame(editor: Editor): SelectionFrame | null {
  const { doc } = editor;
  const ids = topLevelSelection(doc, editor.selection);
  if (!ids.length) return null;
  if (ids.length === 1) {
    const n = doc.nodes[ids[0]];
    return { matrix: worldMatrix(doc, n.id), width: n.width, height: n.height, single: n.id };
  }
  const b = selectionBounds(doc, ids)!;
  return { matrix: translation(b.x, b.y), width: b.width, height: b.height, single: null };
}

/** Screen-space rectangle of a top-level frame's name label. */
export function frameLabelRect(editor: Editor, node: SceneNode): Rect {
  const corners = [
    { x: 0, y: 0 },
    { x: node.width, y: 0 },
    { x: node.width, y: node.height },
    { x: 0, y: node.height },
  ].map((p) => editor.worldToScreen(apply(worldMatrix(editor.doc, node.id), p)));
  const tl = rectFromPoints(corners);
  const prefix = node.type === 'component' || node.type === 'instance' ? 14 : 0;
  const w = Math.min(Math.max(node.name.length * 6.5 + 4 + prefix, 20), Math.max(tl.width, 20));
  return { x: tl.x, y: tl.y - 20, width: w, height: 18 };
}

function nextName(doc: PlanarDocument, type: NodeType, base: string): string {
  let n = 0;
  for (const node of Object.values(doc.nodes)) if (node.type === type) n++;
  return `${base} ${n + 1}`;
}

type Drag =
  | { kind: 'pan'; last: Vec }
  | { kind: 'marquee'; start: Vec; base: string[] }
  | {
      kind: 'move';
      startScreen: Vec;
      start: Vec;
      started: boolean;
      duplicate: boolean;
      ids: string[];
      origins: Map<string, { x: number; y: number; inv: Mat }>;
      bbox: Rect | null;
      snapX: number[];
      snapY: number[];
    }
  | {
      kind: 'resize';
      handle: Handle;
      frame: SelectionFrame;
      ids: string[];
      originals: Map<string, SceneNode>;
      centers: Map<string, { center: Vec; rotation: number }>;
    }
  | { kind: 'rotate'; center: Vec; startAngle: number; ids: string[]; origins: Map<string, { center: Vec; rotation: number }> }
  | { kind: 'create'; type: NodeType; start: Vec; parentId: string; nodeId: string | null; startScreen: Vec };

const SNAP_PX = 5;
const DRAG_THRESHOLD = 3;

export class Interaction {
  drag: Drag | null = null;
  private hoverHandle: string = 'default';

  constructor(private editor: Editor) {}

  private get doc(): PlanarDocument {
    return this.editor.doc;
  }

  private tolerance(): number {
    return 3 / this.editor.viewport.zoom;
  }

  /** Maps a raw hit to what a click should select (respecting groups). */
  resolveSelectable(hitId: string): string {
    const chain = [...getAncestors(this.doc, hitId), this.doc.nodes[hitId]];
    const selected = new Set(this.editor.selection);
    for (const node of chain) {
      if (node.type !== 'group' && node.type !== 'instance') continue;
      if (selected.has(node.id)) return node.id;
      const entered = this.editor.selection.some((s) => s !== node.id && getAncestors(this.doc, s).some((a) => a.id === node.id));
      if (!entered) return node.id;
    }
    return hitId;
  }

  private hitAt(world: Vec): string | null {
    const hit = hitTest(this.doc, this.editor.pageId, world, this.tolerance());
    return hit ? this.resolveSelectable(hit) : null;
  }

  private frameLabelAt(screen: Vec): string | null {
    const page = this.editor.page;
    for (let i = page.children.length - 1; i >= 0; i--) {
      const n = this.doc.nodes[page.children[i]];
      if (!isFrameLike(n) || !n.visible || n.locked) continue;
      const r = frameLabelRect(this.editor, n);
      if (screen.x >= r.x && screen.x <= r.x + r.width && screen.y >= r.y && screen.y <= r.y + r.height) return n.id;
    }
    return null;
  }

  private handleAt(screen: Vec): { handle: Handle; rotate: boolean } | null {
    const frame = selectionFrame(this.editor);
    if (!frame || this.editor.editingTextId) return null;
    const single = frame.single ? this.doc.nodes[frame.single] : null;
    if (single?.locked) return null;
    // Layers inside instances follow their component's geometry.
    if (this.editor.selection.some((id) => isInInstance(this.doc, id))) return null;
    const toScreen = (u: number, v: number) => this.editor.worldToScreen(apply(frame.matrix, { x: u * frame.width, y: v * frame.height }));
    for (const { handle, u, v } of HANDLES) {
      if (dist(toScreen(u, v), screen) <= 6) return { handle, rotate: false };
    }
    // Rotation zones sit just outside the corners.
    const local = apply(invert(frame.matrix), this.editor.screenToWorld(screen));
    const outside = local.x < 0 || local.y < 0 || local.x > frame.width || local.y > frame.height;
    if (outside) {
      for (const { handle, u, v } of HANDLES) {
        if (handle.length === 2 && dist(toScreen(u, v), screen) <= 20) return { handle, rotate: true };
      }
    }
    return null;
  }

  cursor(): string {
    const { editor } = this;
    if (this.drag?.kind === 'pan') return 'grabbing';
    if (editor.spaceDown || editor.tool === 'hand') return 'grab';
    if (editor.tool === 'text') return 'text';
    if (editor.tool !== 'select') return 'crosshair';
    return this.hoverHandle;
  }

  private cursorForHandle(handle: Handle, rotate: boolean): string {
    if (rotate) return ROTATE_CURSOR;
    const frame = selectionFrame(this.editor);
    const rot = frame ? rad2deg(Math.atan2(frame.matrix[1], frame.matrix[0])) : 0;
    const angle = (((HANDLE_ANGLE[handle] + rot) % 180) + 180) % 180;
    return RESIZE_CURSORS[Math.round(angle / 45) % 4];
  }

  // ------------------------------------------------------------- events

  pointerDown(e: PointerInput): void {
    const { editor } = this;
    const world = editor.screenToWorld(e.screen);
    if (editor.editingTextId) editor.finishTextEditing();

    if (e.button === 1 || editor.spaceDown || editor.tool === 'hand') {
      this.drag = { kind: 'pan', last: e.screen };
      editor.emit();
      return;
    }
    if (e.button !== 0) return;

    switch (editor.tool) {
      case 'frame':
      case 'rectangle':
      case 'ellipse':
      case 'line': {
        const type: NodeType = editor.tool === 'line' ? 'vector' : editor.tool;
        const parentId = frameAt(this.doc, editor.pageId, world, new Set());
        this.drag = { kind: 'create', type, start: world, parentId, nodeId: null, startScreen: e.screen };
        return;
      }
      case 'text':
        this.createText(world);
        return;
      case 'pen':
        this.penClick(e, world);
        return;
    }

    // Move tool.
    const h = this.handleAt(e.screen);
    if (h) {
      if (h.rotate) this.startRotate(world);
      else this.startResize(h.handle);
      return;
    }
    const target = this.frameLabelAt(e.screen) ?? this.hitAt(world);
    if (target) {
      if (e.shift) {
        editor.toggleSelect(target);
        if (!editor.selection.includes(target)) return;
      } else if (!editor.selection.includes(target)) {
        editor.select([target]);
      }
      this.prepareMove(e, world);
      return;
    }
    const sb = editor.selection.length > 1 ? selectionBounds(this.doc, editor.selection) : null;
    if (sb && !e.shift && world.x >= sb.x && world.y >= sb.y && world.x <= sb.x + sb.width && world.y <= sb.y + sb.height) {
      this.prepareMove(e, world);
      return;
    }
    this.drag = { kind: 'marquee', start: world, base: e.shift ? [...editor.selection] : [] };
    if (!e.shift) editor.select([]);
  }

  pointerMove(e: PointerInput): void {
    const { editor } = this;
    const world = editor.screenToWorld(e.screen);
    const drag = this.drag;

    if (!drag) {
      if (editor.tool === 'pen' && editor.overlay.pen) {
        editor.overlay.pen.cursor = this.constrainPen(world, e.shift);
        editor.emit();
      } else if (editor.tool === 'select') {
        const h = this.handleAt(e.screen);
        this.hoverHandle = h ? this.cursorForHandle(h.handle, h.rotate) : 'default';
        const hover = h ? null : this.frameLabelAt(e.screen) ?? this.hitAt(world);
        if (hover !== editor.hoverId) {
          editor.hoverId = hover;
          editor.emit();
        }
      }
      return;
    }

    switch (drag.kind) {
      case 'pan':
        editor.panBy(e.screen.x - drag.last.x, e.screen.y - drag.last.y);
        drag.last = e.screen;
        break;
      case 'marquee': {
        const rect = rectFromPoints([drag.start, world]);
        editor.overlay.marquee = rect;
        const picked = this.marqueePick(editor.pageId, rect);
        editor.select([...new Set([...drag.base, ...picked])]);
        break;
      }
      case 'move':
        this.updateMove(drag, e, world);
        break;
      case 'resize':
        this.updateResize(drag, world, e.shift, e.alt);
        break;
      case 'rotate':
        this.updateRotate(drag, world, e.shift);
        break;
      case 'create':
        this.updateCreate(drag, e, world);
        break;
    }
  }

  pointerUp(e: PointerInput): void {
    const { editor } = this;
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    const world = editor.screenToWorld(e.screen);
    switch (drag.kind) {
      case 'pan':
        editor.emit();
        break;
      case 'marquee':
        editor.overlay.marquee = null;
        editor.emit();
        break;
      case 'move':
        if (drag.started) {
          this.dropIntoFrame(drag.ids, world);
          editor.layoutSkip = new Set();
          editor.overlay.guides = [];
          editor.overlay.insertion = null;
          editor.commit();
        }
        break;
      case 'resize':
      case 'rotate':
        editor.commit();
        break;
      case 'create':
        this.finishCreate(drag, world);
        break;
    }
  }

  doubleClick(e: PointerInput): void {
    const { editor } = this;
    if (editor.tool === 'pen') {
      editor.finishPen(false);
      return;
    }
    if (editor.tool !== 'select') return;
    const world = editor.screenToWorld(e.screen);
    const hit = hitTest(this.doc, editor.pageId, world, this.tolerance());
    if (!hit) return;
    const resolved = this.resolveSelectable(hit);
    const node = this.doc.nodes[resolved];
    if (node.type === 'text') {
      editor.startTextEditing(node.id);
    } else if (node.type === 'group' || node.type === 'instance') {
      const chain = [...getAncestors(this.doc, hit).map((a) => a.id), hit];
      const next = chain[chain.indexOf(resolved) + 1];
      if (next) {
        editor.select([next]);
        if (this.doc.nodes[next].type === 'text') editor.startTextEditing(next);
      }
    } else if (hit !== resolved) {
      editor.select([hit]);
    }
  }

  // ------------------------------------------------------------- marquee

  private marqueePick(parentId: string, rect: Rect): string[] {
    const out: string[] = [];
    for (const id of this.doc.nodes[parentId].children) {
      const n = this.doc.nodes[id];
      if (!n.visible || n.locked) continue;
      const b = worldBounds(this.doc, id);
      if (!rectsIntersect(b, rect)) continue;
      const contained = b.x >= rect.x && b.y >= rect.y && b.x + b.width <= rect.x + rect.width && b.y + b.height <= rect.y + rect.height;
      if ((n.type === 'frame' || n.type === 'component') && !contained) out.push(...this.marqueePick(id, rect));
      else out.push(id);
    }
    return out;
  }

  // ------------------------------------------------------------- move

  private prepareMove(e: PointerInput, world: Vec): void {
    this.drag = {
      kind: 'move',
      startScreen: e.screen,
      start: world,
      started: false,
      duplicate: e.alt,
      ids: [],
      origins: new Map(),
      bbox: null,
      snapX: [],
      snapY: [],
    };
  }

  private startMove(drag: Extract<Drag, { kind: 'move' }>): void {
    const { editor } = this;
    drag.started = true;
    editor.begin();
    if (drag.duplicate) editor.duplicateSelection(0);
    const ids = topLevelSelection(this.doc, editor.selection).filter((id) => !this.doc.nodes[id].locked && !isInInstance(this.doc, id));
    drag.ids = ids;
    editor.layoutSkip = new Set(ids.filter((id) => isLaidOut(this.doc, this.doc.nodes[id])));
    for (const id of ids) {
      const n = this.doc.nodes[id];
      drag.origins.set(id, { x: n.x, y: n.y, inv: invert(parentWorldMatrix(this.doc, id)) });
    }
    drag.bbox = selectionBounds(this.doc, ids);
    const moving = new Set(ids.flatMap((id) => [id, ...descendants(this.doc, id)]));
    const xs: number[] = [];
    const ys: number[] = [];
    for (const id of descendants(this.doc, editor.pageId)) {
      const n = this.doc.nodes[id];
      if (moving.has(id) || !n.visible || n.type === 'group') continue;
      const b = worldBounds(this.doc, id);
      xs.push(b.x, b.x + b.width / 2, b.x + b.width);
      ys.push(b.y, b.y + b.height / 2, b.y + b.height);
    }
    drag.snapX = xs;
    drag.snapY = ys;
  }

  private updateMove(drag: Extract<Drag, { kind: 'move' }>, e: PointerInput, world: Vec): void {
    const { editor } = this;
    if (!drag.started) {
      if (dist(e.screen, drag.startScreen) < DRAG_THRESHOLD) return;
      this.startMove(drag);
    }
    let d = { x: world.x - drag.start.x, y: world.y - drag.start.y };
    if (e.shift) d = Math.abs(d.x) > Math.abs(d.y) ? { x: d.x, y: 0 } : { x: 0, y: d.y };
    const guides: { axis: 'x' | 'y'; value: number }[] = [];
    const b = drag.bbox;
    if (b) {
      const threshold = SNAP_PX / editor.viewport.zoom;
      const snapAxis = (start: number, size: number, delta: number, candidates: number[], axis: 'x' | 'y') => {
        const edges = [start + delta, start + delta + size / 2, start + delta + size];
        let best: { diff: number; value: number } | null = null;
        for (const edge of edges) {
          for (const c of candidates) {
            const diff = c - edge;
            if (Math.abs(diff) <= threshold && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, value: c };
          }
        }
        if (best) {
          guides.push({ axis, value: best.value });
          return delta + best.diff;
        }
        return Math.round(start + delta) - start;
      };
      if (!(e.shift && d.x === 0)) d.x = snapAxis(b.x, b.width, d.x, drag.snapX, 'x');
      if (!(e.shift && d.y === 0)) d.y = snapAxis(b.y, b.height, d.y, drag.snapY, 'y');
    }
    editor.overlay.guides = guides;
    editor.change((doc) => {
      for (const id of drag.ids) {
        const o = drag.origins.get(id)!;
        const ld = applyLinear(o.inv, d);
        doc.nodes[id].x = o.x + ld.x;
        doc.nodes[id].y = o.y + ld.y;
      }
    });
    const drop = this.autoLayoutDrop(drag.ids, world);
    editor.overlay.insertion = drop ? insertionLine(this.doc, drop.frame, drop.index, drop.exclude) : null;
  }

  /** If dropping at `world` lands in an auto-layout frame, where it goes. */
  private autoLayoutDrop(ids: string[], world: Vec): { frame: SceneNode; index: number; exclude: Set<string> } | null {
    const exclude = new Set(ids.flatMap((id) => [id, ...descendants(this.doc, id)]));
    const target = this.doc.nodes[frameAt(this.doc, this.editor.pageId, world, exclude)];
    if (!isAutoLayout(target)) return null;
    if (ids.every((id) => this.doc.nodes[id].layoutAbsolute && this.doc.nodes[id].parentId === target.id)) return null;
    const local = apply(invert(worldMatrix(this.doc, target.id)), world);
    return { frame: target, index: insertionIndex(this.doc, target, local, exclude), exclude };
  }

  private dropIntoFrame(ids: string[], world: Vec): void {
    const drop = this.autoLayoutDrop(ids, world);
    if (drop) {
      const { frame, index } = drop;
      this.editor.change((doc) => {
        const moving = ids.filter((id) => doc.nodes[id].parentId !== frame.id || !doc.nodes[id].layoutAbsolute);
        const others = frame.children.filter((c) => !moving.includes(c));
        for (const id of moving) {
          if (doc.nodes[id].parentId !== frame.id) reparentKeepWorld(doc, id, frame.id);
          doc.nodes[id].layoutAbsolute = false;
        }
        frame.children = [...others.slice(0, index), ...moving, ...others.slice(index)];
      });
      return;
    }
    const exclude = new Set(ids.flatMap((id) => [id, ...descendants(this.doc, id)]));
    const target = frameAt(this.doc, this.editor.pageId, world, exclude);
    const targetNode = this.doc.nodes[target];
    if (targetNode.type === 'group') return;
    this.editor.change((doc) => {
      for (const id of ids) {
        const parent = getParent(doc, id);
        if (!parent || parent.id === target || parent.type === 'group') continue;
        reparentKeepWorld(doc, id, target);
      }
    });
  }

  // ------------------------------------------------------------- resize

  private startResize(handle: Handle): void {
    const frame = selectionFrame(this.editor)!;
    const ids = topLevelSelection(this.doc, this.editor.selection);
    const originals = new Map<string, SceneNode>();
    const centers = new Map<string, { center: Vec; rotation: number }>();
    for (const id of ids) {
      for (const d of [id, ...descendants(this.doc, id)]) originals.set(d, structuredClone(this.doc.nodes[d]));
      centers.set(id, { center: worldCenter(this.doc, id), rotation: worldRotation(this.doc, id) });
    }
    this.editor.begin();
    this.drag = { kind: 'resize', handle, frame, ids, originals, centers };
  }

  private updateResize(drag: Extract<Drag, { kind: 'resize' }>, world: Vec, shift: boolean, alt: boolean): void {
    const { frame, handle } = drag;
    const w0 = frame.width;
    const h0 = frame.height;
    const p = apply(invert(frame.matrix), world);
    const hx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
    const hy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
    const ax = alt || hx === 0 ? w0 / 2 : hx === -1 ? w0 : 0;
    const ay = alt || hy === 0 ? h0 / 2 : hy === -1 ? h0 : 0;
    let sw = hx ? (p.x - ax) * hx * (alt ? 2 : 1) : w0;
    let sh = hy ? (p.y - ay) * hy * (alt ? 2 : 1) : h0;
    if (shift && w0 > 0 && h0 > 0) {
      if (hx && hy) {
        const s = Math.max(Math.abs(sw) / w0, Math.abs(sh) / h0);
        sw = Math.sign(sw || 1) * s * w0;
        sh = Math.sign(sh || 1) * s * h0;
      } else if (hx) {
        sh = (Math.abs(sw) / w0) * h0;
      } else {
        sw = (Math.abs(sh) / h0) * w0;
      }
    }
    const edges = (a: number, h: number, s: number, centered: boolean) => (centered ? [a - s / 2, a + s / 2] : [a, a + h * s]);
    let [l, r] = edges(ax, hx, sw, alt || hx === 0);
    let [t, b] = edges(ay, hy, sh, alt || hy === 0);
    const flipX = l > r;
    const flipY = t > b;
    if (flipX) [l, r] = [r, l];
    if (flipY) [t, b] = [b, t];
    if (Math.abs(frame.matrix[1]) < 1e-9 && frame.matrix[0] > 0) {
      // Axis-aligned: keep edges on whole pixels.
      const ox = frame.matrix[4];
      const oy = frame.matrix[5];
      l = Math.round(l + ox) - ox;
      r = Math.round(r + ox) - ox;
      t = Math.round(t + oy) - oy;
      b = Math.round(b + oy) - oy;
    }
    const W = Math.max(r - l, 0.01);
    const H = Math.max(b - t, 0.01);
    const sx = w0 ? W / w0 : 1;
    const sy = h0 ? H / h0 : 1;

    this.editor.change((doc) => {
      for (const [id, orig] of drag.originals) {
        Object.assign(doc.nodes[id], {
          x: orig.x,
          y: orig.y,
          width: orig.width,
          height: orig.height,
          rotation: orig.rotation,
          fontSize: orig.fontSize,
          autoWidth: orig.autoWidth,
          autoHeight: orig.autoHeight,
          points: orig.points,
        });
      }
      for (const id of drag.ids) {
        const node = doc.nodes[id];
        const orig = drag.originals.get(id)!;
        const c0 = drag.centers.get(id)!;
        let center: Vec;
        if (frame.single) {
          node.width = W;
          node.height = H;
          if (node.type === 'text') this.resizeText(node, orig, hx !== 0, hy !== 0);
          center = apply(frame.matrix, { x: l + node.width / 2, y: t + node.height / 2 });
        } else {
          const q = apply(invert(frame.matrix), c0.center);
          const nx = flipX ? w0 - q.x : q.x;
          const ny = flipY ? h0 - q.y : q.y;
          center = apply(frame.matrix, { x: l + nx * sx, y: t + ny * sy });
          node.width = orig.width * sx;
          node.height = orig.height * sy;
        }
        if ((flipX || flipY) && node.type === 'vector') {
          node.points = orig.points.map((pt) => ({ x: flipX ? 1 - pt.x : pt.x, y: flipY ? 1 - pt.y : pt.y }));
        }
        if (node.type === 'group') scaleChildren(doc, id, node.width / (orig.width || 1), node.height / (orig.height || 1));
        if (node.type === 'text') this.resizeText(node, orig, sx !== 1, sy !== 1);
        placeNode(doc, id, center, c0.rotation);
        if (hx) node.sizingH = 'fixed';
        if (hy) node.sizingV = 'fixed';
        const touched = [...(hx ? ['width', 'sizingH'] : []), ...(hy ? ['height', 'sizingV'] : [])];
        if (touched.some((k) => k in node.bindings)) {
          node.bindings = Object.fromEntries(Object.entries(node.bindings).filter(([k]) => !touched.includes(k)));
        }
        markOverrides(node, touched);
      }
    });
  }

  /**
   * Horizontal resizing makes text wrap with an auto height; vertical
   * resizing fixes the box size.
   */
  private resizeText(node: SceneNode, orig: SceneNode, horizontal: boolean, vertical: boolean): void {
    if (!horizontal && !vertical) return;
    node.autoWidth = false;
    node.autoHeight = vertical ? false : orig.autoWidth || orig.autoHeight;
    this.editor.syncTextSize(node);
  }

  // ------------------------------------------------------------- rotate

  private startRotate(world: Vec): void {
    const ids = topLevelSelection(this.doc, this.editor.selection);
    const center = ids.length === 1 ? worldCenter(this.doc, ids[0]) : rectCenter(selectionBounds(this.doc, ids)!);
    const origins = new Map(ids.map((id) => [id, { center: worldCenter(this.doc, id), rotation: worldRotation(this.doc, id) }]));
    this.editor.begin();
    this.drag = { kind: 'rotate', center, startAngle: Math.atan2(world.y - center.y, world.x - center.x), ids, origins };
  }

  private updateRotate(drag: Extract<Drag, { kind: 'rotate' }>, world: Vec, shift: boolean): void {
    let delta = rad2deg(Math.atan2(world.y - drag.center.y, world.x - drag.center.x) - drag.startAngle);
    if (shift) {
      if (drag.ids.length === 1) {
        const r0 = drag.origins.get(drag.ids[0])!.rotation;
        delta = Math.round((r0 + delta) / 15) * 15 - r0;
      } else {
        delta = Math.round(delta / 15) * 15;
      }
    }
    this.editor.change((doc) => {
      for (const id of drag.ids) {
        const o = drag.origins.get(id)!;
        placeNode(doc, id, rotateAround(o.center, drag.center, deg2rad(delta)), o.rotation + delta);
      }
    });
  }

  // ------------------------------------------------------------- create

  private updateCreate(drag: Extract<Drag, { kind: 'create' }>, e: PointerInput, world: Vec): void {
    const { editor } = this;
    if (!drag.nodeId) {
      if (dist(e.screen, drag.startScreen) < DRAG_THRESHOLD) return;
      editor.begin();
      const base = { frame: 'Frame', rectangle: 'Rectangle', ellipse: 'Ellipse', vector: 'Line' }[drag.type as string] ?? 'Layer';
      const node = createNode(drag.type, { name: nextName(this.doc, drag.type, base) });
      if (drag.type === 'vector') node.points = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
      editor.change((doc) => insertNode(doc, node, drag.parentId));
      editor.selection = [node.id];
      drag.nodeId = node.id;
    }
    const inv = invert(worldMatrix(this.doc, drag.parentId));
    const a = apply(inv, drag.start);
    let b = apply(inv, world);
    const node = this.doc.nodes[drag.nodeId];
    editor.change(() => {
      if (drag.type === 'vector') {
        if (e.shift) {
          const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
          const len = dist(a, b);
          b = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
        }
        const x = Math.round(Math.min(a.x, b.x));
        const y = Math.round(Math.min(a.y, b.y));
        const w = Math.round(Math.max(a.x, b.x)) - x;
        const h = Math.round(Math.max(a.y, b.y)) - y;
        Object.assign(node, {
          x,
          y,
          width: w,
          height: h,
          points: [a, b].map((p) => ({ x: w ? (Math.round(p.x) - x) / w : 0, y: h ? (Math.round(p.y) - y) / h : 0 })),
        });
        return;
      }
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      if (e.shift) {
        const s = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * s;
        dy = Math.sign(dy || 1) * s;
      }
      let x1 = a.x;
      let y1 = a.y;
      let x2 = a.x + dx;
      let y2 = a.y + dy;
      if (e.alt) {
        x1 = a.x - dx;
        y1 = a.y - dy;
      }
      const x = Math.round(Math.min(x1, x2));
      const y = Math.round(Math.min(y1, y2));
      Object.assign(node, {
        x,
        y,
        width: Math.max(1, Math.round(Math.max(x1, x2)) - x),
        height: Math.max(1, Math.round(Math.max(y1, y2)) - y),
      });
    });
  }

  private finishCreate(drag: Extract<Drag, { kind: 'create' }>, world: Vec): void {
    const { editor } = this;
    if (!drag.nodeId) {
      if (drag.type === 'vector') {
        editor.setTool('select');
        return;
      }
      // A click creates a default-sized shape.
      const local = apply(invert(worldMatrix(this.doc, drag.parentId)), world);
      const base = { frame: 'Frame', rectangle: 'Rectangle', ellipse: 'Ellipse' }[drag.type as string] ?? 'Layer';
      const node = createNode(drag.type, {
        name: nextName(this.doc, drag.type, base),
        x: Math.round(local.x - 50),
        y: Math.round(local.y - 50),
      });
      editor.change((doc) => insertNode(doc, node, drag.parentId));
      drag.nodeId = node.id;
    } else {
      editor.commit();
    }
    editor.selection = [drag.nodeId];
    editor.setTool('select');
  }

  private createText(world: Vec): void {
    const { editor } = this;
    const parentId = frameAt(this.doc, editor.pageId, world, new Set());
    const local = apply(invert(worldMatrix(this.doc, parentId)), world);
    const node = createNode('text', { characters: '', name: 'Text', fills: [solid(this.contrastColor(parentId))] });
    editor.syncTextSize(node);
    node.x = Math.round(local.x);
    node.y = Math.round(local.y - node.height / 2);
    editor.begin();
    insertNode(this.doc, node, parentId);
    editor.tool = 'select';
    editor.startTextEditing(node.id);
  }

  /** Black or white, whichever reads better on the nearest painted container. */
  private contrastColor(containerId: string): string {
    let cur: SceneNode | undefined = this.doc.nodes[containerId];
    while (cur) {
      const fill = [...cur.fills].reverse().find((f) => f.visible && f.type === 'solid');
      if (fill && fill.type === 'solid') {
        const n = parseInt(fill.color.slice(1, 7), 16) || 0;
        const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
        return lum > 140 ? '#000000' : '#FFFFFF';
      }
      cur = cur.parentId ? this.doc.nodes[cur.parentId] : undefined;
    }
    return '#000000';
  }

  // ------------------------------------------------------------- pen

  private constrainPen(world: Vec, shift: boolean): Vec {
    const pts = this.editor.overlay.pen?.points ?? [];
    const last = pts[pts.length - 1];
    if (!shift || !last) return world;
    const ang = Math.round(Math.atan2(world.y - last.y, world.x - last.x) / (Math.PI / 4)) * (Math.PI / 4);
    const len = dist(last, world);
    return { x: last.x + Math.cos(ang) * len, y: last.y + Math.sin(ang) * len };
  }

  private penClick(e: PointerInput, world: Vec): void {
    const { editor } = this;
    const pen = editor.overlay.pen ?? (editor.overlay.pen = { points: [], cursor: null });
    const first = pen.points[0];
    if (first && pen.points.length >= 3 && dist(editor.worldToScreen(first), e.screen) <= 8) {
      editor.finishPen(true);
      return;
    }
    const p = this.constrainPen(world, e.shift);
    const last = pen.points[pen.points.length - 1];
    if (!last || dist(editor.worldToScreen(last), editor.worldToScreen(p)) > 2) {
      pen.points.push({ x: Math.round(p.x), y: Math.round(p.y) });
    }
    editor.emit();
  }
}
