import { describe, expect, it } from 'vitest';
import { cloneSubtree, createDocument, createNode, insertNode, parseDocument, removeNode } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { exportSvg } from '../src/core/export';
import { fitGroups, hitTest, reparentKeepWorld, worldBounds, worldCenter, worldRotation } from '../src/core/geometry';
import { apply, invert, multiply, rotation, translation } from '../src/core/math';
import { evaluateExpression, normalizeHex } from '../src/ui/controls';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('math', () => {
  it('inverts affine matrices', () => {
    const m = multiply(translation(10, -4), rotation(0.7));
    const p = { x: 3, y: 9 };
    const back = apply(invert(m), apply(m, p));
    close(back.x, 3);
    close(back.y, 9);
  });
});

describe('document tree', () => {
  it('inserts, clones and removes subtrees', () => {
    const doc = createDocument();
    const page = doc.pageIds[0];
    const frame = insertNode(doc, createNode('frame'), page);
    insertNode(doc, createNode('rectangle'), frame.id);
    const copy = cloneSubtree(doc.nodes, frame.id);
    expect(copy).toHaveLength(2);
    expect(copy[0].id).not.toBe(frame.id);
    expect(copy[1].parentId).toBe(copy[0].id);
    removeNode(doc, frame.id);
    expect(Object.keys(doc.nodes)).toEqual([page]);
  });

  it('rejects invalid files', () => {
    expect(() => parseDocument({ hello: 1 })).toThrow();
    const doc = createDocument();
    expect(parseDocument(JSON.parse(JSON.stringify(doc))).pageIds).toEqual(doc.pageIds);
  });
});

describe('geometry', () => {
  it('composes rotated parents', () => {
    const doc = createDocument();
    const page = doc.pageIds[0];
    const frame = insertNode(doc, createNode('frame', { x: 100, y: 100, width: 200, height: 100, rotation: 90 }), page);
    const rect = insertNode(doc, createNode('rectangle', { x: 0, y: 0, width: 20, height: 20 }), frame.id);
    // Frame centre is (200,150); rotating 90° maps the frame's top-left (100,100) to (250,50).
    const c = worldCenter(doc, rect.id);
    close(c.x, 240);
    close(c.y, 60);
    close(worldRotation(doc, rect.id), 90);
  });

  it('keeps world position when re-parenting', () => {
    const doc = createDocument();
    const page = doc.pageIds[0];
    const frame = insertNode(doc, createNode('frame', { x: 50, y: 50, width: 300, height: 300, rotation: 30 }), page);
    const rect = insertNode(doc, createNode('rectangle', { x: 120, y: 80, width: 40, height: 30, rotation: 10 }), page);
    const before = worldCenter(doc, rect.id);
    reparentKeepWorld(doc, rect.id, frame.id);
    const after = worldCenter(doc, rect.id);
    close(after.x, before.x);
    close(after.y, before.y);
    close(worldRotation(doc, rect.id), 10);
    close(doc.nodes[rect.id].rotation, -20);
  });

  it('fits groups to their children', () => {
    const doc = createDocument();
    const page = doc.pageIds[0];
    const group = insertNode(doc, createNode('group', { width: 0, height: 0 }), page);
    insertNode(doc, createNode('rectangle', { x: 10, y: 20, width: 30, height: 40 }), group.id);
    const r2 = insertNode(doc, createNode('ellipse', { x: 100, y: 100, width: 10, height: 10 }), group.id);
    fitGroups(doc, page);
    expect(doc.nodes[group.id]).toMatchObject({ x: 10, y: 20, width: 100, height: 90 });
    expect(worldBounds(doc, r2.id)).toMatchObject({ x: 100, y: 100 });
  });

  it('hit-tests through clipping frames', () => {
    const doc = createDocument();
    const page = doc.pageIds[0];
    const frame = insertNode(doc, createNode('frame', { width: 100, height: 100 }), page);
    const rect = insertNode(doc, createNode('rectangle', { x: 80, y: 80, width: 50, height: 50 }), frame.id);
    expect(hitTest(doc, page, { x: 90, y: 90 }, 0)).toBe(rect.id);
    expect(hitTest(doc, page, { x: 10, y: 10 }, 0)).toBe(frame.id);
    expect(hitTest(doc, page, { x: 120, y: 120 }, 0)).toBe(null); // clipped
    doc.nodes[frame.id].clipContent = false;
    expect(hitTest(doc, page, { x: 120, y: 120 }, 0)).toBe(rect.id);
  });
});

