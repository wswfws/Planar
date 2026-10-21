// SVG import: a small, dependency-free reader for the common subset used by
// icons and simple illustrations. Works in browsers and in Node.

import { createNode, insertNode, solid } from './document';
import { IDENTITY, multiply, rotation, scaling, translation, type Mat } from './math';
import { parsePath, segsBounds, segsToD, transformSegs, type Seg } from './paths';
import type { Paint, PlanarDocument, SceneNode } from './types';

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const SKIP = new Set(['defs', 'title', 'desc', 'metadata', 'style', 'clipPath', 'mask', 'symbol', 'linearGradient', 'radialGradient', 'pattern', 'filter', 'script']);

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Minimal XML reader (elements, attributes, text). */
function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const clean = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const re = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) {
      top.text += m[5];
      continue;
    }
    const [, closing, rawTag, rawAttrs, selfClosing] = m;
    const tag = rawTag.replace(/^svg:/, '');
    if (closing) {
      while (stack.length > 1 && stack.pop()!.tag !== tag) {
        // Tolerate unbalanced markup.
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    const ar = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(rawAttrs))) attrs[a[1]] = decode(a[3] ?? a[4] ?? '');
    const node: XmlNode = { tag, attrs, children: [], text: '' };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000', blue: '#0000FF', yellow: '#FFFF00', orange: '#FFA500',
  purple: '#800080', gray: '#808080', grey: '#808080', silver: '#C0C0C0', navy: '#000080', teal: '#008080', maroon: '#800000',
  lime: '#00FF00', aqua: '#00FFFF', cyan: '#00FFFF', fuchsia: '#FF00FF', magenta: '#FF00FF', pink: '#FFC0CB', brown: '#A52A2A',
};

/** Colour string → hex + alpha, null for none, 'inherit' when unset. */
function parseColor(value: string | undefined, current: string): { color: string; alpha: number } | null | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (!v || v === 'inherit') return undefined;
  if (v === 'none' || v === 'transparent') return null;
  if (v === 'currentcolor') return { color: current, alpha: 1 };
  if (v.startsWith('url(')) return { color: '#808080', alpha: 1 }; // gradients/patterns → neutral fallback
  if (NAMED[v]) return { color: NAMED[v], alpha: 1 };
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    return { color: `#${h.slice(0, 6).toUpperCase()}`, alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = parts.slice(0, 3).map((p) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p)));
    const alpha = parts[3] !== undefined ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    const hex = ch.map((c) => Math.max(0, Math.min(255, Math.round(c || 0))).toString(16).padStart(2, '0')).join('');
    return { color: `#${hex.toUpperCase()}`, alpha };
  }
  return { color: '#000000', alpha: 1 };
}

