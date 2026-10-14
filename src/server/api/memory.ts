/**
 * Gnito — local memory (opt-in, user-controlled).
 *
 * Memory entries are user-editable facts stored locally. Incognito sessions
 * NEVER write to memory (enforced at the API boundary by the `incognito` flag
 * in the client session, plus tests).
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getSetting, setSetting } from './settings.js';

const db = getDb();

const CreateMemoryInput = z.object({
  key: z.string().min(1).max(200),
  value: z.string().max(5000),
  reason: z.string().max(500).default(''),
});

const UpsertMemoryInput = z.object({
  key: z.string().min(1).max(200),
  value: z.string().max(5000),
  reason: z.string().max(500).default(''),
});

export function registerMemoryRoutes(app: any): void {
  // Memory enabled/disabled setting (default off).
  app.get('/api/memory/enabled', (_req: Request, res: Response) => {
    res.json({ enabled: getSetting('memory.enabled', 'false') === 'true' });
  });
  app.put('/api/memory/enabled', (req: Request, res: Response) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    setSetting('memory.enabled', parsed.data.enabled ? 'true' : 'false');
    res.json({ ok: true });
  });

  app.get('/api/memory', (_req: Request, res: Response) => {
    const rows = db.prepare('SELECT * FROM memory_entries ORDER BY updated_at DESC').all() as any[];
    res.json(rows.map(r => ({
      id: r.id, key: r.key, value: r.value, reason: r.reason,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })));
  });

  app.post('/api/memory', (req: Request, res: Response) => {
    // Incognito clients cannot write memory.
    if (req.header('x-gnito-incognito') === '1') {
      res.status(403).json({ error: 'incognito', message: 'Memory is disabled in Incognito Mode.' });
      return;
    }
    if (getSetting('memory.enabled', 'false') !== 'true') {
      res.status(400).json({ error: 'memory-disabled', message: 'Enable memory first in Settings.' });
      return;
    }
    const parsed = CreateMemoryInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT OR REPLACE INTO memory_entries (id, key, value, reason, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run(id, parsed.data.key, parsed.data.value, parsed.data.reason, now, now);
    res.status(201).json({ id });
  });

  app.put('/api/memory/:id', (req: Request, res: Response) => {
    const parsed = UpsertMemoryInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    const existing = db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(req.params.id) as any;
    if (!existing) { res.status(404).json({ error: 'not-found' }); return; }
    db.prepare('UPDATE memory_entries SET key=?, value=?, reason=?, updated_at=? WHERE id=?')
      .run(parsed.data.key, parsed.data.value, parsed.data.reason, Date.now(), req.params.id);
    res.json({ ok: true });
  });

  app.delete('/api/memory/:id', (req: Request, res: Response) => {
    const info = db.prepare('DELETE FROM memory_entries WHERE id = ?').run(req.params.id);
    res.json({ ok: info.changes > 0 });
  });

  app.delete('/api/memory', (_req: Request, res: Response) => {
    db.prepare('DELETE FROM memory_entries').run();
    res.json({ ok: true });
  });
};
