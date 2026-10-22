import { describe, expect, it } from 'vitest';
import { applyProps, describe as describeLayer } from '../src/agent/props';
import { generateCode } from '../src/codegen/codegen';
import { createDocument, createNode, insertNode, parseDocument, solid } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { exportSvg } from '../src/core/export';
import { hitTest } from '../src/core/geometry';
import { insertionIndex } from '../src/core/layout';
import { figmaToPlanar } from '../src/import/figma';
import type { SceneNode } from '../src/core/types';

function grid(props: Partial<SceneNode> = {}, sizes: [number, number][] = [[40, 20], [60, 30], [50, 10], [30, 50], [20, 20]]) {
  const editor = new Editor(createDocument(), { autosave: false });
  const frame = createNode('frame', { name: 'Grid', width: 300, height: 200, layoutMode: 'grid', gridColumns: 2, itemSpacing: 10, counterSpacing: 6, paddingTop: 5, paddingLeft: 5, paddingRight: 5, paddingBottom: 5, ...props });
  const kids = sizes.map(([w, h], i) => createNode('rectangle', { name: `R${i}`, width: w, height: h }));
  editor.change((d) => {
    insertNode(d, frame, editor.pageId);
    for (const k of kids) insertNode(d, k, frame.id);
  });
  const at = (i: number) => {
    const n = editor.doc.nodes[kids[i].id];
    return [n.x, n.y, n.width, n.height];
  };
  return { editor, frame: editor.doc.nodes[frame.id], kids, at };
}

describe('grid layout', () => {
  it('fills cells row by row with equal columns and rows as tall as their tallest item', () => {
    const { at } = grid();
    // Columns: (300 - 10 - 10) / 2 = 140 wide, starting at 5 and 155.
    expect(at(0)).toEqual([5, 5, 40, 20]);
    expect(at(1)).toEqual([155, 5, 60, 30]);
    // Row 1 starts after the 30 px tall first row and the 6 px row gap.
    expect(at(2)).toEqual([5, 41, 50, 10]);
    expect(at(3)).toEqual([155, 41, 30, 50]);
    expect(at(4)).toEqual([5, 97, 20, 20]);
  });

  it('hugs, fills cells, aligns in cells and shares a fixed height between set rows', () => {
    const hug = grid({ sizingH: 'hug', sizingV: 'hug' });
    // Column widths 50 and 60 (widest per column).
    expect(hug.frame.width).toBe(5 + 50 + 10 + 60 + 5);
    expect(hug.frame.height).toBe(5 + 30 + 6 + 50 + 6 + 20 + 5);

    const g = grid({ gridRows: 2, height: 116, primaryAlign: 'center', counterAlign: 'end' }, [[40, 20], [60, 30]]);
    // Two rows of (116 - 10 - 6) / 2 = 50; item centred across its 140 px column, at the bottom of its row.
    expect(g.at(0)).toEqual([5 + 50, 5 + 30, 40, 20]);
    g.editor.updateNodes([g.kids[1].id], { sizingH: 'fill', sizingV: 'fill' });
    expect(g.at(1)).toEqual([155, 5, 140, 50]);
  });

  it('inserts dragged layers in reading order and moves by rows with arrow keys', () => {
    const { editor, frame, kids } = grid();
    expect(insertionIndex(editor.doc, frame, { x: 170, y: 10 }, new Set())).toBe(1);
    expect(insertionIndex(editor.doc, frame, { x: 10, y: 45 }, new Set())).toBe(2);
    expect(insertionIndex(editor.doc, frame, { x: 290, y: 190 }, new Set())).toBe(5);
    editor.select([kids[0].id]);
    editor.nudge(0, 1);
    expect(editor.doc.nodes[frame.id].children.indexOf(kids[0].id)).toBe(2);
  });
});

