import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { figmaFileKey, figmaToPlanar } from '../src/import/figma';

const white = { r: 1, g: 1, b: 1, a: 1 };
const black = { r: 0, g: 0, b: 0, a: 1 };
const at = (x: number, y: number) => [
  [1, 0, x],
  [0, 1, y],
];
const text = (id: string, characters: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'Label',
  type: 'TEXT',
  characters,
  relativeTransform: at(16, 10),
  size: { x: 60, y: 20 },
  fills: [{ type: 'SOLID', color: black }],
  style: { fontFamily: 'Inter', fontWeight: 500, fontSize: 14, textAutoResize: 'WIDTH_AND_HEIGHT', lineHeightUnit: 'INTRINSIC_%' },
  ...extra,
});

/** A small file in the shape of GET /v1/files/:key?geometry=paths. */
const FILE = {
  name: 'Shop',
  styles: { 'S:1': { key: 'k1', name: 'Heading/H1', styleType: 'TEXT' }, 'S:2': { key: 'k2', name: 'Shadow/Card', styleType: 'EFFECT' } },
  document: {
    id: '0:0',
    type: 'DOCUMENT',
    children: [
      {
        id: '0:1',
        name: 'Page 1',
        type: 'CANVAS',
        backgroundColor: { r: 0.9, g: 0.9, b: 0.9, a: 1 },
        children: [
          {
            id: '2:0',
            name: 'Button',
            type: 'COMPONENT_SET',
            relativeTransform: at(600, 0),
            size: { x: 200, y: 100 },
            fills: [],
            children: [
              { id: '2:1', name: 'State=Default', type: 'COMPONENT', relativeTransform: at(0, 0), size: { x: 120, y: 40 }, fills: [{ type: 'SOLID', color: { r: 0.36, g: 0.36, b: 0.84, a: 1 } }], cornerRadius: 8, children: [text('2:2', 'Click')] },
              { id: '2:3', name: 'State=Hover', type: 'COMPONENT', relativeTransform: at(0, 50), size: { x: 120, y: 40 }, fills: [{ type: 'SOLID', color: black }], children: [text('2:4', 'Click')] },
            ],
          },
          {
            id: '1:1',
            name: 'Screen',
            type: 'FRAME',
            relativeTransform: at(100, 50),
            size: { x: 375, y: 200 },
            clipsContent: true,
            fills: [{ type: 'SOLID', color: white }],
            effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0 }],
            styles: { effect: 'S:2' },
            layoutMode: 'VERTICAL',
            itemSpacing: 12,
            paddingLeft: 16,
            paddingRight: 16,
            paddingTop: 16,
            paddingBottom: 16,
            primaryAxisAlignItems: 'MIN',
            counterAxisAlignItems: 'CENTER',
            layoutSizingHorizontal: 'FIXED',
            layoutSizingVertical: 'HUG',
            children: [
              text('1:2', 'Hello', { name: 'Title', styles: { text: 'S:1' }, style: { fontFamily: 'Inter', fontWeight: 700, fontSize: 24, lineHeightPx: 32, lineHeightUnit: 'PIXELS', textAutoResize: 'WIDTH_AND_HEIGHT' } }),
              { id: '3:1', name: 'Button', type: 'INSTANCE', componentId: '2:1', relativeTransform: at(0, 0), size: { x: 120, y: 40 }, fills: [{ type: 'SOLID', color: { r: 0.36, g: 0.36, b: 0.84, a: 1 } }], cornerRadius: 8, children: [text('I3:1;2:2', 'Buy')] },
              { id: '1:3', name: 'Photo', type: 'RECTANGLE', relativeTransform: at(0, 0), size: { x: 343, y: 120 }, layoutSizingHorizontal: 'FILL', fills: [{ type: 'IMAGE', imageRef: 'abc', scaleMode: 'FIT' }] },
              { id: '1:4', name: 'Icon', type: 'VECTOR', relativeTransform: at(0, 0), size: { x: 10, y: 10 }, fills: [{ type: 'SOLID', color: black }], fillGeometry: [{ path: 'M0 0L10 0L10 10Z', windingRule: 'EVENODD' }] },
              { id: '1:5', name: 'Note', type: 'STICKY' },
            ],
          },
          { id: '1:6', name: 'Turned', type: 'RECTANGLE', relativeTransform: [[0, -1, 10], [1, 0, 0]], size: { x: 20, y: 10 }, constraints: { horizontal: 'LEFT_RIGHT', vertical: 'BOTTOM' }, fills: [] },
          {
            id: '1:7',
            name: 'Fade',
            type: 'RECTANGLE',
            relativeTransform: at(0, 300),
            size: { x: 10, y: 10 },
            fills: [{ type: 'GRADIENT_LINEAR', gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] }],
          },
        ],
      },
    ],
  },
};

