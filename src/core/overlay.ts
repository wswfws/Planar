import type { Editor } from './editor';
import { vectorPoints, worldMatrix } from './geometry';
import { frameLabelRect, HANDLES, selectionFrame } from './interaction';
import { apply, clean } from './math';
import type { SceneNode } from './types';

export const ACCENT = '#7b7bf0';
const GUIDE = '#ff4f8b';

/** Traces a node's outline in world space under the current transform. */
function traceOutline(ctx: CanvasRenderingContext2D, node: SceneNode): void {
  ctx.beginPath();
  if (node.type === 'ellipse') {
    ctx.ellipse(node.width / 2, node.height / 2, Math.abs(node.width / 2), Math.abs(node.height / 2), 0, 0, Math.PI * 2);
  } else if (node.type === 'vector') {
    vectorPoints(node).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (node.closed) ctx.closePath();
  } else {
    ctx.rect(0, 0, node.width, node.height);
  }
}

/**
 * Draws editor chrome in screen space. Expects the context to be scaled by
 * devicePixelRatio only.
 */
export function drawOverlay(ctx: CanvasRenderingContext2D, editor: Editor, dpr: number): void {
  const { doc, viewport } = editor;
  const z = viewport.zoom;
  const toScreenMatrix = (id: string) => {
    const m = worldMatrix(doc, id);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * viewport.x, dpr * viewport.y);
    ctx.transform(...m);
  };
  const resetTransform = () => ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Frame labels for top-level frames.
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const id of editor.page.children) {
    const n = doc.nodes[id];
    if (n.type !== 'frame' || !n.visible) continue;
    const r = frameLabelRect(editor, n);
    const selected = editor.selection.includes(id);
    ctx.fillStyle = selected ? ACCENT : editor.hoverId === id ? '#c9c9d6' : '#8d8d9c';
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip();
    ctx.fillText(n.name, r.x, r.y + r.height / 2);
    ctx.restore();
  }

  // Hover outline.
  const hover = editor.hoverId ? doc.nodes[editor.hoverId] : null;
  if (hover && !editor.selection.includes(hover.id) && !editor.editingTextId) {
    toScreenMatrix(hover.id);
    traceOutline(ctx, hover);
    resetTransform();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Outline of each selected node.
  for (const id of editor.selection) {
    const n = doc.nodes[id];
    if (!n) continue;
    toScreenMatrix(id);
    traceOutline(ctx, n);
    resetTransform();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Bounding box, handles and size label.
  const frame = selectionFrame(editor);
  if (frame && !editor.editingTextId) {
    const corners = [
      { x: 0, y: 0 },
      { x: frame.width, y: 0 },
      { x: frame.width, y: frame.height },
      { x: 0, y: frame.height },
    ].map((p) => editor.worldToScreen(apply(frame.matrix, p)));
    ctx.beginPath();
    corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.stroke();

    const locked = frame.single ? doc.nodes[frame.single]?.locked : false;
    const tiny = frame.width * z < 24 || frame.height * z < 24;
    if (!locked) {
      for (const { handle, u, v } of HANDLES) {
        if (tiny && handle.length === 1) continue;
        const p = editor.worldToScreen(apply(frame.matrix, { x: u * frame.width, y: v * frame.height }));
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
        ctx.fill();
        ctx.stroke();
      }
    }

    const label = `${clean(frame.width)} × ${clean(frame.height)}`;
    const bottom = corners.reduce((a, b) => (b.y > a.y ? b : a));
    const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
    ctx.font = '11px system-ui, sans-serif';
    const tw = ctx.measureText(label).width + 10;
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.roundRect(cx - tw / 2, bottom.y + 8, tw, 18, 3);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, bottom.y + 17);
    ctx.textAlign = 'left';
  }

  // Snap guides.
  ctx.strokeStyle = GUIDE;
  ctx.lineWidth = 1;
  for (const g of editor.overlay.guides) {
    ctx.beginPath();
    if (g.axis === 'x') {
      const x = Math.round(g.value * z + viewport.x) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, editor.canvasSize.height);
    } else {
      const y = Math.round(g.value * z + viewport.y) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(editor.canvasSize.width, y);
    }
    ctx.stroke();
  }

  // Marquee.
  const m = editor.overlay.marquee;
  if (m) {
    const a = editor.worldToScreen({ x: m.x, y: m.y });
    ctx.fillStyle = 'rgba(123, 123, 240, 0.12)';
    ctx.strokeStyle = ACCENT;
    ctx.fillRect(a.x, a.y, m.width * z, m.height * z);
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, m.width * z, m.height * z);
  }

  // Pen draft.
  const pen = editor.overlay.pen;
  if (pen && pen.points.length) {
    const pts = pen.points.map((p) => editor.worldToScreen(p));
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (pen.cursor) {
      const c = editor.worldToScreen(pen.cursor);
      ctx.lineTo(c.x, c.y);
    }
    ctx.stroke();
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, i === 0 ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.stroke();
    });
  }
}
