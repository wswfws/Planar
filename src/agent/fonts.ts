// Web fonts for server-side rendering: downloaded from Google Fonts as TTF,
// cached on disk and registered with the native canvas.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { googleFontsUrl, webFonts } from '../core/fonts';
import { clearTextMetrics } from '../core/text';
import type { PlanarDocument } from '../core/types';

const attempted = new Set<string>();
const cacheDir = process.env.PLANAR_FONT_CACHE ?? path.join(os.tmpdir(), 'planar-fonts');

type Fonts = { register(buf: Buffer, alias?: string): unknown; has(name: string): boolean };

async function fetchText(url: string): Promise<string | null> {
  try {
    // A plain user agent gets TrueType files, which the native renderer reads.
    const res = await fetch(url, { headers: { 'User-Agent': 'planar-mcp' }, signal: AbortSignal.timeout(10_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function fetchFile(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

const fileKey = (family: string, weight: number) => `${family.replace(/[^\w-]+/g, '_')}-${weight}.ttf`;

/** Makes sure one weight of a family is registered; returns true if newly added. */
async function ensureWeight(fonts: Fonts, family: string, weight: number): Promise<boolean> {
  const key = `${family}@${weight}`;
  if (attempted.has(key)) return false;
  attempted.add(key);
  const cached = path.join(cacheDir, fileKey(family, weight));
  let buf = await fs.readFile(cached).catch(() => null);
  if (!buf) {
    const css = await fetchText(googleFontsUrl(family, [weight]));
    const url = css && /url\((https:[^)]+)\)/.exec(css)?.[1];
    buf = url ? await fetchFile(url) : null;
    if (!buf) return false;
    await fs.mkdir(cacheDir, { recursive: true }).catch(() => undefined);
    await fs.writeFile(cached, buf).catch(() => undefined);
  }
  fonts.register(buf, family);
  return true;
}

/**
 * Registers every web font a document uses (all used weights plus regular).
 * Returns true when new fonts were added, so text should be re-measured.
 */
export async function ensureDocumentFonts(doc: PlanarDocument): Promise<boolean> {
  let mod: { GlobalFonts: Fonts };
  try {
    mod = (await import('@napi-rs/canvas')) as unknown as { GlobalFonts: Fonts };
  } catch {
    return false;
  }
  let added = false;
  for (const [family, weights] of webFonts(doc)) {
    for (const w of new Set([400, ...weights])) {
      if (await ensureWeight(mod.GlobalFonts, family, w)) added = true;
    }
  }
  if (added) clearTextMetrics();
  return added;
}
