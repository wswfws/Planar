// The layer vocabulary shared by the agent tools: `describe` reads a layer
// into it, `applyProps` / `createLayers` write it back. See docs/MCP.md.

import {
  createInstanceNode,
  listComponents,
  propHost,
  switchComponent,
  variantSet,
  variantsOf,
  wouldCycle,
} from '../core/components';
import { createNode, getPageOf, insertNode } from '../core/document';
import { defaultEffect, isShadow, parseShadows, shadowToString } from '../core/effects';
import { scaleContents } from '../core/geometry';
import { nodePaths, pathGeometry } from '../core/paths';
import { insertSvg, parseSvg } from '../core/svg';
import type { Editor } from '../core/editor';
import type { ConstraintH, ConstraintV, Effect, NodeType, Paint, PlanarDocument, SceneNode } from '../core/types';
import { isFrameLike } from '../core/types';

export type Friendly = Record<string, unknown>;

const round = (n: number) => Math.round(n * 100) / 100;

const WEIGHTS: Record<string, number> = {
  thin: 100,
  extralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
};

const DEFAULT_FONT = 'system-ui, sans-serif';

// ---------------------------------------------------------------- reading

function variableName(doc: PlanarDocument, id: string | undefined): string | null {
  const v = id ? doc.variables.find((x) => x.id === id) : null;
  return v ? `$${v.name}` : null;
}

function paintToFriendly(doc: PlanarDocument, p: Paint): string {
  if (p.type === 'image') return 'image';
  const base = variableName(doc, p.variableId) ?? p.color.toUpperCase();
  const parts = [base];
  if (p.opacity < 1) parts.push(`${Math.round(p.opacity * 100)}%`);
  if (!p.visible) parts.push('hidden');
  return parts.join(' ');
}

function paintsToFriendly(doc: PlanarDocument, paints: Paint[]): unknown {
  if (!paints.length) return undefined;
  const list = paints.map((p) => paintToFriendly(doc, p));
  return list.length === 1 ? list[0] : list;
}

function sizeOf(doc: PlanarDocument, n: SceneNode, axis: 'h' | 'v'): number | string {
  const sizing = axis === 'h' ? n.sizingH : n.sizingV;
  const parent = n.parentId ? doc.nodes[n.parentId] : null;
  const laidOut = !n.layoutAbsolute && isFrameLike(parent) && parent!.layoutMode !== 'none';
  if (sizing === 'fill' && laidOut) return 'fill';
  if (n.type === 'text') {
    if (axis === 'h' && n.autoWidth) return 'hug';
    if (axis === 'v' && (n.autoWidth || n.autoHeight)) return 'hug';
  } else if (sizing === 'hug' && isFrameLike(n) && n.layoutMode !== 'none') {
    return 'hug';
  }
  return round(axis === 'h' ? n.width : n.height);
}

function compactPadding(n: SceneNode): unknown {
  const { paddingTop: t, paddingRight: r, paddingBottom: b, paddingLeft: l } = n;
  if (t === r && r === b && b === l) return t;
  if (t === b && l === r) return [t, r];
  return [t, r, b, l];
}

