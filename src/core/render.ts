import { drawNote } from './noteRender';
import { localMatrix, vectorPoints } from './geometry';
import { nodePaths } from './paths';
import { baselineInLine, fontString, lineHeightPx, nodeLines, verticalOffset } from './text';
import { isFrameLike, type Effect, type ImagePaint, type Paint, type PlanarDocument, type SceneNode, paintOrder } from './types';

const images = new Map<string, HTMLImageElement>();
let onImageLoad: (() => void) | null = null;

export function setImageLoadListener(fn: (() => void) | null): void {
  onImageLoad = fn;
}

let imageProvider: ((src: string) => CanvasImageSource | null) | null = null;

/** Lets non-browser hosts supply decoded images (e.g. for agent screenshots). */
export function setImageProvider(fn: ((src: string) => CanvasImageSource | null) | null): void {
  imageProvider = fn;
}

function getImage(src: string): CanvasImageSource | null {
  if (imageProvider) return imageProvider(src);
  if (typeof Image === 'undefined') return null;
  let img = images.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => onImageLoad?.();
    img.src = src;
    images.set(src, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16) || 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The layer outline; spread grows (or, negative, shrinks) rectangles and ellipses. */
function shapePath(ctx: CanvasRenderingContext2D, node: SceneNode, spread = 0, begin = true): void {
  const { width: w, height: h } = node;
  if (begin) ctx.beginPath();
  switch (node.type) {
    case 'ellipse':
      ctx.ellipse(w / 2, h / 2, Math.max(0, Math.abs(w / 2) + spread), Math.max(0, Math.abs(h / 2) + spread), 0, 0, Math.PI * 2);
      break;
    case 'vector': {
      const pts = vectorPoints(node);
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (node.closed) ctx.closePath();
      break;
    }
    default: {
      const r = Math.max(0, Math.min(node.cornerRadius, Math.abs(w) / 2, Math.abs(h) / 2));
      const s = Math.max(spread, -Math.min(Math.abs(w), Math.abs(h)) / 2);
      if (r > 0) ctx.roundRect(-s, -s, w + 2 * s, h + 2 * s, Math.max(0, r + s));
      else ctx.rect(-s, -s, w + 2 * s, h + 2 * s);
    }
  }
}

const canFilter = (ctx: CanvasRenderingContext2D) => 'filter' in ctx;

/** Parsed vector paths, kept while the layer's paths and size stay the same. */
const pathCache = new WeakMap<object, { w: number; h: number; bw: number; bh: number; list: { path: Path2D; fillRule: CanvasFillRule }[] }>();

function vectorPaths(node: SceneNode): { path: Path2D; fillRule: CanvasFillRule }[] {
  const c = pathCache.get(node.paths);
  if (c && c.w === node.width && c.h === node.height && c.bw === node.pathBox.w && c.bh === node.pathBox.h) return c.list;
  const list = nodePaths(node).map((p) => ({ path: new Path2D(p.d), fillRule: p.fillRule }));
  pathCache.set(node.paths, { w: node.width, h: node.height, bw: node.pathBox.w, bh: node.pathBox.h, list });
  return list;
}

/** How many device pixels one layer unit covers under the current transform. */
function deviceScale(m: DOMMatrix): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
}

/**
 * Paints what casts a shadow in solid black: the filled shape, the text, the
 * vector paths and the strokes; a container without a fill uses its children.
 */
function fillSilhouette(ctx: CanvasRenderingContext2D, doc: PlanarDocument, node: SceneNode, spread: number): void {
  if (!node.visible) return;
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';
  if (node.type === 'text') {
    drawText(ctx, node, { type: 'solid', color: '#000000', opacity: 1, visible: true });
    return;
  }
  const stroked = node.strokeWidth > 0 && node.strokes.some((s) => s.visible);
  if (node.type === 'vector' && node.paths.length) {
    if (typeof Path2D === 'undefined') return;
    for (const { path, fillRule } of vectorPaths(node)) {
      if (node.fills.some((f) => f.visible)) ctx.fill(path, fillRule);
      if (stroked) {
        ctx.lineWidth = node.strokeWidth;
        ctx.stroke(path);
      }
    }
    return;
  }
  const filled = node.fills.some((f) => f.visible) && (node.type !== 'vector' || node.closed) && node.type !== 'group';
  if (filled) {
    shapePath(ctx, node, spread);
    ctx.fill();
  } else {
    for (const c of node.children) {
      const child = doc.nodes[c];
      if (!child) continue;
      ctx.save();
      ctx.transform(...localMatrix(child));
      fillSilhouette(ctx, doc, child, 0);
      ctx.restore();
    }
  }
  if (stroked && node.type !== 'group') {
    shapePath(ctx, node);
    ctx.lineWidth = node.strokeWidth;
    ctx.stroke();
  }
}

// Shapes are drawn this far to the left and only their shadow is shifted back into view.
const FAR = 100000;

