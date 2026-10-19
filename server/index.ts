import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server';

// Planar collaboration server. Configuration comes from the environment:
//   PORT          HTTP/WebSocket port (default 8080)
//   HOST          interface to bind (default 0.0.0.0)
//   DATA_DIR      where shared documents are stored (default ./data)
//   STATIC_DIR    built editor to serve (default ./dist next to this file)
//   PLANAR_TOKEN  optional access token clients must provide

const here = path.dirname(fileURLToPath(import.meta.url));

const server = await startServer({
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST,
  dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  staticDir: path.resolve(process.env.STATIC_DIR ?? path.join(here, '..', 'dist')),
  token: process.env.PLANAR_TOKEN || undefined,
});

console.log(`[planar] collaboration server listening on port ${server.port}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log('[planar] shutting down, saving rooms…');
  await server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
