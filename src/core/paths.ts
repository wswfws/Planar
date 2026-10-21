// Vector path data: parsing SVG path syntax into a small normalised form
// (absolute M, L, C, Q, Z), transforming, measuring and scaling it.

import { apply, type Mat, type Rect } from './math';
import type { SceneNode } from './types';

export type Seg = { c: 'M' | 'L'; p: [number, number] } | { c: 'C'; p: [number, number, number, number, number, number] } | { c: 'Q'; p: [number, number, number, number] } | { c: 'Z'; p: [] };

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

function tokenize(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) out.push(m[1] ?? parseFloat(m[2]));
  return out;
}

/** Arc (endpoint form) to cubic Béziers, per the SVG implementation notes. */
function arcToCubics(x1: number, y1: number, rx: number, ry: number, angle: number, large: boolean, sweep: boolean, x2: number, y2: number): Seg[] {
  if ((x1 === x2 && y1 === y2) || !rx || !ry) return [{ c: 'L', p: [x2, y2] }];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const parts = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / parts;
  const k = (4 / 3) * Math.tan(step / 4);
  const segs: Seg[] = [];
  const point = (t: number) => {
    const ct = Math.cos(t);
    const st = Math.sin(t);
    return { x: cx + rx * ct * cos - ry * st * sin, y: cy + rx * ct * sin + ry * st * cos, dx: -rx * st * cos - ry * ct * sin, dy: -rx * st * sin + ry * ct * cos };
  };
  let t = theta1;
  for (let i = 0; i < parts; i++) {
    const a = point(t);
    const b = point(t + step);
    segs.push({ c: 'C', p: [a.x + k * a.dx, a.y + k * a.dy, b.x - k * b.dx, b.y - k * b.dy, b.x, b.y] });
    t += step;
  }
  // Land exactly on the end point.
  const last = segs[segs.length - 1].p as number[];
  last[4] = x2;
  last[5] = y2;
  return segs;
}

/** Parses SVG path data into absolute M/L/C/Q/Z segments. Throws on garbage. */
export function parsePath(d: string): Seg[] {
  const tokens = tokenize(d);
  const segs: Seg[] = [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lastC: [number, number] | null = null;
  let lastQ: [number, number] | null = null;
  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === 'string') {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        segs.push({ c: 'Z', p: [] });
        x = sx;
        y = sy;
        lastC = lastQ = null;
        continue;
      }
    } else if (!cmd) {
      throw new Error('Path data must start with a command (M)');
    }
    const upper = cmd.toUpperCase();
    const n = ARGS[upper];
    if (n === undefined) throw new Error(`Unknown path command ${cmd}`);
    const args = tokens.slice(i, i + n);
    if (args.length < n || args.some((a) => typeof a !== 'number')) throw new Error(`Bad arguments for path command ${cmd}`);
    i += n;
    const a = args as number[];
    const rel = cmd !== upper;
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (upper) {
      case 'M':
        x = a[0] + ox;
        y = a[1] + oy;
        sx = x;
        sy = y;
        segs.push({ c: 'M', p: [x, y] });
        // Further pairs after M are implicit L.
        cmd = rel ? 'l' : 'L';
        lastC = lastQ = null;
        break;
      case 'L':
        x = a[0] + ox;
        y = a[1] + oy;
        segs.push({ c: 'L', p: [x, y] });
        lastC = lastQ = null;
        break;
      case 'H':
        x = a[0] + (rel ? x : 0);
        segs.push({ c: 'L', p: [x, y] });
        lastC = lastQ = null;
        break;
      case 'V':
        y = a[0] + (rel ? y : 0);
        segs.push({ c: 'L', p: [x, y] });
        lastC = lastQ = null;
        break;
      case 'C': {
        const p: [number, number, number, number, number, number] = [a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy, a[4] + ox, a[5] + oy];
        segs.push({ c: 'C', p });
        lastC = [p[2], p[3]];
        lastQ = null;
        x = p[4];
        y = p[5];
        break;
      }
      case 'S': {
        const c1x = lastC ? 2 * x - lastC[0] : x;
        const c1y = lastC ? 2 * y - lastC[1] : y;
        const p: [number, number, number, number, number, number] = [c1x, c1y, a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy];
        segs.push({ c: 'C', p });
        lastC = [p[2], p[3]];
        lastQ = null;
        x = p[4];
        y = p[5];
        break;
      }
      case 'Q': {
        const p: [number, number, number, number] = [a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy];
        segs.push({ c: 'Q', p });
        lastQ = [p[0], p[1]];
        lastC = null;
        x = p[2];
        y = p[3];
        break;
      }
      case 'T': {
        const cx: number = lastQ ? 2 * x - lastQ[0] : x;
        const cy: number = lastQ ? 2 * y - lastQ[1] : y;
        const p: [number, number, number, number] = [cx, cy, a[0] + ox, a[1] + oy];
        segs.push({ c: 'Q', p });
        lastQ = [cx, cy];
        lastC = null;
        x = p[2];
        y = p[3];
        break;
      }
      case 'A': {
        const ex = a[5] + ox;
        const ey = a[6] + oy;
        segs.push(...arcToCubics(x, y, a[0], a[1], a[2], !!a[3], !!a[4], ex, ey));
        x = ex;
        y = ey;
        lastC = lastQ = null;
        break;
      }
    }
  }
  if (!segs.length) throw new Error('Empty path');
  return segs;
}

