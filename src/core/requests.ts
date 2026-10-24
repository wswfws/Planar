// HTTP requests for the API requests tool: building a request from its parts,
// sending it (straight from the browser or through a Planar server), and a
// history of sent requests with their responses.

import { HTTP_METHODS, type HttpMethod, type KeyValue, type RequestBodyKind, type RequestSpec, type ResponseRecord, type SavedRequest } from './types';

export type { HttpMethod, KeyValue, RequestSpec, ResponseRecord, SavedRequest };

/** What the proxy endpoint (/api/http-proxy) accepts. */
export interface ProxyRequest {
  method: HttpMethod;
  url: string;
  headers: [string, string][];
  body?: string;
}

/** Response bodies longer than this are cut when they arrive. */
export const MAX_RESPONSE_BODY = 1024 * 1024;
/** The history lives in the document, which everyone downloads: it keeps less. */
export const MAX_SAVED_BODY = 100 * 1024;
export const MAX_HISTORY = 50;

export const METHODS = HTTP_METHODS;

export function newRequest(): RequestSpec {
  return { method: 'GET', url: '', params: [], headers: [], bodyKind: 'none', body: '', form: [] };
}

const active = (rows: KeyValue[]) => rows.filter((r) => r.enabled && r.key.trim());

/** The URL to call: adds http:// when no scheme is given and appends the enabled params. */
export function buildUrl(spec: Pick<RequestSpec, 'url' | 'params'>): string {
  let raw = spec.url.trim();
  if (!raw) throw new Error('Enter a URL');
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${spec.url.trim()}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs are supported');
  for (const p of active(spec.params)) url.searchParams.append(p.key.trim(), p.value);
  return url.toString();
}

/** Splits the query of a URL into params, leaving the rest as the URL. */
export function splitUrl(raw: string): { url: string; params: KeyValue[] } {
  const q = raw.indexOf('?');
  if (q < 0) return { url: raw, params: [] };
  const hash = raw.indexOf('#', q);
  const query = raw.slice(q + 1, hash < 0 ? undefined : hash);
  const params = [...new URLSearchParams(query)].map(([key, value]) => ({ key, value, enabled: true }));
  return { url: raw.slice(0, q) + (hash < 0 ? '' : raw.slice(hash)), params };
}

const bodyless = (method: HttpMethod) => method === 'GET' || method === 'HEAD';

/** The body to send and the Content-Type it implies (none for GET and HEAD). */
export function buildBody(spec: RequestSpec): { body?: string; contentType?: string } {
  if (bodyless(spec.method)) return {};
  switch (spec.bodyKind) {
    case 'json':
      return { body: spec.body, contentType: 'application/json' };
    case 'text':
      return { body: spec.body, contentType: 'text/plain;charset=UTF-8' };
    case 'form': {
      const form = new URLSearchParams();
      for (const f of active(spec.form)) form.append(f.key.trim(), f.value);
      return { body: form.toString(), contentType: 'application/x-www-form-urlencoded' };
    }
    default:
      return {};
  }
}

/** Enabled headers, plus Content-Type for the body unless one is set by hand. */
export function buildHeaders(spec: RequestSpec): [string, string][] {
  const headers: [string, string][] = active(spec.headers).map((h) => [h.key.trim(), h.value]);
  const { contentType } = buildBody(spec);
  if (contentType && !headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['Content-Type', contentType]);
  return headers;
}

/** Everything needed to send a request, checked; throws with a message for the user. */
export function prepareRequest(spec: RequestSpec): ProxyRequest {
  if (spec.bodyKind === 'json' && !bodyless(spec.method) && spec.body.trim()) {
    try {
      JSON.parse(spec.body);
    } catch (e) {
      throw new Error(`The JSON body is not valid: ${(e as Error).message}`);
    }
  }
  const { body } = buildBody(spec);
  return { method: spec.method, url: buildUrl(spec), headers: buildHeaders(spec), ...(body !== undefined ? { body } : {}) };
}

export function headerValue(headers: [string, string][], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([k]) => k.toLowerCase() === lower)?.[1];
}

