// Turns Planar layers into code: HTML/CSS and React (TSX + CSS), plus
// design tokens. Pure functions — usable from the editor and the agent tools.

import { propHost, variantAxes, variantSet, variantsOf } from '../core/components';
import { cssEffects } from '../core/effects';
import { vectorPoints } from '../core/geometry';
import { cssFontFamily, fontImports } from '../core/fonts';
import { effectiveSizing } from '../core/layout';
import { nodePaths } from '../core/paths';
import { variableValue } from '../core/variables';
import { isFrameLike, type Paint, type PlanarDocument, type SceneNode, type Variable } from '../core/types';

export type CodeFormat = 'react' | 'html' | 'css';

// ---------------------------------------------------------------- naming

export function slug(s: string): string {
  const out = s
    .normalize('NFKD')
    .replace(/[^\w\s/-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s/_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return /^[a-z]/.test(out) ? out : `x-${out || 'layer'}`;
}

export function pascal(s: string): string {
  const words = s.normalize('NFKD').replace(/[^\w\s-]/g, ' ').split(/[\s_-]+/).filter(Boolean);
  const out = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[A-Z]/.test(out) ? out : `Component${out}`;
}

function camel(s: string): string {
  const p = pascal(s);
  return p[0].toLowerCase() + p.slice(1);
}

export function tokenName(v: Variable): string {
  return `--${slug(v.name)}`;
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

// ---------------------------------------------------------------- styles

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(alpha * 1000) / 1000})`;
}

function cssColor(doc: PlanarDocument, p: Paint): string | null {
  if (p.type !== 'solid' || !p.visible) return null;
  const v = p.variableId ? doc.variables.find((x) => x.id === p.variableId) : null;
  if (v) return p.opacity < 1 ? `color-mix(in srgb, var(${tokenName(v)}) ${Math.round(p.opacity * 100)}%, transparent)` : `var(${tokenName(v)})`;
  return p.opacity < 1 ? hexToRgba(p.color, p.opacity) : p.color.toUpperCase();
}

/** A numeric property, as a token reference when bound to a variable. */
function cssNum(doc: PlanarDocument, n: SceneNode, field: string, value: number): string {
  const v = n.bindings[field] ? doc.variables.find((x) => x.id === n.bindings[field]) : null;
  return v ? `calc(var(${tokenName(v)}) * 1px)` : px(value);
}

const JUSTIFY: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' };
const ALIGN: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end' };

// ---------------------------------------------------------------- element model

interface El {
  tag: string;
  cls: string;
  css: Record<string, string>;
  attrs: Record<string, string>;
  text?: string;
  /** JSX expression replacing the text (prop binding). */
  textExpr?: string;
  /** JSX condition wrapping the element (boolean prop). */
  showExpr?: string;
  /** JSX expression replacing the element (instance-swap slot). */
  slotExpr?: string;
  raw?: string;
  /** Rendered as <Component ... /> in React. */
  component?: { name: string; props: Record<string, string | boolean>; id: string };
  children: El[];
}

interface Ctx {
  doc: PlanarDocument;
  format: CodeFormat;
  classes: Set<string>;
  prefix: string;
  /** Component property id → JS prop name (when generating a React component). */
  propNames: Map<string, string>;
  usedComponents: Map<string, SceneNode>;
  rootId: string;
}

function uniqueClass(ctx: Ctx, name: string): string {
  const base = ctx.prefix ? `${ctx.prefix}__${slug(name)}` : slug(name);
  let cls = base;
  for (let i = 2; ctx.classes.has(cls); i++) cls = `${base}-${i}`;
  ctx.classes.add(cls);
  return cls;
}

function paintStyles(ctx: Ctx, n: SceneNode, css: Record<string, string>): void {
  const { doc } = ctx;
  const solids = n.fills.filter((p) => p.visible && p.type === 'solid');
  const image = [...n.fills].reverse().find((p) => p.visible && p.type === 'image');
  if (image && image.type === 'image') {
    css['background-image'] = `url("image-${n.id}.png")`;
    css['background-size'] = image.scaleMode === 'fit' ? 'contain' : 'cover';
    css['background-position'] = 'center';
    css['background-repeat'] = 'no-repeat';
  }
  if (solids.length) {
    const colors = solids.map((p) => cssColor(doc, p)).filter((c): c is string => !!c);
    if (colors.length === 1) css['background-color'] = colors[0];
    else if (colors.length > 1) {
      // Several fills stack: the last one paints on top.
      css.background = [...colors].reverse().map((c) => `linear-gradient(${c}, ${c})`).join(', ');
    }
  }
  const stroke = n.strokes.find((p) => p.visible && p.type === 'solid');
  const strokeColor = stroke ? cssColor(doc, stroke) : null;
  if (strokeColor && n.strokeWidth > 0) css.border = `${cssNum(doc, n, 'strokeWidth', n.strokeWidth)} solid ${strokeColor}`;
  if (n.type === 'ellipse') css['border-radius'] = '50%';
  else if (n.cornerRadius > 0 || n.bindings.cornerRadius) css['border-radius'] = cssNum(doc, n, 'cornerRadius', n.cornerRadius);
  Object.assign(css, cssEffects(n));
}

function sizeAndPosition(ctx: Ctx, n: SceneNode, css: Record<string, string>, root: boolean): void {
  const { doc } = ctx;
  const parent = n.parentId ? doc.nodes[n.parentId] : null;
  const parentAuto = !root && !n.layoutAbsolute && isFrameLike(parent) && parent!.layoutMode !== 'none';
  const main = parent?.layoutMode === 'horizontal' ? 'h' : 'v';

  if (!root && !parentAuto) {
    css.position = 'absolute';
    css.left = px(n.x);
    css.top = px(n.y);
  }
  for (const axis of ['h', 'v'] as const) {
    const prop = axis === 'h' ? 'width' : 'height';
    const sizing = effectiveSizing(doc, n, axis);
    const value = axis === 'h' ? n.width : n.height;
    if (sizing === 'fill' && parentAuto) {
      if (axis === main) {
        css.flex = '1 1 0';
        css[axis === 'h' ? 'min-width' : 'min-height'] = '0';
      } else {
        css['align-self'] = 'stretch';
      }
    } else if (sizing === 'fixed') {
      css[prop] = cssNum(doc, n, prop, value);
      if (parentAuto) css['flex-shrink'] = '0';
    } else if (root && sizing === 'hug' && axis === 'h' && n.type !== 'text') {
      css.width = 'fit-content';
    }
  }
  if (n.rotation) css.transform = `rotate(${Math.round(n.rotation * 100) / 100}deg)`;
  if (n.opacity < 1) css.opacity = String(Math.round(n.opacity * 1000) / 1000);
}

function textStyles(ctx: Ctx, n: SceneNode, css: Record<string, string>): void {
  const { doc } = ctx;
  css.margin = '0';
  css['font-family'] = cssFontFamily(n.fontFamily);
  css['font-size'] = cssNum(doc, n, 'fontSize', n.fontSize);
  if (n.fontWeight !== 400) css['font-weight'] = String(n.fontWeight);
  css['line-height'] = n.lineHeight > 0 ? String(n.lineHeight) : 'normal';
  const fill = n.fills.find((p) => p.visible && p.type === 'solid');
  const color = fill ? cssColor(doc, fill) : null;
  if (color) css.color = color;
  if (n.textAlign !== 'left') css['text-align'] = n.textAlign;
  css['white-space'] = n.autoWidth ? 'pre' : 'pre-wrap';
  if (!n.autoWidth && !n.autoHeight && n.textAlignVertical !== 'top') {
    css.display = 'flex';
    css['flex-direction'] = 'column';
    css['justify-content'] = n.textAlignVertical === 'middle' ? 'center' : 'flex-end';
  }
}

/** SVG elements for one vector layer, offset by (ox, oy). */
function vectorElements(ctx: Ctx, n: SceneNode, ox: number, oy: number): string {
  const fill = n.fills.find((p) => p.visible && p.type === 'solid');
  const stroke = n.strokes.find((p) => p.visible && p.type === 'solid');
  const fillColor = fill && (n.closed || n.paths.length) ? cssColor(ctx.doc, fill) : 'none';
  const strokeAttrs = stroke && n.strokeWidth > 0 ? ` stroke="${cssColor(ctx.doc, stroke)}" stroke-width="${n.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"` : '';
  const rule = (r: string) => (r === 'evenodd' ? ' fill-rule="evenodd"' : '');
  const move = ox || oy ? ` transform="translate(${Math.round(ox * 100) / 100} ${Math.round(oy * 100) / 100})"` : '';
  if (n.paths.length) return nodePaths(n).map((p) => `<path${move} d="${p.d}" fill="${fillColor}"${rule(p.fillRule)}${strokeAttrs}/>`).join('');
  const pts = vectorPoints(n);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100}`).join(' ') + (n.closed ? ' Z' : '');
  return `<path${move} d="${d}" fill="${fillColor}"${strokeAttrs}/>`;
}

