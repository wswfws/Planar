import type { SceneNode } from './types';

type Measurer = (text: string, font: string, fontSize: number) => number;

let ctx: CanvasRenderingContext2D | null | undefined;

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

/** Splits text into lines, wrapping words when maxWidth is given. */
export function layoutLines(node: SceneNode, maxWidth: number | null): string[] {
  const font = fontString(node);
  const paragraphs = node.characters.split('\n');
  if (maxWidth === null) return paragraphs;
  const lines: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (line && measureWidth(candidate.trimEnd(), font, node.fontSize) > maxWidth) {
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

export function lineHeightPx(node: SceneNode): number {
  return node.fontSize * node.lineHeight;
}

/** Size a text node should have given its content and sizing mode. */
export function measureTextNode(node: SceneNode): { width: number; height: number } {
  const font = fontString(node);
  const lines = layoutLines(node, node.autoWidth ? null : node.width);
  const height = Math.max(1, lines.length) * lineHeightPx(node);
  if (!node.autoWidth) return { width: node.width, height };
  const width = Math.max(...lines.map((l) => measureWidth(l, font, node.fontSize)), node.fontSize * 0.25);
  return { width: Math.ceil(width), height };
}
