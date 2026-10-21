// Which web fonts a document needs, and how to request them from Google Fonts.

import type { PlanarDocument } from './types';

/** Suggestions for the font picker (any family name is accepted). */
export const POPULAR_FONTS = [
  'Inter', 'Roboto', 'Manrope', 'Montserrat', 'Open Sans', 'Lato', 'Poppins', 'Nunito', 'Raleway', 'Rubik', 'Work Sans', 'DM Sans',
  'Space Grotesk', 'IBM Plex Sans', 'Golos Text', 'Onest', 'Unbounded', 'Exo 2', 'Oswald', 'Bebas Neue', 'PT Sans', 'Noto Sans',
  'Playfair Display', 'Merriweather', 'Lora', 'PT Serif', 'Source Serif 4', 'JetBrains Mono', 'Fira Code', 'Roboto Mono',
];

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'cursive', 'fantasy', 'emoji', 'math', 'fangsong']);

/** Families that come with common operating systems — never fetched. */
const SYSTEM = new Set([
  'arial', 'helvetica', 'helvetica neue', 'georgia', 'times', 'times new roman', 'verdana', 'tahoma', 'trebuchet ms', 'courier', 'courier new',
  'segoe ui', 'consolas', 'menlo', 'monaco', 'cascadia code', 'sf pro', 'sf pro text', 'sf pro display', 'sf mono', '-apple-system',
  'blinkmacsystemfont', 'impact', 'calibri', 'cambria', 'garamond', 'palatino', 'lucida grande', 'dejavu sans', 'liberation sans',
]);

/** First family of a CSS font-family list, unquoted. */
export function primaryFamily(css: string): string {
  return (css.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}

/** A family that should be loaded as a web font (not generic, not a system font). */
export function isWebFont(family: string): boolean {
  const f = family.trim().toLowerCase();
  return !!f && !GENERIC.has(f) && !SYSTEM.has(f);
}

/** Web font families used by text layers, with the weights each needs. */
export function webFonts(doc: PlanarDocument, ids?: Iterable<string>): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const nodes = ids ? [...ids].map((id) => doc.nodes[id]).filter(Boolean) : Object.values(doc.nodes);
  for (const n of nodes) {
    if (n.type !== 'text') continue;
    const family = primaryFamily(n.fontFamily);
    if (!isWebFont(family)) continue;
    const weights = out.get(family) ?? new Set<number>();
    weights.add(n.fontWeight);
    out.set(family, weights);
  }
  return out;
}

/** Google Fonts CSS URL for one family (a weight list, a "100..900" range, or regular only). */
export function googleFontsUrl(family: string, weights?: number[] | '100..900'): string {
  const name = encodeURIComponent(family).replace(/%20/g, '+');
  const axis = weights === '100..900' ? ':wght@100..900' : weights?.length ? `:wght@${[...new Set(weights)].sort((a, b) => a - b).join(';')}` : '';
  return `https://fonts.googleapis.com/css2?family=${name}${axis}&display=swap`;
}

/** CSS @import lines for the web fonts used by some layers. */
export function fontImports(doc: PlanarDocument, ids?: Iterable<string>): string[] {
  return [...webFonts(doc, ids)].map(([family, weights]) => `@import url("${googleFontsUrl(family, [...weights])}");`);
}

/** CSS font-family value with quoting and a generic fallback. */
export function cssFontFamily(css: string): string {
  if (css.includes(',')) return css;
  const name = css.trim().replace(/^["']|["']$/g, '');
  if (GENERIC.has(name.toLowerCase())) return name;
  const quoted = /[\s\d]/.test(name) ? `"${name}"` : name;
  return `${quoted}, sans-serif`;
}