/** A frame made only of vector layers (an icon) as one inline SVG. */
function iconSvg(ctx: Ctx, n: SceneNode): string | null {
  const kids = n.children.map((c) => ctx.doc.nodes[c]).filter((k) => k?.visible);
  if (!kids.length || n.layoutMode !== 'none' || n.fills.some((f) => f.visible) || !kids.every((k) => k.type === 'vector' && !k.rotation)) return null;
  const w = Math.round(n.width * 100) / 100;
  const h = Math.round(n.height * 100) / 100;
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="none">${kids.map((k) => vectorElements(ctx, k, k.x, k.y)).join('')}</svg>`;
}

function svgFor(ctx: Ctx, n: SceneNode): string {
  if (n.paths.length) {
    const sw = n.strokes.some((p) => p.visible) ? n.strokeWidth : 0;
    const w = Math.max(n.width, 0.01) + sw;
    const h = Math.max(n.height, 0.01) + sw;
    return `<svg viewBox="${-sw / 2} ${-sw / 2} ${w} ${h}" width="${w}" height="${h}" fill="none">${vectorElements(ctx, n, 0, 0)}</svg>`;
  }
  const pts = vectorPoints(n);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100}`).join(' ') + (n.closed ? ' Z' : '');
  const fill = n.closed ? n.fills.find((p) => p.visible && p.type === 'solid') : null;
  const stroke = n.strokes.find((p) => p.visible && p.type === 'solid');
  const fillColor = fill ? cssColor(ctx.doc, fill) : 'none';
  const strokeAttrs = stroke ? ` stroke="${cssColor(ctx.doc, stroke)}" stroke-width="${n.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"` : '';
  const sw = stroke ? n.strokeWidth : 0;
  const w = Math.max(n.width, 1) + sw;
  const h = Math.max(n.height, 1) + sw;
  const attr = ctx.format === 'react' ? { vb: 'viewBox', cls: 'className' } : { vb: 'viewBox', cls: 'class' };
  return `<svg ${attr.vb}="${-sw / 2} ${-sw / 2} ${w} ${h}" width="${w}" height="${h}" fill="none"><path d="${d}" fill="${fillColor}"${strokeAttrs}/></svg>`;
}