/** A layer in the shared vocabulary (only meaningful, non-default keys). */
export function describe(doc: PlanarDocument, n: SceneNode): Friendly {
  const out: Friendly = { id: n.id, type: n.type === 'vector' && n.points.length === 2 && !n.closed ? 'line' : n.type, name: n.name };
  if (n.type === 'page') {
    out.children = n.children.length;
    const bg = n.fills[0];
    if (bg?.type === 'solid') out.background = bg.color;
    return out;
  }
  const vars = n.bindings;
  const num = (key: keyof SceneNode, value: number) => variableName(doc, vars[key as string]) ?? round(value);

  out.x = round(n.x);
  out.y = round(n.y);
  out.width = vars.width ? variableName(doc, vars.width) : sizeOf(doc, n, 'h');
  out.height = vars.height ? variableName(doc, vars.height) : sizeOf(doc, n, 'v');
  if (n.rotation) out.rotation = round(n.rotation);
  if (n.opacity < 1) out.opacity = round(n.opacity);
  if (!n.visible) out.visible = false;
  if (n.locked) out.locked = true;
  if (n.layoutAbsolute) out.absolute = true;
  if (n.link && doc.nodes[n.link.to]) {
    out.link = doc.nodes[n.link.to].name;
    if (n.link.transition && n.link.transition !== 'instant') out.transition = n.link.transition;
  }

  if (n.type !== 'group' && n.type !== 'componentSet') {
    const fill = paintsToFriendly(doc, n.fills);
    if (fill !== undefined) out.fill = fill;
    else if (n.type !== 'vector' && n.type !== 'text') out.fill = null;
    const stroke = paintsToFriendly(doc, n.strokes);
    if (stroke !== undefined) {
      out.stroke = stroke;
      out.strokeWidth = num('strokeWidth', n.strokeWidth);
    }
  }
  if ((n.type === 'rectangle' || isFrameLike(n)) && (n.cornerRadius || vars.cornerRadius)) out.radius = num('cornerRadius', n.cornerRadius);
  const shadows = n.effects.filter(isShadow);
  if (shadows.length) out.shadow = shadows.map(shadowToString).join(', ');
  for (const [key, type] of [
    ['blur', 'layer-blur'],
    ['backgroundBlur', 'background-blur'],
  ] as const) {
    const e = n.effects.find((x) => x.type === type);
    if (e) out[key] = e.visible ? round(e.radius) : `${round(e.radius)} hidden`;
  }
  if (isFrameLike(n)) {
    if (n.type === 'frame' && !n.clipContent) out.clip = false;
    if (n.type !== 'frame' && n.clipContent) out.clip = true;
    if (n.layoutMode !== 'none') {
      out.layout = n.layoutMode === 'horizontal' ? 'row' : 'column';
      out.gap = num('itemSpacing', n.itemSpacing);
      const pad = compactPadding(n);
      if (pad !== 0) out.padding = pad;
      if (n.primaryAlign !== 'start') out.align = n.primaryAlign;
      if (n.counterAlign !== 'start') out.crossAlign = n.counterAlign;
      if (n.layoutMode === 'horizontal' && n.layoutWrap) {
        out.wrap = true;
        out.rowGap = round(n.counterSpacing);
      }
    }
  }
  const parent = n.parentId ? doc.nodes[n.parentId] : null;
  if (isFrameLike(parent) && (n.constraintH !== 'left' || n.constraintV !== 'top')) out.constraints = `${n.constraintH} ${n.constraintV}`;
  if (n.type === 'text') {
    out.text = n.characters;
    if (n.fontFamily !== DEFAULT_FONT) out.font = n.fontFamily;
    out.size = num('fontSize', n.fontSize);
    if (n.fontWeight !== 400) out.weight = n.fontWeight;
    out.lineHeight = vars.lineHeight ? variableName(doc, vars.lineHeight) : n.lineHeight > 0 ? n.lineHeight : 'auto';
    if (n.textAlign !== 'left') out.textAlign = n.textAlign;
    if (!n.autoWidth && !n.autoHeight && n.textAlignVertical !== 'top') out.textAlignVertical = n.textAlignVertical;
  }
  if (n.type === 'vector') {
    if (n.paths.length) {
      const ds = nodePaths(n).map((p) => p.d);
      out.path = ds.length === 1 ? ds[0] : ds;
      if (n.paths.some((p) => p.fillRule === 'evenodd')) out.fillRule = 'evenodd';
    } else {
      out.points = n.points.map((p) => [round(p.x * n.width), round(p.y * n.height)]);
      if (n.closed) out.closed = true;
    }
  }
  if (n.type === 'instance') {
    const comp = doc.nodes[n.componentId];
    const set = comp ? variantSet(doc, comp.id) : null;
    out.component = set ? set.name : comp?.name ?? '(deleted)';
    if (set) out.variant = { ...comp!.variantProps };
    const host = comp ? propHost(doc, comp) : null;
    if (host?.componentProps.length) {
      out.props = Object.fromEntries(host.componentProps.map((p) => [p.name, p.id in n.propValues ? n.propValues[p.id] : p.defaultValue]));
    }
  }
  if (n.type === 'component' || n.type === 'componentSet') {
    const host = propHost(doc, n);
    if (host === n && n.componentProps.length) {
      out.properties = n.componentProps.map((p) => ({ name: p.name, type: p.type, default: p.defaultValue }));
    }
    if (n.type === 'component' && Object.keys(n.variantProps).length) out.variant = { ...n.variantProps };
    if (n.type === 'componentSet') out.variants = variantsOf(doc, n.id).map((v) => v.variantProps);
  }
  if (n.variableMode) out.mode = doc.modes.find((m) => m.id === n.variableMode)?.name;
  if (n.children.length) out.children = n.children.length;
  return out;
}

