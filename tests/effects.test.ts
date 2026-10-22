import { describe, expect, it } from 'vitest';
import { applyProps, describe as describeLayer } from '../src/agent/props';
import { generateCode } from '../src/codegen/codegen';
import { createDocument, createNode, insertNode, parseDocument } from '../src/core/document';
import { cssEffects, defaultEffect, effectOutset, parseShadows, shadowToString } from '../src/core/effects';
import { Editor } from '../src/core/editor';
import { exportBounds, exportSvg } from '../src/core/export';
import { applyOps } from '../src/core/ops';
import { initCanvas, renderPng } from '../src/agent/raster';

function card() {
  const doc = createDocument();
  const node = createNode('rectangle', { name: 'Card', x: 0, y: 0, width: 100, height: 50 });
  insertNode(doc, node, doc.pageIds[0]);
  return { doc, node };
}

describe('effects', () => {
  it('reads and writes the shadow text form', () => {
    const [a, b] = parseShadows('0 4 12 #000000 25%, inset 1 2 3 4 #FF000080');
    expect(a).toMatchObject({ type: 'drop-shadow', x: 0, y: 4, radius: 12, spread: 0, color: '#000000', opacity: 0.25 });
    expect(b).toMatchObject({ type: 'inner-shadow', x: 1, y: 2, radius: 3, spread: 4, color: '#FF0000' });
    expect(b.opacity).toBeCloseTo(0.5, 2);
    expect(shadowToString(a)).toBe('0 4 12 #000000 25%');
    expect(() => parseShadows('big shadow')).toThrow(/Cannot read shadow/);
  });

  it('cleans effects from files and from old clients', () => {
    const { doc, node } = card();
    const raw = JSON.parse(JSON.stringify(doc));
    raw.nodes[node.id].effects = [{ type: 'drop-shadow', radius: -5, color: 'red' }, { type: 'glow' }, null];
    const parsed = parseDocument(raw);
    expect(parsed.nodes[node.id].effects).toEqual([{ ...defaultEffect('drop-shadow'), radius: 0 }]);

    const old = { ...node } as Partial<typeof node>;
    delete old.effects;
    applyOps(doc, [{ o: 'node', id: node.id, node: old as typeof node }]);
    expect(doc.nodes[node.id].effects).toEqual([]);
  });

  it('extends export bounds by what shadows and blurs reach', () => {
    const { doc, node } = card();
    node.effects = [{ ...defaultEffect('drop-shadow'), x: 0, y: 4, radius: 10, spread: 2 }];
    expect(effectOutset(node)).toEqual({ left: 12, right: 12, top: 8, bottom: 16 });
    expect(exportBounds(doc, [node.id])).toEqual({ x: -12, y: -8, width: 124, height: 74 });
    node.effects[0].visible = false;
    expect(exportBounds(doc, [node.id])).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it('exports shadows and blurs to SVG filters and CSS', () => {
    const { doc, node } = card();
    node.effects = [...parseShadows('0 4 8 #000000 20%, inset 0 1 0 #FFFFFF'), { ...defaultEffect('layer-blur'), radius: 6 }, defaultEffect('background-blur')];
    const svg = exportSvg(doc, [node.id])!;
    expect(svg).toContain('<filter');
    expect(svg).toContain('feGaussianBlur');
    expect(svg).toContain('tableValues="1 0"');
    expect(svg).toMatch(/<g[^>]*filter="url\(#planar-fx-\d+\)"/);
    const css = cssEffects(node);
    expect(css['box-shadow']).toBe('0 4px 8px rgba(0, 0, 0, 0.2), inset 0 1px 0 #FFFFFF');
    expect(css.filter).toBe('blur(3px)');
    expect(css['backdrop-filter']).toBe('blur(4px)');
    expect(generateCode(doc, node.id, 'css').code).toContain('box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2)');
  });

  it('paints a drop shadow outside the layer (when the optional renderer is installed)', async () => {
    const mod = await initCanvas();
    if (!mod) return;
    const { doc, node } = card();
    node.fills = [{ type: 'solid', color: '#FFFFFF', opacity: 1, visible: true }];
    node.effects = parseShadows('0 10 0 #FF0000');
    const png = await renderPng(doc, [node.id]);
    const img = await mod.loadImage(png);
    const c = mod.createCanvas(img.width, img.height).getContext('2d');
    c.drawImage(img, 0, 0);
    expect([img.width, img.height]).toEqual([100, 60]);
    // Below the card: the red shadow; inside: the white fill.
    expect([...c.getImageData(50, 55, 1, 1).data]).toEqual([255, 0, 0, 255]);
    expect([...c.getImageData(50, 25, 1, 1).data]).toEqual([255, 255, 255, 255]);
  });

  it('uses text-shadow for text', () => {
    const t = createNode('text', { characters: 'Hi' });
    t.effects = parseShadows('1 1 2 #000000');
    expect(cssEffects(t)).toEqual({ 'text-shadow': '1px 1px 2px #000000' });
  });

  it('agents set and read shadow, blur and backgroundBlur', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const node = createNode('frame', { name: 'Panel' });
    editor.change((d) => insertNode(d, node, editor.pageId));
    applyProps(editor, node.id, { shadow: '0 2 6 #000000 30%', blur: 4, backgroundBlur: 20 });
    const out = describeLayer(editor.doc, editor.doc.nodes[node.id]);
    expect(out.shadow).toBe('0 2 6 #000000 30%');
    expect(out.blur).toBe(4);
    expect(out.backgroundBlur).toBe(20);
    applyProps(editor, node.id, { shadow: null, blur: 0 });
    expect(editor.doc.nodes[node.id].effects.map((e) => e.type)).toEqual(['background-blur']);
    expect(() => applyProps(editor, node.id, { shadow: 'nope' })).toThrow(/Cannot read shadow/);
  });
});