function build(ctx: Ctx, n: SceneNode, root = false): El | null {
  const { doc } = ctx;
  const visibleProp = n.propBindings.visible && ctx.propNames.get(n.propBindings.visible);
  if (!n.visible && !visibleProp) return null;
  const el: El = { tag: 'div', cls: uniqueClass(ctx, n.name), css: {}, attrs: {}, children: [] };
  if (visibleProp) el.showExpr = visibleProp;
  if (n.variableMode) {
    const mode = doc.modes.find((m) => m.id === n.variableMode);
    if (mode) el.attrs['data-mode'] = slug(mode.name);
  }

  // Instance-swap slot inside a component being generated.
  const slotProp = n.type === 'instance' && n.propBindings.componentId && ctx.propNames.get(n.propBindings.componentId);
  if (slotProp) {
    el.slotExpr = slotProp;
    return el;
  }

  // In React, instances (and main components placed in a layout) become
  // component elements.
  if ((n.type === 'instance' || n.type === 'component') && ctx.format === 'react' && !root) {
    const comp = n.type === 'component' ? n : doc.nodes[n.componentId];
    const set = comp ? variantSet(doc, comp.id) : null;
    const owner = set ?? comp;
    if (owner) {
      ctx.usedComponents.set(owner.id, owner);
      const props: Record<string, string | boolean> = {};
      const host = propHost(doc, comp!);
      for (const p of host.componentProps) {
        if (p.type === 'instance') continue;
        const value = p.id in n.propValues ? n.propValues[p.id] : p.defaultValue;
        if (value !== p.defaultValue) props[camel(p.name)] = value;
      }
      if (set) {
        const first = variantsOf(doc, set.id)[0];
        for (const [axis, value] of Object.entries(comp!.variantProps)) if (first?.variantProps[axis] !== value) props[camel(axis)] = value;
      }
      el.component = { name: pascal(owner.name), props, id: owner.id };
      sizeAndPosition(ctx, n, el.css, root);
      return el;
    }
  }

  sizeAndPosition(ctx, n, el.css, root);

  if (n.type === 'text') {
    el.tag = 'p';
    textStyles(ctx, n, el.css);
    Object.assign(el.css, cssEffects(n));
    const textProp = n.propBindings.characters && ctx.propNames.get(n.propBindings.characters);
    if (textProp) el.textExpr = textProp;
    else el.text = n.characters;
    return el;
  }
  if (n.type === 'vector') {
    el.raw = svgFor(ctx, n);
    el.css.display = 'block';
    // Box shadows would follow the box, not the drawing.
    const fx = cssEffects(n);
    const drops = n.effects.filter((e) => e.visible && e.type === 'drop-shadow');
    if (drops.length) fx.filter = [...drops.map((e) => `drop-shadow(${e.x}px ${e.y}px ${e.radius}px ${e.opacity < 1 ? `color-mix(in srgb, ${e.color} ${Math.round(e.opacity * 100)}%, transparent)` : e.color})`), fx.filter].filter(Boolean).join(' ');
    delete fx['box-shadow'];
    Object.assign(el.css, fx);
    return el;
  }

  paintStyles(ctx, n, el.css);
  const icon = isFrameLike(n) && n.type !== 'instance' ? iconSvg(ctx, n) : null;
  if (icon) {
    el.raw = icon;
    el.css.display = 'block';
    return el;
  }
  if (isFrameLike(n) || n.type === 'group') {
    if (isFrameLike(n) && n.layoutMode !== 'none') {
      el.css.display = 'flex';
      el.css['flex-direction'] = n.layoutMode === 'horizontal' ? 'row' : 'column';
      if (n.itemSpacing || n.bindings.itemSpacing) el.css.gap = cssNum(doc, n, 'itemSpacing', n.itemSpacing);
      const pads = [
        ['paddingTop', n.paddingTop],
        ['paddingRight', n.paddingRight],
        ['paddingBottom', n.paddingBottom],
        ['paddingLeft', n.paddingLeft],
      ] as const;
      if (pads.some(([f, v]) => v || n.bindings[f])) {
        const vals = pads.map(([f, v]) => cssNum(doc, n, f, v));
        el.css.padding = vals.every((v) => v === vals[0]) ? vals[0] : vals[0] === vals[2] && vals[1] === vals[3] ? `${vals[0]} ${vals[1]}` : vals.join(' ');
      }
      if (n.primaryAlign !== 'start') el.css['justify-content'] = JUSTIFY[n.primaryAlign];
      el.css['align-items'] = ALIGN[n.counterAlign];
      if (n.children.some((c) => doc.nodes[c]?.layoutAbsolute)) el.css.position = el.css.position ?? 'relative';
    } else if (n.children.length) {
      el.css.position = el.css.position ?? 'relative';
    }
    if (isFrameLike(n) && n.clipContent) el.css.overflow = 'hidden';
    for (const c of n.children) {
      const child = build(ctx, doc.nodes[c]);
      if (child) el.children.push(child);
    }
  }
  return el;
}