// ---------------------------------------------------------------- writing

export class PropError extends Error {}

function findVariable(doc: PlanarDocument, ref: string, type?: string) {
  const name = ref.replace(/^\$/, '');
  const v = doc.variables.find((x) => x.name === name || x.id === name);
  if (!v) throw new PropError(`Unknown variable "${ref}". Known: ${doc.variables.map((x) => '$' + x.name).join(', ') || 'none'}`);
  if (type && v.type !== type) throw new PropError(`Variable "${ref}" is a ${v.type}, expected ${type}`);
  return v;
}

function parseHex(s: string): { color: string; alpha: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const alpha = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
  return { color: `#${h.slice(0, 6).toUpperCase()}`, alpha };
}

export type ImageLoader = (ref: string) => string;

function parsePaint(doc: PlanarDocument, value: unknown, loadImage?: ImageLoader): Paint {
  if (typeof value !== 'string') throw new PropError(`Paint must be a string like "#FF0000", "#FF0000 50%" or "$variable", got ${JSON.stringify(value)}`);
  const parts = value.trim().split(/\s+/);
  const hidden = parts.includes('hidden');
  const pct = parts.find((p) => /^\d+(\.\d+)?%$/.test(p));
  const opacityFromPct = pct ? Math.max(0, Math.min(1, parseFloat(pct) / 100)) : 1;
  const head = parts[0];
  if (head.startsWith('image:')) {
    if (!loadImage) throw new PropError('Images are not available here');
    return { type: 'image', src: loadImage(value.slice(6).trim()), scaleMode: 'fill', opacity: opacityFromPct, visible: !hidden };
  }
  if (head.startsWith('$')) {
    const v = findVariable(doc, head, 'color');
    const color = String(Object.values(v.values)[0] ?? '#000000');
    return { type: 'solid', color, opacity: opacityFromPct, visible: !hidden, variableId: v.id };
  }
  const hex = parseHex(head);
  if (!hex) throw new PropError(`Cannot read colour "${value}" — use #RRGGBB, #RRGGBB 50% or $variable`);
  return { type: 'solid', color: hex.color, opacity: pct ? opacityFromPct : hex.alpha, visible: !hidden };
}

function parsePaints(doc: PlanarDocument, value: unknown, loadImage?: ImageLoader): Paint[] {
  if (value === null || value === 'none') return [];
  return (Array.isArray(value) ? value : [value]).map((v) => parsePaint(doc, v, loadImage));
}

function parsePadding(value: unknown): [number, number, number, number] {
  if (typeof value === 'number') return [value, value, value, value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
    if (value.length === 2) return [value[0], value[1], value[0], value[1]];
    if (value.length === 4) return value as [number, number, number, number];
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, number>;
    return [o.top ?? 0, o.right ?? 0, o.bottom ?? 0, o.left ?? 0];
  }
  throw new PropError('padding must be a number, [vertical, horizontal] or [top, right, bottom, left]');
}

function parseWeight(value: unknown): number {
  if (typeof value === 'number') return Math.max(100, Math.min(900, Math.round(value / 100) * 100));
  const w = WEIGHTS[String(value).toLowerCase().replace(/[\s-]/g, '')];
  if (!w) throw new PropError(`Unknown weight "${value}"`);
  return w;
}

const H_CONSTRAINTS = ['left', 'right', 'left-right', 'center', 'scale'];
const V_CONSTRAINTS = ['top', 'bottom', 'top-bottom', 'center', 'scale'];

