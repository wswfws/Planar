import { describe, expect, it } from 'vitest';
import { createDocument, createNode, insertNode } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { applyAutoLayout, insertionIndex } from '../src/core/layout';
import type { PlanarDocument, SceneNode } from '../src/core/types';

function setup(frameProps: Partial<SceneNode>, sizes: [number, number][]) {
  const doc = createDocument();
  const page = doc.pageIds[0];
  const frame = insertNode(
    doc,
    createNode('frame', { width: 300, height: 100, layoutMode: 'horizontal', itemSpacing: 10, ...frameProps }),
    page,
  );
  const kids = sizes.map(([w, h]) => insertNode(doc, createNode('rectangle', { width: w, height: h, x: 999, y: 999 }), frame.id));
  return { doc, page, frame, kids };
}

const pos = (doc: PlanarDocument, n: SceneNode) => [doc.nodes[n.id].x, doc.nodes[n.id].y];

describe('auto layout', () => {
  it('stacks children horizontally with padding and spacing', () => {
    const { doc, page, kids } = setup({ paddingLeft: 20, paddingTop: 5 }, [
      [50, 40],
      [30, 20],
    ]);
    applyAutoLayout(doc, page);
    expect(pos(doc, kids[0])).toEqual([20, 5]);
    expect(pos(doc, kids[1])).toEqual([80, 5]);
  });

  it('hugs content', () => {
    const { doc, page, frame } = setup({ sizingH: 'hug', sizingV: 'hug', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }, [
      [50, 40],
      [30, 20],
    ]);
    applyAutoLayout(doc, page);
    expect(doc.nodes[frame.id]).toMatchObject({ width: 8 + 50 + 10 + 30 + 8, height: 4 + 40 + 4 });
  });

  it('shares remaining space between fill children', () => {
    const { doc, page, kids } = setup({}, [
      [50, 40],
      [10, 20],
      [10, 20],
    ]);
    kids[1].sizingH = 'fill';
    kids[2].sizingH = 'fill';
    kids[0].sizingV = 'fill';
    applyAutoLayout(doc, page);
    // 300 - 50 - 2*10 = 230, split in two.
    expect(doc.nodes[kids[1].id].width).toBe(115);
    expect(doc.nodes[kids[2].id].x).toBe(50 + 10 + 115 + 10);
    expect(doc.nodes[kids[0].id].height).toBe(100);
  });

  it('aligns centre / end and space-between', () => {
    const { doc, page, frame, kids } = setup({ primaryAlign: 'center', counterAlign: 'end' }, [
      [50, 40],
      [50, 20],
    ]);
    applyAutoLayout(doc, page);
    expect(pos(doc, kids[0])).toEqual([95, 60]);
    expect(pos(doc, kids[1])).toEqual([155, 80]);
    frame.primaryAlign = 'space-between';
    applyAutoLayout(doc, page);
    expect(doc.nodes[kids[1].id].x).toBe(250);
  });

  it('lays out vertically and skips hidden and absolute children', () => {
    const { doc, page, kids } = setup({ layoutMode: 'vertical' }, [
      [50, 40],
      [50, 40],
      [50, 40],
    ]);
    kids[0].visible = false;
    kids[1].layoutAbsolute = true;
    applyAutoLayout(doc, page);
    expect(pos(doc, kids[2])).toEqual([0, 0]);
    expect(pos(doc, kids[1])).toEqual([999, 999]);
  });

  it('computes drop insertion index', () => {
    const { doc, page, frame, kids } = setup({}, [
      [50, 40],
      [50, 40],
      [50, 40],
    ]);
    applyAutoLayout(doc, page);
    expect(insertionIndex(doc, frame, { x: 0, y: 10 }, new Set())).toBe(0);
    expect(insertionIndex(doc, frame, { x: 70, y: 10 }, new Set())).toBe(1);
    expect(insertionIndex(doc, frame, { x: 290, y: 10 }, new Set())).toBe(3);
    expect(insertionIndex(doc, frame, { x: 290, y: 10 }, new Set([kids[0].id]))).toBe(2);
  });

  it('wraps a selection in an auto-layout frame without moving it', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const a = createNode('rectangle', { x: 100, y: 0, width: 40, height: 40 });
    const b = createNode('rectangle', { x: 0, y: 0, width: 40, height: 40 });
    editor.change((doc) => {
      insertNode(doc, a, editor.pageId);
      insertNode(doc, b, editor.pageId);
    });
    editor.select([a.id, b.id]);
    editor.addAutoLayout();
    const frame = editor.doc.nodes[editor.selection[0]];
    expect(frame).toMatchObject({ layoutMode: 'horizontal', itemSpacing: 60, width: 140, height: 40, x: 0, y: 0 });
    // Children are re-ordered left to right.
    expect(frame.children).toEqual([b.id, a.id]);
    expect(editor.doc.nodes[a.id]).toMatchObject({ x: 100, y: 0 });

    editor.updateNodes([frame.id], { itemSpacing: 4 });
    expect(editor.doc.nodes[frame.id].width).toBe(84);
    editor.select([b.id]);
    editor.nudge(1, 0);
    expect(editor.doc.nodes[frame.id].children).toEqual([a.id, b.id]);
    editor.undo();
    editor.undo();
    editor.undo();
    expect(editor.doc.nodes[frame.id]).toBeUndefined();
  });
});