describe('strokes, stacking and aspect', () => {
  it('included strokes take space in auto layout', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const frame = createNode('frame', { layoutMode: 'horizontal', sizingH: 'hug', sizingV: 'hug', itemSpacing: 0, strokes: [solid('#000000')], strokeWidth: 4 });
    const a = createNode('rectangle', { width: 10, height: 10, strokes: [solid('#000000')], strokeWidth: 2 });
    const b = createNode('rectangle', { width: 10, height: 10 });
    editor.change((d) => {
      insertNode(d, frame, editor.pageId);
      insertNode(d, a, frame.id);
      insertNode(d, b, frame.id);
    });
    expect(editor.doc.nodes[frame.id].width).toBe(20);
    editor.updateNodes([frame.id], { strokesIncluded: true });
    // Frame stroke inner half (2) on each side, child a with its 2 px stroke is 12 wide.
    expect(editor.doc.nodes[frame.id].width).toBe(2 + 12 + 10 + 2);
    expect(editor.doc.nodes[a.id].x).toBe(3);
    expect(editor.doc.nodes[b.id].x).toBe(14);
  });

  it('"first on top" paints and picks earlier items over later ones', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const frame = createNode('frame', { layoutMode: 'horizontal', itemSpacing: -10, width: 100, height: 20 });
    const a = createNode('rectangle', { name: 'A', width: 20, height: 20, fills: [solid('#FF0000')] });
    const b = createNode('rectangle', { name: 'B', width: 20, height: 20, fills: [solid('#0000FF')] });
    editor.change((d) => {
      insertNode(d, frame, editor.pageId);
      insertNode(d, a, frame.id);
      insertNode(d, b, frame.id);
    });
    // Overlap at x 10..20.
    expect(hitTest(editor.doc, editor.pageId, { x: 15, y: 10 }, 0)).toBe(b.id);
    editor.updateNodes([frame.id], { reverseStacking: true });
    expect(hitTest(editor.doc, editor.pageId, { x: 15, y: 10 }, 0)).toBe(a.id);
    const svg = exportSvg(editor.doc, [frame.id])!;
    expect(svg.indexOf('#0000FF')).toBeLessThan(svg.indexOf('#FF0000'));
    expect(generateCode(editor.doc, frame.id, 'html').code).toMatch(/z-index: 2/);
  });

  it('keeps the ratio when resizing with the aspect locked', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const r = createNode('rectangle', { width: 100, height: 50, lockAspect: true });
    editor.change((d) => insertNode(d, r, editor.pageId));
    const json = JSON.parse(JSON.stringify(editor.doc));
    expect(parseDocument(json).nodes[r.id].lockAspect).toBe(true);
  });
});

describe('grid in code, for agents and from Figma', () => {
  it('exports CSS grid', () => {
    const { editor, frame, kids } = grid({ gridRows: 3 });
    editor.updateNodes([kids[0].id], { sizingH: 'fill' });
    const code = generateCode(editor.doc, frame.id, 'html').code;
    expect(code).toMatch(/display: grid;/);
    expect(code).toMatch(/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(code).toMatch(/grid-template-rows: repeat\(3, minmax\(0, 1fr\)\);/);
    expect(code).toMatch(/column-gap: 10px;/);
    expect(code).toMatch(/row-gap: 6px;/);
    expect(code).toMatch(/justify-self: stretch;/);
  });

  it('round-trips through the agent vocabulary', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const f = createNode('frame', { width: 200, height: 200 });
    editor.change((d) => insertNode(d, f, editor.pageId));
    editor.begin();
    const warnings = applyProps(editor, f.id, { layout: 'grid', columns: 3, rows: 2, gap: 8, rowGap: 4, strokesIncluded: true, stacking: 'first-on-top', lockAspect: true });
    editor.commit();
    expect(warnings).toEqual([]);
    expect(describeLayer(editor.doc, editor.doc.nodes[f.id])).toMatchObject({ layout: 'grid', columns: 3, rows: 2, gap: 8, rowGap: 4, strokesIncluded: true, stacking: 'first-on-top', lockAspect: true });
    editor.begin();
    expect(() => applyProps(editor, f.id, { columns: 0 })).toThrow(/columns/);
    editor.cancel();
  });

  it('imports Figma grid auto layout', () => {
    const { doc } = figmaToPlanar({
      name: 'F',
      document: {
        id: '0:0',
        type: 'DOCUMENT',
        children: [
          {
            id: '0:1',
            name: 'P',
            type: 'CANVAS',
            children: [
              { id: '1:1', name: 'Cards', type: 'FRAME', layoutMode: 'GRID', gridColumnCount: 3, gridRowCount: 2, gridColumnGap: 12, gridRowGap: 8, strokesIncludedInLayout: true, itemReverseZIndex: true, relativeTransform: [[1, 0, 0], [0, 1, 0]], size: { x: 300, y: 200 }, fills: [], children: [] },
            ],
          },
        ],
      },
    });
    expect(Object.values(doc.nodes).find((n) => n.name === 'Cards')).toMatchObject({ layoutMode: 'grid', gridColumns: 3, gridRows: 2, itemSpacing: 12, counterSpacing: 8, strokesIncluded: true, reverseStacking: true });
  });
});
