import type { SceneNode } from './types';

type Measurer = (text: string, font: string, fontSize: number) => number;

let ctx: CanvasRenderingContext2D | null | undefined;

/** Lets non-browser hosts (the agent server) provide a canvas for measuring. */
export function setMeasureContext(context: CanvasRenderingContext2D | null): void {
  ctx = context;
  metricsCache.clear();
}

const measureWidth: Measurer = (text, font, fontSize) => {
  if (ctx === undefined) {
    ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  }
  if (!ctx) return text.length * fontSize * 0.55; // headless fallback (tests)
  ctx.font = font;
  return ctx.measureText(text).width;
};

export function fontString(node: Pick<SceneNode, 'fontWeight' | 'fontSize' | 'fontFamily'>): string {
  return `${node.fontWeight} ${node.fontSize}px ${node.fontFamily}`;
}

const linesCache = new Map<string, string[]>();

/** Splits text into lines, wrapping words when maxWidth is given. */
export function layoutLines(node: SceneNode, maxWidth: number | null): string[] {
  const font = fontString(node);
  const paragraphs = node.characters.split('\n');
  if (maxWidth === null) return paragraphs;
  const key = `${font}|${maxWidth}|${node.characters}`;
  const cached = linesCache.get(key);
  if (cached) return cached;
  const lines = wrapParagraphs(paragraphs, font, node.fontSize, maxWidth);
  if (linesCache.size > 20000) linesCache.clear();
  linesCache.set(key, lines);
  return lines;
}

function wrapParagraphs(paragraphs: string[], font: string, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (line && measureWidth(candidate.trimEnd(), font, fontSize) > maxWidth) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Line box height; a line height of 0 means "auto" (the font's own). */
export function lineHeightPx(node: SceneNode): number {
  if (node.lineHeight > 0) return node.fontSize * node.lineHeight;
  const { ascent, descent } = fontMetrics(node);
  return ascent + descent;
}

const metricsCache = new Map<string, { ascent: number; descent: number }>();

/** Font ascent/descent in px, as the browser uses them for line boxes. */
export function fontMetrics(node: Pick<SceneNode, 'fontWeight' | 'fontSize' | 'fontFamily'>): { ascent: number; descent: number } {
  const font = fontString(node);
  const cached = metricsCache.get(font);
  if (cached) return cached;
  if (ctx === undefined) measureWidth('', font, node.fontSize);
  let result = { ascent: node.fontSize * 0.8, descent: node.fontSize * 0.2 };
  if (ctx) {
    ctx.font = font;
    const m = ctx.measureText('Hg');
    if (Number.isFinite(m.fontBoundingBoxAscent) && m.fontBoundingBoxAscent > 0) {
      result = { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
    }
  }
  metricsCache.set(font, result);
  return result;
}

/** Forget cached font metrics (after new fonts were loaded). */
export function clearTextMetrics(): void {
  metricsCache.clear();
  linesCache.clear();
}

/** Fonts may finish loading after first use; forget cached metrics then. */
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.addEventListener?.('loadingdone', () => clearTextMetrics());
}

/**
 * Distance from the top of a line box to the alphabetic baseline. Like CSS,
 * the font's ascent+descent is centred in the line (half-leading).
 */
export function baselineInLine(node: SceneNode): number {
  const { ascent, descent } = fontMetrics(node);
  return (lineHeightPx(node) - (ascent + descent)) / 2 + ascent;
}

/** Lines as laid out for the node's current sizing mode. */
export function nodeLines(node: SceneNode): string[] {
  return layoutLines(node, node.autoWidth ? null : node.width);
}

export function contentHeight(node: SceneNode): number {
  return Math.max(1, nodeLines(node).length) * lineHeightPx(node);
}

/** Offset of the first line from the top of the box (vertical alignment). */
export function verticalOffset(node: SceneNode): number {
  if (node.autoWidth || node.autoHeight) return 0;
  const free = node.height - contentHeight(node);
  return node.textAlignVertical === 'middle' ? free / 2 : node.textAlignVertical === 'bottom' ? free : 0;
}

/** Size a text node should have given its content and sizing mode. */
export function measureTextNode(node: SceneNode): { width: number; height: number } {
  const font = fontString(node);
  const lines = nodeLines(node);
  const content = Math.max(1, lines.length) * lineHeightPx(node);
  if (!node.autoWidth) return { width: node.width, height: node.autoHeight ? content : node.height };
  const width = Math.max(...lines.map((l) => measureWidth(l, font, node.fontSize)), node.fontSize * 0.25);
  return { width: Math.ceil(width), height: content };
}
