import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../server/server';
import { initCanvas } from '../src/agent/raster';
import { AgentSession } from '../src/agent/session';
import { INSTRUCTIONS, registerTools } from '../src/agent/tools';
import { CollabClient } from '../src/collab/client';
import { createDocument } from '../src/core/document';
import { Editor } from '../src/core/editor';

type ToolResult = { content: { type: string; text?: string; data?: string }[]; isError?: boolean };

const dir = mkdtempSync(path.join(tmpdir(), 'planar-mcp-'));
let client: Client;
let session: AgentSession;

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
const textOf = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

beforeAll(async () => {
  await initCanvas();
  session = new AgentSession({ allowFiles: true });
  const server = new McpServer({ name: 'planar', version: 'test' }, { instructions: INSTRUCTIONS });
  registerTools(server, session);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
});

afterAll(() => {
  session.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP tools (file mode)', () => {
  const file = path.join(dir, 'app.planar.json');
  let card = '';

  it('lists tools and opens a new file', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['code', 'components', 'create', 'delete', 'export', 'find', 'inspect', 'open', 'overview', 'screenshot', 'select', 'tokens', 'tree', 'undo', 'update', 'variables'].sort(),
    );
    const r = await call('overview');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/open/);
    expect(textOf(await call('open', { file }))).toMatch(/Created/);
  });

  it('sets up variables and builds a layout in one call', async () => {
    const v = await call('variables', {
      modes: ['Light', 'Dark'],
      set: [
        { name: 'brand', type: 'color', values: { Light: '#5B5BD6', Dark: '#F2A65A' } },
        { name: 'space', type: 'number', value: 16 },
      ],
    });
    expect(textOf(v)).toMatch(/\$brand \(color\) Light="#5B5BD6" Dark="#F2A65A"/);

    const r = await call('create', {
      layers: [
        {
          type: 'frame',
          name: 'Card',
          layout: 'column',
          gap: '$space',
          padding: [24, 32],
          width: 320,
          height: 'hug',
          fill: '#FFFFFF',
          radius: 16,
          children: [
            { type: 'text', text: 'Upgrade to Pro', size: 20, weight: 'bold' },
            { type: 'text', text: 'Unlimited projects.', width: 'fill', fill: '#5A5A68' },
            { type: 'frame', name: 'Button', layout: 'row', padding: [10, 18], fill: '$brand', radius: 10, width: 'hug', height: 'hug', children: [{ type: 'text', text: 'Upgrade', fill: '#FFFFFF', weight: 600 }] },
          ],
        },
      ],
    });
    expect(r.isError).toBeFalsy();
    const out = textOf(r);
    expect(out).toMatch(/frame "Card"/);
    card = /frame "Card" #(\S+)/.exec(out)![1];
    expect(out).toMatch(/column gap \$space pad 24,32/);
    // Saved to disk.
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.nodes[card].layoutMode).toBe('vertical');
  });

  it('inspects in the same vocabulary it accepts', async () => {
    const r = JSON.parse(textOf(await call('inspect', { ids: [card], children: true })));
    expect(r).toMatchObject({ type: 'frame', name: 'Card', layout: 'column', gap: '$space', padding: [24, 32], width: 320, height: 'hug', fill: '#FFFFFF', radius: 16 });
    expect(r.layers[1]).toMatchObject({ type: 'text', text: 'Unlimited projects.', width: 'fill' });
  });

  it('turns the button into a component and uses instances', async () => {
    const button = /frame "Button" #(\S+)/.exec(textOf(await call('find', { name: 'Button' })))![1];
    const comp = await call('components', { action: 'create', ids: [button] });
    expect(textOf(comp)).toMatch(/component "Button"/);
    const label = /text "Upgrade" #(\S+)/.exec(textOf(await call('tree', { id: button })))![1];
    await call('components', { action: 'add_property', ids: [button], type: 'text', name: 'Label', layer: label });
    const created = await call('create', { parent: card, layers: [{ type: 'instance', component: 'Button', props: { Label: 'Maybe later' } }] });
    expect(textOf(created)).toMatch(/of Button \{Label: "Maybe later"\}/);
  });

  it('updates and moves layers, with helpful errors', async () => {
    const r = await call('update', { changes: [{ id: card, fill: '#F5F5FA', mode: 'Dark' }] });
    expect(textOf(r)).toMatch(/fill #F5F5FA/);
    const bad = await call('update', { changes: [{ id: card, fill: '$nope' }] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/Unknown variable "\$nope". Known: \$brand, \$space/);
  });

  it('generates React with typed props and tokens', async () => {
    const button = /component "Button" #(\S+)/.exec(textOf(await call('overview')))![1];
    const react = textOf(await call('code', { id: button }));
    expect(react).toMatch(/export interface ButtonProps \{\n {2}label\?: string;/);
    expect(react).toMatch(/background-color: var\(--brand\)/);
    const page = textOf(await call('code', { id: card, format: 'react' }));
    expect(page).toMatch(/<Button label="Maybe later" \/>/);
    expect(page).toMatch(/flex-direction: column/);
    expect(page).toMatch(/gap: calc\(var\(--space\) \* 1px\)/);
    const html = textOf(await call('code', { id: card, format: 'html' }));
    expect(html).toMatch(/<div class="card"/);
    const tokens = textOf(await call('tokens', {}));
    expect(tokens).toMatch(/--brand: #5B5BD6;/);
    expect(tokens).toMatch(/\[data-mode="dark"\] \{\n {2}--brand: #F2A65A;/);
  });

  it('renders screenshots', async () => {
    const r = await call('screenshot', { id: card });
    const img = r.content.find((c) => c.type === 'image');
    expect(img?.data?.length).toBeGreaterThan(500);
    expect(Buffer.from(img!.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
  });

  it('undoes its own steps', async () => {
    await call('delete', { ids: [card] });
    expect(textOf(await call('find', { name: 'Card' }))).toMatch(/No matching/);
    await call('undo', {});
    expect(textOf(await call('find', { name: 'Card' }))).toMatch(/frame "Card"/);
  });
});

describe('remote MCP endpoint (live room)', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let human: Editor;
  let humanClient: CollabClient;
  let remote: Client;
  const roomId = `mcp-room-${Date.now()}`;

  beforeAll(async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', dataDir: null, staticDir: null, token: 'tok' });
    const url = `http://127.0.0.1:${server.port}`;
    human = new Editor(createDocument('Team file'), { autosave: false });
    humanClient = new CollabClient(human, { serverUrl: url, roomId, name: 'Ann', color: '#e5484d', token: 'tok', createWith: human.doc, shareUrl: '' });
    humanClient.start();
    while (humanClient.status !== 'connected') await new Promise((r) => setTimeout(r, 10));
    remote = new Client({ name: 'remote-test', version: '1' });
    await remote.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: 'Bearer tok' } } }));
  });

  afterAll(async () => {
    await remote.close();
    humanClient.stop();
    await server.close();
  });

  it('rejects requests without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(401);
  });

  it('joins the room by link and edits live for everyone', async () => {
    const open = (await remote.callTool({ name: 'open', arguments: { link: `https://planar.example.com/?room=${roomId}` } })) as ToolResult;
    expect(textOf(open)).toMatch(/Joined live room/);
    expect(textOf(open)).toMatch(/Ann/);
    const created = (await remote.callTool({ name: 'create', arguments: { layers: [{ type: 'text', text: 'Hello from the agent', size: 32 }] } })) as ToolResult;
    expect(created.isError).toBeFalsy();
    const start = Date.now();
    while (!Object.values(human.doc.nodes).some((n) => n.characters === 'Hello from the agent')) {
      if (Date.now() - start > 3000) throw new Error('human did not receive the change');
      await new Promise((r) => setTimeout(r, 20));
    }
    // The agent shows up as a participant pointing at its work.
    while (!human.collab?.peers.some((p) => p.name === 'Agent' && p.presence?.selection.length)) await new Promise((r) => setTimeout(r, 20));
  });

  it('cannot touch server files', async () => {
    const r = (await remote.callTool({ name: 'open', arguments: { file: '/etc/passwd' } })) as ToolResult;
    expect(r.isError).toBe(true);
  });
});
