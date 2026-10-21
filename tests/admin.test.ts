import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startServer } from '../server/server';
import { CollabClient } from '../src/collab/client';
import { createDocument } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { caller, signUp, until, type Account, type TestServer } from './helpers';

const TOKEN = 'TEST-BOT-TOKEN';
let server: TestServer;
let url = '';
let telegram: Server;
const sent: { path: string; body: { chat_id: string; text: string } }[] = [];
let boss: Account;

beforeAll(async () => {
  telegram = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      sent.push({ path: req.url ?? '', body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => telegram.listen(0, '127.0.0.1', r));
  const tgPort = (telegram.address() as { port: number }).port;
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: null,
    staticDir: null,
    authLimit: 1000,
    admins: ['boss1'],
    metricsToken: 'metrics-secret',
    telegram: { token: TOKEN, chatId: '42', api: `http://127.0.0.1:${tgPort}` },
  });
  url = `http://127.0.0.1:${server.port}`;
  boss = await signUp(url, 'boss'); // first sign-up gets the suffix 1 → boss1
  expect(boss.username).toBe('boss1');
});

afterAll(async () => {
  await server.close();
  await new Promise<void>((r) => telegram.close(() => r()));
});

describe('admin access', () => {
  it('is invisible to everyone but admins signed in with a cookie', async () => {
    const ann = await signUp(url, 'ann');
    expect((await ann.call('GET', '/api/admin/overview')).status).toBe(404);
    expect((await caller(url)('GET', '/api/admin/overview')).status).toBe(404);
    // An admin's API key is not enough: agents never administer.
    expect((await caller(url, { key: boss.key })('GET', '/api/admin/overview')).status).toBe(404);
    expect((await boss.call('GET', '/api/admin/overview')).status).toBe(200);
    expect((await boss.call('GET', '/api/me')).body.user.admin).toBe(true);
    expect((await ann.call('GET', '/api/me')).body.user.admin).toBe(false);
  });
});

describe('overview', () => {
  it('reports live connections and activity', async () => {
    const ann = await signUp(url, 'ann');
    const file = (await ann.call('POST', '/api/files', { name: 'Live' })).body.file;
    await ann.call('PATCH', `/api/files/${file.id}`, { linkAccess: 'edit' });
    const clients = [0, 1].map(() => {
      const c = new CollabClient(new Editor(createDocument(), { autosave: false }), { serverUrl: url, fileId: file.id, key: ann.key, shareUrl: '' });
      c.start();
      return c;
    });
    await until(() => clients.every((c) => c.status === 'connected'));
    const o = (await boss.call('GET', '/api/admin/overview')).body;
    expect(o.gauges.sockets).toBe(2);
    expect(o.gauges.openFiles).toBe(1);
    expect(o.gauges.usersOnline).toBe(1);
    expect(o.gauges.users).toBeGreaterThanOrEqual(2);
    expect(o.days.at(-1).registrations).toBeGreaterThanOrEqual(2);
    expect(o.events.some((e: { kind: string }) => e.kind === 'signup')).toBe(true);
    clients.forEach((c) => c.stop());
  });

  it('lists files with metadata only', async () => {
    const ann = await signUp(url, 'ann');
    await ann.call('POST', '/api/files', { name: 'Secret plans' });
    const files = (await boss.call('GET', '/api/admin/files?q=secret')).body.files;
    expect(files[0].name).toBe('Secret plans');
    expect(files[0].owner.username).toBe(ann.username);
    expect(files[0]).not.toHaveProperty('doc');
  });
});

