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
import { signUp, type Account } from './helpers';

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
      ['code', 'components', 'create', 'delete', 'export', 'files', 'find', 'inspect', 'open', 'overview', 'pages', 'screenshot', 'select', 'tokens', 'tree', 'undo', 'update', 'variables', 'versions'].sort(),
    );
    // Directories check that every tool says whether it reads or changes data.
    for (const t of tools) expect(t.annotations?.readOnlyHint !== undefined || t.annotations?.destructiveHint !== undefined, t.name).toBe(true);
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

  it('imports SVG icons, draws paths and manages pages', async () => {
    const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/></svg>';
    const created = await call('create', {
      parent: card,
      layers: [
        { type: 'svg', name: 'Note icon', svg: icon, width: 32, fill: '$brand' },
        { type: 'vector', name: 'Chevron', path: 'M9 6 L15 12 L9 18', stroke: '#5A5A68', strokeWidth: 2, fill: null },
      ],
    });
    expect(created.isError).toBeFalsy();
    const out = textOf(created);
    expect(out).toMatch(/frame "Note icon" #\S+ {2}32×32/);
    const iconId = /frame "Note icon" #(\S+)/.exec(out)![1];
    const parts = JSON.parse(textOf(await call('inspect', { ids: [iconId], children: true })));
    expect(parts.layers).toHaveLength(2);
    expect(parts.layers[0].stroke).toBe('$brand');
    expect(parts.layers[0].path).toMatch(/^M /);
    const chevron = JSON.parse(textOf(await call('inspect', { ids: [/vector "Chevron" #(\S+)/.exec(out)![1]] })));
    expect(chevron).toMatchObject({ width: 6, height: 12, stroke: '#5A5A68' });

    // Resizing an icon frame scales the drawing and its strokes.
    const strokeBefore = parts.layers[0].strokeWidth;
    await call('update', { changes: [{ id: iconId, width: 64, height: 64 }] });
    const scaled = JSON.parse(textOf(await call('inspect', { ids: [iconId], children: true })));
    expect(scaled.layers[0].strokeWidth).toBeCloseTo(strokeBefore * 2, 1);
    expect(scaled.layers[1].width).toBeCloseTo(parts.layers[1].width * 2, 1);

    const pages = textOf(await call('pages', { action: 'create', name: 'Design system' }));
    expect(pages).toMatch(/page "Design system" #\S+ {2}0 top-level layers {2}\(current\)/);
    const ds = /page "Design system" #(\S+)/.exec(pages)![1];
    await call('create', { layers: [{ type: 'text', text: 'Colours', size: 24 }] });
    expect(textOf(await call('tree', { id: ds }))).toMatch(/text "Colours"/);
    const shot = await call('screenshot', { id: ds });
    expect(shot.content.some((c) => c.type === 'image')).toBe(true);
    const back = textOf(await call('pages', { action: 'open', id: /page "Page 1" #(\S+)/.exec(pages)![1] }));
    expect(back).toMatch(/page "Page 1" #\S+ .*\(current\)/);
  });

  it('undoes its own steps', async () => {
    await call('delete', { ids: [card] });
    expect(textOf(await call('find', { name: 'Card' }))).toMatch(/No matching/);
    await call('undo', {});
    expect(textOf(await call('find', { name: 'Card' }))).toMatch(/frame "Card"/);
  });
});

describe('remote MCP endpoint (live file)', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let url = '';
  let ann: Account;
  let ben: Account;
  let human: Editor;
  let humanClient: CollabClient;
  let remote: Client;
  let fileId = '';

  beforeAll(async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', dataDir: null, staticDir: null });
    url = `http://127.0.0.1:${server.port}`;
    ann = await signUp(url, 'ann');
    ben = await signUp(url, 'ben');
    human = new Editor(createDocument('Team file'), { autosave: false });
    fileId = (await ann.call('POST', '/api/files', { doc: human.doc })).body.file.id;
    humanClient = new CollabClient(human, { serverUrl: url, fileId, key: ann.key, guestName: 'Ann', shareUrl: '' });
    humanClient.start();
    while (humanClient.status !== 'connected') await new Promise((r) => setTimeout(r, 10));
    remote = new Client({ name: 'remote-test', version: '1' });
    await remote.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${ann.key}` } } }));
  });

  afterAll(async () => {
    await remote.close();
    humanClient.stop();
    await server.close();
  });

  it('rejects requests without a valid API key', async () => {
    const post = (headers: Record<string, string>) => fetch(`${url}/mcp`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', ...headers } });
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: 'Bearer plk_nonsense' })).status).toBe(401);
    expect((await post({ Authorization: 'Bearer tok' })).status).toBe(401);
  });

  it('lists, creates and opens files with the key owner rights', async () => {
    const list = textOf((await remote.callTool({ name: 'files', arguments: { action: 'list' } })) as ToolResult);
    expect(list).toContain(fileId);
    const made = textOf((await remote.callTool({ name: 'files', arguments: { action: 'create', name: 'From agent' } })) as ToolResult);
    expect(made).toMatch(/From agent/);
    // Links point at the address people use, not the internal one the endpoint connects to.
    expect(made).toContain(`${url}/file/`);
    const newId = /id (\S+)\./.exec(made)![1];
    expect((await ann.call('GET', `/api/files/${newId}`)).body.file.name).toBe('From agent');
  });

  it('is read-only on a file that was only shared for viewing, and can duplicate it', async () => {
    const benRemote = new Client({ name: 'ben-agent', version: '1' });
    await benRemote.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${ben.key}` } } }));
    expect(textOf((await benRemote.callTool({ name: 'open', arguments: { fileId } })) as ToolResult)).toMatch(/Could not open/);
    await ann.call('PUT', `/api/files/${fileId}/members`, { username: ben.username, role: 'viewer' });
    const opened = textOf((await benRemote.callTool({ name: 'open', arguments: { fileId } })) as ToolResult);
    expect(opened).toMatch(/view-only/);
    const blocked = (await benRemote.callTool({ name: 'create', arguments: { layers: [{ type: 'rectangle' }] } })) as ToolResult;
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toMatch(/view-only/);
    const copy = textOf((await benRemote.callTool({ name: 'files', arguments: { action: 'duplicate', fileId } })) as ToolResult);
    expect(copy).toMatch(/Copied/);
    await ann.call('PUT', `/api/files/${fileId}/members`, { username: ben.username, role: null });
    await benRemote.close();
  });

  it('joins the file by link and edits live for everyone', async () => {
    const open = (await remote.callTool({ name: 'open', arguments: { link: `https://planar.example.com/file/${fileId}` } })) as ToolResult;
    expect(textOf(open)).toMatch(/Opened live file/);
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

  it('has a restore point from before the agent edited, and can go back to it', async () => {
    const call = async (args: Record<string, string>) => (await remote.callTool({ name: 'versions', arguments: args })) as ToolResult;
    const idOf = (listing: string, label: string) => listing.split(String.fromCharCode(10)).find((l) => l.includes(label))!.split(' ')[0];
    const list = textOf(await call({ action: 'list' }));
    expect(list).toContain('"Before Agent"');
    expect(textOf(await call({ action: 'save', label: 'With greeting' }))).toMatch(/Saved version/);
    const restored = await call({ action: 'restore', versionId: idOf(list, 'Before Agent') });
    expect(restored.isError).toBeFalsy();
    const start = Date.now();
    while (Object.values(human.doc.nodes).some((n) => n.characters === 'Hello from the agent')) {
      if (Date.now() - start > 3000) throw new Error('the human still has the agent text');
      await new Promise((r) => setTimeout(r, 20));
    }
    // Put the greeting back so later tests see the same file.
    await call({ action: 'restore', versionId: idOf(textOf(await call({ action: 'list' })), 'With greeting') });
    while (!Object.values(human.doc.nodes).some((n) => n.characters === 'Hello from the agent')) await new Promise((r) => setTimeout(r, 20));
  });

  it('cannot touch server files', async () => {
    const r = (await remote.callTool({ name: 'open', arguments: { file: '/etc/passwd' } })) as ToolResult;
    expect(r.isError).toBe(true);
  });
});
