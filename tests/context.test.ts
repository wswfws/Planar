import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { find, overview } from '../src/agent/outline';
import { applyProps, describe as describeLayer } from '../src/agent/props';
import { AgentSession } from '../src/agent/session';
import { INSTRUCTIONS, registerTools } from '../src/agent/tools';
import { generateCode } from '../src/codegen/codegen';
import { CONTEXT_MAX, contextChain, formatContext } from '../src/core/context';
import { createDocument, createNode, insertNode, parseDocument } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { ChangeTracker, applyOps } from '../src/core/ops';
import { figmaToPlanar } from '../src/import/figma';

function setup() {
  const editor = new Editor(createDocument('Shop'), { autosave: false });
  const screen = createNode('frame', { name: 'Checkout', width: 375, height: 600, context: 'Last step before paying.' });
  const card = createNode('frame', { name: 'Card', width: 200, height: 80 });
  const label = createNode('text', { name: 'Label', characters: 'Pay' });
  editor.change((d) => {
    d.context = 'Grocery app for older people: big type, high contrast.';
    d.nodes[editor.pageId].context = 'Payment flow';
    insertNode(d, screen, editor.pageId);
    insertNode(d, card, editor.pageId);
    insertNode(d, label, card.id);
  });
  editor.select([card.id]);
  editor.createComponent();
  const compId = editor.selection[0];
  editor.updateNodes([compId], { context: 'Payment card. Never show the full number.' });
  const instId = editor.createInstance(compId)!;
  editor.change((d) => {
    const inst = d.nodes[instId];
    d.nodes[inst.parentId!].children = d.nodes[inst.parentId!].children.filter((c) => c !== instId);
    inst.parentId = screen.id;
    d.nodes[screen.id].children.push(instId);
  });
  return { editor, screen, compId, instId };
}

