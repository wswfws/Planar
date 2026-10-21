// Server-side rendering for agent screenshots, using @napi-rs/canvas when it
// is installed (it is an optional dependency).

import { parentWorldMatrix, selectionBounds } from '../core/geometry';
import { drawNode, setImageProvider } from '../core/render';
import { setMeasureContext } from '../core/text';
import type { PlanarDocument } from '../core/types';

type CanvasModule = typeof import('@napi-rs/canvas');

let canvasModule: CanvasModule | null | undefined;

/** Loads the canvas module once and uses it for text measurement too. */
export async function initCanvas(): Promise<CanvasModule | null> {
  if (canvasModule !== undefined) return canvasModule;
  try {
    canvasModule = await import('@napi-rs/canvas');
    // The renderer builds vector paths with Path2D, which Node lacks.
    const g = globalThis as unknown as { Path2D?: unknown };
    if (typeof g.Path2D === 'undefined') g.Path2D = canvasModule.Path2D;
    // Generic CSS families mean nothing to the native renderer; map them to
    // fonts that exist on this machine so text looks like it does in browsers.
    const { GlobalFonts } = canvasModule;
    const pick = (names: string[]) => names.find((n) => GlobalFonts.has(n));
    const sans = pick(['Segoe UI', 'Helvetica Neue', 'Helvetica', 'Inter', 'Roboto', 'Noto Sans', 'DejaVu Sans', 'Liberation Sans', 'Arial']);
    const serif = pick(['Georgia', 'Times New Roman', 'Noto Serif', 'DejaVu Serif', 'Liberation Serif']);
    const mono = pick(['Cascadia Code', 'Consolas', 'Menlo', 'SF Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New']);
    for (const [generic, real] of [
      ['system-ui', sans],
      ['sans-serif', sans],
      ['ui-sans-serif', sans],
      ['serif', serif],
      ['monospace', mono],
      ['ui-monospace', mono],
    ] as const) {
      if (real && !GlobalFonts.has(generic)) GlobalFonts.setAlias(real, generic);
    }
    const ctx = canvasModule.createCanvas(8, 8).getContext('2d');
    setMeasureContext(ctx as unknown as CanvasRenderingContext2D);
  } catch {
    canvasModule = null;
  }
  return canvasModule;
}

export function canRender(): boolean {
  return !!canvasModule;
}

/** PNG of the given layers (whole page when `ids` is empty). */
export async function renderPng(doc: PlanarDocument, ids: string[], opts: { scale?: number; maxSize?: number; background?: string } = {}): Promise<Buffer> {
  const mod = await initCanvas();
  if (!mod) throw new Error('Screenshots need the optional @napi-rs/canvas package (npm install @napi-rs/canvas).');
  const b = selectionBounds(doc, ids);
  if (!b || b.width <= 0 || b.height <= 0) throw new Error('Nothing visible to render');
  const pad = 0;
  const maxSize = opts.maxSize ?? 1600;
  let scale = opts.scale ?? 1;
  scale = Math.min(scale, maxSize / Math.max(b.width, b.height));
  const w = Math.max(1, Math.round(b.width * scale) + pad * 2);
  const h = Math.max(1, Math.round(b.height * scale) + pad * 2);

  // Decode embedded images up front; the renderer asks for them by src.
  const decoded = new Map<string, unknown>();
  for (const n of Object.values(doc.nodes)) {
    for (const p of n.fills) {
      if (p.type === 'image' && !decoded.has(p.src)) {
        try {
          decoded.set(p.src, await mod.loadImage(p.src));
        } catch {
          decoded.set(p.src, null);
        }
      }
    }
  }
  setImageProvider((src) => (decoded.get(src) as CanvasImageSource) ?? null);

  const canvas = mod.createCanvas(w, h);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.translate(pad, pad);
  ctx.scale(scale, scale);
  ctx.translate(-b.x, -b.y);
  try {
    for (const id of ids) {
      ctx.save();
      ctx.transform(...parentWorldMatrix(doc, id));
      drawNode(ctx, doc, id);
      ctx.restore();
    }
  } finally {
    setImageProvider(null);
  }
  return canvas.toBuffer('image/png');
}