function setShadow(ctx: CanvasRenderingContext2D, m: DOMMatrix, e: Effect): void {
  ctx.shadowColor = hexToRgba(e.color, e.opacity);
  ctx.shadowBlur = e.radius * deviceScale(m);
  ctx.shadowOffsetX = FAR + m.a * e.x + m.c * e.y;
  ctx.shadowOffsetY = m.b * e.x + m.d * e.y;
}

function dropShadow(ctx: CanvasRenderingContext2D, doc: PlanarDocument, node: SceneNode, e: Effect): void {
  const m = ctx.getTransform();
  ctx.save();
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e - FAR, m.f);
  setShadow(ctx, m, e);
  fillSilhouette(ctx, doc, node, e.spread);
  ctx.restore();
}

function innerShadow(ctx: CanvasRenderingContext2D, node: SceneNode, e: Effect): void {
  if (node.type === 'text' || node.type === 'group' || (node.type === 'vector' && !node.closed && !node.paths.length)) return;
  const pad = e.radius * 3 + Math.abs(e.x) + Math.abs(e.y) + Math.abs(e.spread) + 10;
  const m = ctx.getTransform();
  ctx.save();
  let hole: Path2D | null = null;
  if (node.type === 'vector' && node.paths.length) {
    if (typeof Path2D === 'undefined') return ctx.restore();
    hole = new Path2D();
    for (const p of vectorPaths(node)) hole.addPath(p.path);
    ctx.clip(hole);
  } else {
    shapePath(ctx, node);
    ctx.clip();
  }
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e - FAR, m.f);
  setShadow(ctx, m, e);
  ctx.fillStyle = '#000000';
  if (hole) {
    const ring = new Path2D();
    ring.rect(-pad, -pad, node.width + 2 * pad, node.height + 2 * pad);
    ring.addPath(hole);
    ctx.fill(ring, 'evenodd');
  } else {
    ctx.beginPath();
    ctx.rect(-pad, -pad, node.width + 2 * pad, node.height + 2 * pad);
    shapePath(ctx, node, -e.spread, false);
    ctx.fill('evenodd');
  }
  ctx.restore();
}

/** Blurs what is already painted under the layer's shape. */
function backgroundBlur(ctx: CanvasRenderingContext2D, node: SceneNode, e: Effect): void {
  const canvas = ctx.canvas as unknown as CanvasImageSource | undefined;
  if (!canvas || !canFilter(ctx) || e.radius <= 0) return;
  const m = ctx.getTransform();
  ctx.save();
  shapePath(ctx, node);
  ctx.clip();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = `blur(${(e.radius / 2) * deviceScale(m)}px)`;
  try {
    ctx.drawImage(canvas, 0, 0);
  } catch {
    // Some hosts cannot draw a canvas onto itself; the layer then paints without the blur.
  }
  ctx.restore();
}

function drawImagePaint(ctx: CanvasRenderingContext2D, node: SceneNode, paint: ImagePaint): void {
  const img = getImage(paint.src);
  if (!img) return;
  const { width: w, height: h } = node;
  const size = img as unknown as { naturalWidth?: number; naturalHeight?: number; width: number; height: number };
  const nw = size.naturalWidth || size.width;
  const nh = size.naturalHeight || size.height;
  const scale = paint.scaleMode === 'fit' ? Math.min(w / nw, h / nh) : Math.max(w / nw, h / nh);
  const iw = nw * scale;
  const ih = nh * scale;
  ctx.save();
  ctx.clip();
  ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, node: SceneNode, paint: Paint): void {
  if (paint.type !== 'solid') return;
  ctx.fillStyle = hexToRgba(paint.color, paint.opacity);
  ctx.font = fontString(node);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = node.textAlign;
  const lh = lineHeightPx(node);
  if (node.fontSize * deviceScale(ctx.getTransform()) < 3) {
    const lines = Math.max(1, Math.round(node.height / lh));
    ctx.globalAlpha *= 0.35;
    for (let i = 0; i < lines; i++) ctx.fillRect(0, i * lh + lh * 0.25, node.width, lh * 0.5);
    return;
  }
  const top = verticalOffset(node) + baselineInLine(node);
  const x = node.textAlign === 'center' ? node.width / 2 : node.textAlign === 'right' ? node.width : 0;
  nodeLines(node).forEach((line, i) => {
    ctx.fillText(line, x, top + i * lh);
  });
}

function paintNode(ctx: CanvasRenderingContext2D, node: SceneNode): void {
  if (node.type === 'text') {
    for (const f of node.fills) if (f.visible) drawText(ctx, node, f);
    return;
  }
  if (node.type === 'group' || node.type === 'page') return;
  if (node.type === 'vector' && node.paths.length) {
    if (typeof Path2D === 'undefined') return;
    for (const { path, fillRule } of vectorPaths(node)) {
      for (const f of node.fills) {
        if (!f.visible || f.type !== 'solid') continue;
        ctx.fillStyle = hexToRgba(f.color, f.opacity);
        ctx.fill(path, fillRule);
      }
    }
    return;
  }
  shapePath(ctx, node);
  if (node.type !== 'vector' || node.closed) {
    for (const f of node.fills) {
      if (!f.visible) continue;
      if (f.type === 'solid') {
        ctx.fillStyle = hexToRgba(f.color, f.opacity);
        ctx.fill();
      } else {
        ctx.save();
        ctx.globalAlpha *= f.opacity;
        drawImagePaint(ctx, node, f);
        ctx.restore();
      }
    }
  }
}