const r3 = (n: number) => {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
};

export function segsToD(segs: Seg[]): string {
  return segs.map((s) => (s.c === 'Z' ? 'Z' : `${s.c} ${s.p.map(r3).join(' ')}`)).join(' ');
}

export function transformSegs(segs: Seg[], m: Mat): Seg[] {
  return segs.map((s) => {
    const p = [...s.p];
    for (let i = 0; i < p.length; i += 2) {
      const q = apply(m, { x: p[i], y: p[i + 1] });
      p[i] = q.x;
      p[i + 1] = q.y;
    }
    return { c: s.c, p } as Seg;
  });
}

/** Tight bounds of the drawn path (curves are sampled). */
export function segsBounds(segs: Seg[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  let x = 0;
  let y = 0;
  for (const s of segs) {
    if (s.c === 'M' || s.c === 'L') {
      x = s.p[0];
      y = s.p[1];
      add(x, y);
    } else if (s.c === 'C') {
      const [x1, y1, x2, y2, x3, y3] = s.p;
      for (let i = 1; i <= 24; i++) {
        const t = i / 24;
        const u = 1 - t;
        add(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
      }
      x = x3;
      y = y3;
    } else if (s.c === 'Q') {
      const [x1, y1, x2, y2] = s.p;
      for (let i = 1; i <= 16; i++) {
        const t = i / 16;
        const u = 1 - t;
        add(u * u * x + 2 * u * t * x1 + t * t * x2, u * u * y + 2 * u * t * y1 + t * t * y2);
      }
      x = x2;
      y = y2;
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Scales normalised path data (absolute M/L/C/Q/Z) by sx, sy. */
export function scaleD(d: string, sx: number, sy: number): string {
  if (sx === 1 && sy === 1) return d;
  let axis = 0;
  return d
    .split(' ')
    .map((tok) => {
      if (/^[MLCQZ]$/.test(tok)) {
        axis = 0;
        return tok;
      }
      const v = parseFloat(tok) * (axis++ % 2 === 0 ? sx : sy);
      return String(r3(v));
    })
    .join(' ');
}

/** The node's paths scaled from its pathBox to its current size. */
export function nodePaths(node: SceneNode): { d: string; fillRule: 'nonzero' | 'evenodd' }[] {
  const sx = node.pathBox.w ? node.width / node.pathBox.w : 1;
  const sy = node.pathBox.h ? node.height / node.pathBox.h : 1;
  return node.paths.map((p) => ({ d: scaleD(p.d, sx, sy), fillRule: p.fillRule }));
}

/**
 * Turns path data into node geometry: paths relative to their own bounds,
 * plus the box they occupy in the source coordinates.
 */
export function pathGeometry(d: string | string[], viewBox?: { w: number; h: number }): { paths: { d: string; fillRule: 'nonzero' }[]; box: Rect } {
  const list = (Array.isArray(d) ? d : [d]).map(parsePath);
  const bounds = viewBox ? { x: 0, y: 0, width: viewBox.w, height: viewBox.h } : segsBounds(list.flat());
  const shift: Mat = [1, 0, 0, 1, -bounds.x, -bounds.y];
  return { paths: list.map((segs) => ({ d: segsToD(transformSegs(segs, shift)), fillRule: 'nonzero' })), box: bounds };
}
