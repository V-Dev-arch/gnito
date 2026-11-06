/**
 * Gnito — Express app (routes are registered via a single function per module).
 * Binds to loopback by default. See docs/security.md.
 */
import express, { type Express, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, ensureDataDir } from '../config.js';
import { getDb } from '../db/index.js';
import { requireSession, createSession, revokeSession, rateLimit, isTrustedOrigin } from '../security/auth.js';
import { redactSecrets, truncateForLog } from '../security/redact.js';

ensureDataDir();
getDb(); // initialize + migrate

import { registerChatRoutes } from './chat.js';
import { registerMemoryRoutes } from './memory.js';
import { registerProjectRoutes } from './projects.js';
import { registerProviderRoutes } from './providers.js';
import { registerToolRoutes } from './tools.js';
import { registerFileRoutes } from './files.js';
import { registerAutomationRoutes } from './automations.js';
import { registerPluginRoutes } from './plugins.js';
import { registerIncognitoRoutes } from './incognito.js';
import { registerSettingsRoutes } from './settings.js';
import { registerBackupRoutes } from './backup.js';
import { registerMediaRoutes } from './media.js';

export function createApp(): Express {
  const app = express();

  app.use(express.json({ limit: CONFIG.maxBodyBytes }));
  app.use(express.urlencoded({ extended: false, limit: CONFIG.maxBodyBytes }));
  app.set('trust proxy', false);
  app.disable('x-powered-by');

  // --- session bootstrap (unauthenticated) ---
  app.post('/api/session', (req: Request, res: Response) => {
    // Only issue a session from a trusted (loopback) origin.
    if (!isTrustedOrigin(req)) {
      res.status(403).json({ error: 'csrf', message: 'Untrusted origin.' });
      return;
    }
    const ip: string = req.ip || 'unknown';
    if (!rateLimit(`session:${ip}`, 10)) {
      res.status(429).json({ error: 'rate-limit' });
      return;
    }
    const { token, csrf } = createSession();
    res.json({ token, csrf, dataDir: CONFIG.dataDir });
  });

  app.post('/api/session/logout', (req: Request, res: Response) => {
    revokeSession(req.header('x-gnito-session'));
    res.json({ ok: true });
  });

  // --- authenticated routes ---
  app.use('/api', requireSession);

  app.get('/api/health', (_req: Request, res: Response) => {
    try {
      getDb().prepare('SELECT 1').get();
      res.json({ status: 'ok', uptimeSec: Math.floor(process.uptime()) });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  registerChatRoutes(app);
  registerMemoryRoutes(app);
  registerProjectRoutes(app);
  registerProviderRoutes(app);
  registerToolRoutes(app);
  registerFileRoutes(app);
  registerAutomationRoutes(app);
  registerPluginRoutes(app);
  registerIncognitoRoutes(app);
  registerSettingsRoutes(app);
  registerBackupRoutes(app);
  registerMediaRoutes(app);

  // Serve the built frontend (dist/client) — registered BEFORE the 404 handler
  // so /api/* is handled first but static assets take precedence over 404.
  serveStaticFrontend(app);

  // 404 handler — registered last.
  app.use((req: any, res: any) => {
    res.status(404).json({ error: 'not-found', message: 'Unknown endpoint.' });
  });

  app.use((err: any, req: any, res: any, _next: any) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    const message = redactSecrets(truncateForLog(err.message || 'Internal server error', 500));
    console.error(`[gnito] ${req.method} ${req.originalUrl} → ${status}: ${message}`);
    if (process.env.GNITO_DEBUG === '1' && err.stack) {
      console.error(redactSecrets(err.stack.split('\n').slice(0, 10).join('\n')));
    }
    res.status(status).json({ error: 'server-error', message });
  });

  return app;
}

/** Serve the built frontend (dist/client) + SPA fallback. */
function serveStaticFrontend(app: Express): void {
  const CLIENT_DIST = path.resolve(process.cwd(), 'dist/client');
  if (!fs.existsSync(CLIENT_DIST)) {
    console.warn('[gnito] WARNING: dist/client not found. Run `npm run build` first.');
    return;
  }
  app.use(express.static(CLIENT_DIST));
  app.use((req: any, res: any, next: any) => {
    if (req.path.startsWith('/api')) return next();
    const indexFile = path.join(CLIENT_DIST, 'index.html');
    if (fs.existsSync(indexFile)) {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'");
      res.sendFile(indexFile);
    } else {
      next();
    }
  });
  console.log(`[gnito] serving frontend from ${CLIENT_DIST}`);
}