function strokeNode(ctx: CanvasRenderingContext2D, node: SceneNode): void {
  if (node.type === 'group' || node.type === 'page' || node.strokeWidth <= 0) return;
  const strokes = node.strokes.filter((s) => s.visible && s.type === 'solid');
  if (!strokes.length) return;
  ctx.lineWidth = node.strokeWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (node.type === 'vector' && node.paths.length) {
    if (typeof Path2D === 'undefined') return;
    for (const { path } of vectorPaths(node)) {
      for (const s of strokes) {
        if (s.type !== 'solid') continue;
        ctx.strokeStyle = hexToRgba(s.color, s.opacity);
        ctx.stroke(path);
      }
    }
    return;
  }
  if (node.type === 'text') {
    // Text strokes are drawn as an outline around the text box.
    ctx.beginPath();
    ctx.rect(0, 0, node.width, node.height);
  } else {
    shapePath(ctx, node);
  }
  for (const s of strokes) {
    if (s.type !== 'solid') continue;
    ctx.strokeStyle = hexToRgba(s.color, s.opacity);
    ctx.stroke();
  }
}

export interface RenderOptions {
  /** Node ids that should not be painted (e.g. text being edited). */
  hidden?: ReadonlySet<string>;
  /** Paint annotation layers (notes, chats…); off for exports. Default true. */
  annotations?: boolean;
}

export function drawNode(ctx: CanvasRenderingContext2D, doc: PlanarDocument, id: string, opts: RenderOptions = {}): void {
  const node = doc.nodes[id];
  if (!node || !node.visible) return;
  if (node.type === 'note') {
    if (opts.annotations === false) return;
    ctx.save();
    ctx.transform(...localMatrix(node));
    ctx.globalAlpha *= node.opacity;
    drawNote(ctx, doc, node);
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.transform(...localMatrix(node));
  ctx.globalAlpha *= node.opacity;
  // Skip what is off screen or smaller than a pixel. Children of a frame that
  // does not clip may stick out, so only its own painting is skipped then.
  const out = !visibleOnCanvas(ctx, node);
  if (out && (!node.children.length || node.type === 'group' || (isFrameLike(node) && node.clipContent))) {
    ctx.restore();
    return;
  }
  if (out) {
    for (const c of paintOrder(node)) drawNode(ctx, doc, c, opts);
    ctx.restore();
    return;
  }
  const effects = opts.hidden?.has(id) ? [] : (node.effects ?? []).filter((e) => e.visible);
  if (effects.length) {
    const blur = effects.find((e) => e.type === 'layer-blur');
    if (blur && blur.radius > 0 && canFilter(ctx)) ctx.filter = `blur(${(blur.radius / 2) * deviceScale(ctx.getTransform())}px)`;
    for (const e of effects) {
      if (e.type === 'drop-shadow') dropShadow(ctx, doc, node, e);
      else if (e.type === 'background-blur') backgroundBlur(ctx, node, e);
    }
  }
  if (!opts.hidden?.has(id)) paintNode(ctx, node);
  for (const e of effects) if (e.type === 'inner-shadow') innerShadow(ctx, node, e);
  if (node.children.length) {
    ctx.save();
    if (isFrameLike(node) && node.clipContent) {
      shapePath(ctx, node);
      ctx.clip();
    }
    for (const c of paintOrder(node)) drawNode(ctx, doc, c, opts);
    ctx.restore();
  }
  if (!opts.hidden?.has(id)) strokeNode(ctx, node);
  ctx.restore();
}

/** Whether a layer (in the current transform) covers any of the canvas and at least half a pixel. */
function visibleOnCanvas(ctx: CanvasRenderingContext2D, node: SceneNode): boolean {
  if (typeof ctx.getTransform !== 'function' || !ctx.canvas) return true;
  const m = ctx.getTransform();
  let reach = node.strokeWidth;
  for (const e of node.effects ?? []) if (e.visible) reach += Math.abs(e.x) + Math.abs(e.y) + e.radius + Math.max(0, e.spread);
  const x0 = -reach;
  const y0 = -reach;
  const x1 = node.width + reach;
  const y1 = node.height + reach;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]) {
    const px = m.a * x + m.c * y + m.e;
    const py = m.b * x + m.d * y + m.f;
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  if (maxX < 0 || maxY < 0 || minX > ctx.canvas.width || minY > ctx.canvas.height) return false;
  return maxX - minX >= 0.5 || maxY - minY >= 0.5;
}

export function drawPage(ctx: CanvasRenderingContext2D, doc: PlanarDocument, pageId: string, opts: RenderOptions = {}): void {
  for (const c of doc.nodes[pageId]?.children ?? []) drawNode(ctx, doc, c, opts);
}
