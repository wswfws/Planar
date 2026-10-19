import { localMatrix, parentWorldMatrix, selectionBounds, vectorPoints } from './geometry';
import { clean, type Mat, type Rect } from './math';
import { drawNode } from './render';
import { layoutLines, lineHeightPx } from './text';
import type { PlanarDocument, SceneNode } from './types';

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

function nodeToSvg(doc: PlanarDocument, id: string): string {
  const node = doc.nodes[id];
  if (!node || !node.visible) return '';
  const parts: string[] = [];
  const opacity = node.opacity < 1 ? ` opacity="${clean(node.opacity, 3)}"` : '';
  parts.push(`<g${matrixAttr(localMatrix(node))}${opacity}>`);

  if (node.type === 'text') {
    const lh = lineHeightPx(node);
    const anchor = node.textAlign === 'center' ? 'middle' : node.textAlign === 'right' ? 'end' : 'start';
    const x = node.textAlign === 'center' ? node.width / 2 : node.textAlign === 'right' ? node.width : 0;
    const lines = layoutLines(node, node.autoWidth ? null : node.width);
    for (const f of node.fills) {
      if (!f.visible || f.type !== 'solid') continue;
      parts.push(
        `<text font-family="${esc(node.fontFamily)}" font-size="${node.fontSize}" font-weight="${node.fontWeight}" text-anchor="${anchor}" dominant-baseline="central" fill="${f.color}"${f.opacity < 1 ? ` fill-opacity="${f.opacity}"` : ''}>` +
          lines.map((l, i) => `<tspan x="${clean(x)}" y="${clean(i * lh + lh / 2)}">${esc(l)}</tspan>`).join('') +
          `</text>`,
      );
    }
  } else if (node.type !== 'group') {
    const fillable = node.type !== 'vector' || node.closed;
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
    if (node.type === 'frame' && node.clipContent) {
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

function exportBounds(doc: PlanarDocument, ids: string[]): Rect | null {
  const b = selectionBounds(doc, ids);
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
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${b.width}" height="${b.height}" viewBox="${b.x} ${b.y} ${b.width} ${b.height}" fill="none">` +
    body +
    `</svg>`
  );
}

export function exportPng(doc: PlanarDocument, ids: string[], scale: number): Promise<Blob | null> {
  const b = exportBounds(doc, ids);
  if (!b) return Promise.resolve(null);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(b.width * scale);
  canvas.height = Math.round(b.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.scale(scale, scale);
  ctx.translate(-b.x, -b.y);
  for (const id of ids) {
    ctx.save();
    ctx.transform(...parentWorldMatrix(doc, id));
    drawNode(ctx, doc, id);
    ctx.restore();
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
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