describe('admin actions', () => {
  it('blocks a user: no sign-in, no keys, open files closed', async () => {
    const ann = await signUp(url, 'ann');
    const file = (await ann.call('POST', '/api/files', { name: 'Mine' })).body.file;
    const c = new CollabClient(new Editor(createDocument(), { autosave: false }), { serverUrl: url, fileId: file.id, key: ann.key, shareUrl: '' });
    c.start();
    await until(() => c.status === 'connected');
    const id = (await boss.call('GET', `/api/admin/users?q=${ann.username}`)).body.users[0].id;

    await boss.call('POST', `/api/admin/users/${id}`, { blocked: true });
    await until(() => c.status === 'error');
    expect((await ann.call('GET', '/api/me')).body.user).toBeNull();
    expect((await caller(url, { key: ann.key })('GET', '/api/files')).status).toBe(401);
    expect((await caller(url)('POST', '/api/auth/login', { username: ann.username, password: 'correct horse' })).status).toBe(403);

    await boss.call('POST', `/api/admin/users/${id}`, { blocked: false });
    expect((await caller(url)('POST', '/api/auth/login', { username: ann.username, password: 'correct horse' })).status).toBe(200);
    expect((await boss.call('POST', `/api/admin/users/${(await boss.call('GET', '/api/me')).body.user.id}`, { blocked: true })).status).toBe(400);
  });

  it('deletes a user and hands their files to someone else', async () => {
    const ann = await signUp(url, 'ann');
    const ben = await signUp(url, 'ben');
    const file = (await ann.call('POST', '/api/files', { name: 'Inherited' })).body.file;
    const id = (await boss.call('GET', `/api/admin/users?q=${ann.username}`)).body.users[0].id;
    expect((await boss.call('DELETE', `/api/admin/users/${id}?files=transfer:${ben.username}`)).status).toBe(200);
    expect((await ben.call('GET', `/api/files/${file.id}`)).body.file.role).toBe('owner');
    expect((await caller(url)('POST', '/api/auth/login', { username: ann.username, password: 'correct horse' })).status).toBe(401);
  });

  it('closes public links and deletes files', async () => {
    const ann = await signUp(url, 'ann');
    const file = (await ann.call('POST', '/api/files', { name: 'Spam' })).body.file;
    await ann.call('PATCH', `/api/files/${file.id}`, { linkAccess: 'view' });
    await boss.call('POST', `/api/admin/files/${file.id}`, { linkAccess: 'none' });
    expect((await caller(url)('GET', `/api/files/${file.id}`)).status).toBe(401);
    await boss.call('DELETE', `/api/admin/files/${file.id}`);
    expect((await ann.call('GET', `/api/files/${file.id}`)).status).toBe(404);
  });

  it('closes registration and enforces limits', async () => {
    await boss.call('POST', '/api/admin/settings', { registrationOpen: false });
    expect((await caller(url)('POST', '/api/auth/register', { username: 'latecomer', password: 'correct horse' })).status).toBe(403);
    await boss.call('POST', '/api/admin/settings', { registrationOpen: true, maxFilesPerUser: 1 });
    const ann = await signUp(url, 'ann');
    expect((await ann.call('POST', '/api/files', {})).status).toBe(200);
    expect((await ann.call('POST', '/api/files', {})).status).toBe(403);
    await boss.call('POST', '/api/admin/settings', { maxFilesPerUser: 500 });
  });
});

describe('monitoring outputs', () => {
  it('serves Prometheus metrics only with the token', async () => {
    expect((await caller(url)('GET', '/api/metrics')).status).toBe(404);
    const res = await fetch(`${url}/api/metrics`, { headers: { Authorization: 'Bearer metrics-secret' } });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toMatch(/^planar_users \d+$/m);
    expect(text).toMatch(/planar_registrations_total/);
  });

  it('sends Telegram alerts without leaking the token', async () => {
    const log = vi.spyOn(console, 'error');
    await until(() => sent.some((m) => /Server started/.test(m.body.text)));
    const ann = await signUp(url, 'alerted');
    await until(() => sent.some((m) => m.body.text.includes(`@${ann.username}`)));
    expect(sent.every((m) => m.path === `/bot${TOKEN}/sendMessage` && m.body.chat_id === '42')).toBe(true);
    expect((await boss.call('POST', '/api/admin/alerts/test', {})).status).toBe(200);
    expect(sent.at(-1)!.body.text).toMatch(/Test message/);
    // Repeated alerts of one kind are rate limited.
    const before = sent.length;
    await server.alerts.send('disk', 'low disk');
    await server.alerts.send('disk', 'low disk');
    expect(sent.length).toBe(before + 1);
    expect(log.mock.calls.flat().join(' ')).not.toContain(TOKEN);
    log.mockRestore();
  });
});
