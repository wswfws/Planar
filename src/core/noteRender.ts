// Draws annotation layers (see notes.ts) in their local coordinates.

import { worldBounds, worldMatrix } from './geometry';
import { apply, invert } from './math';
import { markdownBlocks } from './notes';
import type { PlanarDocument, SceneNode } from './types';

const INK = '#1F1F24';
const MUTED = '#6E6E80';
const ACCENT = '#5B5BD6';
const LINE = '#D9D9E3';

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const candidate = line + word;
      if (line.trim() && ctx.measureText(candidate.trimEnd()).width > maxWidth) {
        out.push(line.trimEnd());
        line = word.trimStart();
        // A single word wider than the box is cut into pieces.
        while (line && ctx.measureText(line).width > maxWidth) {
          let i = line.length - 1;
          while (i > 1 && ctx.measureText(line.slice(0, i)).width > maxWidth) i--;
          out.push(line.slice(0, i));
          line = line.slice(i);
        }
      } else line = candidate;
    }
    out.push(line);
  }
  return out;
}

function font(node: SceneNode, size: number, weight = 400, family = node.fontFamily): string {
  return `${weight} ${size}px ${family}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function background(node: SceneNode): string {
  const f = node.fills.find((p) => p.visible && p.type === 'solid');
  return f && f.type === 'solid' ? f.color : '#FFFFFF';
}

/** Card body with a soft shadow and, for white cards, a border. */
function card(ctx: CanvasRenderingContext2D, node: SceneNode, shadow: boolean): void {
  const fill = background(node);
  ctx.save();
  if (shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 3;
  }
  roundRect(ctx, 0, 0, node.width, node.height, node.cornerRadius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
  if (fill.toUpperCase() === '#FFFFFF') {
    roundRect(ctx, 0.5, 0.5, node.width - 1, node.height - 1, node.cornerRadius);
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Draws lines top-down inside the box; returns the y after the last one. */
function lines(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, bottom: number): number {
  for (const l of wrap(ctx, text, maxWidth)) {
    if (y + lineHeight > bottom) {
      ctx.fillText('…', x, y);
      return bottom;
    }
    ctx.fillText(l, x, y);
    y += lineHeight;
  }
  return y;
}

function drawSticky(ctx: CanvasRenderingContext2D, node: SceneNode): void {
  card(ctx, node, true);
  const pad = 16;
  const size = node.fontSize;
  ctx.fillStyle = INK;
  ctx.textBaseline = 'top';
  ctx.font = font(node, size);
  const author = node.note?.author;
  const bottom = node.height - pad - (author ? 18 : 0);
  if (node.characters) lines(ctx, node.characters, pad, pad, node.width - pad * 2, size * 1.35, bottom);
  else {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillText('Empty note', pad, pad);
  }
  if (author) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.font = font(node, 11, 500);
    ctx.fillText(author, pad, node.height - pad - 12);
  }
}

function drawDoc(ctx: CanvasRenderingContext2D, node: SceneNode): void {
  card(ctx, node, true);
  const pad = 20;
  const base = node.fontSize;
  const right = node.width - pad;
  const bottom = node.height - pad;
  let y = pad;
  ctx.textBaseline = 'top';
  for (const b of markdownBlocks(node.characters)) {
    if (y >= bottom) break;
    if (b.kind === 'blank') {
      y += base * 0.6;
      continue;
    }
    let x = pad;
    let size = base;
    let weight = 400;
    let family = node.fontFamily;
    ctx.fillStyle = INK;
    if (b.kind === 'h1') [size, weight] = [base * 1.6, 700];
    else if (b.kind === 'h2') [size, weight] = [base * 1.3, 700];
    else if (b.kind === 'h3') [size, weight] = [base * 1.1, 600];
    else if (b.kind === 'code') family = 'ui-monospace, Consolas, monospace';
    else if (b.kind === 'quote') ctx.fillStyle = MUTED;
    const lh = size * 1.45;
    if (b.kind === 'bullet') {
      ctx.beginPath();
      ctx.arc(x + 4, y + lh / 2, 2.5, 0, Math.PI * 2);
      ctx.fill();
      x += 16;
    } else if (b.kind === 'todo' || b.kind === 'done') {
      checkbox(ctx, x, y + (lh - 12) / 2, 12, b.kind === 'done');
      ctx.fillStyle = b.kind === 'done' ? MUTED : INK;
      x += 20;
    } else if (b.kind === 'quote') {
      ctx.fillStyle = LINE;
      ctx.fillRect(x, y, 3, lh);
      ctx.fillStyle = MUTED;
      x += 12;
    } else if (b.kind === 'code') {
      ctx.fillStyle = '#F2F2F7';
      ctx.fillRect(pad - 6, y, right - pad + 12, lh);
      ctx.fillStyle = INK;
    }
    ctx.font = font(node, size, weight, family);
    y = lines(ctx, b.text, x, y + (lh - size) / 2, right - x, lh, bottom) - (lh - size) / 2;
    if (b.kind === 'h1' || b.kind === 'h2') y += base * 0.3;
  }
}

function checkbox(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, done: boolean): void {
  roundRect(ctx, x + 0.5, y + 0.5, s - 1, s - 1, 3);
  if (done) {
    ctx.fillStyle = ACCENT;
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x + s * 0.25, y + s * 0.52);
    ctx.lineTo(x + s * 0.43, y + s * 0.7);
    ctx.lineTo(x + s * 0.76, y + s * 0.3);
    ctx.stroke();
  } else {
    ctx.strokeStyle = MUTED;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

function header(ctx: CanvasRenderingContext2D, node: SceneNode, title: string, aside: string): number {
  const h = 40;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  ctx.font = font(node, 14, 600);
  const asideW = aside ? ctx.measureText(aside).width + 8 : 0;
  let t = title || ' ';
  while (t.length > 1 && ctx.measureText(t).width > node.width - 32 - asideW) t = t.slice(0, -2) + '…';
  ctx.fillText(t, 16, h / 2);
  if (aside) {
    ctx.fillStyle = MUTED;
    ctx.font = font(node, 12);
    ctx.textAlign = 'right';
    ctx.fillText(aside, node.width - 16, h / 2);
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = LINE;
  ctx.fillRect(0, h, node.width, 1);
  ctx.textBaseline = 'top';
  return h;
}

function drawChat(ctx: CanvasRenderingContext2D, node: SceneNode): void {
  card(ctx, node, true);
  const messages = (node.note?.messages ?? []).filter((m) => !m.deleted);
  const top = header(ctx, node, node.characters || 'Chat', `${messages.length} message${messages.length === 1 ? '' : 's'}`);
  const pad = 12;
  const inner = node.width - pad * 2 - 16;
  if (!messages.length) {
    ctx.fillStyle = MUTED;
    ctx.font = font(node, 13);
    ctx.fillText('No messages yet', pad + 4, top + pad);
    return;
  }
  // Newest at the bottom; earlier ones as far up as they fit.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top + 1, node.width, node.height - top - 1);
  ctx.clip();
  let y = node.height - pad;
  for (let i = messages.length - 1; i >= 0 && y > top; i--) {
    const m = messages[i];
    ctx.font = font(node, 13);
    const body = wrap(ctx, m.text, inner);
    const h = 8 + 16 + body.length * 18 + 8;
    y -= h;
    roundRect(ctx, pad, y, node.width - pad * 2, h, 10);
    ctx.fillStyle = m.agent ? '#EEEEFC' : '#F2F2F7';
    ctx.fill();
    ctx.fillStyle = m.agent ? ACCENT : INK;
    ctx.font = font(node, 12, 600);
    ctx.fillText(m.agent ? `${m.author} · AI` : m.author, pad + 8, y + 8);
    ctx.fillStyle = INK;
    ctx.font = font(node, 13);
    body.forEach((l, j) => ctx.fillText(l, pad + 8, y + 26 + j * 18));
    y -= 8;
  }
  ctx.restore();
}

function drawChecklist(ctx: CanvasRenderingContext2D, node: SceneNode): void {
  card(ctx, node, true);
  const items = node.note?.items ?? [];
  const top = header(ctx, node, node.characters || 'Checklist', items.length ? `${items.filter((i) => i.done).length}/${items.length}` : '');
  const pad = 16;
  let y = top + 12;
  const bottom = node.height - 12;
  if (!items.length) {
    ctx.fillStyle = MUTED;
    ctx.font = font(node, 13);
    ctx.fillText('No items yet', pad, y);
    return;
  }
  for (const item of items) {
    if (y + 20 > bottom) {
      ctx.fillStyle = MUTED;
      ctx.fillText('…', pad, y);
      break;
    }
    checkbox(ctx, pad, y + 2, 14, item.done);
    ctx.font = font(node, node.fontSize);
    ctx.fillStyle = item.done ? MUTED : INK;
    const ls = wrap(ctx, item.text || ' ', node.width - pad * 2 - 22);
    ls.forEach((l, j) => {
      const ly = y + j * 20;
      if (ly + 18 > bottom) return;
      ctx.fillText(l, pad + 22, ly);
      if (item.done) ctx.fillRect(pad + 22, ly + node.fontSize * 0.55, ctx.measureText(l).width, 1);
    });
    y += ls.length * 20 + 6;
  }
}

/** Nearest point of a rectangle to p. */
function clampTo(r: { x: number; y: number; width: number; height: number }, p: { x: number; y: number }) {
  return { x: Math.max(r.x, Math.min(r.x + r.width, p.x)), y: Math.max(r.y, Math.min(r.y + r.height, p.y)) };
}

function drawCallout(ctx: CanvasRenderingContext2D, doc: PlanarDocument, node: SceneNode): void {
  const color = background(node);
  const target = node.note?.targetId ? doc.nodes[node.note.targetId] : undefined;
  if (target && target.type !== 'page') {
    // The arrow runs in page coordinates between the two boxes.
    const self = worldBounds(doc, node.id);
    const to = worldBounds(doc, target.id);
    const end = clampTo(to, { x: self.x + self.width / 2, y: self.y + self.height / 2 });
    const start = clampTo(self, { x: to.x + to.width / 2, y: to.y + to.height / 2 });
    const inv = invert(worldMatrix(doc, node.id));
    const a = apply(inv, start);
    const b = apply(inv, end);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  roundRect(ctx, 0, 0, node.width, node.height, node.cornerRadius);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRect(ctx, 0, 0, node.width, node.height, node.cornerRadius);
  ctx.clip();
  const light = parseInt(color.slice(1, 3), 16) * 0.3 + parseInt(color.slice(3, 5), 16) * 0.59 + parseInt(color.slice(5, 7), 16) * 0.11 > 160;
  ctx.fillStyle = light ? INK : '#FFFFFF';
  ctx.font = font(node, node.fontSize, 500);
  ctx.textBaseline = 'top';
  const pad = 12;
  const ls = wrap(ctx, node.characters, node.width - pad * 2);
  const lh = node.fontSize * 1.35;
  let y = Math.max(pad * 0.75, (node.height - ls.length * lh) / 2);
  for (const l of ls) {
    ctx.fillText(l, pad, y + (lh - node.fontSize) / 2);
    y += lh;
  }
  ctx.restore();
}

/** Paints an annotation layer; the context is already in its local space. */
export function drawNote(ctx: CanvasRenderingContext2D, doc: PlanarDocument, node: SceneNode): void {
  ctx.save();
  ctx.textAlign = 'left';
  switch (node.note?.kind ?? 'sticky') {
    case 'sticky':
      drawSticky(ctx, node);
      break;
    case 'doc':
      drawDoc(ctx, node);
      break;
    case 'chat':
      drawChat(ctx, node);
      break;
    case 'checklist':
      drawChecklist(ctx, node);
      break;
    case 'callout':
      drawCallout(ctx, doc, node);
      break;
  }
  ctx.restore();
}
