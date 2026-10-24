// Remote MCP endpoint (/mcp) on the collaboration server: agents connect over
// Streamable HTTP and join rooms on this same server as live participants.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { AgentSession } from '../src/agent/session';
import { INSTRUCTIONS, registerTools } from '../src/agent/tools';
import type { Db } from './db';
import { publicBase, wwwAuthenticate } from './oauth';

interface Entry {
  transport: StreamableHTTPServerTransport;
  session: AgentSession;
  lastSeen: number;
}

const MAX_BODY = 50 * 1024 * 1024;
const IDLE_MS = 30 * 60 * 1000;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** The personal API key (`plk_…`) of a request: Bearer header, or `?key=` for clients that cannot set headers. */
function apiKey(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return new URL(req.url ?? '/', 'http://localhost').searchParams.get('key') ?? '';
}

export function createMcpHandler(opts: { db: Db; localServer: () => string; publicUrl?: string; proxyPrivateHosts?: boolean }) {
  const sessions = new Map<string, Entry>();
  // Some clients (ChatGPT) start a fresh MCP session per tool call, and may end it right after,
  // so the open file lives per agent (API key, or OAuth user + app) and outlasts its MCP sessions for a while.
  const shared = new Map<string, { session: AgentSession; refs: number; idle?: ReturnType<typeof setTimeout> }>();

  /** Stable across OAuth token refreshes, which hand out a new access token every hour. */
  const agentId = (key: string): string => {
    const t = key.startsWith('pla_') ? opts.db.oauthToken(key, 'access') : null;
    return t ? `oauth:${t.userId}:${t.clientId}` : key;
  };

  const acquire = (id: string, key: string, req: IncomingMessage): AgentSession => {
    let s = shared.get(id);
    if (!s) {
      s = { session: new AgentSession({ allowFiles: false, localServer: opts.localServer(), key, name: 'Agent', publicUrl: publicBase(req, opts.publicUrl), allowPrivateHosts: opts.proxyPrivateHosts }), refs: 0 };
      shared.set(id, s);
    }
    clearTimeout(s.idle);
    s.session.opts.key = key;
    s.refs++;
    return s.session;
  };

  const release = (id: string): void => {
    const s = shared.get(id);
    if (!s || --s.refs > 0) return;
    s.idle = setTimeout(() => {
      s.session.close();
      shared.delete(id);
    }, IDLE_MS);
    s.idle.unref();
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, e] of sessions) {
      if (now - e.lastSeen > IDLE_MS) {
        sessions.delete(id);
        void e.transport.close(); // onclose releases the session
      }
    }
  }, 60_000);
  sweep.unref();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const key = apiKey(req);
    if (!opts.db.keyUser(key)) {
      // MCP clients follow resource_metadata to sign in with OAuth.
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthenticate(req, opts.publicUrl) });
      res.end(JSON.stringify({ error: 'Sign in with OAuth, or send Authorization: Bearer plk_… (account menu → API keys).' }));
      return;
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readBody(req);
      } catch (e) {
        res.writeHead(400).end(String((e as Error).message));
        return;
      }
    }

    let entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        res.writeHead(sessionId ? 404 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sessionId ? 'Unknown session' : 'Start with an initialize request' }, id: null }));
        return;
      }
      const id = agentId(key);
      const session = acquire(id, key, req);
      let released = false;
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, session, lastSeen: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        if (!released) {
          released = true;
          release(id);
        }
      };
      const server = new McpServer({ name: 'planar', version: '0.2.0' }, { instructions: INSTRUCTIONS });
      registerTools(server, session);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    entry.lastSeen = Date.now();
    await entry.transport.handleRequest(req, res, body);
  };

  return {
    handle,
    count: () => sessions.size,
    close: () => {
      clearInterval(sweep);
      for (const e of sessions.values()) void e.transport.close();
      sessions.clear();
      for (const s of shared.values()) {
        clearTimeout(s.idle);
        s.session.close();
      }
      shared.clear();
    },
  };
}
