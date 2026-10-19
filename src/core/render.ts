import { localMatrix, vectorPoints } from './geometry';
import { fontString, layoutLines, lineHeightPx } from './text';
import { isFrameLike, type ImagePaint, type Paint, type PlanarDocument, type SceneNode } from './types';

const images = new Map<string, HTMLImageElement>();
let onImageLoad: (() => void) | null = null;

export function setImageLoadListener(fn: (() => void) | null): void {
  onImageLoad = fn;
}

function getImage(src: string): HTMLImageElement | null {
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

function shapePath(ctx: CanvasRenderingContext2D, node: SceneNode): void {
  const { width: w, height: h } = node;
  ctx.beginPath();
  switch (node.type) {
    case 'ellipse':
      ctx.ellipse(w / 2, h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
      break;
    case 'vector': {
      const pts = vectorPoints(node);
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (node.closed) ctx.closePath();
      break;
    }
    default: {
      const r = Math.max(0, Math.min(node.cornerRadius, Math.abs(w) / 2, Math.abs(h) / 2));
      if (r > 0) ctx.roundRect(0, 0, w, h, r);
      else ctx.rect(0, 0, w, h);
    }
  }
}

function drawImagePaint(ctx: CanvasRenderingContext2D, node: SceneNode, paint: ImagePaint): void {
  const img = getImage(paint.src);
  if (!img) return;
  const { width: w, height: h } = node;
  const scale =
    paint.scaleMode === 'fit'
      ? Math.min(w / img.naturalWidth, h / img.naturalHeight)
      : Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const iw = img.naturalWidth * scale;
  const ih = img.naturalHeight * scale;
  ctx.save();
  ctx.clip();
  ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, node: SceneNode, paint: Paint): void {
  if (paint.type !== 'solid') return;
  ctx.fillStyle = hexToRgba(paint.color, paint.opacity);
  ctx.font = fontString(node);
  ctx.textBaseline = 'middle';
  ctx.textAlign = node.textAlign;
  const lh = lineHeightPx(node);
  const x = node.textAlign === 'center' ? node.width / 2 : node.textAlign === 'right' ? node.width : 0;
  layoutLines(node, node.autoWidth ? null : node.width).forEach((line, i) => {
    ctx.fillText(line, x, i * lh + lh / 2);
  });
}

function paintNode(ctx: CanvasRenderingContext2D, node: SceneNode): void {
  if (node.type === 'text') {
    for (const f of node.fills) if (f.visible) drawText(ctx, node, f);
    return;
  }
  if (node.type === 'group' || node.type === 'page') return;
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
}

export function drawNode(ctx: CanvasRenderingContext2D, doc: PlanarDocument, id: string, opts: RenderOptions = {}): void {
  const node = doc.nodes[id];
  if (!node || !node.visible) return;
  ctx.save();
  ctx.transform(...localMatrix(node));
  ctx.globalAlpha *= node.opacity;
  if (!opts.hidden?.has(id)) paintNode(ctx, node);
  if (node.children.length) {
    ctx.save();
    if (isFrameLike(node) && node.clipContent) {
      shapePath(ctx, node);
      ctx.clip();
    }
    for (const c of node.children) drawNode(ctx, doc, c, opts);
    ctx.restore();
  }
  if (!opts.hidden?.has(id)) strokeNode(ctx, node);
  ctx.restore();
}

export function drawPage(ctx: CanvasRenderingContext2D, doc: PlanarDocument, pageId: string, opts: RenderOptions = {}): void {
  for (const c of doc.nodes[pageId]?.children ?? []) drawNode(ctx, doc, c, opts);
}
