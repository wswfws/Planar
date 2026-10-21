import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server';

// Planar collaboration server. Configuration comes from the environment:
//   PORT          HTTP/WebSocket port (default 8080)
//   HOST          interface to bind (default 0.0.0.0)
//   DATA_DIR      where accounts and documents are stored (default ./data)
//   STATIC_DIR    built editor to serve (default ./dist next to this file)
//   LEGACY_OWNER  username that takes over documents saved before accounts existed
//   ADMIN_USERS   comma-separated usernames that may open /admin
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   alerts and a daily summary in Telegram
//   METRICS_TOKEN bearer token that enables /api/metrics (Prometheus format)

const here = path.dirname(fileURLToPath(import.meta.url));

const server = await startServer({
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST,
  dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  staticDir: path.resolve(process.env.STATIC_DIR ?? path.join(here, '..', 'dist')),
  legacyOwner: process.env.LEGACY_OWNER || undefined,
  admins: (process.env.ADMIN_USERS ?? '').split(','),
  telegram: { token: process.env.TELEGRAM_BOT_TOKEN || undefined, chatId: process.env.TELEGRAM_CHAT_ID || undefined },
  metricsToken: process.env.METRICS_TOKEN || undefined,
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
process.on('unhandledRejection', (e) => {
  console.error('[planar] unhandled rejection:', e);
  server.metrics.event('error', `Unhandled rejection: ${(e as Error)?.message ?? e}`);
  void server.alerts.send('crash', `Unhandled error: ${(e as Error)?.message ?? e}`);
});
process.on('uncaughtException', (e) => {
  console.error('[planar] crash:', e);
  // Docker restarts the container; give the alert a moment to go out first.
  void server.alerts.send('crash', `Server crashed: ${e.message}. Restarting.`, true).finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref();
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