describe('editor', () => {
  const setup = () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const page = editor.pageId;
    const a = createNode('rectangle', { x: 0, y: 0, width: 50, height: 50 });
    const b = createNode('rectangle', { x: 100, y: 40, width: 50, height: 50 });
    editor.change((doc) => {
      insertNode(doc, a, page);
      insertNode(doc, b, page);
    });
    return { editor, a: a.id, b: b.id };
  };

  it('undoes and redoes changes', () => {
    const { editor, a } = setup();
    editor.updateNodes([a], { x: 500 });
    expect(editor.doc.nodes[a].x).toBe(500);
    editor.undo();
    expect(editor.doc.nodes[a].x).toBe(0);
    editor.redo();
    expect(editor.doc.nodes[a].x).toBe(500);
  });

  it('groups and ungroups without moving layers', () => {
    const { editor, a, b } = setup();
    editor.select([a, b]);
    editor.group();
    const g = editor.selection[0];
    expect(editor.doc.nodes[g]).toMatchObject({ type: 'group', x: 0, y: 0, width: 150, height: 90 });
    editor.ungroup();
    expect(editor.doc.nodes[g]).toBeUndefined();
    expect(worldBounds(editor.doc, b)).toMatchObject({ x: 100, y: 40 });
  });

  it('aligns, duplicates and copy-pastes', () => {
    const { editor, a, b } = setup();
    editor.select([a, b]);
    editor.align('bottom');
    expect(editor.doc.nodes[a].y).toBe(40);
    editor.select([a]);
    const [dup] = editor.duplicateSelection();
    expect(editor.doc.nodes[dup]).toMatchObject({ x: 10, y: 50 });
    const text = editor.copySelection();
    expect(editor.paste(text)).toBe(true);
    expect(editor.page.children).toHaveLength(4);
    expect(editor.paste('not planar')).toBe(false);
  });

  it('reorders layers', () => {
    const { editor, a, b } = setup();
    editor.select([a]);
    editor.reorder('front');
    expect(editor.page.children).toEqual([b, a]);
  });
});

describe('export', () => {
  it('writes SVG for shapes and text', () => {
    const doc = createDocument();
    const page = doc.pageIds[0];
    const r = insertNode(doc, createNode('rectangle', { x: 10, y: 10, width: 20, height: 20, cornerRadius: 4 }), page);
    const t = insertNode(doc, createNode('text', { characters: 'Hi <there>', x: 0, y: 40 }), page);
    const svg = exportSvg(doc, [r.id, t.id])!;
    expect(svg).toContain('<svg');
    expect(svg).toContain('rx="4"');
    expect(svg).toContain('Hi &lt;there&gt;');
  });
});

describe('controls', () => {
  it('evaluates arithmetic', () => {
    expect(evaluateExpression('100+20')).toBe(120);
    expect(evaluateExpression('50*2-(10/2)')).toBe(95);
    expect(evaluateExpression('-3')).toBe(-3);
    expect(evaluateExpression('2+')).toBe(null);
    expect(evaluateExpression('alert(1)')).toBe(null);
  });

  it('normalises hex colours', () => {
    expect(normalizeHex('fff')).toBe('#FFFFFF');
    expect(normalizeHex('#1a2b3c')).toBe('#1A2B3C');
    expect(normalizeHex('zz')).toBe(null);
  });
});
