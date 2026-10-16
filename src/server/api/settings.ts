/**
 * Gnito — settings (key/value) + backup/restore + diagnostics.
 * Keys are namespaced (e.g. "theme.dark", "memory.enabled").
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { CONFIG } from '../config.js';

const db = getDb();

const SETTINGS_KEYS = new Set([
  'theme.mode',               // 'dark' | 'light' | 'system'
  'theme.accent',             // hex accent color
  'memory.enabled',           // 'true' | 'false'
  'memory.enabledPerProject', // JSON map projectId->bool
  'audio.micEnabled',
  'audio.ttsEnabled',
  'incognito.retentionPolicy',
  'automation.defaultTimezone',
  'automation.defaultMissedPolicy',
  'automation.defaultMaxSteps',
  'automation.defaultDryRun',
  'backup.includeSecrets',
  'backup.includeFiles',
  'chat.enterToSend',
  'composer.defaultModel',
  'workspace.approvedFolders', // JSON list of FileGrant
  'diagnostics.redactOnExport',
  'ui.sidebarCollapsed',
]);

export function getSetting(key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(key, value);
}

export function registerSettingsRoutes(app: any): void {
  app.get('/api/settings', (_req: Request, res: Response) => {
    const rows = db.prepare('SELECT key, value FROM settings').all() as any[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    res.json(out);
  });

  app.put('/api/settings/:key', (req: Request, res: Response) => {
    const key = String(req.params.key);
    if (!SETTINGS_KEYS.has(key)) {
      res.status(400).json({ error: 'unknown-setting', message: `Setting key not recognized: ${key}` });
      return;
    }
    const parsed = z.object({ value: z.string().max(10_000) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    setSetting(key, parsed.data.value);
    res.json({ ok: true });
  });

  // Diagnostics (redacted, incognito-safe).
  app.get('/api/diagnostics', (_req: Request, res: Response) => {
    res.json({
      dataDir: CONFIG.dataDir,
      dbSize: (db.prepare('SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()').get() as any)?.size,
      providerCount: (db.prepare('SELECT COUNT(*) AS c FROM providers').get() as any)?.c ?? 0,
      chatCount: (db.prepare('SELECT COUNT(*) AS c FROM chats').get() as any)?.c ?? 0,
      memoryCount: (db.prepare('SELECT COUNT(*) AS c FROM memory_entries').get() as any)?.c ?? 0,
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      // Never includes incognito chat data — that's in-memory only.
    });
  });
}
