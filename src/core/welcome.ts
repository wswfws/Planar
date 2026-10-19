import { createDocument, createNode, insertNode, solid } from './document';
import { fitGroups } from './geometry';
import { applyAutoLayout } from './layout';
import { measureTextNode } from './text';
import type { PlanarDocument, SceneNode } from './types';

/** A small sample document shown on first launch. */
export function createWelcomeDocument(): PlanarDocument {
  const doc = createDocument('Welcome to Planar');
  const pageId = doc.pageIds[0];

  const text = (parentId: string, props: Partial<SceneNode>) => {
    const node = createNode('text', props);
    node.name = node.characters.split('\n')[0];
    Object.assign(node, measureTextNode(node));
    return insertNode(doc, node, parentId);
  };

  const card = insertNode(
    doc,
    createNode('frame', { name: 'Welcome card', x: 0, y: 0, width: 480, height: 340, cornerRadius: 24 }),
    pageId,
  );
  insertNode(
    doc,
    createNode('ellipse', { name: 'Accent', x: 300, y: -60, width: 260, height: 260, fills: [solid('#5b5bd6', 0.18)] }),
    card.id,
  );
  insertNode(
    doc,
    createNode('rectangle', { name: 'Logo', x: 40, y: 40, width: 56, height: 56, cornerRadius: 14, fills: [solid('#5b5bd6')] }),
    card.id,
  );
  text(card.id, { characters: 'Planar', x: 40, y: 120, fontSize: 40, fontWeight: 700, fills: [solid('#16161d')] });
  text(card.id, {
    characters: 'An open-source design editor.\nDraw with F, R, O, L, P and T.\nPan with Space, zoom with Ctrl + wheel.',
    x: 40,
    y: 182,
    fontSize: 16,
    lineHeight: 1.5,
    fills: [solid('#4a4a57')],
  });

  // An auto-layout button: the frame hugs its label plus padding.
  const button = insertNode(
    doc,
    createNode('frame', {
      name: 'Button',
      x: 40,
      y: 272,
      cornerRadius: 10,
      fills: [solid('#5b5bd6')],
      clipContent: false,
      layoutMode: 'horizontal',
      paddingLeft: 18,
      paddingRight: 18,
      paddingTop: 10,
      paddingBottom: 10,
      counterAlign: 'center',
      sizingH: 'hug',
      sizingV: 'hug',
    }),
    card.id,
  );
  text(button.id, { characters: 'Get started  →', fontSize: 15, fontWeight: 600, fills: [solid('#ffffff')] });
  applyAutoLayout(doc, pageId);

  const shapes = insertNode(doc, createNode('group', { name: 'Shapes' }), pageId);
  insertNode(
    doc,
    createNode('rectangle', { name: 'Square', x: 560, y: 40, width: 120, height: 120, cornerRadius: 12, rotation: 12, fills: [solid('#f2a65a')] }),
    shapes.id,
  );
  insertNode(
    doc,
    createNode('ellipse', { name: 'Circle', x: 600, y: 180, width: 100, height: 100, fills: [solid('#4cc38a')] }),
    shapes.id,
  );
  insertNode(
    doc,
    createNode('vector', {
      name: 'Triangle',
      x: 720,
      y: 100,
      width: 110,
      height: 100,
      closed: true,
      fills: [solid('#e5484d')],
      strokes: [],
      points: [
        { x: 0.5, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
    }),
    shapes.id,
  );
  Object.assign(shapes, { x: 0, y: 0, width: 0, height: 0 });
  fitGroups(doc, pageId);
  return doc;
}