// ---------------------------------------------------------------- printing

function cssBlock(selector: string, css: Record<string, string>): string {
  const entries = Object.entries(css);
  if (!entries.length) return '';
  return `${selector} {\n${entries.map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`;
}

/** Ids of a layer and everything inside it. */
function subtreeIds(doc: PlanarDocument, id: string): string[] {
  const out = [id];
  for (const c of doc.nodes[id]?.children ?? []) out.push(...subtreeIds(doc, c));
  return out;
}

/** Base CSS plus the Google Fonts imports the layers need. */
function preamble(doc: PlanarDocument, ids: string[]): string {
  return [...fontImports(doc, ids), BASE_CSS].join('\n');
}

function collectCss(el: El, out: string[]): void {
  const block = cssBlock(`.${el.cls}`, el.css);
  if (block) out.push(block);
  el.children.forEach((c) => collectCss(c, out));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function printHtml(el: El, indent: string): string {
  const attrs = [`class="${el.cls}"`, ...Object.entries(el.attrs).map(([k, v]) => `${k}="${escapeHtml(v)}"`)].join(' ');
  if (el.raw) return `${indent}<div ${attrs}>${el.raw}</div>`;
  if (el.text !== undefined) return `${indent}<${el.tag} ${attrs}>${escapeHtml(el.text)}</${el.tag}>`;
  if (!el.children.length) return `${indent}<${el.tag} ${attrs}></${el.tag}>`;
  return `${indent}<${el.tag} ${attrs}>\n${el.children.map((c) => printHtml(c, indent + '  ')).join('\n')}\n${indent}</${el.tag}>`;
}

function jsxText(s: string): string {
  return /[{}<>\n`]|^\s|\s$/.test(s) ? `{${JSON.stringify(s)}}` : s;
}

function jsxValue(v: string | boolean): string {
  return typeof v === 'boolean' ? `{${v}}` : JSON.stringify(v);
}

function printJsx(el: El, indent: string): string {
  if (el.slotExpr) return `${indent}{${el.slotExpr}}`;
  let out: string;
  const attrs = [`className="${el.cls}"`, ...Object.entries(el.attrs).map(([k, v]) => `${k}=${JSON.stringify(v)}`)].join(' ');
  if (el.component) {
    const props = Object.entries(el.component.props).map(([k, v]) => ` ${k}=${jsxValue(v)}`).join('');
    // Wrapper only when the instance needs its own placement/size styles.
    out = Object.keys(el.css).length ? `${indent}<div ${attrs}>\n${indent}  <${el.component.name}${props} />\n${indent}</div>` : `${indent}<${el.component.name}${props} />`;
  } else if (el.raw) {
    out = `${indent}<div ${attrs}>${el.raw}</div>`;
  } else if (el.textExpr) {
    out = `${indent}<${el.tag} ${attrs}>{${el.textExpr}}</${el.tag}>`;
  } else if (el.text !== undefined) {
    out = `${indent}<${el.tag} ${attrs}>${jsxText(el.text)}</${el.tag}>`;
  } else if (!el.children.length) {
    out = `${indent}<${el.tag} ${attrs} />`;
  } else {
    out = `${indent}<${el.tag} ${attrs}>\n${el.children.map((c) => printJsx(c, indent + '  ')).join('\n')}\n${indent}</${el.tag}>`;
  }
  if (el.showExpr) return `${indent}{${el.showExpr} && (\n${out.replace(/^/gm, '  ')}\n${indent})}`;
  return out;
}

const BASE_CSS = '*, *::before, *::after {\n  box-sizing: border-box;\n}';

// ---------------------------------------------------------------- public API

export interface CodeResult {
  code: string;
  /** Components referenced (React) that can be generated separately. */
  uses: { name: string; id: string }[];
}

function newCtx(doc: PlanarDocument, format: CodeFormat, rootId: string, prefix = ''): Ctx {
  return { doc, format, classes: new Set(), prefix, propNames: new Map(), usedComponents: new Map(), rootId };
}

/** React component for a main component or a component set. */
function reactComponent(doc: PlanarDocument, owner: SceneNode): CodeResult {
  const name = pascal(owner.name);
  const variants = owner.type === 'componentSet' ? variantsOf(doc, owner.id) : [owner];
  const host = owner.type === 'componentSet' ? owner : propHost(doc, owner);
  const axes = owner.type === 'componentSet' ? variantAxes(doc, owner.id) : [];
  const propNames = new Map(host.componentProps.map((p) => [p.id, camel(p.name)]));

  const fields: string[] = [];
  const defaults: string[] = [];
  for (const axis of axes) {
    const values = [...new Set(variants.map((v) => v.variantProps[axis]).filter(Boolean))];
    fields.push(`  ${camel(axis)}?: ${values.map((v) => JSON.stringify(v)).join(' | ')};`);
    defaults.push(`${camel(axis)} = ${JSON.stringify(variants[0]?.variantProps[axis] ?? values[0])}`);
  }
  for (const p of host.componentProps) {
    const js = camel(p.name);
    if (p.type === 'text') {
      fields.push(`  ${js}?: string;`);
      defaults.push(`${js} = ${JSON.stringify(String(p.defaultValue))}`);
    } else if (p.type === 'boolean') {
      fields.push(`  ${js}?: boolean;`);
      defaults.push(`${js} = ${p.defaultValue !== false}`);
    } else {
      fields.push(`  /** Slot (instance swap). */\n  ${js}?: ReactNode;`);
      defaults.push(js);
    }
  }

  const css: string[] = [];
  const uses = new Map<string, SceneNode>();
  const bodies = variants.map((v) => {
    const prefix = slug(name) + (variants.length > 1 ? `--${slug(Object.values(v.variantProps).join('-'))}` : '');
    const ctx = newCtx(doc, 'react', v.id, prefix);
    ctx.propNames = propNames;
    const el = build(ctx, v, true)!;
    el.cls = prefix;
    collectCss(el, css);
    ctx.usedComponents.forEach((c, id) => id !== owner.id && uses.set(id, c));
    return { v, jsx: printJsx(el, '    ') };
  });

  const lines: string[] = [];
  const needsNode = host.componentProps.some((p) => p.type === 'instance');
  lines.push(`// ${name}.tsx`);
  if (needsNode) lines.push(`import type { ReactNode } from 'react';`);
  lines.push(`import './${name}.css';`);
  for (const c of uses.values()) lines.push(`import { ${pascal(c.name)} } from './${pascal(c.name)}';`);
  lines.push('');
  lines.push(`export interface ${name}Props {`);
  lines.push(...(fields.length ? fields : ['  // No properties']));
  lines.push('}');
  lines.push('');
  lines.push(`export function ${name}({ ${defaults.join(', ')} }: ${name}Props) {`);
  for (const { v, jsx } of bodies.slice(1)) {
    const cond = axes.map((axis) => `${camel(axis)} === ${JSON.stringify(v.variantProps[axis])}`).join(' && ');
    lines.push(`  if (${cond || 'false'}) {\n    return (\n${jsx.replace(/^/gm, '  ')}\n    );\n  }`);
  }
  lines.push(`  return (\n${bodies[0].jsx}\n  );`);
  lines.push('}');
  lines.push('');
  lines.push(`/* ${name}.css */`);
  lines.push([preamble(doc, variants.flatMap((v) => subtreeIds(doc, v.id))), ...css].join('\n\n'));
  return { code: lines.join('\n'), uses: [...uses.values()].map((c) => ({ name: pascal(c.name), id: c.id })) };
}

export function generateCode(doc: PlanarDocument, id: string, format: CodeFormat): CodeResult {
  const node = doc.nodes[id];
  if (!node) throw new Error(`No layer with id ${id}`);

  if (format === 'react') {
    const owner = node.type === 'componentSet' ? node : node.type === 'component' ? variantSet(doc, node.id) ?? node : null;
    if (owner) return reactComponent(doc, owner);
  }

  const ctx = newCtx(doc, format, id);
  const el = build(ctx, node, true);
  if (!el) return { code: '/* Layer is hidden */', uses: [] };
  const css: string[] = [];
  collectCss(el, css);
  const stylesheet = [preamble(doc, subtreeIds(doc, id)), ...css].join('\n\n');
  const uses = [...ctx.usedComponents.values()].map((c) => ({ name: pascal(c.name), id: c.id }));

  if (format === 'css') return { code: stylesheet, uses: [] };
  if (format === 'html') return { code: `${printHtml(el, '')}\n\n<style>\n${stylesheet}\n</style>`, uses: [] };

  const name = pascal(node.name);
  const lines = [`// ${name}.tsx`, `import './${name}.css';`];
  for (const u of uses) lines.push(`import { ${u.name} } from './${u.name}';`);
  lines.push('', `export function ${name}() {`, `  return (\n${printJsx(el, '    ')}\n  );`, '}', '', `/* ${name}.css */`, stylesheet);
  return { code: lines.join('\n'), uses };
}

export type TokenFormat = 'css' | 'json' | 'ts';

export function generateTokens(doc: PlanarDocument, format: TokenFormat): string {
  const modes = doc.modes;
  const value = (v: Variable, modeId: string) => variableValue(doc, v, modeId);
  if (format === 'json') {
    const out: Record<string, Record<string, unknown>> = {};
    for (const m of modes) out[m.name] = Object.fromEntries(doc.variables.map((v) => [v.name, value(v, m.id)]));
    return JSON.stringify({ modes: out }, null, 2);
  }
  if (format === 'ts') {
    const body = modes
      .map((m) => `  ${JSON.stringify(slug(m.name))}: {\n${doc.variables.map((v) => `    ${JSON.stringify(v.name)}: ${JSON.stringify(value(v, m.id))},`).join('\n')}\n  },`)
      .join('\n');
    return `export const tokens = {\n${body}\n} as const;\n\nexport type Mode = keyof typeof tokens;\nexport type Token = keyof (typeof tokens)[Mode];\n`;
  }
  const decl = (v: Variable, modeId: string) => {
    const val = value(v, modeId);
    if (v.type === 'boolean') return `  /* ${v.name}: ${val} */`;
    return `  ${tokenName(v)}: ${v.type === 'string' ? JSON.stringify(val) : val};`;
  };
  const blocks = modes.map((m, i) => {
    const selector = i === 0 ? `:root,\n[data-mode="${slug(m.name)}"]` : `[data-mode="${slug(m.name)}"]`;
    return `${selector} {\n${doc.variables.map((v) => decl(v, m.id)).join('\n')}\n}`;
  });
  return `/* Design tokens — modes: ${modes.map((m) => m.name).join(', ')}. Numbers are unitless; use calc(var(--x) * 1px). */\n${blocks.join('\n\n')}\n`;
}