/** The body for reading: JSON is indented, everything else is shown as it came. */
export function prettyBody(response: Pick<ResponseRecord, 'body' | 'headers'>): string {
  const type = headerValue(response.headers, 'content-type') ?? '';
  const text = response.body;
  if (/json/i.test(type) || /^\s*[[{]/.test(text)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // not JSON after all
    }
  }
  return text;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Cuts a body to `max` characters (about bytes for text). */
export function cutBody(body: string, max = MAX_RESPONSE_BODY): { body: string; truncated: boolean } {
  return body.length > max ? { body: body.slice(0, max), truncated: true } : { body, truncated: false };
}

type Fetch = typeof fetch;

/** Sends straight from the browser. Most APIs on other sites refuse this unless they allow CORS. */
export async function sendDirect(req: ProxyRequest, fetchImpl: Fetch = fetch): Promise<ResponseRecord> {
  const start = performance.now();
  let res: Response;
  try {
    res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: 'follow', credentials: 'omit' });
  } catch (e) {
    throw new Error(`The request failed: ${(e as Error).message}. The server may be down, or it does not allow requests from browsers (CORS).`);
  }
  const text = await res.text();
  const size = new TextEncoder().encode(text).length;
  const headers: [string, string][] = [];
  res.headers.forEach((value, key) => headers.push([key, value]));
  return {
    status: res.status,
    statusText: res.statusText,
    headers,
    ...cutBody(text),
    size,
    time: Math.round(performance.now() - start),
  };
}

/** Sends through a Planar server, which makes the call itself, so CORS does not apply. */
export async function sendViaProxy(req: ProxyRequest, endpoint = '/api/http-proxy', fetchImpl: Fetch = fetch): Promise<ResponseRecord> {
  let res: Response;
  try {
    res = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), credentials: 'same-origin' });
  } catch (e) {
    throw new Error(`Could not reach the Planar server: ${(e as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as { response?: ResponseRecord; error?: string };
  if (!res.ok || !data.response) throw new Error(data.error ?? `The Planar server answered ${res.status}`);
  return data.response;
}

// ---- history (kept in the document) ------------------------------------

const BODY_KINDS: readonly RequestBodyKind[] = ['none', 'json', 'text', 'form'];
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

function sanitizeRows(v: unknown): KeyValue[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r) => r && typeof r === 'object')
    .slice(0, 200)
    .map((r) => ({ key: text(r.key, 1000), value: text(r.value, 20000), enabled: r.enabled !== false }));
}

export function sanitizeRequestSpec(v: unknown): RequestSpec {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    method: (HTTP_METHODS as readonly string[]).includes(r.method as string) ? (r.method as HttpMethod) : 'GET',
    url: text(r.url, 8000),
    params: sanitizeRows(r.params),
    headers: sanitizeRows(r.headers),
    bodyKind: BODY_KINDS.includes(r.bodyKind as RequestBodyKind) ? (r.bodyKind as RequestBodyKind) : 'none',
    body: text(r.body, MAX_SAVED_BODY),
    form: sanitizeRows(r.form),
  };
}

function sanitizeResponse(v: unknown): ResponseRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const headers = Array.isArray(r.headers)
    ? r.headers.filter((h): h is [string, string] => Array.isArray(h) && typeof h[0] === 'string').slice(0, 200).map(([k, val]) => [k, String(val ?? '')] as [string, string])
    : [];
  const body = typeof r.body === 'string' ? r.body : '';
  return {
    status: Number(r.status) || 0,
    statusText: text(r.statusText, 200),
    headers,
    body: body.slice(0, MAX_SAVED_BODY),
    truncated: r.truncated === true || body.length > MAX_SAVED_BODY,
    size: Number(r.size) || 0,
    time: Number(r.time) || 0,
  };
}

/** Request history from a file: well-formed entries, newest first, within the limits. */
export function sanitizeRequests(v: unknown): SavedRequest[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e) => e && typeof e === 'object' && typeof e.id === 'string')
    .slice(0, MAX_HISTORY)
    .map((e) => ({
      id: e.id,
      ...(typeof e.name === 'string' && e.name.trim() ? { name: e.name.slice(0, 200) } : {}),
      at: Number(e.at) || 0,
      ...(typeof e.author === 'string' && e.author ? { author: e.author.slice(0, 100) } : {}),
      request: sanitizeRequestSpec(e.request),
      response: sanitizeResponse(e.response),
      ...(typeof e.error === 'string' && e.error ? { error: e.error.slice(0, 2000) } : {}),
      via: e.via === 'proxy' ? ('proxy' as const) : ('direct' as const),
    }));
}

/** A history entry for a request just sent, with the response cut to what the document keeps. */
export function savedRequest(entry: Omit<SavedRequest, 'id' | 'at'> & { at?: number }): SavedRequest {
  return sanitizeRequests([{ ...entry, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), at: entry.at ?? Date.now() }])[0];
}

/** How an entry is listed: its name, or the method and URL. */
export function entryTitle(e: SavedRequest): string {
  return e.name || `${e.request.method} ${e.request.url.replace(/^https?:\/\//, '') || '(no URL)'}`;
}
