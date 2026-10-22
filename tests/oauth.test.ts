import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redirectAllowed } from '../server/oauth';
import { startServer } from '../server/server';
import { signUp, type Account, type TestServer } from './helpers';

const CIMD_URL = 'https://claude.example/oauth/client.json';
const REDIRECT = 'https://claude.example/api/mcp/auth_callback';

let server: TestServer;
let url = '';
let ann: Account;

beforeAll(async () => {
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: null,
    staticDir: null,
    authLimit: 1000,
    fetchClientMetadata: async (u) => {
      if (u !== CIMD_URL) throw new Error('not found');
      return { client_id: CIMD_URL, client_name: 'Claude', redirect_uris: [REDIRECT] };
    },
  });
  url = `http://127.0.0.1:${server.port}`;
  ann = await signUp(url, 'ann');
});

afterAll(async () => {
  await server.close();
});

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

function authorizeUrl(clientId: string, redirectUri: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', ...extra });
  return `${url}/oauth/authorize?${q}`;
}

/** Walks through sign-in and consent like a browser, returns the redirect with the code. */
async function approve(clientId: string, redirectUri: string, challenge: string, action = 'allow'): Promise<URL> {
  const page = await fetch(authorizeUrl(clientId, redirectUri, challenge, { resource: `${url}/mcp` }), { headers: { Cookie: ann.cookie }, redirect: 'manual' });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('Allow');
  const consent = /name="consent" value="([^"]+)"/.exec(html)![1];
  const res = await fetch(`${url}/oauth/authorize`, {
    method: 'POST',
    headers: { Cookie: ann.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ consent, action }),
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}

const token = (body: Record<string, string>) =>
  fetch(`${url}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then(
    async (r) => ({ status: r.status, body: (await r.json()) as Record<string, string> }),
  );

describe('discovery', () => {
  it('points unauthenticated MCP clients at the metadata', async () => {
    const res = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`);
    const pr = await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(pr.resource).toBe(`${url}/mcp`);
    expect(pr.authorization_servers).toEqual([url]);
    const as = await (await fetch(`${url}/.well-known/oauth-authorization-server`)).json();
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.registration_endpoint).toBe(`${url}/oauth/register`);
  });
});

describe('authorization code flow', () => {
  it('works with a client ID metadata document (CIMD) and opens MCP', async () => {
    const { challenge } = pkce();
    const back = await approve(CIMD_URL, REDIRECT, challenge);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    const code = back.searchParams.get('code')!;

    // Wrong verifier fails, and the code is single use.
    expect((await token({ grant_type: 'authorization_code', code, client_id: CIMD_URL, redirect_uri: REDIRECT, code_verifier: 'x'.repeat(43) })).status).toBe(400);
    const { verifier: v2, challenge: c2 } = pkce();
    const code2 = (await approve(CIMD_URL, REDIRECT, c2)).searchParams.get('code')!;
    const t = await token({ grant_type: 'authorization_code', code: code2, client_id: CIMD_URL, redirect_uri: REDIRECT, code_verifier: v2 });
    expect(t.status).toBe(200);
    expect(t.body.access_token).toMatch(/^pla_/);
    expect(t.body.refresh_token).toMatch(/^plr_/);

    // The access token works for the MCP endpoint and the REST API as this user.
    const mcp = new Client({ name: 'oauth-test', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${t.body.access_token}` } } }));
    const made = (await mcp.callTool({ name: 'files', arguments: { action: 'create', name: 'Via OAuth' } })) as { content: { text: string }[] };
    expect(made.content[0].text).toMatch(/Via OAuth/);
    await mcp.close();
    const files = (await ann.call('GET', '/api/files')).body.files.map((f: { name: string }) => f.name);
    expect(files).toContain('Via OAuth');

    // Refresh tokens rotate.
    const r = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: CIMD_URL });
    expect(r.status).toBe(200);
    expect((await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: CIMD_URL })).status).toBe(400);

    // The account page lists the app, and disconnecting it revokes the tokens.
    const apps = (await ann.call('GET', '/api/me/apps')).body.apps;
    expect(apps.map((a: { name: string }) => a.name)).toContain('Claude');
    await ann.call('DELETE', `/api/me/apps/${encodeURIComponent(CIMD_URL)}`);
    const after = await fetch(`${url}/api/me`, { headers: { Authorization: `Bearer ${r.body.access_token}` } });
    expect((await after.json()).user).toBeNull();
  });

  it('works with dynamic client registration (DCR)', async () => {
    const reg = await fetch(`${url}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Some agent', redirect_uris: ['http://127.0.0.1:33418/callback'] }),
    });
    expect(reg.status).toBe(201);
    const clientId = (await reg.json()).client_id;
    const { verifier, challenge } = pkce();
    const back = await approve(clientId, 'http://127.0.0.1:33418/callback', challenge);
    const t = await token({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: clientId, redirect_uri: 'http://127.0.0.1:33418/callback', code_verifier: verifier });
    expect(t.status).toBe(200);
  });

  it('returns access_denied when the person says no', async () => {
    const { challenge } = pkce();
    const back = await approve(CIMD_URL, REDIRECT, challenge, 'deny');
    expect(back.searchParams.get('error')).toBe('access_denied');
  });

  it('sends signed-out people to sign in, then back', async () => {
    const { challenge } = pkce();
    const res = await fetch(authorizeUrl(CIMD_URL, REDIRECT, challenge), { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/login\?next=%2Foauth%2Fauthorize/);
  });

  it('never redirects to an address the client did not register', async () => {
    const { challenge } = pkce();
    const res = await fetch(authorizeUrl(CIMD_URL, 'https://evil.example/cb', challenge), { headers: { Cookie: ann.cookie }, redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    const bad = await fetch(authorizeUrl('https://unknown.example/c.json', REDIRECT, challenge), { headers: { Cookie: ann.cookie }, redirect: 'manual' });
    expect(bad.status).toBe(400);
  });

  it('requires PKCE', async () => {
    const res = await fetch(`${url}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CIMD_URL, redirect_uri: REDIRECT, state: 's' })}`, {
      headers: { Cookie: ann.cookie },
      redirect: 'manual',
    });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });
});

describe('loopback redirects', () => {
  it('accepts any port for registered loopback addresses, and nothing else', () => {
    const reg = ['http://localhost/callback', 'http://127.0.0.1/callback'];
    expect(redirectAllowed(reg, 'http://localhost:49141/callback')).toBe(true);
    expect(redirectAllowed(reg, 'http://127.0.0.1:5000/callback')).toBe(true);
    expect(redirectAllowed(reg, 'http://localhost:49141/other')).toBe(false);
    expect(redirectAllowed(reg, 'http://[::1]:49141/callback')).toBe(false);
    expect(redirectAllowed(reg, 'https://localhost:49141/callback')).toBe(false);
    expect(redirectAllowed(reg, 'http://evil.example:80/callback')).toBe(false);
    // Non-loopback addresses must match exactly, port included.
    expect(redirectAllowed(['https://app.example/cb'], 'https://app.example:8443/cb')).toBe(false);
    expect(redirectAllowed(['https://app.example/cb'], 'https://app.example/cb')).toBe(true);
  });
});
