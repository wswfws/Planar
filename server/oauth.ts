// OAuth 2.1 authorization server for the MCP endpoint, as the MCP
// authorization spec expects: protected-resource and authorization-server
// metadata, client ID metadata documents (CIMD) and dynamic client
// registration (DCR), authorization code + PKCE (S256), refresh tokens.
// Apps like Claude connect with it instead of a pasted API key.

import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { authenticate } from './api';
import type { Db, OAuthClient, User } from './db';
import type { Metrics } from './metrics';

const ACCESS_TTL = 60 * 60_000; // 1 hour
const REFRESH_TTL = 90 * 86_400_000; // 90 days
const CODE_TTL = 5 * 60_000;
const CONSENT_TTL = 10 * 60_000;

export interface OAuthContext {
  db: Db;
  metrics: Metrics;
  /** Public address, e.g. https://planar.example.com (default: from the request). */
  publicUrl?: string;
  /** Fetches a client ID metadata document (tests replace this). */
  fetchClientMetadata?: (url: string) => Promise<unknown>;
}

interface Code {
  userId: string;
  client: { clientId: string; clientName: string };
  redirectUri: string;
  challenge: string;
  expires: number;
}

interface Consent {
  userId: string;
  client: { clientId: string; clientName: string };
  redirectUri: string;
  challenge: string;
  state: string | null;
  expires: number;
}

const codes = new Map<string, Code>();
const consents = new Map<string, Consent>();
const cimdCache = new Map<string, { at: number; client: ResolvedClient }>();

interface ResolvedClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The server's public origin, as clients see it. */
export function publicBase(req: IncomingMessage, configured?: string): string {
  if (configured) return configured.replace(/\/+$/, '');
  const proto = (req.socket as { encrypted?: boolean }).encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host ?? 'localhost'}`;
}

/** Header that tells MCP clients where to find the authorization server. */
export function wwwAuthenticate(req: IncomingMessage, publicUrl?: string): string {
  return `Bearer resource_metadata="${publicBase(req, publicUrl)}/.well-known/oauth-protected-resource/mcp"`;
}

const sha256url = (s: string) => createHash('sha256').update(s).digest('base64url');

function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    // Native and CLI clients use loopback redirects.
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

function privateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase();
    return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Downloads a client ID metadata document, refusing anything but public HTTPS hosts. */
async function defaultFetchClientMetadata(url: string): Promise<unknown> {
  const u = new URL(url);
  if (isIP(u.hostname.replace(/^\[|\]$/g, '')) || u.hostname === 'localhost') throw new Error('host not allowed');
  const addresses = await lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => privateAddress(a.address))) throw new Error('host not allowed');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 64 * 1024) throw new Error('document too large');
  return JSON.parse(text);
}

/** The app behind a client_id: a metadata URL (CIMD) or a registered client (DCR). */
async function resolveClient(ctx: OAuthContext, clientId: string): Promise<ResolvedClient> {
  if (/^https:\/\//.test(clientId)) {
    const cached = cimdCache.get(clientId);
    if (cached && Date.now() - cached.at < 60 * 60_000) return cached.client;
    let doc: Record<string, unknown>;
    try {
      doc = (await (ctx.fetchClientMetadata ?? defaultFetchClientMetadata)(clientId)) as Record<string, unknown>;
    } catch (e) {
      throw new OAuthError('invalid_client', `Could not read the client metadata document (${(e as Error).message})`);
    }
    if (!doc || doc.client_id !== clientId) throw new OAuthError('invalid_client', 'The client metadata document does not match its URL');
    const redirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((r): r is string => typeof r === 'string' && validRedirect(r)) : [];
    if (!redirectUris.length) throw new OAuthError('invalid_client', 'The client metadata document has no usable redirect_uris');
    const client = { clientId, clientName: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 80) : new URL(clientId).hostname, redirectUris };
    cimdCache.set(clientId, { at: Date.now(), client });
    return client;
  }
  const registered = ctx.db.oauth.clients[clientId];
  if (!registered) throw new OAuthError('invalid_client', 'Unknown client');
  return registered;
}

function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c;
      if (raw.length > 64 * 1024) {
        reject(new OAuthError('invalid_request', 'Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        if ((req.headers['content-type'] ?? '').includes('application/json')) {
          const v = raw ? JSON.parse(raw) : {};
          resolve(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) ? (x as unknown as string) : String(x)])));
        } else resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch {
        reject(new OAuthError('invalid_request', 'Malformed body'));
      }
    });
    req.on('error', reject);
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Planar</title>
<style>
:root{color-scheme:dark;font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#18181d;color:#e6e6ee}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.card{width:min(420px,100%);background:#222229;border:1px solid #33333d;border-radius:12px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
h1{font-size:18px;margin:0 0 12px}p{margin:0 0 12px;color:#9a9aab}b{color:#e6e6ee}
ul{margin:0 0 16px;padding-left:18px;color:#9a9aab}
.row{display:flex;gap:8px;justify-content:flex-end}
button{font:inherit;height:34px;padding:0 16px;border-radius:6px;cursor:pointer;border:1px solid #33333d;background:transparent;color:#e6e6ee}
button.primary{background:#7b7bf0;border-color:#7b7bf0;color:#fff;font-weight:600}
code{font-size:12px;color:#9a9aab;word-break:break-all}
</style></head><body><main class="card">${body}</main></body></html>`);
}

