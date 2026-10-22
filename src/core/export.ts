import { effectOutset } from './effects';
import { localMatrix, parentWorldMatrix, vectorPoints, worldBounds } from './geometry';
import { fontImports } from './fonts';
import { clean, rectUnion, type Mat, type Rect } from './math';
import { nodePaths } from './paths';
import { drawNode } from './render';
import { pdfFromJpegs } from './pdf';
import { uniqueNames, zipFiles } from './zip';
import { baselineInLine, lineHeightPx, nodeLines, verticalOffset } from './text';
import { isFrameLike, type PlanarDocument, type SceneNode } from './types';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function matrixAttr(m: Mat): string {
  if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1) {
    return m[4] || m[5] ? ` transform="translate(${clean(m[4])} ${clean(m[5])})"` : '';
  }
  return ` transform="matrix(${m.map((v) => clean(v, 6)).join(' ')})"`;
}

function shapeElement(node: SceneNode, paintAttrs: string): string {
  const w = clean(node.width);
  const h = clean(node.height);
  switch (node.type) {
    case 'ellipse':
      return `<ellipse cx="${clean(w / 2)}" cy="${clean(h / 2)}" rx="${clean(w / 2)}" ry="${clean(h / 2)}"${paintAttrs}/>`;
    case 'vector': {
      if (node.paths.length) {
        return nodePaths(node)
          .map((p) => `<path d="${p.d}"${p.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${paintAttrs}/>`)
          .join('');
      }
      const d = vectorPoints(node)
        .map((p, i) => `${i ? 'L' : 'M'}${clean(p.x)} ${clean(p.y)}`)
        .join(' ');
      return `<path d="${d}${node.closed ? ' Z' : ''}"${paintAttrs}/>`;
    }
    default: {
      const r = Math.min(node.cornerRadius, w / 2, h / 2);
      return `<rect width="${w}" height="${h}"${r > 0 ? ` rx="${clean(r)}"` : ''}${paintAttrs}/>`;
    }
  }
}

let clipCounter = 0;

/**
 * An SVG filter for the layer's shadows and layer blur (background blur has no
 * SVG equivalent and is left out). The layer and its contents cast the shadows.
 */
function svgFilter(node: SceneNode, id: string): string | null {
  const effects = (node.effects ?? []).filter((e) => e.visible && e.type !== 'background-blur');
  if (!effects.length) return null;
  const o = effectOutset(node);
  const pad = 2;
  const prims: string[] = [];
  const under: string[] = [];
  const over: string[] = [];
  effects.forEach((e, i) => {
    const sd = clean(e.radius / 2, 3);
    const flood = `<feFlood flood-color="${e.color}"${e.opacity < 1 ? ` flood-opacity="${clean(e.opacity, 3)}"` : ''}/>`;
    if (e.type === 'drop-shadow') {
      const src = e.spread > 0 ? `<feMorphology in="SourceAlpha" operator="dilate" radius="${clean(e.spread)}" result="m${i}"/>` : e.spread < 0 ? `<feMorphology in="SourceAlpha" operator="erode" radius="${clean(-e.spread)}" result="m${i}"/>` : '';
      prims.push(
        src,
        `<feOffset in="${src ? `m${i}` : 'SourceAlpha'}" dx="${clean(e.x)}" dy="${clean(e.y)}"/>`,
        `<feGaussianBlur stdDeviation="${sd}" result="b${i}"/>`,
        flood,
        `<feComposite in2="b${i}" operator="in" result="s${i}"/>`,
      );
      under.push(`s${i}`);
    } else if (e.type === 'inner-shadow') {
      prims.push(
        `<feComponentTransfer in="SourceAlpha" result="v${i}"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>`,
        `<feOffset in="v${i}" dx="${clean(e.x)}" dy="${clean(e.y)}"/>`,
        `<feGaussianBlur stdDeviation="${sd}"/>`,
        `<feComposite in2="SourceAlpha" operator="in" result="b${i}"/>`,
        flood,
        `<feComposite in2="b${i}" operator="in" result="s${i}"/>`,
      );
      over.push(`s${i}`);
    }
  });
  const nodes = [...under, 'SourceGraphic', ...over].map((r) => `<feMergeNode in="${r}"/>`).join('');
  prims.push(`<feMerge result="all">${nodes}</feMerge>`);
  const blur = effects.find((e) => e.type === 'layer-blur');
  if (blur) prims.push(`<feGaussianBlur in="all" stdDeviation="${clean(blur.radius / 2, 3)}"/>`);
  const x = -o.left - pad;
  const y = -o.top - pad;
  return (
    `<filter id="${id}" filterUnits="userSpaceOnUse" x="${clean(x)}" y="${clean(y)}" width="${clean(node.width + o.left + o.right + 2 * pad)}" height="${clean(node.height + o.top + o.bottom + 2 * pad)}" color-interpolation-filters="sRGB">` +
    prims.join('') +
    `</filter>`
  );
}

