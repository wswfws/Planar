import { describe, expect, it } from 'vitest';
import { generateCode } from '../src/codegen/codegen';
import { createDocument, createNode, insertNode, parseDocument } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { exportSvg } from '../src/core/export';
import { cssFontFamily, fontImports, primaryFamily, webFonts } from '../src/core/fonts';
import { parsePath, scaleD, segsBounds, segsToD } from '../src/core/paths';
import { looksLikeSvg, parseSvg } from '../src/core/svg';

const close = (a: number, b: number, d = 0.05) => expect(Math.abs(a - b)).toBeLessThan(d);

describe('path data', () => {
  it('normalises relative, shorthand and arc commands', () => {
    const segs = parsePath('m10 10 h20 v20 h-20 z M0 0 s10 10 20 0 t20 0 a5 5 0 0 1 10 0');
    const d = segsToD(segs);
    expect(d.startsWith('M 10 10 L 30 10 L 30 30 L 10 30 Z M 0 0 C')).toBe(true);
    expect(d).toMatch(/Q /);
    expect(d).not.toMatch(/[hvstaHVSTA]/);
  });

  it('measures curves tightly', () => {
    // A full circle of radius 10 around (50, 50).
    const b = segsBounds(parsePath('M40 50 A10 10 0 1 0 60 50 A10 10 0 1 0 40 50 Z'));
    close(b.x, 40);
    close(b.y, 40);
    close(b.width, 20);
    close(b.height, 20);
  });

  it('scales normalised data', () => {
    expect(scaleD('M 1 2 L 3 4 C 1 1 2 2 3 3 Z', 2, 10)).toBe('M 2 20 L 6 40 C 2 10 4 20 6 30 Z');
  });

  it('rejects garbage', () => {
    expect(() => parsePath('hello')).toThrow();
  });
});

const ICON = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <title>Music</title>
  <path d="M9 18V5l12-2v13"/>
  <circle cx="6" cy="18" r="3"/>
  <circle cx="18" cy="16" r="3" fill="#ff0000" stroke="none"/>
</svg>`;

describe('SVG import', () => {
  it('recognises SVG text', () => {
    expect(looksLikeSvg(ICON)).toBe(true);
    expect(looksLikeSvg('hello <svg>')).toBe(false);
  });

  it('reads shapes with inherited styles and viewBox scaling', () => {
    const svg = parseSvg(ICON.replace('width="24" height="24"', 'width="48" height="48"'));
    expect(svg.title).toBe('Music');
    expect(svg.width).toBe(48);
    expect(svg.shapes).toHaveLength(3);
    expect(svg.shapes[0].style.stroke).toMatchObject({ color: '#000000' });
    expect(svg.shapes[0].style.fill).toBeNull();
    expect(svg.shapes[2].style.fill).toMatchObject({ color: '#FF0000' });
    expect(svg.shapes[2].style.stroke).toBeNull();
    // The 2x viewBox scale applies to geometry and stroke width.
    const b = segsBounds(svg.shapes[1].segs);
    close(b.width, 12);
    expect(svg.shapes[0].scale).toBe(2);
  });

  it('applies nested transforms, rect corners and even-odd', () => {
    const svg = parseSvg(
      `<svg viewBox="0 0 100 100"><g transform="translate(10 20) scale(2)"><rect x="0" y="0" width="10" height="5" rx="2" fill="rgb(0, 128, 255)"/></g><path fill-rule="evenodd" style="fill:#123456" d="M0 0h10v10H0z"/></svg>`,
    );
    const rect = segsBounds(svg.shapes[0].segs);
    close(rect.x, 10);
    close(rect.y, 20);
    close(rect.width, 20);
    close(rect.height, 10);
    expect(svg.shapes[0].style.fill).toMatchObject({ color: '#0080FF' });
    expect(svg.shapes[1].style.fillRule).toBe('evenodd');
    expect(svg.shapes[1].style.fill).toMatchObject({ color: '#123456' });
  });

  it('imports into the editor as a frame of vector layers that survive save/load', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const id = editor.importSvg(ICON, { x: 100, y: 100 })!;
    const frame = editor.doc.nodes[id];
    expect(frame).toMatchObject({ type: 'frame', name: 'Music', width: 24, height: 24, x: 88, y: 88 });
    const vectors = frame.children.map((c) => editor.doc.nodes[c]);
    expect(vectors.map((v) => v.type)).toEqual(['vector', 'vector', 'vector']);
    expect(vectors[0].strokes[0]).toMatchObject({ color: '#000000' });
    expect(vectors[0].strokeWidth).toBe(2);
    const again = parseDocument(JSON.parse(JSON.stringify(editor.doc)));
    expect(again.nodes[vectors[1].id].paths[0].d).toBe(vectors[1].paths[0].d);
    // Exported SVG and generated code contain real paths; icon frames become one <svg>.
    expect(exportSvg(editor.doc, [id])).toMatch(/<path d="M /);
    const html = generateCode(editor.doc, id, 'html').code;
    expect(html).toMatch(/<svg viewBox="0 0 24 24"/);
    expect((html.match(/<path/g) ?? []).length).toBe(3);
  });

  it('resizing a vector scales its paths', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const id = editor.importSvg(ICON, { x: 0, y: 0 })!;
    const v = editor.doc.nodes[editor.doc.nodes[id].children[1]];
    const before = segsBounds(parsePath(exportSvg(editor.doc, [v.id])!.match(/d="([^"]+)"/)![1]));
    editor.updateNodes([v.id], { width: v.width * 2, height: v.height * 2 });
    const after = segsBounds(parsePath(exportSvg(editor.doc, [v.id])!.match(/d="([^"]+)"/)![1]));
    close(after.width, before.width * 2, 0.1);
  });
});

describe('web fonts', () => {
  it('finds web fonts and builds imports', () => {
    const doc = createDocument();
    const page = doc.pageIds[0];
    insertNode(doc, createNode('text', { fontFamily: 'Manrope', fontWeight: 700 }), page);
    insertNode(doc, createNode('text', { fontFamily: 'Manrope', fontWeight: 400 }), page);
    insertNode(doc, createNode('text', { fontFamily: '"Unbounded", sans-serif', fontWeight: 600 }), page);
    insertNode(doc, createNode('text', { fontFamily: 'Arial, sans-serif' }), page);
    insertNode(doc, createNode('text', { fontFamily: 'system-ui, sans-serif' }), page);
    expect(primaryFamily('"Open Sans", sans-serif')).toBe('Open Sans');
    expect([...webFonts(doc).keys()]).toEqual(['Manrope', 'Unbounded']);
    expect(fontImports(doc)).toEqual([
      '@import url("https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&display=swap");',
      '@import url("https://fonts.googleapis.com/css2?family=Unbounded:wght@600&display=swap");',
    ]);
    expect(cssFontFamily('Open Sans')).toBe('"Open Sans", sans-serif');
    expect(cssFontFamily('Manrope')).toBe('Manrope, sans-serif');
  });
});
