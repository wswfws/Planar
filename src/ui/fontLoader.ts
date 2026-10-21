import type { Editor } from '../core/editor';
import { googleFontsUrl, webFonts } from '../core/fonts';
import { clearTextMetrics } from '../core/text';

const requested = new Map<string, Promise<boolean>>();

/** Loads a family from Google Fonts (variable range first, then regular). */
async function loadFamily(family: string): Promise<boolean> {
  for (const url of [googleFontsUrl(family, '100..900'), googleFontsUrl(family)]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const style = document.createElement('style');
      style.dataset.planarFont = family;
      style.textContent = await res.text();
      document.head.appendChild(style);
      await Promise.all([400, 500, 600, 700].map((w) => document.fonts.load(`${w} 16px "${family}"`))).catch(() => undefined);
      return true;
    } catch {
      // Offline or blocked: keep the fallback font.
    }
  }
  return false;
}

/** Keeps the document's web fonts loaded and text measured with them. */
export function watchFonts(editor: Editor): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    timer = null;
    for (const family of webFonts(editor.doc).keys()) {
      if (requested.has(family)) continue;
      requested.set(
        family,
        loadFamily(family).then((ok) => {
          if (ok) {
            clearTextMetrics();
            editor.remeasureText();
          }
          return ok;
        }),
      );
    }
  };
  check();
  const unsubscribe = editor.subscribe(() => {
    if (!timer) timer = setTimeout(check, 300);
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