const find = (doc: ReturnType<typeof figmaToPlanar>['doc'], name: string) => Object.values(doc.nodes).find((n) => n.name === name)!;

describe('Figma import', () => {
  it('converts pages, frames with auto layout, text, effects and styles', () => {
    const { doc, report, imageRefs } = figmaToPlanar(FILE);
    expect(doc.name).toBe('Shop');
    expect(doc.pageIds).toHaveLength(1);
    expect(doc.nodes[doc.pageIds[0]].fills[0]).toMatchObject({ color: '#E6E6E6' });
    const screen = find(doc, 'Screen');
    expect(screen).toMatchObject({ type: 'frame', x: 100, y: 50, width: 375, layoutMode: 'vertical', itemSpacing: 12, paddingLeft: 16, counterAlign: 'center', sizingV: 'hug', clipContent: true });
    expect(screen.effects[0]).toMatchObject({ type: 'drop-shadow', y: 4, radius: 12, opacity: 0.25 });
    expect(doc.styles.map((s) => s.name).sort()).toEqual(['Heading/H1', 'Shadow/Card']);
    const title = find(doc, 'Title');
    expect(title).toMatchObject({ characters: 'Hello', fontFamily: 'Inter', fontWeight: 700, fontSize: 24, autoWidth: true });
    expect(title.lineHeight).toBeCloseTo(1.33, 2);
    expect(doc.styles.find((s) => s.id === title.textStyleId)?.name).toBe('Heading/H1');
    expect(find(doc, 'Photo')).toMatchObject({ sizingH: 'fill', fills: [{ type: 'solid', color: '#D9D9D9' }] });
    expect(imageRefs).toEqual(['abc']);
    expect(report).toEqual(expect.arrayContaining(['1 × sticky layers', '1 × images not downloaded (grey instead)', '1 × gradient fills (average colour instead)']));
  });

  it('keeps components, variants and instance overrides', () => {
    const { doc } = figmaToPlanar(FILE);
    const set = find(doc, 'Button');
    expect(set.type).toBe('componentSet');
    const variants = set.children.map((id) => doc.nodes[id]);
    expect(variants.map((v) => v.variantProps)).toEqual([{ State: 'Default' }, { State: 'Hover' }]);
    const inst = Object.values(doc.nodes).find((n) => n.type === 'instance')!;
    expect(inst.componentId).toBe(variants[0].id);
    const label = doc.nodes[inst.children[0]];
    expect(label.sourceId).toBe(variants[0].children[0]);
    expect(label.overrides).toContain('characters');

    // Opening the document syncs instances with their components; the override survives.
    const editor = new Editor(parseDocument(JSON.parse(JSON.stringify(doc))), { autosave: false });
    editor.updateNodes([variants[0].id], { cornerRadius: 12 });
    expect(editor.doc.nodes[inst.id].cornerRadius).toBe(12);
    expect(editor.doc.nodes[label.id].characters).toBe('Buy');
  });

  it('reads transforms, vectors, constraints and downloaded images', () => {
    const { doc, report } = figmaToPlanar(FILE, { abc: 'data:image/png;base64,AAAA' });
    expect(find(doc, 'Turned')).toMatchObject({ x: -5, y: 5, width: 20, height: 10, rotation: 90, constraintH: 'left-right', constraintV: 'bottom' });
    const icon = find(doc, 'Icon');
    expect(icon.paths).toEqual([expect.objectContaining({ fillRule: 'evenodd' })]);
    expect(icon.pathBox).toEqual({ w: 10, h: 10 });
    expect(find(doc, 'Photo').fills[0]).toMatchObject({ type: 'image', src: 'data:image/png;base64,AAAA', scaleMode: 'fit' });
    expect(report.join()).not.toMatch(/images not downloaded/);
    expect(find(doc, 'Fade').fills[0]).toMatchObject({ color: '#800080' });
  });

  it('refuses other JSON and reads file keys from links', () => {
    expect(() => figmaToPlanar({ format: 'planar' })).toThrow(/not a Figma file/);
    expect(figmaFileKey('https://www.figma.com/design/AbC123xyz456/My-file?node-id=1-2')).toBe('AbC123xyz456');
    expect(figmaFileKey('https://www.figma.com/file/AbC123xyz456/Old')).toBe('AbC123xyz456');
    expect(figmaFileKey('not a link')).toBeNull();
  });
});