function nodeToSvg(doc: PlanarDocument, id: string): string {
  const node = doc.nodes[id];
  if (!node || !node.visible) return '';
  const parts: string[] = [];
  const opacity = node.opacity < 1 ? ` opacity="${clean(node.opacity, 3)}"` : '';
  const fid = `planar-fx-${++clipCounter}`;
  const filter = svgFilter(node, fid);
  if (filter) parts.push(filter);
  parts.push(`<g${matrixAttr(localMatrix(node))}${opacity}${filter ? ` filter="url(#${fid})"` : ''}>`);

  if (node.type === 'text') {
    const lh = lineHeightPx(node);
    const anchor = node.textAlign === 'center' ? 'middle' : node.textAlign === 'right' ? 'end' : 'start';
    const x = node.textAlign === 'center' ? node.width / 2 : node.textAlign === 'right' ? node.width : 0;
    const lines = nodeLines(node);
    const top = verticalOffset(node) + baselineInLine(node);
    for (const f of node.fills) {
      if (!f.visible || f.type !== 'solid') continue;
      parts.push(
        `<text font-family="${esc(node.fontFamily)}" font-size="${node.fontSize}" font-weight="${node.fontWeight}" text-anchor="${anchor}" fill="${f.color}"${f.opacity < 1 ? ` fill-opacity="${f.opacity}"` : ''}>` +
          lines.map((l, i) => `<tspan x="${clean(x)}" y="${clean(top + i * lh)}">${esc(l)}</tspan>`).join('') +
          `</text>`,
      );
    }
  } else if (node.type !== 'group') {
    const fillable = node.type !== 'vector' || node.closed || node.paths.length > 0;
    for (const f of fillable ? node.fills : []) {
      if (!f.visible) continue;
      if (f.type === 'solid') {
        parts.push(shapeElement(node, ` fill="${f.color}"${f.opacity < 1 ? ` fill-opacity="${f.opacity}"` : ''}`));
      } else {
        const cid = `planar-clip-${++clipCounter}`;
        parts.push(`<clipPath id="${cid}">${shapeElement(node, '')}</clipPath>`);
        parts.push(
          `<image href="${esc(f.src)}" width="${clean(node.width)}" height="${clean(node.height)}" preserveAspectRatio="${f.scaleMode === 'fit' ? 'xMidYMid meet' : 'xMidYMid slice'}" clip-path="url(#${cid})"${f.opacity < 1 ? ` opacity="${f.opacity}"` : ''}/>`,
        );
      }
    }
  }

  if (node.children.length) {
    let open = '<g>';
    if (isFrameLike(node) && node.clipContent) {
      const cid = `planar-clip-${++clipCounter}`;
      parts.push(`<clipPath id="${cid}">${shapeElement(node, '')}</clipPath>`);
      open = `<g clip-path="url(#${cid})">`;
    }
    parts.push(open, ...node.children.map((c) => nodeToSvg(doc, c)), '</g>');
  }

  if (node.type !== 'group' && node.type !== 'text' && node.strokeWidth > 0) {
    for (const s of node.strokes) {
      if (!s.visible || s.type !== 'solid') continue;
      parts.push(
        shapeElement(
          node,
          ` fill="none" stroke="${s.color}" stroke-width="${node.strokeWidth}" stroke-linejoin="round" stroke-linecap="round"${s.opacity < 1 ? ` stroke-opacity="${s.opacity}"` : ''}`,
        ),
      );
    }
  }
  parts.push('</g>');
  return parts.join('');
}