/** "left-right top", "right bottom", "scale scale" — horizontal first; a single word sets the axis it names. */
function parseConstraints(value: unknown): [ConstraintH, ConstraintV] {
  const words = (value === null ? 'left top' : String(value)).trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
  const bad = () => new PropError(`constraints must be "<${H_CONSTRAINTS.join('|')}> <${V_CONSTRAINTS.join('|')}>", got ${JSON.stringify(value)}`);
  if (words.length === 2 && H_CONSTRAINTS.includes(words[0]) && V_CONSTRAINTS.includes(words[1])) return words as [ConstraintH, ConstraintV];
  if (words.length === 1) {
    if (['left', 'right', 'left-right'].includes(words[0])) return [words[0] as ConstraintH, 'top'];
    if (['top', 'bottom', 'top-bottom'].includes(words[0])) return ['left', words[0] as ConstraintV];
    if (words[0] === 'center' || words[0] === 'scale') return [words[0], words[0]];
  }
  throw bad();
}

/** Component or component set by name or id. */
export function findComponent(doc: PlanarDocument, ref: string): SceneNode | null {
  const byId = doc.nodes[ref];
  if (byId && (byId.type === 'component' || byId.type === 'componentSet')) return byId;
  const lower = ref.toLowerCase();
  const sets = Object.values(doc.nodes).filter((n) => n.type === 'componentSet');
  return (
    sets.find((s) => s.name.toLowerCase() === lower) ??
    listComponents(doc).find((c) => !variantSet(doc, c.id) && c.name.toLowerCase() === lower) ??
    listComponents(doc).find((c) => c.name.toLowerCase() === lower) ??
    null
  );
}

const KNOWN = new Set([
  'id', 'type', 'name', 'x', 'y', 'width', 'height', 'w', 'h', 'rotation', 'opacity', 'visible', 'locked', 'fill', 'fills', 'stroke',
  'strokes', 'strokeWidth', 'radius', 'clip', 'layout', 'gap', 'padding', 'align', 'crossAlign', 'absolute', 'text', 'font', 'size',
  'fontSize', 'weight', 'fontWeight', 'lineHeight', 'textAlign', 'textAlignVertical', 'component', 'props', 'variant', 'mode',
  'parent', 'index', 'children', 'points', 'closed', 'path', 'viewBox', 'fillRule', 'svg', 'link', 'transition', 'shadow', 'blur',
  'backgroundBlur', 'constraints', 'wrap', 'rowGap',
]);

/**
 * Applies vocabulary props to one layer inside the current transaction.
 * Returns warnings for things that were ignored.
 */
