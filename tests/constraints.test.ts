import { describe, expect, it } from 'vitest';
import { applyProps, describe as describeLayer } from '../src/agent/props';
import { generateCode } from '../src/codegen/codegen';
import { createInstanceNode } from '../src/core/components';
import { createDocument, createNode, insertNode } from '../src/core/document';
import { Editor } from '../src/core/editor';
import type { ConstraintH, ConstraintV } from '../src/core/types';

function setup(h: ConstraintH, v: ConstraintV) {
  const editor = new Editor(createDocument(), { autosave: false });
  const frame = createNode('frame', { name: 'Screen', width: 200, height: 100 });
  const box = createNode('rectangle', { name: 'Box', x: 20, y: 10, width: 40, height: 20, constraintH: h, constraintV: v });
  editor.change((d) => {
    insertNode(d, frame, editor.pageId);
    insertNode(d, box, frame.id);
  });
  return { editor, frame, box };
}

const resize = (editor: Editor, id: string, width: number, height: number) => applyProps(editor, id, { width, height });

describe('constraints', () => {
  it.each([
    ['left', 'top', { x: 20, y: 10, width: 40, height: 20 }],
    ['right', 'bottom', { x: 120, y: 60, width: 40, height: 20 }],
    ['left-right', 'top-bottom', { x: 20, y: 10, width: 140, height: 70 }],
    ['center', 'center', { x: 70, y: 35, width: 40, height: 20 }],
    ['scale', 'scale', { x: 30, y: 15, width: 60, height: 30 }],
  ] as const)('%s / %s', (h, v, expected) => {
    const { editor, frame, box } = setup(h, v);
    resize(editor, frame.id, 300, 150);
    expect(editor.doc.nodes[box.id]).toMatchObject(expected);
  });

  it('nested frames follow their own constraints', () => {
    const { editor, frame, box } = setup('left-right', 'top');
    const inner = createNode('rectangle', { name: 'Dot', x: 30, y: 0, width: 10, height: 10, constraintH: 'right' });
    editor.change((d) => {
      const n = d.nodes[box.id];
      n.type = 'frame';
      insertNode(d, inner, n.id);
    });
    resize(editor, frame.id, 300, 100);
    expect(editor.doc.nodes[box.id].width).toBe(140);
    expect(editor.doc.nodes[inner.id].x).toBe(130);
  });

  it('applies inside resized instances, relative to the main component', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const comp = createNode('component', { name: 'Bar', width: 100, height: 40 });
    const label = createNode('rectangle', { name: 'Close', x: 80, y: 10, width: 10, height: 10, constraintH: 'right' });
    editor.change((d) => {
      insertNode(d, comp, editor.pageId);
      insertNode(d, label, comp.id);
    });
    let instId = '';
    editor.change((d) => {
      const inst = createInstanceNode(d, comp.id);
      instId = inst.id;
      insertNode(d, inst, editor.pageId);
    });
    resize(editor, instId, 250, 40);
    const child = editor.doc.nodes[editor.doc.nodes[instId].children[0]];
    expect(child.x).toBe(230);
    // Syncing again (any edit) keeps it in place instead of drifting.
    editor.updateNodes([comp.id], { name: 'Bar 2' });
    expect(editor.doc.nodes[editor.doc.nodes[instId].children[0]].x).toBe(230);
  });

  it('agents read and write constraints, and code uses right/bottom/percentages', () => {
    const { editor, frame, box } = setup('left', 'top');
    applyProps(editor, box.id, { constraints: 'right bottom' });
    expect(describeLayer(editor.doc, editor.doc.nodes[box.id]).constraints).toBe('right bottom');
    expect(() => applyProps(editor, box.id, { constraints: 'sideways' })).toThrow(/constraints must be/);
    applyProps(editor, box.id, { constraints: 'scale' });
    expect(editor.doc.nodes[box.id]).toMatchObject({ constraintH: 'scale', constraintV: 'scale' });
    const css = generateCode(editor.doc, frame.id, 'css').code;
    expect(css).toContain('left: 10%');
    expect(css).toContain('width: 20%');
    applyProps(editor, box.id, { constraints: 'right bottom' });
    const css2 = generateCode(editor.doc, frame.id, 'css').code;
    expect(css2).toContain('right: 140px');
    expect(css2).toContain('bottom: 70px');
  });
});

describe('wrapping auto layout', () => {
  function chips(count: number, width: number) {
    const editor = new Editor(createDocument(), { autosave: false });
    const row = createNode('frame', { name: 'Tags', width, layoutMode: 'horizontal', layoutWrap: true, itemSpacing: 10, counterSpacing: 6, sizingV: 'hug', paddingLeft: 5, paddingRight: 5 });
    const ids: string[] = [];
    editor.change((d) => {
      insertNode(d, row, editor.pageId);
      for (let i = 0; i < count; i++) ids.push(insertNode(d, createNode('rectangle', { width: 50, height: 20 }), row.id).id);
    });
    return { editor, row, ids };
  }

  it('starts new rows and hugs their total height', () => {
    // 5 + 50 + 10 + 50 + 10 + 50 + 5 = 180 fits three per row.
    const { editor, row, ids } = chips(5, 180);
    const pos = ids.map((id) => [editor.doc.nodes[id].x, editor.doc.nodes[id].y]);
    expect(pos).toEqual([
      [5, 0],
      [65, 0],
      [125, 0],
      [5, 26],
      [65, 26],
    ]);
    expect(editor.doc.nodes[row.id].height).toBe(46);
  });

  it('agents set wrap and rowGap, and code uses flex-wrap', () => {
    const { editor, row } = chips(4, 180);
    applyProps(editor, row.id, { rowGap: 12 });
    const out = describeLayer(editor.doc, editor.doc.nodes[row.id]);
    expect(out).toMatchObject({ wrap: true, rowGap: 12 });
    expect(editor.doc.nodes[row.id].height).toBe(52);
    const css = generateCode(editor.doc, row.id, 'css').code;
    expect(css).toContain('flex-wrap: wrap');
    expect(css).toContain('row-gap: 12px');
    expect(css).toContain('column-gap: 10px');
    applyProps(editor, row.id, { wrap: false });
    expect(editor.doc.nodes[row.id].height).toBe(20);
  });
});