/** The area an export covers: the layers plus whatever their shadows and blurs reach. */
export function exportBounds(doc: PlanarDocument, ids: string[]): Rect | null {
  const rects = ids
    .filter((id) => doc.nodes[id])
    .map((id) => {
      const r = worldBounds(doc, id);
      const o = effectOutset(doc.nodes[id]);
      return { x: r.x - o.left, y: r.y - o.top, width: r.width + o.left + o.right, height: r.height + o.top + o.bottom };
    });
  const b = rectUnion(rects);
  if (!b) return null;
  const x = Math.floor(b.x);
  const y = Math.floor(b.y);
  return { x, y, width: Math.max(1, Math.ceil(b.x + b.width) - x), height: Math.max(1, Math.ceil(b.y + b.height) - y) };
}

export function exportSvg(doc: PlanarDocument, ids: string[]): string | null {
  const b = exportBounds(doc, ids);
  if (!b) return null;
  const body = ids
    .map((id) => `<g${matrixAttr(parentWorldMatrix(doc, id))}>${nodeToSvg(doc, id)}</g>`)
    .join('');
  const all: string[] = [];
  const collect = (id: string) => {
    all.push(id);
    doc.nodes[id]?.children.forEach(collect);
  };
  ids.forEach(collect);
  const imports = fontImports(doc, all);
  const style = imports.length ? `<style>${imports.join('')}</style>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${b.width}" height="${b.height}" viewBox="${b.x} ${b.y} ${b.width} ${b.height}" fill="none">` +
    style +
    body +
    `</svg>`
  );
}

export function exportPng(doc: PlanarDocument, ids: string[], scale: number): Promise<Blob | null> {
  return exportRaster(doc, ids, scale, 'image/png');
}

/** PNG (transparent) or JPEG (white background) of the given layers. */
export function exportRaster(doc: PlanarDocument, ids: string[], scale: number, type: 'image/png' | 'image/jpeg'): Promise<Blob | null> {
  const b = exportBounds(doc, ids);
  if (!b) return Promise.resolve(null);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(b.width * scale);
  canvas.height = Math.round(b.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.scale(scale, scale);
  ctx.translate(-b.x, -b.y);
  for (const id of ids) {
    ctx.save();
    ctx.transform(...parentWorldMatrix(doc, id));
    drawNode(ctx, doc, id);
    ctx.restore();
  }
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
}

/**
 * Every layer on its own: a ZIP of PNG or SVG files, or one PDF with a page per layer.
 * Returns null when nothing could be drawn.
 */
export async function exportEach(doc: PlanarDocument, ids: string[], format: 'png' | 'svg' | 'pdf', scale: number, title: string): Promise<{ blob: Blob; filename: string } | null> {
  const bytes = async (blob: Blob | null) => (blob ? new Uint8Array(await blob.arrayBuffer()) : null);
  if (format === 'pdf') {
    const pages = [];
    for (const id of ids) {
      const b = exportBounds(doc, [id]);
      const jpeg = await bytes(await exportRaster(doc, [id], scale, 'image/jpeg'));
      if (b && jpeg) pages.push({ width: b.width, height: b.height, jpeg, pixelWidth: Math.round(b.width * scale), pixelHeight: Math.round(b.height * scale) });
    }
    return pages.length ? { blob: new Blob([pdfFromJpegs(pages, title)], { type: 'application/pdf' }), filename: `${safeFilename(title)}.pdf` } : null;
  }
  const entries: { name: string; data: Uint8Array }[] = [];
  const names = uniqueNames(ids.map((id) => `${safeFilename(doc.nodes[id].name)}${format === 'png' && scale !== 1 ? `@${scale}x` : ''}.${format}`));
  for (const [i, id] of ids.entries()) {
    const data = format === 'svg' ? new TextEncoder().encode(exportSvg(doc, [id]) ?? '') : await bytes(await exportPng(doc, [id], scale));
    if (data?.length) entries.push({ name: names[i], data });
  }
  return entries.length ? { blob: new Blob([zipFiles(entries)], { type: 'application/zip' }), filename: `${safeFilename(title)}.zip` } : null;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'export';
}