export function applyProps(editor: Editor, id: string, props: Friendly, loadImage?: ImageLoader): string[] {
  const doc = editor.doc;
  const warnings: string[] = [];
  const node = doc.nodes[id];
  if (!node) throw new PropError(`No layer with id ${id}`);
  for (const k of Object.keys(props)) if (!KNOWN.has(k)) warnings.push(`unknown key "${k}" ignored`);

  // Instance swaps first: they rebuild the layer's contents.
  if (props.component !== undefined && node.type === 'instance') {
    const target = findComponent(doc, String(props.component));
    if (!target) throw new PropError(`Unknown component "${props.component}"`);
    const comp = target.type === 'componentSet' ? variantsOf(doc, target.id)[0] : target;
    if (comp && comp.id !== node.componentId) editor.change((d) => switchComponent(d, id, comp.id));
  }

  const numOrVar = (key: string, field: keyof SceneNode, value: unknown, n: SceneNode) => {
    if (typeof value === 'string' && value.startsWith('$')) {
      const v = findVariable(doc, value, 'number');
      n.bindings = { ...n.bindings, [field]: v.id };
    } else if (typeof value === 'number') {
      (n as unknown as Record<string, number>)[field] = value;
      if (n.bindings[field as string]) n.bindings = Object.fromEntries(Object.entries(n.bindings).filter(([k]) => k !== field));
    } else {
      throw new PropError(`${key} must be a number or "$variable"`);
    }
  };

  const before = { w: node.width, h: node.height };
  editor.updateNodes([id], (n) => {
    const set = <K extends keyof SceneNode>(k: K, v: SceneNode[K]) => {
      n[k] = v;
    };
    if (props.name !== undefined) set('name', String(props.name));
    if (props.x !== undefined) set('x', Number(props.x));
    if (props.y !== undefined) set('y', Number(props.y));
    if (props.rotation !== undefined) set('rotation', Number(props.rotation));
    if (props.opacity !== undefined) set('opacity', Math.max(0, Math.min(1, Number(props.opacity))));
    if (props.visible !== undefined) set('visible', props.visible !== false);
    if (props.locked !== undefined) set('locked', props.locked === true);
    if (props.absolute !== undefined) set('layoutAbsolute', props.absolute === true);
    if (props.link !== undefined) {
      if (props.link === null || props.link === '') delete n.link;
      else {
        const ref = String(props.link);
        const top = doc.nodes[getPageOf(doc, node.id)?.id ?? '']?.children ?? [];
        const to = top.find((c) => c === ref) ?? top.find((c) => doc.nodes[c]?.name === ref);
        if (!to) throw new PropError(`link: no top-level frame "${ref}" on this page (use its name or id)`);
        const t = String(props.transition ?? n.link?.transition ?? 'instant');
        if (t !== 'instant' && t !== 'slide' && t !== 'dissolve') throw new PropError('transition must be instant, slide or dissolve');
        n.link = { to, transition: t };
      }
    } else if (props.transition !== undefined && n.link) {
      const t = String(props.transition);
      if (t !== 'instant' && t !== 'slide' && t !== 'dissolve') throw new PropError('transition must be instant, slide or dissolve');
      n.link = { ...n.link, transition: t };
    }
    const fill = props.fill ?? props.fills;
    if (fill !== undefined) set('fills', parsePaints(doc, fill, loadImage));
    const stroke = props.stroke ?? props.strokes;
    if (stroke !== undefined) {
      set('strokes', parsePaints(doc, stroke, loadImage));
      if (props.strokeWidth === undefined && n.strokes.length && !n.strokeWidth) n.strokeWidth = 1;
    }
    if (props.strokeWidth !== undefined) numOrVar('strokeWidth', 'strokeWidth', props.strokeWidth, n);
    if (props.radius !== undefined) numOrVar('radius', 'cornerRadius', props.radius, n);
    if (props.clip !== undefined) set('clipContent', props.clip === true);
    if (props.shadow !== undefined) {
      const list = props.shadow === null || props.shadow === 'none' ? [] : Array.isArray(props.shadow) ? props.shadow.map(String) : [String(props.shadow)];
      let shadows: Effect[];
      try {
        shadows = list.flatMap(parseShadows);
      } catch (e) {
        throw new PropError((e as Error).message);
      }
      n.effects = [...shadows, ...n.effects.filter((e) => !isShadow(e))];
    }
    for (const [key, type] of [
      ['blur', 'layer-blur'],
      ['backgroundBlur', 'background-blur'],
    ] as const) {
      const value = props[key];
      if (value === undefined) continue;
      const rest = n.effects.filter((e) => e.type !== type);
      const radius = value === null ? 0 : Number(value);
      if (!Number.isFinite(radius) || radius < 0) throw new PropError(`${key} must be a blur radius in pixels (0 or null removes it)`);
      n.effects = radius > 0 ? [...rest, { ...defaultEffect(type), radius }] : rest;
    }

    if (props.layout !== undefined) {
      const l = String(props.layout);
      set('layoutMode', l === 'row' || l === 'horizontal' ? 'horizontal' : l === 'column' || l === 'vertical' ? 'vertical' : 'none');
      if (n.layoutMode !== 'none' && !isFrameLike(n)) warnings.push(`layout only applies to frames, components and instances (${n.type})`);
    }
    if (props.gap !== undefined) numOrVar('gap', 'itemSpacing', props.gap, n);
    if (props.padding !== undefined) {
      const [t, r, b, l] = parsePadding(props.padding);
      Object.assign(n, { paddingTop: t, paddingRight: r, paddingBottom: b, paddingLeft: l });
    }
    if (props.align !== undefined) {
      const a = String(props.align);
      if (!['start', 'center', 'end', 'space-between'].includes(a)) throw new PropError('align must be start, center, end or space-between');
      set('primaryAlign', a as SceneNode['primaryAlign']);
    }
    if (props.crossAlign !== undefined) {
      const a = String(props.crossAlign);
      if (!['start', 'center', 'end'].includes(a)) throw new PropError('crossAlign must be start, center or end');
      set('counterAlign', a as SceneNode['counterAlign']);
    }

    if (props.wrap !== undefined) {
      set('layoutWrap', props.wrap === true);
      if (n.layoutWrap && n.layoutMode !== 'horizontal') warnings.push('wrap only applies to row layouts');
    }
    if (props.rowGap !== undefined) {
      const g = Number(props.rowGap);
      if (!Number.isFinite(g)) throw new PropError('rowGap must be a number');
      set('counterSpacing', g);
    }
    if (props.constraints !== undefined) {
      const [h, v] = parseConstraints(props.constraints);
      set('constraintH', h);
      set('constraintV', v);
    }

    if (props.text !== undefined) set('characters', String(props.text));
    if (props.font !== undefined) set('fontFamily', String(props.font));
    const size = props.size ?? props.fontSize;
    if (size !== undefined) numOrVar('size', 'fontSize', size, n);
    const weight = props.weight ?? props.fontWeight;
    if (weight !== undefined) set('fontWeight', parseWeight(weight));
    if (props.lineHeight !== undefined) {
      if (props.lineHeight === 'auto') set('lineHeight', 0);
      else numOrVar('lineHeight', 'lineHeight', props.lineHeight, n);
    }
    if (props.textAlign !== undefined) set('textAlign', String(props.textAlign) as SceneNode['textAlign']);
    if (props.textAlignVertical !== undefined) set('textAlignVertical', String(props.textAlignVertical) as SceneNode['textAlignVertical']);

    for (const [key, axis] of [
      ['width', 'h'],
      ['height', 'v'],
    ] as const) {
      const value = props[key] ?? props[key === 'width' ? 'w' : 'h'];
      if (value === undefined) continue;
      const field = key;
      const sizing = axis === 'h' ? 'sizingH' : 'sizingV';
      if (value === 'fill') {
        set(sizing, 'fill');
      } else if (value === 'hug') {
        if (n.type === 'text') {
          if (axis === 'h') n.autoWidth = true;
          else n.autoHeight = true;
          set(sizing, 'fixed');
        } else {
          set(sizing, 'hug');
        }
      } else if (typeof value === 'number' || (typeof value === 'string' && value.startsWith('$'))) {
        numOrVar(key, field, value, n);
        set(sizing, 'fixed');
        if (n.type === 'text') {
          if (axis === 'h') {
            n.autoHeight = n.autoWidth || n.autoHeight;
            n.autoWidth = false;
          } else {
            n.autoWidth = false;
            n.autoHeight = false;
          }
        }
      } else {
        throw new PropError(`${key} must be a number, "hug", "fill" or "$variable"`);
      }
    }

    if (props.points !== undefined && n.type === 'vector') {
      const pts = props.points as [number, number][];
      if (!Array.isArray(pts) || pts.length < 2) throw new PropError('points needs at least two [x, y] pairs');
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const w = Math.max(...xs) - minX;
      const h = Math.max(...ys) - minY;
      n.x += minX;
      n.y += minY;
      n.width = w;
      n.height = h;
      n.points = pts.map(([px, py]) => ({ x: w ? (px - minX) / w : 0, y: h ? (py - minY) / h : 0 }));
    }
    if (props.closed !== undefined && n.type === 'vector') set('closed', props.closed === true);
    if (props.path !== undefined && n.type === 'vector') {
      const vb = Array.isArray(props.viewBox) ? { w: Number(props.viewBox[0]), h: Number(props.viewBox[1]) } : undefined;
      let geo;
      try {
        geo = pathGeometry(props.path as string | string[], vb);
      } catch (e) {
        throw new PropError(`Bad path: ${(e as Error).message}`);
      }
      const rule = props.fillRule === 'evenodd' ? 'evenodd' : 'nonzero';
      n.paths = geo.paths.map((p) => ({ ...p, fillRule: rule }));
      n.pathBox = { w: Math.max(geo.box.width, 0.01), h: Math.max(geo.box.height, 0.01) };
      // Keep a requested size; otherwise use the path's own size.
      if (props.width === undefined && props.w === undefined) n.width = n.pathBox.w;
      if (props.height === undefined && props.h === undefined) n.height = n.pathBox.h;
      if (!n.fills.length && !n.strokes.length) n.fills = [{ type: 'solid', color: '#000000', opacity: 1, visible: true }];
    }

    if (props.mode !== undefined) {
      const name = String(props.mode);
      const mode = doc.modes.find((m) => m.name.toLowerCase() === name.toLowerCase() || m.id === name);
      if (props.mode === null || name === '' || name === 'auto') set('variableMode', '');
      else if (!mode) throw new PropError(`Unknown mode "${name}". Modes: ${doc.modes.map((m) => m.name).join(', ')}`);
      else set('variableMode', mode.id);
    }
  });

  // Resizing a group or an icon frame scales what it holds.
  const resized = doc.nodes[id];
  if (resized && (resized.width !== before.w || resized.height !== before.h) && before.w > 0 && before.h > 0) {
    editor.change((d) => scaleContents(d, resized, resized.width / before.w, resized.height / before.h));
  }

  // Instance properties and variants.
  const inst = doc.nodes[id];
  if (inst?.type === 'instance') {
    if (props.variant && typeof props.variant === 'object') {
      for (const [axis, value] of Object.entries(props.variant as Record<string, string>)) {
        editor.setInstanceVariant([id], axis, String(value));
        const comp = doc.nodes[doc.nodes[id].componentId];
        if (comp?.variantProps[axis] !== String(value)) warnings.push(`no variant with ${axis}=${value}`);
      }
    }
    if (props.props && typeof props.props === 'object') {
      const comp = doc.nodes[doc.nodes[id].componentId];
      const host = comp ? propHost(doc, comp) : null;
      for (const [name, value] of Object.entries(props.props as Record<string, unknown>)) {
        const prop = host?.componentProps.find((p) => p.name.toLowerCase() === name.toLowerCase() || p.id === name);
        if (!prop) {
          warnings.push(`component has no property "${name}" (has: ${host?.componentProps.map((p) => p.name).join(', ') || 'none'})`);
          continue;
        }
        let v: string | boolean = prop.type === 'boolean' ? value !== false : String(value);
        if (prop.type === 'instance') {
          const target = findComponent(doc, String(value));
          if (!target) {
            warnings.push(`unknown component "${value}" for ${name}`);
            continue;
          }
          v = target.type === 'componentSet' ? variantsOf(doc, target.id)[0].id : target.id;
        }
        editor.setInstanceProp([id], prop.id, v);
      }
    }
  }

  if (props.parent !== undefined || props.index !== undefined) {
    const parentId = props.parent !== undefined ? String(props.parent) : doc.nodes[id].parentId!;
    const parent = doc.nodes[parentId];
    if (!parent) throw new PropError(`No parent with id ${parentId}`);
    const index = props.index !== undefined ? Number(props.index) : parent.children.length;
    editor.moveLayers([id], parentId, index);
    if (doc.nodes[id].parentId !== parentId) warnings.push(`could not move into ${parentId} (inside an instance or would nest a component in itself)`);
  }
  return warnings;
}

