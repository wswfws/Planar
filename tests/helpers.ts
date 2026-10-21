import { startServer } from '../server/server';

export type TestServer = Awaited<ReturnType<typeof startServer>>;

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await wait(10);
  }
}

export interface Call {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
}

export interface Account {
  username: string;
  cookie: string;
  /** Personal API key (plk_…). */
  key: string;
  call: (method: string, path: string, body?: unknown) => Promise<Call>;
}

let counter = 0;

/** Calls the API as a signed-out visitor (or with the given cookie / key). */
export function caller(url: string, auth: { cookie?: string; key?: string } = {}) {
  return async (method: string, path: string, body?: unknown): Promise<Call> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth.cookie) headers.Cookie = auth.cookie;
    if (auth.key) headers.Authorization = `Bearer ${auth.key}`;
    const res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };
}

/** Registers a fresh user and issues them an API key. */
export async function signUp(url: string, name = 'user'): Promise<Account> {
  const username = `${name}${++counter}`;
  const reg = await caller(url)('POST', '/api/auth/register', { username, password: 'correct horse', displayName: name[0].toUpperCase() + name.slice(1) });
  if (reg.status !== 200) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const cookie = reg.headers.get('set-cookie')!.split(';')[0];
  const call = caller(url, { cookie });
  const key = (await call('POST', '/api/me/keys', { name: 'test' })).body.secret as string;
  return { username, cookie, key, call };
}