describe('context', () => {
  it('is kept in files, cleaned when invalid, and synced as ops', () => {
    const { editor, screen } = setup();
    const copy = parseDocument(JSON.parse(JSON.stringify(editor.doc)));
    expect(copy.context).toMatch(/older people/);
    expect(copy.nodes[screen.id].context).toBe('Last step before paying.');
    const raw = JSON.parse(JSON.stringify(editor.doc));
    raw.context = 42;
    raw.nodes[screen.id].context = 'x'.repeat(CONTEXT_MAX + 10);
    const cleaned = parseDocument(raw);
    expect(cleaned.context).toBe('');
    expect(cleaned.nodes[screen.id].context).toHaveLength(CONTEXT_MAX);

    const other = parseDocument(JSON.parse(JSON.stringify(editor.doc)));
    const tracker = new ChangeTracker();
    tracker.reset(editor.doc);
    editor.setDocumentContext('New brief');
    editor.updateNodes([screen.id], { context: 'Changed' });
    applyOps(other, tracker.collect(editor.doc));
    expect(other.context).toBe('New brief');
    expect(other.nodes[screen.id].context).toBe('Changed');
    // A layer from an older client without the field.
    const { context: _c, ...old } = other.nodes[screen.id];
    applyOps(other, [{ o: 'node', id: screen.id, node: old as never }]);
    expect(other.nodes[screen.id].context).toBe('');
  });

  it('chains the file brief, page, parents, component and layer; instances keep their own', () => {
    const { editor, screen, compId, instId } = setup();
    expect(editor.doc.nodes[instId].context).toBe('');
    editor.updateNodes([instId], { context: 'Shown with the saved Visa card.' });
    editor.updateNodes([compId], { context: 'Payment card, v2.' });
    // Editing the component does not overwrite the instance's notes, and they are no override.
    expect(editor.doc.nodes[instId].context).toBe('Shown with the saved Visa card.');
    expect(editor.doc.nodes[instId].overrides).not.toContain('context');

    const chain = contextChain(editor.doc, instId);
    expect(chain.map((e) => e.source)).toEqual(['file', 'page', 'parent', 'component', 'layer']);
    expect(chain[2].id).toBe(screen.id);
    const text = formatContext(chain);
    expect(text).toMatch(/## File "Shop"\nGrocery app/);
    expect(text).toMatch(/## Component "Card" #.+\nPayment card, v2\./);

    // A layer inside the instance points at the component layer it mirrors.
    const inner = editor.doc.nodes[instId].children[0];
    const source = editor.doc.nodes[inner].sourceId;
    editor.updateNodes([source], { context: 'Button label, max 12 characters.' });
    expect(contextChain(editor.doc, inner).find((e) => e.source === 'component')?.text).toMatch(/max 12/);
  });

  it('is part of the agent vocabulary, find and overview', () => {
    const { editor, screen, compId } = setup();
    editor.begin();
    applyProps(editor, screen.id, { context: 'Shows the order total.' });
    editor.commit();
    expect(describeLayer(editor.doc, editor.doc.nodes[screen.id]).context).toBe('Shows the order total.');
    expect(describeLayer(editor.doc, editor.page).context).toBe('Payment flow');
    expect(find(editor.doc, { context: 'order total' }, editor.pageId).map((n) => n.id)).toEqual([screen.id]);
    const ov = overview(editor);
    expect(ov.split('\n').slice(2, 4)).toEqual(['File context (brief):', 'Grocery app for older people: big type, high contrast.']);
    expect(ov).toMatch(/context "Shows the order total\."/);

    const react = generateCode(editor.doc, compId, 'react').code;
    expect(react).toMatch(/\/\*\*\n \* Payment card\. Never show the full number\.\n \*\/\nexport function Card\(/);
  });

  it('imports Figma component descriptions', () => {
    const file = {
      name: 'F',
      components: { '1:2': { key: 'k', name: 'Button', description: 'Primary action only.' } },
      document: {
        id: '0:0',
        type: 'DOCUMENT',
        children: [{ id: '0:1', name: 'Page', type: 'CANVAS', children: [{ id: '1:2', name: 'Button', type: 'COMPONENT', relativeTransform: [[1, 0, 0], [0, 1, 0]], size: { x: 10, y: 10 }, fills: [] }] }],
      },
    };
    const { doc } = figmaToPlanar(file);
    expect(Object.values(doc.nodes).find((n) => n.type === 'component')?.context).toBe('Primary action only.');
  });
});

describe('context MCP tool', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'planar-ctx-'));
  let client: Client;
  let session: AgentSession;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError };
  };

  beforeAll(async () => {
    session = new AgentSession({ allowFiles: true });
    const server = new McpServer({ name: 'planar', version: 'test' }, { instructions: INSTRUCTIONS });
    registerTools(server, session);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    await call('open', { file: path.join(dir, 'ctx.planar.json') });
  });

  afterAll(() => {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads the file brief and layer notes', async () => {
    expect((await call('context', { action: 'get' })).text).toBe('The file has no brief yet.');
    expect((await call('overview')).text).toMatch(/File context: none yet/);
    await call('context', { action: 'set', text: 'Landing page for a bakery.' });
    await call('context', { action: 'set', text: 'Warm colours.', append: true });
    expect((await call('context', { action: 'get' })).text).toBe('## File "ctx"\nLanding page for a bakery.\n\nWarm colours.');

    const created = (await call('create', { layers: [{ type: 'frame', name: 'Hero', context: 'First screen people see.' }] })).text;
    const id = /#(\S+)/.exec(created)![1];
    await call('context', { action: 'set', id, text: 'Decision: no carousel.', append: true });
    const got = (await call('context', { action: 'get', id })).text;
    expect(got).toMatch(/## File "ctx"/);
    expect(got).toMatch(/## Layer "Hero" #\S+\nFirst screen people see\.\n\nDecision: no carousel\./);
    expect((await call('find', { context: 'carousel' })).text).toMatch(/Hero/);
    expect((await call('context', { action: 'set', id: 'nope', text: 'x' })).isError).toBe(true);
  });
});