function parseTransform(value: string | undefined): Mat {
  let m: Mat = [...IDENTITY];
  if (!value) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t: RegExpExecArray | null;
  while ((t = re.exec(value))) {
    const n = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let next: Mat = [...IDENTITY];
    switch (t[1]) {
      case 'matrix':
        next = [n[0], n[1], n[2], n[3], n[4], n[5]];
        break;
      case 'translate':
        next = translation(n[0] || 0, n[1] || 0);
        break;
      case 'scale':
        next = scaling(n[0], n[1] ?? n[0]);
        break;
      case 'rotate': {
        const r = rotation(((n[0] || 0) * Math.PI) / 180);
        next = n.length >= 3 ? multiply(multiply(translation(n[1], n[2]), r), translation(-n[1], -n[2])) : r;
        break;
      }
      case 'skewX':
        next = [1, 0, Math.tan(((n[0] || 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        next = [1, Math.tan(((n[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = multiply(m, next);
  }
  return m;
}

const num = (v: string | undefined, fallback = 0) => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : fallback;
};

function shapeToPath(el: XmlNode): string | null {
  const a = el.attrs;
  switch (el.tag) {
    case 'path':
      return a.d ?? null;
    case 'rect': {
      const x = num(a.x);
      const y = num(a.y);
      const w = num(a.width);
      const h = num(a.height);
      if (w <= 0 || h <= 0) return null;
      let rx = a.rx !== undefined ? num(a.rx) : a.ry !== undefined ? num(a.ry) : 0;
      let ry = a.ry !== undefined ? num(a.ry) : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case 'circle':
    case 'ellipse': {
      const cx = num(a.cx);
      const cy = num(a.cy);
      const rx = el.tag === 'circle' ? num(a.r) : num(a.rx);
      const ry = el.tag === 'circle' ? num(a.r) : num(a.ry);
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'line':
      return `M${num(a.x1)} ${num(a.y1)}L${num(a.x2)} ${num(a.y2)}`;
    case 'polyline':
    case 'polygon': {
      const pts = (a.points ?? '').trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return el.tag === 'polygon' ? d + 'Z' : d;
    }
  }
  return null;
}

interface Style {
  fill: { color: string; alpha: number } | null;
  stroke: { color: string; alpha: number } | null;
  strokeWidth: number;
  fillRule: 'nonzero' | 'evenodd';
  opacity: number;
  color: string;
}

function styleOf(el: XmlNode, parent: Style): Style {
  const a: Record<string, string> = { ...el.attrs };
  for (const decl of (el.attrs.style ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) a[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  const color = parseColor(a.color, parent.color)?.color ?? parent.color;
  const fill = parseColor(a.fill, color);
  const stroke = parseColor(a.stroke, color);
  const fillOpacity = a['fill-opacity'] !== undefined ? num(a['fill-opacity'], 1) : 1;
  const strokeOpacity = a['stroke-opacity'] !== undefined ? num(a['stroke-opacity'], 1) : 1;
  return {
    color,
    fill: fill === undefined ? parent.fill : fill && { ...fill, alpha: fill.alpha * fillOpacity },
    stroke: stroke === undefined ? parent.stroke : stroke && { ...stroke, alpha: stroke.alpha * strokeOpacity },
    strokeWidth: a['stroke-width'] !== undefined ? num(a['stroke-width'], 1) : parent.strokeWidth,
    fillRule: a['fill-rule'] === 'evenodd' ? 'evenodd' : a['fill-rule'] === 'nonzero' ? 'nonzero' : parent.fillRule,
    opacity: parent.opacity * (a.opacity !== undefined ? num(a.opacity, 1) : 1),
  };
}

export interface SvgShape {
  name: string;
  segs: Seg[];
  style: Style;
  scale: number;
}

export interface ParsedSvg {
  width: number;
  height: number;
  title: string | null;
  shapes: SvgShape[];
}

/** Reads SVG markup into transformed shapes in pixel coordinates. */
export function parseSvg(markup: string, opts: { color?: string } = {}): ParsedSvg {
  const doc = parseXml(markup);
  const svg = doc.children.find((c) => c.tag === 'svg');
  if (!svg) throw new Error('Not SVG markup (no <svg> element)');
  const vb = (svg.attrs.viewBox ?? '').split(/[\s,]+/).map(Number);
  const hasVb = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  const width = num(svg.attrs.width?.replace('px', ''), hasVb ? vb[2] : 100);
  const height = num(svg.attrs.height?.replace('px', ''), hasVb ? vb[3] : 100);
  const rootM: Mat = hasVb ? multiply(scaling(width / vb[2], height / vb[3]), translation(-vb[0], -vb[1])) : [...IDENTITY];
  const title = svg.children.find((c) => c.tag === 'title')?.text.trim() || null;
  const base: Style = { fill: { color: '#000000', alpha: 1 }, stroke: null, strokeWidth: 1, fillRule: 'nonzero', opacity: 1, color: opts.color ?? '#000000' };

  const shapes: SvgShape[] = [];
  const counts: Record<string, number> = {};
  const walk = (el: XmlNode, m: Mat, style: Style) => {
    if (SKIP.has(el.tag) || el.attrs.display === 'none' || el.attrs.visibility === 'hidden') return;
    const own = multiply(m, parseTransform(el.attrs.transform));
    const st = styleOf(el, style);
    const d = shapeToPath(el);
    if (d) {
      try {
        const segs = transformSegs(parsePath(d), own);
        counts[el.tag] = (counts[el.tag] ?? 0) + 1;
        const label = el.attrs.id || el.attrs['data-name'] || `${el.tag === 'path' ? 'Path' : el.tag[0].toUpperCase() + el.tag.slice(1)} ${counts[el.tag]}`;
        shapes.push({ name: label, segs, style: st, scale: Math.sqrt(Math.abs(own[0] * own[3] - own[1] * own[2])) || 1 });
      } catch {
        // Skip shapes with unreadable geometry.
      }
    }
    for (const c of el.children) walk(c, own, st);
  };
  for (const c of svg.children) walk(c, rootM, styleOf(svg, base));
  return { width, height, title, shapes };
}

function paint(c: { color: string; alpha: number }, opacity: number): Paint {
  return { ...solid(c.color, Math.round(c.alpha * opacity * 1000) / 1000) };
}

/**
 * Builds Planar layers for parsed SVG under `parentId`: a frame sized like
 * the SVG with one vector layer per shape. Returns the frame.
 */
export function insertSvg(doc: PlanarDocument, parentId: string, svg: ParsedSvg, opts: { name?: string; x?: number; y?: number; index?: number } = {}): SceneNode {
  const frame = createNode('frame', {
    name: opts.name ?? svg.title ?? 'SVG',
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    width: svg.width,
    height: svg.height,
    fills: [],
    clipContent: false,
  });
  insertNode(doc, frame, parentId, opts.index);
  for (const s of svg.shapes) {
    const fill = s.style.fill;
    const stroke = s.style.stroke;
    if (!fill && !stroke) continue;
    const b = segsBounds(s.segs);
    const w = Math.max(b.width, 0.01);
    const h = Math.max(b.height, 0.01);
    const d = segsToD(transformSegs(s.segs, [1, 0, 0, 1, -b.x, -b.y]));
    const node = createNode('vector', {
      name: s.name,
      x: b.x,
      y: b.y,
      width: w,
      height: h,
      paths: [{ d, fillRule: s.style.fillRule }],
      pathBox: { w, h },
      closed: true,
      fills: fill ? [paint(fill, s.style.opacity)] : [],
      strokes: stroke ? [paint(stroke, s.style.opacity)] : [],
      strokeWidth: stroke ? Math.round(s.style.strokeWidth * s.scale * 100) / 100 : 0,
    });
    insertNode(doc, node, frame.id);
  }
  return frame;
}

export function looksLikeSvg(text: string): boolean {
  return /^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[\s\S]*?>\s*)?<svg[\s>]/i.test(text);
}
