/**
 * Gnito — plugins API.
 *
 * A plugin is a directory under DATA_DIR/plugins/<id>/ containing:
 *  - manifest.json (validated against PluginManifestSchema)
 *  - index.js (optional, exports tools via a limited SDK)
 *
 * SECURITY: plugin code runs in the same Node process but with restricted
 * capabilities (no direct fs/network — must go through the tool registry).
 * We honestly disclose this is process-level isolation, not a real sandbox.
 */
import type { Request, Response } from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { PluginManifestSchema } from '../../shared/types.js';
import { CONFIG } from '../config.js';
import { deleteGitHubToken, getGitHubToken, githubApiRequest, githubScopes, setGitHubToken, validateGitHubToken } from '../plugins/github.js';

const db = getDb();
const PLUGINS_DIR = path.join(CONFIG.dataDir, 'plugins');
const GITHUB_PLUGIN = {
  id: 'github',
  builtIn: true,
  manifest: {
    name: 'GitHub',
    version: '1.0.0',
    description: 'Use GitHub through the REST API. Repository, issue, pull request, file, and workflow access follows the permissions granted to your PAT.',
    author: 'Gnito',
    license: 'MIT',
    permissions: ['github:read', 'github:write'],
    tools: ['github_api'],
  },
};

async function ensurePluginsDir(): Promise<void> {
  await fs.mkdir(PLUGINS_DIR, { recursive: true });
}

// ---------------------------------------------------------------- routes

export function registerPluginRoutes(app: any): void {
  // List installed plugins.
  app.get('/api/plugins', async (_req: Request, res: Response) => {
    await ensurePluginsDir();
    const rows = db.prepare('SELECT * FROM plugins').all() as any[];
    const out = [];
    for (const r of rows) {
      try {
        const manifest = JSON.parse(r.manifest);
        out.push({
          id: r.id,
          manifest,
          enabled: !!r.enabled,
          config: JSON.parse(r.config || '{}'),
          state: r.state,
          lastUsedAt: r.last_used_at,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        });
      } catch { /* skip malformed */ }
    }
    res.json([{ ...GITHUB_PLUGIN, enabled: !!getGitHubToken(), state: getGitHubToken() ? 'connected' : 'not-configured' }, ...out]);
  });

  app.get('/api/plugins/github/status', async (_req: Request, res: Response) => {
    if (!getGitHubToken()) { res.json({ ...GITHUB_PLUGIN, connected: false }); return; }
    const result = await githubApiRequest({ method: 'GET', path: '/user' });
    if ('error' in result) { res.json({ ...GITHUB_PLUGIN, connected: false, error: result.error }); return; }
    res.json({ ...GITHUB_PLUGIN, connected: true, login: result.data?.login || '', scopes: githubScopes(result.headers) });
  });

  app.post('/api/plugins/github/connect', async (req: Request, res: Response) => {
    const parsed = z.object({ token: z.string().trim().min(20).max(500) }).safeParse(req.body);
    if (!parsed.success || !validateGitHubToken(parsed.data?.token || '')) {
      res.status(400).json({ error: 'validation', message: 'Enter a GitHub classic or fine-grained personal access token.' });
      return;
    }
    setGitHubToken(parsed.data.token);
    const result = await githubApiRequest({ method: 'GET', path: '/user' });
    if ('error' in result) {
      deleteGitHubToken();
      res.status(400).json({ error: 'github-authentication-failed', message: result.error });
      return;
    }
    res.json({ ok: true, login: result.data?.login || '', scopes: githubScopes(result.headers) });
  });

  app.delete('/api/plugins/github', (_req: Request, res: Response) => {
    deleteGitHubToken();
    res.json({ ok: true });
  });

  // Install a plugin from a local directory path.
  app.post('/api/plugins/install', async (req: Request, res: Response) => {
    const parsed = z.object({ sourcePath: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    await ensurePluginsDir();

    const sourcePath = path.resolve(parsed.data.sourcePath);
    // Security: only allow install from the user's home or /tmp, not /etc etc.
    const HOME = process.env.HOME || '/tmp';
    if (!sourcePath.startsWith(HOME) && !sourcePath.startsWith('/tmp')) {
      res.status(403).json({ error: 'invalid-source', message: 'Plugin source must be inside your home or /tmp.' });
      return;
    }
    const manifestPath = path.join(sourcePath, 'manifest.json');
    if (!fsSync.existsSync(manifestPath)) {
      res.status(400).json({ error: 'missing-manifest' });
      return;
    }
    let manifestRaw: any;
    try {
      manifestRaw = JSON.parse(fsSync.readFileSync(manifestPath, 'utf8'));
    } catch {
      res.status(400).json({ error: 'invalid-manifest-json' });
      return;
    }
    const manifestCheck = PluginManifestSchema.safeParse(manifestRaw);
    if (!manifestCheck.success) {
      res.status(400).json({ error: 'invalid-manifest', issues: manifestCheck.error.issues });
      return;
    }
    const manifest = manifestCheck.data;

    // Copy to plugins dir.
    const id = randomUUID();
    const dest = path.join(PLUGINS_DIR, id);
    await fs.cp(sourcePath, dest, { recursive: true });

    // Register in DB.
    const now = Date.now();
    db.prepare(`
      INSERT INTO plugins (id, manifest, enabled, config, state, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(id, JSON.stringify(manifest), 1, '{}', 'installed', now, now);
    res.status(201).json({ id, state: 'installed' });
  });

  // Enable/disable.
  app.patch('/api/plugins/:id', async (req: Request, res: Response) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    db.prepare('UPDATE plugins SET enabled=?, updated_at=? WHERE id=?')
      .run(parsed.data.enabled ? 1 : 0, Date.now(), req.params.id);
    res.json({ ok: true });
  });

  // Uninstall (removes directory + DB row).
  app.delete('/api/plugins/:id', async (req: Request, res: Response) => {
    const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    const dir = path.join(PLUGINS_DIR, req.params.id);
    await fs.rm(dir, { recursive: true, force: true });
    db.prepare('DELETE FROM plugins WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // Read a plugin's tools (for agent use).
  app.get('/api/plugins/:id/tools', (req: Request, res: Response) => {
    const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    const manifest = JSON.parse(row.manifest);
    res.json({ tools: manifest.tools || [] });
  });
}
