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

export function createMcpHandler(opts: { db: Db; localServer: () => string }) {
  const sessions = new Map<string, Entry>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, e] of sessions) {
      if (now - e.lastSeen > IDLE_MS) {
        e.session.close();
        void e.transport.close();
        sessions.delete(id);
      }
    }
  }, 60_000);
  sweep.unref();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const key = apiKey(req);
    if (!opts.db.keyUser(key)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'Missing or revoked API key. Create one in Planar (account menu → API keys) and send Authorization: Bearer plk_…' }));
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
      const session = new AgentSession({ allowFiles: false, localServer: opts.localServer(), key, name: 'Agent' });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, session, lastSeen: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        session.close();
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
    close: () => {
      clearInterval(sweep);
      for (const e of sessions.values()) {
        e.session.close();
        void e.transport.close();
      }
      sessions.clear();
    },
  };
}