function redirectWith(res: ServerResponse, redirectUri: string, params: Record<string, string | null>): void {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store' }).end();
}

function tokenResponse(db: Db, user: User, client: { clientId: string; clientName: string }) {
  return {
    access_token: db.issueOAuthToken('access', user.id, client, ACCESS_TTL),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL / 1000,
    refresh_token: db.issueOAuthToken('refresh', user.id, client, REFRESH_TTL),
    scope: 'planar',
  };
}

/** Handles /.well-known/oauth-* and /oauth/*. Returns false for other paths. */
export async function handleOAuth(req: IncomingMessage, res: ServerResponse, ctx: OAuthContext): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  if (!p.startsWith('/.well-known/oauth-') && !p.startsWith('/.well-known/openid-configuration') && !p.startsWith('/oauth/')) return false;
  const base = publicBase(req, ctx.publicUrl);
  const { db } = ctx;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
    return true;
  };

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version' }).end();
      return true;
    }

    if (p.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
        scopes_supported: ['planar'],
        resource_name: 'Planar',
        resource_documentation: 'https://github.com/wswfws/Planar/blob/main/docs/MCP.md',
      });
    }

    if (p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/.well-known/openid-configuration')) {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        revocation_endpoint: `${base}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['planar'],
        client_id_metadata_document_supported: true,
      });
    }

    // ---- dynamic client registration (RFC 7591) --------------------------
    if (p === '/oauth/register' && req.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await new Promise<string>((resolve, reject) => {
          let raw = '';
          req.on('data', (c: Buffer) => (raw += c).length > 64 * 1024 && req.destroy());
          req.on('end', () => resolve(raw || '{}'));
          req.on('error', reject);
        }));
      } catch {
        return json(400, { error: 'invalid_client_metadata', error_description: 'Body must be JSON' });
      }
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((r): r is string => typeof r === 'string') : [];
      if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) {
        return json(400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https (or http on localhost)' });
      }
      if (Object.keys(db.oauth.clients).length > 5000) return json(400, { error: 'invalid_client_metadata', error_description: 'Too many registered clients' });
      const client: OAuthClient = {
        clientId: `plc_${randomBytes(12).toString('base64url')}`,
        clientName: typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'MCP client',
        redirectUris: uris,
        createdAt: Date.now(),
      };
      db.oauth.clients[client.clientId] = client;
      db.touch('oauth');
      return json(201, {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        client_id_issued_at: Math.floor(client.createdAt / 1000),
      });
    }

    // ---- authorization (consent page) -------------------------------------
    if (p === '/oauth/authorize' && req.method === 'GET') {
      const q = url.searchParams;
      const clientId = q.get('client_id') ?? '';
      const redirectUri = q.get('redirect_uri') ?? '';
      // Problems with the client or redirect are shown here, never sent to an unverified address.
      let client: ResolvedClient;
      try {
        client = await resolveClient(ctx, clientId);
      } catch (e) {
        page(res, 400, 'Cannot connect', `<h1>Cannot connect this app</h1><p>${esc((e as Error).message)}</p>`);
        return true;
      }
      if (!client.redirectUris.includes(redirectUri)) {
        page(res, 400, 'Cannot connect', '<h1>Cannot connect this app</h1><p>The redirect address is not registered for this app.</p>');
        return true;
      }
      const state = q.get('state');
      const fail = (error: string, description: string) => redirectWith(res, redirectUri, { error, error_description: description, state, iss: base });
      if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported'), true;
      const challenge = q.get('code_challenge') ?? '';
      if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
        return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required'), true;
      }
      const resource = q.get('resource');
      if (resource && resource.replace(/\/+$/, '') !== `${base}/mcp` && resource.replace(/\/+$/, '') !== base) {
        return fail('invalid_target', 'Unknown resource'), true;
      }

      const { user, viaKey } = authenticate(req, db);
      if (!user || viaKey) {
        // Sign in first, then come back here.
        res.writeHead(302, { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store' }).end();
        return true;
      }
      const consentId = randomBytes(24).toString('base64url');
      consents.set(consentId, {
        userId: user.id,
        client: { clientId: client.clientId, clientName: client.clientName },
        redirectUri,
        challenge,
        state,
        expires: Date.now() + CONSENT_TTL,
      });
      for (const [k, c] of consents) if (c.expires < Date.now()) consents.delete(k);
      const host = new URL(redirectUri).host;
      page(
        res,
        200,
        'Allow access',
        `<h1>Allow <b>${esc(client.clientName)}</b> to use Planar?</h1>
<p>Signed in as <b>@${esc(user.username)}</b>. The app will act as you:</p>
<ul><li>see your files and files shared with you</li><li>create files and edit those you can edit</li></ul>
<p>You can disconnect it at any time in Planar under your account. <a href="/privacy" target="_blank" style="color:#8e8ef5">Privacy policy</a></p>
<p><code>Returns to ${esc(host)}</code></p>
<form method="post" action="/oauth/authorize" class="row">
<input type="hidden" name="consent" value="${consentId}">
<button type="submit" name="action" value="deny">Deny</button>
<button type="submit" name="action" value="allow" class="primary">Allow</button>
</form>`,
      );
      return true;
    }

    if (p === '/oauth/authorize' && req.method === 'POST') {
      const body = await readBody(req);
      const consent = consents.get(body.consent ?? '');
      consents.delete(body.consent ?? '');
      const { user, viaKey } = authenticate(req, db);
      if (!consent || consent.expires < Date.now() || !user || viaKey || user.id !== consent.userId) {
        page(res, 400, 'Expired', '<h1>This request expired</h1><p>Start connecting again from the app.</p>');
        return true;
      }
      const base_ = { state: consent.state, iss: base };
      if (body.action !== 'allow') {
        redirectWith(res, consent.redirectUri, { error: 'access_denied', error_description: 'The user denied access', ...base_ });
        return true;
      }
      const code = randomBytes(32).toString('base64url');
      codes.set(code, { userId: user.id, client: consent.client, redirectUri: consent.redirectUri, challenge: consent.challenge, expires: Date.now() + CODE_TTL });
      for (const [k, c] of codes) if (c.expires < Date.now()) codes.delete(k);
      ctx.metrics.event('info', `@${user.username} connected ${consent.client.clientName} (OAuth)`);
      redirectWith(res, consent.redirectUri, { code, ...base_ });
      return true;
    }

    // ---- token endpoint -----------------------------------------------------
    if (p === '/oauth/token' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.grant_type === 'authorization_code') {
        const code = codes.get(body.code ?? '');
        codes.delete(body.code ?? '');
        if (!code || code.expires < Date.now()) throw new OAuthError('invalid_grant', 'Unknown or expired code');
        if (code.client.clientId !== body.client_id) throw new OAuthError('invalid_grant', 'The code was issued to another client');
        if (code.redirectUri !== body.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match');
        if (!body.code_verifier || sha256url(body.code_verifier) !== code.challenge) throw new OAuthError('invalid_grant', 'PKCE verification failed');
        const user = db.users.get(code.userId);
        if (!user || user.blocked) throw new OAuthError('invalid_grant', 'The account is not available');
        return json(200, tokenResponse(db, user, code.client));
      }
      if (body.grant_type === 'refresh_token') {
        const t = db.oauthToken(body.refresh_token ?? '', 'refresh');
        if (!t || (body.client_id && body.client_id !== t.clientId)) throw new OAuthError('invalid_grant', 'Unknown or expired refresh token');
        const user = db.users.get(t.userId);
        if (!user || user.blocked) throw new OAuthError('invalid_grant', 'The account is not available');
        // Refresh tokens rotate: the old one stops working.
        db.dropOAuthToken(body.refresh_token);
        return json(200, tokenResponse(db, user, { clientId: t.clientId, clientName: t.clientName }));
      }
      throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
    }

    if (p === '/oauth/revoke' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.token) db.dropOAuthToken(body.token);
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }).end();
      return true;
    }

    return json(404, { error: 'not_found' });
  } catch (e) {
    if (e instanceof OAuthError) return json(e.status, { error: e.code, error_description: e.message });
    console.error('[planar] oauth error:', e);
    return json(500, { error: 'server_error' });
  }
}
