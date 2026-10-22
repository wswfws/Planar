// Text and effect styles: named settings that layers follow until edited by hand.

import { sanitizeEffects } from './effects';
import { measureTextNode } from './text';
import type { EffectStyle, PlanarDocument, SceneNode, Style, TextStyle } from './types';

/** Layer fields a text style sets; editing one by hand detaches the layer. */
export const TEXT_STYLE_FIELDS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight'] as const;

/** Normalises untrusted style lists (files, ops). */
export function sanitizeStyles(raw: unknown): Style[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const out: Style[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || typeof s.name !== 'string') continue;
    const library = s.library && typeof s.library.fileId === 'string' ? { library: { fileId: s.library.fileId, key: String(s.library.key) } } : {};
    if (s.type === 'text') {
      out.push({
        id: s.id,
        name: s.name,
        type: 'text',
        fontFamily: typeof s.fontFamily === 'string' ? s.fontFamily : 'system-ui, sans-serif',
        fontSize: Math.max(1, num(s.fontSize, 16)),
        fontWeight: num(s.fontWeight, 400),
        lineHeight: Math.max(0, num(s.lineHeight, 0)),
        ...library,
      });
    } else if (s.type === 'effect') {
      out.push({ id: s.id, name: s.name, type: 'effect', effects: sanitizeEffects(s.effects), ...library });
    }
  }
  return out;
}

export function textStyleOf(doc: PlanarDocument, id: string): TextStyle | null {
  const s = id ? doc.styles.find((x) => x.id === id) : null;
  return s?.type === 'text' ? s : null;
}

export function effectStyleOf(doc: PlanarDocument, id: string): EffectStyle | null {
  const s = id ? doc.styles.find((x) => x.id === id) : null;
  return s?.type === 'effect' ? s : null;
}

/** The style's values taken from a layer (for "create style from selection"). */
export function textStyleValues(node: SceneNode): Omit<TextStyle, 'id' | 'name' | 'type'> {
  return { fontFamily: node.fontFamily, fontSize: node.fontSize, fontWeight: node.fontWeight, lineHeight: node.lineHeight };
}

/**
 * Copies style values into the layers that use them; a reference to a
 * deleted style is dropped. Returns whether anything changed.
 */
export function applyStyles(doc: PlanarDocument): boolean {
  if (!doc.styles) doc.styles = [];
  let changed = false;
  for (const n of Object.values(doc.nodes)) {
    if (n.textStyleId) {
      const s = textStyleOf(doc, n.textStyleId);
      if (!s) {
        n.textStyleId = '';
        changed = true;
      } else if (TEXT_STYLE_FIELDS.some((k) => n[k] !== s[k])) {
        for (const k of TEXT_STYLE_FIELDS) (n as unknown as Record<string, unknown>)[k] = s[k];
        if (n.type === 'text') {
          const size = measureTextNode(n);
          n.width = size.width;
          n.height = size.height;
        }
        changed = true;
      }
    }
    if (n.effectStyleId) {
      const s = effectStyleOf(doc, n.effectStyleId);
      if (!s) {
        n.effectStyleId = '';
        changed = true;
      } else if (JSON.stringify(n.effects) !== JSON.stringify(s.effects)) {
        n.effects = structuredClone(s.effects);
        changed = true;
      }
    }
  }
  return changed;
}
