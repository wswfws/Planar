import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../server/server';
import { agentRequest } from '../src/agent/requests';
import { AgentSession } from '../src/agent/session';
import { INSTRUCTIONS, registerTools } from '../src/agent/tools';
import { CollabClient } from '../src/collab/client';
import { createDocument } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { newRequest } from '../src/core/requests';
import { signUp, until, type TestServer } from './helpers';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');

let target: Server;
let targetUrl = '';
const seen: { method?: string; url?: string; body: string; type?: string; auth?: string }[] = [];

beforeAll(async () => {
  target = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, type: req.headers['content-type'], auth: req.headers.authorization });
      res.writeHead(req.url?.startsWith('/missing') ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => target.close(r));
});

describe('agent requests', () => {
  it('builds requests from plain objects, on top of a saved one', () => {
    expect(agentRequest({ url: 'x.dev', body: { a: 1 }, headers: { 'X-Id': '7' } })).toMatchObject({
      method: 'GET',
      url: 'x.dev',
      bodyKind: 'json',
      body: '{\n  "a": 1\n}',
      headers: [{ key: 'X-Id', value: '7', enabled: true }],
    });
    expect(agentRequest({ body: '{"a":1}' }).bodyKind).toBe('json');
    expect(agentRequest({ body: 'plain words' }).bodyKind).toBe('text');
    expect(agentRequest({ form: { name: 'Ann' } })).toMatchObject({ bodyKind: 'form', form: [{ key: 'name', value: 'Ann', enabled: true }] });
    const base = { ...newRequest(), method: 'POST' as const, url: 'https://x.dev/a', params: [{ key: 'p', value: '1', enabled: true }] };
    expect(agentRequest({ url: 'https://x.dev/b' }, base)).toMatchObject({ method: 'POST', url: 'https://x.dev/b', params: base.params });
  });
});

describe('requests tool (local file)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'planar-mcp-req-'));
  const file = path.join(dir, 'api.planar.json');
  let client: Client;
  let session: AgentSession;
  const call = async (args: Record<string, unknown>) => (await client.callTool({ name: 'requests', arguments: args })) as ToolResult;

  beforeAll(async () => {
    session = new AgentSession({ allowFiles: true, name: 'Robo' });
    const server = new McpServer({ name: 'planar', version: 'test' }, { instructions: INSTRUCTIONS });
    registerTools(server, session);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    await client.callTool({ name: 'open', arguments: { file } });
  });

  afterAll(() => {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends a request, shows the response and keeps it in the file', async () => {
    expect(textOf(await call({ action: 'list' }))).toMatch(/No requests/);
    const sent = await call({ action: 'send', method: 'POST', url: `${targetUrl}/items`, params: { page: '2' }, headers: { Authorization: 'Bearer t' }, body: { name: 'Box' }, name: 'Create item' });
    expect(sent.isError).toBeFalsy();
    expect(textOf(sent)).toMatch(/^POST http:\/\/127\.0\.0\.1:\d+\/items\?page=2\n200 OK/);
    expect(textOf(sent)).toContain('"path": "/items?page=2"');
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/items?page=2', type: 'application/json', auth: 'Bearer t' });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ name: 'Box' });

    const id = /Saved to the history as (\S+)\./.exec(textOf(sent))![1];
    expect(textOf(await call({ action: 'list' }))).toMatch(new RegExp(`${id}  "Create item" POST .*/items +→ 200 OK`));
    const full = textOf(await call({ action: 'get', id }));
    expect(full).toContain('Authorization: Bearer t');
    expect(full).toContain('by an agent');

    // Saved to the .planar.json file with the agent as author.
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.requests[0]).toMatchObject({ id, name: 'Create item', author: 'Robo', via: 'agent', response: { status: 200 } });
  });

  it('re-sends a saved request with changes, and can skip saving', async () => {
    const id = JSON.parse(readFileSync(file, 'utf8')).requests[0].id;
    const again = await call({ action: 'send', id, url: `${targetUrl}/missing`, save: false });
    expect(textOf(again)).toMatch(/404 Not Found/);
    expect(textOf(again)).not.toMatch(/Saved/);
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/missing?page=2' });
    expect(textOf(await call({ action: 'list' })).split('\n')).toHaveLength(1);
  });

  it('keeps failures, and renames, deletes and clears', async () => {
    const failed = await call({ action: 'send', url: 'http://127.0.0.1:1/' });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toMatch(/request failed[\s\S]*Saved to the history/);
    expect((await call({ action: 'send', url: 'ftp://x' })).isError).toBe(true);
    expect((await call({ action: 'send' })).isError).toBe(true);

    const list = textOf(await call({ action: 'list' })).split('\n');
    expect(list[0]).toMatch(/→ error: The request failed/);
    const [newest, older] = list.map((l) => l.split(' ')[0]);
    expect(textOf(await call({ action: 'rename', id: older, name: 'Old one' }))).toMatch(/Renamed/);
    expect(textOf(await call({ action: 'list' }))).toContain('"Old one"');
    await call({ action: 'delete', id: newest });
    expect(textOf(await call({ action: 'list' })).split('\n')).toHaveLength(1);
    expect((await call({ action: 'get', id: 'nope' })).isError).toBe(true);
    expect(textOf(await call({ action: 'clear' }))).toMatch(/Cleared 1 request\./);
    expect(JSON.parse(readFileSync(file, 'utf8')).requests).toEqual([]);
  });
});

describe('requests tool (remote, on a Planar server)', () => {
  let server: TestServer;
  let url = '';

  beforeAll(async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', dataDir: null, staticDir: null, authLimit: 1000 });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('refuses private addresses and shares what it sends with people in the file', async () => {
    const ann = await signUp(url, 'ann');
    const human = new Editor(createDocument('Live'), { autosave: false });
    const fileId = (await ann.call('POST', '/api/files', { doc: human.doc })).body.file.id as string;
    const humanClient = new CollabClient(human, { serverUrl: url, fileId, key: ann.key, shareUrl: '' });
    humanClient.start();
    await until(() => humanClient.status === 'connected');

    const remote = new Client({ name: 'remote-test', version: '1' });
    await remote.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${ann.key}` } } }));
    await remote.callTool({ name: 'open', arguments: { fileId } });
    const r = (await remote.callTool({ name: 'requests', arguments: { action: 'send', url: `${targetUrl}/x` } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/inside the server's network/);

    // The failed attempt is still recorded, and the person in the file sees it.
    await until(() => human.doc.requests.length === 1, 5000);
    expect(human.doc.requests[0]).toMatchObject({ via: 'agent', response: null, request: { url: `${targetUrl}/x` } });
    await remote.close();
    humanClient.stop();
  });
});