const TYPE_ALIASES: Record<string, NodeType | 'line' | 'instance' | 'svg'> = {
  frame: 'frame',
  text: 'text',
  rectangle: 'rectangle',
  rect: 'rectangle',
  ellipse: 'ellipse',
  circle: 'ellipse',
  line: 'line',
  vector: 'vector',
  polygon: 'vector',
  group: 'group',
  component: 'component',
  instance: 'instance',
  svg: 'svg',
};

export interface CreateResult {
  ids: string[];
  warnings: string[];
}

/** Creates nested layers from vocabulary specs under `parentId`. */
export function createLayers(
  editor: Editor,
  parentId: string,
  specs: Friendly[],
  index: number | undefined,
  loadImage?: ImageLoader,
): CreateResult {
  const doc = editor.doc;
  const ids: string[] = [];
  const warnings: string[] = [];
  const parent = doc.nodes[parentId];
  if (!parent) throw new PropError(`No parent with id ${parentId}`);

  let at = index;
  for (const spec of specs) {
    const kind = TYPE_ALIASES[String(spec.type ?? 'frame').toLowerCase()];
    if (!kind) throw new PropError(`Unknown type "${spec.type}". Use frame, text, rectangle, ellipse, line, vector, group, component or instance.`);
    let node: SceneNode;
    if (kind === 'svg') {
      if (typeof spec.svg !== 'string') throw new PropError('type "svg" needs svg: "<svg ...>...</svg>"');
      let parsed;
      try {
        parsed = parseSvg(spec.svg);
      } catch (e) {
        throw new PropError(`Cannot read SVG: ${(e as Error).message}`);
      }
      let frameId = '';
      editor.change((d) => {
        frameId = insertSvg(d, parentId, parsed, { name: spec.name !== undefined ? String(spec.name) : undefined, index: at }).id;
      });
      if (at !== undefined) at++;
      const frame = doc.nodes[frameId];
      const { svg: _svg, type: _t, fill, stroke, width, height, children: _c, ...rest } = spec;
      // Resize by scaling the drawing; recolour every shape if asked.
      const w = typeof width === 'number' ? width : typeof height === 'number' ? (height / frame.height) * frame.width : frame.width;
      const h = typeof height === 'number' ? height : typeof width === 'number' ? (width / frame.width) * frame.height : frame.height;
      editor.change((d) => {
        const sx = w / frame.width;
        const sy = h / frame.height;
        for (const c of frame.children) {
          const k = d.nodes[c];
          k.x *= sx;
          k.y *= sy;
          k.width *= sx;
          k.height *= sy;
          k.strokeWidth *= Math.min(sx, sy);
        }
        frame.width = w;
        frame.height = h;
      });
      if (fill !== undefined || stroke !== undefined) {
        for (const c of frame.children) {
          const k = doc.nodes[c];
          const recolor: Friendly = {};
          if (fill !== undefined && k.fills.length) recolor.fill = fill;
          if (fill !== undefined && !k.fills.length && k.strokes.length) recolor.stroke = fill;
          if (stroke !== undefined && k.strokes.length) recolor.stroke = stroke;
          warnings.push(...applyProps(editor, c, recolor, loadImage));
        }
      }
      warnings.push(...applyProps(editor, frameId, rest, loadImage));
      ids.push(frameId);
      continue;
    }
    if (kind === 'instance') {
      const target = findComponent(doc, String(spec.component ?? ''));
      if (!target) throw new PropError(`Unknown component "${spec.component}". Components: ${listComponents(doc).map((c) => c.name).join(', ') || 'none'}`);
      const comp = target.type === 'componentSet' ? variantsOf(doc, target.id)[0] : target;
      if (wouldCycle(doc, comp.id, parentId)) throw new PropError(`Cannot place ${target.name} inside itself`);
      node = createInstanceNode(doc, comp.id);
    } else if (kind === 'line') {
      node = createNode('vector', { name: 'Line', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], width: 100, height: 0 });
    } else {
      // Groups are built as a plain container and become a group once they
      // have children (an empty group would be removed straight away).
      node = kind === 'group' ? createNode('frame', { name: 'Group', fills: [], clipContent: false }) : createNode(kind, {});
      if (kind === 'text') node.characters = String(spec.text ?? 'Text');
      if (kind === 'vector' && !spec.points) node.points = [{ x: 0, y: 1 }, { x: 0.5, y: 0 }, { x: 1, y: 1 }];
    }
    if (spec.name === undefined && kind === 'text') node.name = String(spec.text ?? 'Text').split('\n')[0].slice(0, 40);
    editor.change((d) => insertNode(d, node, parentId, at));
    if (at !== undefined) at++;
    const { children, type: _type, component: _component, ...rest } = spec;
    warnings.push(...applyProps(editor, node.id, kind === 'instance' ? { ...rest } : rest, loadImage).map((w) => `${node.name}: ${w}`));
    if (Array.isArray(children)) {
      if (!isFrameLike(node) && node.type !== 'group') throw new PropError(`${kind} layers cannot have children`);
      const sub = createLayers(editor, node.id, children as Friendly[], undefined, loadImage);
      warnings.push(...sub.warnings);
    }
    if (kind === 'group') {
      if (!node.children.length) throw new PropError('A group needs children');
      editor.change(() => {
        node.type = 'group';
      });
    }
    ids.push(node.id);
  }
  return { ids, warnings };
}
