import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
import { HTTP_METHODS, type ResponseRecord } from '../src/core/types';
import { cutBody } from '../src/core/requests';

// Sends requests for the API requests tool on behalf of signed-in people, so
// APIs that do not allow browsers (CORS) can be called. Addresses inside the
// server's own network are refused unless the server is told otherwise.

const TIMEOUT_MS = 30_000;
/** Bodies over this are cut; what is read never exceeds it by more than one chunk. */
const MAX_BODY = 1024 * 1024;
const MAX_REQUEST_BODY = 5 * 1024 * 1024;

/** Headers the proxy sets itself or that make no sense to forward. */
const DROPPED = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-authorization', 'te', 'trailer']);

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net4, prefix, 'ipv4');
}
for (const [net6, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net6, prefix, 'ipv6');
}

/** True for loopback, private, link-local and other addresses that are not on the public internet. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  const family = net.isIP(address);
  if (!family) return true;
  return blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** DNS lookup that refuses private addresses, checked on the address actually connected to. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) {
      const e = Object.assign(new Error(`${hostname} is an address inside the server's network`), { code: 'EPRIVATE' });
      return callback(e, '', 0);
    }
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

export class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ProxyInput {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
}

/** Checks what the browser sent; throws ProxyError(400) when it is not a request we can send. */
export function parseProxyInput(v: Record<string, unknown>): ProxyInput {
  const method = String(v.method ?? '').toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) throw new ProxyError(400, 'Unsupported method');
  let url: URL;
  try {
    url = new URL(String(v.url ?? ''));
  } catch {
    throw new ProxyError(400, 'Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProxyError(400, 'Only http and https URLs are supported');
  if (url.username || url.password) throw new ProxyError(400, 'Put credentials in an Authorization header, not in the URL');
  const headers = Array.isArray(v.headers)
    ? v.headers
        .filter((h): h is [string, string] => Array.isArray(h) && typeof h[0] === 'string' && typeof h[1] === 'string')
        .filter(([k]) => /^[!#$%&'*+.^_`|~\w-]+$/.test(k) && !DROPPED.has(k.toLowerCase()))
        .slice(0, 100)
    : [];
  if (v.body !== undefined && typeof v.body !== 'string') throw new ProxyError(400, 'The body must be text');
  const body = v.body as string | undefined;
  if (body && Buffer.byteLength(body) > MAX_REQUEST_BODY) throw new ProxyError(413, 'The request body is too large');
  return { method, url: url.toString(), headers, body };
}

/** Makes the request and reads the response (redirects are returned, not followed). */
export function proxyRequest(input: ProxyInput, opts: { allowPrivate?: boolean } = {}): Promise<ResponseRecord> {
  const url = new URL(input.url);
  if (!opts.allowPrivate && net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
    return Promise.reject(new ProxyError(403, `${url.hostname} is an address inside the server's network`));
  }
  const lib = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = { 'User-Agent': 'Planar', Accept: '*/*' };
  for (const [k, v] of input.headers) headers[k] = v;
  if (input.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(input.body));

  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = lib.request(url, { method: input.method, headers, lookup: opts.allowPrivate ? undefined : publicLookup, timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let kept = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (kept < MAX_BODY) {
          chunks.push(c);
          kept += c.length;
        }
      });
      res.on('end', () => {
        const pairs: [string, string][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        const { body, truncated } = cutBody(Buffer.concat(chunks).toString('utf8'), MAX_BODY);
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: pairs,
          body,
          truncated: truncated || size > kept,
          size,
          time: Date.now() - start,
        });
      });
      res.on('error', (e) => reject(new ProxyError(502, `The response broke off: ${e.message}`)));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`No answer in ${TIMEOUT_MS / 1000} s`), { code: 'ETIMEDOUT' })));
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EPRIVATE') reject(new ProxyError(403, e.message));
      else reject(new ProxyError(502, `The request failed: ${e.message}`));
    });
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
}
