import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../src/agent/http';
import { startServer } from '../server/server';
import { CollabClient } from '../src/collab/client';
import { createDocument, parseDocument } from '../src/core/document';
import { Editor } from '../src/core/editor';
import {
  buildHeaders,
  buildUrl,
  MAX_HISTORY,
  MAX_SAVED_BODY,
  newRequest,
  prepareRequest,
  prettyBody,
  sanitizeRequests,
  savedRequest,
  sendDirect,
  sendViaProxy,
  splitUrl,
  type RequestSpec,
} from '../src/core/requests';
import { caller, signUp, until, type TestServer } from './helpers';

const spec = (patch: Partial<RequestSpec>): RequestSpec => ({ ...newRequest(), ...patch });

describe('building requests', () => {
  it('adds a scheme and appends only the enabled params', () => {
    const url = buildUrl({
      url: 'api.example.com/items?sort=name',
      params: [
        { key: 'page', value: '2', enabled: true },
        { key: 'debug', value: '1', enabled: false },
        { key: ' ', value: 'blank', enabled: true },
        { key: 'q', value: 'a b&c', enabled: true },
      ],
    });
    expect(url).toBe('http://api.example.com/items?sort=name&page=2&q=a+b%26c');
    expect(() => buildUrl({ url: '', params: [] })).toThrow(/URL/);
    expect(() => buildUrl({ url: 'ftp://example.com', params: [] })).toThrow(/http/);
  });

  it('turns a pasted query string into params', () => {
    expect(splitUrl('https://x.dev/a?b=1&c=two#top')).toEqual({
      url: 'https://x.dev/a#top',
      params: [
        { key: 'b', value: '1', enabled: true },
        { key: 'c', value: 'two', enabled: true },
      ],
    });
    expect(splitUrl('https://x.dev/a').params).toEqual([]);
  });

  it('sets the body and its Content-Type, unless the method has no body or the header is set', () => {
    const post = spec({ method: 'POST', url: 'https://x.dev', bodyKind: 'json', body: '{"a":1}' });
    expect(prepareRequest(post)).toEqual({ method: 'POST', url: 'https://x.dev/', headers: [['Content-Type', 'application/json']], body: '{"a":1}' });
    expect(prepareRequest({ ...post, method: 'GET' }).body).toBeUndefined();
    expect(buildHeaders({ ...post, headers: [{ key: 'content-type', value: 'application/vnd+json', enabled: true }] })).toEqual([['content-type', 'application/vnd+json']]);
    const form = spec({ method: 'PUT', url: 'x.dev', bodyKind: 'form', form: [{ key: 'name', value: 'Ann Lee', enabled: true }, { key: 'x', value: '1', enabled: false }] });
    expect(prepareRequest(form)).toMatchObject({ body: 'name=Ann+Lee', headers: [['Content-Type', 'application/x-www-form-urlencoded']] });
    expect(() => prepareRequest({ ...post, body: '{oops' })).toThrow(/JSON body is not valid/);
  });

  it('indents JSON responses and leaves other bodies alone', () => {
    expect(prettyBody({ body: '{"a":[1]}', headers: [['Content-Type', 'application/json']] })).toBe('{\n  "a": [\n    1\n  ]\n}');
    expect(prettyBody({ body: '<b>hi</b>', headers: [['content-type', 'text/html']] })).toBe('<b>hi</b>');
    expect(prettyBody({ body: '{broken', headers: [] })).toBe('{broken');
  });

  it('reads a response sent straight from the browser', async () => {
    const fakeFetch = (async () => new Response('{"ok":true}', { status: 201, statusText: 'Created', headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const res = await sendDirect(prepareRequest(spec({ url: 'https://x.dev' })), fakeFetch);
    expect(res).toMatchObject({ status: 201, statusText: 'Created', body: '{"ok":true}', size: 11, truncated: false });
    expect(res.headers).toContainEqual(['content-type', 'application/json']);
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(sendDirect(prepareRequest(spec({ url: 'https://x.dev' })), failing)).rejects.toThrow(/CORS/);
  });
});

describe('request history in the document', () => {
  const entry = (n = 0) =>
    savedRequest({
      request: spec({ method: 'POST', url: `https://x.dev/${n}`, headers: [{ key: 'Authorization', value: 'Bearer t', enabled: true }] }),
      response: { status: 200, statusText: 'OK', headers: [['content-type', 'text/plain']], body: 'hello', truncated: false, size: 5, time: 12 },
      via: 'direct',
      author: 'Ann',
    });

  it('is saved in the file and survives a round trip', () => {
    const doc = createDocument();
    expect(doc.requests).toEqual([]);
    doc.requests = [entry(1)];
    const back = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect(back.requests).toEqual(doc.requests);
    // Files from before the history existed open with an empty one.
    const old = JSON.parse(JSON.stringify(doc));
    delete old.requests;
    expect(parseDocument(old).requests).toEqual([]);
  });

  it('cleans up entries from a file and keeps the limits', () => {
    const big = { ...entry(), response: { ...entry().response!, body: 'x'.repeat(MAX_SAVED_BODY + 10) } };
    const clean = sanitizeRequests([big, { id: 7 }, null, { id: 'e', request: { method: 'BREW', url: 3 }, response: 'nope', via: 'teleport' }]);
    expect(clean).toHaveLength(2);
    expect(clean[0].response).toMatchObject({ truncated: true });
    expect(clean[0].response!.body).toHaveLength(MAX_SAVED_BODY);
    expect(clean[1]).toMatchObject({ id: 'e', request: { method: 'GET', url: '' }, response: null, via: 'direct' });
    expect(sanitizeRequests(Array.from({ length: MAX_HISTORY + 5 }, (_, i) => entry(i)))).toHaveLength(MAX_HISTORY);
  });

  it('records sent requests outside undo, newest first, and can rename, delete and clear', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    editor.renameDocument('Before');
    const a = entry(1);
    const b = entry(2);
    expect(editor.addSavedRequest(a)).toBe(true);
    editor.addSavedRequest(b);
    expect(editor.doc.requests.map((e) => e.id)).toEqual([b.id, a.id]);
    // Undo takes back the rename, not the requests.
    editor.undo();
    expect(editor.doc.name).toBe('Untitled');
    expect(editor.doc.requests).toHaveLength(2);
    editor.redo();
    expect(editor.doc.requests).toHaveLength(2);

    editor.renameSavedRequest(a.id, '  Create item ');
    expect(editor.doc.requests[1].name).toBe('Create item');
    editor.renameSavedRequest(a.id, '');
    expect(editor.doc.requests[1].name).toBeUndefined();
    editor.deleteSavedRequest(b.id);
    expect(editor.doc.requests.map((e) => e.id)).toEqual([a.id]);
    editor.clearSavedRequests();
    expect(editor.doc.requests).toEqual([]);
    expect(editor.canUndo).toBe(true); // only the rename

    for (let i = 0; i < MAX_HISTORY + 3; i++) editor.addSavedRequest(entry(i));
    expect(editor.doc.requests).toHaveLength(MAX_HISTORY);

    editor.readOnly = true;
    expect(editor.addSavedRequest(entry(99))).toBe(false);
  });
});

describe('request proxy and shared history', () => {
  let server: TestServer;
  let open: TestServer;
  let url = '';
  let openUrl = '';
  let target: Server;
  let targetUrl = '';

  beforeAll(async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', dataDir: null, staticDir: null, authLimit: 1000 });
    url = `http://127.0.0.1:${server.port}`;
    open = await startServer({ port: 0, host: '127.0.0.1', dataDir: null, staticDir: null, authLimit: 1000, proxyPrivateHosts: true });
    openUrl = `http://127.0.0.1:${open.port}`;
    target = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/redirect') return res.writeHead(302, { Location: '/elsewhere' }).end();
        res.writeHead(418, 'Teapot', { 'Content-Type': 'application/json', 'X-Seen-Auth': String(req.headers.authorization ?? '') });
        res.end(JSON.stringify({ method: req.method, url: req.url, body, type: req.headers['content-type'] ?? null }));
      });
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await server.close();
    await open.close();
    await new Promise((r) => target.close(r));
  });

  it('knows which addresses are inside the network', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'nonsense']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(a), a).toBe(false);
  });

  it('is only for signed-in people in the editor and refuses private addresses', async () => {
    const ann = await signUp(url, 'ann');
    const body = { method: 'GET', url: `${targetUrl}/x`, headers: [] };
    expect((await caller(url)('POST', '/api/http-proxy', body)).status).toBe(401);
    expect((await caller(url, { key: ann.key })('POST', '/api/http-proxy', body)).status).toBe(403);
    const refused = await ann.call('POST', '/api/http-proxy', body);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/inside the server's network/);
    const viaName = await ann.call('POST', '/api/http-proxy', { ...body, url: `http://localhost:${new URL(targetUrl).port}/` });
    expect(viaName.status).toBe(403);
    expect((await ann.call('POST', '/api/http-proxy', { ...body, method: 'BREW' })).status).toBe(400);
    expect((await ann.call('POST', '/api/http-proxy', { ...body, url: 'file:///etc/passwd' })).status).toBe(400);
    expect((await ann.call('GET', '/api/http-proxy')).status).toBe(405);
  });

  it('sends the request and returns status, headers and body', async () => {
    const ann = await signUp(openUrl, 'ann');
    const withCookie = ((input: string, init: RequestInit) => fetch(`${openUrl}${input}`, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: ann.cookie } })) as typeof fetch;
    const req = prepareRequest(
      spec({
        method: 'POST',
        url: `${targetUrl}/items`,
        params: [{ key: 'page', value: '2', enabled: true }],
        headers: [{ key: 'Authorization', value: 'Bearer abc', enabled: true }, { key: 'Host', value: 'evil', enabled: true }],
        bodyKind: 'json',
        body: '{"name":"Box"}',
      }),
    );
    const res = await sendViaProxy(req, '/api/http-proxy', withCookie);
    expect(res).toMatchObject({ status: 418, statusText: 'Teapot', truncated: false });
    expect(JSON.parse(res.body)).toEqual({ method: 'POST', url: '/items?page=2', body: '{"name":"Box"}', type: 'application/json' });
    expect(res.headers).toContainEqual(['X-Seen-Auth', 'Bearer abc']);

    const redirect = await sendViaProxy(prepareRequest(spec({ url: `${targetUrl}/redirect` })), '/api/http-proxy', withCookie);
    expect(redirect.status).toBe(302);
    expect(redirect.headers).toContainEqual(['Location', '/elsewhere']);

    await expect(sendViaProxy(prepareRequest(spec({ url: 'http://127.0.0.1:1/' })), '/api/http-proxy', withCookie)).rejects.toThrow(/request failed/);
  });

  it('shares the history with everyone in the file, live', async () => {
    const ann = await signUp(url, 'ann');
    const a = new Editor(createDocument('Shared'), { autosave: false });
    const fileId = (await ann.call('POST', '/api/files', { doc: a.doc })).body.file.id as string;
    await ann.call('PATCH', `/api/files/${fileId}`, { linkAccess: 'edit' });
    const ca = new CollabClient(a, { serverUrl: url, fileId, key: ann.key, shareUrl: '' });
    ca.start();
    await until(() => ca.status === 'connected');
    const b = new Editor(createDocument(), { autosave: false });
    const cb = new CollabClient(b, { serverUrl: url, fileId, guestName: 'Ben', shareUrl: '' });
    cb.start();
    await until(() => cb.status === 'connected');

    const e = savedRequest({ request: spec({ url: 'https://x.dev' }), response: null, error: 'Offline', via: 'direct', author: 'Ann' });
    a.addSavedRequest(e);
    await until(() => b.doc.requests.length === 1);
    expect(b.doc.requests[0]).toEqual(e);
    b.deleteSavedRequest(e.id);
    await until(() => a.doc.requests.length === 0);
    ca.stop();
    cb.stop();
  });
});
