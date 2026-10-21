// Planar MCP server over stdio.
//
//   node dist-mcp/index.js [--file design.planar.json] [--link <file link>] [--server https://host] [--key plk_…] [--name Agent]
//   The key can also come from PLANAR_KEY, the server from PLANAR_SERVER.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initCanvas } from '../src/agent/raster';
import { AgentSession, parseLink } from '../src/agent/session';
import { INSTRUCTIONS, registerTools } from '../src/agent/tools';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const log = (msg: string) => process.stderr.write(`[planar-mcp] ${msg}\n`);

await initCanvas();

const session = new AgentSession({
  allowFiles: true,
  key: arg('key') ?? process.env.PLANAR_KEY,
  server: arg('server') ?? process.env.PLANAR_SERVER,
  name: arg('name') ?? 'Agent',
});
try {
  const file = arg('file');
  const link = arg('link');
  if (file) log(await session.openFile(file));
  else if (link) log(await session.openRoom(parseLink(link)));
} catch (e) {
  log(`Could not open on start: ${(e as Error).message}`);
}

const server = new McpServer({ name: 'planar', version: '0.2.0' }, { instructions: INSTRUCTIONS });
registerTools(server, session);
await server.connect(new StdioServerTransport());
log(`ready (${session.describe()})`);

const stop = () => {
  session.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.stdin.on('close', stop);
