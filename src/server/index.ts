/**
 * Gnito — server entry.
 * Binds to loopback by default. See docs/security.md.
 * Serves the built frontend (dist/client) + API from one origin.
 */
import { createApp } from './api/app.js';
import { CONFIG, ensureDataDir } from './config.js';
import { startScheduler } from './api/automations.js';
import { createServer } from 'node:http';

ensureDataDir();
const app = createApp();

const httpServer = createServer(app);

httpServer.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[gnito] listening on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`[gnito] data dir: ${CONFIG.dataDir}`);
  if (CONFIG.host === '127.0.0.1' || CONFIG.host === 'localhost') {
    console.log('[gnito] security: bound to loopback only.');
  } else {
    console.warn('[gnito] WARNING: bound to non-loopback interface. This exposes your data to the network.');
  }
  startScheduler();
});

process.on('SIGINT', () => {
  console.log('[gnito] shutting down…');
  httpServer.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0));
});
