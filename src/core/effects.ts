// Shadows and blurs: defaults, validation, the text form the agent uses
// ("0 4 12 #000000 25%") and how far they reach outside a layer.

import type { Effect, EffectType, SceneNode } from './types';

export const EFFECT_TYPES: EffectType[] = ['drop-shadow', 'inner-shadow', 'layer-blur', 'background-blur'];

export const EFFECT_LABELS: Record<EffectType, string> = {
  'drop-shadow': 'Drop shadow',
  'inner-shadow': 'Inner shadow',
  'layer-blur': 'Layer blur',
  'background-blur': 'Background blur',
};

export function isShadow(e: Effect): boolean {
  return e.type === 'drop-shadow' || e.type === 'inner-shadow';
}

export function defaultEffect(type: EffectType): Effect {
  if (type === 'drop-shadow' || type === 'inner-shadow') {
    return { type, visible: true, color: '#000000', opacity: 0.25, x: 0, y: 4, radius: 4, spread: 0 };
  }
  return { type, visible: true, color: '#000000', opacity: 1, x: 0, y: 0, radius: type === 'layer-blur' ? 4 : 8, spread: 0 };
}

/** Normalises untrusted effect lists (files, ops, agent input). */
export function sanitizeEffects(raw: unknown): Effect[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && EFFECT_TYPES.includes((e as Effect).type))
    .map((e) => {
      const base = defaultEffect(e.type as EffectType);
      return {
        type: base.type,
        visible: e.visible !== false,
        color: typeof e.color === 'string' && /^#[0-9a-f]{6}$/i.test(e.color) ? e.color.toUpperCase() : base.color,
        opacity: Math.max(0, Math.min(1, num(e.opacity, base.opacity))),
        x: num(e.x, base.x),
        y: num(e.y, base.y),
        radius: Math.max(0, num(e.radius, base.radius)),
        spread: num(e.spread, base.spread),
      };
    });
}

/** How far visible effects paint outside the layer box, in its own units. */
export function effectOutset(node: SceneNode): { left: number; top: number; right: number; bottom: number } {
  const out = { left: 0, top: 0, right: 0, bottom: 0 };
  for (const e of node.effects) {
    if (!e.visible) continue;
    if (e.type === 'drop-shadow') {
      const reach = e.radius + Math.max(0, e.spread);
      out.left = Math.max(out.left, reach - e.x);
      out.right = Math.max(out.right, reach + e.x);
      out.top = Math.max(out.top, reach - e.y);
      out.bottom = Math.max(out.bottom, reach + e.y);
    } else if (e.type === 'layer-blur') {
      for (const k of ['left', 'top', 'right', 'bottom'] as const) out[k] = Math.max(out[k], e.radius);
    }
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** "0 4 12 0 #000000 25%" (x y blur spread colour), with "inset" for inner shadows. */
export function shadowToString(e: Effect): string {
  const parts = [e.type === 'inner-shadow' ? 'inset' : '', round(e.x), round(e.y), round(e.radius)];
  if (e.spread) parts.push(round(e.spread));
  parts.push(e.color);
  if (e.opacity < 1) parts.push(`${Math.round(e.opacity * 100)}%`);
  if (!e.visible) parts.push('hidden');
  return parts.filter((p) => p !== '').join(' ');
}

/**
 * Reads one or more shadows: "x y blur [spread] colour [opacity%]", optionally
 * "inset" (inner shadow) and "hidden". Several shadows are separated by commas.
 * Throws a readable Error on bad input.
 */
export function parseShadows(value: string): Effect[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const parts = s.split(/\s+/);
      const inset = parts.includes('inset');
      const hidden = parts.includes('hidden');
      const nums = parts.filter((p) => /^-?\d+(\.\d+)?$/.test(p)).map(Number);
      const pct = parts.find((p) => /^\d+(\.\d+)?%$/.test(p));
      const hex = parts.find((p) => /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(p));
      if (nums.length < 2 || nums.length > 4) throw new Error(`Cannot read shadow "${s}" — use "x y blur [spread] #RRGGBB [opacity%]"`);
      const e = defaultEffect(inset ? 'inner-shadow' : 'drop-shadow');
      e.x = nums[0];
      e.y = nums[1];
      e.radius = Math.max(0, nums[2] ?? 0);
      e.spread = nums[3] ?? 0;
      e.visible = !hidden;
      if (hex) {
        e.color = hex.slice(0, 7).toUpperCase();
        e.opacity = hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
      }
      if (pct) e.opacity = Math.max(0, Math.min(1, parseFloat(pct) / 100));
      return e;
    });
}

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1, 7), 16) || 0;
  return alpha >= 1 ? hex.toUpperCase() : `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(alpha * 1000) / 1000})`;
}

/** CSS for a layer's effects: box-shadow (text-shadow for text), filter and backdrop-filter. */
export function cssEffects(node: SceneNode): Record<string, string> {
  const css: Record<string, string> = {};
  const visible = node.effects.filter((e) => e.visible);
  const px = (n: number) => (n ? `${round(n)}px` : '0');
  const shadows = visible.filter(isShadow);
  if (node.type === 'text') {
    const drops = shadows.filter((e) => e.type === 'drop-shadow');
    if (drops.length) css['text-shadow'] = drops.map((e) => `${px(e.x)} ${px(e.y)} ${px(e.radius)} ${rgba(e.color, e.opacity)}`).join(', ');
  } else if (shadows.length) {
    css['box-shadow'] = shadows
      .map((e) => `${e.type === 'inner-shadow' ? 'inset ' : ''}${px(e.x)} ${px(e.y)} ${px(e.radius)}${e.spread ? ` ${px(e.spread)}` : ''} ${rgba(e.color, e.opacity)}`)
      .join(', ');
  }
  const blur = visible.find((e) => e.type === 'layer-blur');
  if (blur) css.filter = `blur(${px(blur.radius / 2)})`;
  const backdrop = visible.find((e) => e.type === 'background-blur');
  if (backdrop) css['backdrop-filter'] = `blur(${px(backdrop.radius / 2)})`;
  return css;
}
